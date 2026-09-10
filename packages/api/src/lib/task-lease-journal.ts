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

import { AsyncLocalStorage } from 'node:async_hooks';
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
/** Per top-level mutation: one durable evidence query, 5s wall deadline. */
export const JOURNAL_EXIT_QUERY_BUDGET = 1;
export const JOURNAL_EXIT_EVIDENCE_DEADLINE_MS = 5_000;

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
  reason?: string;
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

export type JournalExitTombstone = {
  generation: number;
  at: string;
};

/** Durable IMAP reconstruction for whole-task exit. Never hydrated journal overlay. */
export type JournalExitEvidence = {
  hadMatchingRows: boolean;
  reconstructed: boolean;
  state?: string;
  leaseGeneration: number;
  releasedGeneration: number;
  expiredGeneration: number;
  lostGeneration: number;
  tombstones: JournalExitTombstone[];
  firstClaimedAt?: string;
};

export type JournalExitEvidenceLookup = (
  taskId: string,
  opts: { signal: AbortSignal },
) => Promise<JournalExitEvidence>;

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
let exitCursorTaskId = '';
let evidenceQueryCount = 0;
let beforeExitCommitForTests: (() => void | Promise<void>) | null = null;
type ExitMaintenanceContext = {
  queryBudgetRemaining: number;
  deadlineAt: number;
  abort: AbortController;
  attempt: number;
  /** List hydration only: post-publication / seal uncertainty from optional exit must 503. */
  propagatePublishedPairFailure: boolean;
};
const exitMaintenance = new AsyncLocalStorage<ExitMaintenanceContext>();
let productionExitLookup: JournalExitEvidenceLookup | null = null;
let testExitLookup: JournalExitEvidenceLookup | null = null;
/** Test IO seam: production always fsyncs. Tests may disable to exercise the 10000 cap. */
let persistFsync = true;
let persistCount = 0;
let beforeBatchCommitForTests: (() => void) | null = null;
let beforeListSelectionForTests: (() => void | Promise<void>) | null = null;
const OPEN_FATES: ReadonlySet<JournalFate> = new Set(['intent', 'unconfirmed', 'accepted']);
const RETIRED_FATES: ReadonlySet<JournalFate> = new Set(['indexed', 'rejected', 'superseded', 'tombstoned']);

function dataDir(): string {
  return dataDirOverride ?? config.dataDir;
}

export function journalDir(): string {
  return join(dataDir(), 'task-lease-journal');
}

/** Durably commit a newly created directory entry in the parent DATA_DIR.
 * Child file and journal-directory fsyncs do not cover the parent's entry.
 * Failures propagate to the caller; the descriptor is always closed. */
function fsyncParentDataDir(): void {
  const parentFd = openSync(dataDir(), 'r');
  try {
    fsyncSync(parentFd);
  } finally {
    closeSync(parentFd);
  }
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
  if (typeof value.reason === 'string') rec.reason = value.reason;
  return rec;
}

function serialize(file: JournalFile): Buffer {
  return Buffer.from(JSON.stringify(file), 'utf8');
}

/** POSIX write(2) may return a short count. Loop until the full buffer is on disk; n<=0 fails before rename. */
let writeChunkForTests: number | null = null;

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const slice = writeChunkForTests != null
      ? buf.subarray(offset, offset + Math.min(writeChunkForTests, buf.length - offset))
      : buf.subarray(offset);
    const n = writeSync(fd, slice);
    if (n <= 0) throw new JournalError('lease_journal_short_write');
    offset += n;
  }
}

export function setJournalWriteChunkForTests(bytes: number | null): void {
  writeChunkForTests = bytes;
}

