import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { forbidUnlessAddress, getAuth } from '../lib/auth.ts';
import {
  createIdentity,
  deleteIdentity,
  findIdentity,
  listIdentities,
  LOCALPART_RE,
  PUSH_TIER3_WARNING,
  resolvePushContentTier,
  rotateIdentityToken,
  setIdentityPushContentTier,
  type Identity,
  type PushContentTier,
} from '../lib/identities.ts';
import { NotifyError, provisionIdentityNotifications } from '../lib/notify.ts';
import {
  SCAN_BACK,
  getMessage,
  listMessages,
  scanMailboxWindow,
  setMessageSeen,
  type MessageDetail,
  type MessageSummary,
} from '../lib/imap.ts';
import { createOverviewCache, type ScanOutcome } from '../lib/overview-cache.ts';
import {
  UiSessionStore,
  uiPrivateHeaders,
  uiSessionAuth,
} from '../lib/ui-session.ts';
import { MAX_EMAIL_HTML_LENGTH } from '../lib/sanitize-email-html.ts';

export type UiApiDependencies = {
  listIdentities: () => Identity[];
  listMessages: (address: string, limit: number) => Promise<MessageSummary[]>;
  getMessage: (address: string, id: string) => Promise<MessageDetail | null>;
  /** 标记/清除 \Seen；消息不存在或不属于该地址时返回 false（路由折成 404）。 */
  setMessageSeen: (address: string, id: string, seen: boolean) => Promise<boolean>;
  /**
   * Overview 的唯一入口：缓存与 IMAP 细节都在它后面。
   * 注意**没有** now 尾参 —— 时刻读数一律由缓存层的注入时钟给出，
   * 并经 `outcome.now` 回传，路由自己不取时间。
   */
  getMailboxScan: (opts: {
    refresh: boolean;
    identityAddresses: string[];
  }) => Promise<ScanOutcome>;
  /** Persist an identity's mail-arrival push content tier (admin UI). */
  setPushContentTier: (address: string, tier: PushContentTier) => Identity | null;
};

/** 进程内单例：快照与会话一样活在进程里，重启后第一次 Overview 是冷启动。 */
const overviewCache = createOverviewCache({
  scan: (opts) => scanMailboxWindow(opts),
});

const defaultDependencies: UiApiDependencies = {
  listIdentities: () =>
    listIdentities().map((identity) => findIdentity(identity.address) ?? identity),
  listMessages,
  getMessage,
  setMessageSeen,
  getMailboxScan: (opts) => overviewCache.getOverview(opts),
  setPushContentTier: setIdentityPushContentTier,
};

/** 「最近活跃」的窗口长度（小时）。 */
const RECENT_HOURS = 24;

