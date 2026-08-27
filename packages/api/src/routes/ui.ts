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
import {
  NotifyError,
  createNotificationDevice,
  listNotificationDevices,
  notificationService,
  provisionIdentityNotifications,
  revokeNotificationDevice,
  type NotifyMessage,
  type NotifyTopic,
} from '../lib/notify.ts';
import {
  SCAN_BACK,
  getMessage,
  getMessageSource,
  listMessagesPage,
  scanMailboxWindow,
  setMessageSeen,
  type MessageDetail,
  type MessageListPage,
  type MessageSourcePayload,
  type MessageSummary,
} from '../lib/imap.ts';
import {
  InvalidMailCursorError,
  MAIL_FOLDERS,
  type MailFolder,
} from '../lib/mail-cursor.ts';
import { createOverviewCache, type ScanOutcome } from '../lib/overview-cache.ts';
import {
  InvalidSendCursorError,
  SendLogCorruptError,
  getSendLogRecord,
  isSendLogLimit,
  querySendLog,
} from '../lib/send-log.ts';
import {
  TASK_BOARD_PERIODS,
  TASK_BOARD_STATUSES,
  type Task,
  type TaskBoardLimit,
  type TaskService,
  taskParticipants,
  taskService,
  toUiTaskView,
} from '../lib/tasks.ts';
import { InvalidTaskCursorError } from '../lib/task-cursor.ts';
import { consumeOAuthReturnCookie } from '../lib/oauth-return.ts';
import {
  UiSessionStore,
  uiPrivateHeaders,
  uiSessionAuth,
} from '../lib/ui-session.ts';
import { MAX_EMAIL_HTML_LENGTH } from '../lib/sanitize-email-html.ts';
import { config } from '../lib/config.ts';
import {
  checkNotifyUserLimit,
  releaseNotifyUserLimit,
} from '../lib/ratelimit.ts';
import {
  InvalidNotifyCursorError,
  NotificationLogCorruptError,
  isLogicalChannel,
  lastSuccessfulAt,
  queryNotificationLog,
  summarizeNotificationLog,
  type NotificationLogicalChannel,
  type NotificationLogLimit,
} from '../lib/notification-log.ts';
import {
  DeviceNotFoundError,
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  DeviceRevokeTransientError,
} from '../lib/notification-devices.ts';

/**
 * 与 routes/notify.ts#toTopic 必须保持同一口径（Dashboard cookie 入口的镜像校验）。
 * 若改一侧，另一侧同步；抽出共享 helper 前先靠注释钉死。
 */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const notifyHistoryQuerySchema = z.object({
  topic: z.string().min(1).max(80),
  since: z.string().min(1).max(64).optional(),
});

function toNotifyTopic(value: string): NotifyTopic | null {
  if (value === 'self' || value === 'user-alerts' || value === 'user-low') return value;
  if (!value.startsWith('agent:')) return null;
  const agent = value.slice('agent:'.length);
  return AGENT_NAME_RE.test(agent) ? `agent:${agent}` : null;
}

export type UiApiDependencies = {
  listIdentities: () => Identity[];
  /**
   * Inbox 列表。第三参为 folder/cursor；可返回数组（旧 mock）或带 nextCursor 的页。
   * 未知 folder 由路由 zod 拦成 400，不进本函数。
   */
  listMessages: (
    address: string,
    limit: number,
    query?: { folder?: MailFolder; cursor?: string },
  ) => Promise<MessageSummary[] | MessageListPage>;
  getMessage: (address: string, id: string) => Promise<MessageDetail | null>;
  /** 受控 Source；缺省走 imap.getMessageSource。 */
  getMessageSource?: (address: string, id: string) => Promise<MessageSourcePayload | null>;
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
  /**
   * 通知历史：语义等同 GET /v1/notify/messages（ACL 在本路由强制，不信任客户端 topic）。
   * 测试可注入；生产默认走 notificationService().messages。
   */
  notifyMessages?: (
    topic: NotifyTopic,
    identityAddress?: string,
    since?: string,
  ) => Promise<NotifyMessage[]>;
  /** UI verify 测试缝；生产默认走 notificationService().verify。 */
  notifyVerify?: () => Promise<{ ok: true }>;
  /**
   * 任务工单：语义等同 GET /v1/tasks（ACL 在本路由强制）。
   * 测试可注入；生产默认走 taskService。
   */
  taskService?: Pick<
    TaskService,
    'list' | 'listBoard' | 'get' | 'getForAuthorization' | 'reply' | 'remind' | 'close' | 'decideApproval'
  >;
};

