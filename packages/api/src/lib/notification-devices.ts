/**
 * 设备登记表（ADR #26 PR 6）。
 *
 * DATA_DIR/notification-devices.json：id / displayName / ntfyUsername / topic
 * labels / pairedAt / lastSeenAt / revokeStatus / revokedAt。
 * password/token 永不落盘。单写者 promise 队列、目录 0700、文件 0600、
 * 同目录 .tmp + fsync 文件 + atomic rename + fsync 目录。
 * 覆盖写先把旧文件改名为 .bak，目录 fsync 失败则换回，成功再删 .bak。
 *
 * 吊销：active → pending_revoke（先落盘）→ 删 ntfy user（仅 40031 /
 * "user does not exist" 算缺失成功）→ revoked。步骤 1 失败不得触达 ntfy；
 * 步骤 3 失败保持 pending，启动/列表对账因缺失信号收敛到 revoked。
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
  writeFileSync,
  writeSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
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
/** 禁止落盘的键名（大小写不敏感）；只看 key，不扫字符串值。 */
const FORBIDDEN_SECRET_KEYS = new Set(['password', 'token']);

let writeChain: Promise<unknown> = Promise.resolve();
let persistHookForTests: (() => void) | null = null;
let dirFsyncHookForTests: (() => void) | null = null;
let bakRestoreHookForTests: (() => void) | null = null;
let snapshotRestoreHookForTests: (() => void) | null = null;
let nowFn: () => number = () => Date.now();
let failClosed = false;

function storePath(): string {
  return join(config.dataDir, DEVICE_REGISTRY_FILE);
}

function tmpPath(): string {
  return `${storePath()}.tmp`;
}

function bakPath(): string {
  return `${storePath()}.bak`;
}

function unrestoredPath(): string {
  return `${storePath()}.unrestored`;
}

/**
 * POSIX write(2) 允许短写。writeFileSync 会写全量，但这里自管 fd，
 * 必须循环直到整段 UTF-8 落盘，再 fsync，避免 rename 进半截 JSON。
 */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    const n = writeSync(fd, buf, offset, buf.length - offset);
    if (n <= 0) throw new Error('short_write');
    offset += n;
  }
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

/**
 * 递归检查对象键名是否出现 password/token。
 * displayName 等字符串值里的 `"password":` 文本不得误拦。
 */
export function registryHasForbiddenSecretKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => registryHasForbiddenSecretKey(item));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) return true;
    if (registryHasForbiddenSecretKey(child)) return true;
  }
  return false;
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
  if (registryHasForbiddenSecretKey(row)) return null;
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

