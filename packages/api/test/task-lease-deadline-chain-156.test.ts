// #156 (ORDER-2194-R1): accepted-chain deadline history。
// 续约后旧窗签名回执 = 审计 no-op；同代多个精确 accepted-chain 窗回执允许并存；
// 未知窗/未验证未来 UID/非 server actor 仍 fail-closed；M2 精确证据退休，未知行保持 OPEN。
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-156-deadline-chain-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  getTask,
  isTaskLeaseTokenCurrent,
  listTaskBoard,
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
  journalPersistCountForTests,
  journalRecordsFor,
  resetJournalMemoryForTests,
  setJournalDataDirForTests,
  upsertJournalRecord,
} = await import('../src/lib/task-lease-journal.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

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

function expiryDelivery(input: {
  claimedUntil: string;
  generation?: number;
  actor?: string;
  at?: string;
}): SendInput {
  const at = input.at ?? input.claimedUntil;
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
        actor: (input.actor ?? 'server') as 'server',
        at,
        generation: input.generation ?? 1,
        claimedUntil: input.claimedUntil,
        expiredAt: at,
      },
    }),
  };
}

async function withM3On<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeaseExpiryAuditM3ForTests(true, work));
}

async function withM2On<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, work));
}

async function withM2Off<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(false, work));
}

const testOn = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withM3On(work));

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
  resetJournalMemoryForTests();
});

function isolateJournal(): void {
  const dir = mkdtempSync(join(tmpdir(), 'oae-156-iso-'));
  setJournalDataDirForTests(dir);
  bootstrapTaskLeaseJournal();
}

/** Real signed claimT1 -> renewT2 chain via the public API; returns captures. */
async function claimThenRenew(): Promise<{
  first: Awaited<ReturnType<typeof claimTask>>;
  renewedUntil: string;
  claim1: RawTaskMessage;
  renew1: RawTaskMessage;
  sent: SendInput[];
}> {
  let durable = submittedTask();
  const sent: SendInput[] = [];
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<156-${sent.length}>` };
  });
  const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
  const claim1 = (await parseCaptured(sent[0]!, 2))!;
  durable = taskFromMessages(ID, [submittedRaw(), claim1])!;
  clearQueuedEventsForTests();
  setTaskGetForTests(async () => durable);
  const renewedTask = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 600 });
  const renew1 = (await parseCaptured(sent[1]!, 3))!;
  const renewedUntil = renewedTask.lease?.claimedUntil;
  if (!renewedUntil || Date.parse(renewedUntil) <= Date.parse(first.claimedUntil)) {
    throw new Error('fixture must extend the window');
  }
  return { first, renewedUntil, claim1, renew1, sent };
}

/**
 * #188：认证 claim + 两次续约，构造三窗口链（T1→T2→T3）。
 * 返回各窗截止与邮件证据，供中间窗回执控制用例复用。
 */
async function claimThenTwoRenews(): Promise<{
  first: Awaited<ReturnType<typeof claimTask>>;
  until1: string;
  until2: string;
  until3: string;
  claim1: RawTaskMessage;
  renew1: RawTaskMessage;
  renew2: RawTaskMessage;
  sent: SendInput[];
}> {
  let durable = submittedTask();
  const sent: SendInput[] = [];
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<156-3w-${sent.length}>` };
  });
  const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
  const claim1 = (await parseCaptured(sent[0]!, 2))!;
  durable = taskFromMessages(ID, [submittedRaw(), claim1])!;
  clearQueuedEventsForTests();
  setTaskGetForTests(async () => durable);
  const renewA = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 600 });
  const renew1 = (await parseCaptured(sent[1]!, 3))!;
  const until2 = renewA.lease?.claimedUntil;
  if (!until2 || Date.parse(until2) <= Date.parse(first.claimedUntil)) {
    throw new Error('first renew must extend the window');
  }
  durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1])!;
  clearQueuedEventsForTests();
  setTaskGetForTests(async () => durable);
  const renewB = await renewTask({ id: ID, from: B, leaseToken: first.leaseToken, leaseSec: 900 });
  const renew2 = (await parseCaptured(sent[2]!, 4))!;
  const until3 = renewB.lease?.claimedUntil;
  if (!until3 || Date.parse(until3) <= Date.parse(until2)) {
    throw new Error('second renew must extend past the intermediate window');
  }
  return {
    first,
    until1: first.claimedUntil,
    until2,
    until3,
    claim1,
    renew1,
    renew2,
    sent,
  };
}

