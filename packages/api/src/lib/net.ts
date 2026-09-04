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

function parseIpv4Relaxed(str: string): string | null {
  if (!str || typeof str !== 'string') return null;
  if (str.includes(':') || str.includes('[') || str.includes(']')) return null;
  const parts = str.trim().split('.');
  if (parts.length > 4 || parts.length === 0) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = Number.parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = Number.parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  let val: number;
  if (nums.length === 1) {
    if (nums[0]! > 0xffffffff) return null;
    val = nums[0]!;
  } else if (nums.length === 2) {
    if (nums[0]! > 255 || nums[1]! > 0xffffff) return null;
    val = nums[0]! * 0x1000000 + nums[1]!;
  } else if (nums.length === 3) {
    if (nums[0]! > 255 || nums[1]! > 255 || nums[2]! > 0xffff) return null;
    val = nums[0]! * 0x1000000 + nums[1]! * 0x10000 + nums[2]!;
  } else if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    val = nums[0]! * 0x1000000 + nums[1]! * 0x10000 + nums[2]! * 0x100 + nums[3]!;
  } else {
    return null;
  }
  return `${(val >>> 24) & 0xff}.${(val >>> 16) & 0xff}.${(val >>> 8) & 0xff}.${val & 0xff}`;
}

function hextetToIpv4(hiHex: string, loHex: string): string {
  const hi = Number.parseInt(hiHex, 16);
  const lo = Number.parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function expandIpv6Hextets(host: string): string[] | null {
  const raw = host.toLowerCase().replace(/^\[(.+)\]$/, '$1');
  let [head, tail] = raw.split('::');
  if (tail === undefined) {
    const parts = raw.split(':');
    if (parts.length === 7 && parts[6]!.includes('.')) {
      const v4 = parts.pop()!;
      const nums = v4.split('.').map(Number);
      if (nums.length !== 4 || nums.some((n) => n < 0 || n > 255)) return null;
      parts.push(
        ((nums[0]! << 8) | nums[1]!).toString(16).padStart(4, '0'),
        ((nums[2]! << 8) | nums[3]!).toString(16).padStart(4, '0'),
      );
      return parts.map((p) => p.padStart(4, '0'));
    }
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
 * 提取 IPv6 各种内嵌 IPv4 形式（RFC-0001 §9.2, D16, Q21=A 提取式）：
 * 1. IPv4-mapped (::ffff:0:0/96, RFC 4291)
 * 2. NAT64 (64:ff9b::/96, RFC 6052)
 * 3. 6to4 (2002::/16, RFC 3056)
 * 4. Teredo (2001:0000::/32, RFC 4380) — 提取 server 与 client (XOR 0xFFFFFFFF)
 */
export function extractEmbeddedIpv4s(host: string): string[] {
  const hextets = expandIpv6Hextets(host);
  if (!hextets) return [];
  const results = new Set<string>();

  // 1. IPv4-mapped: ::ffff:a.b.c.d 或 ::ffff:HHHH:LLLL 或 ::ffff:0:a.b.c.d
  if (
    hextets[0] === '0000' &&
    hextets[1] === '0000' &&
    hextets[2] === '0000' &&
    hextets[3] === '0000' &&
    ((hextets[4] === '0000' && hextets[5] === 'ffff') ||
      (hextets[4] === 'ffff' && hextets[5] === '0000'))
  ) {
    results.add(hextetToIpv4(hextets[6]!, hextets[7]!));
  }

  // 2. NAT64: 64:ff9b::/96 (Well-Known Prefix, RFC 6052)
  if (
    hextets[0] === '0064' &&
    hextets[1] === 'ff9b' &&
    hextets[2] === '0000' &&
    hextets[3] === '0000' &&
    hextets[4] === '0000' &&
    hextets[5] === '0000'
  ) {
    results.add(hextetToIpv4(hextets[6]!, hextets[7]!));
  }

  // 3. 6to4: 2002::/16 (RFC 3056, bits 16..47)
  if (hextets[0] === '2002') {
    results.add(hextetToIpv4(hextets[1]!, hextets[2]!));
  }

  // 4. Teredo: 2001:0000::/32 (RFC 4380)
  if (hextets[0] === '2001' && hextets[1] === '0000') {
    // Server IPv4 (hextets 2, 3)
    results.add(hextetToIpv4(hextets[2]!, hextets[3]!));
    // Client IPv4 (hextets 6, 7 inverted per RFC 4380 §4)
    const hiInv = (~Number.parseInt(hextets[6]!, 16)) & 0xffff;
    const loInv = (~Number.parseInt(hextets[7]!, 16)) & 0xffff;
    results.add(
      hextetToIpv4(
        hiInv.toString(16).padStart(4, '0'),
        loInv.toString(16).padStart(4, '0'),
      ),
    );
  }

  return Array.from(results);
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
 * 含 IPv4-mapped、NAT64、6to4、Teredo 等内嵌 IPv4 提取判定（Q21=A）。
 */
export function isBlockedSsrfIp(ip: string): boolean {
  const host = normalizeHost(ip);
  let v = isIP(host);
  if (v === 0) {
    const relaxed = parseIpv4Relaxed(host);
    if (relaxed) return isBlockedSsrfIp(relaxed);
  }
  if (v === 4) {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    return false;
  }
  if (v === 6) {
    const embedded = extractEmbeddedIpv4s(host);
    for (const v4 of embedded) {
      if (isBlockedSsrfIp(v4)) return true;
    }
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
  if (isBlockedSsrfIp(host)) return false;
  let ipVersion = isIP(host);
  if (ipVersion === 0) {
    const relaxed = parseIpv4Relaxed(host);
    if (relaxed) {
      return isAllowedPrivateIpv4(relaxed) || isLoopbackIpv4(relaxed);
    }
    return false;
  }
  if (ipVersion === 4) return isAllowedPrivateIpv4(host) || isLoopbackIpv4(host);
  if (ipVersion === 6) {
    const embedded = extractEmbeddedIpv4s(host);
    if (embedded.length > 0) {
      return embedded.every((v4) => isAllowedPrivateIpv4(v4) || isLoopbackIpv4(v4));
    }
    return isUlaIpv6(host);
  }
  return false;
}

/** @deprecated 别名：旧 mcp/http 导出名，指向同一实现。 */
export const isPrivateOrLoopbackHost = isPrivateOrLoopbackHostname;

/**
 * 解析后的每个 A/AAAA 必须通过 SSRF 策略。
 * 永拒名单见 isBlockedSsrfIp；RFC1918/CGNAT/loopback/ULA(fd) 默认因部署例外放行，
 * OAE_PUBLIC_EDGE / opts.publicEdge=true 时关闭该例外。
 * 内嵌 IPv4（NAT64/6to4/Teredo）走既有 IPv4 策略评估（Q21=A）。
 */
export function isSsrfBlockedResolvedIp(
  ip: string,
  opts?: SsrfPolicyOptions,
): boolean {
  if (isBlockedSsrfIp(ip)) return true;
  const publicEdge = resolvePublicEdge(opts);
  const host = normalizeHost(ip);
  let v = isIP(host);
  if (v === 0) {
    const relaxed = parseIpv4Relaxed(host);
    if (relaxed) return isSsrfBlockedResolvedIp(relaxed, opts);
    return true;
  }
  if (v === 4) {
    if (isAllowedPrivateIpv4(host)) return publicEdge;
    if (isSpecialUseIpv4BeyondAllowlist(host)) return true;
    return false;
  }
  // v === 6:
  const embedded = extractEmbeddedIpv4s(host);
  for (const v4 of embedded) {
    if (isSsrfBlockedResolvedIp(v4, opts)) return true;
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
