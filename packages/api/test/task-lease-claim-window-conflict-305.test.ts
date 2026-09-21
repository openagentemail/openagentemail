/**
 * #305：读侧降级——已鉴权但与残留权威时间窗冲突的 claim
 * 不再整卡 return null；以证据记账 + audit（R2：同代后续事件可 historical 出账）。
 */
import { randomUUID } from 'node:crypto';
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
  queueLeaseOverlayForTests,
  queuedLeaseOverlayCountForTests,
} = await import('./support/task-test-seams.ts');
const {
  setFindTaskMessagesForTests,
} = await import('../src/lib/tasks-internal.ts');
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
const CLAIM1_AT = new Date(START).toISOString();
const CLAIM1_UNTIL = new Date(START + 300_000).toISOString();
const CONFLICT_AT = new Date(START + 60_000).toISOString();
const CONFLICT_UNTIL = new Date(START + 360_000).toISOString();
const CONFLICT_VERIFIER = 'y'.repeat(43);

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

/** 前缀：handoff + claim1 + 窗冲突 claim2（降级证据）。 */
async function conflictPrefix(verifier: string): Promise<{
  claim1: RawTaskMessage;
  claim2: RawTaskMessage;
  prefix: RawTaskMessage[];
}> {
  const claim1 = await signedLease(ID, 2, {
    version: 1, event: 'claim', actor: B, at: CLAIM1_AT, generation: 1,
    claimedUntil: CLAIM1_UNTIL, tokenVerifier: verifier,
  });
  const claim2 = await signedLease(ID, 3, {
    version: 1, event: 'claim', actor: B, at: CONFLICT_AT, generation: 2,
    claimedUntil: CONFLICT_UNTIL, tokenVerifier: CONFLICT_VERIFIER,
  });
  return { claim1, claim2, prefix: [submittedRaw(), claim1, claim2] };
}

