import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { FetchMessageObject } from 'imapflow';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m2-pending-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const { parseConfig } = await import('../src/lib/config.ts');
const {
  claimLostTask,
  claimTask,
  emitPendingExpiryAuditsOnce,
  getTask,
  isTaskLeaseTokenCurrent,
  listTaskBoard,
  reapExpiredTaskLeasesOnce,
  releaseTask,
  renewTask,
  replyTask,
  taskFromMessages,
  toTaskView,
  updateTask,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  setPostSmtpAcceptHookForTests,
  setPreSmtpHookForTests,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const {
  JournalError,
  batchRetireAcceptedIndexedRows,
  bootstrapTaskLeaseJournal,
  cloneLoadedLeaseJournal,
  journalCanonicalSnapshotFor,
  journalExitEvidenceQueryCountForTests,
  journalPathsForTests,
  journalPersistCountForTests,
  journalRecordsFor,
  journalSuppressesExpiry,
  loadLeaseJournal,
  markJournalFate,
  resetJournalMemoryForTests,
  setJournalBeforeBatchCommitForTests,
  setJournalBeforeExitCommitForTests,
  setJournalBeforeListSelectionForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
  setJournalDurableEvidenceForTests,
  setJournalExitEvidenceForTests,
  setJournalNowForTests,
  setJournalWriteChunkForTests,
  unresolvedClaimFence,
  upsertJournalRecord,
} = await import('../src/lib/task-lease-journal.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const ID2 = '1fdc3207-056e-47c1-a65c-b29d39f66b84';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');
const TWO_H = 2 * 60 * 60 * 1000;
const VERIFIER = 'v'.repeat(43);
const OTHER_VERIFIER = 'w'.repeat(43);
const UNTIL = '2026-08-24T00:05:00.000Z';

function submittedRaw(id = ID): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: `Lease ${id}`,
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  };
}

function submittedTask(id = ID): Task {
  return taskFromMessages(id, [submittedRaw(id)])!;
}

function durableWithLease(id: string, generation: number, verifier = VERIFIER, until = UNTIL): Task {
  return {
    ...submittedTask(id),
    state: 'working',
    lease: {
      leaseGeneration: generation,
      claimedUntil: until,
      tokenVerifier: verifier,
      generationClaimedAt: '2026-08-24T00:00:00.000Z',
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    },
  };
}

function durableWithLostLease(id: string, generation: number): Task {
  return {
    ...submittedTask(id),
    lostLease: {
      leaseGeneration: generation,
      claimedUntil: UNTIL,
      lostAt: '2026-08-24T02:00:00.000Z',
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    },
  };
}

function acceptedClaim(id: string, generation = 1, at = '2026-08-24T00:00:00.000Z', verifier = VERIFIER) {
  return {
    taskId: id,
    kind: 'claim' as const,
    generation,
    actor: B,
    at,
    fate: 'accepted' as const,
    claimedUntil: UNTIL,
    tokenVerifier: verifier,
  };
}

async function listAllAdmin() {
  return listTaskBoard(
    { status: 'all', period: '30d', limit: 20 },
    { kind: 'admin' },
  );
}

function ineligibleExitEvidence() {
  return {
    hadMatchingRows: false,
    reconstructed: false,
    leaseGeneration: 0,
    releasedGeneration: 0,
    expiredGeneration: 0,
    lostGeneration: 0,
    tombstones: [] as Array<{ generation: number; at: string }>,
  };
}

function eligibleExitEvidence(generation = 1) {
  return {
    hadMatchingRows: true,
    reconstructed: true,
    leaseGeneration: generation,
    releasedGeneration: 0,
    expiredGeneration: 0,
    lostGeneration: 0,
    tombstones: [] as Array<{ generation: number; at: string }>,
  };
}

function source(input: SendInput): Buffer {
  return Buffer.from([
    `From: ${input.from}`,
    `To: ${input.to[0]}`,
    `Subject: ${input.subject}`,
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n'), 'utf8');
}

async function parseCaptured(input: SendInput, uid: number, id = ID): Promise<RawTaskMessage | null> {
  return parseTaskMessageForTests({
    uid,
    source: source(input),
    envelope: {
      from: [{ address: input.from }],
      to: [{ address: input.to[0] }],
      subject: input.subject,
    },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, id);
}

/** 旧 reader：丢弃 claim_lost，证明 tombstone 后无法跨代。 */
function oldReaderFromMessages(id: string, raw: RawTaskMessage[]): Task | null {
  return taskFromMessages(id, raw.filter((row) => row.lease?.event !== 'claim_lost'));
}

async function withM2On<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () =>
    withTaskLeasePendingJournalForTests(true, work));
}

async function withM2Off<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () =>
    withTaskLeasePendingJournalForTests(false, work));
}

async function withM2M3<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () =>
    withTaskLeasePendingJournalForTests(true, () =>
      withTaskLeaseExpiryAuditM3ForTests(true, work)));
}

const testOn = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withM2On(work));

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  setPreSmtpHookForTests(null);
  setPostSmtpAcceptHookForTests(null);
  setJournalCrashHookForTests(null);
  setJournalNowForTests(null);
  setJournalDurableEvidenceForTests(null);
  setJournalBeforeBatchCommitForTests(null);
  setJournalBeforeExitCommitForTests(null);
  setJournalBeforeListSelectionForTests(null);
  setJournalWriteChunkForTests(null);
  clearQueuedEventsForTests();
  resetJournalMemoryForTests();
});

function isolateJournal(): void {
  const dir = mkdtempSync(join(tmpdir(), 'oae-m2-iso-'));
  setJournalDataDirForTests(dir);
  bootstrapTaskLeaseJournal();
}

/** Flag-bound: neighbor TASK_LEASES_ENABLED=false must not satisfy defaultsFalse. */
function pendingJournalDefaultsFalse(nearby: string, marker = 'TASK_LEASES_PENDING_JOURNAL'): boolean {
  return new RegExp(`${marker}\\s*[=:]\\s*["']?false`).test(nearby)
    || new RegExp(`${marker}:-false`).test(nearby)
    || new RegExp(`${marker}[^\\n]*\\bdefault(s)?\\s+(to\\s+)?false`, 'i').test(nearby);
}

function pendingJournalRequiresLeases(nearby: string): boolean {
  return /requires?[^\n]*TASK_LEASES_ENABLED|TASK_LEASES_ENABLED[^\n]*required|depends on TASK_LEASES_ENABLED|TASK_LEASES_ENABLED[^\n]{0,80}TASK_LEASES_PENDING_JOURNAL|TASK_LEASES_PENDING_JOURNAL[^\n]{0,80}TASK_LEASES_ENABLED/i
    .test(nearby);
}