/** 进程内单例：快照与会话一样活在进程里，重启后第一次 Overview 是冷启动。 */
const overviewCache = createOverviewCache({
  scan: (opts) => scanMailboxWindow(opts),
});

const defaultDependencies: UiApiDependencies = {
  listIdentities: () =>
    listIdentities().map((identity) => findIdentity(identity.address) ?? identity),
  listMessages: (address, limit, query) =>
    listMessagesPage(address, {
      limit,
      folder: query?.folder ?? 'inbox',
      cursor: query?.cursor,
    }),
  getMessage,
  getMessageSource,
  setMessageSeen,
  getMailboxScan: (opts) => overviewCache.getOverview(opts),
  setPushContentTier: setIdentityPushContentTier,
  notifyMessages: (topic, identityAddress, since) =>
    notificationService().messages(topic, identityAddress, since),
  taskService,
};

const taskBoardQuerySchema = z.object({
  status: z.enum(TASK_BOARD_STATUSES).optional().default('active'),
  period: z.enum(TASK_BOARD_PERIODS).optional().default('30d'),
  limit: z
    .union([z.literal('20'), z.literal('50'), z.literal('100')])
    .optional()
    .default('20')
    .transform((value): TaskBoardLimit => Number(value) as TaskBoardLimit),
  cursor: z.string().min(1).max(1024).optional(),
});
const taskIdParamSchema = z.string().uuid();
/** UI cookie 入口 body-limit 仍是 4KiB；字段上限必须能放进该信封。 */
const UI_TASK_TEXT_MAX = 3000;
const taskReplySchema = z
  .object({
    body: z.string().min(1).max(UI_TASK_TEXT_MAX),
    from: z.string().email().optional(),
  })
  .strict();
