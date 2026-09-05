/**
 * Webhook 订阅注册表存储：DATA_DIR/webhooks.json (RFC-0001 §10.5)
 *
 * 规范约定：
 * - 0600 文件，0700 目录
 * - 单写者，原子 .tmp + rename，fsync 文件与目录
 * - 损坏文件 fail-closed（抛错并标记拒绝读写）
 * - FORBIDDEN_SECRET_KEYS 门闩：拒绝持久化 secret, signingSecret, previousSecret
 * - 幂等键表持久化（create 与 rotate 幂等），留存至 WEBHOOK_LOG_RETENTION_DAYS
 * - 身份删除级联硬删除订阅
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.ts';
import { deriveWebhookKey } from './webhook-signing.ts';

export const WEBHOOK_STORE_SCHEMA_VERSION = 1;
export const WEBHOOK_STORE_FILE = 'webhooks.json';
/** Cap on persisted create/rotate idempotency records per list (newest kept). */
export const WEBHOOK_IDEMPOTENCY_MAX_RECORDS = 256;

export type WebhookContentScope = 'metadata' | 'preview';
export type WebhookState = 'unverified' | 'enabled' | 'disabled';
export type WebhookDisabledReason = 'manual' | 'threshold' | 'refused' | null;

export type WebhookRecord = {
  id: string; // 'whk_' + UUIDv4
  url: string;
  address: string; // lower-cased
  events: string[];
  contentScope: WebhookContentScope;
  description: string;
  state: WebhookState;
  disabledReason: WebhookDisabledReason;
  secretPrefix: string;
  epoch: number;
  overlapUntil: string | null;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
  consecutiveFailures: number;
  privateTargetGranted: boolean;
  createdBy: string; // 'admin' or address
};

export type CreateIdempotencyRecord = {
  key: string;
  address: string;
  webhookId: string;
  responseBody: Record<string, unknown>; // secret: null
  createdAt: string;
};

export type RotateIdempotencyRecord = {
  key: string;
  webhookId: string;
  epoch: number;
  responseBody: Record<string, unknown>; // secret: null
  createdAt: string;
};

export type WebhooksFile = {
  schemaVersion: typeof WEBHOOK_STORE_SCHEMA_VERSION;
  webhooks: WebhookRecord[];
  createIdempotency?: CreateIdempotencyRecord[];
  rotateIdempotency?: RotateIdempotencyRecord[];
};

export class WebhookStoreCorruptError extends Error {
  readonly code = 'store_corrupt';
  constructor(message = 'webhooks store is corrupt') {
    super(message);
    this.name = 'WebhookStoreCorruptError';
  }
}

export class WebhookForbiddenSecretError extends Error {
  readonly code = 'forbidden_secret_key';
  constructor(key: string) {
    super(`Cannot persist forbidden secret key: "${key}"`);
    this.name = 'WebhookForbiddenSecretError';
  }
}

/** 禁止落盘的键名（大小写不敏感）；只看 key，不扫字符串值。 */
export const FORBIDDEN_SECRET_KEYS = new Set([
  'password',
  'token',
  'secret',
  'signingsecret',
  'previoussecret',
]);

/** 内存 failClosed 闸。一旦检测到文件损坏，拒绝后续读写。 */
let failClosed = false;

function storePath(): string {
  return join(config.dataDir, WEBHOOK_STORE_FILE);
}

function tmpPath(): string {
  return `${storePath()}.tmp`;
}

function failClosedPath(): string {
  return `${storePath()}.failclosed`;
}

export function webhookStoreHasForbiddenSecretKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => webhookStoreHasForbiddenSecretKey(item));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      if (child !== null && child !== undefined) return true;
    }
    if (webhookStoreHasForbiddenSecretKey(child)) return true;
  }
  return false;
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 属主可能不同；文件 mode 仍会设置
  }
}

function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw new Error('short_write');
    offset += n;
  }
}

