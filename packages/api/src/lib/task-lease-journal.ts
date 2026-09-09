/**
 * M2 pending-lease journal：保守证据，不是替换权威。
 *
 * 只存 fence / fate / 可重建审计身份，永不写明文 leaseToken。
 * 落盘：DATA_DIR/task-lease-journal/ (activated marker + journal.json + journal.seal)
 * 首次启用：专属目录排他性创建（exclusive mkdir），写入 marker + 空表 + seal。
 * 丢失/损坏：永久 fail-closed recovery_required，绝不自动重新初始化或旁路恢复。
 * 整段 read-modify-write（含 upsert 与 markFate）在 journal 范围串行，不按 task 分锁。
 * 未成功 persist 的变更不得进入 cache / fence 权威。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
  signedPayload?: string;
};

export type JournalFile = {
  version: 1;
  initializedAt: string;
  source: 'bootstrap' | 'init';
  firstTombstoneAt?: string;
  records: JournalRecord[];
};

export type ActivatedMarker = {
  version: 1;
  activatedAt: string;
  journalInitializedAt: string;
  nonce: string;
  mac: string;
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

let cache: JournalFile | null = null;
let loaded = false;
let previouslyLoaded = false;
let latchedError: JournalError | null = null;
let crashHook: JournalCrashHook | null = null;
let dataDirOverride: string | undefined;
let nowFn: () => number = () => Date.now();
let mutationQueue: Promise<void> = Promise.resolve();

function dataDir(): string {
  return dataDirOverride ?? config.dataDir;
}

export function journalDir(): string {
  return join(dataDir(), 'task-lease-journal');
}

export function markerPath(): string {
  return join(journalDir(), 'activated');
}

export function journalPath(): string {
  return join(journalDir(), 'journal.json');
}

export function sealPath(): string {
  return join(journalDir(), 'journal.seal');
}

function tmpJournalPath(): string {
  return `${journalPath()}.tmp`;
}

function tmpSealPath(): string {
  return `${sealPath()}.tmp`;
}

function nowIso(): string {
  return new Date(nowFn()).toISOString();
}

function enqueueJournal<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function cloneJournal(file: JournalFile): JournalFile {
  const cloned: JournalFile = {
    version: file.version,
    initializedAt: file.initializedAt,
    source: file.source,
    records: file.records.map((row) => ({ ...row })),
  };
  if (file.firstTombstoneAt !== undefined) cloned.firstTombstoneAt = file.firstTombstoneAt;
  return cloned;
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

function markerMac(version: number, activatedAt: string, journalInitializedAt: string, nonce: string): string {
  const canonical = `task-lease-journal-activated-v1\n${version}\n${activatedAt}\n${journalInitializedAt}\n${nonce}`;
  return createHmac('sha256', config.taskSigningSecret)
    .update(canonical)
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseMarker(raw: string): ActivatedMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalError('lease_journal_corrupt');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JournalError('lease_journal_corrupt');
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 5) throw new JournalError('lease_journal_corrupt');
  const allowed = ['version', 'activatedAt', 'journalInitializedAt', 'nonce', 'mac'];
  for (const k of allowed) {
    if (!keys.includes(k)) throw new JournalError('lease_journal_corrupt');
  }
  const val = parsed as Record<string, unknown>;
  if (val.version !== 1) throw new JournalError('lease_journal_corrupt');
  if (typeof val.activatedAt !== 'string' || !Number.isFinite(Date.parse(val.activatedAt))) {
    throw new JournalError('lease_journal_corrupt');
  }
  if (typeof val.journalInitializedAt !== 'string' || !Number.isFinite(Date.parse(val.journalInitializedAt))) {
    throw new JournalError('lease_journal_corrupt');
  }
  if (typeof val.nonce !== 'string' || !/^[0-9a-f]{64}$/i.test(val.nonce)) {
    throw new JournalError('lease_journal_corrupt');
  }
  if (typeof val.mac !== 'string' || !val.mac) {
    throw new JournalError('lease_journal_corrupt');
  }
  const expectedMac = markerMac(1, val.activatedAt, val.journalInitializedAt, val.nonce);
  if (!safeEqual(val.mac, expectedMac)) {
    throw new JournalError('lease_journal_corrupt');
  }
  return {
    version: 1,
    activatedAt: val.activatedAt,
    journalInitializedAt: val.journalInitializedAt,
    nonce: val.nonce,
    mac: val.mac,
  };
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
  if (value.version !== 1 || (value.source !== 'bootstrap' && value.source !== 'init')) {
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
  if (typeof value.signedPayload === 'string') rec.signedPayload = value.signedPayload;
  return rec;
}

function serialize(file: JournalFile): Buffer {
  return Buffer.from(JSON.stringify(file), 'utf8');
}

function writeSeal(body: Buffer): void {
  const seal = Buffer.from(`${sealBytes(body)}\n`, 'utf8');
  const path = sealPath();
  const tmp = tmpSealPath();
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
  if (latchedError) {
    throw latchedError;
  }
  compact(file);
  if (file.records.length > TASK_LEASE_JOURNAL_MAX_RECORDS) {
    throw new JournalError('lease_journal_capacity_exhausted');
  }
  const body = serialize(file);
  fireCrash('before-write');
  const tmp = tmpJournalPath();
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
  cache = cloneJournal(file);
  loaded = true;
}

function compact(file: JournalFile): void {
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

export function bootstrapTaskLeaseJournal(): JournalFile {
  if (latchedError) {
    throw latchedError;
  }
  const dir = journalDir();
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'EEXIST') {
      throw new JournalError('lease_journal_already_initialized');
    }
    throw err;
  }
  const initializedAt = nowIso();
  const file: JournalFile = {
    version: 1,
    initializedAt,
    source: 'bootstrap',
    records: [],
  };
  const body = serialize(file);
  const jPath = journalPath();
  const jFd = openSync(jPath, 'w', 0o600);
  try {
    writeSync(jFd, body);
    fsyncSync(jFd);
  } finally {
    closeSync(jFd);
  }
  writeSeal(body);
  const nonce = randomBytes(32).toString('hex');
  const mac = markerMac(1, initializedAt, initializedAt, nonce);
  const markerObj: ActivatedMarker = {
    version: 1,
    activatedAt: initializedAt,
    journalInitializedAt: initializedAt,
    nonce,
    mac,
  };
  const mPath = markerPath();
  const mFd = openSync(mPath, 'w', 0o600);
  try {
    writeSync(mFd, Buffer.from(JSON.stringify(markerObj), 'utf8'));
    fsyncSync(mFd);
  } finally {
    closeSync(mFd);
  }
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  cache = file;
  loaded = true;
  previouslyLoaded = true;
  return file;
}

function loadLeaseJournalUnlocked(): JournalFile {
  if (latchedError) {
    throw latchedError;
  }
  const dir = journalDir();
  const mPath = markerPath();
  const jPath = journalPath();
  const sPath = sealPath();

  try {
    if (!existsSync(dir)) {
      throw new JournalError(previouslyLoaded ? 'lease_journal_lost' : 'lease_journal_not_bootstrapped');
    }
    if (!existsSync(mPath)) {
      throw new JournalError(previouslyLoaded || existsSync(jPath) ? 'lease_journal_corrupt' : 'lease_journal_not_bootstrapped');
    }
    let markerRaw: string;
    try {
      markerRaw = readFileSync(mPath, 'utf8');
    } catch {
      throw new JournalError('lease_journal_corrupt');
    }
    const marker = parseMarker(markerRaw);

    if (!existsSync(jPath)) {
      throw new JournalError('lease_journal_lost');
    }
    if (!existsSync(sPath)) {
      throw new JournalError('lease_journal_corrupt');
    }

    let raw: string;
    try {
      raw = readFileSync(jPath, 'utf8');
    } catch {
      throw new JournalError('lease_journal_corrupt');
    }
    if (!raw.trim()) throw new JournalError('lease_journal_corrupt');

    const file = parseJournal(raw);
    if (file.initializedAt !== marker.journalInitializedAt) {
      throw new JournalError('lease_journal_corrupt');
    }

    const expectedSeal = readFileSync(sPath, 'utf8').trim();
    const actualSeal = sealBytes(Buffer.from(raw, 'utf8'));
    if (!safeEqual(expectedSeal, actualSeal)) {
      throw new JournalError('lease_journal_corrupt');
    }

    cache = cloneJournal(file);
    loaded = true;
    previouslyLoaded = true;
    return cache;
  } catch (err) {
    cache = null;
    loaded = false;
    if (err instanceof JournalError) {
      latchedError = err;
    }
    throw err;
  }
}

export async function loadLeaseJournal(): Promise<JournalFile> {
  return enqueueJournal(() => cloneJournal(loadLeaseJournalUnlocked()));
}

function recordKey(rec: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>): string {
  return `${rec.taskId}\n${rec.kind}\n${rec.generation}\n${rec.at}`;
}

export async function upsertJournalRecord(next: JournalRecord): Promise<JournalRecord> {
  return enqueueJournal(() => {
    if (latchedError) {
      throw latchedError;
    }
    const file = cloneJournal(loadLeaseJournalUnlocked());
    const idx = file.records.findIndex((row) => recordKey(row) === recordKey(next));
    if (idx >= 0) {
      file.records[idx] = { ...file.records[idx]!, ...next };
    } else {
      file.records.push({ ...next });
    }
    if (next.kind === 'tombstone' && next.fate === 'accepted' && !file.firstTombstoneAt) {
      file.firstTombstoneAt = next.at;
    }
    persist(file);
    return next;
  });
}

export async function markJournalFate(
  match: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>,
  fate: JournalFate,
  extra?: Partial<Pick<JournalRecord, 'supersededBy'>>,
): Promise<JournalRecord> {
  return enqueueJournal(() => {
    if (latchedError) {
      throw latchedError;
    }
    const file = cloneJournal(loadLeaseJournalUnlocked());
    const rec = file.records.find((row) => recordKey(row) === recordKey(match));
    if (!rec) throw new JournalError('lease_journal_record_missing');
    rec.fate = fate;
    if (extra?.supersededBy !== undefined) rec.supersededBy = extra.supersededBy;
    persist(file);
    return { ...rec };
  });
}

const OPEN_FATES: ReadonlySet<JournalFate> = new Set(['intent', 'unconfirmed', 'accepted']);

export function journalRecordsFor(taskId: string, file?: JournalFile): JournalRecord[] {
  if (!file && latchedError) {
    throw latchedError;
  }
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
  previouslyLoaded = false;
  latchedError = null;
  mutationQueue = Promise.resolve();
}

export function setJournalDataDirForTests(dir: string | undefined): void {
  dataDirOverride = dir;
  resetJournalMemoryForTests();
}

/** Legacy test seam stub retained for test compatibility; durable evidence cannot bypass fail-closed in R2. */
export function setJournalDurableEvidenceForTests(_fn: unknown): void {
  // No-op in R2: absence of journal/seal is always fail-closed.
}

export function setJournalNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function deleteJournalFilesForTests(opts?: { marker?: boolean; journal?: boolean; seal?: boolean; resetMemory?: boolean }): void {
  if (opts?.marker !== false && existsSync(markerPath())) unlinkSync(markerPath());
  if (opts?.journal !== false && existsSync(journalPath())) unlinkSync(journalPath());
  if (opts?.seal !== false && existsSync(sealPath())) unlinkSync(sealPath());
  if (existsSync(tmpJournalPath())) unlinkSync(tmpJournalPath());
  if (existsSync(tmpSealPath())) unlinkSync(tmpSealPath());
  if (opts?.resetMemory !== false) {
    resetJournalMemoryForTests();
  }
}

export function journalPathsForTests(): { marker: string; journal: string; seal: string; dir: string } {
  return { marker: markerPath(), journal: journalPath(), seal: sealPath(), dir: journalDir() };
}
