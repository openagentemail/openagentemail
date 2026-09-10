/**
 * Whole-task journal exit (commander 1970 / v4 + FC addendum).
 * Uses production persist/cap (TASK_LEASE_JOURNAL_MAX_RECORDS = 10000; not lowered).
 * Disclosed seams:
 * - setJournalExitEvidenceForTests (durable evidence only; no hydrate).
 * - setJournalPersistFsyncForTests(false) speeds cardinality fills only; still
 *   write/rename/seal/cap. Does not substitute real fsync or SIGKILL durability.
 */
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m2-cap-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test } = await import('bun:test');
const journal = await import('../src/lib/task-lease-journal.ts');
const {
  JournalError,
  TASK_LEASE_JOURNAL_MAX_RECORDS,
  bootstrapTaskLeaseJournal,
  journalExitCursorForTests,
  journalExitEvidenceQueryCountForTests,
  journalMaintenanceDepthForTests,
  journalOccupancyForTests,
  loadLeaseJournal,
  markJournalFate,
  resetJournalMemoryForTests,
  setJournalDataDirForTests,
  setJournalBeforeExitCommitForTests,
  setJournalExitEvidenceForTests,
  setJournalPersistFsyncForTests,
  upsertJournalRecord,
} = journal;
const {
  setFindTaskMessagesForTests,
  taskFromParsedMessagesForTests,
} = await import('../src/lib/tasks-internal.ts');
type JournalExitEvidence = import('../src/lib/task-lease-journal.ts').JournalExitEvidence;
type JournalRecord = import('../src/lib/task-lease-journal.ts').JournalRecord;

const FIRST_CLAIM = '2026-08-24T00:00:00.000Z';
/**
 * Cap-fill wall budget. Post-orch 8th fillIndexed (concurrent fixture) measured
 * 364888ms at 27.41 admits/s, occupancy 10000; bun 360s fired between n=9500
 * (306397ms) and n=10000. Not a barrier hang. Leave headroom for post-fill.
 */
const FILL_TIMEOUT = 480_000;
/** Cooperative check *between* admits only. Does not cancel in-flight persist IO. */
const FILL_DEADLINE_MS = 460_000;
const POST_FILL_BUDGET_MS = 15_000;
/** Optional durable path for local diagnosis. Unset → process temp file (CI must not need FC dirs). */
const ADMIT_RATE_LOG = process.env.OAE_JOURNAL_ADMIT_RATE_LOG
  ?? join(mkdtempSync(join(tmpdir(), 'oae-admit-rate-')), 'admit-rate.log');
let fillEpoch = 0;
let fillAbort = new AbortController();
let outstandingFills: Promise<unknown>[] = [];

function abortActiveFills(): void {
  fillAbort.abort();
  fillEpoch += 1;
  fillAbort = new AbortController();
}

function fillWasAborted(epoch: number, signal: AbortSignal): boolean {
  return epoch !== fillEpoch || signal.aborted;
}

function trackFill<T>(work: Promise<T>): Promise<T> {
  const handled = work.then(() => undefined, () => undefined);
  outstandingFills.push(handled);
  return work;
}

function logAdmitEvent(event: Record<string, unknown>): void {
  try {
    appendFileSync(ADMIT_RATE_LOG, `${JSON.stringify({
      t: new Date().toISOString(),
      persistFsync: false,
      cap: TASK_LEASE_JOURNAL_MAX_RECORDS,
      ...event,
    })}\n`);
  } catch {
    // Diagnostic only; a missing FC path must not fail the fixture.
  }
}

function logAdmitProgress(phase: string, n: number, total: number, started: number): void {
  if (n % 500 !== 0 && n !== total && n !== 1) return;
  const elapsed = Date.now() - started;
  const rate = elapsed > 0 ? n / (elapsed / 1000) : 0;
  logAdmitEvent({
    phase,
    n,
    total,
    occupancy: journalOccupancyForTests(),
    elapsed_ms: elapsed,
    admits_per_s: Number(rate.toFixed(2)),
  });
}

