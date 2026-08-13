/**
 * 设备登记表（ADR #26 PR 6）。
 *
 * DATA_DIR/notification-devices.json：id / displayName / ntfyUsername / topic
 * labels / pairedAt / lastSeenAt / revokeStatus / revokedAt。
 * password/token 永不落盘。单写者 promise 队列、目录 0700、文件 0600、
 * 同目录 .tmp + fsync + atomic rename。
 *
 * 吊销：active → pending_revoke（先落盘）→ 删 ntfy user（404/not_found 算成功）
 * → revoked。步骤 1 失败不得触达 ntfy；步骤 3 失败保持 pending，启动/列表对账
 * 因 not_found 收敛到 revoked。
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
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.ts';

export const DEVICE_REGISTRY_SCHEMA_VERSION = 1;
export const DEVICE_REGISTRY_FILE = 'notification-devices.json';

export type DeviceRevokeStatus = 'active' | 'pending_revoke' | 'revoked';

export type DeviceTopics = {
  userAlerts: string;
  userLow: string;
};

export type DeviceRecord = {
  id: string;
  displayName: string;
  ntfyUsername: string;
  topics: DeviceTopics;
  pairedAt: string;
  lastSeenAt: string | null;
  revokeStatus: DeviceRevokeStatus;
  revokedAt: string | null;
};

export type DeviceListItem = {
  id: string;
  displayName: string;
  topics: DeviceTopics;
  topicLabels: { userAlerts: string; userLow: string };
  pairedAt: string;
  lastSeenAt: string | null;
  revokeStatus: DeviceRevokeStatus;
  revokedAt: string | null;
};

export type NtfyUserDeleteResult = 'deleted' | 'not_found' | 'transient';
export type DeleteNtfyUser = (username: string) => Promise<NtfyUserDeleteResult>;

export class DeviceRegistryCorruptError extends Error {
  readonly code = 'device_registry_corrupt';
  constructor() {
    super('device_registry_corrupt');
    this.name = 'DeviceRegistryCorruptError';
  }
}

export class DeviceRegistryPersistError extends Error {
  readonly code = 'device_registry_unavailable';
  constructor(cause?: unknown) {
    super('device_registry_unavailable');
    this.name = 'DeviceRegistryPersistError';
    if (cause instanceof Error) this.cause = cause;
  }
}

export class DeviceNotFoundError extends Error {
  readonly code = 'not_found';
  constructor() {
    super('not_found');
    this.name = 'DeviceNotFoundError';
  }
}

export class DeviceRevokeTransientError extends Error {
  readonly code = 'device_revoke_retry';
  constructor() {
    super('device_revoke_retry');
    this.name = 'DeviceRevokeTransientError';
  }
}

type RegistryFile = {
  schemaVersion: typeof DEVICE_REGISTRY_SCHEMA_VERSION;
  devices: DeviceRecord[];
};

const STATUSES = new Set<DeviceRevokeStatus>(['active', 'pending_revoke', 'revoked']);
const DISPLAY_NAME_MAX = 80;
const DEFAULT_DISPLAY_NAME = 'Phone';

let writeChain: Promise<unknown> = Promise.resolve();
let persistHookForTests: (() => void) | null = null;
let nowFn: () => number = () => Date.now();
let failClosed = false;

function storePath(): string {
  return join(config.dataDir, DEVICE_REGISTRY_FILE);
}

function tmpPath(): string {
  return `${storePath()}.tmp`;
}

function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 高优先级本地健康告警：不含 password/token。 */
export function deviceRegistryHealthAlert(kind: string, detail: Record<string, unknown> = {}): void {
  console.error(`[notification-devices] HIGH: ${kind}`, detail);
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 属主可能不同；文件 mode 仍会设置
  }
}

function newDeviceId(): string {
  return `dev_${randomBytes(12).toString('hex')}`;
}

export function normalizeDisplayName(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return DEFAULT_DISPLAY_NAME;
  return trimmed.slice(0, DISPLAY_NAME_MAX);
}

