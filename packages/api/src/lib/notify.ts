/**
 * Server-side ntfy adapter.
 *
 * Topics and ntfy credentials never leave this process. Agents talk only to
 * the REST/MCP notify operations. Phone setup is an admin-only REST action;
 * its one-time reader password is never written into this JSON state. The
 * state mirrors identities.json: small, atomic and owner-only. ntfy itself
 * uses its own auth database for ACL enforcement.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordAuditEvent } from './audit.ts';
import { config } from './config.ts';
import { findIdentity, listIdentities, type Identity } from './identities.ts';
import {
  appendNotificationLog,
  logicalChannelFor,
  notificationLogHealthAlert,
  inspectLegacyLocalpartOwnerEvidence,
  type NotificationLogicalChannel,
  type NotificationLogicalTarget,
  type NotificationSource,
} from './notification-log.ts';
import {
  DeviceNotFoundError,
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  listPairedDevices,
  peekPairedDevice,
  reconcilePendingRevokes,
  registerPairedDevice,
  revokePairedDevice,
  type DeleteNtfyUser,
  type DeviceListItem,
  type NtfyUserDeleteResult,
} from './notification-devices.ts';
import { encodeQrModules } from './qr-byte.ts';

export type NotifyLevel = 'urgent' | 'normal' | 'low';
export type NotifyTarget = 'user' | `agent:${string}`;
export type NotifyTopic = 'self' | 'user-alerts' | 'user-low' | `agent:${string}`;
/**
 * When serialized ntfy JSON still exceeds NTFY_REQUEST_MAX_BYTES after optional
 * click-drop (F76):
 * - `truncate` — shorten message with ellipsis (mail-arrival watcher only; must
 *   not throw or the UID watermark stalls).
 * - `error` — throw message_too_large (default; manual /v1/notify must not
 *   silently cut the body and return 200).
 */
export type NotifyOverflow = 'truncate' | 'error';

/** 旧 localpart 键属主烙印：完整地址，或 ambiguous（拒绝回退）。 */
export const LEGACY_OWNER_AMBIGUOUS = 'ambiguous';

export interface NotifyInput {
  target: NotifyTarget;
  title: string;
  message: string;
  level: NotifyLevel;
  tags?: string[];
  /** Optional ntfy click action URL (e.g. dashboard origin for mail-arrival pushes). */
  click?: string;
  /**
   * Final privacy check after all internal awaits and body serialization,
   * immediately before fetch(). Return false to abort without sending.
   */
  beforeSend?: () => boolean;
  /** Default `error`. Watcher passes `truncate`. Click-drop runs before this. */
  overflow?: NotifyOverflow;
  /**
   * 审计元数据：不进入 ntfy JSON。落在具体 publish 成功路径内写入 30 天日志。
   * 缺省 source 按 manual 记，避免漏埋点；四来源调用方应显式传入。
   */
  source?: NotificationSource;
  logicalChannel?: NotificationLogicalChannel;
  sensitive?: boolean;
  identityAddress?: string;
}

export interface NotifyMessage {
  id: string;
  time: number;
  title: string;
  message: string;
  priority: number;
  tags: string[];
}

export interface NotifyService {
  publish(input: NotifyInput): Promise<{ target: NotifyTarget; title: string; level: NotifyLevel }>;
  messages(topic: NotifyTopic, identityAddress?: string, since?: string): Promise<NotifyMessage[]>;
  verify(): Promise<{ ok: true }>;
}

/** One-time credentials for a human phone. password 只出现在本响应，永不落盘。 */
export type NotificationDevice = {
  id: string;
  displayName: string;
  username: string;
  password: string;
  serverUrl: string;
  topics: {
    userAlerts: string;
    userLow: string;
  };
  qrPayload: {
    serverUrl: string;
    username: string;
    password: string;
    topics: {
      userAlerts: string;
      userLow: string;
    };
  };
  /** 一次性 QR 模块图；列表接口永不返回。编码失败则省略，copy 字段仍可用。 */
  qr?: {
    size: number;
    modules: string;
  };
};

type NotifyFailureKind = 'message' | 'service';
const NOTIFY_FAILURE_KIND = Symbol('notifyFailureKind');

export class NotifyError extends Error {
  readonly [NOTIFY_FAILURE_KIND]?: NotifyFailureKind;

  constructor(
    public readonly code:
      | 'notifications_disabled'
      | 'notifications_unconfigured'
      | 'notify_unavailable'
      | 'notify_cancelled'
      | 'verify_failed'
      | 'unknown_agent'
      | 'invalid_agent_name'
      | 'message_too_large'
      | 'device_registry_unavailable',
    public readonly details?: {
      maxRequestBytes?: number;
      availableMessageBytes?: number;
      /** 给人看的原因；API 可原样返回。 */
      message?: string;
    },
    /** @internal Watcher-only failure routing; never serialized by REST handlers. */
    internal?: { failureKind: NotifyFailureKind },
  ) {
    super(code);
    this[NOTIFY_FAILURE_KIND] = internal?.failureKind;
  }
}

/** @internal Distinguishes provider-wide outages from one rejected payload. */
export function isNotifyServiceFailure(err: unknown): boolean {
  // Only an explicitly classified payload rejection may consume a UID.
  // Unknown/plain failures retain it and are still bounded by the watcher's
  // 10-minute CRITICAL fallback instead of silently losing outage traffic.
  if (err instanceof NotifyError && err.code === 'notify_cancelled') return false;
  return !(err instanceof NotifyError) || err[NOTIFY_FAILURE_KIND] !== 'message';
}

/** @internal Shared by publish and watcher status-boundary regression tests. */
export function isNtfyPublishServiceStatus(status: number): boolean {
  // Only known payload rejections may consume a UID. An unrecognized status
  // can reflect a shared endpoint/proxy/provider fault, so retain by default.
  return status !== 400 && status !== 413 && status !== 422;
}

type Reader = {
  username: string;
  token: string;
};

type Route = {
  topic: string;
  reader: Reader;
  /**
   * 仅旧裸 localpart 键使用：属主完整地址，或 LEGACY_OWNER_AMBIGUOUS。
   * 完整地址键不写此字段。
   */
  ownerAddress?: string;
};

/** agent reader 吊销对账行：复用 phone 设备线 deleted/not_found/transient 分类。 */
type PendingReaderRevoke = {
  username: string;
  address: string;
  status: 'pending_revoke';
  createdAt: string;
};

type NotifyState = {
  version: 1;
  suffix: string;
  publisherToken: string;
  userAlerts: Route;
  userLow: Route;
  agents: Record<string, Route>;
  /** 可选：身份删除/boot 清幽灵后待对账的 reader 用户名队列。 */
  pendingReaderRevokes?: PendingReaderRevoke[];
};

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_ALPHABET = TOKEN_ALPHABET;
/** 裸 localpart（旧键）或完整地址（新键）；与 routes/notify 目标口径对齐。 */
const AGENT_ROUTE_KEY_RE =
  /^[a-z0-9][a-z0-9._-]{0,62}(?:@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)?$/;
// ntfy's public topic grammar is stricter than our valid identity localparts:
// it has no dots and caps a topic at 64 characters.
const NTFY_TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

function randomFrom(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let value = '';
  for (let i = 0; i < length; i++) value += alphabet[bytes[i]! % alphabet.length];
  return value;
}