describe('#156 RED-core: 同代续约后旧窗回执', () => {
  testOn('claim T1 -> renew T2 -> 迟到签名 expiry(T1)：重建成功且权威=T2，回执仅审计', async () => {
    const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
    const lateExpiry = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1, lateExpiry]);
    expect({
      rebuilt: rebuilt !== null,
      generation: rebuilt?.lease?.leaseGeneration ?? null,
      claimedUntil: rebuilt?.lease?.claimedUntil ?? null,
      renewedCurrent: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      firstCurrent: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      noExpiredLease: rebuilt?.expiredLease === undefined,
      publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      phantom: rebuilt ? toTaskView(rebuilt).messages.some((m) => m.body === 'Lease expired.') : true,
    }).toEqual({
      rebuilt: true,
      generation: 1,
      claimedUntil: renewedUntil,
      renewedCurrent: true,
      firstCurrent: true,
      noExpiredLease: true,
      publicMessages: 3,
      phantom: false,
    });
  });

  testOn('同代双回执两种 UID 序：旧窗/最终窗均为 accepted-chain 节点，最终窗生效', async () => {
    const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
    const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
    const expiryFinal = (await parseCaptured(expiryDelivery({ claimedUntil: renewedUntil }), 5))!;
    const oldFirst = taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld, expiryFinal]);
    const finalFirst = taskFromMessages(ID, [
      submittedRaw(), claim1, renew1,
      { ...expiryFinal, uid: 4 }, { ...expiryOld, uid: 5 },
    ]);
    for (const [label, rebuilt] of [['old-first', oldFirst], ['final-first', finalFirst]] as const) {
      expect({
        label,
        rebuilt: rebuilt !== null,
        noAuthority: rebuilt?.lease === undefined,
        expiredWindow: rebuilt?.expiredLease?.claimedUntil ?? null,
        expiredGen: rebuilt?.expiredLease?.leaseGeneration ?? null,
        publicExpiryBodies: rebuilt
          ? toTaskView(rebuilt).messages.filter((m) => m.body === 'Lease expired.').length
          : -1,
      }).toEqual({
        label,
        rebuilt: true,
        noAuthority: true,
        expiredWindow: renewedUntil,
        expiredGen: 1,
        publicExpiryBodies: 1,
      });
    }
  });

  testOn('同身份重复回执幂等：旧窗回执两次投递仍只审计一次', async () => {
    const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
    const dup1 = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
    const dup2 = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 5))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1, dup1, dup2]);
    expect({
      rebuilt: rebuilt !== null,
      claimedUntil: rebuilt?.lease?.claimedUntil ?? null,
      publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      noExpiredLease: rebuilt?.expiredLease === undefined,
    }).toEqual({
      rebuilt: true,
      claimedUntil: renewedUntil,
      publicMessages: 3,
      noExpiredLease: true,
    });
  });
});