function markStoreFailClosed(kind: string): void {
  failClosed = true;
  try {
    writeFileSync(failClosedPath(), `${kind}\n`, { mode: 0o600 });
  } catch {
    // 内存闸仍拦住本进程
  }
  console.error(`[webhook-store] HIGH: fail-closed due to ${kind}`);
}

function checkFailClosed(): void {
  if (failClosed || existsSync(failClosedPath())) {
    failClosed = true;
    throw new WebhookStoreCorruptError('webhooks store is in fail-closed state');
  }
}

function parseFile(content: string): WebhooksFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    markStoreFailClosed('json_parse_error');
    throw new WebhookStoreCorruptError(
      `webhooks.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    markStoreFailClosed('root_not_object');
    throw new WebhookStoreCorruptError('webhooks.json root must be an object');
  }

  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== WEBHOOK_STORE_SCHEMA_VERSION) {
    markStoreFailClosed('unsupported_schema_version');
    throw new WebhookStoreCorruptError(
      `webhooks.json unsupported schemaVersion: ${root.schemaVersion}`,
    );
  }

  if (!Array.isArray(root.webhooks)) {
    markStoreFailClosed('webhooks_not_array');
    throw new WebhookStoreCorruptError('webhooks.json webhooks must be an array');
  }

  // 基础校验每个记录的完整性
  for (const item of root.webhooks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      markStoreFailClosed('invalid_webhook_item');
      throw new WebhookStoreCorruptError('webhooks.json item is not an object');
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      !r.id.startsWith('whk_') ||
      typeof r.url !== 'string' ||
      typeof r.address !== 'string' ||
      !Array.isArray(r.events) ||
      typeof r.contentScope !== 'string' ||
      typeof r.state !== 'string' ||
      typeof r.epoch !== 'number'
    ) {
      markStoreFailClosed('invalid_webhook_record_fields');
      throw new WebhookStoreCorruptError('webhooks.json invalid record fields');
    }
  }

  return root as WebhooksFile;
}

export function readStore(): WebhooksFile {
  checkFailClosed();
  ensureDataDir();
  const file = storePath();
  if (!existsSync(file)) {
    return {
      schemaVersion: WEBHOOK_STORE_SCHEMA_VERSION,
      webhooks: [],
      createIdempotency: [],
      rotateIdempotency: [],
    };
  }

  const text = readFileSync(file, 'utf8');
  if (!text.trim()) {
    return {
      schemaVersion: WEBHOOK_STORE_SCHEMA_VERSION,
      webhooks: [],
      createIdempotency: [],
      rotateIdempotency: [],
    };
  }

  return parseFile(text);
}

export function writeStore(data: WebhooksFile): void {
  checkFailClosed();
  ensureDataDir();

  // FORBIDDEN_SECRET_KEYS 门闩：绝不落盘密钥明文
  if (webhookStoreHasForbiddenSecretKey(data)) {
    throw new WebhookForbiddenSecretError('forbidden secret key detected in store payload');
  }

  const tmp = tmpPath();
  const target = storePath();
  const text = JSON.stringify(data, null, 2);

  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeAllSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }

  renameSync(tmp, target);

  // fsync 所在目录
  try {
    const dirFd = openSync(config.dataDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // 目录 fsync 尽力而为（非 POSIX 兼容系统可能不支持）
  }
}

export function listWebhooks(address?: string): WebhookRecord[] {
  const file = readStore();
  if (!address) return file.webhooks;
  const needle = address.toLowerCase();
  return file.webhooks.filter((w) => w.address.toLowerCase() === needle);
}

export function getWebhook(id: string): WebhookRecord | undefined {
  const file = readStore();
  return file.webhooks.find((w) => w.id === id);
}

export function saveWebhook(record: WebhookRecord): void {
  const file = readStore();
  const idx = file.webhooks.findIndex((w) => w.id === record.id);
  if (idx >= 0) {
    file.webhooks[idx] = record;
  } else {
    file.webhooks.push(record);
  }
  writeStore(file);
}

export function deleteWebhook(id: string): WebhookRecord | undefined {
  const file = readStore();
  const idx = file.webhooks.findIndex((w) => w.id === id);
  if (idx < 0) return undefined;
  const [removed] = file.webhooks.splice(idx, 1);
  if (file.createIdempotency) {
    file.createIdempotency = file.createIdempotency.filter(
      (c) => c.webhookId !== id && c.responseBody?.id !== id,
    );
  }
  if (file.rotateIdempotency) {
    file.rotateIdempotency = file.rotateIdempotency.filter((r) => r.webhookId !== id);
  }
  writeStore(file);
  return removed;
}

export type WebhookSubscription = WebhookRecord;
export const getWebhookSubscription = getWebhook;
export const listWebhookSubscriptions = listWebhooks;
export const deleteWebhookSubscription = deleteWebhook;

export function updateWebhookSubscription(
  id: string,
  updater: (record: WebhookRecord) => void,
): WebhookRecord | undefined {
  const file = readStore();
  const idx = file.webhooks.findIndex((w) => w.id === id);
  if (idx < 0) return undefined;
  updater(file.webhooks[idx]!);
  file.webhooks[idx]!.updatedAt = new Date().toISOString();
  writeStore(file);
  return file.webhooks[idx];
}

export function createWebhookSubscription(params: {
  url: string;
  address: string;
  events: string[];
  contentScope?: WebhookContentScope;
  description?: string;
  privateTargetGranted?: boolean;
  createdBy?: string;
}): WebhookRecord {
  const id = `whk_${randomUUID()}`;
  const now = new Date().toISOString();
  const derived = deriveWebhookKey(
    config.webhooks.signingSecret || config.taskSigningSecret,
    id,
    0,
  );
  const record: WebhookRecord = {
    id,
    url: params.url,
    address: params.address.toLowerCase(),
    events: params.events,
    contentScope: params.contentScope ?? 'metadata',
    description: params.description ?? '',
    state: 'unverified',
    disabledReason: null,
    secretPrefix: derived.secretPrefix,
    epoch: 0,
    overlapUntil: null,
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
    consecutiveFailures: 0,
    privateTargetGranted: params.privateTargetGranted ?? false,
    createdBy: params.createdBy ?? 'admin',
  };
  saveWebhook(record);
  return record;
}

export function cascadeDeleteWebhooksForAddress(address: string): WebhookRecord[] {
  const needle = address.toLowerCase();
  const file = readStore();
  const removed: WebhookRecord[] = [];
  const kept: WebhookRecord[] = [];
  const removedIds = new Set<string>();
  for (const w of file.webhooks) {
    if (w.address.toLowerCase() === needle) {
      removed.push(w);
      removedIds.add(w.id);
    } else {
      kept.push(w);
    }
  }
  if (removed.length === 0) return [];
  file.webhooks = kept;
  if (file.createIdempotency) {
    file.createIdempotency = file.createIdempotency.filter(
      (c) =>
        c.address.toLowerCase() !== needle &&
        (!c.webhookId || !removedIds.has(c.webhookId)) &&
        (!c.responseBody?.id || !removedIds.has(c.responseBody.id as string)),
    );
  }
  if (file.rotateIdempotency) {
    file.rotateIdempotency = file.rotateIdempotency.filter((r) => !removedIds.has(r.webhookId));
  }
  writeStore(file);
  return removed;
}

export function checkSubscriptionLimits(
  address: string,
  maxTotal: number = config.webhooks.maxSubscriptions,
  maxPerAddress: number = config.webhooks.maxPerAddress,
): { allowed: boolean; reason?: 'instance_limit' | 'address_limit' } {
  const file = readStore();
  if (maxTotal > 0 && file.webhooks.length >= maxTotal) {
    return { allowed: false, reason: 'instance_limit' };
  }
  if (maxPerAddress > 0) {
    const needle = address.toLowerCase();
    const count = file.webhooks.filter((w) => w.address.toLowerCase() === needle).length;
    if (count >= maxPerAddress) {
      return { allowed: false, reason: 'address_limit' };
    }
  }
  return { allowed: true };
}

export function findCreateIdempotency(
  key: string,
  address: string,
): CreateIdempotencyRecord | undefined {
  const file = readStore();
  const needle = address.toLowerCase();
  return file.createIdempotency?.find(
    (c) => c.key === key && c.address.toLowerCase() === needle,
  );
}

function createdAtMs(value: string): number {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function trimIdempotencyList<T extends { createdAt: string }>(
  list: T[] | undefined,
  retentionDays: number,
  maxRecords: number,
): T[] {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept = (list ?? []).filter((r) => createdAtMs(r.createdAt) >= cutoff);
  if (kept.length <= maxRecords) return kept;
  kept.sort((a, b) => createdAtMs(b.createdAt) - createdAtMs(a.createdAt));
  return kept.slice(0, maxRecords);
}

function capIdempotencyList<T extends { createdAt: string }>(list: T[], maxRecords: number): T[] {
  if (list.length <= maxRecords) return list;
  return [...list]
    .sort((a, b) => createdAtMs(b.createdAt) - createdAtMs(a.createdAt))
    .slice(0, maxRecords);
}

export function saveCreateIdempotency(record: CreateIdempotencyRecord): void {
  const file = readStore();
  file.createIdempotency = file.createIdempotency ?? [];
  const idx = file.createIdempotency.findIndex(
    (c) => c.key === record.key && c.address.toLowerCase() === record.address.toLowerCase(),
  );
  if (idx >= 0) {
    file.createIdempotency[idx] = record;
  } else {
    file.createIdempotency.push(record);
  }
  file.createIdempotency = capIdempotencyList(
    file.createIdempotency,
    WEBHOOK_IDEMPOTENCY_MAX_RECORDS,
  );
  writeStore(file);
}

export function findRotateIdempotency(
  webhookId: string,
  key: string,
): RotateIdempotencyRecord | undefined {
  const file = readStore();
  return file.rotateIdempotency?.find(
    (r) => r.webhookId === webhookId && r.key === key,
  );
}

export function saveRotateIdempotency(record: RotateIdempotencyRecord): void {
  const file = readStore();
  file.rotateIdempotency = file.rotateIdempotency ?? [];
  const idx = file.rotateIdempotency.findIndex(
    (r) => r.webhookId === record.webhookId && r.key === record.key,
  );
  if (idx >= 0) {
    file.rotateIdempotency[idx] = record;
  } else {
    file.rotateIdempotency.push(record);
  }
  file.rotateIdempotency = capIdempotencyList(
    file.rotateIdempotency,
    WEBHOOK_IDEMPOTENCY_MAX_RECORDS,
  );
  writeStore(file);
}

export function compactIdempotencyKeys(
  retentionDays: number = config.webhooks.logRetentionDays,
  maxRecords: number = WEBHOOK_IDEMPOTENCY_MAX_RECORDS,
): void {
  const file = readStore();
  file.createIdempotency = trimIdempotencyList(
    file.createIdempotency,
    retentionDays,
    maxRecords,
  );
  file.rotateIdempotency = trimIdempotencyList(
    file.rotateIdempotency,
    retentionDays,
    maxRecords,
  );
  writeStore(file);
}

export function resetWebhooksStoreForTests(): void {
  failClosed = false;
  try {
    if (existsSync(failClosedPath())) unlinkSync(failClosedPath());
  } catch {
    // ignore
  }
  try {
    if (existsSync(tmpPath())) unlinkSync(tmpPath());
  } catch {
    // ignore
  }
  try {
    if (existsSync(storePath())) unlinkSync(storePath());
  } catch {
    // ignore
  }
}

export function setWebhooksFailClosedForTests(value: boolean): void {
  failClosed = value;
}
