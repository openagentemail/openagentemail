/**
 * Persistent bounded dedup keyed by configured subscription + signed event id.
 * Capacity/storage failure fails closed and never evicts live records.
 * File + parent-directory fsync after rename; first-created dirs are fsynced.
 * Malformed records are never treated as a successful hit.
 */

import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { DedupConfig, DedupRecord } from './types.ts';

export class DedupError extends Error {
  code:
    | 'storage_failed'
    | 'storage_capacity'
    | 'dedup_rename_failed'
    | 'dedup_dir_fsync_failed'
    | 'dedup_mkdir_fsync_failed';
  constructor(
    code:
      | 'storage_failed'
      | 'storage_capacity'
      | 'dedup_rename_failed'
      | 'dedup_dir_fsync_failed'
      | 'dedup_mkdir_fsync_failed',
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

type StoreFile = {
  records: Record<string, DedupRecord>;
};

export type DedupFailureKind =
  | 'read'
  | 'write'
  | 'capacity'
  | 'rename'
  | 'dir_fsync'
  | 'mkdir_fsync'
  | 'dirsync_persist'
  | 'unacked_persist';

export function dedupKey(subscriptionId: string, eventId: string): string {
  return `${subscriptionId}:${eventId}`;
}

export type DedupInspect =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'state_unreadable'
        | 'state_corrupt'
        | 'state_unacked'
        | 'state_unacked_unreadable'
        | 'state_dirsync'
        | 'state_dirsync_unreadable'
        | 'state_dirsync_corrupt'
        | 'state_dirsync_not_file'
        | 'state_capacity'
        | 'state_not_file';
    };

/** Reject FIFO/dir/socket before a blocking readFileSync. Missing is ok. */
export function inspectRegularStateFile(path: string): 'missing' | 'file' | 'not_file' | 'unreadable' {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) {
      try {
        return statSync(path).isFile() ? 'file' : 'not_file';
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_file' : 'unreadable';
      }
    }
    return link.isFile() ? 'file' : 'not_file';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function isPlainRecordMap(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function emptyRecordMap(): Record<string, DedupRecord> {
  return Object.create(null) as Record<string, DedupRecord>;
}

export function isSafeDedupKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_RECORD_KEYS.has(key);
}

/** Absolute paths only. Empty or truncated markers are corrupt, not an empty chain. */
function parseDirsyncLines(raw: string): string[] | null {
  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0 || !lines.every((line) => line.startsWith('/') && !line.includes('\0'))) {
    return null;
  }
  return lines;
}

