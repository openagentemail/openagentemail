/**
 * Persistent bounded dedup keyed by configured subscription + signed event id.
 * Capacity/storage failure fails closed and never evicts live records.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DedupConfig, DedupRecord } from './types.ts';

export class DedupError extends Error {
  code: 'storage_failed' | 'storage_capacity';
  constructor(code: 'storage_failed' | 'storage_capacity', message: string) {
    super(message);
    this.code = code;
  }
}

type StoreFile = {
  records: Record<string, DedupRecord>;
};

export function dedupKey(subscriptionId: string, eventId: string): string {
  return `${subscriptionId}:${eventId}`;
}

export class DedupStore {
  readonly config: DedupConfig;
  private chain: Promise<void> = Promise.resolve();
  private inflight = new Map<string, Promise<unknown>>();
  private failReads = false;
  private failWrites = false;
  private forceCapacity = false;

  constructor(config: DedupConfig) {
    this.config = config;
  }

  /** Test hook: next disk operation fails closed. */
  injectFailure(kind: 'read' | 'write' | 'capacity'): void {
    if (kind === 'read') this.failReads = true;
    if (kind === 'write') this.failWrites = true;
    if (kind === 'capacity') this.forceCapacity = true;
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
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object' || !parsed.records) {
        throw new DedupError('storage_failed', 'dedup_corrupt');
      }
      return parsed;
    } catch (err) {
      if (err instanceof DedupError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { records: {} };
      }
      throw new DedupError('storage_failed', 'dedup_read_failed');
    }
  }

  private writeFile(file: StoreFile): void {
    if (this.failWrites) {
      this.failWrites = false;
      throw new DedupError('storage_failed', 'dedup_write_failed');
    }
    try {
      mkdirSync(dirname(this.config.path), { recursive: true });
      const tmp = `${this.config.path}.tmp.${process.pid}`;
      const payload = JSON.stringify(file);
      writeFileSync(tmp, payload, { mode: 0o600 });
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.config.path);
    } catch (err) {
      if (err instanceof DedupError) throw err;
      throw new DedupError('storage_failed', 'dedup_write_failed');
    }
  }
}
