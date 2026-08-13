import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
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
/** authenticate 更新 lastSeenAt 的落盘节流：默认 5 分钟内不重复写盘。 */
export const LAST_SEEN_PERSIST_INTERVAL_MS = 5 * 60 * 1000;

type Session = {
  /** 仅进程内持有；落盘绝不写明文 token。重启后靠 tokenHash 反解。 */
  token?: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  remembered: boolean;
};

/** 落盘条目：仅 sidHash → 哈希与时间戳，无 sid/token 原文。 */
type PersistedSession = {
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  remembered: boolean;
};

type PersistedStore = Record<string, PersistedSession>;

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
  /**
   * 按 tokenHash 反解 principal（持久化会话 authenticate 必用）。
   * 未提供时：仅进程内带明文 token 的会话可 authenticate（测试常用）。
   */
  resolveTokenHash?: (tokenHash: string) => Auth | null;
  maxSessions?: number;
  maxSessionsPerToken?: number;
  /**
   * 持久化文件路径。生产由 app.ts 传入 DATA_DIR/ui-sessions.json；
   * 省略则纯内存（避免测试文件共享 DATA_DIR 时互相污染）。
   * DATA_DIR 下本 store 与 identities/oauth/audit 等均为单写者，不支持多容器共享。
   */
  persistPath?: string;
  /** lastSeenAt 落盘节流间隔；默认 LAST_SEEN_PERSIST_INTERVAL_MS。 */
  lastSeenPersistIntervalMs?: number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isExpired(session: Pick<Session, 'lastSeenAt' | 'createdAt' | 'remembered'>, now: number): boolean {
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

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.tokenHash === 'string' &&
    typeof row.createdAt === 'number' &&
    typeof row.lastSeenAt === 'number' &&
    typeof row.remembered === 'boolean'
  );
}

function isPersistedStore(value: unknown): value is PersistedStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as object).every(isPersistedSession);
}