function randomToken(): string {
  // ntfy access tokens have the tk_ prefix and are exactly 32 characters.
  return `tk_${randomFrom(TOKEN_ALPHABET, 29)}`;
}

function statePath(): string {
  return join(dirname(config.ntfy.configPath), 'notifications.json');
}

/** 键化用：小写；仅完整地址（含 @）才剥域名尾点，裸 localpart 如 fox. 原样保留。 */
export function canonicalizeAgentAddress(address: string): string {
  const lower = address.toLowerCase().trim();
  if (lower.includes('@')) return lower.replace(/\.+$/, '');
  return lower;
}

function safeAgentName(value: string): string {
  const normalized = canonicalizeAgentAddress(value);
  // 完整地址最长按邮箱惯例封顶；非法/超长映射既有 NotifyError，避免裸 Error→500。
  if (normalized.length > 254 || !AGENT_ROUTE_KEY_RE.test(normalized)) {
    throw new NotifyError('invalid_agent_name');
  }
  return normalized;
}

function route(topic: string, username: string): Route {
  return { topic, reader: { username, token: randomToken() } };
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function physicalAgentTopic(name: string, suffix: string): string {
  const direct = `agent-${name}-${suffix}`;
  if (NTFY_TOPIC_RE.test(direct)) {
    return direct;
  }

  // 逻辑路由可为 agent:<full-address>；仅此私有物理名做规范化。
  // hash 避免点替换/截断后碰撞；下方算术保证 topic ≤64 字。算法本身不得改。
  const normalized = name.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'agent';
  const fragment = normalized.slice(0, 44);
  return `agent-${fragment}-${shortHash(name)}-${suffix}`;
}

function agentRoute(name: string, suffix: string): Route {
  const entry = route(physicalAgentTopic(name, suffix), 'reader-pending');
  // A failed live provision must be safely retryable. Tie the reader name to
  // this fresh route token, not just the identity, so an orphaned ntfy user
  // from a failed attempt cannot block the retry.
  entry.reader.username = `reader-agent-${shortHash(name)}-${shortHash(entry.reader.token)}`;
  return entry;
}

export function userRouteKey(level: NotifyLevel): 'userAlerts' | 'userLow' {
  return level === 'low' ? 'userLow' : 'userAlerts';
}

/** Keep route state unpublished until the matching ntfy startup config exists. */
export async function commitNotificationState(
  writeConfig: () => Promise<void>,
  save: () => void,
): Promise<void> {
  await writeConfig();
  save();
}

/**
 * deleteIdentity 同步级联用的落盘钩子：先请求 writeConfig，再 save JSON。
 * 默认 writeConfig 异步踢 server.yml 重写（不阻塞同步签名）；save 失败即抛。
 */
type SyncCascadeCommitFn = (writeConfig: () => void, save: () => void) => void;

const defaultSyncCascadeCommit: SyncCascadeCommitFn = (writeConfig, save) => {
  writeConfig();
  save();
};

let syncCascadeCommitImpl: SyncCascadeCommitFn = defaultSyncCascadeCommit;

/** @internal 测试缝：注入同步级联落盘（state 持久化失败 fail-closed）。 */
export function setSyncCascadeCommitForTests(fn: SyncCascadeCommitFn | null): void {
  syncCascadeCommitImpl = fn ?? defaultSyncCascadeCommit;
}

function isUsableAgentRoute(entry: Route | undefined): entry is Route {
  return !!entry && NTFY_TOPIC_RE.test(entry.topic) && /^[a-z0-9_-]{1,64}$/.test(entry.reader.username);
}

function makeState(): NotifyState {
  const suffix = randomFrom(SUFFIX_ALPHABET, 4);
  return {
    version: 1,
    suffix,
    publisherToken: randomToken(),
    userAlerts: route(`user-alerts-${suffix}`, 'reader-user-alerts'),
    userLow: route(`user-low-${suffix}`, 'reader-user-low'),
    agents: {},
  };
}

function isReader(value: unknown): value is Reader {
  if (!value || typeof value !== 'object') return false;
  const reader = value as Record<string, unknown>;
  return typeof reader.username === 'string' && typeof reader.token === 'string';
}

function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.topic !== 'string' || !isReader(entry.reader)) return false;
  if (entry.ownerAddress !== undefined && typeof entry.ownerAddress !== 'string') return false;
  return true;
}

function isPendingReaderRevoke(value: unknown): value is PendingReaderRevoke {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.username === 'string' &&
    typeof row.address === 'string' &&
    row.status === 'pending_revoke' &&
    typeof row.createdAt === 'string'
  );
}

function isState(value: unknown): value is NotifyState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (state.pendingReaderRevokes !== undefined) {
    if (!Array.isArray(state.pendingReaderRevokes)) return false;
    if (!state.pendingReaderRevokes.every(isPendingReaderRevoke)) return false;
  }
  return (
    state.version === 1 &&
    typeof state.suffix === 'string' &&
    typeof state.publisherToken === 'string' &&
    isRoute(state.userAlerts) &&
    isRoute(state.userLow) &&
    !!state.agents &&
    typeof state.agents === 'object' &&
    Object.values(state.agents as Record<string, unknown>).every(isRoute)
  );
}

function writePrivate(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // A named volume can have a different owner. File mode below still holds.
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function loadState(): NotifyState {
  const path = statePath();
  if (!existsSync(path)) {
    const state = makeState();
    writePrivate(path, JSON.stringify(state, null, 2));
    return state;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!isState(parsed)) throw new Error('invalid notification store shape');
    // 旧裸 localpart 键烙印属主，防止删身份后跨域复用误绑残留 topic。
    try {
      if (stampLegacyAgentOwners(parsed)) {
        writePrivate(path, JSON.stringify(parsed, null, 2));
      }
    } catch {
      // 烙印失败不阻断加载；下次 load 再试。
    }
    return parsed;
  } catch {
    throw new Error('notification_store_corrupt');
  }
}

/**
 * 给尚未烙印的旧 localpart 键写入 ownerAddress。
 * 唯一持有者且 notification-log 无冲突属主证据 → 烙印；否则 ambiguous。已烙印不覆盖。
 */
function stampLegacyAgentOwners(state: NotifyState): boolean {
  let changed = false;
  const identities = listIdentities();
  for (const [key, entry] of Object.entries(state.agents)) {
    if (key.includes('@')) continue;
    if (entry.ownerAddress !== undefined) continue;
    const holders = identities.filter(
      (i) => i.address.split('@')[0].toLowerCase() === key.toLowerCase(),
    );
    if (holders.length !== 1) {
      entry.ownerAddress = LEGACY_OWNER_AMBIGUOUS;
      changed = true;
      continue;
    }
    const candidate = canonicalizeAgentAddress(holders[0]!.address);
    const evidence = inspectLegacyLocalpartOwnerEvidence(key, candidate);
    entry.ownerAddress =
      evidence === 'conflict' ? LEGACY_OWNER_AMBIGUOUS : candidate;
    changed = true;
  }
  return changed;
}

function saveState(state: NotifyState): void {
  writePrivate(statePath(), JSON.stringify(state, null, 2));
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

let passwordHashForTests: ((password: string) => Promise<string>) | null = null;

async function passwordHash(password: string): Promise<string> {
  if (passwordHashForTests) return passwordHashForTests(password);
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 });
}