describe('#156 历史代与终态', () => {
  testOn('代 N 续约后跨代：N+1 权威下，N 的旧窗与最终窗回执都只审计', async () => {
    const { first, renewedUntil, claim1, renew1, sent } = await claimThenRenew();
    let durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1])!;
    setTaskGetForTests(async () => durable);
    setTaskNowForTests(() => Date.parse(renewedUntil));
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim2 = (await parseCaptured(sent[2]!, 4))!;
    const expiryOldN = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 5))!;
    const expiryFinalN = (await parseCaptured(expiryDelivery({ claimedUntil: renewedUntil }), 6))!;
    for (const [label, receipt] of [['old-window', expiryOldN], ['final-window', expiryFinalN]] as const) {
      const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1, claim2, receipt]);
      expect({
        label,
        rebuilt: rebuilt !== null,
        generation: rebuilt?.lease?.leaseGeneration ?? null,
        gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
        noExpiredLease: rebuilt?.expiredLease === undefined,
        publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      }).toEqual({
        label,
        rebuilt: true,
        generation: 2,
        gen2Current: true,
        noExpiredLease: true,
        publicMessages: 4,
      });
    }
    durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1, claim2])!;
    expect(durable.lease?.leaseGeneration).toBe(2);
  });

  testOn('终态冻结：completed 后旧窗+最终窗回执都不重开、不留幻影、不印章 expiredLease', async () => {
    const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
    const completed: RawTaskMessage = {
      uid: 4, from: B, to: A, subject: `Lease ${ID}`,
      date: '2026-08-24T00:06:00.000Z', state: 'completed', body: 'done',
    };
    const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 5))!;
    const expiryFinal = (await parseCaptured(expiryDelivery({ claimedUntil: renewedUntil }), 6))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1, completed, expiryOld, expiryFinal]);
    const view = rebuilt ? toTaskView(rebuilt) : null;
    expect({
      rebuilt: rebuilt !== null,
      state: view?.state ?? null,
      expiredStamped: rebuilt?.expiredLease !== undefined,
      phantom: view?.messages.some((m) => m.body === 'Lease expired.') ?? true,
      publicMessages: view?.messages.length ?? 0,
    }).toEqual({
      rebuilt: true,
      state: 'completed',
      expiredStamped: false,
      phantom: false,
      publicMessages: 4,
    });
    // #186：终态下两条认证 expiry receipt 均保留在私有数组（不进公共投影）。
    const receipts = rebuilt?.expiryReceipts ?? [];
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.claimedUntil).sort()).toEqual(
      [first.claimedUntil, renewedUntil].sort(),
    );
    expect(JSON.stringify(view)).not.toContain('expiryReceipts');
  });

  // #188：三窗口链——中间窗回执被接受且不清除后续（最终）权威。
  testOn('claim T1 -> renew T2 -> renew T3 -> 中间窗 expiry(T2)：接受且权威仍=T3', async () => {
    const { until2, until3, claim1, renew1, renew2, first } = await claimThenTwoRenews();
    const midExpiry = (await parseCaptured(expiryDelivery({ claimedUntil: until2 }), 5))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1, renew2, midExpiry]);
    expect({
      rebuilt: rebuilt !== null,
      generation: rebuilt?.lease?.leaseGeneration ?? null,
      claimedUntil: rebuilt?.lease?.claimedUntil ?? null,
      tokenCurrent: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      noExpiredLease: rebuilt?.expiredLease === undefined,
      publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      phantom: rebuilt ? toTaskView(rebuilt).messages.some((m) => m.body === 'Lease expired.') : true,
      privateReceipts: rebuilt?.expiryReceipts?.length ?? 0,
    }).toEqual({
      rebuilt: true,
      generation: 1,
      claimedUntil: until3,
      tokenCurrent: true,
      noExpiredLease: true,
      publicMessages: 4,
      phantom: false,
      privateReceipts: 1,
    });
    expect(rebuilt?.expiryReceipts?.[0]?.claimedUntil).toBe(until2);
  });
});

describe('#156 负控矩阵（fail-closed 不放宽）', () => {
  testOn('未知窗回执仍 null——即使同代已入账一个合法旧窗回执', async () => {
    const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
    const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
    const unknownUntil = new Date(Date.parse(renewedUntil) + 1_000).toISOString();
    const expiryUnknown = (await parseCaptured(expiryDelivery({ claimedUntil: unknownUntil }), 5))!;
    // 单发未知窗：null（原始冲突负控保留）。
    expect(taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryUnknown])).toBeNull();
    // 合法旧窗回执入账后，未知窗仍 fail-closed（配对规则只允许 accepted-chain 精确窗）。
    expect(taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld, expiryUnknown])).toBeNull();
    // 未知代：null。
    const unknownGen = (await parseCaptured(expiryDelivery({
      claimedUntil: first.claimedUntil, generation: 9,
    }), 5))!;
    expect(taskFromMessages(ID, [submittedRaw(), claim1, renew1, unknownGen])).toBeNull();
  });

  testOn('未来 UID 证据不预信：回执先于其 renew 入流仍 null', async () => {
    const { renewedUntil, claim1, renew1 } = await claimThenRenew();
    const earlyExpiry = (await parseCaptured(expiryDelivery({ claimedUntil: renewedUntil }), 3))!;
    const lateRenew = { ...renew1, uid: 4 };
    // UID 序：claim(2) -> expiry(T2)(3) -> renew(T2)(4)。回执到达时 T2 未验证。
    expect(taskFromMessages(ID, [submittedRaw(), claim1, earlyExpiry, lateRenew])).toBeNull();
  });

  testOn('actor 非 server 或坏签名的回执解析即丢弃，权威流不受影响', async () => {
    const { first, claim1, renew1 } = await claimThenRenew();
    const wrongActor = await parseCaptured(expiryDelivery({
      claimedUntil: first.claimedUntil, actor: B,
    }), 4);
    expect(wrongActor).toBeNull();
    const forged = expiryDelivery({ claimedUntil: first.claimedUntil });
    forged.headers = { ...forged.headers, 'X-OA-Task-Stamp': 'forged-stamp' };
    const parsedForged = await parseCaptured(forged, 4);
    expect(parsedForged).toBeNull();
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, renew1]);
    expect(rebuilt).not.toBeNull();
  });
});

