/**
 * M2 pending-lease journal：保守证据，不是替换权威。
 *
 * 只存 fence / fate / 可重建审计身份，永不写明文 leaseToken。
 * 落盘：DATA_DIR/task-lease-journal.json + .seal，tmp+write+fsync+rename+parent fsync。
 * 丢失文件不得伪装成首次初始化。
 */

import { createHmac } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';

export const TASK_LEASE_JOURNAL_MAX_RECORDS = 10_000;
export const TASK_LEASE_CLAIM_LOST_MS = 2 * 60 * 60 * 1000;

export type JournalKind = 'claim' | 'renew' | 'release' | 'expired' | 'tombstone';
export type JournalFate =
  | 'intent'
  | 'unconfirmed'
  | 'accepted'
  | 'rejected'
  | 'indexed'
  | 'tombstoned'
  | 'superseded';

export type JournalRecord = {
  taskId: string;
  kind: JournalKind;
  generation: number;
  actor: string;
  at: string;
  fate: JournalFate;
  claimedUntil?: string;
  tokenVerifier?: string;
  firstClaimedAt?: string;
  generationClaimedAt?: string;
  supersededBy?: number;
};

export type JournalFile = {
  version: 1;
  initializedAt: string;
  source: 'init' | 'recovery-ack';
  firstTombstoneAt?: string;
  records: JournalRecord[];
};

export type JournalCrashHook =
  | 'before-write'
  | 'after-write'
  | 'after-file-fsync'
  | 'after-rename'
  | 'after-parent-fsync'
  | 'short-write';

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

type DurableEvidenceFn = () => boolean | Promise<boolean>;

let cache: JournalFile | null = null;
let loaded = false;
let crashHook: JournalCrashHook | null = null;
let dataDirOverride: string | undefined;
let durableEvidenceFn: DurableEvidenceFn | null = null;
let nowFn: () => number = () => Date.now();

function dataDir(): string {
  return dataDirOverride ?? config.dataDir;
}

function journalPath(): string {
  return join(dataDir(), 'task-lease-journal.json');
}

function sealPath(): string {
  return join(dataDir(), 'task-lease-journal.seal');
}

function tmpPath(): string {
  return `${journalPath()}.tmp`;
}

function nowIso(): string {
  return new Date(nowFn()).toISOString();
}

function fireCrash(hook: JournalCrashHook): void {
  if (crashHook === hook) {
    const hit = crashHook;
    crashHook = null;
    throw new JournalError(`lease_journal_crash_${hit.replace(/-/g, '_')}`);
  }
}

function sealBytes(body: Buffer): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update('task-lease-journal-seal-v1\n')
    .update(body)
    .digest('base64url');
}

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

function parseJournal(raw: string): JournalFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalError('lease_journal_corrupt');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JournalError('lease_journal_corrupt');
  }
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || (value.source !== 'init' && value.source !== 'recovery-ack')) {
    throw new JournalError('lease_journal_corrupt');
  }
  if (typeof value.initializedAt !== 'string' || !Number.isFinite(Date.parse(value.initializedAt))) {
    throw new JournalError('lease_journal_corrupt');
  }
  if (!Array.isArray(value.records)) throw new JournalError('lease_journal_corrupt');
  const records: JournalRecord[] = [];
  for (const row of value.records) {
    const rec = parseRecord(row);
    if (!rec) throw new JournalError('lease_journal_corrupt');
    records.push(rec);
  }
  const file: JournalFile = {
    version: 1,
    initializedAt: value.initializedAt,
    source: value.source,
    records,
  };
  if (typeof value.firstTombstoneAt === 'string') file.firstTombstoneAt = value.firstTombstoneAt;
  return file;
}

function parseRecord(row: unknown): JournalRecord | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  const kinds: JournalKind[] = ['claim', 'renew', 'release', 'expired', 'tombstone'];
  const fates: JournalFate[] = [
    'intent', 'unconfirmed', 'accepted', 'rejected', 'indexed', 'tombstoned', 'superseded',
  ];
  if (
    typeof value.taskId !== 'string' || !value.taskId
    || typeof value.kind !== 'string' || !kinds.includes(value.kind as JournalKind)
    || typeof value.generation !== 'number' || !Number.isInteger(value.generation) || value.generation < 1
    || typeof value.actor !== 'string' || !value.actor
    || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
    || typeof value.fate !== 'string' || !fates.includes(value.fate as JournalFate)
  ) return null;
  if (typeof value.tokenVerifier === 'string' && value.tokenVerifier.length < 32) return null;
  const rec: JournalRecord = {
    taskId: value.taskId,
    kind: value.kind as JournalKind,
    generation: value.generation,
    actor: value.actor,
    at: value.at,
    fate: value.fate as JournalFate,
  };
  if (typeof value.claimedUntil === 'string') rec.claimedUntil = value.claimedUntil;
  if (typeof value.tokenVerifier === 'string') rec.tokenVerifier = value.tokenVerifier;
  if (typeof value.firstClaimedAt === 'string') rec.firstClaimedAt = value.firstClaimedAt;
  if (typeof value.generationClaimedAt === 'string') rec.generationClaimedAt = value.generationClaimedAt;
  if (typeof value.supersededBy === 'number') rec.supersededBy = value.supersededBy;
  return rec;
}

