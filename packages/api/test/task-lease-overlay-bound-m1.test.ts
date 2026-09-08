// M1：公共读 lease overlay 重放有界（T1–T9 + 配置面 + 四象限抽样）。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m1-overlay-bound-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

import type { FetchMessageObject } from 'imapflow';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

const { afterEach, describe, expect, test: bunTest, spyOn } = await import('bun:test');
const { createIdentity } = await import('../src/lib/identities.ts');
const { parseConfig } = await import('../src/lib/config.ts');
const {
  claimTask,
  createApprovalTask,
  decideApprovalTask,
  getTask,
  listTaskBoard,
  releaseTask,
  renewTask,
  taskFromMessages,
  updateTask,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  getTaskSnapshot,
  LEASE_OVERLAY_MAX_LIFETIME_MS,
  LEASE_OVERLAY_REPLAY_EXPIRED_SEEN_CAP,
  queueLeaseOverlayForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  takeLeaseOverlayReplayExpiredCountForTests,
} = await import('./support/task-test-seams.ts');
const {
  parseTaskMessageForTests,
  withTaskLeaseOverlayBoundForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');

const ID = '1a8c0e2f-4b31-4d6a-9c10-7e2f0a1b3c4d';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-09-08T00:00:00.000Z');
const FIFTEEN = LEASE_OVERLAY_MAX_LIFETIME_MS;
const FRESH = FIFTEEN - 60_000;
const STALE = FIFTEEN + 60_000;

function submittedRaw(id = ID): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: `Lease ${id}`,
    date: '2026-09-08T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
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

async function withBoundOn<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeaseOverlayBoundForTests(true, work));
}

async function withBoundOff<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeaseOverlayBoundForTests(false, work));
}

const testOn = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withBoundOn(work));

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

function warnKinds(spy: ReturnType<typeof spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((args) => args[0])
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .filter((row) => row.kind === 'lease_overlay_replay_expired');
}