const listQuerySchema = z.object({
  address: z.string().email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const detailQuerySchema = z.object({
  address: z.string().email(),
});

const seenBodySchema = z
  .object({
    address: z.string().email(),
    seen: z.boolean(),
  })
  .strict();

function identityProjection(identity: Identity) {
  const pushContentTier = resolvePushContentTier(identity);
  return {
    address: identity.address,
    ...(identity.name ? { name: identity.name } : {}),
    createdAt: identity.createdAt,
    hasToken: Boolean(identity.tokenHash),
    pushContentTier,
    ...(pushContentTier === 3 ? { pushContentTierWarning: PUSH_TIER3_WARNING } : {}),
  };
}

const pushTierBodySchema = z
  .object({
    pushContentTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    confirm_risk: z.boolean().optional(),
  })
  .strict();

function requireUiAdmin(c: Context): Response | null {
  if (getAuth(c).kind !== 'admin') {
    return c.json({ error: 'forbidden: admin session required' }, 403);
  }
  return null;
}

/**
 * 响应时刻的 join：per-UID 记录 × 当前身份列表 → 每行统计 + 总计。
 *
 * 去重口径在这里重算（一封投给两个身份的信只让 `matchedInWindow` +1），
 * `activeAddresses` / `recentSince` 也按 `outcome.now` 重算，因此身份增删
 * 立刻反映、无需重扫。逐行完整性判据是 `affected` 集合而不是 `partial`：
 * 只挤掉投机域内地址的快照，所有身份计数仍然精确。
 */
function overviewPayload(
  identities: Identity[],
  outcome: Extract<ScanOutcome, { kind: 'ready' | 'stale' }>,
) {
  const now = outcome.now;
  const snapshot = outcome.snapshot;
  const recentSince = now - RECENT_HOURS * 3_600_000;

  const idSet = new Set(identities.map((identity) => identity.address.toLowerCase()));
  const per = new Map<string, { count: number; unseen: number; lastMs: number }>();
  for (const address of idSet) per.set(address, { count: 0, unseen: 0, lastMs: 0 });

  let matched = 0;
  let unseenMatched = 0;
  for (const record of snapshot?.records ?? []) {
    let hit = false;
    for (const address of record.r) {
      const bucket = per.get(address);
      if (!bucket) continue;
      bucket.count += 1;
      if (!record.s) bucket.unseen += 1;
      if (record.t > bucket.lastMs) bucket.lastMs = record.t;
      hit = true;
    }
    if (hit) {
      matched += 1;
      if (!record.s) unseenMatched += 1;
    }
  }

  // 逐行完整性判定：截断绝不表现为 0
  const scanIdSet = new Set(snapshot?.identityAddressesAtScan ?? []);
  const affected = new Set<string>();
  if (snapshot) {
    for (const address of idSet) {
      // ① 该身份确实被截断规则牺牲过
      if (snapshot.incompleteFor.has(address)) affected.add(address);
      // ② 扫描后才建的身份 + 快照不完整 → 无法证明它没被当作投机地址丢掉
      else if (snapshot.partial && !scanIdSet.has(address)) affected.add(address);
    }
  }
  const exact = affected.size === 0;

  let activeAddresses = 0;
  for (const bucket of per.values()) {
    if (bucket.lastMs > 0 && bucket.lastMs >= recentSince) activeAddresses += 1;
  }

  const addresses = identities.map((identity) => {
    const key = identity.address.toLowerCase();
    const bucket = per.get(key) ?? { count: 0, unseen: 0, lastMs: 0 };
    return {
      ...identityProjection(identity),
      complete: !affected.has(key),
      count: bucket.count,
      unseen: bucket.unseen,
      lastReceivedAt: bucket.lastMs > 0 ? new Date(bucket.lastMs).toISOString() : null,
    };
  });

  return {
    status: outcome.kind,
    generatedAt: new Date(snapshot ? snapshot.scannedAt : now).toISOString(),
    ageSeconds: snapshot ? Math.max(0, Math.floor((now - snapshot.scannedAt) / 1000)) : 0,
    cached: outcome.cached,
    revalidating: outcome.revalidating,
    refreshError: outcome.refreshError,
    ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    scan: {
      scanBack: SCAN_BACK,
      // 跳过扫描时窗口派生量未被观测，用 null 而不是 0
      scanned: snapshot ? snapshot.scanned : null,
      mailboxTotal: snapshot ? snapshot.mailboxTotal : null,
      truncated: snapshot ? snapshot.truncated : false,
      skipped: snapshot === null,
      partial: snapshot ? snapshot.partial : false,
    },
    totals: {
      addresses: addresses.length,
      matchedInWindow: matched,
      // exact:false 时方向变成上界，skipped 时未观测 —— 两种都置 null
      unmatchedInWindow: snapshot && exact ? snapshot.scanned - matched : null,
      unseenInWindow: unseenMatched,
      activeAddresses,
      exact,
      recentHours: RECENT_HOURS,
      recentSince: new Date(recentSince).toISOString(),
    },
    addresses,
  };
}

export function isValidMessageUid(id: string): boolean {
  if (!/^[1-9]\d{0,9}$/.test(id)) return false;
  const uid = Number(id);
  return Number.isSafeInteger(uid) && uid <= 4_294_967_295;
}

export function createUiApiRoutes(
  store: UiSessionStore,
  dependencies: UiApiDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.use('*', uiPrivateHeaders);
  routes.use('*', uiSessionAuth(store));

  routes.get('/me', (c) => c.json(getAuth(c)));

  routes.get('/identities', (c) => {
    const auth = getAuth(c);
    const all = dependencies.listIdentities();
    const visible =
      auth.kind === 'admin'
        ? all
        : all.filter((identity) => identity.address === auth.address);
    return c.json({ identities: visible.map(identityProjection) });
  });

  routes.post('/identities', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const name = (body as any)?.name;
    const localpart = (body as any)?.localpart;
    const input: { name?: string; localpart?: string } = {};
    if (typeof name === 'string' && name.length >= 1 && name.length <= 100) {
      input.name = name;
    }
    if (typeof localpart === 'string' && LOCALPART_RE.test(localpart)) {
      input.localpart = localpart.toLowerCase();
    }
    try {
      const created = createIdentity(input);
      if (!created) return c.json({ error: 'address_exists' }, 409);
      try {
        await provisionIdentityNotifications(created.identity);
      } catch (err) {
        deleteIdentity(created.identity.address);
        if (err instanceof NotifyError) return c.json({ error: err.code }, 503);
        throw err;
      }
      return c.json(
        {
          address: created.identity.address,
          ...(created.identity.name ? { name: created.identity.name } : {}),
          token: created.token,
        },
        201,
      );
    } catch (err) {
      if ((err as Error).message === 'invalid_localpart') {
        return c.json({ error: 'invalid_localpart' }, 400);
      }
      throw err;
    }
  });

  routes.post('/identities/:address/token', (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    const token = rotateIdentityToken(c.req.param('address'));
    if (!token) return c.json({ error: 'not_found' }, 404);
    return c.json({ address: c.req.param('address').toLowerCase(), token });
  });

  routes.put('/identities/:address/push-tier', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = pushTierBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const { pushContentTier: tier, confirm_risk: confirmRisk } = parsed.data;
    if (tier === 3 && confirmRisk !== true) {
      return c.json(
        {
          error: 'confirm_risk_required',
          message: PUSH_TIER3_WARNING,
        },
        400,
      );
    }
    const updated = dependencies.setPushContentTier(c.req.param('address'), tier);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    const resolved = resolvePushContentTier(updated);
    return c.json({
      address: updated.address,
      pushContentTier: resolved,
      ...(resolved === 3 ? { warning: PUSH_TIER3_WARNING } : {}),
    });
  });

  routes.delete('/identities/:address', (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    if (!deleteIdentity(c.req.param('address'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ deleted: true });
  });

  routes.get('/overview', async (c) => {
    // 授权先于一切 I/O：identity 会话下 listIdentities / 缓存 / IMAP 均为零次
    const auth = getAuth(c);
    if (auth.kind !== 'admin') {
      return c.json({ error: 'forbidden: admin session required' }, 403);
    }
    // ?refresh 只认字面 1，其他值等同不传
    const refresh = c.req.query('refresh') === '1';
    const identities = dependencies.listIdentities();
    const outcome = await dependencies.getMailboxScan({
      refresh,
      identityAddresses: identities.map((identity) => identity.address.toLowerCase()),
    });

    if (outcome.kind === 'loading') {
      return c.json({ status: 'loading', retryAfterMs: outcome.retryAfterMs }, 202);
    }
    if (outcome.kind === 'unavailable') {
      c.header('Retry-After', String(outcome.retryAfterSeconds));
      return c.json(
        {
          status: 'unavailable',
          error: 'overview_unavailable',
          reason: outcome.reason,
          retryAfterSeconds: outcome.retryAfterSeconds,
        },
        503,
      );
    }
    return c.json(overviewPayload(identities, outcome));
  });

  routes.get('/messages', async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const messages = await dependencies.listMessages(address, parsed.data.limit);
    return c.json({ messages });
  });

  routes.get('/messages/:id', async (c) => {
    const parsed = detailQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!isValidMessageUid(id)) return c.json({ error: 'invalid_request' }, 400);

    const detail = await dependencies.getMessage(address, id);
    if (!detail) return c.json({ error: 'not_found' }, 404);
    const { html: _html, ...safeDetail } = detail;
    return c.json({
      ...safeDetail,
      hasHtml: Boolean(detail.html),
      htmlTooLarge:
        typeof detail.html === 'string' &&
        detail.html.length > MAX_EMAIL_HTML_LENGTH,
    });
  });

  routes.post('/messages/:id/seen', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const parsed = seenBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!isValidMessageUid(id)) return c.json({ error: 'invalid_request' }, 400);

    const marked = await dependencies.setMessageSeen(address, id, parsed.data.seen);
    if (!marked) return c.json({ error: 'not_found' }, 404);
    return c.json({ id, seen: parsed.data.seen });
  });

  return routes;
}