/** Read-only. Does not repair `.unacked` or rewrite / drop corrupt files. */
export function inspectDedupFile(
  path: string,
  options?: { maxRecords?: number; nowMs?: number },
): DedupInspect {
  const unacked = `${path}.unacked`;
  const unackedKind = inspectRegularStateFile(unacked);
  if (unackedKind === 'not_file') {
    return { ok: false, reason: 'state_unacked' };
  }
  if (unackedKind === 'unreadable') {
    return { ok: false, reason: 'state_unacked_unreadable' };
  }
  if (unackedKind === 'file') {
    try {
      accessSync(unacked, constants.R_OK);
    } catch {
      return { ok: false, reason: 'state_unacked_unreadable' };
    }
    return { ok: false, reason: 'state_unacked' };
  }
  const dirsync = `${path}.dirsync`;
  const dirsyncKind = inspectRegularStateFile(dirsync);
  if (dirsyncKind === 'not_file') {
    return { ok: false, reason: 'state_dirsync_not_file' };
  }
  if (dirsyncKind === 'unreadable') {
    return { ok: false, reason: 'state_dirsync_unreadable' };
  }
  if (dirsyncKind === 'file') {
    try {
      accessSync(dirsync, constants.R_OK);
    } catch {
      return { ok: false, reason: 'state_dirsync_unreadable' };
    }
    try {
      const lines = parseDirsyncLines(readFileSync(dirsync, 'utf8'));
      if (!lines) {
        return { ok: false, reason: 'state_dirsync_corrupt' };
      }
      return { ok: false, reason: 'state_dirsync' };
    } catch {
      return { ok: false, reason: 'state_dirsync_corrupt' };
    }
  }
  const kind = inspectRegularStateFile(path);
  if (kind === 'missing') {
    return { ok: true };
  }
  if (kind === 'not_file') {
    return { ok: false, reason: 'state_not_file' };
  }
  if (kind === 'unreadable') {
    return { ok: false, reason: 'state_unreadable' };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return { ok: false, reason: 'state_unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainRecordMap(parsed) || !isPlainRecordMap(parsed.records)) {
      return { ok: false, reason: 'state_corrupt' };
    }
    // Every persisted entry must be a real dedup record. Do not skip/repair.
    const nowMs = options?.nowMs ?? Date.now();
    let live = 0;
    for (const [key, value] of Object.entries(parsed.records)) {
      if (!isValidDedupRecord(key, value)) {
        return { ok: false, reason: 'state_corrupt' };
      }
      if (value.expiresAtMs > nowMs) live += 1;
    }
    if (typeof options?.maxRecords === 'number' && live >= options.maxRecords) {
      return { ok: false, reason: 'state_capacity' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'state_corrupt' };
  }
}

export function isValidDedupRecord(key: string, value: unknown): value is DedupRecord {
  if (!isSafeDedupKey(key) || !value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.key === key &&
    (rec.status === 'success' || rec.status === 'observed') &&
    typeof rec.storedAtMs === 'number' &&
    Number.isFinite(rec.storedAtMs) &&
    typeof rec.expiresAtMs === 'number' &&
    Number.isFinite(rec.expiresAtMs)
  );
}

function fsyncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class DedupStore {
  readonly config: DedupConfig;
  private chain: Promise<void> = Promise.resolve();
  private inflight = new Map<string, Promise<unknown>>();
  private failReads = false;
  private failWrites = false;
  private forceCapacity = false;
  private failRename = false;
  private failDirFsync = false;
  private failMkdirFsync = false;
  private failDirsyncPersist = false;
  private failUnackedPersist = false;
  private reserved = new Set<string>();
  private readonly onDirFsync?: (dir: string) => void;

  constructor(config: DedupConfig, hooks?: { onDirFsync?: (dir: string) => void }) {
    this.config = config;
    this.onDirFsync = hooks?.onDirFsync;
  }

  unackedPath(): string {
    return `${this.config.path}.unacked`;
  }

  dirsyncPath(): string {
    return `${this.config.path}.dirsync`;
  }

  /** Test hook: next disk operation fails closed. */
  injectFailure(kind: DedupFailureKind): void {
    if (kind === 'read') this.failReads = true;
    if (kind === 'write') this.failWrites = true;
    if (kind === 'capacity') this.forceCapacity = true;
    if (kind === 'rename') this.failRename = true;
    if (kind === 'dir_fsync') this.failDirFsync = true;
    if (kind === 'mkdir_fsync') this.failMkdirFsync = true;
    if (kind === 'dirsync_persist') this.failDirsyncPersist = true;
    if (kind === 'unacked_persist') this.failUnackedPersist = true;
  }

  private withQueue<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  share<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const started = work().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, started);
    return started;
  }

  async get(key: string, nowMs: number): Promise<DedupRecord | undefined> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      return file.records[key];
    });
  }

  /** Hold one slot until commit or releaseCapacity. Bounded by in-flight keys. */
  async reserveCapacity(key: string, nowMs: number): Promise<void> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      if (this.forceCapacity || this.wouldExceed(file, key)) {
        throw new DedupError('storage_capacity', 'dedup_capacity');
      }
      if (!file.records[key]) {
        this.reserved.add(key);
      }
    });
  }

  async releaseCapacity(key: string): Promise<void> {
    return this.withQueue(() => {
      this.reserved.delete(key);
    });
  }

  async commit(record: DedupRecord, nowMs: number): Promise<void> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      if (this.forceCapacity || this.wouldExceed(file, record.key)) {
        throw new DedupError('storage_capacity', 'dedup_capacity');
      }
      if (!isSafeDedupKey(record.key)) {
        throw new DedupError('storage_failed', 'dedup_unsafe_key');
      }
      Object.defineProperty(file.records, record.key, {
        value: record,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.writeFile(file);
      this.reserved.delete(record.key);
    });
  }

  async count(nowMs: number): Promise<number> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      return Object.keys(file.records).length;
    });
  }

  private wouldExceed(file: StoreFile, key: string): boolean {
    if (file.records[key] || this.reserved.has(key)) return false;
    return Object.keys(file.records).length + this.reserved.size >= this.config.maxRecords;
  }

  private expire(file: StoreFile, nowMs: number): void {
    for (const [key, rec] of Object.entries(file.records)) {
      if (rec.expiresAtMs <= nowMs) {
        delete file.records[key];
      }
    }
  }

  private markUnacked(): void {
    writeFileSync(this.unackedPath(), 'unacked\n', { mode: 0o600 });
  }

  /** File + parent-dir fsync so a crash after rename still sees the marker. */
  private persistUnacked(): void {
    if (this.failUnackedPersist) {
      this.failUnackedPersist = false;
      throw new DedupError('dedup_dir_fsync_failed', 'dedup_unacked_persist_failed');
    }
    const marker = this.unackedPath();
    writeFileSync(marker, 'unacked\n', { mode: 0o600 });
    const fd = openSync(marker, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(marker));
  }

  private clearUnacked(): void {
    try {
      unlinkSync(this.unackedPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new DedupError('storage_failed', 'dedup_unacked_clear_failed');
      }
    }
  }

  private fsyncParentOrThrow(): void {
    const parent = dirname(this.config.path);
    if (this.failDirFsync) {
      this.failDirFsync = false;
      this.markUnacked();
      throw new DedupError('dedup_dir_fsync_failed', 'dedup_dir_fsync_failed');
    }
    try {
      fsyncDirectory(parent);
    } catch (err) {
      if (err instanceof DedupError) throw err;
      this.markUnacked();
      throw new DedupError('dedup_dir_fsync_failed', 'dedup_dir_fsync_failed');
    }
  }

  /** A renamed file is not ACK-able until the parent directory fsync succeeds. */
  private requireDurable(): void {
    if (!existsSync(this.unackedPath())) return;
    this.fsyncParentOrThrow();
    this.clearUnacked();
  }

  private readFile(): StoreFile {
    this.requireDurable();
    if (this.failReads) {
      this.failReads = false;
      throw new DedupError('storage_failed', 'dedup_read_failed');
    }
    try {
      const kind = inspectRegularStateFile(this.config.path);
      if (kind === 'not_file') {
        throw new DedupError('storage_failed', 'dedup_not_file');
      }
      if (kind === 'unreadable') {
        throw new DedupError('storage_failed', 'dedup_read_failed');
      }
      const raw = readFileSync(this.config.path, 'utf8');
      const parsed = JSON.parse(raw) as { records?: unknown };
      if (!parsed || typeof parsed !== 'object' || parsed.records == null || typeof parsed.records !== 'object') {
        throw new DedupError('storage_failed', 'dedup_corrupt');
      }
      const records = emptyRecordMap();
      for (const [key, value] of Object.entries(parsed.records as Record<string, unknown>)) {
        if (!isValidDedupRecord(key, value)) {
          // Malformed entries are not successful dedup hits.
          continue;
        }
        Object.defineProperty(records, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return { records };
    } catch (err) {
      if (err instanceof DedupError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { records: emptyRecordMap() };
      }
      throw new DedupError('storage_failed', 'dedup_read_failed');
    }
  }

  private writeDirsync(dirs: string[]): void {
    if (this.failDirsyncPersist) {
      this.failDirsyncPersist = false;
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_dirsync_persist_failed');
    }
    const marker = this.dirsyncPath();
    writeFileSync(marker, `${dirs.join('\n')}\n`, { mode: 0o600 });
    const fd = openSync(marker, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(marker));
  }

  /** Missing marker → empty (caller recovers by walking). Corrupt/nonregular marker fails closed. */
  private requirePendingDirsync(): string[] {
    const kind = inspectRegularStateFile(this.dirsyncPath());
    if (kind === 'missing') return [];
    if (kind === 'not_file') {
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_dirsync_not_file');
    }
    if (kind === 'unreadable') {
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_dirsync_unreadable');
    }
    let raw: string;
    try {
      raw = readFileSync(this.dirsyncPath(), 'utf8');
    } catch {
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_dirsync_unreadable');
    }
    const lines = parseDirsyncLines(raw);
    if (!lines) {
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_dirsync_corrupt');
    }
    return lines;
  }

  private clearDirsync(): void {
    try {
      unlinkSync(this.dirsyncPath());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new DedupError('storage_failed', 'dedup_dirsync_clear_failed');
      }
    }
  }

  private fsyncAncestorChain(dirs: string[]): void {
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        fsyncDirectory(dir);
        this.onDirFsync?.(dir);
      } catch (err) {
        if (err instanceof DedupError) throw err;
        throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_mkdir_fsync_failed');
      }
    }
  }

  /** Sync existing ancestors. EACCES/EPERM is a failed sync, not a durable wall. */
  private fsyncExistingAncestors(start: string): void {
    let cursor = start;
    for (;;) {
      if (existsSync(cursor)) {
        try {
          fsyncDirectory(cursor);
          this.onDirFsync?.(cursor);
        } catch (err) {
          if (err instanceof DedupError) throw err;
          throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_mkdir_fsync_failed');
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  private mkdirDurable(dir: string): void {
    const pending = this.requirePendingDirsync();
    if (pending.length > 0) {
      if (this.failMkdirFsync) {
        this.failMkdirFsync = false;
        throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_mkdir_fsync_failed');
      }
      this.fsyncAncestorChain(pending);
      this.clearDirsync();
    }

    const missing: string[] = [];
    let cursor = dir;
    while (!existsSync(cursor)) {
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    mkdirSync(dir, { recursive: true });
    const chain = [...missing];
    if (existsSync(cursor) && !chain.includes(cursor)) {
      chain.push(cursor);
    }
    if (chain.length > 0) {
      this.writeDirsync(chain);
    }
    if (this.failMkdirFsync) {
      this.failMkdirFsync = false;
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_mkdir_fsync_failed');
    }
    // Marker may be missing after a crash; always sync existing ancestors before ACK.
    this.fsyncExistingAncestors(dir);
    this.clearDirsync();
  }

  private writeFile(file: StoreFile): void {
    if (this.failWrites) {
      this.failWrites = false;
      throw new DedupError('storage_failed', 'dedup_write_failed');
    }
    const parent = dirname(this.config.path);
    try {
      this.mkdirDurable(parent);
      const tmp = `${this.config.path}.tmp.${process.pid}`;
      const payload = JSON.stringify(file);
      writeFileSync(tmp, payload, { mode: 0o600 });
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (this.failRename) {
        this.failRename = false;
        throw new DedupError('dedup_rename_failed', 'dedup_rename_failed');
      }
      this.persistUnacked();
      renameSync(tmp, this.config.path);
      this.fsyncParentOrThrow();
      this.clearUnacked();
    } catch (err) {
      if (err instanceof DedupError) throw err;
      throw new DedupError('storage_failed', 'dedup_write_failed');
    }
  }
}