function parseRecord(raw: unknown): DeviceRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.startsWith('dev_') || row.id.length > 64) return null;
  if (typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > DISPLAY_NAME_MAX) {
    return null;
  }
  if (typeof row.ntfyUsername !== 'string' || !row.ntfyUsername.startsWith('phone-')) return null;
  const topics = row.topics as Record<string, unknown> | undefined;
  if (!topics || typeof topics.userAlerts !== 'string' || typeof topics.userLow !== 'string') return null;
  if (typeof row.pairedAt !== 'string' || !Number.isFinite(Date.parse(row.pairedAt))) return null;
  if (row.lastSeenAt !== null && typeof row.lastSeenAt !== 'string') return null;
  if (typeof row.revokeStatus !== 'string' || !STATUSES.has(row.revokeStatus as DeviceRevokeStatus)) return null;
  if (row.revokeStatus === 'revoked') {
    if (typeof row.revokedAt !== 'string' || !Number.isFinite(Date.parse(row.revokedAt))) return null;
  } else if (row.revokedAt !== null) {
    return null;
  }
  if (/"password"\s*:|"token"\s*:/i.test(JSON.stringify(row))) return null;
  return {
    id: row.id,
    displayName: row.displayName,
    ntfyUsername: row.ntfyUsername,
    topics: { userAlerts: topics.userAlerts, userLow: topics.userLow },
    pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt,
    revokeStatus: row.revokeStatus as DeviceRevokeStatus,
    revokedAt: row.revokedAt as string | null,
  };
}

function parseFile(raw: string): RegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceRegistryCorruptError();
  }
  if (!parsed || typeof parsed !== 'object') throw new DeviceRegistryCorruptError();
  const body = parsed as Record<string, unknown>;
  if (body.schemaVersion !== DEVICE_REGISTRY_SCHEMA_VERSION) throw new DeviceRegistryCorruptError();
  if (!Array.isArray(body.devices)) throw new DeviceRegistryCorruptError();
  const devices: DeviceRecord[] = [];
  const ids = new Set<string>();
  for (const item of body.devices) {
    const record = parseRecord(item);
    if (!record) throw new DeviceRegistryCorruptError();
    if (ids.has(record.id)) throw new DeviceRegistryCorruptError();
    ids.add(record.id);
    devices.push(record);
  }
  return { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices };
}

