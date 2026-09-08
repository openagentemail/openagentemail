// M3 收窄：claim 到期派生失活 + 迟到回执容忍 + 终态冻结。发射器已并入 M2。
import { mkdtempSync, readFileSync } from 'node:fs';
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m3-expiry-audit-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest, spyOn } = await import('bun:test');
const { parseConfig } = await import('../src/lib/config.ts');
const {
  claimTask,
  getTask,
  isTaskLeaseTokenCurrent,
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
const {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');

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

function expiryEvent(input: { claimedUntil: string; generation?: number; at?: string; actor?: string }) {
  const at = input.at ?? input.claimedUntil;
  return {
    version: 1 as const,
    event: 'expired' as const,
    actor: (input.actor ?? 'server') as 'server',
    at,
    generation: input.generation ?? 1,
    claimedUntil: input.claimedUntil,
    expiredAt: at,
  };
}

function expiryDelivery(input: {
  claimedUntil: string;
  generation?: number;
  actor?: string;
  at?: string;
  id?: string;
}): SendInput {
  const event = expiryEvent(input);
  const id = input.id ?? ID;
  return {
    from: A,
    to: [B],
    subject: `Lease ${id}`,
    text: 'Lease expired.',
    headers: claimLeaseHeadersForTests({
      id,
      state: 'working',
      from: A,
      to: B,
      event: event as Parameters<typeof claimLeaseHeadersForTests>[0]['event'],
    }),
  };
}

async function withM3On<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeaseExpiryAuditM3ForTests(true, work));
}

async function withM3Off<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () => withTaskLeaseExpiryAuditM3ForTests(false, work));
}

const testOn = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withM3On(work));

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('M3 配置面与默认关', () => {
  testOn('config 默认 false，true 解析生效', () => {
    const base = {
      DOMAIN: 'test.example', API_KEYS: 'admin-key', IMAP_USER: A, IMAP_PASS: 'imap-secret',
      SMTP_USER: A, SMTP_PASS: 'smtp-secret', DATA_DIR: mkdtempSync(join(tmpdir(), 'oae-m3-cfg-')),
    };
    expect(parseConfig(base).taskLeasesExpiryAuditM3).toBe(false);
    expect(parseConfig({ ...base, TASK_LEASES_EXPIRY_AUDIT_M3: 'true' }).taskLeasesExpiryAuditM3).toBe(true);
  });

  testOn('六个配置面都带默认 false，且只描述解耦+容忍', () => {
    const surfaces = [
      { name: 'bundled-compose', text: readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8') },
      { name: 'api-only-compose', text: readFileSync(new URL('../../../compose.api-only.yaml', import.meta.url), 'utf8') },
      { name: 'bundled-example', text: readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8') },
      { name: 'api-only-example', text: readFileSync(new URL('../../../.env.api-only.example', import.meta.url), 'utf8') },
      { name: 'root-readme', text: readFileSync(new URL('../../../README.md', import.meta.url), 'utf8') },
      { name: 'mcp-readme', text: readFileSync(new URL('../../mcp/README.md', import.meta.url), 'utf8') },
    ];
    const observed = surfaces.map(({ name, text }) => {
      const nearby = text.match(/TASK_LEASES_EXPIRY_AUDIT_M3[\s\S]{0,280}/)?.[0] ?? '';
      return {
        name,
        mentionsFlag: text.includes('TASK_LEASES_EXPIRY_AUDIT_M3'),
        defaultsFalse: /false/.test(nearby) || /default false/i.test(nearby),
        noBackfill: !/backfill/i.test(nearby),
      };
    });
    expect(observed.every((row) => row.mentionsFlag && row.defaultsFalse && row.noBackfill)).toBe(true);
  });
});

describe('M3-1 reclaim 解耦', () => {
  testOn('T-A：审计通道完全不可用时 reclaim 即时成功且锁内零审计 SMTP', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let expiryCalls = 0;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        expiryCalls += 1;
        await new Promise(() => undefined);
      }
      sent.push(input);
      return { messageId: `<m3-ta-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const warnKinds = warn.mock.calls
      .map((args) => args[0])
      .filter((row): row is { kind?: string } => !!row && typeof row === 'object')
      .filter((row) => row.kind === 'expiry_audit_delivery_failed');
    warn.mockRestore();
    expect({
      generation: second.leaseGeneration,
      expiryCalls,
      expiryDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length,
      claimDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'claim').length,
      reaper: await reapExpiredTaskLeasesOnce(),
      warns: warnKinds.length,
    }).toEqual({
      generation: 2,
      expiryCalls: 0,
      expiryDeliveries: 0,
      claimDeliveries: 2,
      reaper: 0,
      warns: 0,
    });
  });

  bunTest('T-A 负控：M3 off 时同场景仍抛错', async () => {
    await withM3Off(async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      let failExpiry = false;
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
          throw new Error('permanent smtp reject');
        }
        sent.push(input);
        return { messageId: `<m3-ta-off-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      failExpiry = true;
      await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toThrow('permanent smtp reject');
      expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'claim')).toHaveLength(1);
    });
  });
});

