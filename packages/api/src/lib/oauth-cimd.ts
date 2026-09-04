/**
 * CIMD（Client ID Metadata Documents）校验器。
 * 规范锚点 draft-ietf-oauth-client-id-metadata-document-00；SSRF/200 按 -01 MUST。
 *
 * SSRF 部署例外（写进注释与 PR）：本 AS 跑在 loopback/tailnet 私网，验收模拟
 * 客户端 CIMD 也开在私网 → 放行 RFC1918 / CGNAT / loopback；
 * **永拒**：169.254.0.0/16、0.0.0.0/8、fe80::/10、fd00:ec2::/16。P4 公网部署须收紧。
 *
 * DNS-rebinding：不在校验后再另开一次 DNS；连接时用自定义 lookup 钉死，
 * 对连接实际使用的每个解析结果跑 SSRF；https 保留 SNI/Host。
 */

import { isIP } from 'node:net';
import {
  allowsPrivateCimdException,
  isPrivateOrLoopbackHostname,
  isSsrfBlockedResolvedIp,
  type SsrfPolicyOptions,
} from './net.ts';
import {
  defaultDnsLookup,
  pinnedFetch,
  readBodyCapped,
  type DnsLookup,
} from './pinned-fetch.ts';

// 再导出：既有测试从本模块导入 SSRF 助手与传输实现；实现分别在 lib/net.ts 与 lib/pinned-fetch.ts。
export {
  allowsPrivateCimdException,
  isBlockedSsrfIp,
  isPrivateOrLoopbackHostname,
  isSsrfBlockedResolvedIp,
} from './net.ts';
export type { SsrfPolicyOptions } from './net.ts';
export { defaultDnsLookup, pinnedFetch, readBodyCapped } from './pinned-fetch.ts';
export type { DnsLookup } from './pinned-fetch.ts';