describe('M1 配置面与默认关', () => {
  testOn('config 默认 false，true 解析生效', () => {
    const base = {
      DOMAIN: 'test.example', API_KEYS: 'admin-key', IMAP_USER: A, IMAP_PASS: 'imap-secret',
      SMTP_USER: A, SMTP_PASS: 'smtp-secret', DATA_DIR: mkdtempSync(join(tmpdir(), 'oae-m1-cfg-')),
    };
    expect(parseConfig(base).taskLeasesOverlayBound).toBe(false);
    expect(parseConfig({ ...base, TASK_LEASES_OVERLAY_BOUND: 'true' }).taskLeasesOverlayBound).toBe(true);
  });

  testOn('六个配置面都带默认 false，且只描述公共读有界', () => {
    const surfaces = [
      { name: 'bundled-compose', text: readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8') },
      { name: 'api-only-compose', text: readFileSync(new URL('../../../compose.api-only.yaml', import.meta.url), 'utf8') },
      { name: 'bundled-example', text: readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8') },
      { name: 'api-only-example', text: readFileSync(new URL('../../../.env.api-only.example', import.meta.url), 'utf8') },
      { name: 'root-readme', text: readFileSync(new URL('../../../README.md', import.meta.url), 'utf8') },
      { name: 'mcp-readme', text: readFileSync(new URL('../../mcp/README.md', import.meta.url), 'utf8') },
    ];
    const observed = surfaces.map(({ name, text }) => {
      const nearby = text.match(/TASK_LEASES_OVERLAY_BOUND[\s\S]{0,280}/)?.[0] ?? '';
      return {
        name,
        mentionsFlag: text.includes('TASK_LEASES_OVERLAY_BOUND'),
        defaultsFalse: /false/.test(nearby) || /default false/i.test(nearby),
        publicRead: /public|list\/detail|list\/详情|公共读/i.test(nearby) || /public list\/detail/i.test(text),
      };
    });
    expect(observed.every((row) => row.mentionsFlag && row.defaultsFalse && row.publicRead)).toBe(true);
  });
});

describe('M1 公共读 overlay 有界', () => {
  testOn('T1 滞后 15min 内公共读仍重放 overlay', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-t1>' }));
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + FRESH;
    const publicTask = await getTask(ID);
    expect(publicTask?.lease?.leaseGeneration).toBe(1);
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(0);
  });

  testOn('T2 滞后超过 15min 公共读停播并 warn 一次', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-t2>' }));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + STALE;
    const first = await getTask(ID);
    const second = await getTask(ID);
    const kinds = warnKinds(warn);
    warn.mockRestore();
    expect(first?.lease).toBeUndefined();
    expect(first?.state).toBe('submitted');
    expect(second?.lease).toBeUndefined();
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toMatchObject({
      kind: 'lease_overlay_replay_expired',
      taskId: ID,
      generation: 1,
    });
    expect(typeof kinds[0]?.age).toBe('number');
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(1);
  });

  testOn('T3 同一停播时刻写路径仍见全量 overlay', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-t3>' }));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + STALE;
    const publicTask = await getTask(ID);
    const authority = await getTaskSnapshot(ID);
    warn.mockRestore();
    setTaskListAllForTests(async () => [submittedTask()]);
    const board = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    await expect(claimTask({ id: ID, from: B, leaseSec: 3600 })).rejects.toThrow('lease_already_claimed');
    expect(publicTask?.lease).toBeUndefined();
    expect(authority?.lease?.leaseGeneration).toBe(1);
    expect(board.tasks.find((row) => row.id === ID)?.leaseGeneration).toBeUndefined();
  });

  testOn('T4 停播后索引赶上则行退休、公共归真', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m1-t4-${sent.length}>` };
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + STALE;
    expect((await getTask(ID))?.lease).toBeUndefined();
    const indexed = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    warn.mockRestore();
    setTaskGetForTests(async () => indexed);
    const publicTask = await getTask(ID);
    expect(publicTask?.lease?.leaseGeneration).toBe(1);
    expect((await getTaskSnapshot(ID))?.lease?.leaseGeneration).toBe(1);
  });

  testOn('T5 sentAt 取自消息日期，时钟前进即按该锚计龄', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<m1-t5>' };
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    const parsed = await parseCaptured(sent[0]!, 2);
    expect(Date.parse(parsed!.date)).toBe(START);
    now = START + STALE;
    expect((await getTask(ID))?.lease).toBeUndefined();
    expect((await getTaskSnapshot(ID))?.lease?.leaseGeneration).toBe(1);
    warn.mockRestore();
  });

  testOn('T6 旧 generation 整组停播，新 generation 仍展示', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-t6>' }));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 6 * 60_000;
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + STALE;
    const publicTask = await getTask(ID);
    const authority = await getTaskSnapshot(ID);
    warn.mockRestore();
    expect(publicTask?.lease?.leaseGeneration).toBe(2);
    expect(authority?.lease?.leaseGeneration).toBe(2);
  });

  testOn('T7 R6 链：旧 claim + 新 renew 整组保留', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-t7>' }));
    const grant = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + FRESH;
    await renewTask({ id: ID, from: B, leaseToken: grant.leaseToken, leaseSec: 3600 });
    now = START + STALE;
    const publicTask = await getTask(ID);
    expect(publicTask?.lease?.leaseGeneration).toBe(1);
    expect(publicTask?.lease?.claimedUntil).toBeDefined();
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(0);
  });

  testOn('P2-1 旧 claim + 新 release：整组保留，公共视图为已释放', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-p2-1>' }));
    const grant = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + FRESH;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken });
    now = START + STALE;
    const publicTask = await getTask(ID);
    const authority = await getTaskSnapshot(ID);
    expect(publicTask?.lease).toBeUndefined();
    expect(publicTask?.releasedLease?.leaseGeneration).toBe(1);
    expect(authority?.lease).toBeUndefined();
    expect(authority?.releasedLease?.leaseGeneration).toBe(1);
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(0);
  });

  testOn('fix4 已索引后继状态不回退，旧关账消息不进公共序列', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m1-fix4-${sent.length}>` };
    });
    const grant = await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + 1_000;
    await updateTask({ id: ID, from: B, state: 'working', body: 'later-progress', leaseToken: grant.leaseToken });
    const durableIndexed = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
    ])!;
    setTaskGetForTests(async () => durableIndexed);
    now = START + 2_000;
    await releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken });
    now = START + STALE;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const publicTask = await getTask(ID);
    const authority = await getTaskSnapshot(ID);
    const durable = await getTaskSnapshot(ID, { mergeOverlay: false });
    warn.mockRestore();
    expect(durable?.state).toBe('working');
    expect(durable?.lease?.leaseGeneration).toBe(1);
    expect(authority?.releasedLease?.leaseGeneration).toBe(1);
    expect(publicTask?.lease).toBeUndefined();
    expect(publicTask?.releasedLease).toBeUndefined();
    expect(publicTask?.state).toBe(durable?.state);
    expect(publicTask?.updatedAt).toBe(durable?.updatedAt);
    expect(publicTask?.messages.map((row) => row.body)).toEqual(durable?.messages.map((row) => row.body));
    expect(publicTask?.messages.some((row) => row.body === 'Lease released.' || row.body === 'Lease expired.')).toBe(false);
    expect(publicTask?.messages.some((row) => row.body.includes('later-progress'))).toBe(true);
  });

  testOn('fix3-2 >1024 个 stale key 时窗口内 warn 有界，计数仍按 key 累计', async () => {
    let now = START + STALE;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async (id) => submittedTask(id));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const n = LEASE_OVERLAY_REPLAY_EXPIRED_SEEN_CAP + 1;
    for (let i = 0; i < n; i += 1) {
      const id = crypto.randomUUID();
      queueLeaseOverlayForTests({ taskId: id, sentAt: START, generation: 1 });
      await getTask(id);
    }
    const kinds = warnKinds(warn);
    warn.mockRestore();
    expect(kinds.length).toBe(1);
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(n);
  });

  bunTest('T8 开关 off：超龄后公共读仍重放（现行为负控）', async () => {
    await withBoundOff(async () => {
      let now = START;
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async () => ({ messageId: '<m1-t8>' }));
      await claimTask({ id: ID, from: B, leaseSec: 3600 });
      now = START + STALE;
      const publicTask = await getTask(ID);
      expect(publicTask?.lease?.leaseGeneration).toBe(1);
      expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(0);
    });
  });

  testOn('T9 approval-terminal overlay 超龄仍重放', async () => {
    const stamp = Date.now().toString(36);
    const requester = createIdentity({ localpart: `m1-req-${stamp}` })!.identity;
    const reviewer = createIdentity({ localpart: `m1-rev-${stamp}` })!.identity;
    let now = START;
    setTaskNowForTests(() => now);
    setTaskSendMailForTests(async () => ({ messageId: `<m1-t9-${now}>` }));
    const approval = await createApprovalTask({
      from: requester.address,
      to: reviewer.address,
      subject: 'M1 approval terminal',
      action: { type: 'tool', name: 'noop', arguments: {} },
      expiresAt: new Date(START + 24 * 60 * 60 * 1000).toISOString(),
    });
    setTaskGetForTests(async () => approval);
    await decideApprovalTask({ id: approval.id, from: reviewer.address, decision: 'approved' });
    now = START + STALE;
    const publicTask = await getTask(approval.id);
    expect(publicTask?.state).toBe('completed');
    expect(takeLeaseOverlayReplayExpiredCountForTests()).toBe(0);
  });
});

