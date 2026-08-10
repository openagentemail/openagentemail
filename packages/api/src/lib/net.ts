/**
 * 主机名 / IP 私网与 SSRF 判定的唯一共享实现。
 * CIMD SSRF 与 MCP insecure-issuer 门闩都走这里，禁止再抄一份。
 *
 * 部署例外：本服务跑在 loopback/tailnet 时放行 RFC1918 / CGNAT / loopback / ULA；
 * **169.254.0.0/16（云 metadata）与 0.0.0.0/8 永远拒绝**（含 IPv4-mapped）。P4 公网须收紧。
 */

import { isIP } from 'node:net';

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
}

function isLoopbackIpv4(ip: string): boolean {
  const [a] = ip.split('.').map(Number);
  return a === 127;
}

/**
 * 永拒：169.254.0.0/16（链路本地 / 云 metadata）、0.0.0.0/8。
 * 与「私网放行清单」分离，便于单测对照。
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
    // IPv4-mapped :ffff:169.254.x.x / :ffff:0.x.x.x
    const mapped = ipv4MappedFromV6(host);
    if (mapped) return isBlockedSsrfIp(mapped);
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

function isLoopbackOrUlaIpv6(host: string): boolean {
  if (host === '::1') return true;
  const first = host.split(':').find((p) => p.length > 0) ?? '';
  // fd00::/8 ULA；fe80::/10 链路本地（与旧 http.ts 仅认 fd 不同——以本完整版为准）
  return first.toLowerCase().startsWith('fd') || first.toLowerCase().startsWith('fe80');
}

function ipv4MappedFromV6(host: string): string | null {
  const lower = host.toLowerCase();
  const idx = lower.lastIndexOf(':ffff:');
  if (idx === -1) return null;
  const tail = lower.slice(idx + 6);
  if (isIP(tail) === 4) return tail;
  return null;
}

/**
 * 判断 hostname 字面量是否为可放行的私网/loopback（未解析 DNS）。
 * 169.254 / 0.0.0.0 **不算**私网（永拒段）。
 */
export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1') return true;
  // 永拒段即使是「特殊用途」也不得当作私网放行（含 v4-mapped）
  if (isIP(host) !== 0 && isBlockedSsrfIp(host)) return false;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isAllowedPrivateIpv4(host) || isLoopbackIpv4(host);
  if (ipVersion === 6) return isLoopbackOrUlaIpv6(host);
  return false;
}

/** @deprecated 别名：旧 mcp/http 导出名，指向同一实现。 */
export const isPrivateOrLoopbackHost = isPrivateOrLoopbackHostname;

/**
 * 解析后的每个 A/AAAA 必须通过 SSRF 策略。
 * 永拒 169.254/0.0.0.0；私网/loopback 因 AS 同部署例外放行。
 */
export function isSsrfBlockedResolvedIp(ip: string): boolean {
  if (isBlockedSsrfIp(ip)) return true;
  const host = normalizeHost(ip);
  const v = isIP(host);
  if (v === 0) return true;
  if (v === 4) {
    if (isAllowedPrivateIpv4(host)) return false;
    if (isSpecialUseIpv4BeyondAllowlist(host)) return true;
    return false;
  }
  if (host === '::1' || isLoopbackOrUlaIpv6(host)) return false;
  if (host === '::' || host.startsWith('ff')) return true;
  return false;
}

function isSpecialUseIpv4BeyondAllowlist(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return false;
  if (a >= 224) return true; // multicast / reserved
  if (a === 100 && b >= 64 && b <= 127) return false;
  return false;
}
