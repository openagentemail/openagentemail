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
  isTaskLeaseTokenCurrent,
  reapExpiredTaskLeasesOnce,
  renewTask,
  taskFromMessages,
  toTaskView,
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
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const {
  bootstrapTaskLeaseJournal,
  journalPathsForTests,
  loadLeaseJournal,
  resetJournalMemoryForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
  setJournalDurableEvidenceForTests,
  setJournalNowForTests,
  unresolvedClaimFence,
} = await import('../src/lib/task-lease-journal.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');
const TWO_H = 2 * 60 * 60 * 1000;

function submittedRaw(id = ID): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: `Lease ${id}`,
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  };
}

function submittedTask(id = ID): Task {
  return taskFromMessages(id, [submittedRaw(id)])!;
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
  setJournalCrashHookForTests(null);
  setJournalNowForTests(null);
  setJournalDurableEvidenceForTests(null);
  clearQueuedEventsForTests();
  resetJournalMemoryForTests();
});

function isolateJournal(): void {
  const dir = mkdtempSync(join(tmpdir(), 'oae-m2-iso-'));
  setJournalDataDirForTests(dir);
  bootstrapTaskLeaseJournal();
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
      const nearby = text.match(/TASK_LEASES_PENDING_JOURNAL[\s\S]{0,280}/)?.[0] ?? '';
      return {
        name,
        mentionsFlag: text.includes('TASK_LEASES_PENDING_JOURNAL'),
        defaultsFalse: /false/.test(nearby) || /default false/i.test(text),
        requiresLeases: /TASK_LEASES_ENABLED/.test(text),
      };
    });
    expect(observed.every((row) => row.mentionsFlag && row.defaultsFalse && row.requiresLeases)).toBe(true);
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