const taskRemindSchema = z
  .object({
    body: z.string().max(UI_TASK_TEXT_MAX).optional(),
    from: z.string().email().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
const taskCloseSchema = z
  .object({
    reason: z.string().min(1).max(UI_TASK_TEXT_MAX),
    from: z.string().email().optional(),
  })
  .strict();
const taskDecisionSchema = z.object({
  from: z.string().email().optional(),
  decision: z.enum(['approved', 'rejected']),
}).strict();

/** 与 routes/tasks.ts#canReadTask 保持同一口径（Dashboard cookie 入口的镜像）。 */
function canReadUiTask(c: Context, task: Task): boolean {
  const auth = getAuth(c);
  // 参与者集合按小写存；identity 会话地址比较前归一化，避免大小写漂移。
  return auth.kind === 'admin' || taskParticipants(task).has(auth.address.toLowerCase());
}

function authorizationUiTask(service: Pick<TaskService, 'get' | 'getForAuthorization'>, id: string): Promise<Task | null> {
  const read = service === taskService || service.getForAuthorization !== taskService.getForAuthorization
    ? service.getForAuthorization
    : undefined;
  return (read ?? service.get)(id);
}

/** GET :id 与 reply/remind/close 成功体同一套 viewer 投影，不扩权限。 */
function presentUiTask(c: Context, task: Task) {
  if (!canReadUiTask(c, task)) {
    return c.json({ error: 'forbidden: task participant required' }, 403);
  }
  return c.json(toUiTaskView(task));
}

/** identity 用自身；admin 必须显式选择任务中的本方 from。 */
function taskActionFrom(c: Context, task: Task, supplied: string | undefined): string | Response {
  const auth = getAuth(c);
  if (auth.kind === 'identity') {
    if (supplied && supplied.toLowerCase() !== auth.address.toLowerCase()) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }
    const from = auth.address.toLowerCase();
    if (!taskParticipants(task).has(from)) {
      return c.json({ error: 'forbidden: task participant required' }, 403);
    }
    return from;
  }
  if (!supplied) return c.json({ error: 'from is required for an admin key' }, 400);
  const from = supplied.toLowerCase();
  if (!taskParticipants(task).has(from)) {
    return c.json({ error: 'invalid_request: from must be a task participant' }, 400);
  }
  return from;
}

function taskMutationError(c: Context, err: unknown): Response {
  const code = (err as Error).message;
  if (code === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (code === 'task_already_terminal' || code === 'task_lease_required') return c.json({ error: code }, 409);
  if (code === 'task_expired' || code === 'task_already_decided' || code === 'not_approval_task' || code === 'approval_decision_required') {
    return c.json({ error: code }, 409);
  }
  if (code === 'task_not_input_required') return c.json({ error: 'task_not_input_required' }, 409);
  if (code === 'task_remind_cooldown') return c.json({ error: 'task_remind_cooldown' }, 429);
  if (code === 'task_participant_required') {
    return c.json({ error: 'forbidden: task participant required' }, 403);
  }
  if (code === 'approval_reviewer_required') return c.json({ error: 'forbidden: approval reviewer required' }, 403);
  if (err instanceof InvalidTaskCursorError) return c.json({ error: 'invalid_cursor' }, 400);
  console.warn('[task] ui mutation failed:', (err as Error).message);
  return c.json({ error: 'smtp_error' }, 502);
}

/** 将 NotifyError 折成与 /v1/notify 一致的 JSON 状态码（历史只读路径）。 */
function notifyHistoryError(c: Context, err: unknown) {
  if (!(err instanceof NotifyError)) throw err;
  if (err.code === 'notifications_disabled' || err.code === 'notifications_unconfigured') {
    return c.json(
      err.details?.message ? { error: err.code, message: err.details.message } : { error: err.code },
      503,
    );
  }
  if (err.code === 'unknown_agent') return c.json({ error: err.code }, 404);
  return c.json({ error: err.code }, 502);
}

function deviceUiError(c: Context, err: unknown) {
  if (err instanceof DeviceNotFoundError) return c.json({ error: err.code }, 404);
  if (err instanceof DeviceRegistryCorruptError) return c.json({ error: err.code }, 500);
  if (err instanceof DeviceRegistryPersistError) return c.json({ error: err.code }, 502);
  if (err instanceof DeviceRevokeTransientError) return c.json({ error: err.code }, 502);
  return notifyHistoryError(c, err);
}

function notificationLogError(c: Context, err: unknown) {
  if (err instanceof InvalidNotifyCursorError) {
    return c.json({ error: 'invalid_cursor' }, 400);
  }
  if (err instanceof NotificationLogCorruptError) {
    return c.json({ error: 'notification_log_corrupt' }, 500);
  }
  throw err;
}

const notificationsQuerySchema = z.object({
  channel: z.string().min(1).max(80).optional(),
  level: z.enum(['urgent', 'normal', 'low']).optional(),
  from: z.string().min(1).max(64).optional(),
  to: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  // 查询串是字符串；只接受 20|50|100 字面量，禁止 coerce 后再兜底。
  limit: z
    .union([z.literal('20'), z.literal('50'), z.literal('100')])
    .optional()
    .default('20')
    .transform((value): NotificationLogLimit => Number(value) as NotificationLogLimit),
});

const notifySummaryQuerySchema = z.object({
  date: z.string().min(1).max(32).default('today'),
  tz: z.string().min(1).max(80),
});

const notifyDiagnosticsQuerySchema = z.object({
  channel: z.string().min(1).max(80).optional(),
});

function ownAgentChannel(c: Context): NotificationLogicalChannel | null {
  const auth = getAuth(c);
  if (auth.kind !== 'identity') return null;
  const localpart = auth.address.split('@')[0];
  return localpart && AGENT_NAME_RE.test(localpart) ? `agent:${localpart}` : null;
}

/**
 * identity：强制自身 agent channel，越权 channel → 403。
 * admin：省略 = 全实例；给出的 channel 必须是合法逻辑频道。
 */
function scopeNotificationChannel(
  c: Context,
  requested: string | undefined,
): NotificationLogicalChannel | undefined | Response {
  const auth = getAuth(c);
  if (auth.kind === 'identity') {
    const own = ownAgentChannel(c);
    if (!own) return c.json({ error: 'forbidden' }, 403);
    if (requested && requested !== own && requested !== 'self') {
      return c.json({ error: 'forbidden: token is scoped to another notification channel' }, 403);
    }
    return own;
  }
  if (!requested) return undefined;
  if (!isLogicalChannel(requested)) {
    return c.json({ error: 'invalid_request: unknown channel' }, 400);
  }
  return requested;
}

/** 与 Bearer /v1/notify/verify 同一授权：admin 或 canNotifyUser。 */
function requireUiUserNotifyPermission(c: Context): Response | { actor: string } {
  const auth = getAuth(c);
  if (auth.kind === 'admin') return { actor: 'admin' };
  if (!findIdentity(auth.address)?.canNotifyUser) {
    return c.json({ error: 'forbidden: can_notify_user required' }, 403);
  }
  return { actor: auth.address };
}

/** 「最近活跃」的窗口长度（小时）。 */
const RECENT_HOURS = 24;

const listQuerySchema = z.object({
  address: z.string().email(),
  folder: z.enum(MAIL_FOLDERS).default('inbox'),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** 兼容测试 mock 仍返回数组。 */
function asMessagePage(raw: MessageSummary[] | MessageListPage): MessageListPage {
  if (Array.isArray(raw)) return { messages: raw, nextCursor: null };
  return { messages: raw.messages, nextCursor: raw.nextCursor ?? null };
}

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
  // 设备 / 身份写操作仅实例 admin。现网 Auth 只有 admin | identity：
  // identity 会话与任何非 admin（含未来平台运营主体）一律 403，不得解释为 admin。
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

  routes.get('/me', (c) => {
    const auth = getAuth(c);
    // 已登录用户打开 /ui 时若仍挂着 OAuth return cookie，一并交给前端回跳。
    const returnTo = consumeOAuthReturnCookie(c);
    return c.json(returnTo ? { ...auth, returnTo } : auth);
  });

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

  const sendLogQuerySchema = z.object({
    address: z.string().email().max(254).optional(),
    limit: z
      .union([z.literal('20'), z.literal('50'), z.literal('100')])
      .optional()
      .default('50')
      .transform((value) => Number(value)),
    cursor: z.string().min(1).max(1024).optional(),
  });

  function sendLogQueryError(c: Context, err: unknown) {
    if (err instanceof InvalidSendCursorError) return c.json({ error: 'invalid_cursor' }, 400);
    if (err instanceof SendLogCorruptError) return c.json({ error: 'send_log_corrupt' }, 500);
    throw err;
  }

  /** Sent 审计：identity 只看自己的 from；admin 可筛地址。 */
  routes.get('/send-log', async (c) => {
    const parsed = sendLogQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    if (!isSendLogLimit(parsed.data.limit)) return c.json({ error: 'invalid_request' }, 400);
    const auth = getAuth(c);
    let address = parsed.data.address?.toLowerCase();
    if (auth.kind === 'identity') {
      if (address && address !== auth.address.toLowerCase()) {
        return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
      }
      address = auth.address.toLowerCase();
    }
    try {
      return c.json(
        await querySendLog({
          address,
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        }),
      );
    } catch (err) {
      return sendLogQueryError(c, err);
    }
  });

  routes.get('/send-log/:id', async (c) => {
    const id = c.req.param('id');
    if (!id.startsWith('snd_')) return c.json({ error: 'invalid_request' }, 400);
    try {
      const row = await getSendLogRecord(id);
      if (!row) return c.json({ error: 'not_found' }, 404);
      const denied = forbidUnlessAddress(c, row.from);
      if (denied) return denied;
      return c.json(row);
    } catch (err) {
      return sendLogQueryError(c, err);
    }
  });

  routes.get('/messages', async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    try {
      const raw = await dependencies.listMessages(address, parsed.data.limit, {
        folder: parsed.data.folder,
        cursor: parsed.data.cursor,
      });
      const page = asMessagePage(raw);
      return c.json({ messages: page.messages, nextCursor: page.nextCursor });
    } catch (err) {
      if (err instanceof InvalidMailCursorError) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      throw err;
    }
  });

  /** Source 必须先于 /messages/:id 注册，避免被 :id 吞掉。 */
  routes.get('/messages/:id/source', async (c) => {
    const parsed = detailQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!isValidMessageUid(id)) return c.json({ error: 'invalid_request' }, 400);

    c.header('Cache-Control', 'no-store');
    const getter = dependencies.getMessageSource ?? getMessageSource;
    const payload = await getter(address, id);
    if (!payload) return c.json({ error: 'not_found' }, 404);
    return c.json(payload);
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

  /**
   * Dashboard 任务工单板：status/period/limit/cursor + overdue。
   * identity 仅参与者可见；admin 全量。terminal 超 30 天不可见。
   */
  routes.get('/tasks', async (c) => {
    const parsed = taskBoardQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const service = dependencies.taskService ?? taskService;
    const auth = getAuth(c);
    const viewer =
      auth.kind === 'admin'
        ? ({ kind: 'admin' } as const)
        : ({ kind: 'identity', address: auth.address } as const);
    try {
      return c.json(
        await service.listBoard(
          {
            status: parsed.data.status,
            period: parsed.data.period,
            limit: parsed.data.limit,
            cursor: parsed.data.cursor,
          },
          viewer,
        ),
      );
    } catch (err) {
      if (err instanceof InvalidTaskCursorError) return c.json({ error: 'invalid_cursor' }, 400);
      throw err;
    }
  });

  routes.get('/tasks/:id', async (c) => {
    const parsed = taskIdParamSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const service = dependencies.taskService ?? taskService;
    const authorization = await authorizationUiTask(service, parsed.data);
    if (!authorization) return c.json({ error: 'not_found' }, 404);
    if (!canReadUiTask(c, authorization)) return c.json({ error: 'forbidden: task participant required' }, 403);
    const task = service.getForAuthorization && (service === taskService || service.getForAuthorization !== taskService.getForAuthorization)
      ? await service.get(parsed.data)
      : authorization;
    if (!task) return c.json({ error: 'not_found' }, 404);
    // overdue 由服务端按 queryNow 同类时钟计算，避免各浏览器口径漂移。
    return presentUiTask(c, task);
  });

  /** Approval decisions share the core service gate; this route merely maps
   * cookie identity/admin context to its stored reviewer. */
  routes.post('/tasks/:id/decision', async (c) => {
    const parsed = taskIdParamSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const body = taskDecisionSchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_request', details: body.error.issues }, 400);
    const service = dependencies.taskService ?? taskService;
    const task = await authorizationUiTask(service, parsed.data);
    if (!task) return c.json({ error: 'not_found' }, 404);
    if (!canReadUiTask(c, task)) return c.json({ error: 'not_found' }, 404);
    if (task.kind !== 'approval' || !task.approval) return c.json({ error: 'not_approval_task' }, 409);
    const auth = getAuth(c);
    const from = auth.kind === 'identity'
      ? (body.data.from && body.data.from.toLowerCase() !== auth.address.toLowerCase()
        ? null
        : auth.address.toLowerCase())
      : body.data.from?.toLowerCase();
    if (!from || from !== task.approval.reviewer) {
      return c.json({ error: 'forbidden: approval reviewer required' }, 403);
    }
    try {
      const decide = service.decideApproval;
      if (!decide) throw new Error('approval_service_unavailable');
      return presentUiTask(c, await decide({ id: parsed.data, from, decision: body.data.decision }));
    } catch (err) {
      return taskMutationError(c, err);
    }
  });

  /** 人在 input-required 时补料；写 working 事件。identity=自身，admin 必须显式选本方 from。 */
  routes.post('/tasks/:id/reply', async (c) => {
    const parsed = taskIdParamSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const body = taskReplySchema.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.issues }, 400);
    }
    const service = dependencies.taskService ?? taskService;
    const task = await authorizationUiTask(service, parsed.data);
    if (!task) return c.json({ error: 'not_found' }, 404);
    if (!canReadUiTask(c, task)) {
      return c.json({ error: 'forbidden: task participant required' }, 403);
    }
    const from = taskActionFrom(c, task, body.data.from);
    if (from instanceof Response) return from;
    try {
      return presentUiTask(c, await service.reply({ id: parsed.data, from, body: body.data.body }));
    } catch (err) {
      return taskMutationError(c, err);
    }
  });

  /** admin 催办：新 reminder event，不改变 task.state；已 terminal → 409。 */
  routes.post('/tasks/:id/remind', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    const parsed = taskIdParamSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const body = taskRemindSchema.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.issues }, 400);
    }
    const service = dependencies.taskService ?? taskService;
    const task = await service.get(parsed.data);
    if (!task) return c.json({ error: 'not_found' }, 404);
    if (task.kind === 'approval') return c.json({ error: 'approval_decision_required' }, 409);
    const from = taskActionFrom(c, task, body.data.from);
    if (from instanceof Response) return from;
    try {
      return presentUiTask(
        c,
        await service.remind({
          id: parsed.data,
          from,
          body: body.data.body,
          idempotencyKey: body.data.idempotencyKey,
        }),
      );
    } catch (err) {
      return taskMutationError(c, err);
    }
  });

  /** admin 关闭：terminal failed + closed_by_admin；已 terminal → 409。 */
  routes.post('/tasks/:id/close', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    const parsed = taskIdParamSchema.safeParse(c.req.param('id'));
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const body = taskCloseSchema.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_request', details: body.error.issues }, 400);
    }
    const service = dependencies.taskService ?? taskService;
    const task = await service.get(parsed.data);
    if (!task) return c.json({ error: 'not_found' }, 404);
    const from = taskActionFrom(c, task, body.data.from);
    if (from instanceof Response) return from;
    try {
      return presentUiTask(c, await service.close({ id: parsed.data, from, reason: body.data.reason }));
    } catch (err) {
      return taskMutationError(c, err);
    }
  });

  /**
   * Dashboard 通知记录：cookie 会话入口，ACL 与 GET /v1/notify/messages 对齐
   *（identity 只能读自己的 agent topic；admin 必须显式选 topic，禁止 self）。
   */
  routes.get('/notify/messages', async (c) => {
    const parsed = notifyHistoryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    let topic = toNotifyTopic(parsed.data.topic);
    if (!topic) return c.json({ error: 'invalid_request' }, 400);

    const auth = getAuth(c);
    let identityAddress: string | undefined;
    if (auth.kind === 'identity') {
      const localpart = auth.address.split('@')[0];
      const own = localpart ? (`agent:${localpart}` as NotifyTopic) : null;
      if (!own) return c.json({ error: 'forbidden' }, 403);
      // 授权边界：identity 不可用历史窥探 user 频道或其他 agent。
      if (topic === 'self') topic = own;
      if (topic !== own) {
        return c.json({ error: 'forbidden: token is scoped to another notification topic' }, 403);
      }
      identityAddress = auth.address;
    } else if (topic === 'self') {
      return c.json({ error: 'invalid_request: admin must choose a topic' }, 400);
    }

    const read =
      dependencies.notifyMessages ??
      ((t, addr, since) => notificationService().messages(t, addr, since));
    try {
      return c.json({ messages: await read(topic, identityAddress, parsed.data.since) });
    } catch (err) {
      return notifyHistoryError(c, err);
    }
  });

  /**
   * 30 天通知日志：cookie 会话入口。identity 强制自身 agent channel；
   * admin 可查本实例全部逻辑 channel。不回填 ntfy 12h。
   */
  routes.get('/notifications', async (c) => {
    const parsed = notificationsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    if (parsed.data.from && !Number.isFinite(Date.parse(parsed.data.from))) {
      return c.json({ error: 'invalid_request: from' }, 400);
    }
    if (parsed.data.to && !Number.isFinite(Date.parse(parsed.data.to))) {
      return c.json({ error: 'invalid_request: to' }, 400);
    }
    const scoped = scopeNotificationChannel(c, parsed.data.channel);
    if (scoped instanceof Response) return scoped;

    try {
      const page = await queryNotificationLog({
        channel: scoped,
        level: parsed.data.level,
        from: parsed.data.from,
        to: parsed.data.to,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
      return c.json(page);
    } catch (err) {
      return notificationLogError(c, err);
    }
  });

  /** Overview 卡与 Notifications 今日小结同一数据源。 */
  routes.get('/notify/summary', async (c) => {
    const parsed = notifySummaryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const scoped = scopeNotificationChannel(c, undefined);
    if (scoped instanceof Response) return scoped;
    try {
      const summary = await summarizeNotificationLog({
        date: parsed.data.date,
        tz: parsed.data.tz,
        channel: scoped,
      });
      return c.json(summary);
    } catch (err) {
      if (err instanceof RangeError) {
        return c.json({ error: 'invalid_request: date or tz' }, 400);
      }
      return notificationLogError(c, err);
    }
  });

  /**
   * 「为什么我没收到」自查。不返回物理 topic / secret。
   * identity 强制看自身 agent channel；admin 可指定逻辑 channel。
   */
  routes.get('/notify/diagnostics', async (c) => {
    const parsed = notifyDiagnosticsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const scoped = scopeNotificationChannel(c, parsed.data.channel);
    if (scoped instanceof Response) return scoped;
    const auth = getAuth(c);
    const canVerify =
      auth.kind === 'admin' || Boolean(findIdentity(auth.address)?.canNotifyUser);
    try {
      const last = await lastSuccessfulAt(scoped);
      return c.json({
        enabled: config.ntfy.enabled,
        configured: Boolean(config.ntfy.enabled && config.ntfy.adminPassword),
        channel: scoped ?? null,
        lastSuccessfulAt: last,
        canVerify,
      });
    } catch (err) {
      return notificationLogError(c, err);
    }
  });

  /** UI 镜像 Bearer POST /v1/notify/verify：同一 service、权限与 rate limit。 */
  routes.post('/notify/verify', async (c) => {
    const allowed = requireUiUserNotifyPermission(c);
    if (allowed instanceof Response) return allowed;
    const limit = checkNotifyUserLimit(allowed.actor, config.ntfy.notifyRateLimit);
    if (!limit.allowed) {
      return c.json(
        {
          error: 'notify_rate_limited',
          limit: config.ntfy.notifyRateLimit,
          retryAfterSec: limit.retryAfterSec,
        },
        429,
      );
    }
    try {
      return c.json(await (dependencies.notifyVerify ?? (() => notificationService().verify()))());
    } catch (err) {
      releaseNotifyUserLimit(allowed.actor, limit.reservation);
      return notifyHistoryError(c, err);
    }
  });

  const uiDeviceNameSchema = z
    .object({
      displayName: z.string().max(80).optional(),
    })
    .strict();

  /** admin-only 设备列表；identity 与非 admin 一律 403。列表前对账 pending_revoke。 */
  routes.get('/notify/devices', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    try {
      c.header('Cache-Control', 'no-store');
      return c.json({ devices: await listNotificationDevices() });
    } catch (err) {
      return deviceUiError(c, err);
    }
  });

  /** Dashboard 添加设备：复用 create service；凭据 no-store，只展示一次。 */
  routes.post('/notify/devices', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = uiDeviceNameSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    try {
      const created = await createNotificationDevice({ displayName: parsed.data.displayName });
      c.header('Cache-Control', 'no-store');
      return c.json(created, 201);
    } catch (err) {
      return deviceUiError(c, err);
    }
  });

  /** 吊销：pending → 删 ntfy（404 算成功）→ revoked；已 revoked 幂等 204。 */
  routes.delete('/notify/devices/:id', async (c) => {
    const denied = requireUiAdmin(c);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!id || !id.startsWith('dev_') || id.length > 64) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    try {
      await revokeNotificationDevice(id);
      return c.body(null, 204);
    } catch (err) {
      return deviceUiError(c, err);
    }
  });

  return routes;
}
