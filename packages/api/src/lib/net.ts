/**
 * 主机名 / IP 私网与 SSRF 判定的唯一共享实现。
 * CIMD SSRF 与 MCP insecure-issuer 门闩都走这里，禁止再抄一份。
 *
 * 部署例外：本服务跑在 loopback/tailnet 时放行 RFC1918 / CGNAT / loopback / ULA(fd)；
 * **永拒**：169.254.0.0/16、0.0.0.0/8、fe80::/10（与 IPv4 链路本地对齐）、
 * fd00:ec2::/16（AWS IMDS IPv6）。含 IPv4-mapped。
 * OAE_PUBLIC_EDGE=true 时关闭私网放行（回到 -01 MUST）。
 *
 * 客户端 IP：clientIp(c) 是唯一实现——TRUST_PROXY_HEADERS 控制是否读 XFF。
 */

import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { config } from './config.ts';

/** SSRF 策略选项：publicEdge 关闭私网部署例外。 */
export type SsrfPolicyOptions = {
  /** true = 公网边缘，私网/loopback/CGNAT/ULA 一律拒。默认读 config.oaePublicEdge。 */
  publicEdge?: boolean;
};

function resolvePublicEdge(opts?: SsrfPolicyOptions): boolean {
  return opts?.publicEdge ?? config.oaePublicEdge;
}

/**
 * 真实客户端 IP（预鉴权限流 / UI 登录桶 / 审计用）。
 * TRUST_PROXY_HEADERS=true → X-Forwarded-For 首跳（须为合法 IP 字面量）；
 * 否则 / 首跳非法 → 连接远端地址。
 * 测试客户端无 conninfo 时回落 `unknown`（永不盲信 XFF，除非开关打开）。
 *
 * 首跳必须 `isIP !== 0`：append 式反代会保留客户端自供的左侧值，
 * 若不校验，伪造/轮换垃圾串可蒸发 IP 限流桶。
 */
export function clientIp(
  c: Context,
  opts?: { trustProxy?: boolean },
): string {
  const trust = opts?.trustProxy ?? config.trustProxyHeaders;
  if (trust) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      // 标准反代语义：左侧为原始客户端，逗号分隔后续跳
      const first = xff.split(',')[0]?.trim();
      // 仅采纳合法 IPv4/IPv6 字面量；垃圾串回落连接 IP
      if (first && isIP(first) !== 0) return first;
    }
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
}

function isLoopbackIpv4(ip: string): boolean {
  const [a] = ip.split('.').map(Number);
  return a === 127;
}

/** fe80::/10：前 10 位为 1111111010（即首 hextet 的高 10 位）。 */
export function isFe80LinkLocalIpv6(host: string): boolean {
  const h = normalizeHost(host);
  if (isIP(h) !== 6) return false;
  // 展开压缩以便读首 hextet
  const parts = expandIpv6Hextets(h);
  if (!parts) return false;
  const first = Number.parseInt(parts[0]!, 16);
  // 0xfe80 >> 6 == 0x3fa；等价于 (first & 0xffc0) === 0xfe80
  return (first & 0xffc0) === 0xfe80;
}

/** AWS IMDS IPv6：fd00:ec2::/16 */
export function isAwsImdsIpv6(host: string): boolean {
  const h = normalizeHost(host);
  if (isIP(h) !== 6) return false;
  const parts = expandIpv6Hextets(h);
  if (!parts) return false;
  return parts[0] === 'fd00' && parts[1] === '0ec2';
}

