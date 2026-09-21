/**
 * #305：读侧降级——已鉴权但与残留权威时间窗冲突的 claim
 * 不再整卡 return null，而是按无效事件出账 + audit。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-305-claim-window-conflict-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const { claimTask, getTask, taskFromMessages, toTaskView } = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const { setFindTaskMessagesForTests } = await import('../src/lib/tasks-internal.ts');
const {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');

const test = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const ID = '305c3207-056e-47c1-a65c-b29d39f66b83';
const NEIGHBOR = '305c3207-056e-47c1-a65c-b29d39f66b84';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(id = ID): RawTaskMessage {
  return {
    uid: 1,
    from: A,
    to: B,
    subject: `Lease ${id}`,
    date: '2026-08-24T00:00:00.000Z',
    state: 'submitted',
    body: 'Please claim.',
  };
}

function source(from: string, to: string, subject: string, headers: Record<string, string>): Buffer {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    'Lease audit event.',
  ].join('\r\n'), 'utf8');
}

/** 构造已鉴权 lease 消息（与 legacy-history 同款缝）。 */
async function signedLease(
  id: string,
  uid: number,
  event: Parameters<typeof claimLeaseHeadersForTests>[0]['event'],
  state: 'working' | 'submitted' = 'working',
): Promise<RawTaskMessage> {
  const from = event.event === 'expired' ? A : B;
  const to = event.event === 'expired' ? B : A;
  const headers = claimLeaseHeadersForTests({ id, state, from, to, event });
  const parsed = await parseTaskMessageForTests({
    uid,
    source: source(from, to, `Lease ${id}`, headers),
    envelope: { from: [{ address: from }], to: [{ address: to }], subject: `Lease ${id}` },
    internalDate: new Date(event.at),
  } as unknown as FetchMessageObject, id);
  if (!parsed) throw new Error('failed to construct signed lease event');
  return parsed;
}

/** 取一次真实 claim 的 tokenVerifier，供后续手写签名事件复用。 */
async function liveVerifier(id = ID): Promise<string> {
  let durable = taskFromMessages(id, [submittedRaw(id)])!;
  const sent: Array<{ headers?: Record<string, string> }> = [];
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: '<305-verifier>' };
  });
  const grant = await claimTask({ id, from: B, leaseSec: 300 });
  durable = grant.task;
  const payload = JSON.parse(
    Buffer.from(sent[0]!.headers!['X-OA-Task-Lease-Payload']!, 'base64url').toString('utf8'),
  ) as { tokenVerifier: string };
  clearQueuedEventsForTests();
  return payload.tokenVerifier;
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  setFindTaskMessagesForTests(null);
  clearQueuedEventsForTests();
  resetAuditForTests();
});