/** 覆盖写留下的 .bak：dest 缺失则恢复旧表；dest 已在则丢掉残留备份。 */
function recoverBackupSync(): void {
  const bak = bakPath();
  const dest = storePath();
  // 三连失败把新 dest 隔离成 .unrestored：不得当有效文件，也不得丢掉 .bak。
  if (existsSync(unrestoredPath()) && existsSync(bak)) {
    failClosed = true;
    deviceRegistryHealthAlert('crash_bak_restore_exhausted', { path: DEVICE_REGISTRY_FILE });
    throw new DeviceRegistryCorruptError();
  }
  if (!existsSync(bak)) return;
  if (!existsSync(dest)) {
    try {
      bakRestoreHookForTests?.();
      renameSync(bak, dest);
      deviceRegistryHealthAlert('crash_bak_restored', { path: DEVICE_REGISTRY_FILE });
    } catch (err) {
      failClosed = true;
      deviceRegistryHealthAlert('crash_bak_restore_failed', {
        path: DEVICE_REGISTRY_FILE,
        error: err instanceof Error ? err.message : 'unknown',
      });
      throw new DeviceRegistryCorruptError();
    }
    return;
  }
  try {
    rmSync(bak, { force: true });
    deviceRegistryHealthAlert('crash_bak_discarded', { path: DEVICE_REGISTRY_FILE });
  } catch (err) {
    deviceRegistryHealthAlert('crash_bak_cleanup_failed', {
      path: DEVICE_REGISTRY_FILE,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** 目录 fsync 失败时把覆盖写滚回旧 registry（.bak 优先，内存快照兜底）。 */
function restoreOverwrittenRegistry(dest: string, bak: string, previous: Buffer | null): void {
  try {
    bakRestoreHookForTests?.();
    if (existsSync(bak)) {
      renameSync(bak, dest);
      return;
    }
  } catch {
    // 下面用内存快照再写一次
  }
  try {
    snapshotRestoreHookForTests?.();
    if (previous) {
      writeFileSync(dest, previous, { mode: 0o600 });
      return;
    }
  } catch {
    // 三连失败走 fail-closed
  }
  failClosed = true;
  deviceRegistryHealthAlert('crash_bak_restore_exhausted', { path: DEVICE_REGISTRY_FILE });
  // 把新 dest 挪走，避免下次读盘把新文件当有效并丢掉 .bak。
  try {
    if (existsSync(dest)) renameSync(dest, unrestoredPath());
  } catch {
    try {
      rmSync(dest, { force: true });
    } catch {
      // dest 挪不走也保持 failClosed；.bak 仍留着
    }
  }
  throw new DeviceRegistryCorruptError();
}

function readRegistrySync(): RegistryFile {
  if (failClosed) throw new DeviceRegistryCorruptError();
  recoverCrashTmpSync();
  recoverBackupSync();
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

function fsyncDirectorySync(dir: string): void {
  dirFsyncHookForTests?.();
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 个别 fs（部分 NFS/FUSE、部分 Windows）不允许对目录 fsync：rename 已完成，
    // 视为成功以免整站无法落盘。EIO 等真失败仍按持久化失败上抛。
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS') return;
    throw err;
  } finally {
    closeSync(fd);
  }
}

function writeAtomicSync(file: RegistryFile): void {
  if (failClosed) throw new DeviceRegistryCorruptError();
  // dest 缺而 .bak 还在：禁止当空表落盘，否则会丢掉历史配对。
  if (existsSync(bakPath()) && !existsSync(storePath())) {
    failClosed = true;
    deviceRegistryHealthAlert('crash_bak_unrestored', { path: DEVICE_REGISTRY_FILE });
    throw new DeviceRegistryCorruptError();
  }
  ensureDataDir();
  persistHookForTests?.();
  // 结构化键检查：不扫序列化文本，避免 displayName 含 `"password":` 被误拒。
  if (registryHasForbiddenSecretKey(file)) {
    throw new DeviceRegistryPersistError('refusing to persist password/token');
  }
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  const tmp = tmpPath();
  const dest = storePath();
  const bak = bakPath();
  const replacing = existsSync(dest);
  // 覆盖写：先把旧文件挪到 .bak，fsync 失败时再换回来，保证 502 与磁盘一致。
  const previous = replacing ? readFileSync(dest) : null;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeAllSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  if (replacing) renameSync(dest, bak);
  renameSync(tmp, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best effort
  }
  try {
    fsyncDirectorySync(config.dataDir);
  } catch (err) {
    // 首次创建：撤回刚 rename 的文件，避免接口失败但磁盘已有设备。
    // 覆盖写：把 .bak（或内存快照）换回 dest，磁盘回到旧态，与 persist 失败一致。
    if (!replacing) {
      try {
        rmSync(dest, { force: true });
      } catch {
        // ignore
      }
    } else {
      restoreOverwrittenRegistry(dest, bak, previous);
    }
    throw err;
  }
  if (replacing) {
    try {
      rmSync(bak, { force: true });
    } catch {
      // 残留 .bak 下次读盘会丢掉
    }
  }
}

function persist(file: RegistryFile): void {
  try {
    writeAtomicSync(file);
  } catch (err) {
    if (err instanceof DeviceRegistryCorruptError || err instanceof DeviceRegistryPersistError) throw err;
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

/** skipDeviceId：revoke 入口对账其它 pending，但跳过本次目标，避免对同一 user 连 DELETE 两次。 */
export function reconcilePendingRevokes(deleteUser: DeleteNtfyUser, skipDeviceId?: string): Promise<void> {
  return enqueue(async () => {
    const file = readRegistrySync();
    for (const device of file.devices) {
      if (device.revokeStatus !== 'pending_revoke') continue;
      if (skipDeviceId && device.id === skipDeviceId) continue;
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

/** 启动入口：corrupt 已 fail-closed 并告警，不阻断邮件 API 监听。 */
export async function inspectDeviceRegistryAtBoot(): Promise<void> {
  try {
    await inspectDeviceRegistry();
  } catch (err) {
    if (err instanceof DeviceRegistryCorruptError) return;
    throw err;
  }
}

export function setDeviceRegistryPersistHookForTests(hook: (() => void) | null): void {
  persistHookForTests = hook;
}

export function setDeviceRegistryDirFsyncHookForTests(hook: (() => void) | null): void {
  dirFsyncHookForTests = hook;
}

export function setDeviceRegistryBakRestoreHookForTests(hook: (() => void) | null): void {
  bakRestoreHookForTests = hook;
}

export function setDeviceRegistrySnapshotRestoreHookForTests(hook: (() => void) | null): void {
  snapshotRestoreHookForTests = hook;
}

export function setDeviceRegistryNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function resetDeviceRegistryForTests(): void {
  failClosed = false;
  persistHookForTests = null;
  dirFsyncHookForTests = null;
  bakRestoreHookForTests = null;
  snapshotRestoreHookForTests = null;
  nowFn = () => Date.now();
  writeChain = Promise.resolve();
  for (const path of [storePath(), tmpPath(), bakPath(), unrestoredPath()]) {
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

/** 测试缝：走与生产相同的落盘闸（含 secret-key 结构化拒绝）。 */
export function persistRegistryForTests(file: unknown): void {
  persist(file as RegistryFile);
}

export function deviceRegistryFailClosedForTests(): boolean {
  return failClosed;
}
