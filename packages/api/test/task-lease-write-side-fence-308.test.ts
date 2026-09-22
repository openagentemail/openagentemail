/**
 * #308：写侧非 journal pending-index fence——release/renew 已 SMTP accepted
 * 但未被 durable 吸收时，fresh（≤CLAIM_FENCE_MAX_MS）行挡 re-claim 为 409；
 * 吸收后重试成功；超龄（>15min）放行并 audit（防永久丢失回执卡死）。
 * journal 路径零改；协议零新增。
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
  CLAIM_FENCE_MAX_MS,
  takeClaimFenceExpiredCountForTests,
} = await import('./support/task-test-seams.ts');
const {
  parseTaskMessageForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const { setFindTaskMessagesForTests } = await import('../src/lib/tasks-internal.ts');

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
  setFindTaskMessagesForTests(null);
  clearQueuedEventsForTests();
  resetAuditForTests();
  takeClaimFenceExpiredCountForTests();
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

  test('② 吸收后重试 → 成功', async () => {
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

  test('P1 行龄 >15min → 放行 claim 成功 + audit 恰一条', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rel-age-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });
    // 上界前多次尝试持续 409（附则4④）
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    now = START + 1_000 + Math.floor(CLAIM_FENCE_MAX_MS / 2);
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    now = START + 1_000 + CLAIM_FENCE_MAX_MS; // 边界：age === MAX 仍 fresh（<=）
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });

    // 推进超过 CLAIM_FENCE_MAX_MS → 超龄放行
    now = START + 1_000 + CLAIM_FENCE_MAX_MS + 1;
    resetAuditForTests();
    takeClaimFenceExpiredCountForTests();
    const again = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(again.leaseGeneration).toBe(2);
    const audits = readAuditEvents({ event: 'task.lease.claim_fence_expired', limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'task.lease.claim_fence_expired',
      outcome: 'ok',
      taskId: ID,
      leaseGeneration: 1,
      provenance: 'release',
    });
    expect(audits[0]!.durationMs).toBeGreaterThan(CLAIM_FENCE_MAX_MS);
    expect(takeClaimFenceExpiredCountForTests()).toBe(1);
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

  test('② 吸收后重试 → 成功（窗过期后放行）', async () => {
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

  test('P1 renew 超龄 → 不再 409（仍可被 lease_already_claimed 挡）', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-rnw-age-${sent.length}>` };
    });

    // 租约窗须长于 CLAIM_FENCE_MAX_MS，否则超龄时窗已过期会直接放行 claim
    const grant = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await renewTask({ id: ID, from: B, leaseToken: grant.leaseToken, leaseSec: 3600 });
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });

    now = START + 1_000 + CLAIM_FENCE_MAX_MS + 1;
    resetAuditForTests();
    // 超龄放行后 overlay renew 仍活窗 → lease_already_claimed（非 pending 码）
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_already_claimed' });
    const audits = readAuditEvents({ event: 'task.lease.claim_fence_expired', limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      provenance: 'renew',
      taskId: ID,
      leaseGeneration: 1,
    });
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

describe('#308 R1 · P2 I/O + P3-1 fail-closed', () => {
  test('P2 无候选时零额外 durable 查找；有 fresh 候选恰 +1', async () => {
    let now = START;
    let durable = submittedTask();
    let getCalls = 0;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => {
      getCalls += 1;
      return durable;
    });
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-io-${sent.length}>` };
    });

    // 首 claim：无 release/renew 候选 → 仅初始 1 次 get（零 fence durable）
    getCalls = 0;
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(getCalls).toBe(1);

    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => {
      getCalls += 1;
      return durable;
    });

    now = START + 1_000;
    getCalls = 0;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });
    // release 自身也会 get 一次（merge）
    const afterRelease = getCalls;

    getCalls = 0;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    // 初始 merge + fence durable = 2
    expect(getCalls).toBe(2);
    expect(afterRelease).toBeGreaterThanOrEqual(1);
  });

  test('P3-1 fresh 候选 + durable null → 409 fail-closed', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-null-${sent.length}>` };
    });

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), await parseSent(sent[0]!, 2)])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);

    now = START + 1_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });
    // claim：call1=merge(durable)、call2=fence durable(null) → fail-closed 409
    let callN = 0;
    setTaskGetForTests(async () => {
      callN += 1;
      return callN === 1 ? durable : null;
    });

    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    expect(callN).toBe(2);
  });
});

describe('#308 R1.1 · audit 限频 pin（附则4③）', () => {
  test('60s 窗内两异键：count=2 但 audit 恰 1；>60s 第三键 → audit 第 2 条', async () => {
    const {
      noteClaimFenceExpiredForTests,
      CLAIM_FENCE_EXPIRED_AUDIT_INTERVAL_MS: interval,
      takeClaimFenceExpiredCountForTests: takeCount,
    } = await import('../src/lib/tasks-internal.ts');

    let now = START;
    setTaskNowForTests(() => now);
    resetAuditForTests();
    clearQueuedEventsForTests();
    takeCount();

    // 两不同键（异 taskId）在限频窗内先后放行
    noteClaimFenceExpiredForTests('308a0001-056e-47c1-a65c-b29d39f66b83', 'release', 1, CLAIM_FENCE_MAX_MS + 1);
    noteClaimFenceExpiredForTests('308a0002-056e-47c1-a65c-b29d39f66b83', 'renew', 2, CLAIM_FENCE_MAX_MS + 2);
    expect(takeCount()).toBe(2);
    expect(readAuditEvents({ event: 'task.lease.claim_fence_expired', limit: 20 })).toHaveLength(1);

    // 推进超过限频窗后第三键 → 第 2 条 audit
    now = START + interval + 1;
    noteClaimFenceExpiredForTests('308a0003-056e-47c1-a65c-b29d39f66b83', 'release', 3, CLAIM_FENCE_MAX_MS + 3);
    expect(takeCount()).toBe(1);
    expect(readAuditEvents({ event: 'task.lease.claim_fence_expired', limit: 20 })).toHaveLength(2);
  });
});

describe('#308 R1.1 · findTaskMessages I/O 机械证据（附则1）', () => {
  test('正常路径 find=1；fresh 候选 claim find=2（原始计数打印）', async () => {
    // 不用 setTaskGetForTests——走 IMAP 查找层，与 main 同路径
    setTaskGetForTests(null);
    let now = START;
    let messages: RawTaskMessage[] = [submittedRaw()];
    let findCalls = 0;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setFindTaskMessagesForTests(async () => {
      findCalls += 1;
      return { hadMatchingRows: true, messages };
    });
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<308-find-io-${sent.length}>` };
    });

    // —— 正常首 claim：无 release/renew 候选 → findTaskMessages = 1（与 main 逐字一致）——
    findCalls = 0;
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    // 机械证据原始输出（验收点：贴 completion / PR 评论）
    console.log(JSON.stringify({
      tag: '308-r1.1-io-evidence',
      path: 'claim_no_candidate',
      findTaskMessagesCalls: findCalls,
      expect: 1,
    }));
    expect(findCalls).toBe(1);
    expect(grant.leaseGeneration).toBe(1);

    // 吸收 claim；清 overlay；再 release 留下 pending
    messages = [submittedRaw(), await parseSent(sent[0]!, 2)];
    clearQueuedEventsForTests();
    now = START + 1_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'handoff' });

    // —— fresh 候选 re-claim：merge + fence durable = 2 ——
    findCalls = 0;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 }))
      .rejects.toMatchObject({ message: 'lease_overlay_pending_index' });
    console.log(JSON.stringify({
      tag: '308-r1.1-io-evidence',
      path: 'claim_fresh_release_pending',
      findTaskMessagesCalls: findCalls,
      expect: 2,
    }));
    expect(findCalls).toBe(2);
  });
});