/** 测试缝：跳过 bcrypt，避免 CI 上 cost=10 把 5s 用例拖死。 */
export function setNotifyPasswordHashForTests(fn: ((password: string) => Promise<string>) | null): void {
  passwordHashForTests = fn;
}

/**
 * 模块级串行化 + coalesce：挂起期间再调只更新 latest state 引用并返回同一 promise；
 * 开写时再拍 agents 快照。连续 N 次删除合并为尽量少的全量 bcrypt 重写。
 */
let writeServerConfigChain: Promise<void> = Promise.resolve();
let writeServerConfigLatest: NotifyState | null = null;
let writeServerConfigCoalesce: Promise<void> | null = null;

/** @internal 测试缝：每次实际开写时回调当前 agents 键（排队后、await 哈希前）。 */
let writeServerConfigObserverForTests: ((agentKeys: string[]) => void) | null = null;

export function setWriteServerConfigObserverForTests(
  fn: ((agentKeys: string[]) => void) | null,
): void {
  writeServerConfigObserverForTests = fn;
}

/** @internal 测试缝：等待 writeServerConfig 队列排空（含 coalesce drain）。 */
export async function flushWriteServerConfigForTests(): Promise<void> {
  await writeServerConfigChain;
  while (writeServerConfigCoalesce) {
    await writeServerConfigCoalesce;
  }
  await writeServerConfigChain;
}

async function writeServerConfigBody(state: NotifyState): Promise<void> {
  const adminPassword = config.ntfy.adminPassword;
  if (!adminPassword) throw new NotifyError('notifications_unconfigured');

  // 快照在拿到槽位、真正开写时拍。
  writeServerConfigObserverForTests?.(Object.keys(state.agents).sort());
  const readers = [state.userAlerts, state.userLow, ...Object.values(state.agents)];
  const adminHash = await passwordHash(adminPassword);
  const publisherHash = await passwordHash(randomBytes(24).toString('base64url'));
  const readerHashes = await Promise.all(
    readers.map(async (entry) => ({
      username: entry.reader.username,
      hash: await passwordHash(randomBytes(24).toString('base64url')),
      topic: entry.topic,
      token: entry.reader.token,
    })),
  );

  const lines = [
    '# Generated by openagent.email. Do not hand-edit: the API owns topic routing.',
    `base-url: ${quoted(config.ntfy.publicUrl)}`,
    'behind-proxy: true',
    'auth-default-access: "deny-all"',
    'cache-duration: "12h"',
    `cache-file: ${quoted(join(config.ntfy.storageDir, 'cache.db'))}`,
    `auth-file: ${quoted(join(config.ntfy.storageDir, 'auth.db'))}`,
    ...(config.ntfy.upstreamEnabled ? ['upstream-base-url: "https://ntfy.sh"'] : []),
    'auth-users:',
    `  - ${quoted(`admin:${adminHash}:admin`)}`,
    `  - ${quoted(`publisher:${publisherHash}:user`)}`,
    ...readerHashes.map((entry) => `  - ${quoted(`${entry.username}:${entry.hash}:user`)}`),
    'auth-access:',
    '  - "publisher:*:write-only"',
    ...readerHashes.map((entry) => `  - ${quoted(`${entry.username}:${entry.topic}:read-only`)}`),
    'auth-tokens:',
    `  - ${quoted(`publisher:${state.publisherToken}:openagentemail-server`)}`,
    ...readerHashes.map((entry) => `  - ${quoted(`${entry.username}:${entry.token}:reserved-device-reader`)}`),
    '',
  ];
  writePrivate(config.ntfy.configPath, lines.join('\n'));
}

async function writeServerConfig(state: NotifyState): Promise<void> {
  writeServerConfigLatest = state;
  if (writeServerConfigCoalesce) return writeServerConfigCoalesce;

  const drain = (async () => {
    await writeServerConfigChain.then(
      () => undefined,
      () => undefined,
    );
    while (writeServerConfigLatest) {
      const toWrite = writeServerConfigLatest;
      writeServerConfigLatest = null;
      await writeServerConfigBody(toWrite);
    }
  })();

  writeServerConfigCoalesce = drain;
  writeServerConfigChain = drain.then(
    () => undefined,
    () => undefined,
  );
  void drain.finally(() => {
    if (writeServerConfigCoalesce === drain) {
      writeServerConfigCoalesce = null;
      // finally 窗口内若又有新请求，补开一轮 drain
      if (writeServerConfigLatest) void writeServerConfig(writeServerConfigLatest);
    }
  });
  return drain;
}

let cachedState: NotifyState | undefined;

/** @internal Test seam for exercising notification-store load and recovery. */
export function resetNotificationStateForTests(): void {
  cachedState = undefined;
}

/** @internal Test seam for injecting agent routes in memory for testing. */
export function setNotificationAgentRouteForTests(agent: string, route: Route | null): void {
  if (!cachedState) cachedState = loadState();
  if (route) cachedState.agents[agent] = route;
  else delete cachedState.agents[agent];
}

/** @internal 测试缝：读取内存中的 agent 路由键（完整地址或旧 localpart）。 */
export function getNotificationAgentRouteForTests(agent: string): Route | undefined {
  if (!cachedState) cachedState = loadState();
  return cachedState.agents[agent];
}

/** @internal 测试缝：对内存态补跑旧键属主烙印。 */
export function runLegacyOwnerStampForTests(): void {
  if (!cachedState) cachedState = loadState();
  stampLegacyAgentOwners(cachedState);
}

/** @internal 测试缝：读取 pending reader 吊销队列。 */
export function getPendingReaderRevokesForTests(): PendingReaderRevoke[] {
  if (!cachedState) cachedState = loadState();
  return [...(cachedState.pendingReaderRevokes ?? [])];
}

function enqueuePendingReaderRevoke(
  state: NotifyState,
  username: string,
  address: string,
): void {
  if (!username) return;
  const list = state.pendingReaderRevokes ?? (state.pendingReaderRevokes = []);
  if (list.some((row) => row.username === username && row.status === 'pending_revoke')) return;
  list.push({
    username,
    address,
    status: 'pending_revoke',
    createdAt: new Date().toISOString(),
  });
}

/**
 * deleteIdentity 同步级联：删完整地址 agents 键并持久化（请求 writeConfig），
 * reader 落 pending_revoke；裸 localpart 键不碰。state 持久化失败抛错 fail-closed。
 */
