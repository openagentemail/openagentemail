/**
 * 服务端可信出站登记（Sent 判定用）。
 *
 * 条目是 (Message-ID, From)：只有本进程真正发出的那对才算数。
 * 伪造信即使抄了真实出站 Message-ID，只要信封 From 对不上登记的 from，
 * 就不进任何人的 Sent，也不能凭 From 跨身份读详情 / Source / Seen。
 *
 * 落盘照抄 ui-sessions.json：DATA_DIR/sent-registry.json、tmp+rename、0600、
 * 目录 0700、单写者。损坏 fail-closed（抛错，不装空库冒充成功）。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

/** FIFO 上限：超出则淘汰最旧记录。 */
export const SENT_REGISTRY_MAX_ENTRIES = 20_000;

export type SentRegistryEntry = {
  id: string;
  /** 出站时的 From（小写邮箱），Sent 判定必须与信封 From 同时命中。 */
  from: string;
  recordedAt: number;
};

type PersistedStore = {
  version: 1;
  entries: SentRegistryEntry[];
};

let loaded = false;
let entries: SentRegistryEntry[] = [];
const pairSet = new Set<string>();
let testMaxEntries: number | undefined;
let testTtlMs: number | undefined;

function storePath(): string {
  return join(config.dataDir, 'sent-registry.json');
}

function maxEntries(): number {
  return testMaxEntries ?? SENT_REGISTRY_MAX_ENTRIES;
}

function ttlMs(): number | null {
  if (testTtlMs !== undefined) return testTtlMs;
  if (config.retentionDays <= 0) return null;
  return config.retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * 规约 Message-ID：去空白、剥一层尖括号、小写。
 * 空串视为缺失（fail-closed，不能当 Sent）。
 */
export function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^</, '').replace(/>$/, '').trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function pairKey(id: string, from: string): string {
  return `${id}\n${from}`;
}

function normalizeFrom(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const addr = raw.trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

function isEntry(value: unknown): value is SentRegistryEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.from === 'string' &&
    row.from.length > 0 &&
    typeof row.recordedAt === 'number'
  );
}

function isPersistedStore(value: unknown): value is PersistedStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && Array.isArray(row.entries) && row.entries.every(isEntry);
}

function rebuildIndex(): void {
  pairSet.clear();
  for (const row of entries) pairSet.add(pairKey(row.id, row.from));
}

function prune(now: number): boolean {
  const ttl = ttlMs();
  const cap = maxEntries();
  const before = entries.length;
  if (ttl !== null) {
    entries = entries.filter((row) => now - row.recordedAt <= ttl);
  }
  if (entries.length > cap) {
    entries = entries.slice(entries.length - cap);
  }
  if (entries.length !== before) rebuildIndex();
  return entries.length !== before;
}

function loadFromDisk(): void {
  if (loaded) return;
  const path = storePath();
  if (!existsSync(path)) {
    entries = [];
    pairSet.clear();
    loaded = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('sent_registry_corrupt');
  }
  if (!isPersistedStore(parsed)) {
    throw new Error('sent_registry_corrupt');
  }
  entries = parsed.entries.map((row) => ({
    id: row.id,
    from: row.from,
    recordedAt: row.recordedAt,
  }));
  rebuildIndex();
  loaded = true;
  if (prune(Date.now())) persist();
}

function persist(): void {
  const path = storePath();
  const data: PersistedStore = { version: 1, entries };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // bind mount 可能属主不同；文件 mode 仍会设置
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  try {
    if (existsSync(path) && (statSync(path).mode & 0o777) !== 0o600) {
      chmodSync(path, 0o600);
    }
  } catch {
    // best effort
  }
}

/** 出站成功后登记 (message-id, from)。同一对重复忽略（不刷新时间）。 */
export function recordSentMessageId(rawId: string, from: string, now = Date.now()): void {
  const id = normalizeMessageId(rawId);
  const addr = normalizeFrom(from);
  if (!id || !addr) return;
  loadFromDisk();
  const key = pairKey(id, addr);
  if (pairSet.has(key)) return;
  prune(now);
  entries.push({ id, from: addr, recordedAt: now });
  pairSet.add(key);
  if (entries.length > maxEntries()) {
    const evicted = entries.shift();
    if (evicted) pairSet.delete(pairKey(evicted.id, evicted.from));
  }
  persist();
}

export function hasSentMessageId(
  rawId: string | undefined | null,
  from: string | undefined | null,
): boolean {
  const id = normalizeMessageId(rawId);
  const addr = normalizeFrom(from);
  if (!id || !addr) return false;
  loadFromDisk();
  const key = pairKey(id, addr);
  if (!pairSet.has(key)) return false;
  const ttl = ttlMs();
  if (ttl === null) return true;
  const row = entries.find((item) => item.id === id && item.from === addr);
  if (!row) return false;
  if (Date.now() - row.recordedAt > ttl) {
    prune(Date.now());
    persist();
    return false;
  }
  return true;
}

/** 测试辅助：清空内存（可改 FIFO/TTL），不读盘。 */
export function resetSentRegistryForTests(opts?: {
  maxEntries?: number;
  ttlMs?: number;
}): void {
  loaded = true;
  entries = [];
  pairSet.clear();
  testMaxEntries = opts?.maxEntries;
  testTtlMs = opts?.ttlMs;
}

/** 测试辅助：丢掉内存，下次 has/record 从盘重载。 */
export function reloadSentRegistryFromDiskForTests(): void {
  loaded = false;
  entries = [];
  pairSet.clear();
}

/** 测试辅助：当前条数。 */
export function sentRegistrySizeForTests(): number {
  loadFromDisk();
  return entries.length;
}