/** 权威仍停前窗（gen1）。 */
function expectAuthorityUnmoved(task: Task | null): void {
  expect(task).not.toBeNull();
  expect(task?.lease).toMatchObject({
    leaseGeneration: 1,
    claimedUntil: CLAIM1_UNTIL,
    firstClaimedAt: CLAIM1_AT,
  });
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
    const { claim1, claim2, prefix } = await conflictPrefix(verifier);

    resetAuditForTests();
    clearQueuedEventsForTests();
    const rebuilt = taskFromMessages(ID, prefix);
    expectAuthorityUnmoved(rebuilt);
    // claim2 按重复事件隐藏：公开消息仅 handoff + claim1
    expect(toTaskView(rebuilt!).messages).toHaveLength(2);
    expect(toTaskView(rebuilt!).messages.map((m) => m.state)).toEqual(['submitted', 'working']);
    // 公开面不含冲突 claim 的事件时间（消息 date 取 lease.at=claim2.at；
    // 勿断言 claim2.claimedUntil——公开 claimedUntil 只来自 task.lease/gen1，该串永不会出现）
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain(CONFLICT_AT);

    const audits = readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 10 });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: 'task.lease.claim_window_conflict_degraded',
      outcome: 'denied',
      taskId: ID,
      leaseGeneration: 2,
    });
    expect(audits[0]).not.toHaveProperty('reason');
    expect(JSON.stringify(audits[0])).not.toContain(CONFLICT_UNTIL);

    // 同键再重建不刷屏
    expect(taskFromMessages(ID, prefix)).not.toBeNull();
    expect(readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 10 })).toHaveLength(1);

    setTaskGetForTests(null);
    setFindTaskMessagesForTests(async () => ({
      hadMatchingRows: true,
      messages: [submittedRaw(), claim1, claim2],
    }));
    const snapped = await getTask(ID);
    expect(snapped?.lease?.leaseGeneration).toBe(1);
    expect(snapped?.lease?.claimedUntil).toBe(CLAIM1_UNTIL);
  });

  test('正2+正3: 邻单不受影响；列表重建包含降级单', async () => {
    const verifier = await liveVerifier();
    const neighborVerifier = await liveVerifier(NEIGHBOR);
    const { prefix: badThread } = await conflictPrefix(verifier);
    const neighborThread = [
      submittedRaw(NEIGHBOR),
      await signedLease(NEIGHBOR, 2, {
        version: 1, event: 'claim', actor: B, at: CLAIM1_AT, generation: 1,
        claimedUntil: CLAIM1_UNTIL, tokenVerifier: neighborVerifier,
      }),
    ];

    const listed = [ID, NEIGHBOR]
      .map((id) => taskFromMessages(id, id === ID ? badThread : neighborThread))
      .filter((task): task is Task => !!task);
    expect(listed.map((t) => t.id).sort()).toEqual([ID, NEIGHBOR].sort());
    expect(listed.find((t) => t.id === ID)?.lease?.leaseGeneration).toBe(1);
    expect(listed.find((t) => t.id === NEIGHBOR)?.lease).toMatchObject({
      leaseGeneration: 1,
      claimedUntil: CLAIM1_UNTIL,
    });
  });

  test('负1: 无冲突 claim（合法 release 后 re-claim）行为不变', async () => {
    const verifier = await liveVerifier();
    const claim2At = new Date(START + 180_000).toISOString();
    const claim2Until = new Date(START + 480_000).toISOString();
    const history = [
      submittedRaw(),
      await signedLease(ID, 2, {
        version: 1, event: 'claim', actor: B, at: CLAIM1_AT, generation: 1,
        claimedUntil: CLAIM1_UNTIL, tokenVerifier: verifier,
      }),
      await signedLease(ID, 3, {
        version: 1, event: 'release', actor: B, at: new Date(START + 120_000).toISOString(),
        generation: 1, tokenVerifier: verifier, reason: 'handoff',
      }),
      await signedLease(ID, 4, {
        version: 1, event: 'claim', actor: B, at: claim2At, generation: 2,
        claimedUntil: claim2Until, tokenVerifier: 'w'.repeat(43),
      }),
    ];

    resetAuditForTests();
    clearQueuedEventsForTests();
    const rebuilt = taskFromMessages(ID, history);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toMatchObject({
      leaseGeneration: 2,
      claimedUntil: claim2Until,
      firstClaimedAt: CLAIM1_AT,
    });
    expect(rebuilt?.releasedLease).toBeUndefined();
    expect(readAuditEvents({ event: 'task.lease.claim_window_conflict_degraded', limit: 5 })).toHaveLength(0);
  });

  test('负2: 鉴权不弱化——坏签名 lease 仍被 parse 层丢弃', async () => {
    const verifier = await liveVerifier();
    const claim1 = await signedLease(ID, 2, {
      version: 1, event: 'claim', actor: B, at: CLAIM1_AT, generation: 1,
      claimedUntil: CLAIM1_UNTIL, tokenVerifier: verifier,
    });
    const headers = claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: B,
      to: A,
      event: {
        version: 1, event: 'claim', actor: B,
        at: CONFLICT_AT, generation: 2, claimedUntil: CONFLICT_UNTIL, tokenVerifier: 'f'.repeat(43),
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
    expect(taskFromMessages(ID, [submittedRaw(), claim1])?.lease?.leaseGeneration).toBe(1);
  });

  test('负3: 降级=忽略≠接受——冲突 claim 不获得权威', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const rebuilt = taskFromMessages(ID, prefix);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.lease?.leaseGeneration).toBe(1);
    expect(rebuilt!.lease?.claimedUntil).toBe(CLAIM1_UNTIL);
    expect(rebuilt!.lease?.firstClaimedAt).toBe(CLAIM1_AT);
    expect(rebuilt!.lease?.tokenVerifier === verifier).toBe(true);
    expect(toTaskView(rebuilt!).messages).toHaveLength(2);
    // 同上：断言 claim2.at（CONFLICT_AT），非 claim2.claimedUntil
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain(CONFLICT_AT);
  });
});