describe('M2 配置面与默认关', () => {
  testOn('config 默认 false，true 解析生效', () => {
    const base = {
      DOMAIN: 'test.example', API_KEYS: 'admin-key', IMAP_USER: A, IMAP_PASS: 'imap-secret',
      SMTP_USER: A, SMTP_PASS: 'smtp-secret', DATA_DIR: mkdtempSync(join(tmpdir(), 'oae-m2-cfg-')),
    };
    expect(parseConfig(base).taskLeasesPendingJournal).toBe(false);
    expect(parseConfig({ ...base, TASK_LEASES_PENDING_JOURNAL: 'true' }).taskLeasesPendingJournal).toBe(true);
  });

  testOn('六个配置面都带默认 false，并写明依赖 TASK_LEASES_ENABLED', () => {
    const surfaces = [
      { name: 'bundled-compose', text: readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8') },
      { name: 'api-only-compose', text: readFileSync(new URL('../../../compose.api-only.yaml', import.meta.url), 'utf8') },
      { name: 'bundled-example', text: readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8') },
      { name: 'api-only-example', text: readFileSync(new URL('../../../.env.api-only.example', import.meta.url), 'utf8') },
      { name: 'root-readme', text: readFileSync(new URL('../../../README.md', import.meta.url), 'utf8') },
      { name: 'mcp-readme', text: readFileSync(new URL('../../mcp/README.md', import.meta.url), 'utf8') },
    ];
    const observed = surfaces.map(({ name, text }) => {
      const marker = 'TASK_LEASES_PENDING_JOURNAL';
      const index = text.indexOf(marker);
      const nearby = index < 0 ? '' : text.slice(Math.max(0, index - 280), index + marker.length + 280);
      return {
        name,
        mentionsFlag: index >= 0,
        defaultsFalse: pendingJournalDefaultsFalse(nearby, marker),
        requiresLeases: pendingJournalRequiresLeases(nearby),
      };
    });
    for (const row of observed) {
      expect(row).toEqual({
        name: row.name, mentionsFlag: true, defaultsFalse: true, requiresLeases: true,
      });
    }
  });

  testOn('G: defaultsFalse binds to TASK_LEASES_PENDING_JOURNAL, not neighbor ENABLED=false', () => {
    const marker = 'TASK_LEASES_PENDING_JOURNAL';
    const neighborTrue = `${marker}=true\nTASK_LEASES_ENABLED=false`;
    expect(pendingJournalDefaultsFalse(neighborTrue, marker)).toBe(false);
    expect(/false/.test(neighborTrue)).toBe(true);
    const composeDefault = `${marker}: \${${marker}:-false}`;
    expect(pendingJournalDefaultsFalse(composeDefault, marker)).toBe(true);
    expect(pendingJournalDefaultsFalse(`${marker}=false`, marker)).toBe(true);
    expect(pendingJournalDefaultsFalse(`Optional \`${marker}\` (default false, requires TASK_LEASES_ENABLED)`, marker)).toBe(true);
  });
});

describe('M2-1 pending fence 跨重启', () => {
  testOn('未索引超过 15min + 内存清空：不得重分配同一代', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m2-1-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(first.leaseGeneration).toBe(1);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    now = START + 16 * 60 * 1000;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
    expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'claim')).toHaveLength(1);
  });

  testOn('SMTP 失败后重启：同 identity 重发，不新开代', async () => {
    isolateJournal();
    let now = START;
    const sent: SendInput[] = [];
    let failOnce = true;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('smtp_down');
      }
      sent.push(input);
      return { messageId: `<rs-${sent.length}>` };
    });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({ message: 'smtp_down' });
    resetJournalMemoryForTests();
    clearQueuedEventsForTests();
    now = START + 16 * 60 * 1000;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
    expect(sent).toHaveLength(1);
    const payload = JSON.parse(Buffer.from(String(sent[0]?.headers?.['X-OA-Task-Lease-Payload']), 'base64url').toString('utf8')) as { generation: number };
    expect(payload.generation).toBe(1);
  });

  testOn('SMTP 失败后重启：全量 signed-payload 与 stamp 字节完全一致', async () => {
    isolateJournal();
    let now = START;
    let firstAttemptHeaders: Record<string, string | undefined> | undefined;
    const sent: SendInput[] = [];
    let failOnce = true;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      if (failOnce) {
        failOnce = false;
        firstAttemptHeaders = { ...input.headers };
        throw new Error('smtp_down');
      }
      sent.push(input);
      return { messageId: `<rs-${sent.length}>` };
    });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({ message: 'smtp_down' });
    expect(firstAttemptHeaders).toBeDefined();
    resetJournalMemoryForTests();
    clearQueuedEventsForTests();
    now = START + 16 * 60 * 1000;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.['X-OA-Task-Lease-Payload']).toBe(firstAttemptHeaders?.['X-OA-Task-Lease-Payload']);
    expect(sent[0]?.headers?.['X-OA-Task-Stamp']).toBe(firstAttemptHeaders?.['X-OA-Task-Stamp']);
    expect(sent[0]?.headers?.['X-OA-Task-Lease-Event']).toBe(firstAttemptHeaders?.['X-OA-Task-Lease-Event']);
  });

  bunTest('负控：无 journal 时内存清空后会重分配', async () => {
    await withM2Off(async () => {
      isolateJournal();
      let durable = submittedTask();
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async () => ({ messageId: '<off>' }));
      await claimTask({ id: ID, from: B, leaseSec: 300 });
      clearQueuedEventsForTests();
      const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
      expect(second.leaseGeneration).toBe(1);
    });
  });
});