function recoverCrashTmpSync(): void {
  const tmp = tmpPath();
  const path = storePath();
  if (!existsSync(tmp)) return;
  try {
    if (existsSync(path)) {
      rmSync(tmp, { force: true });
      deviceRegistryHealthAlert('crash_tmp_discarded', { path: DEVICE_REGISTRY_FILE });
      return;
    }
    rmSync(tmp, { force: true });
    deviceRegistryHealthAlert('crash_tmp_incomplete_first_write', { path: DEVICE_REGISTRY_FILE });
  } catch (err) {
    deviceRegistryHealthAlert('crash_tmp_cleanup_failed', {
      path: DEVICE_REGISTRY_FILE,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

function readRegistrySync(): RegistryFile {
  recoverCrashTmpSync();
  const path = storePath();
  if (!existsSync(path)) {
    failClosed = false;
    return { schemaVersion: DEVICE_REGISTRY_SCHEMA_VERSION, devices: [] };
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort
      }
    }
  } catch {
    // stat 失败走下面 read
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    failClosed = true;
    deviceRegistryHealthAlert('read_failed', {
      path: DEVICE_REGISTRY_FILE,
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw new DeviceRegistryCorruptError();
  }
  try {
    const parsed = parseFile(raw);
    failClosed = false;
    return parsed;
  } catch (err) {
    failClosed = true;
    deviceRegistryHealthAlert('corrupt', { path: DEVICE_REGISTRY_FILE });
    if (err instanceof DeviceRegistryCorruptError) throw err;
    throw new DeviceRegistryCorruptError();
  }
}

function writeAtomicSync(file: RegistryFile): void {
  if (failClosed) throw new DeviceRegistryCorruptError();
  ensureDataDir();
  persistHookForTests?.();
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (/"password"\s*:|"token"\s*:/i.test(serialized)) {
    throw new DeviceRegistryPersistError('refusing to persist password/token');
  }
  const tmp = tmpPath();
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  renameSync(tmp, storePath());
  try {
    chmodSync(storePath(), 0o600);
  } catch {
    // best effort
  }
}

function persist(file: RegistryFile): void {
  try {
    writeAtomicSync(file);
  } catch (err) {
    if (err instanceof DeviceRegistryCorruptError) throw err;
    deviceRegistryHealthAlert('persist_failed', {
      path: DEVICE_REGISTRY_FILE,
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw new DeviceRegistryPersistError(err);
  }
}

function toListItem(record: DeviceRecord): DeviceListItem {
  return {
    id: record.id,
    displayName: record.displayName,
    topics: record.topics,
    topicLabels: { userAlerts: 'User alerts', userLow: 'User low' },
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
    revokeStatus: record.revokeStatus,
    revokedAt: record.revokedAt,
  };
}

export function registerPairedDevice(input: {
  displayName?: string;
  ntfyUsername: string;
  topics: DeviceTopics;
}): Promise<DeviceRecord> {
  return enqueue(() => {
    const file = readRegistrySync();
    const record: DeviceRecord = {
      id: newDeviceId(),
      displayName: normalizeDisplayName(input.displayName),
      ntfyUsername: input.ntfyUsername,
      topics: {
        userAlerts: input.topics.userAlerts,
        userLow: input.topics.userLow,
      },
      pairedAt: new Date(nowFn()).toISOString(),
      lastSeenAt: null,
      revokeStatus: 'active',
      revokedAt: null,
    };
    file.devices.push(record);
    persist(file);
    return record;
  });
}

async function finishRevoke(
  file: RegistryFile,
  device: DeviceRecord,
  deleteUser: DeleteNtfyUser,
): Promise<'revoked'> {
  const remote = await deleteUser(device.ntfyUsername);
  if (remote === 'transient') {
    deviceRegistryHealthAlert('revoke_ntfy_transient', { id: device.id });
    throw new DeviceRevokeTransientError();
  }
  device.revokeStatus = 'revoked';
  device.revokedAt = new Date(nowFn()).toISOString();
  persist(file);
  return 'revoked';
}

export function revokePairedDevice(
  id: string,
  deleteUser: DeleteNtfyUser,
): Promise<'revoked' | 'already_revoked'> {
  return enqueue(async () => {
    const file = readRegistrySync();
    const device = file.devices.find((row) => row.id === id);
    if (!device) throw new DeviceNotFoundError();
    if (device.revokeStatus === 'revoked') return 'already_revoked';
    if (device.revokeStatus === 'active') {
      device.revokeStatus = 'pending_revoke';
      device.revokedAt = null;
      persist(file);
    }
    return finishRevoke(file, device, deleteUser);
  });
}

export function reconcilePendingRevokes(deleteUser: DeleteNtfyUser): Promise<void> {
  return enqueue(async () => {
    const file = readRegistrySync();
    for (const device of file.devices) {
      if (device.revokeStatus !== 'pending_revoke') continue;
      try {
        await finishRevoke(file, device, deleteUser);
      } catch (err) {
        if (err instanceof DeviceRevokeTransientError || err instanceof DeviceRegistryPersistError) {
          continue;
        }
        throw err;
      }
    }
  });
}

export function listPairedDevices(options: { includeRevoked?: boolean } = {}): Promise<DeviceListItem[]> {
  return enqueue(() => {
    const file = readRegistrySync();
    return file.devices
      .filter((row) => options.includeRevoked || row.revokeStatus !== 'revoked')
      .map(toListItem);
  });
}

/** 启动时读盘（崩溃 tmp / corrupt 告警）并对账入口由调用方接着跑 reconcile。 */
export function inspectDeviceRegistry(): Promise<void> {
  return enqueue(() => {
    readRegistrySync();
  });
}

export function setDeviceRegistryPersistHookForTests(hook: (() => void) | null): void {
  persistHookForTests = hook;
}

export function setDeviceRegistryNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function resetDeviceRegistryForTests(): void {
  failClosed = false;
  persistHookForTests = null;
  nowFn = () => Date.now();
  writeChain = Promise.resolve();
  for (const path of [storePath(), tmpPath()]) {
    try {
      if (existsSync(path)) rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

export function deviceRegistryPathForTests(): string {
  return storePath();
}

export function deviceRegistryFailClosedForTests(): boolean {
  return failClosed;
}