describe('#156 M2 精确证据退休与 OPEN 围栏', () => {
  bunTest('M2 on：已索引旧窗回执退休精确 accepted 行；权威不丢；无重放无重持久化', async () => {
    await withM2On(async () => {
      isolateJournal();
      const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
      const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
      const durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld])!;
      expect(durable.lease?.claimedUntil).toBe(renewedUntil);
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      // 已投递（accepted）且现已入盘的旧窗回执行：精确身份退休。
      await upsertJournalRecord({
        taskId: ID, kind: 'expired', generation: 1, actor: 'server',
        at: first.claimedUntil, fate: 'accepted', claimedUntil: first.claimedUntil,
      });
      const board = await listTaskBoard({ status: 'all', period: '30d', limit: 20 }, { kind: 'admin' });
      expect(board.tasks).toHaveLength(1);
      expect(
        journalRecordsFor(ID).find((row) => row.kind === 'expired' && row.claimedUntil === first.claimedUntil)?.fate,
      ).toBe('indexed');
      const detail = await getTask(ID);
      expect(detail?.lease?.leaseGeneration).toBe(1);
      expect(detail?.lease?.claimedUntil).toBe(renewedUntil);
      expect(detail?.expiredLease).toBeUndefined();
      expect(toTaskView(detail!).messages.filter((m) => m.body === 'Lease expired.')).toHaveLength(0);
      const before = journalPersistCountForTests();
      await listTaskBoard({ status: 'all', period: '30d', limit: 20 }, { kind: 'admin' });
      expect(journalPersistCountForTests() - before).toBe(0);
    });
  });

  bunTest('M2 on：未知窗/未知代 accepted 行保持 OPEN，权威不被叠加篡改', async () => {
    await withM2On(async () => {
      isolateJournal();
      const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
      const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
      const durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld])!;
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      const unknownUntil = new Date(Date.parse(renewedUntil) + 1_000).toISOString();
      await upsertJournalRecord({
        taskId: ID, kind: 'expired', generation: 1, actor: 'server',
        at: unknownUntil, fate: 'accepted', claimedUntil: unknownUntil,
      });
      await upsertJournalRecord({
        taskId: ID, kind: 'expired', generation: 7, actor: 'server',
        at: unknownUntil, fate: 'accepted', claimedUntil: unknownUntil,
      });
      const board = await listTaskBoard({ status: 'all', period: '30d', limit: 20 }, { kind: 'admin' });
      expect(board.tasks).toHaveLength(1);
      const open = journalRecordsFor(ID).filter((row) => row.kind === 'expired' && row.claimedUntil === unknownUntil);
      expect(open.map((row) => row.fate)).toEqual(['accepted', 'accepted']);
      const detail = await getTask(ID);
      expect(detail?.lease?.claimedUntil).toBe(renewedUntil);
      expect(detail?.expiredLease).toBeUndefined();
    });
  });

  bunTest('M2 off：同一 durable 流重建一致，无 journal 交互', async () => {
    await withM2Off(async () => {
      // #187：隔离 journal，断言 flag-off 零持久化增量 + 零行；既有返回值断言保留。
      isolateJournal();
      const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
      const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
      const durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld])!;
      setTaskGetForTests(async () => durable);
      const before = journalPersistCountForTests();
      const detail = await getTask(ID);
      expect(detail?.lease?.claimedUntil).toBe(renewedUntil);
      expect(toTaskView(detail!).messages).toHaveLength(3);
      expect(journalPersistCountForTests() - before).toBe(0);
      expect(journalRecordsFor(ID)).toHaveLength(0);
    });
  });

  bunTest('私有回执证据不外泄：投影与列表 JSON 均不含 expiryReceipts', async () => {
    await withM2On(async () => {
      isolateJournal();
      const { first, renewedUntil, claim1, renew1 } = await claimThenRenew();
      const expiryOld = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
      const expiryFinal = (await parseCaptured(expiryDelivery({ claimedUntil: renewedUntil }), 5))!;
      const durable = taskFromMessages(ID, [submittedRaw(), claim1, renew1, expiryOld, expiryFinal])!;
      // 私有证据：两个精确窗回执都入账（内部可用，供 M2 精确退休）。
      const receipts = (durable as Task & { expiryReceipts?: unknown[] }).expiryReceipts;
      expect(Array.isArray(receipts)).toBe(true);
      expect(receipts).toHaveLength(2);
      expect(JSON.stringify(toTaskView(durable))).not.toContain('expiryReceipts');
      setTaskListAllForTests(async () => [durable]);
      const board = await listTaskBoard({ status: 'all', period: '30d', limit: 20 }, { kind: 'admin' });
      expect(JSON.stringify(board.tasks[0])).not.toContain('expiryReceipts');
    });
  });
});