describe('M2-2 crash 边界 fail-closed', () => {
  testOn('journal 短写后不得发放成功代', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<crash>' }));
    setJournalCrashHookForTests('short-write');
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_journal_crash_short_write',
    });
    setJournalCrashHookForTests(null);
    resetJournalMemoryForTests();
    clearQueuedEventsForTests();
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grant.leaseGeneration).toBe(1);
  });

  testOn('热进程下磁盘丢失：claimTask 抛出 lease_journal_lost，磁盘不得被重建，状态永久 latch', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    const paths = journalPathsForTests();

    // 模拟热进程正在运行，外部或硬件导致磁盘 journal 被删
    unlinkSync(paths.journal);
    // 注意：绝不调用 resetJournalMemoryForTests()

    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_journal_lost',
    });

    // 磁盘绝未被重新创建
    expect(existsSync(paths.journal)).toBe(false);

    // 再次调用仍然 fail-closed
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_journal_lost',
    });
  });

  testOn('before-write 失败后不重置内存：零 SMTP，重试成功后才发送且 intent 已落盘', async () => {
    isolateJournal();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<retry-${sent.length}>` };
    });
    setJournalCrashHookForTests('before-write');
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_journal_crash_before_write',
    });
    expect(sent).toHaveLength(0);
    expect(unresolvedClaimFence(ID)).toBeUndefined();
    const empty = JSON.parse(readFileSync(journalPathsForTests().journal, 'utf8')) as { records: unknown[] };
    expect(empty.records).toEqual([]);

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grant.leaseGeneration).toBe(1);
    expect(sent).toHaveLength(1);
    const live = await loadLeaseJournal();
    expect(live.records.some((row) => row.taskId === ID && row.generation === 1)).toBe(true);
  });
});

describe('PR181 R1 A/D/E/F/G/H/I/J', () => {
  testOn('A: nonempty release reason survives restart hydration and keeps firstClaimedAt', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<a>' }));
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claimRow = (await loadLeaseJournal()).records.find((row) => row.kind === 'claim');
    expect(claimRow).toBeDefined();
    await markJournalFate(claimRow!, 'indexed');
    setTaskGetForTests(async () => grant.task);
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff-complete' });
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const file = await loadLeaseJournal();
    const rel = file.records.find((row) => row.kind === 'release');
    expect(rel?.reason).toBe('handoff-complete');
    expect(rel?.firstClaimedAt).toBe('2026-08-24T00:00:00.000Z');
    const view = await getTask(ID);
    expect(view?.releasedLease?.reason).toBe('handoff-complete');
    expect(view?.releasedLease?.firstClaimedAt).toBe('2026-08-24T00:00:00.000Z');
  });

  testOn('D: crash-before-SMTP release does not clear durable lease or allow N+1', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<d>' }));
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claimRow = (await loadLeaseJournal()).records.find((row) => row.kind === 'claim');
    expect(claimRow).toBeDefined();
    await markJournalFate(claimRow!, 'indexed');
    setTaskGetForTests(async () => grant.task);
    setPreSmtpHookForTests(async () => {
      throw new Error('killed_pre_smtp');
    });
    await expect(releaseTask({
      id: ID, from: B, leaseToken: grant.leaseToken, reason: 'pause',
    })).rejects.toMatchObject({ message: 'killed_pre_smtp' });
    setPreSmtpHookForTests(null);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const view = await getTask(ID);
    expect(view?.lease?.leaseGeneration).toBe(1);
    expect(view?.releasedLease).toBeUndefined();
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
  });

  testOn('E: unresolved tombstone retry reuses exact at/identity', async () => {
    isolateJournal();
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<e>' }));
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + TWO_H;
    setPostSmtpAcceptHookForTests(async () => {
      throw new Error('killed_after_accept');
    });
    await expect(claimLostTask({ id: ID })).rejects.toMatchObject({ message: 'killed_after_accept' });
    const first = (await loadLeaseJournal()).records.find((row) => row.kind === 'tombstone');
    expect(first?.fate).toBe('intent');
    const at = first!.at;
    const payload = first!.signedPayload;
    setPostSmtpAcceptHookForTests(null);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    await claimLostTask({ id: ID });
    const tombs = journalRecordsFor(ID).filter((row) => row.kind === 'tombstone');
    expect(tombs).toHaveLength(1);
    expect(tombs[0]?.at).toBe(at);
    expect(tombs[0]?.signedPayload).toBe(payload);
  });

  bunTest('F: journal off 时 durableGen 取 receipts 最大值', async () => {
    await withM2Off(async () => {
      isolateJournal();
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => ({
        ...submittedTask(),
        expiredLease: {
          leaseGeneration: 1,
          claimedUntil: '2026-08-24T00:05:00.000Z',
          expiredAt: '2026-08-24T00:05:00.000Z',
          firstClaimedAt: '2026-08-24T00:00:00.000Z',
        },
        lostLease: {
          leaseGeneration: 2,
          claimedUntil: '2026-08-24T00:05:00.000Z',
          lostAt: '2026-08-24T02:00:00.000Z',
          firstClaimedAt: '2026-08-24T00:00:00.000Z',
        },
      }));
      setTaskSendMailForTests(async () => ({ messageId: '<f>' }));
      const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
      expect(grant.leaseGeneration).toBe(3);
    });
  });

  testOn('G: tombstone accept 后 markFate 失败不得报成功', async () => {
    isolateJournal();
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<g>' }));
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + TWO_H;
    await upsertJournalRecord({
      taskId: ID,
      kind: 'tombstone',
      generation: 1,
      actor: 'server',
      at: '2026-08-24T02:00:00.000Z',
      fate: 'accepted',
      claimedUntil: '2026-08-24T00:05:00.000Z',
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    });
    setJournalCrashHookForTests('before-write');
    await expect(claimLostTask({ id: ID })).rejects.toMatchObject({
      message: 'lease_journal_crash_before_write',
    });
    expect(unresolvedClaimFence(ID)?.kind).toBe('claim');
  });

  testOn('H: restart 后 list/detail 对 accepted claim 投影一致且走 publicRead', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskListAllForTests(async () => [submittedTask()]);
    setTaskSendMailForTests(async () => ({ messageId: '<h>' }));
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const detail = await getTask(ID);
    expect(detail?.state).toBe('working');
    const board = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(board.tasks.find((row) => row.id === ID)?.state).toBe('working');
  });

  testOn('I: 成功重发后 fate=accepted，后续重试不再 SMTP', async () => {
    isolateJournal();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<i-${sent.length}>` };
    });
    setPostSmtpAcceptHookForTests(async () => {
      throw new Error('killed_after_accept');
    });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'killed_after_accept',
    });
    expect(sent).toHaveLength(1);
    setPostSmtpAcceptHookForTests(null);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
    expect(sent).toHaveLength(2);
    expect((await loadLeaseJournal()).records.find((row) => row.kind === 'claim')?.fate).toBe('accepted');
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_overlay_pending_index',
    });
    expect(sent).toHaveLength(2);
  });

  testOn('J: 授权读 journal 失败映射 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-m2-j503-'));
    setJournalDataDirForTests(dir);
    setTaskGetForTests(async () => submittedTask());
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'identity', address: B });
      await next();
    });
    app.route('/v1/tasks', createTaskRoutes());
    const res = await app.request(`/v1/tasks/${ID}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lease_journal_not_bootstrapped' });
  });
});

describe('PR181 R2 A/B/C/M', () => {
  testOn('B: children journal unavailable maps 503', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-m2-ch503-'));
    setJournalDataDirForTests(dir);
    setTaskListAllForTests(async () => [submittedTask()]);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'identity', address: B });
      await next();
    });
    app.route('/v1/tasks', createTaskRoutes());
    const res = await app.request(`/v1/tasks/${ID}/children`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lease_journal_not_bootstrapped' });
  });

  testOn('C: intent/unconfirmed fence recipient update/reply; sender and accepted-lease preserved', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskSendMailForTests(async () => ({ messageId: '<c-fence>' }));
    setTaskGetForTests(async () => submittedTask());
    await upsertJournalRecord({
      taskId: ID,
      kind: 'claim',
      generation: 1,
      actor: B,
      at: '2026-08-24T00:00:00.000Z',
      fate: 'intent',
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'c'.repeat(43),
    });
    await expect(updateTask({ id: ID, from: B, state: 'input-required' })).rejects.toMatchObject({
      message: 'task_already_terminal',
    });
    await expect(updateTask({
      id: ID, from: B, state: 'input-required', leaseToken: 'supplied-bearer',
    })).rejects.toMatchObject({ message: 'task_lease_required' });
    await expect(updateTask({ id: ID, from: A, state: 'input-required' })).resolves.toMatchObject({
      state: 'input-required',
    });

    setTaskGetForTests(async () => ({ ...submittedTask(), state: 'input-required' }));
    await upsertJournalRecord({
      taskId: ID,
      kind: 'claim',
      generation: 1,
      actor: B,
      at: '2026-08-24T00:00:00.000Z',
      fate: 'unconfirmed',
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'c'.repeat(43),
    });
    await expect(replyTask({ id: ID, from: B, body: 'no' })).rejects.toMatchObject({
      message: 'task_already_terminal',
    });
    await expect(replyTask({ id: ID, from: A, body: 'sender-ok' })).resolves.toMatchObject({
      state: 'working',
    });

    clearQueuedEventsForTests();
    isolateJournal();
    setTaskGetForTests(async () => submittedTask());
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    setTaskGetForTests(async () => grant.task);
    await expect(updateTask({
      id: ID, from: B, state: 'input-required', leaseToken: grant.leaseToken,
    })).resolves.toMatchObject({ state: 'input-required' });
  });

  bunTest('A: leftover indexed claim does not suppress expired intent', async () => {
    await withM2M3(async () => {
      isolateJournal();
      let now = START;
      setTaskNowForTests(() => now);
      setTaskSendMailForTests(async () => ({ messageId: '<a-exp>' }));
      setTaskGetForTests(async () => submittedTask());
      setJournalExitEvidenceForTests(async () => ({
        hadMatchingRows: false,
        reconstructed: false,
        leaseGeneration: 0,
        releasedGeneration: 0,
        expiredGeneration: 0,
        lostGeneration: 0,
        tombstones: [],
      }));
      const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const claimRow = (await loadLeaseJournal()).records.find((row) => row.kind === 'claim');
      expect(claimRow?.fate).toBe('accepted');
      await markJournalFate(claimRow!, 'indexed');
      expect(journalSuppressesExpiry(ID, 1, grant.claimedUntil)).toBe(false);
      now = Date.parse(grant.claimedUntil) + 1000;
      setTaskGetForTests(async () => grant.task);
      await claimTask({ id: ID, from: B, leaseSec: 300 });
      const expired = journalRecordsFor(ID).find((row) => row.kind === 'expired');
      expect(expired?.fate).toBe('intent');
      expect(expired?.claimedUntil).toBe(grant.claimedUntil);
    });
  });

  testOn('M: claim_lost without claimedUntil is not eligible', async () => {
    isolateJournal();
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    await upsertJournalRecord({
      taskId: ID,
      kind: 'claim',
      generation: 1,
      actor: B,
      at: '2026-08-24T00:00:00.000Z',
      fate: 'intent',
      tokenVerifier: 'm'.repeat(43),
    });
    now = START + TWO_H;
    await expect(claimLostTask({ id: ID })).rejects.toMatchObject({
      message: 'lease_claim_lost_not_eligible',
    });
  });
});

describe('PR181 R2 D list bound', () => {
  testOn('D: N exact-eligible accepted rows use one persist and at most one fresh lookup', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    const one = durableWithLease(ID, 1);
    const two = durableWithLease(ID2, 1);
    setTaskListAllForTests(async () => [one, two]);
    await upsertJournalRecord(acceptedClaim(ID));
    await upsertJournalRecord(acceptedClaim(ID2, 1, '2026-08-24T00:00:01.000Z'));
    setJournalExitEvidenceForTests(async () => ineligibleExitEvidence());
    const beforePersist = journalPersistCountForTests();
    const beforeQuery = journalExitEvidenceQueryCountForTests();
    const board = await listAllAdmin();
    expect(board.tasks.map((row) => row.id).sort()).toEqual([ID, ID2].sort());
    const persistDelta = journalPersistCountForTests() - beforePersist;
    const queryDelta = journalExitEvidenceQueryCountForTests() - beforeQuery;
    // Exercised fresh lookup (not vacuous 0): ineligible evidence skips exit persist.
    expect(queryDelta).toBe(1);
    expect(persistDelta).toBe(1);
    expect(persistDelta).toBeLessThanOrEqual(2);
    expect(queryDelta).toBeLessThanOrEqual(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('indexed');
    expect(journalRecordsFor(ID2).find((row) => row.kind === 'claim')?.fate).toBe('indexed');
  });

  testOn('D: exact-receipt eventIsIndexed retires without requiring domination', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    const before = journalPersistCountForTests();
    await listAllAdmin();
    expect(journalPersistCountForTests() - before).toBe(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('indexed');
  });

  testOn('D: domination eventIsIndexed retires without requiring exact same receipt', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 2)]);
    await upsertJournalRecord(acceptedClaim(ID, 1));
    const before = journalPersistCountForTests();
    await listAllAdmin();
    expect(journalPersistCountForTests() - before).toBe(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim' && row.generation === 1)?.fate).toBe('indexed');
  });

  testOn('D: same taskId retires only the matching row', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 2)]);
    await upsertJournalRecord(acceptedClaim(ID, 1, '2026-08-24T00:00:00.000Z'));
    await upsertJournalRecord({
      taskId: ID,
      kind: 'renew',
      generation: 2,
      actor: B,
      at: '2026-08-24T00:01:00.000Z',
      fate: 'accepted',
      claimedUntil: UNTIL,
      tokenVerifier: OTHER_VERIFIER,
    });
    const beforePersist = journalPersistCountForTests();
    const beforeQuery = journalExitEvidenceQueryCountForTests();
    await listAllAdmin();
    expect(journalPersistCountForTests() - beforePersist).toBe(1);
    expect(journalExitEvidenceQueryCountForTests() - beforeQuery).toBe(0);
    const rows = journalRecordsFor(ID);
    // Matching gen-1 claim was eligible → indexed, then existing compact() drops
    // dominated+retired non-tombstone rows (generation 1 < maxGen 2). Absence is
    // compact retirement, not a failed eligibility mark. Bad eligibility would
    // leave fate 'accepted' and compact would keep the row.
    expect(rows.find((row) => row.kind === 'claim')).toBeUndefined();
    expect(rows.some((row) => row.kind === 'claim' && row.fate === 'accepted')).toBe(false);
    // Unmatched OPEN renew must stay accepted. Do not weaken this.
    expect(rows.find((row) => row.kind === 'renew')?.fate).toBe('accepted');
    expect(rows.filter((row) => row.fate === 'accepted')).toHaveLength(1);
  });

  testOn('D: empty after queue revalidation does not persist; list still 200', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    await loadLeaseJournal();
    const rec = journalRecordsFor(ID).find((row) => row.kind === 'claim')!;
    const before = journalPersistCountForTests();
    await batchRetireAcceptedIndexedRows([{
      taskId: rec.taskId,
      kind: rec.kind,
      generation: rec.generation,
      at: rec.at,
      snapshot: `${journalCanonicalSnapshotFor(ID)}-stale`,
    }]);
    expect(journalPersistCountForTests() - before).toBe(0);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('accepted');
    setTaskListAllForTests(async () => [submittedTask()]);
    const beforeList = journalPersistCountForTests();
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalPersistCountForTests() - beforeList).toBe(0);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('accepted');
  });

  testOn('D: journal lost on batch reload throws unavailable', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalBeforeBatchCommitForTests(() => {
      unlinkSync(journalPathsForTests().journal);
    });
    await expect(listAllAdmin()).rejects.toMatchObject({ message: 'lease_journal_lost' });
  });

  testOn('D: proven short-write before rename returns list without fate claim', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    const before = journalPersistCountForTests();
    setJournalWriteChunkForTests(0);
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalPersistCountForTests() - before).toBe(0);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('accepted');
  });

  testOn('D: post-publication after-rename is unavailable not list success', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalCrashHookForTests('after-rename');
    await expect(listAllAdmin()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  testOn('D: ordinary fresh lookup failure keeps list 200 after successful batch', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalExitEvidenceForTests(async () => {
      throw new JournalError('lease_journal_exit_evidence_timeout');
    });
    const beforePersist = journalPersistCountForTests();
    const beforeQuery = journalExitEvidenceQueryCountForTests();
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalExitEvidenceQueryCountForTests() - beforeQuery).toBe(1);
    expect(journalPersistCountForTests() - beforePersist).toBe(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('indexed');
  });

  testOn('D: optional exit persist after-rename propagates 503; lookup is exercised', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalExitEvidenceForTests(async () => eligibleExitEvidence(1));
    setJournalBeforeExitCommitForTests(() => {
      setJournalCrashHookForTests('after-rename');
    });
    const beforeQuery = journalExitEvidenceQueryCountForTests();
    await expect(listAllAdmin()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    expect(journalExitEvidenceQueryCountForTests() - beforeQuery).toBe(1);
  });

  testOn('D: non-list mutation still swallows exit post-rename (1970 original success)', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    const rec = await upsertJournalRecord(acceptedClaim(ID));
    setJournalExitEvidenceForTests(async () => eligibleExitEvidence(1));
    setJournalBeforeExitCommitForTests(() => {
      setJournalCrashHookForTests('after-rename');
    });
    await expect(markJournalFate(rec, 'indexed')).resolves.toMatchObject({ fate: 'indexed' });
  });

  testOn('D: concurrent same-key mutation before selection keeps changed accepted row OPEN', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalBeforeListSelectionForTests(async () => {
      await upsertJournalRecord({
        ...acceptedClaim(ID),
        tokenVerifier: OTHER_VERIFIER,
      });
    });
    const beforePersist = journalPersistCountForTests();
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    // Concurrent upsert is one persist; list batch must not add a second.
    expect(journalPersistCountForTests() - beforePersist).toBe(1);
    const claim = journalRecordsFor(ID).find((row) => row.kind === 'claim');
    expect(claim?.fate).toBe('accepted');
    expect(claim?.tokenVerifier).toBe(OTHER_VERIFIER);
  });

  testOn('D: successful exit uses one fresh lookup and two persists', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalExitEvidenceForTests(async () => eligibleExitEvidence(1));
    const beforePersist = journalPersistCountForTests();
    const beforeQuery = journalExitEvidenceQueryCountForTests();
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalExitEvidenceQueryCountForTests() - beforeQuery).toBe(1);
    expect(journalPersistCountForTests() - beforePersist).toBe(2);
    expect(journalRecordsFor(ID)).toEqual([]);
  });

  testOn('B: uncertain post-publication persist latches and invalidates cache', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalCrashHookForTests('after-rename');
    await expect(listAllAdmin()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    // No reset: the synchronous cache reader must fail closed, never serve pre-uncertainty state.
    expect(() => cloneLoadedLeaseJournal()).toThrow('lease_journal_corrupt');
    // Latched: later operations fail closed without waiting for a reload mismatch.
    await expect(listAllAdmin()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    await expect(upsertJournalRecord(acceptedClaim(ID))).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  testOn('B: verified unchanged prepublication failure stays unlatched', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLease(ID, 1)]);
    await upsertJournalRecord(acceptedClaim(ID));
    setJournalWriteChunkForTests(0);
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('accepted');
    // Proven pre-publication failure must not poison cache or latch the journal.
    expect(() => cloneLoadedLeaseJournal()).not.toThrow();
    setJournalWriteChunkForTests(null);
    const again = await listAllAdmin();
    expect(again.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'claim')?.fate).toBe('indexed');
  });

  testOn('C: durable lostLease dominates equal and older queued claims, never newer', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLostLease(ID, 2)]);
    await upsertJournalRecord(acceptedClaim(ID, 1, '2026-08-24T00:00:00.000Z'));
    await upsertJournalRecord(acceptedClaim(ID, 2, '2026-08-24T00:10:00.000Z'));
    await upsertJournalRecord(acceptedClaim(ID, 3, '2026-08-24T00:20:00.000Z'));
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    const rows = journalRecordsFor(ID);
    // Equal (gen2) and older (gen1) queued claims retire against the durable
    // tombstone; the dominating gen3 row compacts them away in the same persist
    // (compact(): dominated && retired && kind !== 'tombstone' is dropped).
    const openGenerations = (list: typeof rows) => list
      .filter((row) => row.fate === 'intent' || row.fate === 'unconfirmed' || row.fate === 'accepted')
      .map((row) => row.generation);
    expect(openGenerations(rows)).toEqual([3]);
    expect(rows.some((row) => row.generation === 1 || row.generation === 2)).toBe(false);
    // A newer generation is never dominated by an older tombstone.
    expect(rows.find((row) => row.generation === 3)?.fate).toBe('accepted');
    // No-revival: burned generations are not projected as authority; only gen3 is.
    expect(board.tasks[0]?.leaseGeneration).toBe(3);
    // And they never reappear on later reads (retirement sticks, nothing replays).
    const again = await listAllAdmin();
    expect(again.tasks[0]?.leaseGeneration).toBe(3);
    const later = journalRecordsFor(ID);
    expect(openGenerations(later)).toEqual([3]);
    expect(later.some((row) => row.generation === 1 || row.generation === 2)).toBe(false);
  });

  testOn('C clause2 (2074-strict): older accepted tombstone without an exact receipt is NOT retired', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskListAllForTests(async () => [durableWithLostLease(ID, 2)]);
    await upsertJournalRecord({
      taskId: ID,
      kind: 'tombstone',
      generation: 1,
      actor: 'server',
      at: '2026-08-24T01:00:00.000Z',
      fate: 'accepted',
      claimedUntil: UNTIL,
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    });
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    // 2074-strict: no gen1 authenticated receipt exists; dominance over a newer
    // durable lostLease is NOT indexing proof — the row stays OPEN.
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('accepted');
    // Replay is projection-only: repeated reads perform no persist.
    const beforePersist = journalPersistCountForTests();
    const again = await listAllAdmin();
    expect(again.tasks).toHaveLength(1);
    expect(journalPersistCountForTests() - beforePersist).toBe(0);
  });

  testOn('C: newer durable lostLease does not hide a queued newer claim on detail', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => durableWithLostLease(ID, 1));
    await upsertJournalRecord(acceptedClaim(ID, 2, '2026-08-24T00:10:00.000Z'));
    const detail = await getTask(ID);
    expect(detail?.lease?.leaseGeneration).toBe(2);
    expect(journalRecordsFor(ID).find((row) => row.generation === 2)?.fate).toBe('accepted');
  });
});

describe('M2-3 claim_lost', () => {
  testOn('2h 前拒绝；到期后烧掉未决代，迟到 claim 不复活权威', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<lost-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    await expect(claimLostTask({ id: ID })).rejects.toMatchObject({ message: 'lease_claim_lost_too_early' });
    now = START + TWO_H;
    const after = await claimLostTask({ id: ID });
    expect(after.lostLease?.leaseGeneration).toBe(1);
    expect(['submitted', 'working']).toContain(after.state);
    const tombstone = await parseCaptured(sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'claim_lost')!, 2);
    const claim1 = await parseCaptured(sent[0]!, 3);
    durable = taskFromMessages(ID, [submittedRaw(), tombstone!, claim1!])!;
    expect(durable.lease).toBeUndefined();
    expect(durable.lostLease?.leaseGeneration).toBe(1);
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const next = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(next.leaseGeneration).toBe(2);
    expect(next.task.lease?.firstClaimedAt).toBe('2026-08-24T00:00:00.000Z');
    const rebuilt = taskFromMessages(ID, [submittedRaw(), tombstone!, claim1!, (await parseCaptured(sent.at(-1)!, 4))!])!;
    expect(rebuilt.lease?.leaseGeneration).toBe(2);
    expect(oldReaderFromMessages(ID, [submittedRaw(), tombstone!, (await parseCaptured(sent.at(-1)!, 4))!])).toBeNull();
  });

  testOn('非 admin 403；伪造 stamp 不能入账', async () => {
    isolateJournal();
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'identity', address: B });
      await next();
    });
    const service: TaskService = {
      async create() { throw new Error('unused'); },
      async list() { return []; },
      async listBoard() { throw new Error('unused'); },
      async get() { return submittedTask(); },
      async getForAuthorization() { return submittedTask(); },
      async update() { throw new Error('unused'); },
      async reply() { throw new Error('unused'); },
      async remind() { throw new Error('unused'); },
      async close() { throw new Error('unused'); },
      async waitForTerminal() { return null; },
    };
    app.route('/v1/tasks', createTaskRoutes({
      service,
      findIdentity: (address) => ({ address, createdAt: '2026-08-24T00:00:00.000Z' }),
    }));
    const res = await app.request(`/v1/tasks/${ID}/claim-lost`, { method: 'POST' });
    expect(res.status).toBe(403);
    const forged = claimLeaseHeadersForTests({
      id: ID, state: 'working', from: A, to: B,
      event: {
        version: 1, event: 'claim_lost', actor: 'server',
        at: '2026-08-24T02:00:00.000Z', generation: 1,
        claimedUntil: '2026-08-24T00:05:00.000Z',
        firstClaimedAt: '2026-08-24T00:00:00.000Z',
      },
    });
    forged['X-OA-Task-Stamp'] = 'deadbeef';
    const parsed = await parseTaskMessageForTests({
      uid: 9,
      source: source({ from: A, to: [B], subject: 'x', text: 'x', headers: forged }),
      envelope: { from: [{ address: A }], to: [{ address: B }], subject: 'x' },
      internalDate: new Date(START),
    } as unknown as FetchMessageObject, ID);
    expect(parsed).toBeNull();
  });
});

describe('M2-4 emitter 硬禁不可达', () => {
  bunTest('journal ON 时生产发射器硬禁：不发出任何 expired 审计邮件', async () => {
    await withM2M3(async () => {
      isolateJournal();
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<rn-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      durable = {
        ...first.task,
      };
      setTaskGetForTests(async () => durable);
      const renewed = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 });
      durable = renewed;
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      clearQueuedEventsForTests();
      resetJournalMemoryForTests();
      now = Date.parse(first.claimedUntil);
      expect(await emitPendingExpiryAuditsOnce()).toBe(0);
      now = Date.parse(renewed.lease!.claimedUntil) + 1000;
      durable = { ...durable, lease: { ...durable.lease! } };
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      const n = await emitPendingExpiryAuditsOnce();
      expect(n).toBe(0);
      const expiry = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
      expect(expiry).toHaveLength(0);
    });
  });
});

describe('M2-5 reclaim 不被审计 SMTP 挡住', () => {
  bunTest('M2+M3：审计 SMTP 挂起时仍能 claim 下一代', async () => {
    await withM2M3(async () => {
      isolateJournal();
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        if (input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
          await new Promise(() => undefined);
        }
        sent.push(input);
        return { messageId: `<rc-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      setTaskGetForTests(async () => durable);
      clearQueuedEventsForTests();
      now = Date.parse(first.claimedUntil);
      const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
      expect(second.leaseGeneration).toBe(2);
      expect(await reapExpiredTaskLeasesOnce()).toBe(0);
      expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired')).toHaveLength(0);
    });
  });
});