describe('#305 R2 同代后续事件不出整卡 null', () => {
  type FollowOn = 'renew' | 'release' | 'expired' | 'next-claim';

  const cases: Array<{
    name: FollowOn;
    build: (uid: number) => Promise<RawTaskMessage>;
    bad: (uid: number) => Promise<RawTaskMessage>;
  }> = [
    {
      name: 'renew',
      build: (uid) => signedLease(ID, uid, {
        version: 1, event: 'renew', actor: B,
        at: new Date(START + 90_000).toISOString(),
        generation: 2,
        claimedUntil: new Date(START + 420_000).toISOString(),
        tokenVerifier: CONFLICT_VERIFIER,
      }),
      // verifier 不符 → 仍 fail-closed
      bad: (uid) => signedLease(ID, uid, {
        version: 1, event: 'renew', actor: B,
        at: new Date(START + 90_000).toISOString(),
        generation: 2,
        claimedUntil: new Date(START + 420_000).toISOString(),
        tokenVerifier: 'x'.repeat(43),
      }),
    },
    {
      name: 'release',
      build: (uid) => signedLease(ID, uid, {
        version: 1, event: 'release', actor: B,
        at: new Date(START + 90_000).toISOString(),
        generation: 2,
        tokenVerifier: CONFLICT_VERIFIER,
        reason: 'done',
      }),
      bad: (uid) => signedLease(ID, uid, {
        version: 1, event: 'release', actor: B,
        at: new Date(START + 90_000).toISOString(),
        generation: 2,
        tokenVerifier: 'x'.repeat(43),
        reason: 'done',
      }),
    },
    {
      name: 'expired',
      build: (uid) => signedLease(ID, uid, {
        version: 1, event: 'expired', actor: 'server',
        at: CONFLICT_UNTIL, generation: 2,
        claimedUntil: CONFLICT_UNTIL, expiredAt: CONFLICT_UNTIL,
      }),
      // 未知窗 → 仍 fail-closed
      bad: (uid) => signedLease(ID, uid, {
        version: 1, event: 'expired', actor: 'server',
        at: new Date(START + 999_000).toISOString(),
        generation: 2,
        claimedUntil: new Date(START + 999_000).toISOString(),
        expiredAt: new Date(START + 999_000).toISOString(),
      }),
    },
    {
      name: 'next-claim',
      // 仍落在 claim1 窗内 → 再次降级；权威不推进
      build: (uid) => signedLease(ID, uid, {
        version: 1, event: 'claim', actor: B,
        at: new Date(START + 120_000).toISOString(),
        generation: 3,
        claimedUntil: new Date(START + 480_000).toISOString(),
        tokenVerifier: 'z'.repeat(43),
      }),
      // generation 跳号（缺 gen3 证据却直接 gen4）→ 仍 fail-closed
      bad: (uid) => signedLease(ID, uid, {
        version: 1, event: 'claim', actor: B,
        at: new Date(START + 120_000).toISOString(),
        generation: 4,
        claimedUntil: new Date(START + 480_000).toISOString(),
        tokenVerifier: 'z'.repeat(43),
      }),
    },
  ];

  for (const c of cases) {
    test(`R2 正控: 冲突 claim + ${c.name} → 可读且权威不推进`, async () => {
      const verifier = await liveVerifier();
      const { prefix } = await conflictPrefix(verifier);
      const follow = await c.build(4);
      const rebuilt = taskFromMessages(ID, [...prefix, follow]);
      expectAuthorityUnmoved(rebuilt);
      // 冲突 claim 与后续 historical/降级事件均不进公开面
      expect(toTaskView(rebuilt!).messages).toHaveLength(2);
    });

    test(`R2 负控: 冲突 claim + 坏 ${c.name} 仍拒（整卡 fail-closed）`, async () => {
      const verifier = await liveVerifier();
      const { prefix } = await conflictPrefix(verifier);
      const bad = await c.bad(4);
      expect(taskFromMessages(ID, [...prefix, bad])).toBeNull();
    });
  }
});

