/**
 * CIMD（Client ID Metadata Documents）校验器。
 * 规范锚点 draft-ietf-oauth-client-id-metadata-document-00；SSRF/200 按 -01 MUST。
 *
 * SSRF 部署例外（写进注释与 PR）：本 AS 跑在 loopback/tailnet 私网，验收模拟
 * 客户端 CIMD 也开在私网 → 放行 RFC1918 / CGNAT / loopback；
 * **169.254.0.0/16（云 metadata）与 0.0.0.0/8 永远拒绝**。P4 公网部署须收紧。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  isPrivateOrLoopbackHostname,
  isSsrfBlockedResolvedIp,
} from './net.ts';

// 再导出：既有测试从本模块导入 SSRF 助手；实现唯一在 lib/net.ts。
export {
  isBlockedSsrfIp,
  isPrivateOrLoopbackHostname,
  isSsrfBlockedResolvedIp,
} from './net.ts';

export const CIMD_FETCH_TIMEOUT_MS = 10_000;
export const CIMD_MAX_BYTES = 5 * 1024;
/** 缓存下限 60s、上限 7 天（对齐 Cloudflare 封顶惯例）。 */
export const CIMD_CACHE_MIN_S = 60;
export const CIMD_CACHE_MAX_S = 7 * 24 * 60 * 60;

export type CimdDocument = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
};

export type CimdFetchResult =
  | { ok: true; doc: CimdDocument }
  | { ok: false; reason: string };

export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** 测试可注入的窄 DNS 查找（避免绑死 node:dns/promises lookup 全重载）。 */
export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

type CacheEntry = {
  doc: CimdDocument;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/** 测试用清空 CIMD 缓存。 */
export function clearCimdCacheForTests(): void {
  cache.clear();
}

/**
 * client_id URL 合法性（CIMD MUST）。
 * https + 含 path；禁 `.`/`..` 段、fragment、userinfo；本实现拒 query（规范 SHOULD NOT）。
 */
export function validateClientIdUrl(clientId: string): { ok: true; url: URL } | { ok: false; reason: string } {
  // 点段 / fragment / query 检查兼顾原始串：`new URL` 会规范化 `/./a` → `/a`。
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, reason: 'client_id_not_url' };
  }
  if (url.protocol !== 'https:') {
    // 私网 dogfood：允许 http 仅当 host 为 loopback/私网（与 AS 同部署例外一致）
    if (url.protocol !== 'http:' || !isPrivateOrLoopbackHostname(url.hostname)) {
      return { ok: false, reason: 'client_id_not_https' };
    }
  }
  if (!url.pathname || url.pathname === '/') {
    return { ok: false, reason: 'client_id_missing_path' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'client_id_has_userinfo' };
  }
  // 原始串含 # 即视为 fragment（规范化后 hash 可能仍在）
  if (url.hash || clientId.includes('#')) {
    return { ok: false, reason: 'client_id_has_fragment' };
  }
  if (url.search || clientId.includes('?')) {
    return { ok: false, reason: 'client_id_has_query' };
  }
  // 从原始 path 取段（authority 之后、?/# 之前），避免规范化吞掉 `.`/`..`
  const rawPath = rawUrlPath(clientId);
  const segments = rawPath.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, reason: 'client_id_dot_segment' };
  }
  return { ok: true, url };
}

/** 提取 URL 原始 path（未百分号解码、未去点段）。 */
function rawUrlPath(clientId: string): string {
  const withoutFrag = clientId.split('#')[0] ?? clientId;
  const withoutQuery = withoutFrag.split('?')[0] ?? withoutFrag;
  const schemeIdx = withoutQuery.indexOf('://');
  if (schemeIdx < 0) return withoutQuery;
  const afterScheme = withoutQuery.slice(schemeIdx + 3);
  const pathIdx = afterScheme.indexOf('/');
  if (pathIdx < 0) return '/';
  return afterScheme.slice(pathIdx);
}

async function defaultDnsLookup(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  const list = Array.isArray(results) ? results : [results];
  return list.map((r) =>
    typeof r === 'string'
      ? { address: r, family: 0 }
      : { address: r.address, family: r.family },
  );
}