describe('M3-3 迟到回执无害化', () => {
  testOn('T-C：迟到回执落在后继 claim 之后 → 重建成功且权威=后继 claim', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      if (input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('drop audit');
      }
      sent.push(input);
      return { messageId: `<m3-tc-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent[1]!, 3))!;
    const lateExpiry = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, claim2, lateExpiry]);
    expect({
      rebuilt: rebuilt !== null,
      authority: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
      publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      noExpiredLease: rebuilt?.expiredLease === undefined,
    }).toEqual({
      rebuilt: true,
      authority: 2,
      gen2Current: true,
      publicMessages: 3,
      noExpiredLease: true,
    });
  });

  bunTest('R1-d：off 态注入已有迟到回执仍重建成功（容忍无条件）', async () => {
    await withM3Off(async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<m3-r1d-off-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      const claim1 = (await parseCaptured(sent[0]!, 2))!;
      const claim2Headers = claimLeaseHeadersForTests({
        id: ID,
        state: 'working',
        from: B,
        to: A,
        event: {
          version: 1,
          event: 'claim',
          actor: B,
          at: new Date(now).toISOString(),
          generation: 2,
          claimedUntil: new Date(now + 300_000).toISOString(),
          tokenVerifier: 'a'.repeat(43),
        },
      });
      const claim2 = (await parseCaptured({
        from: B, to: [A], subject: 'Lease this task', text: 'Lease claimed.', headers: claim2Headers,
      }, 3))!;
      const lateExpiry = (await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil }), 4))!;
      const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1, claim2, lateExpiry]);
      expect({
        rebuilt: rebuilt !== null,
        authority: rebuilt?.lease?.leaseGeneration,
        publicMessages: rebuilt ? toTaskView(rebuilt).messages.length : 0,
      }).toEqual({ rebuilt: true, authority: 2, publicMessages: 3 });
    });
  });

  bunTest('R1-d 负控：off 态无匹配窗流（同 gen 错 claimedUntil）仍 null', async () => {
    await withM3Off(async () => {
      const sent: SendInput[] = [];
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<m3-r1d-neg-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const claim1 = (await parseCaptured(sent[0]!, 2))!;
      const forgedUntil = new Date(Date.parse(first.claimedUntil) + 1_000).toISOString();
      const mismatched = (await parseCaptured(expiryDelivery({ claimedUntil: forgedUntil }), 3))!;
      expect(taskFromMessages(ID, [submittedRaw(), claim1, mismatched])).toBeNull();
    });
  });

  testOn('T-F：不匹配任何已入账窗的回执仍 null', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m3-tf-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const forgedUntil = new Date(Date.parse(first.claimedUntil) + 1_000).toISOString();
    const mismatched = (await parseCaptured(expiryDelivery({ claimedUntil: forgedUntil }), 3))!;
    const unknownGen = (await parseCaptured(expiryDelivery({
      claimedUntil: first.claimedUntil, generation: 9,
    }), 4))!;
    expect(taskFromMessages(ID, [submittedRaw(), claim1, mismatched])).toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), claim1, unknownGen])).toBeNull();
  });
});

describe('M3 终态冻结', () => {
  async function signedClaim(generation: number, atMs: number): Promise<RawTaskMessage> {
    const at = new Date(atMs).toISOString();
    const headers = claimLeaseHeadersForTests({
      id: ID, state: 'working', from: B, to: A,
      event: {
        version: 1, event: 'claim', actor: B, at, generation,
        claimedUntil: new Date(atMs + 300_000).toISOString(),
        tokenVerifier: 'a'.repeat(43),
      },
    });
    return (await parseCaptured({
      from: B, to: [A], subject: `Lease ${ID}`, text: 'Lease claimed.', headers,
    }, generation + 1))!;
  }

  function terminalRaw(input: {
    state: 'completed' | 'failed';
    uid: number;
    body: string;
    result?: unknown;
  }): RawTaskMessage {
    return {
      uid: input.uid, from: A, to: B, subject: `Lease ${ID}`,
      date: '2026-08-24T00:06:00.000Z', state: input.state, body: input.body,
      ...(input.result !== undefined ? { result: input.result } : {}),
    };
  }

  testOn('R2-A：failed / admin-closed 最终窗回执不进公开历史', async () => {
    const claim = await signedClaim(1, START);
    const claimedUntil = claim.lease && 'claimedUntil' in claim.lease ? claim.lease.claimedUntil : '';
    const expiry = (await parseCaptured(expiryDelivery({ claimedUntil }), 4))!;
    const failed = terminalRaw({ state: 'failed', uid: 3, body: 'boom' });
    const adminClosed = terminalRaw({
      state: 'failed', uid: 3, body: 'duplicate',
      result: { closed_by_admin: true, reason: 'duplicate' },
    });
    const failedView = toTaskView(taskFromMessages(ID, [submittedRaw(), claim, failed, expiry])!);
    const closedView = toTaskView(taskFromMessages(ID, [submittedRaw(), claim, adminClosed, expiry])!);
    expect({
      failedState: failedView.state,
      failedPhantom: failedView.messages.some((message) => message.body === 'Lease expired.'),
      closedPhantom: closedView.messages.some((message) => message.body === 'Lease expired.'),
      closedAdmin: !!(adminClosed.result as { closed_by_admin?: boolean }).closed_by_admin,
    }).toEqual({
      failedState: 'failed',
      failedPhantom: false,
      closedPhantom: false,
      closedAdmin: true,
    });
  });

  testOn('R2-A 负控：活窗过期回执在终态前仍进公开 messages', async () => {
    const claim = await signedClaim(1, START);
    const claimedUntil = claim.lease && 'claimedUntil' in claim.lease ? claim.lease.claimedUntil : '';
    const expiry = (await parseCaptured(expiryDelivery({ claimedUntil }), 3))!;
    const completed = terminalRaw({ state: 'completed', uid: 4, body: 'done' });
    const live = toTaskView(taskFromMessages(ID, [submittedRaw(), claim, expiry])!);
    const afterComplete = toTaskView(taskFromMessages(ID, [submittedRaw(), claim, expiry, completed])!);
    expect({
      liveExpiry: live.messages.filter((message) => message.body === 'Lease expired.').length,
      keptAfterComplete: afterComplete.messages.filter((message) => message.body === 'Lease expired.').length,
      state: afterComplete.state,
    }).toEqual({ liveExpiry: 1, keptAfterComplete: 1, state: 'completed' });
  });

  testOn('R2-A：终态在 replayed claim 之前仍冻结最终窗回执', async () => {
    const claim = await signedClaim(1, START);
    const claimedUntil = claim.lease && 'claimedUntil' in claim.lease ? claim.lease.claimedUntil : '';
    const completed = terminalRaw({ state: 'completed', uid: 2, body: 'done' });
    const replayedClaim = { ...claim, uid: 3 };
    const expiry = (await parseCaptured(expiryDelivery({ claimedUntil }), 4))!;
    const rebuilt = taskFromMessages(ID, [submittedRaw(), completed, replayedClaim, expiry]);
    const view = rebuilt ? toTaskView(rebuilt) : null;
    expect({
      rebuilt: rebuilt !== null,
      state: view?.state,
      phantom: view?.messages.some((message) => message.body === 'Lease expired.') ?? true,
    }).toEqual({ rebuilt: true, state: 'completed', phantom: false });
  });
});

describe('队列行退休（后继代 / 终态）', () => {
  bunTest('M3-off 过期 reclaim 双索引后过期队列行退休，读路径不重放', async () => {
    await withM3Off(async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<m3-b2-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const claim1 = (await parseCaptured(sent[0]!, 2))!;
      durable = taskFromMessages(ID, [submittedRaw(), claim1])!;
      // 不 clear 队列：reclaim 会排队 gen1 回执 + gen2 claim，随后双双入盘。
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const expiryInput = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
      const claim2Input = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'claim')[1];
      const expiry = expiryInput ? (await parseCaptured(expiryInput, 3))! : null;
      const claim2 = claim2Input ? (await parseCaptured(claim2Input, 4))! : null;
      const indexed = claim1 && expiry && claim2
        ? taskFromMessages(ID, [submittedRaw(), claim1, expiry, claim2])
        : null;
      if (!indexed) throw new Error('B2 fixture must index gen1 expiry and gen2 claim');
      durable = indexed;
      setTaskGetForTests(async () => durable);
      const firstRead = await getTask(ID);
      const firstView = firstRead ? toTaskView(firstRead) : null;
      const secondRead = await getTask(ID);
      const secondView = secondRead ? toTaskView(secondRead) : null;
      expect({
        generation: second.leaseGeneration,
        leaseGen: firstRead?.lease?.leaseGeneration ?? null,
        expiredStamped: firstRead?.expiredLease !== undefined,
        state: firstRead?.state ?? null,
        expiryBodies: firstView?.messages.filter((message) => message.body === 'Lease expired.').length ?? -1,
        messages: firstRead?.messages.length ?? null,
        durableMessages: indexed.messages.length,
        secondExpiryBodies: secondView?.messages.filter((message) => message.body === 'Lease expired.').length ?? -1,
        secondMessages: secondRead?.messages.length ?? null,
        secondLeaseGen: secondRead?.lease?.leaseGeneration ?? null,
      }).toEqual({
        generation: 2,
        leaseGen: 2,
        expiredStamped: false,
        state: 'working',
        expiryBodies: 1,
        messages: indexed.messages.length,
        durableMessages: indexed.messages.length,
        secondExpiryBodies: 1,
        secondMessages: indexed.messages.length,
        secondLeaseGen: 2,
      });
    });
  });

  bunTest('B3：M3-off reaper 排队后先 completed 再索引回执，读路径不重放', async () => {
    await withM3Off(async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<m3-b3-${sent.length}>` };
      });
      const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const claim1 = (await parseCaptured(sent[0]!, 2))!;
      durable = taskFromMessages(ID, [submittedRaw(), claim1])!;
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      now = Date.parse(first.claimedUntil);
      expect(await reapExpiredTaskLeasesOnce()).toBe(1);
      const expiryInput = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
      const expiry = expiryInput ? (await parseCaptured(expiryInput, 4))! : null;
      if (!expiry) throw new Error('B3 fixture must queue a reaper expiry receipt');
      // 任务先 completed（durable 尚无回执），同代无后继可 dominates。
      const completed: RawTaskMessage = {
        uid: 3, from: A, to: B, subject: `Lease ${ID}`,
        date: '2026-08-24T00:06:00.000Z', state: 'completed', body: 'done',
      };
      const completedOnly = taskFromMessages(ID, [submittedRaw(), claim1, completed]);
      if (!completedOnly) throw new Error('B3 fixture must rebuild completed before expiry index');
      durable = completedOnly;
      setTaskGetForTests(async () => durable);
      const beforeIndex = await getTask(ID);
      // 回执后索引：终态流再附上 expiry，队列行必须已退休。
      const indexed = taskFromMessages(ID, [submittedRaw(), claim1, completed, expiry]);
      if (!indexed) throw new Error('B3 fixture must index expiry after completed');
      durable = indexed;
      setTaskGetForTests(async () => durable);
      const afterIndex = await getTask(ID);
      const afterView = afterIndex ? toTaskView(afterIndex) : null;
      const secondRead = await getTask(ID);
      const secondView = secondRead ? toTaskView(secondRead) : null;
      expect({
        beforeState: beforeIndex?.state ?? null,
        beforeExpiryBodies: beforeIndex
          ? toTaskView(beforeIndex).messages.filter((message) => message.body === 'Lease expired.').length
          : -1,
        afterState: afterIndex?.state ?? null,
        afterExpiryBodies: afterView?.messages.filter((message) => message.body === 'Lease expired.').length ?? -1,
        afterMessages: afterIndex?.messages.length ?? null,
        durableMessages: indexed.messages.length,
        expiredStamped: afterIndex?.expiredLease !== undefined,
        secondExpiryBodies: secondView?.messages.filter((message) => message.body === 'Lease expired.').length ?? -1,
        secondMessages: secondRead?.messages.length ?? null,
      }).toEqual({
        beforeState: 'completed',
        beforeExpiryBodies: 0,
        afterState: 'completed',
        afterExpiryBodies: 0,
        afterMessages: indexed.messages.length,
        durableMessages: indexed.messages.length,
        expiredStamped: false,
        secondExpiryBodies: 0,
        secondMessages: indexed.messages.length,
      });
    });
  });
});