describe('#305 R2 audit 去重表击穿有界', () => {
  test('>cap 稳定键扫描：全局限频下 audit 写入有界', async () => {
    const {
      noteClaimWindowConflictDegradedForTests,
      CLAIM_WINDOW_CONFLICT_DEGRADED_SEEN_CAP: cap,
    } = await import('../src/lib/tasks-internal.ts');

    resetAuditForTests();
    clearQueuedEventsForTests();
    setTaskNowForTests(() => START);

    const keys = Array.from({ length: cap + 1 }, (_, i) => ({
      taskId: randomUUID(),
      generation: 2,
      claimedUntil: new Date(START + 360_000 + i).toISOString(),
    }));

    // 第一轮：>cap 不同键填满 FIFO 去重表
    for (const k of keys) {
      noteClaimWindowConflictDegradedForTests(k.taskId, k.generation, k.claimedUntil);
    }
    expect(readAuditEvents({
      event: 'task.lease.claim_window_conflict_degraded',
      limit: 1000,
    }).length).toBe(1);

    // 第二轮：相同稳定序再扫——无全局限频时 FIFO 击穿会整批重写
    for (const k of keys) {
      noteClaimWindowConflictDegradedForTests(k.taskId, k.generation, k.claimedUntil);
    }
    expect(readAuditEvents({
      event: 'task.lease.claim_window_conflict_degraded',
      limit: 1000,
    }).length).toBe(1);

    // 新键均计数（含限频吞掉未写 audit 的键）；去重表次序不变
    const {
      takeClaimWindowConflictDegradedCountForTests,
    } = await import('../src/lib/tasks-internal.ts');
    // 两轮各 cap+1 次首次见键；第二轮因 FIFO 淘汰后再次 miss，再计 cap+1
    expect(takeClaimWindowConflictDegradedCountForTests()).toBe((cap + 1) * 2);
  });
});