/** DNS 解析并对每个地址做 SSRF 检查。 */
export async function assertClientIdHostSafe(
  hostname: string,
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(host)) {
    if (isSsrfBlockedResolvedIp(host)) {
      return { ok: false, reason: 'ssrf_blocked_ip' };
    }
    return { ok: true };
  }
  try {
    const list = await dnsLookup(host);
    if (list.length === 0) return { ok: false, reason: 'dns_empty' };
    for (const r of list) {
      if (isSsrfBlockedResolvedIp(r.address)) {
        return { ok: false, reason: 'ssrf_blocked_ip' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
}

/** RFC 8252：loopback redirect 比较时忽略端口。 */
export function redirectUrisMatch(requested: string, registered: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(requested);
    b = new URL(registered);
  } catch {
    return false;
  }
  if (a.protocol !== b.protocol) return false;
  if (a.username || b.username || a.password || b.password) return false;
  if (a.hash || b.hash) return false;
  // 路径 + query 精确
  if (a.pathname !== b.pathname || a.search !== b.search) return false;

  const aHost = a.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
  const bHost = b.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (aHost !== bHost) return false;

  if (isLoopbackHostname(aHost)) {
    // 忽略端口
    return true;
  }
  return a.port === b.port;
}

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  if (isIP(h) === 4) {
    const [a] = h.split('.').map(Number);
    return a === 127;
  }
  return false;
}

export function redirectUriIsLoopback(redirectUri: string): boolean {
  try {
    const u = new URL(redirectUri);
    return isLoopbackHostname(u.hostname.replace(/^\[(.+)\]$/, '$1'));
  } catch {
    return false;
  }
}

function parseCacheMaxAge(header: string | null): number | null {
  if (!header) return null;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header);
  if (!m) return null;
  return Number(m[1]);
}

function cacheTtlSeconds(res: Response): number {
  const cc = res.headers.get('cache-control');
  if (cc && /no-store|no-cache/i.test(cc)) return 0;
  const maxAge = parseCacheMaxAge(cc);
  if (maxAge === null) return CIMD_CACHE_MIN_S;
  if (maxAge <= 0) return 0;
  return Math.min(CIMD_CACHE_MAX_S, Math.max(CIMD_CACHE_MIN_S, maxAge));
}

function validateDocument(
  clientId: string,
  json: unknown,
): CimdFetchResult {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: 'cimd_not_object' };
  }
  const doc = json as Record<string, unknown>;
  if (typeof doc.client_id !== 'string' || doc.client_id !== clientId) {
    // 逐字符一致（RFC 3986 simple string comparison）
    return { ok: false, reason: 'client_id_mismatch' };
  }
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) {
    return { ok: false, reason: 'missing_client_name' };
  }
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return { ok: false, reason: 'missing_redirect_uris' };
  }
  if (!doc.redirect_uris.every((u) => typeof u === 'string' && u.length > 0)) {
    return { ok: false, reason: 'invalid_redirect_uris' };
  }

  // 禁一切 client_secret*
  for (const key of Object.keys(doc)) {
    if (key.startsWith('client_secret')) {
      return { ok: false, reason: 'client_secret_forbidden' };
    }
  }

  const method =
    typeof doc.token_endpoint_auth_method === 'string'
      ? doc.token_endpoint_auth_method
      : 'none';
  if (method !== 'none') {
    // 声明 private_key_jwt 等一律拒（本 AS 只接受 none）
    return { ok: false, reason: 'auth_method_unsupported' };
  }

  return {
    ok: true,
    doc: {
      client_id: doc.client_id,
      client_name: doc.client_name.trim(),
      redirect_uris: doc.redirect_uris as string[],
      token_endpoint_auth_method: 'none',
    },
  };
}

/**
 * 拉取并校验 CIMD。可注入 fetcher（测试不启真 HTTP）。
 * MUST NOT 跟随重定向；MUST 200；响应限 5KB。
 */
export async function fetchClientMetadata(
  clientId: string,
  options: {
    fetcher?: Fetcher;
    dnsLookup?: DnsLookup;
    now?: number;
  } = {},
): Promise<CimdFetchResult> {
  const now = options.now ?? Date.now();
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > now) {
    return { ok: true, doc: cached.doc };
  }

  const urlCheck = validateClientIdUrl(clientId);
  if (!urlCheck.ok) return urlCheck;

  const hostSafe = await assertClientIdHostSafe(
    urlCheck.url.hostname,
    options.dnsLookup,
  );
  if (!hostSafe.ok) return hostSafe;

  const fetcher = options.fetcher ?? defaultFetcher;
  let res: Response;
  try {
    res = await fetcher(clientId, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  // 3xx：MUST NOT 跟随
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, reason: 'redirect_forbidden' };
  }
  if (res.status !== 200) {
    return { ok: false, reason: 'http_not_200' };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > CIMD_MAX_BYTES) {
    return { ok: false, reason: 'response_too_large' };
  }

  let json: unknown;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const validated = validateDocument(clientId, json);
  if (!validated.ok) return validated;

  const ttl = cacheTtlSeconds(res);
  if (ttl > 0) {
    cache.set(clientId, { doc: validated.doc, expiresAt: now + ttl * 1000 });
  }
  return validated;
}

async function defaultFetcher(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/** 授权请求的 redirect_uri 是否在文档列表中（含 loopback 端口放宽）。 */
export function matchRedirectUri(
  requested: string,
  registered: string[],
): boolean {
  return registered.some((r) => redirectUrisMatch(requested, r));
}
