// #85：claim/renew/release 传输层精确去重（拆卡后不含 #80/#84）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-p2-85-dedup-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  isTaskLeaseTokenCurrent,
  releaseTask,
  renewTask,
  taskFromMessages,
  toTaskView,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  emitDurableExpiryIfM3ForTests,
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

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('PR-2 #85 传输层精确去重（claim/renew/release）', () => {
  test('邻接重复：逐字节相同的 claim/renew/release 幂等重建，公开视图不变', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-85-adj-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 1_000;
    await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 300 });
    await releaseTask({ id: ID, from: B, leaseToken: first.leaseToken, reason: 'done' });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const renew1 = (await parseCaptured(sent[1]!, 3))!;
    const release1 = (await parseCaptured(sent[2]!, 4))!;
    const claimDup = { ...claim1, uid: 5 };
    const renewDup = { ...renew1, uid: 6 };
    const releaseDup = { ...release1, uid: 7 };
    const baseline = taskFromMessages(ID, [submittedRaw(), claim1, renew1, release1]);
    const duplicated = taskFromMessages(ID, [submittedRaw(), claim1, renew1, release1, claimDup, renewDup, releaseDup]);
    const baselineView = baseline ? toTaskView(baseline) : null;
    const duplicateView = duplicated ? toTaskView(duplicated) : null;
    expect({
      baseline: baseline !== null,
      duplicated: duplicated !== null,
      publicViewsIdentical: JSON.stringify(baselineView) === JSON.stringify(duplicateView),
      messageCount: duplicateView?.messages.length,
      released: duplicated?.releasedLease?.leaseGeneration,
    }).toEqual({
      baseline: true,
      duplicated: true,
      publicViewsIdentical: true,
      messageCount: 4,
      released: 1,
    });
  });

  test('延迟重复：晚于新 generation 到达的旧 claim 不得超越新权威', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-85-late-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    now = Date.parse(first.claimedUntil);
    await emitDurableExpiryIfM3ForTests();
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const expiry1 = (await parseCaptured(sent[1]!, 3))!;
    const claim2 = (await parseCaptured(sent[2]!, 4))!;
    const lateClaim1 = { ...claim1, uid: 6 };
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, expiry1, claim2, lateClaim1]);
    expect({
      valid: rebuilt !== null,
      generation: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
      gen1Fenced: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      messages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
    }).toEqual({
      valid: true,
      generation: 2,
      gen2Current: true,
      gen1Fenced: false,
      messages: 4,
    });
  });

  test('重启后重建：durable 流含重复事件仍保持 generation 单调', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-85-restart-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 1_000;
    await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const renew1 = (await parseCaptured(sent[1]!, 3))!;
    clearQueuedEventsForTests();
    // 重启后 IMAP 以新 UID 重放同一已认证事件；必须是不同对象，避免 Set 把首次也滤掉。
    const restarted = taskFromMessages(ID, [
      submittedRaw(),
      claim1,
      { ...claim1, uid: 4 },
      renew1,
      { ...renew1, uid: 5 },
    ]);
    expect({
      valid: restarted !== null,
      generation: restarted?.lease?.leaseGeneration,
      claimedUntil: restarted?.lease?.claimedUntil,
      messages: restarted ? toTaskView(restarted).messages.length : 0,
    }).toEqual({
      valid: true,
      generation: 1,
      claimedUntil: renew1.lease && 'claimedUntil' in renew1.lease ? renew1.lease.claimedUntil : undefined,
      messages: 3,
    });
  });

  test('混合事件类型：claim 重复不得被当成 renew/release，字段差异 fail-closed', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-85-mix-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 1_000;
    await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const renew1 = (await parseCaptured(sent[1]!, 3))!;
    const alteredAt = {
      ...claim1,
      uid: 4,
      lease: claim1.lease ? { ...claim1.lease, at: '2026-08-24T00:00:01.000Z' } : undefined,
    };
    const claimVerifier = claim1.lease && 'tokenVerifier' in claim1.lease ? claim1.lease.tokenVerifier : '';
    const alteredVerifier = {
      ...claim1,
      uid: 5,
      lease: claim1.lease ? { ...claim1.lease, tokenVerifier: `${claimVerifier.slice(0, -1)}X` } : undefined,
    };
    const alteredGeneration = {
      ...claim1,
      uid: 6,
      lease: claim1.lease ? { ...claim1.lease, generation: 9 } : undefined,
    };
    expect(taskFromMessages(ID, [submittedRaw(), claim1, alteredAt])).toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), claim1, alteredVerifier])).toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), claim1, alteredGeneration])).toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), claim1, renew1, { ...claim1, uid: 8 }])?.lease?.claimedUntil)
      .toBe(renew1.lease && 'claimedUntil' in renew1.lease ? renew1.lease.claimedUntil : undefined);
  });

  test('真实下游：nodemailer 折行源经生产 parser 后，重复 claim 仍幂等', async () => {
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-85-wire-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const result = await transport.sendMail({
      from: sent[0]!.from,
      to: sent[0]!.to,
      subject: sent[0]!.subject,
      text: sent[0]!.text,
      headers: sent[0]!.headers,
    });
    if (!Buffer.isBuffer(result.message)) throw new Error('stream transport must return buffered RFC 5322 source');
    const asFetch = (uid: number) => ({
      uid,
      source: result.message,
      envelope: { from: [{ address: sent[0]!.from }], to: [{ address: sent[0]!.to[0] }], subject: sent[0]!.subject },
      internalDate: new Date(START),
    } as unknown as FetchMessageObject);
    const first = await parseTaskMessageForTests(asFetch(2), ID);
    const duplicate = await parseTaskMessageForTests(asFetch(3), ID);
    const rebuilt = first && duplicate
      ? taskFromMessages(ID, [submittedRaw(), first, duplicate])
      : null;
    expect({
      parsed: first?.lease?.event,
      generation: rebuilt?.lease?.leaseGeneration,
      messages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
    }).toEqual({ parsed: 'claim', generation: 1, messages: 2 });
  });
});