describe('#305 R3 降级代写路径复用编号', () => {
  const REISSUE_VERIFIER = 'r'.repeat(43);
  // 权威窗过后重发（写路径 durableGen=1 → gen2'）
  const REISSUE_AT = new Date(START + 300_000).toISOString(); // == CLAIM1_UNTIL，at >= 窗
  const REISSUE_UNTIL = new Date(START + 600_000).toISOString();
  // 仍落在权威窗内的同代异容重发
  const STILL_CONFLICT_AT = new Date(START + 90_000).toISOString();
  const STILL_CONFLICT_UNTIL = new Date(START + 390_000).toISOString();
  const STILL_CONFLICT_VERIFIER = 's'.repeat(43);

  test('R3①: 降级 gen2 → gen2\'(at≥窗、异容) → 可读且权威推进到 gen2\'', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const reissue = await signedLease(ID, 4, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    const rebuilt = taskFromMessages(ID, [...prefix, reissue]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toMatchObject({
      leaseGeneration: 2,
      claimedUntil: REISSUE_UNTIL,
      tokenVerifier: REISSUE_VERIFIER,
      firstClaimedAt: CLAIM1_AT,
    });
    // 降级 claim2 仍隐藏；reissue 作为已接受 claim 可见 → handoff + claim1 + gen2'
    expect(toTaskView(rebuilt!).messages).toHaveLength(3);
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain(CONFLICT_AT);
  });

  test('R3②: 降级 gen2 → gen2\'\'(at<窗、异容) → 仍降级、权威不推进', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const again = await signedLease(ID, 4, {
      version: 1, event: 'claim', actor: B,
      at: STILL_CONFLICT_AT, generation: 2,
      claimedUntil: STILL_CONFLICT_UNTIL, tokenVerifier: STILL_CONFLICT_VERIFIER,
    });
    const rebuilt = taskFromMessages(ID, [...prefix, again]);
    expectAuthorityUnmoved(rebuilt);
    expect(rebuilt?.lease?.tokenVerifier).toBe(verifier);
    expect(toTaskView(rebuilt!).messages).toHaveLength(2);
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain(STILL_CONFLICT_AT);
  });

  test('R3③: 原 verifier 的 renew/release 在重发前到达 → R2 出账保持', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const renew = await signedLease(ID, 4, {
      version: 1, event: 'renew', actor: B,
      at: new Date(START + 90_000).toISOString(),
      generation: 2,
      claimedUntil: new Date(START + 420_000).toISOString(),
      tokenVerifier: CONFLICT_VERIFIER,
    });
    const withRenew = taskFromMessages(ID, [...prefix, renew]);
    expectAuthorityUnmoved(withRenew);
    expect(toTaskView(withRenew!).messages).toHaveLength(2);

    const release = await signedLease(ID, 4, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 90_000).toISOString(),
      generation: 2,
      tokenVerifier: CONFLICT_VERIFIER,
      reason: 'done',
    });
    const withRelease = taskFromMessages(ID, [...prefix, release]);
    expectAuthorityUnmoved(withRelease);
    expect(toTaskView(withRelease!).messages).toHaveLength(2);
  });

  test('R3 边界: 降级 gen2 + 原 verifier renew 后接受 gen2\' → 原 renew 与新权威共存时保守 null', async () => {
    // 声明边界：证据被 gen2' 覆盖后，旧 verifier 的 historical renew 与新权威同代冲突 → fail-closed
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const renewOld = await signedLease(ID, 4, {
      version: 1, event: 'renew', actor: B,
      at: new Date(START + 90_000).toISOString(),
      generation: 2,
      claimedUntil: new Date(START + 420_000).toISOString(),
      tokenVerifier: CONFLICT_VERIFIER,
    });
    const reissue = await signedLease(ID, 5, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    // renew 在前、reissue 在后：renew 先 historical 出账；reissue 覆盖证据后权威=gen2'。
    // 若 renew 仍留在 appliedRenews 且后续路径与新权威冲突——本实现：reissue 接受后旧 renew 已隐藏，线程可读。
    // 反向边界（reissue 后再来旧 renew）钉死为 null：
    const afterAccept = taskFromMessages(ID, [...prefix, reissue]);
    expect(afterAccept?.lease?.leaseGeneration).toBe(2);
    const lateOldRenew = await signedLease(ID, 6, {
      version: 1, event: 'renew', actor: B,
      at: new Date(START + 310_000).toISOString(),
      generation: 2,
      claimedUntil: new Date(START + 650_000).toISOString(),
      tokenVerifier: CONFLICT_VERIFIER, // 旧 verifier，与新权威不符
    });
    expect(taskFromMessages(ID, [...prefix, reissue, lateOldRenew])).toBeNull();
    // renew-before-reissue 线程仍可读（旧 renew 已隐藏）
    expect(taskFromMessages(ID, [...prefix, renewOld, reissue])?.lease?.leaseGeneration).toBe(2);
  });

  test('R3 端到端: seam 降级任务 → claimTask 真实分配 → 重建权威=新代', async () => {
    // 两闸必并：经 claimTask 分配，不用手工构造 gen2'。
    // 高水位暴露后应分配 gen3（durableGen=max(1, highWater=2)+1）。
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    let durable = taskFromMessages(ID, prefix)!;
    expect(durable.leaseGenerationHighWater).toBe(2);
    expect(durable.lease?.leaseGeneration).toBe(1);

    const sent: Array<{ headers?: Record<string, string>; from: string; to: string[]; subject: string; text: string }> = [];
    // 权威窗过后：deriveExpired → durableGen 含 highWater=2 → 新代=3
    let now = Date.parse(CLAIM1_UNTIL);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input as typeof sent[number]);
      return { messageId: `<r3-e2e-${sent.length}>` };
    });
    clearQueuedEventsForTests();

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grant.leaseGeneration).toBe(3);
    expect(grant.task.lease?.leaseGeneration).toBe(3);
    // M3-off 时可能先物化 expiry 信；取最后一封 claim 事件
    const claimSend = [...sent].reverse().find(
      (row) => row.headers?.['X-OA-Task-Lease-Event'] === 'claim',
    );
    expect(claimSend).toBeDefined();

    const issued = await parseTaskMessageForTests({
      uid: 4,
      source: source(
        claimSend!.from,
        claimSend!.to[0]!,
        claimSend!.subject,
        claimSend!.headers ?? {},
      ),
      envelope: {
        from: [{ address: claimSend!.from }],
        to: [{ address: claimSend!.to[0]! }],
        subject: claimSend!.subject,
      },
      internalDate: new Date(now),
    } as unknown as FetchMessageObject, ID);
    expect(issued?.lease?.event).toBe('claim');
    expect(issued?.lease && 'generation' in issued.lease ? issued.lease.generation : 0).toBe(3);

    const rebuilt = taskFromMessages(ID, [...prefix, issued!]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease?.leaseGeneration).toBe(3);
    expect(rebuilt?.lease?.tokenVerifier).toBe(
      issued?.lease && 'tokenVerifier' in issued.lease ? issued.lease.tokenVerifier : undefined,
    );
    // 公开面不含降级 claim2.at；含新代
    expect(toTaskView(rebuilt!).messages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain(CONFLICT_AT);
  });
});