export const CIMD_FETCH_TIMEOUT_MS = 10_000;
export const CIMD_MAX_BYTES = 5 * 1024;
/** 缓存下限 60s、上限 7 天（常见 CDN 缓存封顶惯例）。 */
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
export function validateClientIdUrl(
  clientId: string,
  opts?: SsrfPolicyOptions,
): { ok: true; url: URL } | { ok: false; reason: string } {
  // 点段 / fragment / query 检查兼顾原始串：`new URL` 会规范化 `/./a` → `/a`。
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return { ok: false, reason: 'client_id_not_url' };
  }
  if (url.protocol !== 'https:') {
    // 私网 dogfood：允许 http 仅当 host 为 loopback/私网（与 AS 同部署例外一致）；
    // OAE_PUBLIC_EDGE / opts.publicEdge=true 时关闭该例外（-01 MUST：非 https 一律拒）。
    if (
      url.protocol !== 'http:' ||
      !isPrivateOrLoopbackHostname(url.hostname) ||
      !allowsPrivateCimdException(opts)
    ) {
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

/**
 * DNS 解析并对每个地址做 SSRF 检查。
 *
 * **警示：仅供预检/测试。** 生产必须走 `pinnedCimdFetcher` 的连接期钉死 lookup，
 * 禁止「校验后直接 fetch」——二者之间存在 DNS-rebinding TOCTOU 窗口。
 */
export async function assertClientIdHostSafe(
  hostname: string,
  dnsLookup: DnsLookup = defaultDnsLookup,
  opts?: SsrfPolicyOptions,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const host = hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(host)) {
    if (isSsrfBlockedResolvedIp(host, opts)) {
      return { ok: false, reason: 'ssrf_blocked_ip' };
    }
    return { ok: true };
  }
  try {
    const list = await dnsLookup(host);
    if (list.length === 0) return { ok: false, reason: 'dns_empty' };
    for (const r of list) {
      if (isSsrfBlockedResolvedIp(r.address, opts)) {
        return { ok: false, reason: 'ssrf_blocked_ip' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'dns_failed' };
  }
}

/**
 * redirect_uri scheme 白名单（CIMD 文档与匹配共用）。
 * - https：一律放行
 * - http：仅 loopback（IP 字面量 127/::1 或 localhost 主机名）
 * - 其余（javascript:/data:/file:/自定义私有 scheme）一律拒
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
    return isLoopbackHostname(host);
  }
  return false;
}

/**
 * RFC 8252 §7.3：仅 http + IP 字面量（127.0.0.1 / [::1]）比较时忽略端口。
 * localhost 主机名与 https 仍精确匹配端口。
 */
export function redirectUrisMatch(requested: string, registered: string): boolean {
  // 两侧都必须过 scheme 白名单（防存量脏数据 / 精确匹配绕过）
  if (!isAllowedRedirectUri(requested) || !isAllowedRedirectUri(registered)) {
    return false;
  }
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

  // 仅 http + IP 字面量忽端口（RFC 8252 精确口径）
  if (a.protocol === 'http:' && isIpLiteralLoopback(aHost)) {
    return true;
  }
  return a.port === b.port;
}

/** 127.0.0.0/8 或 ::1 字面量（不含 localhost 主机名）。 */
function isIpLiteralLoopback(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1') return true;
  if (isIP(h) === 4) {
    const [a] = h.split('.').map(Number);
    return a === 127;
  }
  return false;
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
  // scheme 白名单：禁 javascript:/data: 等（过渡页可点链接/meta refresh 的 XSS 面）
  if (!doc.redirect_uris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))) {
    return { ok: false, reason: 'redirect_uri_scheme_forbidden' };
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
    // 本 AS token 端点仍只接受 none。singular 非 none 时，仅当 plural
    // token_endpoint_auth_methods_supported 为数组且含 'none' 才按公共客户端放行
    //（ChatGPT 连接器：singular=private_key_jwt，plural 同时含 none）。
    // plural 缺失 / 非数组 / 不含 'none' → 维持拒绝。不另发明 jwks_uri 等条件。
    const supported = doc.token_endpoint_auth_methods_supported;
    const canFallbackNone =
      Array.isArray(supported) && supported.includes('none');
    if (!canFallbackNone) {
      return { ok: false, reason: 'auth_method_unsupported' };
    }
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
 * 默认 CIMD 传输：调用共享 pinnedFetch，传入 CIMD 规范参数与默认 lookup。
 * 对外签名与行为保持零变化。
 */
export async function pinnedCimdFetcher(
  urlStr: string,
  init: RequestInit = {},
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<Response> {
  const initHeaders = new Headers(init.headers);
  if (!initHeaders.has('accept')) {
    initHeaders.set('accept', 'application/json');
  }
  return pinnedFetch(urlStr, {
    ...init,
    headers: initHeaders,
    maxBytes: CIMD_MAX_BYTES,
    timeoutMs: CIMD_FETCH_TIMEOUT_MS,
    deadlineMs: CIMD_FETCH_TIMEOUT_MS,
    dnsLookup,
  });
}

/**
 * 拉取并校验 CIMD。可注入 fetcher（测试不启真 HTTP）。
 * MUST NOT 跟随重定向；MUST 200；响应边读边限 5KB。
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
  const urlCheck = validateClientIdUrl(clientId);
  if (!urlCheck.ok) return urlCheck;
  // 缓存键用规范化后的 href（避免大小写/尾斜杠等变体分裂缓存）
  const cacheKey = urlCheck.url.href;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ok: true, doc: cached.doc };
  }

  // 字面量 IP：连接前预检。主机名 SSRF 留给连接 lookup（钉死，无二次解析窗口）。
  const host = urlCheck.url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(host)) {
    const hostSafe = await assertClientIdHostSafe(host, options.dnsLookup);
    if (!hostSafe.ok) return hostSafe;
  }

  const fetcher =
    options.fetcher ??
    ((url, init) => pinnedCimdFetcher(url, init, options.dnsLookup));

  let res: Response;
  try {
    res = await fetcher(clientId, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'ssrf_blocked_ip' || msg.includes('ssrf_blocked')) {
      return { ok: false, reason: 'ssrf_blocked_ip' };
    }
    if (msg === 'response_too_large') {
      return { ok: false, reason: 'response_too_large' };
    }
    if (msg === 'redirect_forbidden') {
      return { ok: false, reason: 'redirect_forbidden' };
    }
    return { ok: false, reason: 'fetch_failed' };
  }

  // 3xx：MUST NOT 跟随
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, reason: 'redirect_forbidden' };
  }
  if (res.status !== 200) {
    return { ok: false, reason: 'http_not_200' };
  }

  // 注入 fetcher 可能仍整包返回；统一再限一次体积
  let buf: Buffer;
  try {
    if (res.body) {
      const capped = await readBodyCapped(
        res.body as unknown as NodeJS.ReadableStream,
        CIMD_MAX_BYTES,
      );
      if (!capped.ok) return capped;
      buf = capped.buf;
    } else {
      const ab = Buffer.from(await res.arrayBuffer());
      if (ab.byteLength > CIMD_MAX_BYTES) {
        return { ok: false, reason: 'response_too_large' };
      }
      buf = ab;
    }
  } catch {
    return { ok: false, reason: 'fetch_failed' };
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
    cache.set(cacheKey, { doc: validated.doc, expiresAt: now + ttl * 1000 });
  }
  return validated;
}

/** 授权请求的 redirect_uri 是否在文档列表中（含 RFC8252 端口放宽）。 */
export function matchRedirectUri(
  requested: string,
  registered: string[],
): boolean {
  return registered.some((r) => redirectUrisMatch(requested, r));
}
