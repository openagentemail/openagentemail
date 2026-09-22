/**
 * #308：写侧非 journal pending-index fence——release/renew 已 SMTP accepted
 * 但未被 durable 吸收时，re-claim 返 409 lease_overlay_pending_index（可重试）；
 * 吸收后重试成功（瞬态非死锁）。journal 路径零改；协议零新增。
 */
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-308-write-side-fence-'));
process.env.TASK_LEASES_ENABLED = 'true';
// 生产默认：journal 关——本卡 fence 落在 else 分支
process.env.TASK_LEASES_PENDING_JOURNAL = 'false';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  releaseTask,
  renewTask,
  taskFromMessages,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  queuedLeaseOverlayCountForTests,
} = await import('./support/task-test-seams.ts');
const {
  parseTaskMessageForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');

/** journal 关 + leases 开：本卡目标路径 */
const test = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () =>
    withTaskLeasesEnabledForTests(true, () =>
      withTaskLeasePendingJournalForTests(false, work)));

const ID = '308c3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1,
    from: A,
    to: B,
    subject: 'Lease fence 308',
    date: '2026-08-24T00:00:00.000Z',
    state: 'submitted',
    body: 'Please claim.',
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

/** 把 SMTP 出站邮件解析回 RawTaskMessage，供 durable 吸收仿真 */
async function parseSent(input: SendInput, uid: number): Promise<RawTaskMessage> {
  const parsed = await parseTaskMessageForTests({
    uid,
    source: source(input),
    envelope: {
      from: [{ address: input.from }],
      to: [{ address: input.to[0] }],
      subject: input.subject,
    },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
  if (!parsed) throw new Error('failed to parse sent lease mail');
  return parsed;
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#308 write-side fence · release 腿', () => {
  test('① pending 期 re-claim → 409 lease_overlay_pending_index', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rel-pending-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    // 吸收 claim，留下真实 release pending 窗
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });
    // durable 仍停在 claim1；queued 有未索引 release
    expect(durable.lease?.leaseGeneration).toBe(1);
    expect(durable.releasedLease).toBeUndefined();
    expect(queuedLeaseOverlayCountForTests(ID)).toBeGreaterThan(0);

    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
  });

  test('② 吸收后重试 → 成功（瞬态非死锁）', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rel-absorb-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });

    // 模拟索引吸收：durable 带上 release；queued 仍可留存——fence 以 eventIsIndexed 判定
    durable = taskFromMessages(ID, [
      submittedRaw(),
      await parseSent(sent[0]!, 2),
      await parseSent(sent[1]!, 3),
    ])!;
    setTaskGetForTests(async () => durable);

    const again = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(again.leaseGeneration).toBe(2);
    expect(again.task.lease?.leaseGeneration).toBe(2);
  });
});

describe('#308 write-side fence · renew 腿', () => {
  test('① pending 期 re-claim → 409 lease_overlay_pending_index', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rnw-pending-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await renewTask({ id: ID, from: B, leaseToken: grant.leaseToken, leaseSec: 300 });
    // durable 仍为 claim1 窗；queued 有未索引 renew
    expect(durable.lease?.claimedUntil).toBe(grant.claimedUntil);
    expect(queuedLeaseOverlayCountForTests(ID)).toBeGreaterThan(0);

    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
  });

  test('② 吸收后重试 → 成功（窗过期后放行，证明不卡死）', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rnw-absorb-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    const renewed = await renewTask({
      id: ID, from: B, leaseToken: grant.leaseToken, leaseSec: 300,
    });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });

    // 吸收 renew 进 durable
    durable = taskFromMessages(ID, [
      submittedRaw(),
      await parseSent(sent[0]!, 2),
      await parseSent(sent[1]!, 3),
    ])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    // 窗仍有效 → 正常 lease_already_claimed（fence 已解除，非 pending 码）
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_already_claimed' });

    // 窗过期后 re-claim 成功——核心：吸收后不卡死
    now = Date.parse(renewed.lease!.claimedUntil);
    const again = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(again.leaseGeneration).toBe(2);
  });
});

describe('#308 write-side fence · 对照（防误伤）', () => {
  test('③a queued 无 release/renew 时 fence 零触发（首 claim 正常）', async () => {
    const now = START;
    const durable = submittedTask();
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async () => ({ messageId: '<308-ctrl-first>' }));
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(0);
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grant.leaseGeneration).toBe(1);
  });

  test('③b claim1 未索引时二次 claim 仍 lease_already_claimed', async () => {
    const now = START;
    const durable = submittedTask(); // durable 无 claim
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async () => ({ messageId: '<308-ctrl-claim-overlay>' }));
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    // queued 仅有 claim overlay，无 release/renew → fence 不触发
    expect(queuedLeaseOverlayCountForTests(ID)).toBeGreaterThan(0);
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_already_claimed' });
  });
});