describe('#305 R4 release 残渣与多降级代', () => {
  const REISSUE_VERIFIER = 'r'.repeat(43);
  const REISSUE_AT = new Date(START + 300_000).toISOString();
  const REISSUE_UNTIL = new Date(START + 600_000).toISOString();
  const GEN3_AT = new Date(START + 120_000).toISOString();
  const GEN3_UNTIL = new Date(START + 480_000).toISOString();
  const GEN3_VERIFIER = 'z'.repeat(43);

  test('R4 P1-B①: 降级 gen2 + 旧 release → gen2\' 接受 → 新 token release 可读', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const oldRelease = await signedLease(ID, 4, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 90_000).toISOString(),
      generation: 2,
      tokenVerifier: CONFLICT_VERIFIER,
      reason: 'old-instance',
    });
    const reissue = await signedLease(ID, 5, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    const newRelease = await signedLease(ID, 6, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 310_000).toISOString(),
      generation: 2,
      tokenVerifier: REISSUE_VERIFIER,
      reason: 'new-instance',
    });
    const rebuilt = taskFromMessages(ID, [...prefix, oldRelease, reissue, newRelease]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.lease).toBeUndefined();
    expect(rebuilt?.releasedLease).toMatchObject({
      leaseGeneration: 2,
      tokenVerifier: REISSUE_VERIFIER,
    });
  });

  test('R4 P1-B②: 接受 gen2\' 后旧 token release → 保守 null（边界不变）', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const reissue = await signedLease(ID, 4, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    const lateOldRelease = await signedLease(ID, 5, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 310_000).toISOString(),
      generation: 2,
      tokenVerifier: CONFLICT_VERIFIER,
      reason: 'stale',
    });
    expect(taskFromMessages(ID, [...prefix, reissue, lateOldRelease])).toBeNull();
  });

  test('R4 P1-B③: 重新降级覆盖时亦清残渣 → 其后 gen2\' + 新 release 可读', async () => {
    // 推演：re-degrade 与 accept 同清；否则旧 release 残渣在 accept 前仍占 appliedReleases。
    const STILL_AT = new Date(START + 90_000).toISOString();
    const STILL_UNTIL = new Date(START + 390_000).toISOString();
    const STILL_VERIFIER = 's'.repeat(43);
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const oldRelease = await signedLease(ID, 4, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 70_000).toISOString(),
      generation: 2,
      tokenVerifier: CONFLICT_VERIFIER,
      reason: 'old-instance',
    });
    const redegrade = await signedLease(ID, 5, {
      version: 1, event: 'claim', actor: B,
      at: STILL_AT, generation: 2,
      claimedUntil: STILL_UNTIL, tokenVerifier: STILL_VERIFIER,
    });
    const reissue = await signedLease(ID, 6, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    const newRelease = await signedLease(ID, 7, {
      version: 1, event: 'release', actor: B,
      at: new Date(START + 310_000).toISOString(),
      generation: 2,
      tokenVerifier: REISSUE_VERIFIER,
      reason: 'new-instance',
    });
    const rebuilt = taskFromMessages(ID, [...prefix, oldRelease, redegrade, reissue, newRelease]);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.releasedLease).toMatchObject({
      leaseGeneration: 2,
      tokenVerifier: REISSUE_VERIFIER,
    });
  });

  test('R4 P1-A① E2E: 连续降级 gen2+gen3 → highWater=3 → claimTask 分配 gen4', async () => {
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const deg3 = await signedLease(ID, 4, {
      version: 1, event: 'claim', actor: B,
      at: GEN3_AT, generation: 3,
      claimedUntil: GEN3_UNTIL, tokenVerifier: GEN3_VERIFIER,
    });
    const durable = taskFromMessages(ID, [...prefix, deg3])!;
    expect(durable.leaseGenerationHighWater).toBe(3);
    expect(durable.lease?.leaseGeneration).toBe(1);

    const sent: Array<{ headers?: Record<string, string>; from: string; to: string[]; subject: string; text: string }> = [];
    const now = Date.parse(CLAIM1_UNTIL);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input as typeof sent[number]);
      return { messageId: `<r4-e2e-${sent.length}>` };
    });
    clearQueuedEventsForTests();

    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(grant.leaseGeneration).toBe(4);
    const claimSend = [...sent].reverse().find(
      (row) => row.headers?.['X-OA-Task-Lease-Event'] === 'claim',
    );
    expect(claimSend).toBeDefined();
    const issued = await parseTaskMessageForTests({
      uid: 5,
      source: source(claimSend!.from, claimSend!.to[0]!, claimSend!.subject, claimSend!.headers ?? {}),
      envelope: {
        from: [{ address: claimSend!.from }],
        to: [{ address: claimSend!.to[0]! }],
        subject: claimSend!.subject,
      },
      internalDate: new Date(now),
    } as unknown as FetchMessageObject, ID);
    expect(issued?.lease && 'generation' in issued.lease ? issued.lease.generation : 0).toBe(4);
    const rebuilt = taskFromMessages(ID, [...prefix, deg3, issued!]);
    expect(rebuilt?.lease?.leaseGeneration).toBe(4);
  });

  test('R4 P1-A②: 多降级后更早代 gen2\' 重评估 → 保 null（不放宽门；高水位写路径已覆盖）', async () => {
    // 放宽为「降级集合内且 ≤ previousGeneration」会使 prevGen 回退并与更高降级代残渣交错，风险实质 → 保 null。
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const deg3 = await signedLease(ID, 4, {
      version: 1, event: 'claim', actor: B,
      at: GEN3_AT, generation: 3,
      claimedUntil: GEN3_UNTIL, tokenVerifier: GEN3_VERIFIER,
    });
    const earlyReissue = await signedLease(ID, 5, {
      version: 1, event: 'claim', actor: B,
      at: REISSUE_AT, generation: 2,
      claimedUntil: REISSUE_UNTIL, tokenVerifier: REISSUE_VERIFIER,
    });
    expect(taskFromMessages(ID, [...prefix, deg3, earlyReissue])).toBeNull();
  });
});

