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
import { config } from './config.ts';
import { findIdentity, listIdentities, type Identity } from './identities.ts';
import {
  appendNotificationLog,
  logicalChannelFor,
  notificationLogHealthAlert,
  type NotificationLogicalChannel,
  type NotificationLogicalTarget,
  type NotificationSource,
} from './notification-log.ts';
import {
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  listPairedDevices,
  reconcilePendingRevokes,
  registerPairedDevice,
  revokePairedDevice,
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

export class NotifyError extends Error {
  constructor(
    public readonly code:
      | 'notifications_disabled'
      | 'notifications_unconfigured'
      | 'notify_unavailable'
      | 'notify_cancelled'
      | 'verify_failed'
      | 'unknown_agent'
      | 'message_too_large'
      | 'device_registry_unavailable',
    public readonly details?: {
      maxRequestBytes: number;
      availableMessageBytes: number;
    },
  ) {
    super(code);
  }
}

type Reader = {
  username: string;
  token: string;
};

type Route = {
  topic: string;
  reader: Reader;
};

type NotifyState = {
  version: 1;
  suffix: string;
  publisherToken: string;
  userAlerts: Route;
  userLow: Route;
  agents: Record<string, Route>;
};

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_ALPHABET = TOKEN_ALPHABET;
const TOPIC_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
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

function safeAgentName(value: string): string {
  const normalized = value.toLowerCase();
  if (!TOPIC_NAME_RE.test(normalized)) throw new Error('invalid_agent_name');
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

  // Keep the logical route as agent:<localpart>; only this private physical
  // name is normalized. The hash avoids collisions after dot replacement or
  // truncation, and the arithmetic below keeps the topic within 64 chars.
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
  return typeof entry.topic === 'string' && isReader(entry.reader);
}

function isState(value: unknown): value is NotifyState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
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
    return parsed;
  } catch {
    throw new Error('notification_store_corrupt');
  }
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

async function writeServerConfig(state: NotifyState): Promise<void> {
  const adminPassword = config.ntfy.adminPassword;
  if (!adminPassword) throw new NotifyError('notifications_unconfigured');

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

let cachedState: NotifyState | undefined;

async function state(): Promise<NotifyState> {
  if (!cachedState) cachedState = loadState();
  return cachedState;
}

async function existingAgentRoute(name: string): Promise<Route> {
  const agent = safeAgentName(name);
  const current = await state();
  const existing = current.agents[agent];
  if (!isUsableAgentRoute(existing)) throw new NotifyError('unknown_agent');
  return existing;
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
  const agent = topic === 'self'
    ? identityAddress?.split('@')[0]
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

/** 管理面 ntfy fetch 超时，避免 delete 挂死设备 registry 队列。 */
const NTFY_ADMIN_FETCH_TIMEOUT_MS = 8_000;

async function ntfyFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(providerUrl(path), {
    ...init,
    signal: AbortSignal.timeout(NTFY_ADMIN_FETCH_TIMEOUT_MS),
  });
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

function ntfyDeleteBodyMeansMissingUser(body: string, allowNotFoundToken: boolean): boolean {
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
  if (code === 40031 || haystack.includes('user does not exist')) return true;
  if (allowNotFoundToken && haystack.includes('not_found')) return true;
  return false;
}

/**
 * 吊销路径：远端 user 已不存在视为删除成功。
 * 现网 ntfy `handleUsersDelete` 对缺失 user 返回 HTTP 400 / code 40031 /
 * "user does not exist"（不是裸 HTTP 404）。网络错误与 5xx 是 transient。
 * 反代/网关裸 404 不得收敛 revoked。
 */
export function classifyNtfyUserDeleteResponse(
  status: number,
  body: string,
): NtfyUserDeleteResult {
  if (status >= 200 && status < 300) return 'deleted';
  // 一切 5xx 不看 body：远端 user 可能仍在，不得收敛 revoked。
  if (status >= 500) return 'transient';
  if (status === 404) {
    return ntfyDeleteBodyMeansMissingUser(body, true) ? 'not_found' : 'transient';
  }
  if (status !== 400) return 'transient';
  return ntfyDeleteBodyMeansMissingUser(body, false) ? 'not_found' : 'transient';
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

export async function reconcileNotificationDevices(): Promise<void> {
  if (!config.ntfy.enabled || !config.ntfy.adminPassword) return;
  // 并发入口共用一次 in-flight（同一 tick 的 list/revoke 不放大 ntfy）。
  // 不做跨请求 TTL：列表必须能收敛刚写入的 pending_revoke。
  if (reconcileInFlight) return reconcileInFlight;
  const run = reconcilePendingRevokes(deleteNtfyUserResult).finally(() => {
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
  // ntfy 未启用/未配置：无远端可对账，纯本地标 revoked，避免 pending 永远卡住、也不外呼。
  if (!config.ntfy.enabled || !config.ntfy.adminPassword) {
    return revokePairedDevice(id, async () => 'deleted');
  }
  await reconcileNotificationDevices();
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
    if (!config.ntfy.enabled) throw new NotifyError('notifications_disabled');
    if (!config.ntfy.adminPassword) throw new NotifyError('notifications_unconfigured');
    return state();
  }

  async publish(input: NotifyInput): Promise<{ target: NotifyTarget; title: string; level: NotifyLevel }> {
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
    const response = await fetch(providerUrl('/'), {
      method: 'POST',
      headers: { ...bearer(current.publisherToken), 'content-type': 'application/json' },
      body,
    });
    if (!response.ok) throw new NotifyError('notify_unavailable');
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
    const response = await fetch(providerUrl(`/${encodeURIComponent(physical)}/json?${query.toString()}`), {
      headers: basic('admin', adminPassword),
    });
    if (!response.ok) throw new NotifyError('notify_unavailable');
    return parseMessages(await response.text());
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
export async function provisionIdentityNotifications(identity: Identity): Promise<void> {
  if (!config.ntfy.enabled) return;
  if (!config.ntfy.adminPassword) throw new NotifyError('notifications_unconfigured');
  const agent = identity.address.split('@')[0];
  if (!agent) throw new NotifyError('unknown_agent');

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
  const localpart = identity.address.split('@')[0];
  if (!localpart) return;

  try {
    await notificationService().publish({
      target: `agent:${localpart}`,
      title: 'openagent.email new mail',
      message: `${identity.address} received new email`,
      level: 'normal',
      tags: ['email'],
      source: 'task',
      logicalChannel: `agent:${localpart}`,
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
  // Provision a reader account for every identity that already exists before
  // ntfy boots. These private routes remain server-only; phone pairing grants
  // a separate account only to the two human topics.
  for (const identity of listIdentities()) {
    const agent = identity.address.split('@')[0];
    if (!agent || isUsableAgentRoute(current.agents[agent])) continue;
    current.agents[agent] = agentRoute(agent, current.suffix);
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
