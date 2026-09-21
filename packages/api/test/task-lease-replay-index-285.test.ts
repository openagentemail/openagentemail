// #285：租约重放路径键控去重——去重等价 + expiryReceipts 顺序 + 索引一致性。
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-285-replay-index-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  renewTask,
  taskFromMessages,
  toTaskView,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const {
  isSameAuthenticatedLeaseEventForTests,
  isSameLeaseExpiryIdentityForTests,
  leaseReceiptDedupKeyForTests,
  leaseRenewDedupKeyForTests,
  leaseReplayIndexPushConsistentForTests,
} = await import('../src/lib/tasks-internal.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

const test = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withTaskLeasesEnabledForTests(true, () => withTaskLeaseExpiryAuditM3ForTests(true, work)));

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: `Lease ${ID}`,
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

function expiryDelivery(claimedUntil: string): SendInput {
  return {
    from: A,
    to: [B],
    subject: `Lease ${ID}`,
    text: 'Lease expired.',
    headers: claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: A,
      to: B,
      event: {
        version: 1,
        event: 'expired',
        actor: 'server',
        at: claimedUntil,
        generation: 1,
        claimedUntil,
        expiredAt: claimedUntil,
      },
    }),
  };
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

/** 构造最小 renew 样例（仅身份字段；不经 SMTP）。 */
function renewSample(at: string, claimedUntil: string, tokenVerifier = 'tv-1') {
  return {
    version: 1 as const,
    event: 'renew' as const,
    actor: 'recipient' as const,
    at,
    generation: 1,
    claimedUntil,
    tokenVerifier,
  };
}

describe('#285 去重键 vs .some() 等价', () => {
  test('renew：键相等 ⇔ isSameAuthenticatedLeaseEvent', () => {
    const a = renewSample('2026-08-24T00:01:00.000Z', '2026-08-24T00:06:00.000Z');
    const bSame = renewSample('2026-08-24T00:01:00.000Z', '2026-08-24T00:06:00.000Z');
    const bDiffAt = renewSample('2026-08-24T00:01:01.000Z', '2026-08-24T00:06:00.000Z');
    const bDiffUntil = renewSample('2026-08-24T00:01:00.000Z', '2026-08-24T00:07:00.000Z');
    const samples = [a, bSame, bDiffAt, bDiffUntil];
    for (const left of samples) {
      for (const right of samples) {
        const keyEq = leaseRenewDedupKeyForTests(left) === leaseRenewDedupKeyForTests(right);
        const someEq = isSameAuthenticatedLeaseEventForTests(left, right);
        expect(keyEq).toBe(someEq);
      }
    }
    // 模拟 .some()：已有 [a] 时 bSame 命中、bDiffAt 不命中
    const prior = [a];
    expect(prior.some((p) => isSameAuthenticatedLeaseEventForTests(p, bSame))).toBe(true);
    expect(prior.some((p) => leaseRenewDedupKeyForTests(p) === leaseRenewDedupKeyForTests(bSame))).toBe(true);
    expect(prior.some((p) => isSameAuthenticatedLeaseEventForTests(p, bDiffAt))).toBe(false);
    expect(prior.some((p) => leaseRenewDedupKeyForTests(p) === leaseRenewDedupKeyForTests(bDiffAt))).toBe(false);
  });

  test('expiry 回执：键相等 ⇔ isSameLeaseExpiryIdentity（同代）', () => {
    const a = { leaseGeneration: 1, claimedUntil: '2026-08-24T00:05:00.000Z' };
    const bSame = { generation: 1, claimedUntil: '2026-08-24T00:05:00.000Z' };
    const bDiffUntil = { leaseGeneration: 1, claimedUntil: '2026-08-24T00:06:00.000Z' };
    const bDiffGen = { leaseGeneration: 2, claimedUntil: '2026-08-24T00:05:00.000Z' };
    const samples = [a, bSame, bDiffUntil, bDiffGen];
    for (const left of samples) {
      for (const right of samples) {
        const someEq = isSameLeaseExpiryIdentityForTests(left, right);
        // 生产索引按代分桶后只比 claimedUntil；跨代桶不会互扫。
        const sameGen = (left.leaseGeneration ?? left.generation) === (right.leaseGeneration ?? right.generation);
        const keyEq = sameGen
          && leaseReceiptDedupKeyForTests(left) === leaseReceiptDedupKeyForTests(right);
        expect(keyEq).toBe(someEq);
      }
    }
  });
});

describe('#285 索引与主结构一致性', () => {
  test('连续 push：每代 keys.size === items.length，重复键拒绝', () => {
    const items = new Map<number, Array<{ id: string }>>();
    const keys = new Map<number, Set<string>>();
    expect(leaseReplayIndexPushConsistentForTests({
      items, keys, generation: 1, key: 'k1', item: { id: 'a' },
    })).toBe(true);
    expect(leaseReplayIndexPushConsistentForTests({
      items, keys, generation: 1, key: 'k2', item: { id: 'b' },
    })).toBe(true);
    expect(leaseReplayIndexPushConsistentForTests({
      items, keys, generation: 2, key: 'k1', item: { id: 'c' },
    })).toBe(true);
    // 同代重复键：拒绝且不破坏既有一致性
    expect(leaseReplayIndexPushConsistentForTests({
      items, keys, generation: 1, key: 'k1', item: { id: 'dup' },
    })).toBe(false);
    expect(items.get(1)?.map((x) => x.id)).toEqual(['a', 'b']);
    expect(keys.get(1)?.size).toBe(2);
    expect(items.get(2)?.map((x) => x.id)).toEqual(['c']);
    expect(items.size).toBe(keys.size);
    for (const [gen, arr] of items) {
      expect(keys.get(gen)?.size).toBe(arr.length);
    }
  });
});

describe('#285 expiryReceipts 插入顺序快照', () => {
  test('多窗回执 flat 顺序=入账序（旧窗→最终窗）', async () => {
    // 夹具对齐 #156 claimThenRenew：真实签名链，续约必须拉长窗。
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<285-ord-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    const renewed = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 600 });
    const renewMsg = (await parseCaptured(sent[1]!, 3))!;
    const until1 = first.claimedUntil;
    const until2 = renewed.lease?.claimedUntil;
    expect(until2 && Date.parse(until2) > Date.parse(until1)).toBe(true);
    const expiryOld = (await parseCaptured(expiryDelivery(until1), 4))!;
    const expiryFinal = (await parseCaptured(expiryDelivery(until2!), 5))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renewMsg, expiryOld, expiryFinal]);
    expect(rebuilt).not.toBeNull();
    // 可观察面：Map.values().flat() 保真插入序
    expect(rebuilt!.expiryReceipts?.map((r) => r.claimedUntil)).toEqual([until1, until2]);
    // 颠倒 UID 序 → flat 序随之颠倒（仍为入账序，非按窗排序）
    const reversed = taskFromMessages(ID, [
      submittedRaw(), claim1, renewMsg,
      { ...expiryFinal, uid: 4 },
      { ...expiryOld, uid: 5 },
    ]);
    expect(reversed!.expiryReceipts?.map((r) => r.claimedUntil)).toEqual([until2, until1]);
    // 双回执入账后权威已撤（最终窗回执生效）
    expect(rebuilt!.lease).toBeUndefined();
    expect(JSON.stringify(toTaskView(rebuilt!))).not.toContain('expiryReceipts');
  });
});
