// PR-2：#85 传输去重 + #80 overlay 有界 fallback + #84 reclaim/audit 解耦。
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-p2-pr2-lease-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  getTask,
  isTaskLeaseTokenCurrent,
  reapExpiredTaskLeasesOnce,
  releaseTask,
  renewTask,
  taskFromMessages,
  toTaskView,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  EXPIRY_AUDIT_MAX_ATTEMPTS,
  getExpiryAuditLingerAlertCountForTests,
  getPendingExpiryAuditCountForTests,
  getWarnedStaleLeaseOverlayRetentionForTests,
  getQueuedEventsForTests,
  getStaleLeaseOverlayAlertCountForTests,
  LEASE_OVERLAY_MAX_LIFETIME_MS,
  rebuildExpiryAuditRetryQueueFromMessages,
  retryPendingExpiryAuditsOnce,
  seedQueuedEventForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const { parseTaskMessageForTests, withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const ID_BAD = '1fdc3207-056e-47c1-a65c-b29d39f66b84';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: 'Lease this task',
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  };
}

function submittedTask(id = ID): Task {
  return taskFromMessages(id, [submittedRaw()])!;
}

function leaseClaimedUntil(message: RawTaskMessage | null): string | undefined {
  return message?.lease && 'claimedUntil' in message.lease ? message.lease.claimedUntil : undefined;
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
    now = Date.parse(first.claimedUntil);
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

describe('PR-2 #80 排队 overlay 有界 fallback + 告警', () => {
  test('缺失索引：15 分钟后停止重放并告警一次，事件本体仍滞留取证', async () => {
    let now = START;
    const warnings: unknown[][] = [];
    const priorWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async (input) => ({ messageId: `<p2-80-miss-${input.subject}>` }));
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const live = await getTask(ID);
      expect(live?.lease?.leaseGeneration).toBe(1);
      now = START + LEASE_OVERLAY_MAX_LIFETIME_MS + 1;
      const expiredOverlay = await getTask(ID);
      const queued = getQueuedEventsForTests(ID);
      expect({
        overlayStopped: expiredOverlay?.lease,
        state: expiredOverlay?.state,
        forensicRetained: queued.length === 1 && queued[0]?.lease?.event === 'claim',
        alerts: getStaleLeaseOverlayAlertCountForTests(),
        structured: warnings.some((row) => String(row[0]).includes('lease_overlay_fallback_exhausted')),
        claimedUntilUnchanged: first.claimedUntil,
      }).toEqual({
        overlayStopped: undefined,
        state: 'submitted',
        forensicRetained: true,
        alerts: 1,
        structured: true,
        claimedUntilUnchanged: first.claimedUntil,
      });
      await getTask(ID);
      expect(getStaleLeaseOverlayAlertCountForTests()).toBe(1);
    } finally {
      console.warn = priorWarn;
    }
  });

  test('延迟索引：>15min 后 IMAP 追上则退休 overlay 并恢复权威', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-80-delay-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + LEASE_OVERLAY_MAX_LIFETIME_MS + 1;
    expect((await getTask(ID))?.lease).toBeUndefined();
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    setTaskGetForTests(async () => durable);
    const recovered = await getTask(ID);
    expect({
      generation: recovered?.lease?.leaseGeneration,
      queueRetired: getQueuedEventsForTests(ID).length,
    }).toEqual({ generation: 1, queueRetired: 0 });
  });

  test('重启：fallback 从 sentAt 起算，不从进程启动时刻清零', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<p2-80-restart>' }));
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const original = getQueuedEventsForTests(ID);
    expect(original[0]?.sentAt).toBe(START);
    clearQueuedEventsForTests();
    for (const row of original) seedQueuedEventForTests(ID, row);
    now = START + LEASE_OVERLAY_MAX_LIFETIME_MS + 1;
    const afterRestart = await getTask(ID);
    expect({
      overlayStopped: afterRestart?.lease,
      forensicRetained: getQueuedEventsForTests(ID).length,
      alerts: getStaleLeaseOverlayAlertCountForTests(),
    }).toEqual({ overlayStopped: undefined, forensicRetained: 1, alerts: 1 });
  });

  test('陈旧 generation：已索引的更新权威使旧 overlay 在 15min 内退休', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-80-stale-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parseCaptured(sent[2]!, 4))!,
    ])!;
    setTaskGetForTests(async () => durable);
    const viewed = await getTask(ID);
    expect({
      generation: viewed?.lease?.leaseGeneration,
      gen2Current: viewed ? isTaskLeaseTokenCurrent(viewed, second.leaseToken) : null,
      queueRetired: getQueuedEventsForTests(ID).length,
      alerts: getStaleLeaseOverlayAlertCountForTests(),
    }).toEqual({
      generation: 2,
      gen2Current: true,
      queueRetired: 0,
      alerts: 0,
    });
  });

  test('still-active overlay 超过 15min 仍 fence，claimedUntil 过期后才停重放', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<p2-80-active-cutoff>' }));
    const first = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + LEASE_OVERLAY_MAX_LIFETIME_MS + 1;
    const live = await getTask(ID);
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toThrow('lease_already_claimed');
    expect({
      stillFenced: live?.lease?.leaseGeneration,
      claimedUntil: live?.lease?.claimedUntil,
      alertsWhileActive: getStaleLeaseOverlayAlertCountForTests(),
    }).toEqual({
      stillFenced: 1,
      claimedUntil: first.claimedUntil,
      alertsWhileActive: 0,
    });
    now = Date.parse(first.claimedUntil);
    const afterExpiry = await getTask(ID);
    expect({
      overlayStopped: afterExpiry?.lease,
      forensicRetained: getQueuedEventsForTests(ID).some((row) => row.lease?.event === 'claim'),
      alertsAfterExpiry: getStaleLeaseOverlayAlertCountForTests(),
    }).toEqual({
      overlayStopped: undefined,
      forensicRetained: true,
      alertsAfterExpiry: 1,
    });
  });

  test('indexed overlay 完结后剪枝 warnedStaleLeaseOverlays', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<p2-80-prune-${sent.length}>` };
    });
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + LEASE_OVERLAY_MAX_LIFETIME_MS + 1;
    await getTask(ID);
    expect(getWarnedStaleLeaseOverlayRetentionForTests()).toBe(1);
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    setTaskGetForTests(async () => durable);
    await getTask(ID);
    expect({
      queueRetired: getQueuedEventsForTests(ID).length,
      warnedRetained: getWarnedStaleLeaseOverlayRetentionForTests(),
    }).toEqual({ queueRetired: 0, warnedRetained: 0 });
  });
});

describe('PR-2 #84 reclaim 与 expiry-audit 解耦', () => {
  test('SMTP 拒收：reclaim 仍成功，audit 入队，旧 bearer 失活', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-reject-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect({
      generation: second.leaseGeneration,
      oldBearer: isTaskLeaseTokenCurrent(second.task, first.leaseToken),
      newBearer: isTaskLeaseTokenCurrent(second.task, second.leaseToken),
      deliveries: sent.map((mail) => mail.headers?.['X-OA-Task-Lease-Event']),
      pending: getPendingExpiryAuditCountForTests(),
    }).toEqual({
      generation: 2,
      oldBearer: false,
      newBearer: true,
      deliveries: ['claim', 'claim'],
      pending: 1,
    });
  });

  test('SMTP 恢复：重试补投 canonical actor=server audit，迟到事件不推翻 gen2', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-recover-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ])!;
    setTaskGetForTests(async () => durable);
    failExpiry = false;
    now = Date.parse(first.claimedUntil) + 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(1);
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect(expiry?.headers?.['X-OA-Task-Lease-Event']).toBe('expired');
    const rebuilt = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parseCaptured(expiry!, 4))!,
    ]);
    expect({
      pending: getPendingExpiryAuditCountForTests(),
      generation: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
      actorServer: (await parseCaptured(expiry!, 4))?.lease?.actor,
    }).toEqual({
      pending: 0,
      generation: 2,
      gen2Current: true,
      actorServer: 'server',
    });
  });

  test('拒收到底：封顶后滞留告警，队列项不删', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    const warnings: unknown[][] = [];
    const priorWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      let failExpiry = false;
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
          throw new Error('smtp rejected expiry audit');
        }
        sent.push(input);
        return { messageId: `<p2-84-cap-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      failExpiry = true;
      await claimTask({ id: ID, from: B, leaseSec: 300 });
      for (let attempt = 0; attempt < EXPIRY_AUDIT_MAX_ATTEMPTS; attempt += 1) {
        now += 60_000;
        await retryPendingExpiryAuditsOnce();
      }
      expect({
        pending: getPendingExpiryAuditCountForTests(),
        linger: getExpiryAuditLingerAlertCountForTests(),
        structured: warnings.some((row) => String(row[0]).includes('expiry_audit_retry_exhausted')),
        stillNoAudit: sent.every((mail) => mail.headers?.['X-OA-Task-Lease-Event'] !== 'expired'),
      }).toEqual({
        pending: 1,
        linger: 1,
        structured: true,
        stillNoAudit: true,
      });
    } finally {
      console.warn = priorWarn;
    }
  });

  test('重启后从 durable 事件流重建重试队列，随后补投成功', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-rebuild-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const history = [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ];
    clearQueuedEventsForTests();
    expect(getPendingExpiryAuditCountForTests()).toBe(0);
    rebuildExpiryAuditRetryQueueFromMessages(ID, history);
    expect(getPendingExpiryAuditCountForTests()).toBe(1);
    failExpiry = false;
    now += 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(1);
    expect(getPendingExpiryAuditCountForTests()).toBe(0);
    expect(sent.some((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired')).toBe(true);
  });

  test('reclaim/audit 竞态：锁串行后只补一封 server audit，gen2 不被旧 audit 覆盖', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-race-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ])!;
    setTaskGetForTests(async () => durable);
    failExpiry = false;
    now += 2_000;
    const [a, b] = await Promise.all([
      retryPendingExpiryAuditsOnce(),
      retryPendingExpiryAuditsOnce(),
    ]);
    const audits = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect({
      delivered: a + b,
      audits: audits.length,
      generation: second.leaseGeneration,
      gen2Current: isTaskLeaseTokenCurrent(second.task, second.leaseToken),
    }).toEqual({
      delivered: 1,
      audits: 1,
      generation: 2,
      gen2Current: true,
    });
  });

  test('续约后迟到 audit 匹配最终 renewal deadline，reconstruction 保持可读', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-renew-late-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 60_000;
    const renewed = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 300 });
    durable = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(renewed.lease!.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    failExpiry = false;
    now += 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(1);
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const renew1 = (await parseCaptured(sent[1]!, 3))!;
    const claim2 = (await parseCaptured(sent[2]!, 4))!;
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const expiryParsed = expiry ? await parseCaptured(expiry, 5) : null;
    const originalClaimUntil = leaseClaimedUntil(claim1);
    const renewedUntil = leaseClaimedUntil(renew1);
    const rebuilt = expiryParsed
      ? taskFromMessages(ID, [submittedRaw(), claim1, renew1, claim2, expiryParsed])
      : null;
    expect({
      originalDistinctFromRenewed: originalClaimUntil !== renewedUntil,
      auditMatchesRenewedDeadline: leaseClaimedUntil(expiryParsed) === renewedUntil,
      readable: rebuilt !== null,
      generation: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
    }).toEqual({
      originalDistinctFromRenewed: true,
      auditMatchesRenewedDeadline: true,
      readable: true,
      generation: 2,
      gen2Current: true,
    });
  });

  test('重启重建含 renew 链：合成 expiry 使用最终续约 deadline', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-renew-rebuild-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 60_000;
    const renewed = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 300 });
    durable = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(renewed.lease!.claimedUntil);
    failExpiry = true;
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const history = [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parseCaptured(sent[2]!, 4))!,
    ];
    clearQueuedEventsForTests();
    rebuildExpiryAuditRetryQueueFromMessages(ID, history);
    expect(getPendingExpiryAuditCountForTests()).toBe(1);
    failExpiry = false;
    now += 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(1);
    const renew1 = (await parseCaptured(sent[1]!, 3))!;
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const expiryParsed = expiry ? await parseCaptured(expiry, 5) : null;
    const rebuilt = expiryParsed
      ? taskFromMessages(ID, [...history, expiryParsed])
      : null;
    expect({
      synthesizedDeadline: leaseClaimedUntil(expiryParsed),
      finalRenewDeadline: leaseClaimedUntil(renew1),
      readable: rebuilt !== null,
      generation: rebuilt?.lease?.leaseGeneration,
    }).toEqual({
      synthesizedDeadline: leaseClaimedUntil(renew1),
      finalRenewDeadline: leaseClaimedUntil(renew1),
      readable: true,
      generation: 2,
    });
  });

  test('一 task 拒收不饿死其他 pending audit', async () => {
    let now = START;
    const durables = new Map<string, Task>([
      [ID, submittedTask(ID)],
      [ID_BAD, submittedTask(ID_BAD)],
    ]);
    const sent: SendInput[] = [];
    let failOkExpiry = false;
    let failBadExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    setTaskSendMailForTests(async (input) => {
      const taskId = input.headers?.['X-OA-Task'];
      if (failOkExpiry && taskId === ID && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected ok audit');
      }
      if (failBadExpiry && taskId === ID_BAD && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected bad task');
      }
      sent.push(input);
      return { messageId: `<p2-84-isolate-${sent.length}>` };
    });
    const okFirst = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const badFirst = await claimTask({ id: ID_BAD, from: B, leaseSec: 300 });
    durables.set(ID, taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2, ID))!])!);
    durables.set(ID_BAD, taskFromMessages(ID_BAD, [submittedRaw(), (await parseCaptured(sent[1]!, 2, ID_BAD))!])!);
    clearQueuedEventsForTests();
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    now = Date.parse(okFirst.claimedUntil);
    failOkExpiry = true;
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(getPendingExpiryAuditCountForTests()).toBe(1);
    durables.set(ID, taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2, ID))!,
      (await parseCaptured(sent[2]!, 3, ID))!,
    ])!);
    failOkExpiry = false;
    failBadExpiry = true;
    now = Date.parse(badFirst.claimedUntil) + 2_000;
    expect(await reapExpiredTaskLeasesOnce()).toBe(0);
    const okAudit = sent.filter((mail) =>
      mail.headers?.['X-OA-Task'] === ID && mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const badAudit = sent.filter((mail) =>
      mail.headers?.['X-OA-Task'] === ID_BAD && mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect({
      pendingAfterFlush: getPendingExpiryAuditCountForTests(),
      okAuditDelivered: okAudit.length,
      badAuditBlocked: badAudit.length,
    }).toEqual({
      pendingAfterFlush: 0,
      okAuditDelivered: 1,
      badAuditBlocked: 0,
    });
  });

  test('迟到 durable expiry 已在流中则不得再入队重投', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp rejected expiry audit');
      }
      sent.push(input);
      return { messageId: `<p2-84-no-replay-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    failExpiry = false;
    now += 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(1);
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const historyWithLate = [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parseCaptured(expiry!, 4))!,
    ];
    const deliveriesBeforeRebuild = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length;
    rebuildExpiryAuditRetryQueueFromMessages(ID, historyWithLate);
    expect(getPendingExpiryAuditCountForTests()).toBe(0);
    now += 2_000;
    expect(await retryPendingExpiryAuditsOnce()).toBe(0);
    expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired')).toHaveLength(deliveriesBeforeRebuild);
  });
});
