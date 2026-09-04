/**
 * 共享 pinned fetcher：node:http(s) + 连接时 lookup 钉死 SSRF。
 * 供 CIMD（OAuth metadata）与 Outbound Webhooks（RFC-0001 §9.1/§9.7）共享。
 *
 * 特性：
 * - IP 字面量连接前预检
 * - 连接时 lookup hook 对每一个解析地址跑 isSsrfBlockedResolvedIp（防 DNS-rebinding TOCTOU）
 * - 3xx 重定向绝对拒绝（RFC-0001 §9.1/§9.4 redirect: 'manual'，内置行为，抛 redirect_forbidden）
 * - 超时与字节上限参数化（timeoutMs, maxBytes）
 * - 绝对墙钟死线（deadlineMs，RFC-0001 §9.7）：独立于 socket 空闲度，到期销毁请求（防 slowloris/tarpit 占坑）
 */

import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookupAll } from 'node:dns/promises';
import { isSsrfBlockedResolvedIp, type SsrfPolicyOptions } from './net.ts';

export type DnsLookupResult = { address: string; family: 4 | 6 };

/** 测试可注入的窄 DNS 查找（避免绑死 node:dns/promises lookup 全重载）。 */
export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

/** 默认 DNS 解析实现。 */
export async function defaultDnsLookup(
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

/** 流式读取响应体，超过 maxBytes 截断失败（不整缓冲 arrayBuffer）。 */
export async function readBodyCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ ok: true; buf: Buffer } | { ok: false; reason: 'response_too_large' }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      const maybeDestroy = (stream as unknown as { destroy?: () => void }).destroy;
      if (typeof maybeDestroy === 'function') maybeDestroy.call(stream);
      return { ok: false, reason: 'response_too_large' };
    }
    chunks.push(buf);
  }
  return { ok: true, buf: Buffer.concat(chunks) };
}

export type PinnedFetchOptions = RequestInit & {
  /** 响应最大字节数；超出时抛 response_too_large。未设时不限。 */
  maxBytes?: number;
  /** Socket 空闲超时（毫秒，req.setTimeout）。默认 10_000 (10s)。 */
  timeoutMs?: number;
  /**
   * 绝对墙钟死线（毫秒，RFC-0001 §9.7）。
   * 从请求开始计时，无论 socket 是否有数据流动，到期均销毁请求并抛 deadline_exceeded。
   * 独立于 socket 空闲度，防 slowloris / tarpit 占坑。
   * 默认等于 timeoutMs 或 10_000。
   */
  deadlineMs?: number;
  /** 测试或定制的可注入 DNS 查询钩子。 */
  dnsLookup?: DnsLookup;
  /** SSRF 判定选项（如 publicEdge: true）。 */
  ssrfOptions?: SsrfPolicyOptions;
};

/**
 * 归一化请求体或早拒不支持的类型（CodeRabbit Major 修复）。
 * 必须在创建连接和死线定时器前同步完成。
 */
function normalizeRequestBody(body: unknown): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8');
  }
  throw new TypeError('unsupported_request_body_type');
}

/**
 * 默认通用 pinned fetcher：node:http(s) + 连接时 lookup 钉死 SSRF。
 * Host / SNI 仍用原始 hostname；实际 TCP 目标由 lookup 结果决定。
 */
export async function pinnedFetch(
  urlStr: string,
  options: PinnedFetchOptions = {},
): Promise<Response> {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('unsupported_protocol');
  }

  // IP 字面量：连接前即判黑名单（无 DNS TOCTOU）
  const literal = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(literal) && isSsrfBlockedResolvedIp(literal, options.ssrfOptions)) {
    throw new Error('ssrf_blocked_ip');
  }

  // 请求体早拒/归一化（CodeRabbit Major：在创建底层请求与定时器前完成）
  const normalizedBody = normalizeRequestBody(options.body);

  const headers: Record<string, string> = {
    host: url.host,
  };
  if (options.headers) {
    const h = new Headers(options.headers);
    h.forEach((v, k) => {
      if (k.toLowerCase() === 'host') return;
      headers[k] = v;
    });
  }

  const lib = isHttps ? https : http;
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadlineMs = options.deadlineMs ?? (timeoutMs > 0 ? timeoutMs : 10_000);
  const maxBytes = options.maxBytes;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let activeRes: http.IncomingMessage | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = undefined;
      }
    };

    const doReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        req.destroy(err);
      } catch {
        // ignore
      }
      try {
        if (req.socket) req.socket.destroy(err);
      } catch {
        // ignore
      }
      try {
        if (activeRes) activeRes.destroy(err);
      } catch {
        // ignore
      }
      reject(err);
    };

    const doResolve = (res: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: (options.method as string) || 'GET',
        headers,
        agent: false,
        servername: isHttps && !isIP(literal) ? literal : undefined,
        // 连接时解析并对每个结果跑 SSRF（钉死，消灭校验/fetch 间 TOCTOU）
        lookup: ((hostname, lookupOpts, callback) => {
          const fail = (err: NodeJS.ErrnoException) => {
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
                if (isSsrfBlockedResolvedIp(r.address, options.ssrfOptions)) {
                  fail(Object.assign(new Error('ssrf_blocked_ip'), { code: 'EACCES' }));
                  return;
                }
              }
              const mapped = list.map((r) => ({
                address: r.address,
                family: (r.family === 6 ? 6 : 4) as 4 | 6,
              }));
              const opts = lookupOpts as { all?: boolean } | number | undefined;
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
        activeRes = res;
        void (async () => {
          try {
            // 3xx：MUST NOT 跟随重定向，提升为共享 fetcher 内置行为（RFC-0001 §9.1/§9.4）
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
              res.resume();
              req.destroy();
              doReject(new Error('redirect_forbidden'));
              return;
            }

            let bodyBuf: Buffer;
            if (maxBytes !== undefined) {
              const capped = await readBodyCapped(res, maxBytes);
              if (!capped.ok) {
                res.resume();
                req.destroy();
                doReject(new Error(capped.reason));
                return;
              }
              bodyBuf = capped.buf;
            } else {
              const chunks: Buffer[] = [];
              for await (const chunk of res) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              bodyBuf = Buffer.concat(chunks);
            }

            const headerInit: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') headerInit[k] = v;
              else if (Array.isArray(v)) headerInit[k] = v.join(', ');
            }

            const isNullBody =
              res.statusCode === 204 || res.statusCode === 205 || res.statusCode === 304;

            doResolve(
              new Response(isNullBody ? null : bodyBuf, {
                status: res.statusCode ?? 200,
                headers: headerInit,
              }),
            );
          } catch (err) {
            doReject(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      },
    );

    // 空闲超时（inactivity timeout）
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      req.setTimeout(timeoutMs, () => {
        doReject(new Error('timeout'));
      });
    }

    // 绝对墙钟死线（wall-clock deadline，§9.7）
    if (deadlineMs > 0 && Number.isFinite(deadlineMs)) {
      deadlineTimer = setTimeout(() => {
        doReject(new Error('deadline_exceeded'));
      }, deadlineMs);
      if (typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref();
      }
    }

    req.on('error', (err) => {
      doReject(err);
    });

    if (options.signal) {
      abortListener = () => {
        doReject(new Error('aborted'));
      };
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener('abort', abortListener, { once: true });
    }

    if (normalizedBody && normalizedBody.length > 0) {
      req.write(normalizedBody);
    }

    req.end();
  });
}
