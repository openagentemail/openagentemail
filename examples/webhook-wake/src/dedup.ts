/**
 * Persistent bounded dedup keyed by configured subscription + signed event id.
 * Capacity/storage failure fails closed and never evicts live records.
 * File + parent-directory fsync after rename; first-created dirs are fsynced.
 * Malformed records are never treated as a successful hit.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

export type DedupFailureKind = 'read' | 'write' | 'capacity' | 'rename' | 'dir_fsync' | 'mkdir_fsync';

export function dedupKey(subscriptionId: string, eventId: string): string {
  return `${subscriptionId}:${eventId}`;
}

export function isValidDedupRecord(key: string, value: unknown): value is DedupRecord {
  if (!value || typeof value !== 'object') return false;
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

  constructor(config: DedupConfig) {
    this.config = config;
  }

  /** Test hook: next disk operation fails closed. */
  injectFailure(kind: DedupFailureKind): void {
    if (kind === 'read') this.failReads = true;
    if (kind === 'write') this.failWrites = true;
    if (kind === 'capacity') this.forceCapacity = true;
    if (kind === 'rename') this.failRename = true;
    if (kind === 'dir_fsync') this.failDirFsync = true;
    if (kind === 'mkdir_fsync') this.failMkdirFsync = true;
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

  async ensureCapacity(key: string, nowMs: number): Promise<void> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      if (this.forceCapacity || this.wouldExceed(file, key)) {
        throw new DedupError('storage_capacity', 'dedup_capacity');
      }
    });
  }

  async commit(record: DedupRecord, nowMs: number): Promise<void> {
    return this.withQueue(() => {
      const file = this.readFile();
      this.expire(file, nowMs);
      if (this.forceCapacity || this.wouldExceed(file, record.key)) {
        throw new DedupError('storage_capacity', 'dedup_capacity');
      }
      file.records[record.key] = record;
      this.writeFile(file);
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
    if (file.records[key]) return false;
    return Object.keys(file.records).length >= this.config.maxRecords;
  }

  private expire(file: StoreFile, nowMs: number): void {
    for (const [key, rec] of Object.entries(file.records)) {
      if (rec.expiresAtMs <= nowMs) {
        delete file.records[key];
      }
    }
  }

  private readFile(): StoreFile {
    if (this.failReads) {
      this.failReads = false;
      throw new DedupError('storage_failed', 'dedup_read_failed');
    }
    try {
      const raw = readFileSync(this.config.path, 'utf8');
      const parsed = JSON.parse(raw) as { records?: unknown };
      if (!parsed || typeof parsed !== 'object' || parsed.records == null || typeof parsed.records !== 'object') {
        throw new DedupError('storage_failed', 'dedup_corrupt');
      }
      const records: Record<string, DedupRecord> = {};
      for (const [key, value] of Object.entries(parsed.records as Record<string, unknown>)) {
        if (!isValidDedupRecord(key, value)) {
          // Malformed entries are not successful dedup hits.
          continue;
        }
        records[key] = value;
      }
      return { records };
    } catch (err) {
      if (err instanceof DedupError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { records: {} };
      }
      throw new DedupError('storage_failed', 'dedup_read_failed');
    }
  }

  private mkdirDurable(dir: string): void {
    const missing: string[] = [];
    let cursor = dir;
    while (!existsSync(cursor)) {
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    mkdirSync(dir, { recursive: true });
    if (this.failMkdirFsync) {
      this.failMkdirFsync = false;
      throw new DedupError('dedup_mkdir_fsync_failed', 'dedup_mkdir_fsync_failed');
    }
    for (const created of missing) {
      fsyncDirectory(created);
    }
    if (existsSync(cursor)) {
      fsyncDirectory(cursor);
    }
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
      renameSync(tmp, this.config.path);
      if (this.failDirFsync) {
        this.failDirFsync = false;
        throw new DedupError('dedup_dir_fsync_failed', 'dedup_dir_fsync_failed');
      }
      fsyncDirectory(parent);
    } catch (err) {
      if (err instanceof DedupError) throw err;
      throw new DedupError('storage_failed', 'dedup_write_failed');
    }
  }
}
