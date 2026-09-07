// #78：钉死单进程契约下的两进程交错边界（不引入跨进程机制）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-multiprocess-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  reapExpiredTaskLeasesOnce,
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
const { parseTaskMessageForTests, withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: 'Lease this task',
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  };
}

function submittedTask(): Task {
  return taskFromMessages(ID, [submittedRaw()])!;
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

async function parseCaptured(input: SendInput, uid: number): Promise<RawTaskMessage | null> {
  return parseTaskMessageForTests({
    uid,
    source: source(input),
    envelope: {
      from: [{ address: input.from }],
      to: [{ address: input.to[0] }],
      subject: input.subject,
    },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
}

function claimVerifier(message: RawTaskMessage): string {
  return message.lease && 'tokenVerifier' in message.lease ? message.lease.tokenVerifier : '';
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#78 multiprocess lease contract (documented single-process boundary)', () => {
  test('#78 conflicting same-generation claims from two processes fail-closed', async () => {
    // 模拟两进程交错：A 的 claim 未索引时，B 独立再分配同一 generation。
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p78-claim-${sent.length}>` };
    });

    const grantA = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grantA.leaseGeneration).toBe(1);
    const claimA = (await parseCaptured(sent[0]!, 2))!;
    expect(claimA.lease?.event).toBe('claim');
    expect(claimA.lease && 'generation' in claimA.lease ? claimA.lease.generation : 0).toBe(1);

    // 进程 B 看不到 A 的 overlay / 未索引 claim，仍按 submitted 视图独立分配。
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => submittedTask());
    const grantB = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grantB.leaseGeneration).toBe(1);
    const claimB = (await parseCaptured(sent[1]!, 3))!;
    expect(claimB.lease?.event).toBe('claim');
    expect(claimB.lease && 'generation' in claimB.lease ? claimB.lease.generation : 0).toBe(1);
    expect(claimVerifier(claimA)).not.toBe(claimVerifier(claimB));
    expect(claimVerifier(claimA).length).toBeGreaterThanOrEqual(32);
    expect(claimVerifier(claimB).length).toBeGreaterThanOrEqual(32);

    const rebuilt = taskFromMessages(ID, [submittedRaw(), claimA, claimB]);
    expect(rebuilt).toBeNull();
  });

  test('#78 reaper dual expiry receipts across processes are identity-deduped', async () => {
    // 模拟两进程交错：同窗 (generation, claimedUntil) 各发一条 expired，第二条幂等。
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p78-expiry-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim = (await parseCaptured(sent[0]!, 2))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim])!;

    now = Date.parse(grant.claimedUntil);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    await reapExpiredTaskLeasesOnce();
    const expiryA = (await parseCaptured(sent[1]!, 3))!;
    expect(expiryA.lease?.event).toBe('expired');
    const expiryALease = expiryA.lease as { generation: number; claimedUntil: string; expiredAt: string };
    expect(expiryALease.generation).toBe(1);
    expect(expiryALease.claimedUntil).toBe(grant.claimedUntil);

    // 进程 B 未索引 A 的回执，仍只看见 claim 权威窗，再物化一条不同 expiredAt。
    clearQueuedEventsForTests();
    now = Date.parse(grant.claimedUntil) + 30_000;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    await reapExpiredTaskLeasesOnce();
    const expiryB = (await parseCaptured(sent[2]!, 4))!;
    expect(expiryB.lease?.event).toBe('expired');
    const expiryBLease = expiryB.lease as { generation: number; claimedUntil: string; expiredAt: string };
    expect(expiryBLease.generation).toBe(1);
    expect(expiryBLease.claimedUntil).toBe(grant.claimedUntil);
    expect(expiryBLease.expiredAt).not.toBe(expiryALease.expiredAt);

    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim, expiryA, expiryB]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toBeUndefined();
    expect(rebuilt?.expiredLease).toEqual({
      leaseGeneration: 1,
      claimedUntil: grant.claimedUntil,
      expiredAt: expiryALease.expiredAt,
      firstClaimedAt: '2026-08-24T00:00:00.000Z',
    });
    const publicView = toTaskView(rebuilt!);
    expect(publicView.messages).toHaveLength(3);
    expect(publicView.messages.filter((message) => message.body === 'Lease expired.')).toHaveLength(1);
    expect(JSON.stringify(publicView)).not.toContain(expiryBLease.expiredAt);
  });
});