function expandIpv6Hextets(host: string): string[] | null {
  const raw = host.toLowerCase();
  if (raw.includes('.')) {
    // IPv4-mapped 内嵌点分：先抽 v4 再展开前缀
    const mapped = ipv4MappedFromV6(raw);
    if (!mapped) return null;
  }
  let [head, tail] = raw.split('::');
  if (tail === undefined) {
    const parts = raw.split(':');
    if (parts.length !== 8) return null;
    return parts.map((p) => p.padStart(4, '0'));
  }
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // 内嵌 IPv4 时右侧最后一段可能是 a.b.c.d
  if (right.length && right[right.length - 1]!.includes('.')) {
    const v4 = right.pop()!;
    const nums = v4.split('.').map(Number);
    if (nums.length !== 4 || nums.some((n) => n < 0 || n > 255)) return null;
    right.push(
      ((nums[0]! << 8) | nums[1]!).toString(16).padStart(4, '0'),
      ((nums[2]! << 8) | nums[3]!).toString(16).padStart(4, '0'),
    );
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const mid = Array.from({ length: missing }, () => '0000');
  return [...left, ...mid, ...right].map((p) => p.padStart(4, '0'));
}

/**
 * 从 IPv6 抽出 IPv4-mapped 的点分 v4。
 * 支持：
 * - ::ffff:169.254.1.1
 * - ::ffff:a9fe:a9fe（URL 规范化后的十六进制形）
 * - ::ffff:0:a.b.c.d
 */
export function ipv4MappedFromV6(host: string): string | null {
  const lower = normalizeHost(host);
  if (isIP(lower) !== 6 && !lower.includes(':ffff:')) {
    // 仍尝试：部分形式 isIP 可识别
  }
  const idx = lower.lastIndexOf(':ffff:');
  if (idx === -1) return null;
  const tail = lower.slice(idx + ':ffff:'.length);
  if (isIP(tail) === 4) return tail;

  // ::ffff:0:a.b.c.d → 丢掉中间的 0:
  const maybeSkip = /^0:(.+)$/.exec(tail);
  if (maybeSkip && isIP(maybeSkip[1]!) === 4) return maybeSkip[1]!;

  // ::ffff:HHHH:LLLL 十六进制两 hextet → 4 字节
  const hexParts = tail.split(':');
  if (hexParts.length === 2) {
    const hi = Number.parseInt(hexParts[0]!, 16);
    const lo = Number.parseInt(hexParts[1]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo) && hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/**
 * 永拒：169.254/16、0.0.0.0/8、fe80::/10、fd00:ec2::/16。
 * 与「私网放行清单」分离。
 */
export function isBlockedSsrfIp(ip: string): boolean {
  const host = normalizeHost(ip);
  const v = isIP(host);
  if (v === 4) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }
  if (v === 6) {
    const mapped = ipv4MappedFromV6(host);
    if (mapped) return isBlockedSsrfIp(mapped);
    if (isFe80LinkLocalIpv6(host)) return true;
    if (isAwsImdsIpv6(host)) return true;
    return false;
  }
  return true; // 非 IP 字面量交由 DNS 后再判
}

/** 部署例外下允许的私网 IPv4（含 loopback / CGNAT）。不含 169.254 / 0.0.0.0。 */
export function isAllowedPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;
  return false;
}

function isUlaIpv6(host: string): boolean {
  if (host === '::1') return true;
  const parts = expandIpv6Hextets(host);
  if (!parts) {
    const first = host.split(':').find((p) => p.length > 0) ?? '';
    return first.toLowerCase().startsWith('fd');
  }
  // fd00::/8 ULA；排除 fd00:ec2::/16（已永拒）
  if (!parts[0]!.startsWith('fd')) return false;
  if (isAwsImdsIpv6(host)) return false;
  return true;
}

/**
 * 判断 hostname 字面量是否为可放行的私网/loopback（未解析 DNS）。
 * 永拒段（含 fe80 / 169.254 / fd00:ec2）**不算**私网。
 */
export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) !== 0 && isBlockedSsrfIp(host)) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isAllowedPrivateIpv4(host) || isLoopbackIpv4(host);
  if (ipVersion === 6) return isUlaIpv6(host);
  return false;
}

/** @deprecated 别名：旧 mcp/http 导出名，指向同一实现。 */
export const isPrivateOrLoopbackHost = isPrivateOrLoopbackHostname;

/**
 * 解析后的每个 A/AAAA 必须通过 SSRF 策略。
 * 永拒名单见 isBlockedSsrfIp；RFC1918/CGNAT/loopback/ULA(fd) 默认因部署例外放行，
 * OAE_PUBLIC_EDGE / opts.publicEdge=true 时关闭该例外。
 */
export function isSsrfBlockedResolvedIp(
  ip: string,
  opts?: SsrfPolicyOptions,
): boolean {
  if (isBlockedSsrfIp(ip)) return true;
  const publicEdge = resolvePublicEdge(opts);
  const host = normalizeHost(ip);
  const v = isIP(host);
  if (v === 0) return true;
  if (v === 4) {
    if (isAllowedPrivateIpv4(host)) return publicEdge;
    if (isSpecialUseIpv4BeyondAllowlist(host)) return true;
    return false;
  }
  if (host === '::1' || isUlaIpv6(host)) return publicEdge;
  if (host === '::' || host.startsWith('ff')) return true;
  return false;
}

/**
 * 私网部署例外是否生效（http client_id / 文档口径）。
 * publicEdge 时返回 false——调用方应拒绝非 https 私网 client_id。
 */
export function allowsPrivateCimdException(opts?: SsrfPolicyOptions): boolean {
  return !resolvePublicEdge(opts);
}

function isSpecialUseIpv4BeyondAllowlist(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return false;
  if (a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return false;
}