describe('M1 四象限抽样', () => {
  bunTest('BOUND off + LEASES on：超龄公共读仍见 overlay', async () => {
    await withBoundOff(async () => {
      let now = START;
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async () => ({ messageId: '<m1-q-off-on>' }));
      await claimTask({ id: ID, from: B, leaseSec: 3600 });
      now = START + STALE;
      expect((await getTask(ID))?.lease?.leaseGeneration).toBe(1);
    });
  });

  testOn('BOUND on + LEASES on：超龄公共读停播', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-q-on-on>' }));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await claimTask({ id: ID, from: B, leaseSec: 3600 });
    now = START + STALE;
    expect((await getTask(ID))?.lease).toBeUndefined();
    warn.mockRestore();
  });

  bunTest('BOUND on + LEASES off：有界仍作用于公共读', async () => {
    let now = START;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<m1-q-on-off>' }));
    await withTaskLeasesEnabledForTests(true, async () => {
      await claimTask({ id: ID, from: B, leaseSec: 3600 });
    });
    now = START + STALE;
    await withTaskLeasesEnabledForTests(false, () => withTaskLeaseOverlayBoundForTests(true, async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
      expect((await getTask(ID))?.lease).toBeUndefined();
      expect((await getTaskSnapshot(ID))?.lease?.leaseGeneration).toBe(1);
      warn.mockRestore();
    }));
  });
});