describe('#305 R4 P1-1 overlay/journal 决退降级 claim', () => {
  test('R4 P1-1① RED→绿: durable 降级后 queued 冲突 claim 退休且权威=前窗', async () => {
    // 亲核：eventIsIndexed 只看 authority/released/expired/lost → 降级 gen2 永不退休 → overlay 复现为活跃权威。
    const verifier = await liveVerifier();
    const { claim2, prefix } = await conflictPrefix(verifier);
    const durable = taskFromMessages(ID, prefix)!;
    expect(durable.lease?.leaseGeneration).toBe(1);

    clearQueuedEventsForTests();
    const lease = claim2.lease!;
    expect(lease.event).toBe('claim');
    queueLeaseOverlayForTests({
      taskId: ID,
      sentAt: Date.parse(CONFLICT_AT),
      generation: 2,
      at: CONFLICT_AT,
      claimedUntil: CONFLICT_UNTIL,
      tokenVerifier: CONFLICT_VERIFIER,
      actor: B,
      from: B,
      to: A,
      subject: `Lease ${ID}`,
    });
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(1);

    setTaskGetForTests(async () => durable);
    setTaskNowForTests(() => START + 90_000);
    const merged = await getTask(ID);
    expect(merged?.lease?.leaseGeneration).toBe(1);
    expect(merged?.lease?.claimedUntil).toBe(CLAIM1_UNTIL);
    expect(merged?.lease?.tokenVerifier).toBe(verifier);
    // 私有证据不得进公开投影
    expect(toTaskView(merged!)).not.toHaveProperty('degradedLeaseClaims');
    expect(JSON.stringify(toTaskView(merged!))).not.toContain(CONFLICT_VERIFIER);
    // 该行已退休：再读不得重放
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(0);
    const again = await getTask(ID);
    expect(again?.lease?.leaseGeneration).toBe(1);
  });

  test('R4 P1-1②: 非降级 claim overlay 行为逐字不变（权威匹配仍应用/退休）', async () => {
    const verifier = await liveVerifier();
    const claim1 = await signedLease(ID, 2, {
      version: 1, event: 'claim', actor: B,
      at: CLAIM1_AT, generation: 1,
      claimedUntil: CLAIM1_UNTIL, tokenVerifier: verifier,
    });
    // durable 尚无 claim：queued gen1 应被 overlay 应用为权威
    const base = taskFromMessages(ID, [submittedRaw()])!;
    expect(base.lease).toBeUndefined();
    clearQueuedEventsForTests();
    queueLeaseOverlayForTests({
      taskId: ID,
      sentAt: START,
      generation: 1,
      at: CLAIM1_AT,
      claimedUntil: CLAIM1_UNTIL,
      tokenVerifier: verifier,
      actor: B,
      from: B,
      to: A,
    });
    setTaskGetForTests(async () => base);
    setTaskNowForTests(() => START + 10_000);
    const withOverlay = await getTask(ID);
    expect(withOverlay?.lease).toMatchObject({
      leaseGeneration: 1,
      claimedUntil: CLAIM1_UNTIL,
      tokenVerifier: verifier,
    });
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(1);

    // durable 已索引同身份 claim → overlay 退休
    const indexed = taskFromMessages(ID, [submittedRaw(), claim1])!;
    setTaskGetForTests(async () => indexed);
    const afterIndex = await getTask(ID);
    expect(afterIndex?.lease?.leaseGeneration).toBe(1);
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(0);
  });

  test('R4 P1-1②b: high-water  alone 不得误退身份不符的 queued claim', async () => {
    // 防误退：仅有高水位=2、降级证据是 CONFLICT，queued 却是另一 verifier → 不得靠代际退休。
    const OTHER = 'q'.repeat(43);
    const verifier = await liveVerifier();
    const { prefix } = await conflictPrefix(verifier);
    const durable = taskFromMessages(ID, prefix)!;
    expect(durable.leaseGenerationHighWater).toBe(2);
    clearQueuedEventsForTests();
    queueLeaseOverlayForTests({
      taskId: ID,
      sentAt: Date.parse(CONFLICT_AT),
      generation: 2,
      at: CONFLICT_AT,
      claimedUntil: CONFLICT_UNTIL,
      tokenVerifier: OTHER,
      actor: B,
      from: B,
      to: A,
    });
    setTaskGetForTests(async () => durable);
    setTaskNowForTests(() => START + 90_000);
    await getTask(ID);
    // 身份不符 → 仍滞后（会被 apply 为活跃——这是未索引异容行的既有行为；关键是不得被 high-water 静默退休）
    expect(queuedLeaseOverlayCountForTests(ID)).toBe(1);
  });

  test('R4 P1-1③: journal-on 水合——降级证据身份匹配则决退 accepted claim 行', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const {
      bootstrapTaskLeaseJournal,
      journalRecordsFor,
      resetJournalMemoryForTests,
      setJournalDataDirForTests,
      upsertJournalRecord,
    } = await import('../src/lib/task-lease-journal.ts');
    const { withTaskLeasePendingJournalForTests } = await import('./support/task-lease-seams.ts');

    await withTaskLeasePendingJournalForTests(true, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oae-305-j-'));
      setJournalDataDirForTests(dir);
      resetJournalMemoryForTests();
      bootstrapTaskLeaseJournal();

      const verifier = await liveVerifier();
      const { prefix } = await conflictPrefix(verifier);
      const durable = taskFromMessages(ID, prefix)!;
      expect(durable.lease?.leaseGeneration).toBe(1);

      clearQueuedEventsForTests();
      await upsertJournalRecord({
        taskId: ID,
        kind: 'claim',
        generation: 2,
        actor: B,
        at: CONFLICT_AT,
        fate: 'accepted',
        claimedUntil: CONFLICT_UNTIL,
        tokenVerifier: CONFLICT_VERIFIER,
      });
      expect(journalRecordsFor(ID).find((r) => r.kind === 'claim' && r.generation === 2)?.fate)
        .toBe('accepted');

      setTaskGetForTests(async () => durable);
      setTaskNowForTests(() => START + 90_000);
      const merged = await getTask(ID);
      expect(merged?.lease?.leaseGeneration).toBe(1);
      expect(merged?.lease?.tokenVerifier).toBe(verifier);
      // 水合路径经 eventIsIndexed → fate=indexed；不得再入 queued 重放
      expect(queuedLeaseOverlayCountForTests(ID)).toBe(0);
      expect(journalRecordsFor(ID).find((r) => r.kind === 'claim' && r.generation === 2)?.fate)
        .toBe('indexed');
    });
  });
});