describe('#305 claim window conflict degrade', () => {
  test('正1: 冲突 claim 降级——整卡可读、权威=前窗、消息隐藏、audit 恰一条', async () => {
    const verifier = await liveVerifier();
    const claim1At = new Date(START).toISOString();
    const claim1Until = new Date(START + 300_000).toISOString();
    // claim2.at 仍落在 claim1 窗内 → 与残留权威冲突（模拟坏 release 被 parse 丢弃后的 re-claim）
    const claim2At = new Date(START + 60_000).toISOString();
    const claim2Until = new Date(START + 360_000).toISOString();
    const claim1 = await signedLease(ID, 2, {
      version: 1, event: 'claim', actor: B, at: claim1At, generation: 1,
      claimedUntil: claim1Until, tokenVerifier: verifier,
    });
    const claim2 = await signedLease(ID, 3, {
      version: 1, event: 'claim', actor: B, at: claim2At, generation: 2,
      claimedUntil: claim2Until, tokenVerifier: 'y'.repeat(43),
    });

    resetAuditForTests();
    clearQueuedEventsForTests();
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, claim2]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toMatchObject({
      leaseGeneration: 1,
      claimedUntil: claim1Until,
      firstClaimedAt: claim1At,
    });
    // claim2 按重复事件隐藏：公开消息仅 handoff + claim1
    expect(toTaskView(rebuilt!).messages).toHaveLength(2);
    expect(toTaskView(rebuilt!).messages.map((m) => m.state)).toEqual(['submitted', 'working']);

    const audits = readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'task.lease.claim_window_conflict_degraded',
      outcome: 'denied',
      taskId: ID,
      leaseGeneration: 2,
    });
    // 不得回显 reason 原文或载荷类字段
    expect(audits[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(audits[0])).not.toContain(claim2Until);

    // 同键再重建不刷屏
    expect(taskFromMessages(ID, [submittedRaw(), claim1, claim2])).not.toBeNull();
    expect(readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 10 })).toHaveLength(1);

    // getTaskSnapshot 路径：hadMatchingRows 时不再 fail-closed 404
    setTaskGetForTests(null);
    setFindTaskMessagesForTests(async () => ({
      hadMatchingRows: true,
      messages: [submittedRaw(), claim1, claim2],
    }));
    const snapped = await getTask(ID);
    expect(snapped?.lease?.leaseGeneration).toBe(1);
    expect(snapped?.lease?.claimedUntil).toBe(claim1Until);
  });

  test('正2+正3: 邻单不受影响；列表重建包含降级单', async () => {
    const verifier = await liveVerifier();
    const neighborVerifier = await liveVerifier(NEIGHBOR);
    const claim1Until = new Date(START + 300_000).toISOString();
    const claim1At = new Date(START).toISOString();
    const conflictAt = new Date(START + 30_000).toISOString();

    const badThread = [
      submittedRaw(ID),
      await signedLease(ID, 2, {
        version: 1, event: 'claim', actor: B, at: claim1At, generation: 1,
        claimedUntil: claim1Until, tokenVerifier: verifier,
      }),
      await signedLease(ID, 3, {
        version: 1, event: 'claim', actor: B, at: conflictAt, generation: 2,
        claimedUntil: new Date(START + 360_000).toISOString(), tokenVerifier: 'z'.repeat(43),
      }),
    ];
    const neighborThread = [
      submittedRaw(NEIGHBOR),
      await signedLease(NEIGHBOR, 2, {
        version: 1, event: 'claim', actor: B, at: claim1At, generation: 1,
        claimedUntil: claim1Until, tokenVerifier: neighborVerifier,
      }),
    ];

    // 模拟 scanDurableTasks 的「逐单重建 + 静默过滤 null」列表路径
    const listed = [ID, NEIGHBOR]
      .map((id) => taskFromMessages(id, id === ID ? badThread : neighborThread))
      .filter((task): task is Task => !!task);
    expect(listed.map((t) => t.id).sort()).toEqual([ID, NEIGHBOR].sort());
    expect(listed.find((t) => t.id === ID)?.lease?.leaseGeneration).toBe(1);
    expect(listed.find((t) => t.id === NEIGHBOR)?.lease).toMatchObject({
      leaseGeneration: 1,
      claimedUntil: claim1Until,
    });
  });

  test('负1: 无冲突 claim（合法 release 后 re-claim）行为不变', async () => {
    const verifier = await liveVerifier();
    const claim1At = new Date(START).toISOString();
    const claim1Until = new Date(START + 300_000).toISOString();
    const releaseAt = new Date(START + 120_000).toISOString();
    const claim2At = new Date(START + 180_000).toISOString();
    const claim2Until = new Date(START + 480_000).toISOString();
    const claim2Verifier = 'w'.repeat(43);

    const history = [
      submittedRaw(),
      await signedLease(ID, 2, {
        version: 1, event: 'claim', actor: B, at: claim1At, generation: 1,
        claimedUntil: claim1Until, tokenVerifier: verifier,
      }),
      await signedLease(ID, 3, {
        version: 1, event: 'release', actor: B, at: releaseAt, generation: 1,
        tokenVerifier: verifier, reason: 'handoff',
      }),
      await signedLease(ID, 4, {
        version: 1, event: 'claim', actor: B, at: claim2At, generation: 2,
        claimedUntil: claim2Until, tokenVerifier: claim2Verifier,
      }),
    ];

    resetAuditForTests();
    clearQueuedEventsForTests();
    const rebuilt = taskFromMessages(ID, history);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toMatchObject({
      leaseGeneration: 2,
      claimedUntil: claim2Until,
      firstClaimedAt: claim1At,
    });
    expect(rebuilt?.releasedLease).toBeUndefined();
    expect(readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 5 })).toHaveLength(0);
  });

  test('负2: 鉴权不弱化——坏签名 lease 仍被 parse 层丢弃', async () => {
    const verifier = await liveVerifier();
    const claim1At = new Date(START).toISOString();
    const claim1Until = new Date(START + 300_000).toISOString();
    const claim1 = await signedLease(ID, 2, {
      version: 1, event: 'claim', actor: B, at: claim1At, generation: 1,
      claimedUntil: claim1Until, tokenVerifier: verifier,
    });

    // 伪造 payload：改 generation 但不重签 → parse 丢弃
    const headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1, event: 'claim', actor: B,
        at: new Date(START + 60_000).toISOString(),
        generation: 2,
        claimedUntil: new Date(START + 360_000).toISOString(),
        tokenVerifier: 'f'.repeat(43),
      },
    });
    const forgedPayload = JSON.parse(
      Buffer.from(headers['X-OA-Task-Lease-Payload']!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    forgedPayload.generation = 99;
    const forged = await parseTaskMessageForTests({
      uid: 3,
      source: source(B, A, `Lease ${ID}`, {
        ...headers,
        'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url'),
      }),
      envelope: { from: [{ address: B }], to: [{ address: A }], subject: `Lease ${ID}` },
      internalDate: new Date(START + 60_000),
    } as unknown as FetchMessageObject, ID);
    expect(forged).toBeNull();

    // 仅 claim1 入账；权威仍为 gen1
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1]);
    expect(rebuilt?.lease?.leaseGeneration).toBe(1);
  });

  test('负3: 降级=忽略≠接受——冲突 claim 不获得权威', async () => {
    const verifier = await liveVerifier();
    const claim1Until = new Date(START + 300_000).toISOString();
    const claim1 = await signedLease(ID, 2, {
      version: 1, event: 'claim', actor: B, at: new Date(START).toISOString(), generation: 1,
      claimedUntil: claim1Until, tokenVerifier: verifier,
    });
    const claim2 = await signedLease(ID, 3, {
      version: 1, event: 'claim', actor: B,
      at: new Date(START + 10_000).toISOString(), generation: 2,
      claimedUntil: new Date(START + 400_000).toISOString(), tokenVerifier: 'n'.repeat(43),
    });

    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    expect(rebuilt.lease?.leaseGeneration).toBe(1);
    expect(rebuilt.lease?.claimedUntil).toBe(claim1Until);
    expect(rebuilt.lease?.tokenVerifier).toBe(verifier);
    // 公开面不含冲突 claim 的时间戳
    expect(JSON.stringify(toTaskView(rebuilt))).not.toContain('2026-08-24T00:06:40.000Z');
  });
});
