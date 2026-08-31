import { constants, lstat, mkdir, open, readFile, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const PHASES = [
  'intent-created', 'create-attempted', 'task-adopted', 'input-request-attempted',
  'awaiting-input', 'decision-received', 'resume-started', 'resumed',
] as const;
export type Phase = typeof PHASES[number];

export interface DecisionEvidence {
  decision: 'approved' | 'rejected';
  messageId: string;
  evidenceFingerprint: string;
}

export interface CorrelationRecord {
  schemaVersion: 1;
  framework: string;
  correlationId: string;
  operationKey: string;
  requestFingerprint: string;
  expectedParticipants: { requester: string; responder: string };
  taskId: string | null;
  frameworkStateRef: string;
  approvalItemKey: string | null;
  phase: Phase;
  createAttemptedAt: string | null;
  inputEvidence: string | null;
  decisionEvidence: DecisionEvidence | null;
  resumeEvidence: string | null;
  updatedAt: string;
}

export class CorrelationSafetyError extends Error {}
export function validateCorrelationRecord(value: unknown): asserts value is CorrelationRecord { validateRecord(value); }

/** Canonical lowercase RFC 4122 UUIDs, versions 1–5, non-nil. */
const CORRELATION_UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isCorrelationId(value: unknown): value is string { return typeof value === 'string' && value.length === 36 && CORRELATION_UUID.test(value); }

/** Shared semantic task ID boundary for persistence and public diagnostics. */
export function isSafeTaskId(value: unknown): value is string { return validSafeText(value, /^[A-Za-z0-9._:-]{1,240}$/); }

export function requestFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function createIntent(input: Omit<CorrelationRecord, 'schemaVersion' | 'correlationId' | 'taskId' | 'phase' | 'createAttemptedAt' | 'inputEvidence' | 'decisionEvidence' | 'resumeEvidence' | 'updatedAt'> & { correlationId?: string; now?: string }): CorrelationRecord {
  const now = input.now ?? new Date().toISOString();
  const record: CorrelationRecord = {
    schemaVersion: 1, correlationId: input.correlationId ?? randomUUID(), framework: input.framework,
    operationKey: input.operationKey, requestFingerprint: input.requestFingerprint,
    expectedParticipants: input.expectedParticipants, frameworkStateRef: input.frameworkStateRef,
    approvalItemKey: input.approvalItemKey, taskId: null, phase: 'intent-created', createAttemptedAt: null, inputEvidence: null,
    decisionEvidence: null, resumeEvidence: null, updatedAt: now,
  };
  validateRecord(record);
  return record;
}

type TransitionChanges = Partial<Pick<CorrelationRecord, 'taskId' | 'createAttemptedAt' | 'inputEvidence' | 'decisionEvidence' | 'resumeEvidence'>>;

export function transition(record: CorrelationRecord, phase: Phase, changes: TransitionChanges = {}, now?: string): CorrelationRecord {
  if (PHASES.indexOf(phase) !== PHASES.indexOf(record.phase) + 1) throw new CorrelationSafetyError(`non-monotonic transition ${record.phase} -> ${phase}`);
  const updatedAt = now ?? new Date(Math.max(Date.now(), Date.parse(record.updatedAt) + 1)).toISOString();
  const next = { ...record, ...changes, phase, updatedAt };
  if (phase === 'create-attempted' && next.createAttemptedAt !== updatedAt) throw new CorrelationSafetyError('create attempt timestamp must equal transition updatedAt');
  validateRecord(next);
  validateAdjacentChange(record, next);
  return next;
}

export interface StoreHooks {
  /** Test seam: invoked after file fsync and before rename. */
  beforeRename?: () => Promise<void>;
}

export class CorrelationStore {
  constructor(readonly directory: string, private readonly hooks: StoreHooks = {}) {}

  private path(id: string): string {
    if (!isCorrelationId(id)) throw new CorrelationSafetyError('correlation ID is not a canonical RFC UUID');
    return join(this.directory, `${id}.json`);
  }

  async save(record: CorrelationRecord): Promise<void> {
    validateRecord(record);
    await ensureTrustedDirectory(this.directory);
    const target = this.path(record.correlationId);
    const lock = await acquireLock(`${target}.lock`);
    try { await this.saveLocked(record, target, lock); } finally { await releaseLock(lock, this.directory); }
  }

  private async saveLocked(record: CorrelationRecord, target: string, lock: Lock): Promise<void> {
    const prior = await this.loadIfPresent(record.correlationId);
    if (prior) validateAdjacentChange(prior, record);
    else if (record.phase !== 'intent-created') throw new CorrelationSafetyError('first durable write must be intent-created');

    const temporary = join(dirname(target), `.${record.correlationId}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally { await handle.close(); }
      await validateSafeFile(temporary);
      await this.hooks.beforeRename?.();
      await verifyLock(lock);
      await rename(temporary, target);
      created = false;
      await validateSafeFile(target);
      const directoryHandle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      if (created) await removeExactTemporary(temporary);
      throw error;
    }
  }

  async load(correlationId: string): Promise<CorrelationRecord> {
    const path = this.path(correlationId);
    await ensureTrustedDirectory(this.directory);
    await validateSafeFile(path);
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new CorrelationSafetyError('correlation file is corrupt or truncated'); }
    validateRecord(parsed);
    if (parsed.correlationId !== correlationId) throw new CorrelationSafetyError('correlation filename and record ID differ');
    return parsed;
  }

  private async loadIfPresent(correlationId: string): Promise<CorrelationRecord | null> {
    try { return await this.load(correlationId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

async function ensureTrustedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CorrelationSafetyError('state directory must be a real directory');
  if (entry.uid !== currentUid() || (entry.mode & 0o777) !== 0o700) throw new CorrelationSafetyError('state directory must be owned and mode 0700');
}

type Lock = { path: string; token: string; dev: number; ino: number };

async function acquireLock(path: string): Promise<Lock> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CorrelationSafetyError('correlation record is busy; refusing unproven stale lock'); throw error; }
  const token = randomUUID();
  try {
    const owner = await open(join(path, 'owner'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await owner.writeFile(token); await owner.sync(); } finally { await owner.close(); }
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== currentUid() || (entry.mode & 0o777) !== 0o700) throw new CorrelationSafetyError('new correlation lock is unsafe');
    return { path, token, dev: entry.dev, ino: entry.ino };
  } catch (error) { await removeOwnedLock(path, token); throw error; }
}

async function verifyLock(lock: Lock): Promise<void> {
  const entry = await lstat(lock.path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== lock.dev || entry.ino !== lock.ino) throw new CorrelationSafetyError('correlation lock ownership was replaced');
  const owner = await lstat(join(lock.path, 'owner'));
  if (!owner.isFile() || owner.isSymbolicLink() || owner.uid !== currentUid() || (owner.mode & 0o777) !== 0o600 || await readFile(join(lock.path, 'owner'), 'utf8') !== lock.token) throw new CorrelationSafetyError('correlation lock token was replaced');
}

async function releaseLock(lock: Lock, directory: string): Promise<void> {
  try {
    await verifyLock(lock);
    await unlink(join(lock.path, 'owner'));
    await rmdir(lock.path);
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function removeOwnedLock(path: string, token: string): Promise<void> {
  try {
    const ownerPath = join(path, 'owner');
    if (await readFile(ownerPath, 'utf8') !== token) return;
    await unlink(ownerPath); await rmdir(path);
  } catch { /* never delete a replacement on failed acquisition */ }
}

async function validateSafeFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new CorrelationSafetyError('state file must be a regular non-symlink file');
  if (entry.uid !== currentUid() || (entry.mode & 0o777) !== 0o600) throw new CorrelationSafetyError('state file must be owned and mode 0600');
  if (!(await stat(path)).isFile()) throw new CorrelationSafetyError('state file changed during validation');
}

async function removeExactTemporary(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isFile() && !entry.isSymbolicLink()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CorrelationSafetyError('owner validation is unavailable on this platform');
  return uid;
}

function validateAdjacentChange(prior: CorrelationRecord, next: CorrelationRecord): void {
  const immutable: Array<keyof CorrelationRecord> = ['schemaVersion', 'framework', 'correlationId', 'operationKey', 'requestFingerprint', 'expectedParticipants', 'frameworkStateRef', 'approvalItemKey'];
  for (const key of immutable) if (canonicalJson(prior[key]) !== canonicalJson(next[key])) throw new CorrelationSafetyError(`immutable field changed: ${key}`);
  if (PHASES.indexOf(next.phase) !== PHASES.indexOf(prior.phase) + 1) throw new CorrelationSafetyError(`durable transition must be exactly adjacent: ${prior.phase} -> ${next.phase}`);
  if (next.updatedAt <= prior.updatedAt) throw new CorrelationSafetyError('updatedAt must advance monotonically');
  if (prior.createAttemptedAt !== null && next.createAttemptedAt !== prior.createAttemptedAt) throw new CorrelationSafetyError('create attempt timestamp cannot be rewritten');
  if (prior.taskId !== null && next.taskId !== prior.taskId) throw new CorrelationSafetyError('adopted task ID cannot be rewritten');
  if (prior.inputEvidence !== null && next.inputEvidence !== prior.inputEvidence) throw new CorrelationSafetyError('input evidence cannot be rewritten');
  if (prior.decisionEvidence !== null && canonicalJson(next.decisionEvidence) !== canonicalJson(prior.decisionEvidence)) throw new CorrelationSafetyError('decision evidence cannot be rewritten');
  if (prior.resumeEvidence !== null && next.resumeEvidence !== prior.resumeEvidence) throw new CorrelationSafetyError('resume evidence cannot be rewritten');
}

function validSafeText(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value) && !/(bearer|basic\s+|authorization|token|secret|password|api[_-]?key|raw[-_ ]?body|-----begin|private[ _-]?key|\r|\n)/i.test(value) && !/(^|[^a-z0-9])(?:sk-|oa_)[a-z0-9_-]+/i.test(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected.slice().sort()[index]);
}

function validEvidence(value: unknown): value is DecisionEvidence {
  const row = value as Partial<DecisionEvidence>;
  return !!row && typeof row === 'object' && exactKeys(row, ['decision', 'messageId', 'evidenceFingerprint'])
    && (row.decision === 'approved' || row.decision === 'rejected') && validSafeText(row.messageId, /^[A-Za-z0-9._:-]{1,240}$/)
    && typeof row.evidenceFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(row.evidenceFingerprint);
}

function validateRecord(value: unknown): asserts value is CorrelationRecord {
  const row = value as Partial<CorrelationRecord>;
  if (!row || typeof row !== 'object' || !exactKeys(row, ['schemaVersion', 'framework', 'correlationId', 'operationKey', 'requestFingerprint', 'expectedParticipants', 'taskId', 'frameworkStateRef', 'approvalItemKey', 'phase', 'createAttemptedAt', 'inputEvidence', 'decisionEvidence', 'resumeEvidence', 'updatedAt'])) throw new CorrelationSafetyError('correlation file has unknown or missing fields');
  const participant = row.expectedParticipants as Partial<CorrelationRecord['expectedParticipants']>;
  const basic = row.schemaVersion === 1 && validSafeText(row.framework, /^[a-z0-9-]{1,80}$/i) && isCorrelationId(row.correlationId)
    && validSafeText(row.operationKey, /^[A-Za-z0-9._:/-]{1,240}$/) && /^[0-9a-f]{64}$/i.test(row.requestFingerprint ?? '')
    && !!participant && exactKeys(participant, ['requester', 'responder']) && validSafeText(participant.requester, /^[^@\s]+@[^@\s]+$/) && validSafeText(participant.responder, /^[^@\s]+@[^@\s]+$/)
    && (row.taskId === null || isSafeTaskId(row.taskId)) && validSafeText(row.frameworkStateRef, /^[A-Za-z0-9._:/-]{1,240}$/)
    && (row.approvalItemKey === null || validSafeText(row.approvalItemKey, /^[A-Za-z0-9._:-]{1,240}$/)) && PHASES.includes(row.phase as Phase)
    && (row.createAttemptedAt === null || canonicalTimestamp(row.createAttemptedAt ?? undefined)) && (row.inputEvidence === null || /^[0-9a-f]{64}$/i.test(row.inputEvidence ?? '')) && (row.decisionEvidence === null || validEvidence(row.decisionEvidence))
    && (row.resumeEvidence === null || validSafeText(row.resumeEvidence, /^[A-Za-z0-9._:-]{1,240}$/)) && canonicalTimestamp(row.updatedAt ?? undefined);
  if (!basic) throw new CorrelationSafetyError('correlation file has an invalid schema or unsafe value');
  const phase = row.phase as Phase;
  const needsAttempt = PHASES.indexOf(phase) >= PHASES.indexOf('create-attempted');
  const needsTask = PHASES.indexOf(phase) >= PHASES.indexOf('task-adopted');
  const needsInput = PHASES.indexOf(phase) >= PHASES.indexOf('input-request-attempted');
  const needsDecision = PHASES.indexOf(phase) >= PHASES.indexOf('decision-received');
  const needsResume = phase === 'resumed';
  if ((needsAttempt !== (row.createAttemptedAt !== null)) || (needsTask !== (row.taskId !== null)) || (needsInput !== (row.inputEvidence !== null)) || (needsDecision !== (row.decisionEvidence !== null)) || (needsResume !== (row.resumeEvidence !== null))) throw new CorrelationSafetyError(`correlation phase ${phase} has impossible evidence`);
  if (row.createAttemptedAt !== null && row.createAttemptedAt !== undefined && row.updatedAt !== undefined && row.createAttemptedAt > row.updatedAt) throw new CorrelationSafetyError('create attempt timestamp is after updatedAt');
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