export class UiSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ipFailures = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private readonly resolve: (token: string) => Auth | null;
  private readonly resolveHash: ((tokenHash: string) => Auth | null) | null;
  private readonly maxSessions: number;
  private readonly maxSessionsPerToken: number;
  private readonly persistPath: string | null;
  private readonly lastSeenPersistIntervalMs: number;
  /** 上次因 lastSeenAt 滑动而落盘的时间（按墙钟；节流用）。 */
  private lastSeenPersistedAt = 0;

  constructor(options: SessionStoreOptions) {
    this.resolve = options.resolveToken;
    this.resolveHash = options.resolveTokenHash ?? null;
    this.maxSessions = options.maxSessions ?? 200;
    this.maxSessionsPerToken = options.maxSessionsPerToken ?? 5;
    this.persistPath = options.persistPath ?? null;
    this.lastSeenPersistIntervalMs =
      options.lastSeenPersistIntervalMs ?? LAST_SEEN_PERSIST_INTERVAL_MS;
    if (this.persistPath) this.loadFromDisk(Date.now());
  }

  create(token: string, ip: string, now = Date.now(), remember = false): CreateResult {
    const removed = this.cleanup(now);
    token = token.trim();

    const ipFailures = this.recentIpFailures(ip, now);
    if (
      ipFailures.length >= MAX_IP_FAILURES ||
      this.globalFailures.length >= MAX_GLOBAL_FAILURES
    ) {
      if (removed) this.persist();
      return { ok: false, reason: 'rate_limited' };
    }

    const auth = this.resolve(token);
    if (!auth) {
      ipFailures.push(now);
      this.ipFailures.set(ip, ipFailures);
      this.globalFailures.push(now);
      if (removed) this.persist();
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
    let evicted = false;
    if (principalSessions >= this.maxSessionsPerToken) {
      // The caller just proved they hold this token, so rather than locking
      // them out for hours, drop their own least-recently-used session.
      if (oldestPrincipalHash) {
        this.sessions.delete(oldestPrincipalHash);
        evicted = true;
      }
    }
    if (this.sessions.size >= this.maxSessions) {
      if (removed || evicted) this.persist();
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
    // create / 驱逐 / 过期清理 → 必落盘；同时重置节流时钟避免紧随的 authenticate 再写一次
    this.persist();
    this.lastSeenPersistedAt = now;
    return { ok: true, sid, auth };
  }

  authenticate(sid: string, now = Date.now()): { auth: Auth } | null {
    const sidHash = sha256(sid);
    const session = this.sessions.get(sidHash);
    if (!session) return null;

    if (isExpired(session, now)) {
      this.sessions.delete(sidHash);
      this.persist();
      return null;
    }

    const auth = this.resolveSession(session);
    if (!auth) {
      this.sessions.delete(sidHash);
      this.persist();
      return null;
    }

    session.lastSeenAt = now;
    // 节流：lastSeenAt 滑动不每请求写盘；间隔到了才落盘。
    if (now - this.lastSeenPersistedAt >= this.lastSeenPersistIntervalMs) {
      this.persist();
      this.lastSeenPersistedAt = now;
    }
    return { auth };
  }

  destroy(sid: string): void {
    const sidHash = sha256(sid);
    if (!this.sessions.has(sidHash)) return;
    this.sessions.delete(sidHash);
    this.persist();
  }

  /** 测试辅助：当前内存会话数。 */
  sizeForTests(): number {
    return this.sessions.size;
  }

  /** 测试辅助：lastSeen 落盘节流时钟（墙钟 ms）。 */
  lastSeenPersistedAtForTests(): number {
    return this.lastSeenPersistedAt;
  }

  private resolveSession(session: Session): Auth | null {
    if (session.token !== undefined) return this.resolve(session.token);
    if (this.resolveHash) return this.resolveHash(session.tokenHash);
    return null;
  }

  /** @returns 是否删除了过期会话（调用方据此决定是否落盘）。 */
  private cleanup(now: number): boolean {
    let removed = false;
    for (const [sidHash, session] of this.sessions) {
      if (isExpired(session, now)) {
        this.sessions.delete(sidHash);
        removed = true;
      }
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
    return removed;
  }

  private recentIpFailures(ip: string, now: number): number[] {
    const recent = (this.ipFailures.get(ip) ?? []).filter(
      (failureAt) => now - failureAt <= IP_FAILURE_WINDOW_MS,
    );
    if (recent.length === 0) this.ipFailures.delete(ip);
    else this.ipFailures.set(ip, recent);
    return recent;
  }

  /** 进程在 write/rename 之间被杀会留 .tmp；启动时顺手删掉（无明文、无安全影响）。 */
  private discardStaleTmp(path: string): void {
    const tmp = `${path}.tmp`;
    if (!existsSync(tmp)) return;
    try {
      unlinkSync(tmp);
    } catch {
      // best effort：删不掉不得阻断启动
    }
  }

  private loadFromDisk(now: number): void {
    const path = this.persistPath;
    if (!path) return;
    this.discardStaleTmp(path);
    // 文件不存在也要钉节流时钟，否则随后 authenticate 会因 lastSeenPersistedAt=0 立刻写盘
    if (!existsSync(path)) {
      this.lastSeenPersistedAt = now;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('ui_session_store_corrupt');
    }
    if (!isPersistedStore(parsed)) {
      throw new Error('ui_session_store_corrupt');
    }

    let pruned = false;
    for (const [sidHash, row] of Object.entries(parsed)) {
      if (isExpired(row, now)) {
        pruned = true;
        continue;
      }
      // 重启后无明文 token；authenticate 走 resolveTokenHash
      this.sessions.set(sidHash, {
        tokenHash: row.tokenHash,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        remembered: row.remembered,
      });
    }
    if (pruned) this.persist();
    // 启动加载后的首批 authenticate 不必立刻再写盘
    this.lastSeenPersistedAt = now;
  }

  private persist(): void {
    const path = this.persistPath;
    if (!path) return;

    const data: PersistedStore = {};
    for (const [sidHash, session] of this.sessions) {
      data[sidHash] = {
        tokenHash: session.tokenHash,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        remembered: session.remembered,
      };
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // bind mount 可能属主不同；文件 mode 仍会设置
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    try {
      // rename 后目标文件 mode 可能继承旧 inode；再钉一次 0600
      if (existsSync(path) && (statSync(path).mode & 0o777) !== 0o600) {
        chmodSync(path, 0o600);
      }
    } catch {
      // best effort
    }
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
