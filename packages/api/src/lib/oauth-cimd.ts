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

import { lookup as dnsLookupAll } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPrivateOrLoopbackHostname, isSsrfBlockedResolvedIp } from './net.ts';

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
  const results = await dnsLookupAll(hostname, { all: true, verbatim: true });
  const list = Array.isArray(results) ? results : [results];
  return list.map((r) =>
    typeof r === 'string'
      ? { address: r, family: 0 }
      : { address: r.address, family: r.family },
  );
}

/**
 * DNS 解析并对每个地址做 SSRF 检查（测试/字面量预检用）。
 * 生产 CIMD 默认传输在连接 lookup 内再钉一次，避免 TOCTOU。
 */
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

/**
 * RFC 8252 §7.3：仅 http + IP 字面量（127.0.0.1 / [::1]）比较时忽略端口。
 * localhost 主机名与 https 仍精确匹配端口。
 */
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

/** 流式读取响应体，超过 CIMD_MAX_BYTES 截断失败（不整缓冲 arrayBuffer）。 */
async function readBodyCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ ok: true; buf: Buffer } | { ok: false; reason: 'response_too_large' }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      // 尽早停读，避免大响应占内存
      const maybeDestroy = (stream as unknown as { destroy?: () => void }).destroy;
      if (typeof maybeDestroy === 'function') maybeDestroy.call(stream);
      return { ok: false, reason: 'response_too_large' };
    }
    chunks.push(buf);
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}

/**
 * 默认 CIMD 传输：node:http(s) + 连接时 lookup 钉死 SSRF。
 * Host / SNI 仍用原始 hostname；实际 TCP 目标由 lookup 结果决定。
 */
export async function pinnedCimdFetcher(
  urlStr: string,
  init: RequestInit = {},
  dnsLookup: DnsLookup = defaultDnsLookup,
): Promise<Response> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported_protocol');
  }

  // IP 字面量：连接前即判黑名单（无 DNS TOCTOU）
  const literal = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(literal) && isSsrfBlockedResolvedIp(literal)) {
    throw new Error('ssrf_blocked_ip');
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    host: url.host,
  };
  if (init.headers) {
    const h = new Headers(init.headers);
    h.forEach((v, k) => {
      if (k.toLowerCase() === 'host') return;
      headers[k] = v;
    });
  }

  const lib = isHttps ? https : http;
  const timeoutMs = CIMD_FETCH_TIMEOUT_MS;

  return new Promise<Response>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: (init.method as string) || 'GET',
        headers,
        // https：显式 SNI = 原始 hostname（即使 dial 到解析 IP）
        servername: isHttps ? literal : undefined,
        // 连接时解析并对每个结果跑 SSRF（钉死，消灭校验/fetch 间 TOCTOU）
        lookup: ((hostname, options, callback) => {
          const fail = (err: NodeJS.ErrnoException) => {
            // LookupFunction 要求 (err, address, family) 三参
            callback(err, '', 4);
          };
          void (async () => {
            try {
              const list = await dnsLookup(hostname.replace(/^\[(.+)\]$/, '$1'));
              if (list.length === 0) {
                fail(Object.assign(new Error('dns_empty'), { code: 'ENOTFOUND' }));
                return;
              }
              for (const r of list) {
                if (isSsrfBlockedResolvedIp(r.address)) {
                  fail(Object.assign(new Error('ssrf_blocked_ip'), { code: 'EACCES' }));
                  return;
                }
              }
              const mapped = list.map((r) => ({
                address: r.address,
                family: (r.family === 6 ? 6 : 4) as 4 | 6,
              }));
              const opts = options as { all?: boolean } | number | undefined;
              const wantAll =
                typeof opts === 'object' && opts !== null && Boolean(opts.all);
              if (wantAll) {
                (callback as (err: Error | null, addresses: typeof mapped) => void)(
                  null,
                  mapped,
                );
              } else {
                const first = mapped[0]!;
                callback(null, first.address, first.family);
              }
            } catch (err) {
              fail(err as NodeJS.ErrnoException);
            }
          })();
        }) as LookupFunction,
      },
      (res) => {
        void (async () => {
          try {
            const capped = await readBodyCapped(res, CIMD_MAX_BYTES);
            if (!capped.ok) {
              res.resume();
              reject(new Error(capped.reason));
              return;
            }
            const headerInit: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headerInit[k] = v;
              else if (Array.isArray(v)) headerInit[k] = v.join(', ');
            }
            resolve(
              new Response(capped.buf, {
                status: res.statusCode ?? 0,
                headers: headerInit,
              }),
            );
          } catch (err) {
            reject(err);
          }
        })();
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);

    // MUST NOT 跟随重定向：node http 默认不跟随；3xx 原样交上层
    if (init.signal) {
      const onAbort = () => req.destroy(new Error('aborted'));
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
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
  const cached = cache.get(clientId);
  if (cached && cached.expiresAt > now) {
    return { ok: true, doc: cached.doc };
  }

  const urlCheck = validateClientIdUrl(clientId);
  if (!urlCheck.ok) return urlCheck;

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
    cache.set(clientId, { doc: validated.doc, expiresAt: now + ttl * 1000 });
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