function serialize(file: JournalFile): Buffer {
  return Buffer.from(JSON.stringify(file), 'utf8');
}

function writeSeal(body: Buffer): void {
  const seal = Buffer.from(`${sealBytes(body)}\n`, 'utf8');
  const path = sealPath();
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, seal);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function persist(file: JournalFile): void {
  compact(file);
  if (file.records.length > TASK_LEASE_JOURNAL_MAX_RECORDS) {
    throw new JournalError('lease_journal_capacity_exhausted');
  }
  ensureDir();
  const body = serialize(file);
  fireCrash('before-write');
  const tmp = tmpPath();
  const fd = openSync(tmp, 'w', 0o600);
  try {
    if (crashHook === 'short-write') {
      crashHook = null;
      writeSync(fd, body.subarray(0, Math.max(1, Math.floor(body.length / 3))));
      throw new JournalError('lease_journal_crash_short_write');
    }
    writeSync(fd, body);
    fireCrash('after-write');
    fsyncSync(fd);
    fireCrash('after-file-fsync');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, journalPath());
  fireCrash('after-rename');
  const dirFd = openSync(dirname(journalPath()), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  fireCrash('after-parent-fsync');
  writeSeal(body);
  cache = file;
  loaded = true;
}

function compact(file: JournalFile): void {
  // 只丢已退休且被后代支配的 accepted/indexed/rejected；tombstone 与未决 fence 永不丢。
  const keep: JournalRecord[] = [];
  const maxGen = new Map<string, number>();
  for (const rec of file.records) {
    maxGen.set(rec.taskId, Math.max(maxGen.get(rec.taskId) ?? 0, rec.generation));
  }
  for (const rec of file.records) {
    const dominated = rec.generation < (maxGen.get(rec.taskId) ?? 0);
    const retired = rec.fate === 'indexed' || rec.fate === 'rejected' || rec.fate === 'superseded';
    if (dominated && retired && rec.kind !== 'tombstone') continue;
    keep.push(rec);
  }
  file.records = keep;
}

function emptyJournal(source: JournalFile['source']): JournalFile {
  return { version: 1, initializedAt: nowIso(), source, records: [] };
}

async function decideMissingBoth(): Promise<JournalFile> {
  const evidence = durableEvidenceFn ? await durableEvidenceFn() : false;
  if (evidence) throw new JournalError('lease_journal_recovery_required');
  return emptyJournal('init');
}

export async function loadLeaseJournal(): Promise<JournalFile> {
  if (loaded && cache) return cache;
  const path = journalPath();
  const seal = sealPath();
  const hasJournal = existsSync(path);
  const hasSeal = existsSync(seal);
  if (!hasJournal && hasSeal) throw new JournalError('lease_journal_lost');
  if (!hasJournal && !hasSeal) {
    const created = await decideMissingBoth();
    persist(created);
    return created;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new JournalError('lease_journal_corrupt');
  }
  if (!raw.trim()) throw new JournalError('lease_journal_corrupt');
  const file = parseJournal(raw);
  const body = Buffer.from(raw, 'utf8');
  if (hasSeal) {
    const expected = readFileSync(seal, 'utf8').trim();
    if (expected !== sealBytes(body)) throw new JournalError('lease_journal_corrupt');
  } else {
    // rename 成功但 seal 未写出：补 seal，不把损坏当空表。
    writeSeal(body);
  }
  cache = file;
  loaded = true;
  return file;
}

export async function acknowledgeJournalRecovery(): Promise<JournalFile> {
  const created = emptyJournal('recovery-ack');
  persist(created);
  return created;
}

function recordKey(rec: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>): string {
  return `${rec.taskId}\n${rec.kind}\n${rec.generation}\n${rec.at}`;
}

export async function upsertJournalRecord(next: JournalRecord): Promise<JournalRecord> {
  const file = await loadLeaseJournal();
  const idx = file.records.findIndex((row) => recordKey(row) === recordKey(next));
  if (idx >= 0) {
    file.records[idx] = { ...file.records[idx]!, ...next };
  } else {
    file.records.push(next);
  }
  if (next.kind === 'tombstone' && next.fate === 'accepted' && !file.firstTombstoneAt) {
    file.firstTombstoneAt = next.at;
  }
  persist(file);
  return next;
}

export async function markJournalFate(
  match: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>,
  fate: JournalFate,
  extra?: Partial<Pick<JournalRecord, 'supersededBy'>>,
): Promise<JournalRecord> {
  const file = await loadLeaseJournal();
  const rec = file.records.find((row) => recordKey(row) === recordKey(match));
  if (!rec) throw new JournalError('lease_journal_record_missing');
  rec.fate = fate;
  if (extra?.supersededBy !== undefined) rec.supersededBy = extra.supersededBy;
  persist(file);
  return rec;
}

const OPEN_FATES: ReadonlySet<JournalFate> = new Set(['intent', 'unconfirmed', 'accepted']);

export function journalRecordsFor(taskId: string, file?: JournalFile): JournalRecord[] {
  const rows = file?.records ?? cache?.records ?? [];
  return rows.filter((row) => row.taskId === taskId);
}

export function unresolvedClaimFence(taskId: string, file?: JournalFile): JournalRecord | undefined {
  return journalRecordsFor(taskId, file).find((row) =>
    row.kind === 'claim' && OPEN_FATES.has(row.fate),
  );
}

export function unresolvedMutationFence(taskId: string, file?: JournalFile): JournalRecord | undefined {
  return journalRecordsFor(taskId, file).find((row) =>
    (row.kind === 'claim' || row.kind === 'renew' || row.kind === 'release' || row.kind === 'tombstone')
    && OPEN_FATES.has(row.fate),
  );
}

export function maxJournalGeneration(taskId: string, file?: JournalFile): number {
  let max = 0;
  for (const row of journalRecordsFor(taskId, file)) {
    if (row.fate === 'rejected') continue;
    if (row.generation > max) max = row.generation;
  }
  return max;
}

export function journalSuppressesExpiry(
  taskId: string,
  generation: number,
  claimedUntil: string,
  file?: JournalFile,
): boolean {
  return journalRecordsFor(taskId, file).some((row) => {
    if (row.generation !== generation) return false;
    if (row.kind === 'renew' || row.kind === 'release' || row.kind === 'claim' || row.kind === 'tombstone') {
      if (OPEN_FATES.has(row.fate) || row.fate === 'indexed' || row.fate === 'tombstoned' || row.fate === 'superseded') {
        if (row.kind === 'renew' && row.claimedUntil && row.claimedUntil !== claimedUntil) return true;
        if (row.kind !== 'renew') return true;
        return true;
      }
    }
    if (row.kind === 'expired' && OPEN_FATES.has(row.fate) && row.claimedUntil === claimedUntil) return true;
    return false;
  });
}

export function firstTombstoneAt(file?: JournalFile): string | undefined {
  return file?.firstTombstoneAt ?? cache?.firstTombstoneAt;
}

export function listOpenExpiryCandidates(file?: JournalFile): JournalRecord[] {
  const rows = file?.records ?? cache?.records ?? [];
  return rows.filter((row) => row.kind === 'expired' && OPEN_FATES.has(row.fate));
}

export function listHydrationRecords(taskId: string, file?: JournalFile): JournalRecord[] {
  return journalRecordsFor(taskId, file).filter((row) =>
    OPEN_FATES.has(row.fate) || row.kind === 'tombstone',
  );
}

export function setJournalCrashHookForTests(hook: JournalCrashHook | null): void {
  crashHook = hook;
}

export function resetJournalMemoryForTests(): void {
  cache = null;
  loaded = false;
}

export function setJournalDataDirForTests(dir: string | undefined): void {
  dataDirOverride = dir;
  resetJournalMemoryForTests();
}

export function setJournalDurableEvidenceForTests(fn: DurableEvidenceFn | null): void {
  durableEvidenceFn = fn;
}

export function setJournalNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function deleteJournalFilesForTests(opts?: { journal?: boolean; seal?: boolean }): void {
  if (opts?.journal !== false && existsSync(journalPath())) unlinkSync(journalPath());
  if (opts?.seal !== false && existsSync(sealPath())) unlinkSync(sealPath());
  if (existsSync(tmpPath())) unlinkSync(tmpPath());
  resetJournalMemoryForTests();
}

export function journalPathsForTests(): { journal: string; seal: string } {
  return { journal: journalPath(), seal: sealPath() };
}
