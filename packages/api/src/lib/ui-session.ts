import { createHash, randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import { clientIp } from './net.ts';
import { consumeOAuthReturnCookie } from './oauth-return.ts';

const COOKIE_NAME = 'oae_ui';
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REMEMBER_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const REMEMBER_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const IP_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const GLOBAL_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_IP_FAILURES = 10;
const MAX_GLOBAL_FAILURES = 60;

type Session = {
  token: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  remembered: boolean;
};

type CreateResult =
  | { ok: true; sid: string; auth: Auth; reason?: undefined }
  | {
      ok: false;
      reason: 'invalid_token' | 'rate_limited' | 'capacity';
      sid?: undefined;
      auth?: undefined;
    };

type SessionStoreOptions = {
  resolveToken: (token: string) => Auth | null;
  maxSessions?: number;
  maxSessionsPerToken?: number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isExpired(session: Session, now: number): boolean {
  // Remembered sessions ("trust this device") use a single 30-day sliding
  // idle window. There is no extra absolute cap server-side: the persistent
  // cookie's own 30-day Max-Age bounds the lifetime at the browser.
  if (session.remembered) {
    return now - session.lastSeenAt >= REMEMBER_TIMEOUT_MS;
  }
  return (
    now - session.lastSeenAt >= IDLE_TIMEOUT_MS ||
    now - session.createdAt >= ABSOLUTE_TIMEOUT_MS
  );
}

export class UiSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ipFailures = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private readonly resolve: (token: string) => Auth | null;
  private readonly maxSessions: number;
  private readonly maxSessionsPerToken: number;

  constructor(options: SessionStoreOptions) {
    this.resolve = options.resolveToken;
    this.maxSessions = options.maxSessions ?? 200;
    this.maxSessionsPerToken = options.maxSessionsPerToken ?? 5;
  }

  create(token: string, ip: string, now = Date.now(), remember = false): CreateResult {
    this.cleanup(now);
    token = token.trim();

    const ipFailures = this.recentIpFailures(ip, now);
    if (
      ipFailures.length >= MAX_IP_FAILURES ||
      this.globalFailures.length >= MAX_GLOBAL_FAILURES
    ) {
      return { ok: false, reason: 'rate_limited' };
    }

    const auth = this.resolve(token);
    if (!auth) {
      ipFailures.push(now);
      this.ipFailures.set(ip, ipFailures);
      this.globalFailures.push(now);
      return { ok: false, reason: 'invalid_token' };
    }

    const tokenHash = sha256(token);
    let principalSessions = 0;
    let oldestPrincipalHash: string | null = null;
    let oldestPrincipalSeen = Infinity;
    for (const [sidHash, session] of this.sessions) {
      if (session.tokenHash !== tokenHash) continue;
      principalSessions += 1;
      if (session.lastSeenAt < oldestPrincipalSeen) {
        oldestPrincipalSeen = session.lastSeenAt;
        oldestPrincipalHash = sidHash;
      }
    }
    if (principalSessions >= this.maxSessionsPerToken) {
      // The caller just proved they hold this token, so rather than locking
      // them out for hours, drop their own least-recently-used session.
      if (oldestPrincipalHash) this.sessions.delete(oldestPrincipalHash);
    }
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, reason: 'capacity' };
    }

    const sid = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(sid), {
      token,
      tokenHash,
      createdAt: now,
      lastSeenAt: now,
      remembered: remember,
    });
    return { ok: true, sid, auth };
  }

  authenticate(sid: string, now = Date.now()): { auth: Auth } | null {
    const sidHash = sha256(sid);
    const session = this.sessions.get(sidHash);
    if (!session) return null;

    if (isExpired(session, now)) {
      this.sessions.delete(sidHash);
      return null;
    }

    const auth = this.resolve(session.token);
    if (!auth) {
      this.sessions.delete(sidHash);
      return null;
    }

    session.lastSeenAt = now;
    return { auth };
  }

  destroy(sid: string): void {
    this.sessions.delete(sha256(sid));
  }

  private cleanup(now: number): void {
    for (const [sidHash, session] of this.sessions) {
      if (isExpired(session, now)) this.sessions.delete(sidHash);
    }

    this.globalFailures = this.globalFailures.filter(
      (failureAt) => now - failureAt <= GLOBAL_FAILURE_WINDOW_MS,
    );
    for (const [ip, failures] of this.ipFailures) {
      const recent = failures.filter(
        (failureAt) => now - failureAt <= IP_FAILURE_WINDOW_MS,
      );
      if (recent.length === 0) this.ipFailures.delete(ip);
      else this.ipFailures.set(ip, recent);
    }
  }

  private recentIpFailures(ip: string, now: number): number[] {
    const recent = (this.ipFailures.get(ip) ?? []).filter(
      (failureAt) => now - failureAt <= IP_FAILURE_WINDOW_MS,
    );
    if (recent.length === 0) this.ipFailures.delete(ip);
    else this.ipFailures.set(ip, recent);
    return recent;
  }
}