function tid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function indexedClaim(taskId: string, extra: Partial<JournalRecord> = {}): JournalRecord {
  return {
    taskId,
    kind: 'claim',
    generation: 1,
    actor: 'bravo@test.example',
    at: FIRST_CLAIM,
    fate: 'indexed',
    claimedUntil: '2026-08-24T00:05:00.000Z',
    tokenVerifier: 'a'.repeat(43),
    firstClaimedAt: FIRST_CLAIM,
    generationClaimedAt: FIRST_CLAIM,
    ...extra,
  };
}

function intentClaim(taskId: string): JournalRecord {
  return { ...indexedClaim(taskId), fate: 'intent' };
}

function eligibleEvidence(generation = 1): JournalExitEvidence {
  return {
    hadMatchingRows: true,
    reconstructed: true,
    state: 'working',
    leaseGeneration: generation,
    releasedGeneration: 0,
    expiredGeneration: 0,
    lostGeneration: 0,
    tombstones: [],
    firstClaimedAt: FIRST_CLAIM,
  };
}

function absentEvidence(): JournalExitEvidence {
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

async function fillIndexedBody(count: number, start: number, epoch: number, signal: AbortSignal): Promise<void> {
  const started = Date.now();
  const total = start + count - 1;
  const phase = `fillIndexed:${start}-${total}`;
  for (let n = start; n < start + count; n += 1) {
    if (fillWasAborted(epoch, signal)) {
      logAdmitEvent({ phase: `${phase}:abandoned`, n: n - start, total: count, occupancy: journalOccupancyForTests(), elapsed_ms: Date.now() - started });
      throw new Error(`${phase} aborted at n=${n}`);
    }
    const elapsed = Date.now() - started;
    if (elapsed > FILL_DEADLINE_MS) {
      logAdmitEvent({ phase: `${phase}:deadline`, n: n - start, total: count, occupancy: journalOccupancyForTests(), elapsed_ms: elapsed });
      throw new Error(`${phase} exceeded ${FILL_DEADLINE_MS}ms at n=${n}`);
    }
    await upsertJournalRecord(indexedClaim(tid(n)));
    if (fillWasAborted(epoch, signal)) {
      logAdmitEvent({ phase: `${phase}:abandoned`, n: n - start + 1, total: count, occupancy: journalOccupancyForTests(), elapsed_ms: Date.now() - started });
      throw new Error(`${phase} aborted at n=${n}`);
    }
    logAdmitProgress(phase, n - start + 1, count, started);
  }
  logAdmitEvent({
    phase: `${phase}:done`,
    n: count,
    total: count,
    occupancy: journalOccupancyForTests(),
    elapsed_ms: Date.now() - started,
  });
}

function fillIndexed(count: number, start = 1): Promise<void> {
  return trackFill(fillIndexedBody(count, start, fillEpoch, fillAbort.signal));
}

function freshDir(): void {
  setJournalDataDirForTests(mkdtempSync(join(tmpdir(), 'oae-m2-cap-')));
  setJournalPersistFsyncForTests(false);
  bootstrapTaskLeaseJournal();
}

afterEach(async () => {
  abortActiveFills();
  const pending = outstandingFills;
  outstandingFills = [];
  await Promise.all(pending);
  setJournalExitEvidenceForTests(null);
  setJournalBeforeExitCommitForTests(null);
  setFindTaskMessagesForTests(null);
  resetJournalMemoryForTests();
});

describe('M2 journal whole-task exit (v4 + addendum)', () => {
  test('cleanup abort rejects fill so caller cannot post-fill mutate the next fixture', async () => {
    freshDir();
    const leaks: unknown[] = [];
    const onUnhandled = (reason: unknown) => { leaks.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let postFillMutated = false;
    const fill = fillIndexed(30);
    const caller = fill.then(async () => {
      postFillMutated = true;
      await upsertJournalRecord(indexedClaim(tid(99), { signedPayload: 'caller-post-fill' }));
    });
    const callerOutcome = caller.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    abortActiveFills();
    await Promise.all(outstandingFills);
    outstandingFills = [];
    resetJournalMemoryForTests();
    freshDir();
    await upsertJournalRecord(indexedClaim(tid(1)));
    const outcome = await callerOutcome;
    process.off('unhandledRejection', onUnhandled);
    expect(postFillMutated).toBe(false);
    expect(outcome.status).toBe('rejected');
    expect((await loadLeaseJournal()).records.some((row) => row.signedPayload === 'caller-post-fill')).toBe(false);
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === tid(1))).toBe(true);
    expect(leaks).toEqual([]);
  });

  test('10000 OPEN fences are never deleted; next insert is capacity', async () => {
    freshDir();
    await trackFill((async () => {
      const started = Date.now();
      const epoch = fillEpoch;
      const signal = fillAbort.signal;
      for (let n = 1; n <= TASK_LEASE_JOURNAL_MAX_RECORDS; n += 1) {
        if (fillWasAborted(epoch, signal)) {
          throw new Error(`fillOpen aborted at n=${n}`);
        }
        if (Date.now() - started > FILL_DEADLINE_MS) {
          throw new Error(`fillOpen exceeded ${FILL_DEADLINE_MS}ms at n=${n}`);
        }
        await upsertJournalRecord(intentClaim(tid(n)));
        if (fillWasAborted(epoch, signal)) {
          throw new Error(`fillOpen aborted at n=${n}`);
        }
        logAdmitProgress('fillOpen', n, TASK_LEASE_JOURNAL_MAX_RECORDS, started);
      }
    })());
    expect(journalOccupancyForTests()).toBe(TASK_LEASE_JOURNAL_MAX_RECORDS);
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    await expect(upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)))).rejects.toMatchObject({
      message: 'lease_journal_capacity_exhausted',
    });
    const file = await loadLeaseJournal();
    expect(file.records).toHaveLength(TASK_LEASE_JOURNAL_MAX_RECORDS);
    expect(file.records.every((row) => row.fate === 'intent')).toBe(true);
  }, FILL_TIMEOUT);

  test('exact-full already-retired: cleanup then new write without a new mark', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS);
    expect(journalOccupancyForTests()).toBe(TASK_LEASE_JOURNAL_MAX_RECORDS);
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    const beforeQueries = journalExitEvidenceQueryCountForTests();
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)));
    expect(journalExitEvidenceQueryCountForTests() - beforeQueries).toBe(1);
    const file = await loadLeaseJournal();
    expect(file.records.some((row) => row.taskId === tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1))).toBe(true);
    expect(file.records.some((row) => row.taskId === tid(1))).toBe(false);
  }, FILL_TIMEOUT);

  test('cumulative >10000 distinct tasks through legal capacity then new write', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS);
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)));
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 2)));
    const ids = new Set((await loadLeaseJournal()).records.map((row) => row.taskId));
    expect(ids.has(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1))).toBe(true);
    expect(ids.has(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 2))).toBe(true);
    expect(TASK_LEASE_JOURNAL_MAX_RECORDS + 2).toBeGreaterThan(TASK_LEASE_JOURNAL_MAX_RECORDS);
  }, FILL_TIMEOUT);

  test('permanently bad first candidate does not starve a later eligible task', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS);
    const first = tid(1);
    const second = tid(2);
    setJournalExitEvidenceForTests(async (id) => {
      if (id === first) throw new Error('permanent_imap_dead');
      return eligibleEvidence();
    });
    await expect(upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)))).rejects.toMatchObject({
      message: 'lease_journal_capacity_exhausted',
    });
    expect(journalExitCursorForTests()).toBe(first);
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)));
    const file = await loadLeaseJournal();
    expect(file.records.some((row) => row.taskId === first)).toBe(true);
    expect(file.records.some((row) => row.taskId === second)).toBe(false);
  }, FILL_TIMEOUT);

  test('retry without new mark: second persist exits after first evidence failure', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS);
    let calls = 0;
    setJournalExitEvidenceForTests(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient_imap');
      return eligibleEvidence();
    });
    await expect(upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)))).rejects.toBeInstanceOf(JournalError);
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)));
    expect(calls).toBe(2);
  }, FILL_TIMEOUT);

  test('exact-full + lastOPEN + retry share one evidence query', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS - 1);
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS)));
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    const before = journalExitEvidenceQueryCountForTests();
    await markJournalFate(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS)), 'indexed');
    expect(journalExitEvidenceQueryCountForTests() - before).toBe(1);
  }, FILL_TIMEOUT);

  test('5s deadline: hung evidence cannot delete; late result ignored', async () => {
    freshDir();
    await upsertJournalRecord(intentClaim(tid(1)));
    let late: ((value: JournalExitEvidence) => void) | undefined;
    setJournalExitEvidenceForTests((_id, { signal }) => new Promise((resolve, reject) => {
      late = resolve;
      signal.addEventListener('abort', () => reject(new JournalError('lease_journal_exit_evidence_timeout')));
    }));
    const started = Date.now();
    await markJournalFate(intentClaim(tid(1)), 'indexed');
    expect(Date.now() - started).toBeLessThan(8_000);
    expect((await loadLeaseJournal()).records).toHaveLength(1);
    late?.(eligibleEvidence());
    await Bun.sleep(50);
    expect((await loadLeaseJournal()).records).toHaveLength(1);
  }, 15_000);

  test('concurrent full-field change aborts exit', async () => {
    freshDir();
    const fillStarted = Date.now();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS);
    const fillMs = Date.now() - fillStarted;
    logAdmitEvent({ phase: 'concurrent:fill_done', fill_ms: fillMs, occupancy: journalOccupancyForTests() });
    let releaseFirst!: () => void;
    let firstBegun!: () => void;
    const firstBegunP = new Promise<void>((resolve) => { firstBegun = resolve; });
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let lookups = 0;
    let firstReturnedValid = false;
    let firstTimedOut = false;
    setJournalExitEvidenceForTests(async (_id, { signal }) => {
      lookups += 1;
      if (lookups !== 1) {
        return absentEvidence();
      }
      firstBegun();
      await firstHold;
      if (signal.aborted) {
        firstTimedOut = true;
        throw new JournalError('lease_journal_exit_evidence_timeout');
      }
      firstReturnedValid = true;
      return eligibleEvidence();
    });
    const postFillStarted = Date.now();
    const pending = upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS + 1)));
    const pendingOutcome = pending.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );
    await firstBegunP;
    logAdmitEvent({ phase: 'concurrent:barrier', post_fill_ms: Date.now() - postFillStarted, lookups });
    await upsertJournalRecord(indexedClaim(tid(1), { signedPayload: 'mutated-payload' }));
    logAdmitEvent({ phase: 'concurrent:mutated', post_fill_ms: Date.now() - postFillStarted, lookups });
    releaseFirst();
    const outcome = await pendingOutcome;
    const postFillMs = Date.now() - postFillStarted;
    logAdmitEvent({
      phase: 'concurrent:pending_settled',
      post_fill_ms: postFillMs,
      fill_ms: fillMs,
      status: outcome.status,
      lookups,
      firstReturnedValid,
      firstTimedOut,
    });
    expect(postFillMs).toBeLessThan(POST_FILL_BUDGET_MS);
    expect(outcome.status).toBe('rejected');
    expect(outcome).toMatchObject({
      status: 'rejected',
      reason: { message: 'lease_journal_capacity_exhausted' },
    });
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === tid(1) && row.signedPayload === 'mutated-payload')).toBe(true);
    expect(firstReturnedValid).toBe(true);
    expect(firstTimedOut).toBe(false);
    expect(lookups).toBeGreaterThanOrEqual(2);
  }, FILL_TIMEOUT);

  test('committed accepted fate stays accepted if maintenance fails', async () => {
    freshDir();
    await upsertJournalRecord(intentClaim(tid(1)));
    await upsertJournalRecord({ ...intentClaim(tid(1)), fate: 'accepted' });
    setJournalExitEvidenceForTests(async () => {
      throw new Error('imap_down');
    });
    const marked = await markJournalFate(intentClaim(tid(1)), 'indexed');
    expect(marked.fate).toBe('indexed');
    expect((await loadLeaseJournal()).records[0]?.fate).toBe('indexed');
  });

  test('evidence lookup cannot reenter reconcile (nested mutation uses no extra query)', async () => {
    freshDir();
    await fillIndexed(TASK_LEASE_JOURNAL_MAX_RECORDS - 1);
    await upsertJournalRecord(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS)));
    setJournalExitEvidenceForTests(async () => {
      expect(journalMaintenanceDepthForTests()).toBeGreaterThan(0);
      await upsertJournalRecord(indexedClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS), { at: '2026-08-24T00:00:01.000Z', fate: 'indexed' }));
      return eligibleEvidence();
    });
    const before = journalExitEvidenceQueryCountForTests();
    await markJournalFate(intentClaim(tid(TASK_LEASE_JOURNAL_MAX_RECORDS)), 'indexed');
    expect(journalExitEvidenceQueryCountForTests() - before).toBe(1);
  }, FILL_TIMEOUT);

  test('production reconstruction: completed task still exits via historical claim receipts', async () => {
    freshDir();
    const id = tid(1);
    const claimAt = FIRST_CLAIM;
    const messages = [
      {
        uid: 1, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: claimAt, state: 'submitted' as const, body: 'Please claim.',
      },
      {
        uid: 2, from: 'bravo@test.example', to: 'alpha@test.example',
        subject: 'Lease', date: claimAt, state: 'working' as const, body: 'Lease claimed.',
        lease: {
          version: 1 as const, event: 'claim' as const, actor: 'bravo@test.example', at: claimAt,
          generation: 1, claimedUntil: '2026-08-24T00:05:00.000Z', tokenVerifier: 'a'.repeat(43),
        },
      },
      {
        uid: 3, from: 'bravo@test.example', to: 'alpha@test.example',
        subject: 'Lease', date: '2026-08-24T00:01:00.000Z', state: 'completed' as const, body: 'done',
      },
    ];
    const rebuilt = taskFromParsedMessagesForTests(id, messages);
    expect(rebuilt?.state).toBe('completed');
    expect(rebuilt?.lease).toBeUndefined();
    expect(rebuilt?.lostLease).toBeUndefined();
    setFindTaskMessagesForTests(async () => ({ hadMatchingRows: true, messages }));
    await upsertJournalRecord(intentClaim(id));
    await markJournalFate(intentClaim(id), 'indexed');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(false);
  });

  test('tombstone same generation different at does not exit', async () => {
    freshDir();
    const id = tid(1);
    const journalAt = '2026-08-24T02:00:00.000Z';
    await upsertJournalRecord({
      ...indexedClaim(id),
      kind: 'tombstone',
      fate: 'intent',
      at: journalAt,
    });
    setJournalExitEvidenceForTests(async () => ({
      ...eligibleEvidence(),
      lostGeneration: 1,
      tombstones: [{ generation: 1, at: '2026-08-24T03:00:00.000Z' }],
    }));
    await markJournalFate({ taskId: id, kind: 'tombstone', generation: 1, at: journalAt }, 'tombstoned');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(true);
  });

  test('tombstone matching generation+at exits', async () => {
    freshDir();
    const id = tid(1);
    const journalAt = '2026-08-24T02:00:00.000Z';
    await upsertJournalRecord({
      ...indexedClaim(id),
      kind: 'tombstone',
      fate: 'intent',
      at: journalAt,
    });
    setJournalExitEvidenceForTests(async () => ({
      ...eligibleEvidence(),
      lostGeneration: 1,
      tombstones: [{ generation: 1, at: journalAt }],
    }));
    await markJournalFate({ taskId: id, kind: 'tombstone', generation: 1, at: journalAt }, 'tombstoned');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(false);
  });

  test('late queued commit after deadline cannot delete', async () => {
    freshDir();
    await upsertJournalRecord(intentClaim(tid(1)));
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    setJournalBeforeExitCommitForTests(async () => {
      await Bun.sleep(6_000);
    });
    await markJournalFate(intentClaim(tid(1)), 'indexed');
    expect((await loadLeaseJournal()).records).toHaveLength(1);
  }, 15_000);

  test('without evidence lookup lastOPEN does not query or advance cursor', async () => {
    freshDir();
    await upsertJournalRecord(intentClaim(tid(1)));
    await markJournalFate(intentClaim(tid(1)), 'indexed');
    expect(journalExitCursorForTests()).toBe('');
    expect(journalExitEvidenceQueryCountForTests()).toBe(0);
    expect((await loadLeaseJournal()).records).toHaveLength(1);
  });

  test('overlapping independent mutations each get a query budget', async () => {
    freshDir();
    await upsertJournalRecord(intentClaim(tid(1)));
    await upsertJournalRecord(intentClaim(tid(2)));
    setJournalExitEvidenceForTests(async () => eligibleEvidence());
    const before = journalExitEvidenceQueryCountForTests();
    await Promise.all([
      markJournalFate(intentClaim(tid(1)), 'indexed'),
      markJournalFate(intentClaim(tid(2)), 'indexed'),
    ]);
    expect(journalExitEvidenceQueryCountForTests() - before).toBe(2);
  });

  test('production reconstruction: matching claim_lost generation+at exits tombstone rows', async () => {
    freshDir();
    const id = tid(1);
    const journalAt = '2026-08-24T02:00:00.000Z';
    const messages = [
      {
        uid: 1, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: FIRST_CLAIM, state: 'submitted' as const, body: 'Please claim.',
      },
      {
        uid: 2, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: journalAt, state: 'submitted' as const, body: 'lost',
        lease: {
          version: 1 as const, event: 'claim_lost' as const, actor: 'server' as const, at: journalAt,
          generation: 1, claimedUntil: '2026-08-24T00:05:00.000Z', firstClaimedAt: FIRST_CLAIM,
        },
      },
    ];
    const rebuilt = taskFromParsedMessagesForTests(id, messages);
    expect(rebuilt?.lostLease?.leaseGeneration).toBe(1);
    expect(rebuilt?.lostLease?.lostAt).toBe(journalAt);
    setFindTaskMessagesForTests(async () => ({ hadMatchingRows: true, messages }));
    await upsertJournalRecord({
      ...indexedClaim(id),
      kind: 'tombstone',
      fate: 'intent',
      at: journalAt,
    });
    await markJournalFate({ taskId: id, kind: 'tombstone', generation: 1, at: journalAt }, 'tombstoned');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(false);
  });

  test('production reconstruction: claim_lost same generation different at does not exit', async () => {
    freshDir();
    const id = tid(1);
    const journalAt = '2026-08-24T02:00:00.000Z';
    const lostAt = '2026-08-24T03:00:00.000Z';
    const messages = [
      {
        uid: 1, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: FIRST_CLAIM, state: 'submitted' as const, body: 'Please claim.',
      },
      {
        uid: 2, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: lostAt, state: 'submitted' as const, body: 'lost',
        lease: {
          version: 1 as const, event: 'claim_lost' as const, actor: 'server' as const, at: lostAt,
          generation: 1, claimedUntil: '2026-08-24T00:05:00.000Z', firstClaimedAt: FIRST_CLAIM,
        },
      },
    ];
    const rebuilt = taskFromParsedMessagesForTests(id, messages);
    expect(rebuilt?.lostLease?.leaseGeneration).toBe(1);
    expect(rebuilt?.lostLease?.lostAt).toBe(lostAt);
    setFindTaskMessagesForTests(async () => ({ hadMatchingRows: true, messages }));
    await upsertJournalRecord({
      ...indexedClaim(id),
      kind: 'tombstone',
      fate: 'intent',
      at: journalAt,
    });
    await markJournalFate({ taskId: id, kind: 'tombstone', generation: 1, at: journalAt }, 'tombstoned');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(true);
  });

  test('production reconstruction: firstClaimedAt mismatch does not exit', async () => {
    freshDir();
    const id = tid(1);
    const messages = [
      {
        uid: 1, from: 'alpha@test.example', to: 'bravo@test.example',
        subject: 'Lease', date: FIRST_CLAIM, state: 'submitted' as const, body: 'Please claim.',
      },
      {
        uid: 2, from: 'bravo@test.example', to: 'alpha@test.example',
        subject: 'Lease', date: '2026-08-24T00:00:09.000Z', state: 'working' as const, body: 'Lease claimed.',
        lease: {
          version: 1 as const, event: 'claim' as const, actor: 'bravo@test.example',
          at: '2026-08-24T00:00:09.000Z',
          generation: 1, claimedUntil: '2026-08-24T00:05:00.000Z', tokenVerifier: 'a'.repeat(43),
        },
      },
      {
        uid: 3, from: 'bravo@test.example', to: 'alpha@test.example',
        subject: 'Lease', date: '2026-08-24T00:01:00.000Z', state: 'completed' as const, body: 'done',
      },
    ];
    const rebuilt = taskFromParsedMessagesForTests(id, messages);
    expect(rebuilt?.state).toBe('completed');
    expect(rebuilt?.lease).toBeUndefined();
    setFindTaskMessagesForTests(async () => ({ hadMatchingRows: true, messages }));
    await upsertJournalRecord(intentClaim(id));
    await markJournalFate(intentClaim(id), 'indexed');
    expect((await loadLeaseJournal()).records.some((row) => row.taskId === id)).toBe(true);
  });
});