describe('P1-B 迟到 renew / release 历史和解与负控矩阵', () => {
  testOn('正向：claim(1) -> tombstone(1) -> claim(2) -> 迟到 renew(1) 和解历史窗，不改变代2权威', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m-${sent.length}>` };
    });
    const claim1 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg])!;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const claim2 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const expired1Msg = (await parseCaptured(sent[2]!, 4))!;
    const claim2Msg = (await parseCaptured(sent[3]!, 5))!;
    expect(claim2.leaseGeneration).toBe(2);

    const renew1At = new Date(START + 200 * 1000).toISOString();
    const renew1Until = new Date(START + 600 * 1000).toISOString();
    const renew1Headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1,
        event: 'renew',
        actor: B,
        at: renew1At,
        generation: 1,
        claimedUntil: renew1Until,
        tokenVerifier: claim1.task.lease!.tokenVerifier!,
      },
    });
    const renew1Msg = (await parseCaptured({ from: B, to: [A], subject: 'Lease renew', text: 'renew', headers: renew1Headers }, 6))!;

    const reconstructed = taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg, expired1Msg, claim2Msg, renew1Msg]);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.lease?.leaseGeneration).toBe(2);
  });

  testOn('正向：claim(1) -> claim(2) -> 迟到 release(1) 和解历史释放，不篡夺代2权威', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m-${sent.length}>` };
    });
    const claim1 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + 300 * 1000;
    durable = taskFromMessages(ID, [submittedRaw(), claim1Msg])!;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const claim2 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const expired1Msg = (await parseCaptured(sent[1]!, 3))!;
    const claim2Msg = (await parseCaptured(sent[2]!, 4))!;
    expect(claim2.leaseGeneration).toBe(2);

    const release1At = new Date(START + 250 * 1000).toISOString();
    const release1Headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1,
        event: 'release',
        actor: B,
        at: release1At,
        generation: 1,
        tokenVerifier: claim1.task.lease!.tokenVerifier!,
        reason: 'done',
      },
    });
    const release1Msg = (await parseCaptured({ from: B, to: [A], subject: 'Lease release', text: 'release', headers: release1Headers }, 5))!;

    const reconstructed = taskFromMessages(ID, [submittedRaw(), claim1Msg, expired1Msg, claim2Msg, release1Msg]);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.lease?.leaseGeneration).toBe(2);
    expect(reconstructed!.releasedLease).toBeUndefined();
  });

  testOn('负控：仅 tombstone 无 durable claim 时，迟到 renew/release 必 fail-closed (return null)', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 2))!;
    durable = taskFromMessages(ID, [submittedRaw(), tombstoneMsg])!;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const claim2 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim2Msg = (await parseCaptured(sent[2]!, 3))!;

    const renew1Headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1,
        event: 'renew',
        actor: B,
        at: new Date(START + 200 * 1000).toISOString(),
        generation: 1,
        claimedUntil: new Date(START + 600 * 1000).toISOString(),
        tokenVerifier: '0'.repeat(43),
      },
    });
    const fakeRenewMsg = (await parseCaptured({ from: B, to: [A], subject: 'Lease renew', text: 'renew', headers: renew1Headers }, 4))!;
    expect(taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim2Msg, fakeRenewMsg])).toBeNull();

    const release1Headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1,
        event: 'release',
        actor: B,
        at: new Date(START + 200 * 1000).toISOString(),
        generation: 1,
        tokenVerifier: '0'.repeat(43),
        reason: 'done',
      },
    });
    const fakeReleaseMsg = (await parseCaptured({ from: B, to: [A], subject: 'Lease release', text: 'release', headers: release1Headers }, 5))!;
    expect(taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim2Msg, fakeReleaseMsg])).toBeNull();
  });

  testOn('负控：迟到 renew/release 验签错误或超出时间窗必 fail-closed (return null)', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m-${sent.length}>` };
    });
    const claim1 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg])!;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    resetJournalMemoryForTests();
    const claim2 = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim2Msg = (await parseCaptured(sent[2]!, 4))!;

    const badVerifierRenew = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1, event: 'renew', actor: B,
        at: new Date(START + 200 * 1000).toISOString(),
        generation: 1, claimedUntil: new Date(START + 600 * 1000).toISOString(),
        tokenVerifier: 'wrong-verifier-length-is-valid-base64url-padding-safe',
      },
    });
    const badVerifierMsg = (await parseCaptured({ from: B, to: [A], subject: 'r', text: 'r', headers: badVerifierRenew }, 5))!;
    expect(taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg, claim2Msg, badVerifierMsg])).toBeNull();

    const lateAtRenew = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1, event: 'renew', actor: B,
        at: new Date(START + 350 * 1000).toISOString(),
        generation: 1, claimedUntil: new Date(START + 600 * 1000).toISOString(),
        tokenVerifier: claim1.task.lease!.tokenVerifier!,
      },
    });
    const lateAtMsg = (await parseCaptured({ from: B, to: [A], subject: 'r', text: 'r', headers: lateAtRenew }, 6))!;
    expect(taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg, claim2Msg, lateAtMsg])).toBeNull();

    const lateRelease = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1, event: 'release', actor: B,
        at: new Date(START + 350 * 1000).toISOString(),
        generation: 1, tokenVerifier: claim1.task.lease!.tokenVerifier!,
        reason: 'late',
      },
    });
    const lateReleaseMsg = (await parseCaptured({ from: B, to: [A], subject: 'r', text: 'r', headers: lateRelease }, 7))!;
    expect(taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg, claim2Msg, lateReleaseMsg])).toBeNull();
  });
});

describe('M2-6 兼容面', () => {
  testOn('M1 公共投影不含 lostLease / token', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<p>' }));
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const view = toTaskView(grant.task);
    expect(view).not.toHaveProperty('lostLease');
    expect(view).not.toHaveProperty('leaseToken');
    expect(view.leaseGeneration).toBe(1);
    expect(isTaskLeaseTokenCurrent(grant.task, grant.leaseToken)).toBe(true);
  });

  bunTest('M2 off 时 claim 成功且不写 journal 错误', async () => {
    await withM2Off(async () => {
      isolateJournal();
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async () => ({ messageId: '<off2>' }));
      const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
      expect(grant.leaseGeneration).toBe(1);
    });
  });
});

describe('R4-BC old-deadline pending-renew recovery', () => {
  function renewIntentRow(verifier: string, fate: 'intent' | 'unconfirmed' | 'accepted' = 'intent') {
    return {
      taskId: ID,
      kind: 'renew' as const,
      generation: 1,
      actor: B,
      at: '2026-08-24T00:01:00.000Z',
      fate,
      claimedUntil: '2026-08-24T01:00:00.000Z',
      tokenVerifier: verifier,
    };
  }

  testOn('B: old-deadline retry recovers exact pending renew (resend + accepted), replacement still blocked', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<bc-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    // Constructed fixture standing in for the accepted-but-uncommitted state
    // (a manually seeded intent row, NOT a real SMTP crash reproduction).
    const seeded = renewIntentRow(durable.lease!.tokenVerifier!);
    await upsertJournalRecord(seeded);
    // The old durable deadline passes; neither the 24h generation cap nor the
    // seven-day task cap is near.
    now = Date.parse(first.claimedUntil) + 1000;
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    // The exact immutable renew identity was resent once and marked accepted.
    const renewMail = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'renew');
    expect(renewMail).toHaveLength(1);
    const acceptedRow = journalRecordsFor(ID).find((row) => row.kind === 'renew');
    expect(acceptedRow?.fate).toBe('accepted');
    // Immutable identity proof: every identity field of the recovered row is
    // byte-identical to the seeded pending row — only fate changed.
    expect(acceptedRow).toMatchObject({
      kind: seeded.kind,
      generation: seeded.generation,
      actor: seeded.actor,
      at: seeded.at,
      claimedUntil: seeded.claimedUntil,
      tokenVerifier: seeded.tokenVerifier,
    });
    // The resent payload carries the same event identity and the ORIGINAL
    // deadline — nothing minted, nothing extended.
    const renewMsg = (await parseCaptured(renewMail[0]!, 7))!;
    expect(renewMsg?.lease).toMatchObject({
      event: 'renew',
      generation: seeded.generation,
      at: seeded.at,
      claimedUntil: seeded.claimedUntil,
      tokenVerifier: seeded.tokenVerifier,
    });
    // Recovery clears the stale rejection, NOT the fence: a replacement claim
    // is still blocked while the recovered authority is active and unindexed.
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
  });

  testOn('B: accepted pending renew replays via overlay; retry reports pending index without resend', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<bca-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    await upsertJournalRecord(renewIntentRow(durable.lease!.tokenVerifier!, 'accepted'));
    now = Date.parse(first.claimedUntil) + 1000;
    const before = sent.length;
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    expect(sent).toHaveLength(before);
  });

  testOn('B: stale matrix — wrong bearer, identity mismatch, no pending, caps never bypassed', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<bcn-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    const verifier = durable.lease!.tokenVerifier!;
    await upsertJournalRecord(renewIntentRow(verifier));
    now = Date.parse(first.claimedUntil) + 1000;
    // Wrong bearer is rejected at authentication, before any recovery.
    await expect(renewTask({ id: ID, from: B, leaseToken: 'wrong-token', leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'stale_lease' });
    // Identity mismatch: a pending renew under a different verifier is not recovered.
    resetJournalMemoryForTests();
    isolateJournal();
    await upsertJournalRecord(renewIntentRow(OTHER_VERIFIER));
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'stale_lease' });
    // No pending renew at all: plain stale rejection, unchanged.
    resetJournalMemoryForTests();
    isolateJournal();
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'stale_lease' });
    // Caps are never bypassed: past the 24h generation cap, no recovery happens
    // even with an exact matching pending renew.
    resetJournalMemoryForTests();
    isolateJournal();
    await upsertJournalRecord(renewIntentRow(verifier));
    now = START + 24 * 60 * 60 * 1000 + 1000;
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'stale_lease' });
    expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'renew')).toHaveLength(0);
    // Seven-day task cap likewise.
    now = START + 7 * 24 * 60 * 60 * 1000 + 1000;
    await expect(renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 3600 }))
      .rejects.toMatchObject({ message: 'stale_lease' });
    expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'renew')).toHaveLength(0);
  });
});

describe('R4-A tombstone row retirement (ORDER-2074)', () => {
  function tombstoneRow(at: string, generation = 1, fate: 'intent' | 'accepted' = 'accepted') {
    return {
      taskId: ID,
      kind: 'tombstone' as const,
      generation,
      actor: 'server' as const,
      at,
      fate,
      claimedUntil: UNTIL,
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    };
  }

  testOn('A2074: claim-before-tombstone UID order retires the exact row, preserves authority, no re-persist', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<a71-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    // Claim indexes BEFORE its tombstone: reconstruction keeps the claim
    // authoritative; the authenticated tombstone is a historical no-op.
    durable = taskFromMessages(ID, [submittedRaw(), claim1Msg, tombstoneMsg])!;
    expect(durable.lease?.leaseGeneration).toBe(1);
    expect(durable.lostLease).toBeUndefined();
    setTaskListAllForTests(async () => [durable]);
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    // The accepted tombstone journal row retires on exact authenticated identity.
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('tombstoned');
    // Current authority is preserved internally, never rolled back: the durable
    // lease stays authoritative and no lostLease is fabricated. (The public
    // projection hides the already-expired window by design.)
    const detail = await getTask(ID);
    expect(detail?.lease?.leaseGeneration).toBe(1);
    expect(detail?.lostLease).toBeUndefined();
    // No revival and no re-persist on repeated reads.
    const before = journalPersistCountForTests();
    const again = await listAllAdmin();
    expect(again.tasks).toHaveLength(1);
    expect(journalPersistCountForTests() - before).toBe(0);
  });

  testOn('A2074: tombstone-before-claim UID order also retires; newer generation never rolled back', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<a72-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 3))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 2))!;
    // Tombstone indexes first (earlier UID); the late claim reconciles history only.
    durable = taskFromMessages(ID, [submittedRaw(), tombstoneMsg, claim1Msg])!;
    expect(durable.lostLease?.leaseGeneration).toBe(1);
    // A newer accepted claim exists only in the journal so far, with a live window.
    await upsertJournalRecord({
      ...acceptedClaim(ID, 2, '2026-08-24T02:30:00.000Z'),
      claimedUntil: '2026-08-24T05:00:00.000Z',
    });
    setTaskListAllForTests(async () => [durable]);
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('tombstoned');
    const gen2 = journalRecordsFor(ID).find((row) => row.kind === 'claim' && row.generation === 2);
    expect(gen2?.fate).toBe('accepted');
    expect(board.tasks[0]?.leaseGeneration).toBe(2);
  });

  testOn('A2078: terminal with exact authenticated history retires; different identity stays OPEN; receipts never leak', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<a78-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    const completedRaw: RawTaskMessage = {
      uid: 4, from: B, to: A, subject: 'done', date: '2026-08-24T02:30:00.000Z',
      state: 'completed', body: 'done',
    };
    // Real reconstruction: claim first (authority), tombstone as authenticated
    // historical no-op, then terminal — receipts preserved privately (2078 cl3).
    durable = taskFromMessages(ID, [submittedRaw(), claim1Msg, tombstoneMsg, completedRaw])!;
    expect(durable.state).toBe('completed');
    expect(durable.tombstoneReceipts).toHaveLength(1);
    // A second journal tombstone whose identity matches no receipt.
    await upsertJournalRecord(tombstoneRow('2026-08-24T03:33:00.000Z'));
    setTaskListAllForTests(async () => [durable]);
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    const rows = journalRecordsFor(ID).filter((row) => row.kind === 'tombstone');
    // Positive: exact authenticated history retires even on a terminal task.
    expect(rows.find((row) => row.at !== '2026-08-24T03:33:00.000Z')?.fate).toBe('tombstoned');
    // Negative: different/unauthenticated identity stays OPEN on the same task.
    expect(rows.find((row) => row.at === '2026-08-24T03:33:00.000Z')?.fate).toBe('accepted');
    // Non-disclosure: private receipts never reach public projections.
    expect(JSON.stringify(board.tasks[0])).not.toContain('tombstoneReceipts');
    expect(JSON.stringify(toTaskView(durable))).not.toContain('tombstoneReceipts');
    // No revival, no extra persist on repeated reads.
    const before = journalPersistCountForTests();
    const again = await listAllAdmin();
    expect(again.tasks).toHaveLength(1);
    expect(journalPersistCountForTests() - before).toBe(0);
  });

  testOn('A2074: same-generation lostLease or terminal without an exact receipt never retires', async () => {
    isolateJournal();
    setTaskNowForTests(() => START);
    // (a) Durable lostLease gen1 exists, but the journal row's identity matches
    // no authenticated receipt — generation-only evidence is not enough.
    setTaskListAllForTests(async () => [durableWithLostLease(ID, 1)]);
    await upsertJournalRecord(tombstoneRow('2026-08-24T03:33:00.000Z'));
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('accepted');
    // (b) Terminal task: terminality alone never retires a tombstone row.
    resetJournalMemoryForTests();
    isolateJournal();
    const terminal = { ...submittedTask(ID), state: 'completed' as const };
    setTaskListAllForTests(async () => [terminal]);
    await upsertJournalRecord(tombstoneRow('2026-08-24T02:00:00.000Z'));
    const board2 = await listAllAdmin();
    expect(board2.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('accepted');
  });

  testOn('A2074: missing evidence and wrong identity are never retired; same-generation claim is not proof', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<a73-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1Msg, tombstoneMsg])!;
    setTaskListAllForTests(async () => [durable]);
    // A journal tombstone whose `at` matches NO authenticated durable receipt
    // must survive every read — same-generation claim existence is not proof.
    await upsertJournalRecord(tombstoneRow('2026-08-24T03:33:00.000Z'));
    const board = await listAllAdmin();
    expect(board.tasks).toHaveLength(1);
    const tombstones = journalRecordsFor(ID).filter((row) => row.kind === 'tombstone');
    const forged = tombstones.find((row) => row.at === '2026-08-24T03:33:00.000Z');
    expect(forged?.fate).toBe('accepted');
    // The authentic row still retires on exact identity.
    expect(tombstones.find((row) => row.at !== '2026-08-24T03:33:00.000Z')?.fate).toBe('tombstoned');
    // And with NO durable tombstone evidence at all (claim only), nothing retires.
    const durableClaimOnly = taskFromMessages(ID, [submittedRaw(), claim1Msg])!;
    setTaskListAllForTests(async () => [durableClaimOnly]);
    resetJournalMemoryForTests();
    isolateJournal();
    await upsertJournalRecord(tombstoneRow('2026-08-24T02:00:00.000Z'));
    const board2 = await listAllAdmin();
    expect(board2.tasks).toHaveLength(1);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('accepted');
    expect(first.leaseToken).toBeString();
  });
});

describe('R5-A claimTask supersede skips tombstone rows', () => {
  testOn('R5-A: new claim never retires or annotates an unindexed tombstone row; exact receipt still retires on read', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r5-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1Msg = (await parseCaptured(sent[0]!, 2))!;
    now = START + TWO_H;
    await claimLostTask({ id: ID });
    const tombstoneMsg = (await parseCaptured(sent[1]!, 3))!;
    const tombAt = tombstoneMsg!.lease!.at;
    // Durable has not indexed the tombstone yet; the next claim sends.
    durable = { ...submittedTask(), state: 'working' as const };
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(second.leaseGeneration).toBe(2);
    // The unindexed tombstone row remains OPEN with complete identity and NO
    // supersededBy annotation — a newer claim's send is not indexing proof.
    const tombRow = journalRecordsFor(ID).find((row) => row.kind === 'tombstone');
    expect(tombRow?.fate).toBe('accepted');
    expect(tombRow?.at).toBe(tombAt);
    expect(tombRow?.generation).toBe(1);
    expect(tombRow?.supersededBy).toBeUndefined();
    // Claim-kind annotation behavior is preserved: the burned gen1 claim row
    // keeps its burn-flow fate and gains only the supersededBy marker.
    const claimRow = journalRecordsFor(ID).find((row) => row.kind === 'claim' && row.generation === 1);
    expect(claimRow?.fate).toBe('tombstoned');
    expect(claimRow?.supersededBy).toBe(2);
    // Expiry suppression reflects ACTUAL policy while the tombstone is OPEN:
    // an open tombstone row still suppresses the older window's expiry intent.
    expect(journalSuppressesExpiry(ID, 1, UNTIL)).toBe(true);
    // No receipt despite the newer claim: read paths do not retire it either.
    setTaskListAllForTests(async () => [durable]);
    await listAllAdmin();
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('accepted');
    // Once the exact authenticated durable receipt exists, read-path retirement works.
    durable = taskFromMessages(ID, [submittedRaw(), claim1Msg, tombstoneMsg!])!;
    setTaskListAllForTests(async () => [durable]);
    await listAllAdmin();
    expect(journalRecordsFor(ID).find((row) => row.kind === 'tombstone')?.fate).toBe('tombstoned');
  });
});

describe('R4-2132 unresolved renew recipient fence', () => {
  function liveRenewIntent(verifier: string) {
    return {
      taskId: ID,
      kind: 'renew' as const,
      generation: 1,
      actor: B,
      at: '2026-08-24T00:01:00.000Z',
      fate: 'intent' as const,
      claimedUntil: '2026-08-24T01:00:00.000Z',
      tokenVerifier: verifier,
    };
  }

  testOn('2132: recipient update/reply fenced by unresolved live renewal; bearer does not resolve; sender unaffected', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<n32-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    // Original claim is durably authoritative; the renewal was accepted by SMTP
    // (constructed fixture) but never committed.
    await upsertJournalRecord(liveRenewIntent(durable.lease!.tokenVerifier!));
    // While the EXISTING lease window is still active, established bearer
    // behavior is unchanged: the correct bearer passes and the new fence does
    // not engage.
    const renewedWhileActive = await updateTask({ id: ID, from: B, state: 'working', leaseToken: first.leaseToken });
    expect(renewedWhileActive?.state).toBe('working');
    clearQueuedEventsForTests();
    // Old deadline expires while the renewed window is still live: the
    // conservative gap fence now applies.
    durable = first.task;
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil) + 1000;

    // updateTask (recipient): omission is the opaque conflict, any supplied
    // bearer — including the genuinely valid one — is task_lease_required,
    // because an unknown renewal is never resolved by a bearer.
    await expect(updateTask({ id: ID, from: B, state: 'working' }))
      .rejects.toMatchObject({ message: 'task_already_terminal' });
    await expect(updateTask({ id: ID, from: B, state: 'working', leaseToken: 'wrong-token' }))
      .rejects.toMatchObject({ message: 'task_lease_required' });
    await expect(updateTask({ id: ID, from: B, state: 'working', leaseToken: first.leaseToken }))
      .rejects.toMatchObject({ message: 'task_lease_required' });
    // Sender path is untouched: the same update from the task author succeeds.
    const updated = await updateTask({ id: ID, from: A, state: 'working' });
    expect(updated?.state).toBe('working');

    // replyTask (recipient): existing policy passes no bearer, so the fence
    // surfaces as the opaque conflict; the sender may still reply. The queued
    // overlay from the claim/sender update is cleared so the durable literal
    // governs the snapshot.
    clearQueuedEventsForTests();
    durable = { ...durable, state: 'input-required' as const };
    setTaskGetForTests(async () => durable);
    await expect(replyTask({ id: ID, from: B, body: 'blocked by unknown renewal' }))
      .rejects.toMatchObject({ message: 'task_already_terminal' });
    const replied = await replyTask({ id: ID, from: A, body: 'sender still may reply' });
    expect(replied.state).toBe('working');

    // The renewal itself remains recoverable only through the authenticated
    // renew path (existing R4-BC controls), not through update/reply.
    expect(journalRecordsFor(ID).find((row) => row.kind === 'renew')?.fate).toBe('intent');
  });
});

describe('R4-2147 expiry retry identity reuse (M3-off)', () => {
  testOn('2147: repeated SMTP failure leaves ONE open expiry identity with the original at', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<e47-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    setTaskListAllForTests(async () => [durable]);
    // Expiry materializes while SMTP is down; the attempt persists one intent.
    now = Date.parse(first.claimedUntil) + 1000;
    setTaskSendMailForTests(async () => {
      throw new Error('smtp_down');
    });
    await expect(reapExpiredTaskLeasesOnce()).rejects.toThrow('smtp_down');
    const firstRow = journalRecordsFor(ID).find((row) => row.kind === 'expired');
    expect(journalRecordsFor(ID).filter((row) => row.kind === 'expired')).toHaveLength(1);
    const firstAt = firstRow?.at;
    expect(typeof firstAt).toBe('string');
    // A later retry must REUSE that identity, not mint a second record.
    now += 120_000;
    await expect(reapExpiredTaskLeasesOnce()).rejects.toThrow('smtp_down');
    const rows = journalRecordsFor(ID).filter((row) => row.kind === 'expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at).toBe(firstAt as string);
    expect(rows[0]?.fate).toBe('unconfirmed');
  });

  testOn('2147: accepted-but-uncommitted send then retry resends the identical signed payload', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<e48-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = first.task;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    setTaskListAllForTests(async () => [durable]);
    now = Date.parse(first.claimedUntil) + 1000;
    // SMTP accepts the expiry, but the accepted-fate commit is lost.
    setPostSmtpAcceptHookForTests(() => {
      throw new Error('commit_lost');
    });
    await expect(reapExpiredTaskLeasesOnce()).rejects.toThrow('commit_lost');
    setPostSmtpAcceptHookForTests(null);
    expect(journalRecordsFor(ID).find((row) => row.kind === 'expired')?.fate).toBe('intent');
    // Retry later: the same immutable identity is resent and marked accepted.
    now += 120_000;
    expect(await reapExpiredTaskLeasesOnce()).toBe(1);
    const rows = journalRecordsFor(ID).filter((row) => row.kind === 'expired');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fate).toBe('accepted');
    const expiryMails = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect(expiryMails).toHaveLength(2);
    expect(expiryMails[1]!.headers?.['X-OA-Task-Lease-Payload'])
      .toBe(expiryMails[0]!.headers?.['X-OA-Task-Lease-Payload']);
  });

  testOn('2147: two deliveries of the SAME expiry identity reconcile; a different identity conflicts and hides the task', async () => {
    isolateJournal();
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<e49-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claimMsg = (await parseCaptured(sent[0]!, 2))!;
    durable = first.task;
    setTaskGetForTests(async () => durable);
    clearQueuedEventsForTests();
    setTaskListAllForTests(async () => [durable]);
    now = Date.parse(first.claimedUntil) + 1000;
    expect(await reapExpiredTaskLeasesOnce()).toBe(1);
    const expiryMsg = (await parseCaptured(sent[1]!, 3))!;
    // Duplicate delivery: the SAME single expiry mail (no retry in this
    // flow) parsed twice into two captures must reconcile idempotently.
    const expiryDelivery1 = (await parseCaptured(sent[1]!, 3))!;
    const expiryDelivery2 = (await parseCaptured(sent[1]!, 4))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claimMsg, expiryDelivery1, expiryDelivery2]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.expiredLease?.leaseGeneration).toBe(1);
    // priorReceipt conflict: a same-generation receipt for a DIFFERENT window
    // is the only shape that reaches the conflict branch in this code —
    // isSameLeaseExpiryIdentity is (generation, claimedUntil)-keyed, so an
    // at/expiredAt-only difference is absorbed as an idempotent duplicate
    // (verified empirically and reported).
    const forgedHeaders = claimLeaseHeadersForTests({
      id: ID, state: 'working', from: A, to: B,
      event: {
        version: 1, event: 'expired', actor: 'server',
        at: '2026-08-24T01:00:00.000Z', generation: 1,
        claimedUntil: '2026-08-24T00:04:00.000Z', expiredAt: '2026-08-24T01:00:00.000Z',
      },
    });
    const forgedMsg = (await parseCaptured({ from: A, to: [B], subject: 'Lease expired', text: 'expired', headers: forgedHeaders }, 4))!;
    expect(taskFromMessages(ID, [submittedRaw(), claimMsg, expiryDelivery1, forgedMsg])).toBeNull();
  });
});