function writeSeal(body: Buffer): void {
  const seal = Buffer.from(`${sealBytes(body)}\n`, 'utf8');
  const path = sealPath();
  const tmp = tmpSealPath();
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeAllSync(fd, seal);
    if (persistFsync) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (persistFsync) {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
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
    writeAllSync(fd, body);
    fireCrash('after-write');
    if (persistFsync) fsyncSync(fd);
    fireCrash('after-file-fsync');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, journalPath());
  fireCrash('after-rename');
  if (persistFsync) {
    const dirFd = openSync(dirname(journalPath()), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
  fireCrash('after-parent-fsync');
  writeSeal(body);
  cache = cloneJournal(file);
  loaded = true;
  persistCount += 1;
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
    writeAllSync(jFd, body);
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
    writeAllSync(mFd, Buffer.from(JSON.stringify(markerObj), 'utf8'));
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
  // Commit the new journal directory's name entry in DATA_DIR before
  // publishing success. On failure nothing is published in memory and the
  // files on disk are left for explicit operator handling.
  fsyncParentDataDir();
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

    let expectedSeal: string;
    try {
      expectedSeal = readFileSync(sPath, 'utf8').trim();
    } catch {
      throw new JournalError('lease_journal_corrupt');
    }
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

function countOpenForTask(file: JournalFile, taskId: string): number {
  let n = 0;
  for (const row of file.records) {
    if (row.taskId === taskId && OPEN_FATES.has(row.fate)) n += 1;
  }
  return n;
}

function occupancyOf(file: JournalFile): number {
  return file.records.length;
}

function isCapacityError(err: unknown): boolean {
  return err instanceof JournalError && err.message === 'lease_journal_capacity_exhausted';
}

function isAvailabilityJournalError(err: unknown): boolean {
  return err instanceof JournalError && (
    err.message === 'lease_journal_lost'
    || err.message === 'lease_journal_corrupt'
    || err.message === 'lease_journal_not_bootstrapped'
  );
}

function snapshotPublishedPair(): { journal: Buffer; seal: string } | null {
  try {
    const jPath = journalPath();
    const sPath = sealPath();
    if (!existsSync(jPath) || !existsSync(sPath)) return null;
    const journal = readFileSync(jPath);
    const seal = readFileSync(sPath, 'utf8').trim();
    if (!safeEqual(sealBytes(journal), seal)) return null;
    return { journal, seal };
  } catch {
    return null;
  }
}

function publishedPairUnchanged(before: { journal: Buffer; seal: string } | null): boolean {
  if (!before) return false;
  try {
    const jPath = journalPath();
    const sPath = sealPath();
    if (!existsSync(jPath) || !existsSync(sPath)) return false;
    const journal = readFileSync(jPath);
    const seal = readFileSync(sPath, 'utf8').trim();
    if (journal.length !== before.journal.length || !journal.equals(before.journal)) return false;
    if (!safeEqual(seal, before.seal)) return false;
    if (!safeEqual(sealBytes(journal), seal)) return false;
    return true;
  } catch {
    return false;
  }
}

function unavailableAfterUncertainPersist(err: unknown): JournalError {
  const unavailable = isAvailabilityJournalError(err)
    ? err as JournalError
    : new JournalError('lease_journal_corrupt');
  // Publication outcome is uncertain: no cached state may serve as authority.
  latchedError ??= unavailable;
  cache = null;
  loaded = false;
  return unavailable;
}

function logExitMaintenance(code: string, extra: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({
    src: 'task-lease-journal',
    event: 'exit_maintenance',
    code,
    ...extra,
  }));
}

function canonicalTaskSnapshot(file: JournalFile, taskId: string): string {
  const rows = file.records
    .filter((row) => row.taskId === taskId)
    .slice()
    .sort((a, b) => recordKey(a).localeCompare(recordKey(b)))
    .map((row) => ({
      taskId: row.taskId,
      kind: row.kind,
      generation: row.generation,
      actor: row.actor,
      at: row.at,
      fate: row.fate,
      claimedUntil: row.claimedUntil ?? null,
      tokenVerifier: row.tokenVerifier ?? null,
      firstClaimedAt: row.firstClaimedAt ?? null,
      generationClaimedAt: row.generationClaimedAt ?? null,
      supersededBy: row.supersededBy ?? null,
      signedPayload: row.signedPayload ?? null,
      reason: row.reason ?? null,
    }));
  return JSON.stringify(rows);
}

function zeroOpenTaskIds(file: JournalFile): string[] {
  const open = new Set<string>();
  const all = new Set<string>();
  for (const row of file.records) {
    all.add(row.taskId);
    if (OPEN_FATES.has(row.fate)) open.add(row.taskId);
  }
  return [...all].filter((id) => !open.has(id)).sort();
}

function pickZeroOpenCandidate(ids: string[], preferred: string | undefined, cursor: string): string | undefined {
  if (preferred && ids.includes(preferred)) return preferred;
  if (ids.length === 0) return undefined;
  return ids.find((id) => id > cursor) ?? ids[0];
}

function maxGenerationFromRows(rows: JournalRecord[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.fate === 'rejected') continue;
    if (row.generation > max) max = row.generation;
  }
  return max;
}

function canExitTask(file: JournalFile, taskId: string, evidence: JournalExitEvidence): boolean {
  const rows = file.records.filter((row) => row.taskId === taskId);
  if (rows.length === 0) return false;
  if (rows.some((row) => OPEN_FATES.has(row.fate))) return false;
  if (rows.some((row) => !RETIRED_FATES.has(row.fate))) return false;
  if (!evidence.hadMatchingRows || !evidence.reconstructed) return false;
  const journalGen = maxGenerationFromRows(rows);
  const durableGen = Math.max(
    evidence.leaseGeneration,
    evidence.releasedGeneration,
    evidence.expiredGeneration,
    evidence.lostGeneration,
  );
  if (durableGen < journalGen) return false;
  for (const row of rows) {
    if (row.kind !== 'tombstone') continue;
    const sameIdentity = evidence.tombstones.some((stone) =>
      stone.generation === row.generation && stone.at === row.at,
    );
    if (sameIdentity) continue;
    if (durableGen > row.generation) continue;
    return false;
  }
  const journalFirst = rows.map((row) => row.firstClaimedAt).find((value) => typeof value === 'string');
  if (journalFirst && evidence.firstClaimedAt !== journalFirst) {
    return false;
  }
  return true;
}

function persistGuardingPublishedPair(file: JournalFile): 'ok' | 'prepublish' {
  const published = snapshotPublishedPair();
  try {
    persist(file);
    return 'ok';
  } catch (err) {
    if (isAvailabilityJournalError(err)) throw err;
    if (publishedPairUnchanged(published)) return 'prepublish';
    throw unavailableAfterUncertainPersist(err);
  }
}

function exitTaskRows(file: JournalFile, taskId: string): void {
  file.records = file.records.filter((row) => row.taskId !== taskId);
  persistGuardingPublishedPair(file);
}

type MutationMeta<T> = {
  value: T;
  occupancy: number;
  lastOpenTaskId?: string;
};

function upsertBody(next: JournalRecord): MutationMeta<JournalRecord> {
  if (latchedError) throw latchedError;
  const file = cloneJournal(loadLeaseJournalUnlocked());
  const openBefore = countOpenForTask(file, next.taskId);
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
  const live = cache ?? file;
  const openAfter = countOpenForTask(live, next.taskId);
  return {
    value: next,
    occupancy: occupancyOf(live),
    lastOpenTaskId: openBefore > 0 && openAfter === 0 ? next.taskId : undefined,
  };
}

function markFateBody(
  match: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>,
  fate: JournalFate,
  extra?: Partial<Pick<JournalRecord, 'supersededBy'>>,
): MutationMeta<JournalRecord> {
  if (latchedError) throw latchedError;
  const file = cloneJournal(loadLeaseJournalUnlocked());
  const openBefore = countOpenForTask(file, match.taskId);
  const rec = file.records.find((row) => recordKey(row) === recordKey(match));
  if (!rec) throw new JournalError('lease_journal_record_missing');
  rec.fate = fate;
  if (extra?.supersededBy !== undefined) rec.supersededBy = extra.supersededBy;
  persist(file);
  const live = cache ?? file;
  const openAfter = countOpenForTask(live, match.taskId);
  return {
    value: { ...rec },
    occupancy: occupancyOf(live),
    lastOpenTaskId: openBefore > 0 && openAfter === 0 ? match.taskId : undefined,
  };
}

function activeExitLookup(): JournalExitEvidenceLookup | null {
  return testExitLookup ?? productionExitLookup;
}

async function fetchExitEvidence(taskId: string, remainingMs: number, signal: AbortSignal): Promise<JournalExitEvidence> {
  const lookup = activeExitLookup();
  if (!lookup) {
    return {
      hadMatchingRows: false,
      reconstructed: false,
      leaseGeneration: 0,
      releasedGeneration: 0,
      expiredGeneration: 0,
      lostGeneration: 0,
      tombstones: [],
    };
  }
  evidenceQueryCount += 1;
  const local = new AbortController();
  const onAbort = () => local.abort();
  signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => local.abort(), Math.max(0, remainingMs));
  const attempt = exitMaintenance.getStore()?.attempt ?? 0;
  try {
    const evidence = await Promise.race([
      lookup(taskId, { signal: local.signal }),
      new Promise<never>((_, reject) => {
        const fail = () => reject(new JournalError('lease_journal_exit_evidence_timeout'));
        if (local.signal.aborted) fail();
        else local.signal.addEventListener('abort', fail, { once: true });
      }),
    ]);
    if (local.signal.aborted || attempt !== (exitMaintenance.getStore()?.attempt ?? 0)) {
      throw new JournalError('lease_journal_exit_evidence_timeout');
    }
    return evidence;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function deadlineExpired(ctx: ExitMaintenanceContext): boolean {
  return ctx.abort.signal.aborted || Date.now() >= ctx.deadlineAt;
}

async function reconcileZeroOpenExits(preferredTaskId: string | undefined): Promise<void> {
  const ctx = exitMaintenance.getStore();
  if (!ctx || ctx.queryBudgetRemaining <= 0) return;
  const lookup = activeExitLookup();
  if (!lookup && !testExitLookup) return;
  if (deadlineExpired(ctx)) return;
  const picked = await enqueueJournal(() => {
    const file = loadLeaseJournalUnlocked();
    const ids = zeroOpenTaskIds(file);
    const id = pickZeroOpenCandidate(ids, preferredTaskId, exitCursorTaskId);
    if (!id) return null;
    exitCursorTaskId = id;
    return { id, snapshot: canonicalTaskSnapshot(file, id) };
  });
  if (!picked) return;
  ctx.queryBudgetRemaining -= 1;
  ctx.attempt += 1;
  const attempt = ctx.attempt;
  try {
    const evidence = await fetchExitEvidence(
      picked.id,
      Math.max(0, ctx.deadlineAt - Date.now()),
      ctx.abort.signal,
    );
    if (attempt !== ctx.attempt || deadlineExpired(ctx)) {
      return;
    }
    await enqueueJournal(async () => {
      if (beforeExitCommitForTests) await beforeExitCommitForTests();
      if (deadlineExpired(ctx) || attempt !== ctx.attempt) return;
      const file = loadLeaseJournalUnlocked();
      if (canonicalTaskSnapshot(file, picked.id) !== picked.snapshot) return;
      if (!canExitTask(file, picked.id, evidence)) return;
      if (deadlineExpired(ctx) || attempt !== ctx.attempt) return;
      const next = cloneJournal(file);
      exitTaskRows(next, picked.id);
    });
  } catch (err) {
    logExitMaintenance(err instanceof JournalError ? err.message : 'exit_evidence_failed', { taskId: picked.id });
    throw err;
  }
}

function rethrowListHydrationPublishedPairFailure(ctx: ExitMaintenanceContext, err: unknown): void {
  if (ctx.propagatePublishedPairFailure && isAvailabilityJournalError(err)) throw err;
}

async function runTopLevelMutation<T>(
  op: () => MutationMeta<T>,
  opts?: { propagatePublishedPairFailure?: boolean },
): Promise<T> {
  const ctx: ExitMaintenanceContext = {
    queryBudgetRemaining: JOURNAL_EXIT_QUERY_BUDGET,
    deadlineAt: Date.now() + JOURNAL_EXIT_EVIDENCE_DEADLINE_MS,
    abort: new AbortController(),
    attempt: 0,
    propagatePublishedPairFailure: opts?.propagatePublishedPairFailure === true,
  };
  return exitMaintenance.run(ctx, async () => {
    try {
      let meta: MutationMeta<T>;
      try {
        meta = await enqueueJournal(op);
      } catch (err) {
        if (!isCapacityError(err)) throw err;
        try {
          await reconcileZeroOpenExits(undefined);
        } catch (maint) {
          logExitMaintenance(maint instanceof Error ? maint.message : 'exit_maintenance_failed');
          rethrowListHydrationPublishedPairFailure(ctx, maint);
        }
        return (await enqueueJournal(op)).value;
      }
      if (
        ctx.queryBudgetRemaining > 0
        && (meta.occupancy >= TASK_LEASE_JOURNAL_MAX_RECORDS || meta.lastOpenTaskId)
      ) {
        try {
          await reconcileZeroOpenExits(meta.lastOpenTaskId);
        } catch (maint) {
          logExitMaintenance(maint instanceof Error ? maint.message : 'exit_maintenance_failed', {
            taskId: meta.lastOpenTaskId,
          });
          rethrowListHydrationPublishedPairFailure(ctx, maint);
        }
      }
      return meta.value;
    } finally {
      ctx.abort.abort();
    }
  });
}

async function withExitMaintenance<T>(
  op: () => MutationMeta<T>,
  opts?: { propagatePublishedPairFailure?: boolean },
): Promise<T> {
  if (exitMaintenance.getStore()) {
    return (await enqueueJournal(op)).value;
  }
  return runTopLevelMutation(op, opts);
}

export function setJournalExitEvidenceLookup(fn: JournalExitEvidenceLookup | null): void {
  productionExitLookup = fn;
}

export function setJournalExitEvidenceForTests(fn: JournalExitEvidenceLookup | null): void {
  testExitLookup = fn;
}

/** Disclosed test IO seam: skip fsync while still using production cap/rename/seal. */
export function setJournalPersistFsyncForTests(on: boolean): void {
  persistFsync = on;
}

export function journalExitEvidenceQueryCountForTests(): number {
  return evidenceQueryCount;
}

export function journalExitCursorForTests(): string {
  return exitCursorTaskId;
}

export function journalOccupancyForTests(): number {
  return cache?.records.length ?? 0;
}

export function journalMaintenanceDepthForTests(): number {
  return exitMaintenance.getStore() ? 1 : 0;
}

export function setJournalBeforeExitCommitForTests(fn: (() => void | Promise<void>) | null): void {
  beforeExitCommitForTests = fn;
}

export async function upsertJournalRecord(next: JournalRecord): Promise<JournalRecord> {
  return withExitMaintenance(() => upsertBody(next));
}

export async function markJournalFate(
  match: Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>,
  fate: JournalFate,
  extra?: Partial<Pick<JournalRecord, 'supersededBy'>>,
): Promise<JournalRecord> {
  return withExitMaintenance(() => markFateBody(match, fate, extra));
}

export type JournalRowKey = Pick<JournalRecord, 'taskId' | 'kind' | 'generation' | 'at'>;

function batchRetireBody(
  selected: Array<JournalRowKey & { snapshot: string }>,
): MutationMeta<{ persisted: boolean; marked: number }> {
  if (latchedError) throw latchedError;
  if (beforeBatchCommitForTests) beforeBatchCommitForTests();
  const file = cloneJournal(loadLeaseJournalUnlocked());
  const keep: Array<JournalRowKey & { snapshot: string }> = [];
  for (const item of selected) {
    const rec = file.records.find((row) => recordKey(row) === recordKey(item));
    if (!rec || rec.fate !== 'accepted') continue;
    if (canonicalTaskSnapshot(file, item.taskId) !== item.snapshot) continue;
    keep.push(item);
  }
  if (keep.length === 0) {
    return {
      value: { persisted: false, marked: 0 },
      occupancy: occupancyOf(file),
      lastOpenTaskId: undefined,
    };
  }
  const openBefore = new Map<string, number>();
  for (const item of keep) {
    if (!openBefore.has(item.taskId)) openBefore.set(item.taskId, countOpenForTask(file, item.taskId));
  }
  for (const item of keep) {
    const rec = file.records.find((row) => recordKey(row) === recordKey(item));
    if (!rec) continue;
    rec.fate = item.kind === 'tombstone' ? 'tombstoned' : 'indexed';
  }
  if (persistGuardingPublishedPair(file) === 'prepublish') {
    return {
      value: { persisted: false, marked: 0 },
      occupancy: cache ? occupancyOf(cache) : occupancyOf(file),
      lastOpenTaskId: undefined,
    };
  }
  const live = cache ?? file;
  let lastOpenTaskId: string | undefined;
  for (const [taskId, before] of openBefore) {
    if (before > 0 && countOpenForTask(live, taskId) === 0) {
      lastOpenTaskId = taskId;
      break;
    }
  }
  return {
    value: { persisted: true, marked: keep.length },
    occupancy: occupancyOf(live),
    lastOpenTaskId,
  };
}

/** One atomic accepted→indexed/tombstoned persist for list hydration. Empty after revalidation does not persist. */
export async function batchRetireAcceptedIndexedRows(
  selected: Array<JournalRowKey & { snapshot: string }>,
): Promise<{ persisted: boolean; marked: number }> {
  if (latchedError) throw latchedError;
  if (selected.length === 0) {
    const occupancy = cache ? occupancyOf(cache) : 0;
    if (occupancy < TASK_LEASE_JOURNAL_MAX_RECORDS) {
      return { persisted: false, marked: 0 };
    }
    return withExitMaintenance(() => {
      if (latchedError) throw latchedError;
      const file = loadLeaseJournalUnlocked();
      return {
        value: { persisted: false, marked: 0 },
        occupancy: occupancyOf(file),
        lastOpenTaskId: undefined,
      };
    }, { propagatePublishedPairFailure: true });
  }
  return withExitMaintenance(() => batchRetireBody(selected), { propagatePublishedPairFailure: true });
}

export function journalCanonicalSnapshotFor(taskId: string): string {
  if (latchedError) throw latchedError;
  if (!cache) return '[]';
  return canonicalTaskSnapshot(cache, taskId);
}

export function journalCanonicalSnapshotFrom(file: JournalFile, taskId: string): string {
  return canonicalTaskSnapshot(file, taskId);
}

export function cloneLoadedLeaseJournal(): JournalFile {
  if (latchedError) throw latchedError;
  if (!cache) throw new JournalError('lease_journal_not_bootstrapped');
  return cloneJournal(cache);
}

export function setJournalBeforeListSelectionForTests(fn: (() => void | Promise<void>) | null): void {
  beforeListSelectionForTests = fn;
}

export async function fireJournalBeforeListSelectionForTests(): Promise<void> {
  if (beforeListSelectionForTests) await beforeListSelectionForTests();
}

export function journalPersistCountForTests(): number {
  return persistCount;
}

export function setJournalBeforeBatchCommitForTests(fn: (() => void) | null): void {
  beforeBatchCommitForTests = fn;
}

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
    if (row.kind === 'expired') {
      return OPEN_FATES.has(row.fate) && row.claimedUntil === claimedUntil;
    }
    if (row.kind === 'claim') {
      return OPEN_FATES.has(row.fate);
    }
    if (row.kind === 'renew') {
      if (row.claimedUntil && row.claimedUntil !== claimedUntil) {
        return OPEN_FATES.has(row.fate) || row.fate === 'indexed' || row.fate === 'superseded';
      }
      return OPEN_FATES.has(row.fate);
    }
    if (row.kind === 'release') {
      return OPEN_FATES.has(row.fate) || row.fate === 'indexed' || row.fate === 'superseded' || row.fate === 'tombstoned';
    }
    if (row.kind === 'tombstone') {
      return OPEN_FATES.has(row.fate) || row.fate === 'tombstoned' || row.fate === 'indexed' || row.fate === 'superseded';
    }
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
  exitCursorTaskId = '';
  evidenceQueryCount = 0;
  testExitLookup = null;
  beforeExitCommitForTests = null;
  persistFsync = true;
  writeChunkForTests = null;
  persistCount = 0;
  beforeBatchCommitForTests = null;
  beforeListSelectionForTests = null;
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