export function removeAgentRouteOnIdentityDelete(
  address: string,
  actor = 'deleteIdentity',
): void {
  // 未启用 ntfy：无活凭据可外泄，跳过清理且不物化 notifications.json。
  if (!config.ntfy.enabled) return;

  const agent = canonicalizeAgentAddress(address);
  // 只碰完整地址键；裸 localpart 一行不动（R2-4 跨域复用防线）。
  if (!agent.includes('@')) return;

  if (!cachedState) cachedState = loadState();
  const current = cachedState;
  const entry = current.agents[agent];
  if (!entry) return;

  const previous = entry;
  const previousPending = current.pendingReaderRevokes
    ? current.pendingReaderRevokes.map((row) => ({ ...row }))
    : undefined;
  delete current.agents[agent];
  enqueuePendingReaderRevoke(current, previous.reader.username, agent);

  try {
    // 先落 JSON（fail-closed 边界）；成功后再踢 server.yml，避免回滚与异步重写竞态。
    syncCascadeCommitImpl(
      () => {
        /* writeConfig 延后到 save 成功之后 */
      },
      () => saveState(current),
    );
  } catch (err) {
    current.agents[agent] = previous;
    if (previousPending) current.pendingReaderRevokes = previousPending;
    else delete current.pendingReaderRevokes;
    throw err;
  }

  // 持久化成功后立即 best-effort 首次吊销（保持同步签名不阻塞）。
  // 失败行留 pending，由既有 reconcile/boot 对账收敛——无 boot/无设备列表时也能踢出旧 reader。
  void reconcilePendingReaderRevokes().catch((err) => {
    console.warn('[notify] first reader revoke after identity delete failed', {
      address: agent,
      error: err instanceof Error ? err.message : 'unknown',
    });
  });

  if (config.ntfy.adminPassword) {
    void writeServerConfig(current).catch((err) => {
      console.warn('[notify] server.yml rewrite after agent route delete failed', {
        address: agent,
        error: err instanceof Error ? err.message : 'unknown',
      });
    });
  }

  recordAuditEvent({
    event: 'identity.notify_route.delete',
    outcome: 'ok',
    address: agent,
    actor,
  });
}

/**
 * 对账 pending reader 吊销：复用 deleteNtfyUserResult 三分类。
 * deleted/not_found → 出队收敛；transient → 留 pending 下轮重试。
 * 结尾差集合并：只滤掉本轮已确认 username，迭代间隙新入队行保留。
 * 模块级串行化：避免 deleteIdentity 首次吊销与 boot/list 对账并发互相覆盖。
 * 整体预算（时间+行数双闸）：耗尽即停开新行，已 confirmed 照常合并落盘。
 */
/** 单轮 reader 吊销对账时间预算（ms）；与 NTFY_ADMIN_FETCH_TIMEOUT_MS 同口径常量。 */
export const READER_REVOKE_RECONCILE_BUDGET_MS = 5_000;
/** 单轮最多新开 DELETE 的 pending 行数。 */
export const READER_REVOKE_RECONCILE_MAX_ROWS = 32;

let readerRevokeReconcileBudgetMsForTests: number | null = null;
let readerRevokeReconcileMaxRowsForTests: number | null = null;

/** @internal 测试缝：注入对账时间预算（null 恢复默认）。 */
export function setReaderRevokeReconcileBudgetForTests(ms: number | null): void {
  readerRevokeReconcileBudgetMsForTests = ms;
}

/** @internal 测试缝：注入单轮最大开行数（null 恢复默认）。 */
export function setReaderRevokeReconcileMaxRowsForTests(n: number | null): void {
  readerRevokeReconcileMaxRowsForTests = n;
}

function readerRevokeReconcileBudgetMs(): number {
  const raw = readerRevokeReconcileBudgetMsForTests ?? READER_REVOKE_RECONCILE_BUDGET_MS;
  // clamp 风格：有限正整数，至少 1ms
  if (!Number.isFinite(raw)) return READER_REVOKE_RECONCILE_BUDGET_MS;
  return Math.min(Math.max(1, Math.trunc(raw)), 60_000);
}

function readerRevokeReconcileMaxRows(): number {
  const raw = readerRevokeReconcileMaxRowsForTests ?? READER_REVOKE_RECONCILE_MAX_ROWS;
  if (!Number.isFinite(raw)) return READER_REVOKE_RECONCILE_MAX_ROWS;
  return Math.min(Math.max(1, Math.trunc(raw)), 1_000);
}

let readerRevokeReconcileTail: Promise<void> = Promise.resolve();