declare module 'hono' {
  interface ContextVariableMap {
    uiSessionSid: string;
  }
}

const loginSchema = z
  .object({ token: z.string().min(1).max(512), remember: z.boolean().optional() })
  .strict();

function cookieSecure(url: string): boolean {
  const parsed = new URL(url);
  const localHost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  return !(parsed.protocol === 'http:' && localHost);
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  sid: string,
  remember: boolean,
): void {
  setCookie(c, COOKIE_NAME, sid, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/ui',
    secure: cookieSecure(c.req.url),
    // Only remembered sessions get a persistent cookie; the default stays a
    // browser-session cookie so closing the browser signs the user out.
    ...(remember ? { maxAge: REMEMBER_COOKIE_MAX_AGE_S } : {}),
  });
}

function expireSessionCookie(c: Parameters<typeof deleteCookie>[0]): void {
  deleteCookie(c, COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/ui',
    secure: cookieSecure(c.req.url),
  });
}

/**
 * UI 登录失败桶键：走共享 clientIp（TRUST_PROXY_HEADERS 控制 XFF）。
 * 默认关 XFF——测试客户端无 conninfo 时为 `unknown`，与旧行为一致。
 */
function connectionIp(c: Parameters<typeof clientIp>[0]): string {
  return clientIp(c);
}

export const uiSessionBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json({ error: 'request_too_large' }, 413),
});

export const requireUiOrigin = createMiddleware(async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const expectedUrl = new URL(c.req.url);
  const origin = c.req.header('origin');
  const sameOriginSignal = c.req.header('sec-fetch-site') === 'same-origin';
  let allowed = !origin && sameOriginSignal;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      allowed =
        originUrl.origin === expectedUrl.origin ||
        (sameOriginSignal &&
          originUrl.protocol === 'https:' &&
          expectedUrl.protocol === 'http:' &&
          originUrl.host === expectedUrl.host);
    } catch {
      allowed = false;
    }
  }
  if (!allowed) {
    return c.json({ error: 'forbidden_origin' }, 403);
  }

  await next();
});

export const uiPrivateHeaders = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'Authorization, Cookie');
  await next();
});

export function uiSessionAuth(store: UiSessionStore) {
  return createMiddleware(async (c, next) => {
    const sid = getCookie(c, COOKIE_NAME);
    if (!sid) return c.json({ error: 'invalid_token' }, 401);

    const result = store.authenticate(sid);
    if (!result) {
      expireSessionCookie(c);
      return c.json({ error: 'invalid_token' }, 401);
    }

    c.set('auth', result.auth);
    c.set('uiSessionSid', sid);
    await next();
  });
}

export function createUiSessionRoutes(store: UiSessionStore): Hono {
  const routes = new Hono();

  routes.use('*', uiPrivateHeaders);

  routes.post('/', async (c) => {
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'unsupported_media_type' }, 415);
      }

      const parsedBody: unknown = await c.req.json();
      const parsed = loginSchema.safeParse(parsedBody);
      if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

      const remember = parsed.data.remember === true;
      const result = store.create(parsed.data.token, connectionIp(c), undefined, remember);
      if (!result.ok) {
        if (result.reason === 'invalid_token') {
          return c.json({ error: 'invalid_token' }, 401);
        }
        return c.json(
          {
            error:
              result.reason === 'rate_limited' ? 'rate_limited' : 'too_many_sessions',
          },
          429,
        );
      }

      setSessionCookie(c, result.sid, remember);
      // OAuth 同意页登录回跳（若有）；一次性消费，不进会话长期状态。
      const returnTo = consumeOAuthReturnCookie(c);
      return c.json(returnTo ? { ...result.auth, returnTo } : result.auth);
    } catch {
      // Keep credentials out of the global error logger even if parsing or the
      // backing token resolver fails with an error containing request data.
      return c.json({ error: 'invalid_request' }, 400);
    }
  });

  routes.delete('/', (c) => {
    const sid = getCookie(c, COOKIE_NAME);
    if (sid) store.destroy(sid);
    expireSessionCookie(c);
    return c.body(null, 204);
  });

  return routes;
}