export async function reconcilePendingReaderRevokes(
  deleteUser: DeleteNtfyUser = deleteNtfyUserResult,
): Promise<void> {
  const run = async (): Promise<void> => {
    if (!cachedState) cachedState = loadState();
    const current = cachedState;
    const snapshot = [...(current.pendingReaderRevokes ?? [])];
    if (!snapshot.length) return;

    const deadline = Date.now() + readerRevokeReconcileBudgetMs();
    const maxRows = readerRevokeReconcileMaxRows();
    let started = 0;
    const confirmed = new Set<string>();
    for (const row of snapshot) {
      if (row.status !== 'pending_revoke') continue;
      // 预算耗尽：停开新行；未处理与已见 transient 留队下轮。
      if (started >= maxRows || Date.now() >= deadline) break;
      started += 1;
      const result = await deleteUser(row.username);
      if (result === 'transient') continue;
      // deleted | not_found：本轮确认收敛。
      confirmed.add(row.username);
    }
    if (confirmed.size === 0) return;

    // 重读当前队列（可能含迭代间隙新入队），只去掉 confirmed。
    const latest = current.pendingReaderRevokes ?? [];
    const merged = latest.filter((row) => !confirmed.has(row.username));
    current.pendingReaderRevokes = merged.length > 0 ? merged : undefined;
    saveState(current);
  };

  const next = readerRevokeReconcileTail.then(run, run);
  readerRevokeReconcileTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * boot reconcile：清「完整地址键但对应身份不存在」的存量幽灵。
 * 裸 localpart 键一律保留；有身份主键不动。
 * 对齐 delete 路径：先 save 再 audit；save 失败回滚内存且不发 audit。
 */
export function purgeOrphanFullAddressAgentRoutes(actor = 'boot_reconcile'): boolean {
  if (!cachedState) cachedState = loadState();
  const current = cachedState;

  const toPurge: Array<{ key: string; entry: Route }> = [];
  for (const key of Object.keys(current.agents)) {
    if (!key.includes('@')) continue;
    if (findIdentity(key)) continue;
    toPurge.push({ key, entry: current.agents[key]! });
  }
  if (toPurge.length === 0) return false;

  const previousPending = current.pendingReaderRevokes
    ? current.pendingReaderRevokes.map((row) => ({ ...row }))
    : undefined;

  for (const { key, entry } of toPurge) {
    delete current.agents[key];
    enqueuePendingReaderRevoke(current, entry.reader.username, key);
  }

  try {
    syncCascadeCommitImpl(
      () => {
        /* boot purge 只落 JSON；server.yml 由 initializeNotifications 统一重写 */
      },
      () => saveState(current),
    );
  } catch (err) {
    for (const { key, entry } of toPurge) {
      current.agents[key] = entry;
    }
    if (previousPending) current.pendingReaderRevokes = previousPending;
    else delete current.pendingReaderRevokes;
    throw err;
  }

  for (const { key } of toPurge) {
    recordAuditEvent({
      event: 'identity.notify_route.delete',
      outcome: 'ok',
      address: key,
      actor,
    });
  }
  return true;
}

async function state(): Promise<NotifyState> {
  if (!cachedState) cachedState = loadState();
  return cachedState;
}

/**
 * 解析 agent 路由：先精确命中（完整地址键），miss 再回退旧 localpart 键。
 * 裸 localpart 且无旧键时 fail-closed（unknown_agent），要求调用方改用完整地址。
 * 旧键回退须匹配 ownerAddress 烙印，ambiguous/错属主一律拒绝。
 * 裸 localpart 精确命中同样要求 ownerAddress 非 ambiguous（纵深 fail-closed）。
 */
async function existingAgentRoute(name: string): Promise<Route> {
  const agent = safeAgentName(name);
  const current = await state();
  const exact = current.agents[agent];
  if (isUsableAgentRoute(exact)) {
    // 完整地址键直接可用；裸 localpart 键须已烙印且非 ambiguous。
    if (!agent.includes('@')) {
      if (
        exact.ownerAddress === undefined ||
        exact.ownerAddress === LEGACY_OWNER_AMBIGUOUS
      ) {
        throw new NotifyError('unknown_agent');
      }
    }
    return exact;
  }
  // 仅完整地址 miss 时回退 localpart，兼容未迁移的旧键。
  if (agent.includes('@')) {
    const localpart = agent.split('@')[0];
    if (localpart) {
      const fallback = current.agents[localpart];
      if (
        isUsableAgentRoute(fallback) &&
        fallback.ownerAddress !== undefined &&
        fallback.ownerAddress !== LEGACY_OWNER_AMBIGUOUS &&
        fallback.ownerAddress === agent
      ) {
        return fallback;
      }
    }
  }
  throw new NotifyError('unknown_agent');
}

function priority(level: NotifyLevel): number {
  if (level === 'urgent') return 5;
  if (level === 'low') return 1;
  return 3;
}

async function physicalTopic(target: NotifyTarget, level: NotifyLevel): Promise<string> {
  const current = await state();
  // Human low-priority traffic has a separate topic so a later device setup
  // can subscribe to urgent/normal alerts without being interrupted by FYIs.
  if (target === 'user') return current[userRouteKey(level)].topic;
  return (await existingAgentRoute(target.slice('agent:'.length))).topic;
}

async function readableTopic(topic: NotifyTopic, identityAddress?: string): Promise<string> {
  const current = await state();
  if (topic === 'user-alerts') return current.userAlerts.topic;
  if (topic === 'user-low') return current.userLow.topic;
  // self 用完整地址键（去尾点）；existingAgentRoute 会在属主匹配时回退旧 localpart 键。
  const agent = topic === 'self'
    ? (identityAddress ? canonicalizeAgentAddress(identityAddress) : undefined)
    : topic.slice('agent:'.length);
  if (!agent) throw new Error('invalid_notify_topic');
  return (await existingAgentRoute(agent)).topic;
}

function providerUrl(path: string): string {
  return `${config.ntfy.internalUrl}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(user: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

/** 管理面 ntfy fetch 超时（含 messages() 缓存读），避免假死实例把 /v1 与 /ui 挂住。 */
export const NTFY_ADMIN_FETCH_TIMEOUT_MS = 8_000;

async function ntfyFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(providerUrl(path), {
    ...init,
    signal: AbortSignal.timeout(NTFY_ADMIN_FETCH_TIMEOUT_MS),
  });
}

/** fetch 超时 / 网络失败统一成现有 NotifyError，避免未捕获 AbortError 变成 500。 */
function notifyFetchFailed(err: unknown): NotifyError {
  if (err instanceof NotifyError) return err;
  return new NotifyError('notify_unavailable');
}

async function ntfyAdminJson(path: string, body: unknown): Promise<Response> {
  return ntfyFetch(path, {
    method: 'POST',
    headers: {
      ...basic('admin', config.ntfy.adminPassword!),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Config provisioning covers a clean Compose boot. Runtime identity creation
 * additionally uses ntfy's built-in admin API, so its reader exists now — not
 * only after somebody restarts ntfy. The one-use password is never persisted;
 * the returned bearer token is persisted in our owner-only JSON route store.
 */
export async function createRuntimeReader(entry: Route): Promise<void> {
  let userCreated = false;
  try {
    const password = randomBytes(24).toString('base64url');
    const created = await ntfyAdminJson('/v1/users', {
      username: entry.reader.username,
      password,
    });
    if (!created.ok) throw new NotifyError('notify_unavailable');
    userCreated = true;

    const access = await ntfyAdminJson('/v1/users/access', {
      username: entry.reader.username,
      topic: entry.topic,
      permission: 'read-only',
    });
    if (!access.ok) throw new NotifyError('notify_unavailable');

    const tokenResponse = await ntfyFetch('/v1/account/token', {
      method: 'POST',
      headers: { ...basic(entry.reader.username, password), 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'openagentemail-device-reader' }),
    });
    if (!tokenResponse.ok) throw new NotifyError('notify_unavailable');
    const result = await tokenResponse.json() as { token?: unknown };
    if (typeof result.token !== 'string' || !result.token.startsWith('tk_')) {
      throw new NotifyError('notify_unavailable');
    }
    entry.reader.token = result.token;
  } catch (err) {
    if (userCreated) await deleteRuntimeReader(entry);
    if (err instanceof NotifyError) throw err;
    throw new NotifyError('notify_unavailable');
  }
}

async function deleteRuntimeReader(entry: Route): Promise<void> {
  await deleteNtfyUser(entry.reader.username);
}

async function deleteNtfyUser(username: string): Promise<void> {
  try {
    const response = await ntfyFetch('/v1/users', {
      method: 'DELETE',
      headers: {
        ...basic('admin', config.ntfy.adminPassword!),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username }),
    });
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    // 幽灵清理仍是 best-effort（无重试队列：凭据从未落盘，无法对账）。
    // 失败只记 warn，不把登记失败改成别的错误码。
    if (classifyNtfyUserDeleteResponse(response.status, body) === 'transient') {
      console.warn('[notify] ghost ntfy user cleanup failed', { username, status: response.status });
    }
  } catch (err) {
    console.warn('[notify] ghost ntfy user cleanup failed', {
      username,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

function ntfyDeleteBodyMeansMissingUser(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  let code: number | undefined;
  let error = '';
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown; error?: unknown };
    if (typeof parsed.code === 'number') code = parsed.code;
    if (typeof parsed.error === 'string') error = parsed.error;
  } catch {
    error = trimmed;
  }
  const haystack = `${error} ${trimmed}`.toLowerCase();
  // 只认 ntfy 缺 user 信号；裸 not_found 会误伤 {"error":"route_not_found"}。
  return code === 40031 || haystack.includes('user does not exist');
}

/**
 * 吊销路径：远端 user 已不存在视为删除成功。
 * 现网 ntfy `handleUsersDelete` 对缺失 user 返回 HTTP 400 / code 40031 /
 * "user does not exist"（不是裸 HTTP 404）。网络错误与 5xx 是 transient。
 * 反代/网关 404（含 route_not_found）不得收敛 revoked。
 */
export function classifyNtfyUserDeleteResponse(
  status: number,
  body: string,
): NtfyUserDeleteResult {
  if (status >= 200 && status < 300) return 'deleted';
  // 一切 5xx 不看 body：远端 user 可能仍在，不得收敛 revoked。
  if (status >= 500) return 'transient';
  if (status === 404 || status === 400) {
    return ntfyDeleteBodyMeansMissingUser(body) ? 'not_found' : 'transient';
  }
  return 'transient';
}

export async function deleteNtfyUserResult(username: string): Promise<NtfyUserDeleteResult> {
  try {
    const response = await ntfyFetch('/v1/users', {
      method: 'DELETE',
      headers: {
        ...basic('admin', config.ntfy.adminPassword!),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ username }),
    });
    let body = '';
    try {
      body = await response.text();
    } catch {
      body = '';
    }
    return classifyNtfyUserDeleteResponse(response.status, body);
  } catch {
    return 'transient';
  }
}

/**
 * Create one human-facing reader account for the two user alert channels.
 * Agent routes are deliberately absent: a phone is for the owner, not an
 * alternate credential for an agent's private wake-up topic.
 */
export async function createNotificationDevice(
  options: { displayName?: string } = {},
): Promise<NotificationDevice> {
  if (!config.ntfy.enabled) throw new NotifyError('notifications_disabled');
  if (!config.ntfy.adminPassword) throw new NotifyError('notifications_unconfigured');
  const current = await state();
  const topics = [current.userAlerts.topic, current.userLow.topic];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const username = `phone-${randomFrom(TOKEN_ALPHABET, 8)}`;
    const password = randomBytes(24).toString('base64url');
    let created = false;
    try {
      const response = await ntfyAdminJson('/v1/users', { username, password });
      if (response.status === 409) continue;
      if (!response.ok) throw new NotifyError('notify_unavailable');
      created = true;

      for (const topic of topics) {
        const access = await ntfyAdminJson('/v1/users/access', {
          username,
          topic,
          permission: 'read-only',
        });
        if (!access.ok) throw new NotifyError('notify_unavailable');
      }
      const topicMap = { userAlerts: current.userAlerts.topic, userLow: current.userLow.topic };
      let record;
      try {
        record = await registerPairedDevice({
          displayName: options.displayName,
          ntfyUsername: username,
          topics: topicMap,
        });
      } catch (err) {
        await deleteNtfyUser(username);
        if (err instanceof DeviceRegistryPersistError) throw err;
        throw new DeviceRegistryPersistError(err);
      }
      const qrPayload = {
        serverUrl: config.ntfy.publicUrl,
        username,
        password,
        topics: topicMap,
      };
      let qr: { size: number; modules: string } | undefined;
      try {
        qr = encodeQrModules(JSON.stringify(qrPayload));
      } catch {
        // 配对 copy 字段仍可用；QR 失败不得阻断发凭据。
      }
      return {
        id: record.id,
        displayName: record.displayName,
        username,
        password,
        serverUrl: config.ntfy.publicUrl,
        topics: topicMap,
        qrPayload,
        ...(qr ? { qr } : {}),
      };
    } catch (err) {
      if (created && !(err instanceof DeviceRegistryPersistError)) await deleteNtfyUser(username);
      if (err instanceof NotifyError || err instanceof DeviceRegistryPersistError) throw err;
      throw new NotifyError('notify_unavailable');
    }
  }
  throw new NotifyError('notify_unavailable');
}

let reconcileInFlight: Promise<void> | null = null;

export async function reconcileNotificationDevices(skipDeviceId?: string): Promise<void> {
  if (!config.ntfy.enabled || !config.ntfy.adminPassword) return;
  // skip 路径只清其它 pending，不占用/替换 list 的 in-flight coalesce。
  if (skipDeviceId) {
    await reconcilePendingRevokes(deleteNtfyUserResult, skipDeviceId);
    await reconcilePendingReaderRevokes(deleteNtfyUserResult);
    return;
  }
  // 并发入口共用一次 in-flight（同一 tick 的 list/revoke 不放大 ntfy）。
  // 不做跨请求 TTL：列表必须能收敛刚写入的 pending_revoke。
  if (reconcileInFlight) return reconcileInFlight;
  const run = (async () => {
    await reconcilePendingRevokes(deleteNtfyUserResult);
    // agent reader 吊销与 phone 设备线共用同一对账挂点。
    await reconcilePendingReaderRevokes(deleteNtfyUserResult);
  })().finally(() => {
    if (reconcileInFlight === run) reconcileInFlight = null;
  });
  reconcileInFlight = run;
  return run;
}

export async function listNotificationDevices(): Promise<DeviceListItem[]> {
  await reconcileNotificationDevices();
  return listPairedDevices();
}

export async function revokeNotificationDevice(id: string): Promise<'revoked' | 'already_revoked'> {
  const ntfyReady = Boolean(config.ntfy.enabled && config.ntfy.adminPassword);
  if (!ntfyReady) {
    const device = await peekPairedDevice(id);
    if (!device) throw new DeviceNotFoundError();
    if (device.revokeStatus === 'revoked') return 'already_revoked';
    // ② 记录含远端 user：临时关 ntfy / 缺 admin 密码时不得本地假吊销（凭据可能仍活着）。
    if (device.ntfyUsername) {
      const code = config.ntfy.enabled ? 'notifications_unconfigured' : 'notifications_disabled';
      throw new NotifyError(code, {
        message:
          'Restore ntfy admin access before revoking this device. The phone credential may still receive notifications.',
      });
    }
    // ① 从未配过远端（无 ntfyUsername）：无对账对象，允许本地收敛。
    return revokePairedDevice(id, async () => 'deleted');
  }
  // 对账其它 pending，但跳过本目标：revoke 自己走单次 DELETE。
  await reconcileNotificationDevices(id);
  return revokePairedDevice(id, deleteNtfyUserResult);
}

function parseMessages(text: string): NotifyMessage[] {
  const messages: NotifyMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event !== 'message' || typeof event.id !== 'string') continue;
      messages.push({
        id: event.id,
        time: typeof event.time === 'number' ? event.time : 0,
        title: typeof event.title === 'string' ? event.title : '',
        message: typeof event.message === 'string' ? event.message : '',
        priority: typeof event.priority === 'number' ? event.priority : 0,
        tags: Array.isArray(event.tags) ? event.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      });
    } catch {
      // Ignore ntfy keepalive/open events and malformed cache rows.
    }
  }
  return messages;
}

/**
 * ntfy rejects request bodies near ~4096 bytes. Cap serialized publish JSON
 * under this so a poison message cannot make publish throw and stall the
 * watcher UID watermark forever.
 */
export const NTFY_REQUEST_MAX_BYTES = 4_000;

/** UTF-8 ellipsis appended when JSON-escaped message content is truncated. */
const JSON_MESSAGE_ELLIPSIS = '…';
const JSON_MESSAGE_ELLIPSIS_ESCAPED_BYTES = Buffer.byteLength(JSON_MESSAGE_ELLIPSIS, 'utf8');

/**
 * Cost of one code point inside a JSON string (UTF-8 of the escaped form).
 * Matches JSON.stringify: quotes/backslash and the five single-letter escapes
 * cost 2; other C0 controls become \\u00XX (6); lone surrogates (0xD800–0xDFFF)
 * become \\uXXXX (6) — Buffer.byteLength would only count the U+FFFD replacement
 * (3); paired surrogates form a >0xFFFF code point and take the UTF-8 branch.
 * Everything else is raw UTF-8.
 */
function jsonStringEscapeCost(point: string): number {
  const cp = point.codePointAt(0)!;
  if (point === '"' || point === '\\') return 2;
  if (cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return 2;
  if (cp < 0x20) return 6;
  if (cp >= 0xd800 && cp <= 0xdfff) return 6;
  return Buffer.byteLength(point, 'utf8');
}

/**
 * UTF-8 byte length of `text` after JSON string escaping (content only, no
 * surrounding quotes). Used by the watcher to pack under the same budget that
 * publish() enforces after serialization (F88).
 */
export function jsonEscapedByteLength(text: string): number {
  let total = 0;
  for (const point of text) total += jsonStringEscapeCost(point);
  return total;
}

/**
 * Available UTF-8 bytes for the ntfy JSON `message` field content after framing
 * (topic/title/priority/tags/click). Mirrors publish() click-drop: if including
 * click overflows the request cap, click is dropped before measuring (F76/F88).
 * Conservative default topic is max ntfy length so watcher packing never exceeds
 * the live physical topic overhead.
 */
export function notifyAvailableMessageBytes(options: {
  title: string;
  level: NotifyLevel;
  tags?: string[];
  click?: string;
  topic?: string;
}): number {
  const topic = options.topic ?? 'x'.repeat(64);
  const basePayload = {
    topic,
    title: options.title,
    message: '',
    priority: priority(options.level),
    ...(options.tags?.length ? { tags: options.tags } : {}),
  };
  let framing = JSON.stringify(
    options.click ? { ...basePayload, click: options.click } : basePayload,
  );
  if (options.click && Buffer.byteLength(framing, 'utf8') > NTFY_REQUEST_MAX_BYTES) {
    framing = JSON.stringify(basePayload);
  }
  return Math.max(0, NTFY_REQUEST_MAX_BYTES - Buffer.byteLength(framing, 'utf8'));
}

/**
 * Truncate `text` so its JSON string-escape length is ≤ maxEscapedBytes.
 * Code-point aligned (same discipline as boundTextBytes); reserves room for `…`.
 * Used only for ntfy publish message bodies after field caps — a second line of
 * defense against JSON expansion of control characters.
 */
export function boundJsonEscapedText(text: string, maxEscapedBytes: number): string {
  let total = 0;
  for (const point of text) {
    total += jsonStringEscapeCost(point);
    if (total > maxEscapedBytes) break;
  }
  if (total <= maxEscapedBytes) return text;
  if (maxEscapedBytes < JSON_MESSAGE_ELLIPSIS_ESCAPED_BYTES) return '';
  const budget = maxEscapedBytes - JSON_MESSAGE_ELLIPSIS_ESCAPED_BYTES;
  if (budget <= 0) return JSON_MESSAGE_ELLIPSIS;

  let used = 0;
  let end = 0;
  for (const point of text) {
    const cost = jsonStringEscapeCost(point);
    if (used + cost > budget) break;
    used += cost;
    end += point.length;
  }
  return `${text.slice(0, end)}${JSON_MESSAGE_ELLIPSIS}`;
}

export class NtfyNotificationService implements NotifyService {
  private async assertEnabled(): Promise<NotifyState> {
    if (!config.ntfy.enabled) {
      throw new NotifyError('notifications_disabled', undefined, { failureKind: 'service' });
    }
    if (!config.ntfy.adminPassword) {
      throw new NotifyError('notifications_unconfigured', undefined, { failureKind: 'service' });
    }
    return state();
  }

  async publish(input: NotifyInput): Promise<{ target: NotifyTarget; title: string; level: NotifyLevel }> {
    try {
      return await this.publishOnce(input);
    } catch (err) {
      /* 只把已发往 provider、但未送达的 urgent 推送记进值班台；配置/大小/取消
         都不是投递失败。 */
      if (input.level === 'urgent' && err instanceof NotifyError && err.code === 'notify_unavailable') {
        await this.recordUrgentFailure(input);
      }
      throw err;
    }
  }

  private async recordUrgentFailure(input: NotifyInput): Promise<void> {
    const logicalTarget = input.target as NotificationLogicalTarget;
    const logicalChannel = input.logicalChannel ?? logicalChannelFor(logicalTarget, input.level);
    try {
      await appendNotificationLog({
        source: input.source ?? 'manual',
        logicalTarget,
        logicalChannel,
        level: input.level,
        title: input.title,
        /* 不把未送达的正文再落盘；Home 只需要服务端计数。 */
        message: '',
        tags: input.tags,
        sensitive: Boolean(input.sensitive),
        identityAddress: input.identityAddress,
        delivery: 'failed',
      });
    } catch (logError) {
      notificationLogHealthAlert('append_failed_delivery_failure', {
        source: input.source ?? 'manual',
        logicalChannel,
        error: (logError as Error).message,
      });
    }
  }

  private async publishOnce(input: NotifyInput): Promise<{ target: NotifyTarget; title: string; level: NotifyLevel }> {
    const current = await this.assertEnabled();
    const topic = await physicalTopic(input.target, input.level);
    // ntfy rejects bodies near ~4096 bytes. Prefer keeping click; if the
    // serialized body is still over budget after dropping click, either
    // truncate message (watcher) or error (manual). Click-drop always runs
    // first so its budget relief still counts for both overflow modes (F76).
    const overflow = input.overflow ?? 'error';
    const basePayload = {
      topic,
      title: input.title,
      message: input.message,
      priority: priority(input.level),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    };
    let body = JSON.stringify(
      input.click ? { ...basePayload, click: input.click } : basePayload,
    );
    if (input.click && Buffer.byteLength(body, 'utf8') > NTFY_REQUEST_MAX_BYTES) {
      body = JSON.stringify(basePayload);
    }
    if (Buffer.byteLength(body, 'utf8') > NTFY_REQUEST_MAX_BYTES) {
      // overhead = all keys/quotes/commas except the message *content* (empty
      // string still contributes the surrounding "" which stays in the final body).
      const overhead = Buffer.byteLength(
        JSON.stringify({ ...basePayload, message: '' }),
        'utf8',
      );
      const availableMessageBytes = Math.max(0, NTFY_REQUEST_MAX_BYTES - overhead);
      if (overflow === 'error') {
        throw new NotifyError('message_too_large', {
          maxRequestBytes: NTFY_REQUEST_MAX_BYTES,
          availableMessageBytes,
        });
      }
      basePayload.message = boundJsonEscapedText(input.message, availableMessageBytes);
      body = JSON.stringify(basePayload);
    }
    // After assertEnabled/physicalTopic awaits: last chance to drop a payload
    // whose privacy floor moved mid-flight (tier downgrade or DELETE).
    if (input.beforeSend && !input.beforeSend()) {
      throw new NotifyError('notify_cancelled');
    }
    let response: Response;
    try {
      response = await fetch(providerUrl('/'), {
        method: 'POST',
        headers: { ...bearer(current.publisherToken), 'content-type': 'application/json' },
        body,
        // Match management reads/writes: a hung provider must reach watcher
        // retry/backoff instead of pinning one UID forever.
        signal: AbortSignal.timeout(NTFY_ADMIN_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new NotifyError('notify_unavailable', undefined, { failureKind: 'service' });
    }
    if (!response.ok) {
      throw new NotifyError('notify_unavailable', undefined, {
        failureKind: isNtfyPublishServiceStatus(response.status) ? 'service' : 'message',
      });
    }
    // 送达优先：ntfy 成功后、返回前写日志。append 失败只告警，不把投递改成失败。
    const logicalTarget = input.target as NotificationLogicalTarget;
    const logicalChannel =
      input.logicalChannel ?? logicalChannelFor(logicalTarget, input.level);
    try {
      await appendNotificationLog({
        source: input.source ?? 'manual',
        logicalTarget,
        logicalChannel,
        level: input.level,
        title: input.title,
        message: basePayload.message,
        tags: input.tags,
        sensitive: Boolean(input.sensitive),
        identityAddress: input.identityAddress,
      });
    } catch (err) {
      notificationLogHealthAlert('append_failed_after_delivery', {
        source: input.source ?? 'manual',
        logicalChannel,
        error: (err as Error).message,
      });
    }
    return { target: input.target, title: input.title, level: input.level };
  }

  async messages(topic: NotifyTopic, identityAddress?: string, since?: string): Promise<NotifyMessage[]> {
    await this.assertEnabled();
    const physical = await readableTopic(topic, identityAddress);
    const adminPassword = config.ntfy.adminPassword!;
    const query = new URLSearchParams({ poll: '1' });
    if (since) query.set('since', since);
    try {
      // 与管理面 ntfyFetch 同一 8s 超时；header 与 body 阶段都要映射，避免 500。
      const response = await ntfyFetch(`/${encodeURIComponent(physical)}/json?${query.toString()}`, {
        headers: basic('admin', adminPassword),
      });
      if (!response.ok) throw new NotifyError('notify_unavailable');
      return parseMessages(await response.text());
    } catch (err) {
      throw notifyFetchFailed(err);
    }
  }

  async verify(): Promise<{ ok: true }> {
    await this.assertEnabled();
    const nonce = randomBytes(12).toString('hex');
    await this.publish({
      target: 'user',
      title: 'openagent.email notification check',
      message: `openagent.email notification check ${nonce}`,
      level: 'normal',
      tags: ['white_check_mark'],
      source: 'verify',
      logicalChannel: 'user-alerts',
      sensitive: false,
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const messages = await this.messages('user-alerts', undefined, '10m');
      if (messages.some((message) => message.message.includes(nonce))) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new NotifyError('verify_failed');
  }
}

let defaultService: NtfyNotificationService | undefined;

export function notificationService(): NtfyNotificationService {
  defaultService ??= new NtfyNotificationService();
  return defaultService;
}

/**
 * Make an identity's private agent route available to a live ntfy instance.
 * This is called immediately after identity creation, before its API response
 * is returned, so there is no window where a client receives an identity that
 * lacks the reader account promised by the notification model.
 */
/** @internal 测试缝：createRuntimeReader 成功后、二次确认前注入（模拟同址删竞态）。 */
let afterCreateRuntimeReaderForTests: (() => void) | null = null;

export function setAfterCreateRuntimeReaderForTests(fn: (() => void) | null): void {
  afterCreateRuntimeReaderForTests = fn;
}

export async function provisionIdentityNotifications(identity: Identity): Promise<void> {
  if (!config.ntfy.enabled) return;
  if (!config.ntfy.adminPassword) throw new NotifyError('notifications_unconfigured');
  // 新身份一律以完整地址（小写、去尾点）为 agents 键；不因旧 localpart 键存在而跳过。
  const agent = canonicalizeAgentAddress(identity.address);
  if (!agent.includes('@')) throw new NotifyError('unknown_agent');

  const current = await state();
  const existing = current.agents[agent];
  if (isUsableAgentRoute(existing)) return;

  const entry = agentRoute(agent, current.suffix);
  current.agents[agent] = entry;
  let runtimeReaderCreated = false;
  let configWritten = false;
  try {
    await createRuntimeReader(entry);
    runtimeReaderCreated = true;
    // 测试缝：模拟 createRuntimeReader 成功后、提交前身份被删。
    afterCreateRuntimeReaderForTests?.();
    // 二次确认：create/delete 同址竞态下身份可能已删——吊销刚建 reader，放弃提交。
    if (!findIdentity(agent)) {
      if (existing) current.agents[agent] = existing;
      else delete current.agents[agent];
      await deleteRuntimeReader(entry);
      runtimeReaderCreated = false;
      return;
    }
    // Keep the declarative startup config in sync with the live reader. ntfy
    // will consume this same token on every later restart.
    await commitNotificationState(
      async () => {
        await writeServerConfig(current);
        configWritten = true;
      },
      // The JSON route map is the commit record. Do not write it until both
      // the live account and future-startup config are ready.
      () => saveState(current),
    );
  } catch (err) {
    if (existing) current.agents[agent] = existing;
    else delete current.agents[agent];
    if (configWritten) {
      try {
        await writeServerConfig(current);
      } catch {
        // The original error decides the API response; startup provision will
        // reconcile this best-effort rollback before ntfy next boots.
      }
    }
    if (runtimeReaderCreated) await deleteRuntimeReader(entry);
    throw err;
  }
}

/** Notify an agent only for a server-authenticated, local API send event. */
export async function notifyTrustedAgentDelivery(address: string): Promise<void> {
  if (!config.ntfy.enabled || config.ntfy.pushPolicy === 'none') return;
  const identity = findIdentity(address);
  if (!identity) return;
  const fullAddress = canonicalizeAgentAddress(identity.address);
  if (!fullAddress.includes('@')) return;

  try {
    await notificationService().publish({
      target: `agent:${fullAddress}`,
      title: 'openagent.email new mail',
      message: `${identity.address} received new email`,
      level: 'normal',
      tags: ['email'],
      source: 'task',
      logicalChannel: `agent:${fullAddress}`,
      sensitive: false,
      identityAddress: identity.address,
    });
  } catch (err) {
    // Mail already made it to SMTP; notification delivery must not turn a
    // successful send into a false failure. The operator still gets a signal.
    console.warn('[notify] trusted agent delivery failed:', (err as Error).message);
  }
}

/** Called by the one-shot Compose provisioner and again on API startup. */
export async function initializeNotifications(): Promise<void> {
  const current = await state();
  let changed = false;
  // 先清完整地址幽灵键（身份已不存在）；裸 localpart 键一行不动。
  if (purgeOrphanFullAddressAgentRoutes('boot_reconcile')) changed = true;
  // Provision a reader account for every identity that already exists before
  // ntfy boots. These private routes remain server-only; phone pairing grants
  // a separate account only to the two human topics.
  for (const identity of listIdentities()) {
    const fullKey = canonicalizeAgentAddress(identity.address);
    const localpart = fullKey.split('@')[0];
    if (!fullKey.includes('@')) continue;
    // 已有完整地址键 → 跳过。
    if (isUsableAgentRoute(current.agents[fullKey])) continue;
    // 旧 localpart 键仅当烙印属主就是本身份时视为已 provision（不重写）。
    if (localpart && isUsableAgentRoute(current.agents[localpart])) {
      const legacy = current.agents[localpart]!;
      if (legacy.ownerAddress === fullKey) continue;
    }
    // 写入只写完整地址键；旧 localpart 键原地保留。
    current.agents[fullKey] = agentRoute(fullKey, current.suffix);
    changed = true;
  }
  if (changed) saveState(current);
  await writeServerConfig(current);
  try {
    await reconcileNotificationDevices();
  } catch (err) {
    // inspect 已 fail-closed+告警；启动对账再读同一 corrupt 文件不得炸 API。
    if (err instanceof DeviceRegistryCorruptError) return;
    throw err;
  }
}
