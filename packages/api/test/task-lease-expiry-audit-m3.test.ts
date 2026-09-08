// M3：expired 回执派生化 + reaper durable 补账 + 迟到回执无害化。
import { mkdtempSync, readFileSync } from 'node:fs';
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m3-expiry-audit-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest, spyOn } = await import('bun:test');
const { parseConfig } = await import('../src/lib/config.ts');
const {
  EXPIRY_AUDIT_BACKFILL_BATCH_LIMIT,
  EXPIRY_AUDIT_IN_FLIGHT_TTL_MS,
  EXPIRY_AUDIT_WARNED_WINDOWS_LIMIT,
  claimTask,
  getTask,
  isTaskLeaseTokenCurrent,
  reapExpiredTaskLeasesOnce,
  taskFromMessages,
  toTaskView,
  updateTask,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  expiryAuditDeliveryFailureCountForTests,
  resetExpiryAuditDeliveryFailureCountForTests,
  warnedExpiryAuditWindowCountForTests,
  warnExpiryAuditDeliveryFailedForTests,
  expiryAuditInFlightCountForTests,
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
const ID_B = '1a2b3c4d-056e-47c1-a65c-b29d39f66b84';
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
  resetExpiryAuditDeliveryFailureCountForTests();
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

  testOn('六个配置面都带默认 false 与 singleton 注释', () => {
    const surfaces = [
      { name: 'bundled-compose', text: readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8') },
      { name: 'api-only-compose', text: readFileSync(new URL('../../../compose.api-only.yaml', import.meta.url), 'utf8') },
      { name: 'bundled-example', text: readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8') },
      { name: 'api-only-example', text: readFileSync(new URL('../../../.env.api-only.example', import.meta.url), 'utf8') },
      { name: 'root-readme', text: readFileSync(new URL('../../../README.md', import.meta.url), 'utf8') },
      { name: 'mcp-readme', text: readFileSync(new URL('../../mcp/README.md', import.meta.url), 'utf8') },
    ];
    const observed = surfaces.map(({ name, text }) => ({
      name,
      mentionsFlag: text.includes('TASK_LEASES_EXPIRY_AUDIT_M3'),
      defaultsFalse: /TASK_LEASES_EXPIRY_AUDIT_M3/.test(text)
        && (/false/.test(text.match(/TASK_LEASES_EXPIRY_AUDIT_M3[\s\S]{0,120}/)?.[0] ?? '')
          || /default false/i.test(text)),
    }));
    expect(observed.every((row) => row.mentionsFlag && row.defaultsFalse)).toBe(true);
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
        // 假 transport hang：若 claim 仍 await 审计，本用例不会结束。
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
      failures: expiryAuditDeliveryFailureCountForTests(),
      warns: warnKinds.length,
    }).toEqual({
      generation: 2,
      expiryCalls: 0,
      expiryDeliveries: 0,
      claimDeliveries: 2,
      failures: 0,
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
      expect(expiryAuditDeliveryFailureCountForTests()).toBe(0);
    });
  });
});

describe('M3-2 reaper durable 补账', () => {
  testOn('T-B/T13：SMTP 恢复后 reaper 补上缺失回执，权威不被迟到回执推翻', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('permanent smtp reject');
      }
      sent.push(input);
      return { messageId: `<m3-tb-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent.find((mail) =>
      mail.headers?.['X-OA-Task-Lease-Event'] === 'claim' && mail !== sent[0])!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const expiryMsg = expiry ? await parseCaptured(expiry, 4) : null;
    const rebuilt = expiryMsg
      ? taskFromMessages(ID, [submittedRaw(), claim1, claim2, expiryMsg])
      : null;
    expect({
      secondGen: second.leaseGeneration,
      expiryGen: expiryMsg?.lease && 'generation' in expiryMsg.lease ? expiryMsg.lease.generation : null,
      expiryUntil: expiryMsg?.lease && 'claimedUntil' in expiryMsg.lease ? expiryMsg.lease.claimedUntil : null,
      rebuilt: rebuilt !== null,
      authority: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
      gen1Fenced: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
    }).toEqual({
      secondGen: 2,
      expiryGen: 1,
      expiryUntil: first.claimedUntil,
      rebuilt: true,
      authority: 2,
      gen2Current: true,
      gen1Fenced: false,
    });
  });

  testOn('T-D：同窗两轮补账只发一条；历史窗也被补', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('drop claim-path audit');
      }
      sent.push(input);
      return { messageId: `<m3-td-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const beforeReap = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length;
    const firstPass = await reapExpiredTaskLeasesOnce();
    const secondPass = await reapExpiredTaskLeasesOnce();
    const expiries = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect({
      beforeReap,
      firstPass: firstPass > 0,
      secondPass,
      expiryCount: expiries.length,
    }).toEqual({ beforeReap: 0, firstPass: true, secondPass: 0, expiryCount: 1 });
  });

  testOn('T-E：A 补发失败不挡 B 补发与 A 后续 pass', async () => {
    let now = START;
    const sent: SendInput[] = [];
    const failIds = new Set<string>([ID]);
    const durables = new Map<string, Task>([
      [ID, submittedTask(ID)],
      [ID_B, submittedTask(ID_B)],
    ]);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    setTaskSendMailForTests(async (input) => {
      const taskId = input.headers?.['X-OA-Task'];
      if (failIds.has(taskId ?? '') && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error(`smtp fail ${taskId}`);
      }
      sent.push(input);
      return { messageId: `<m3-te-${sent.length}>` };
    });
    const firstA = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const firstB = await claimTask({ id: ID_B, from: B, leaseSec: 300 });
    const claimA = (await parseCaptured(sent.find((mail) => mail.headers?.['X-OA-Task'] === ID)!, 2, ID))!;
    const claimB = (await parseCaptured(sent.find((mail) => mail.headers?.['X-OA-Task'] === ID_B)!, 2, ID_B))!;
    durables.set(ID, taskFromMessages(ID, [submittedRaw(ID), claimA])!);
    durables.set(ID_B, taskFromMessages(ID_B, [submittedRaw(ID_B), claimB])!);
    clearQueuedEventsForTests();
    now = Math.max(Date.parse(firstA.claimedUntil), Date.parse(firstB.claimedUntil));
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    await reapExpiredTaskLeasesOnce();
    const afterFirst = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    failIds.delete(ID);
    await reapExpiredTaskLeasesOnce();
    const afterSecond = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect({
      firstRoundBOnly: afterFirst.length === 1 && afterFirst[0]?.headers?.['X-OA-Task'] === ID_B,
      secondRoundFilledA: afterSecond.some((mail) => mail.headers?.['X-OA-Task'] === ID)
        && afterSecond.some((mail) => mail.headers?.['X-OA-Task'] === ID_B),
      expiryCount: afterSecond.length,
    }).toEqual({
      firstRoundBOnly: true,
      secondRoundFilledA: true,
      expiryCount: 2,
    });
  });

  testOn('T-G：重启后无内存队列，reaper 仍能从 durable 补账', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = true;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp down');
      }
      sent.push(input);
      return { messageId: `<m3-tg-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    now = Date.parse(first.claimedUntil);
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent[1]!, 3))!;
    // 模拟重启：清空 overlay，只留 durable 流。
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    expect(sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired')).toHaveLength(1);
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

  bunTest('R1-d：off 态注入已补账迟到回执仍重建成功（容忍无条件）', async () => {
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

  bunTest('R1-d 负控：off 态无补账形态流（同 gen 错 claimedUntil）仍 null', async () => {
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

describe('M3 全链 e2e', () => {
  testOn('T-H：claim→audit 拒→reclaim→reaper 补账→nodemailer 折行源重建全绿', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('nodemailer downstream reject');
      }
      sent.push(input);
      return { messageId: `<m3-th-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const expiryInput = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect(expiryInput).toBeTruthy();
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const serialize = async (input: SendInput) => {
      const result = await transport.sendMail({
        from: input.from, to: input.to, subject: input.subject, text: input.text, headers: input.headers,
      });
      if (!Buffer.isBuffer(result.message)) throw new Error('stream transport must return buffered RFC 5322 source');
      return result.message;
    };
    const asFetch = (buf: Buffer, input: SendInput, uid: number) => ({
      uid,
      source: buf,
      envelope: { from: [{ address: input.from }], to: [{ address: input.to[0] }], subject: input.subject },
      internalDate: new Date(START),
    } as unknown as FetchMessageObject);
    const wireClaim1 = await parseTaskMessageForTests(asFetch(await serialize(sent[0]!), sent[0]!, 2), ID);
    const wireClaim2 = await parseTaskMessageForTests(asFetch(await serialize(sent[1]!), sent[1]!, 3), ID);
    const wireExpiry = expiryInput
      ? await parseTaskMessageForTests(asFetch(await serialize(expiryInput), expiryInput, 4), ID)
      : null;
    const rebuilt = wireClaim1 && wireClaim2 && wireExpiry
      ? taskFromMessages(ID, [submittedRaw(), wireClaim1, wireClaim2, wireExpiry])
      : null;
    expect({
      secondGen: second.leaseGeneration,
      rebuilt: rebuilt !== null,
      authority: rebuilt?.lease?.leaseGeneration,
      gen2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
    }).toEqual({
      secondGen: 2,
      rebuilt: true,
      authority: 2,
      gen2Current: true,
    });
  });
});

describe('M3 R1 返工', () => {
  async function signedClaim(generation: number, atMs: number, id = ID): Promise<RawTaskMessage> {
    const at = new Date(atMs).toISOString();
    const headers = claimLeaseHeadersForTests({
      id, state: 'working', from: B, to: A,
      event: {
        version: 1, event: 'claim', actor: B, at, generation,
        claimedUntil: new Date(atMs + 300_000).toISOString(),
        tokenVerifier: 'a'.repeat(43),
      },
    });
    return (await parseCaptured({
      from: B, to: [A], subject: `Lease ${id}`, text: 'Lease claimed.', headers,
    }, generation + 1, id))!;
  }

  testOn('R1-a：terminal 任务仍补历史窗，视图保持 completed', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp down');
      }
      sent.push(input);
      return { messageId: `<m3-r1a-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    await updateTask({ id: ID, from: A, state: 'completed', body: 'done' });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent.find((mail) =>
      mail.headers?.['X-OA-Task-Lease-Event'] === 'claim' && mail !== sent[0])!, 3))!;
    const completed = (await parseCaptured(sent.find((mail) =>
      mail.headers?.['X-OA-Task-State'] === 'completed')!, 4))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2, completed])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const before = toTaskView(durable);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const after = toTaskView((await getTask(ID))!);
    const expiries = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    expect({
      secondGen: second.leaseGeneration,
      state: after.state,
      expiryCount: expiries.length,
      messages: after.messages.map((message) => message.body),
      updatedAt: after.updatedAt,
    }).toEqual({
      secondGen: 2,
      state: 'completed',
      expiryCount: 1,
      messages: before.messages.map((message) => message.body),
      updatedAt: before.updatedAt,
    });
  });

  testOn('R1-b：补账回执不进公共 overlay，索引前后视图稳定', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = true;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('drop audit');
      }
      sent.push(input);
      return { messageId: `<m3-r1b-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    now = Date.parse(first.claimedUntil);
    await claimTask({ id: ID, from: B, leaseSec: 300 });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const claim2 = (await parseCaptured(sent[1]!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, claim2])!;
    clearQueuedEventsForTests();
    failExpiry = false;
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const before = toTaskView(durable);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const overlayView = toTaskView((await getTask(ID))!);
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const expiryMsg = expiry ? await parseCaptured(expiry, 4) : null;
    const indexed = expiryMsg
      ? taskFromMessages(ID, [submittedRaw(), claim1, claim2, expiryMsg])
      : null;
    const indexedView = indexed ? toTaskView(indexed) : null;
    expect({
      overlayBodies: overlayView.messages.map((message) => message.body),
      overlayUpdatedAt: overlayView.updatedAt,
      phantomExpiry: overlayView.messages.some((message) => message.body === 'Lease expired.'),
      indexedBodies: indexedView?.messages.map((message) => message.body),
      indexedUpdatedAt: indexedView?.updatedAt,
    }).toEqual({
      overlayBodies: before.messages.map((message) => message.body),
      overlayUpdatedAt: before.updatedAt,
      phantomExpiry: false,
      indexedBodies: before.messages.map((message) => message.body),
      indexedUpdatedAt: before.updatedAt,
    });
  });

  testOn('R1-c：单 pass 只补一批，余量下轮；B 不被 A 长尾挡住', async () => {
    const claimCount = EXPIRY_AUDIT_BACKFILL_BATCH_LIMIT + 2;
    const claims: RawTaskMessage[] = [];
    for (let generation = 1; generation <= claimCount; generation += 1) {
      claims.push(await signedClaim(generation, START + (generation - 1) * 300_000));
    }
    const taskA = taskFromMessages(ID, [submittedRaw(), ...claims])!;
    const claimB = await signedClaim(1, START, ID_B);
    const taskB = taskFromMessages(ID_B, [submittedRaw(ID_B), claimB])!;
    const sent: SendInput[] = [];
    // claim A 的最后一代仍在活窗内，只补历史窗；B 的唯一窗已过期。
    const now = START + (claimCount - 1) * 300_000;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async (id) => (id === ID_B ? taskB : taskA));
    setTaskListAllForTests(async () => [taskA, taskB]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m3-r1c-${sent.length}>` };
    });
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const firstPass = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const firstA = firstPass.filter((mail) => mail.headers?.['X-OA-Task'] === ID);
    const firstB = firstPass.filter((mail) => mail.headers?.['X-OA-Task'] === ID_B);
    expect({ a: firstA.length, b: firstB.length }).toEqual({
      a: EXPIRY_AUDIT_BACKFILL_BATCH_LIMIT,
      b: 1,
    });
    expect(sent.findIndex((mail) => mail.headers?.['X-OA-Task'] === ID_B))
      .toBeGreaterThan(sent.findIndex((mail) => mail.headers?.['X-OA-Task'] === ID));
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const allA = sent.filter((mail) =>
      mail.headers?.['X-OA-Task-Lease-Event'] === 'expired' && mail.headers?.['X-OA-Task'] === ID);
    expect(allA.length).toBe(claimCount - 1);
  });

  testOn('R1-e：同窗连续失败只 warn 一次，计数仍累加', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp down');
      }
      sent.push(input);
      return { messageId: `<m3-r1e-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    now = Date.parse(first.claimedUntil);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    await reapExpiredTaskLeasesOnce();
    await reapExpiredTaskLeasesOnce();
    await reapExpiredTaskLeasesOnce();
    const kinds = warn.mock.calls
      .map((args) => args[0])
      .filter((row): row is { kind?: string } => !!row && typeof row === 'object')
      .filter((row) => row.kind === 'expiry_audit_delivery_failed');
    warn.mockRestore();
    expect({ warns: kinds.length, failures: expiryAuditDeliveryFailureCountForTests() })
      .toEqual({ warns: 1, failures: 3 });
  });
});

describe('M3 R2 返工', () => {
  async function signedClaim(generation: number, atMs: number, id = ID): Promise<RawTaskMessage> {
    const at = new Date(atMs).toISOString();
    const headers = claimLeaseHeadersForTests({
      id, state: 'working', from: B, to: A,
      event: {
        version: 1, event: 'claim', actor: B, at, generation,
        claimedUntil: new Date(atMs + 300_000).toISOString(),
        tokenVerifier: 'a'.repeat(43),
      },
    });
    return (await parseCaptured({
      from: B, to: [A], subject: `Lease ${id}`, text: 'Lease claimed.', headers,
    }, generation + 1, id))!;
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

  testOn('R2-A：终态最终窗补账索引后 detail messages 冻结', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m3-r2a-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    await updateTask({ id: ID, from: A, state: 'completed', body: 'done' });
    const claim1 = (await parseCaptured(sent[0]!, 2))!;
    const completed = (await parseCaptured(sent.find((mail) =>
      mail.headers?.['X-OA-Task-State'] === 'completed')!, 3))!;
    durable = taskFromMessages(ID, [submittedRaw(), claim1, completed])!;
    clearQueuedEventsForTests();
    now = Date.parse(first.claimedUntil);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const before = toTaskView(durable);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const overlayView = toTaskView((await getTask(ID))!);
    const expiry = sent.find((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const expiryMsg = expiry ? await parseCaptured(expiry, 4) : null;
    const indexed = expiryMsg
      ? taskFromMessages(ID, [submittedRaw(), claim1, completed, expiryMsg])
      : null;
    const indexedView = indexed ? toTaskView(indexed) : null;
    expect({
      state: indexed?.state,
      overlayBodies: overlayView.messages.map((message) => message.body),
      indexedBodies: indexedView?.messages.map((message) => message.body),
      phantom: indexedView?.messages.some((message) => message.body === 'Lease expired.'),
      hasReceipt: indexed?.leaseClaimWindows?.some((window) =>
        window.generation === 1 && window.hasExpiryReceipt),
    }).toEqual({
      state: 'completed',
      overlayBodies: before.messages.map((message) => message.body),
      indexedBodies: before.messages.map((message) => message.body),
      phantom: false,
      hasReceipt: true,
    });
  });

  testOn('R2-A：failed / admin-closed 最终窗回执同样不进公开历史', async () => {
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

describe('M3 R3 返工', () => {
  testOn('R3：失败 warn 一次，投递成功后 warned 集合清空', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = true;
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('smtp down');
      }
      sent.push(input);
      return { messageId: `<m3-r3a-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    now = Date.parse(first.claimedUntil);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    await reapExpiredTaskLeasesOnce();
    await reapExpiredTaskLeasesOnce();
    const afterFail = {
      warns: warn.mock.calls
        .map((args) => args[0])
        .filter((row): row is { kind?: string } => !!row && typeof row === 'object')
        .filter((row) => row.kind === 'expiry_audit_delivery_failed').length,
      warned: warnedExpiryAuditWindowCountForTests(),
      failures: expiryAuditDeliveryFailureCountForTests(),
    };
    failExpiry = false;
    await reapExpiredTaskLeasesOnce();
    warn.mockRestore();
    expect({
      ...afterFail,
      afterSuccess: warnedExpiryAuditWindowCountForTests(),
    }).toEqual({
      warns: 1,
      warned: 1,
      failures: 2,
      afterSuccess: 0,
    });
  });

  testOn('R3：连续失败超上限，集合大小不超 1024', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const over = EXPIRY_AUDIT_WARNED_WINDOWS_LIMIT + 3;
    for (let index = 0; index < over; index += 1) {
      warnExpiryAuditDeliveryFailedForTests({
        taskId: ID,
        generation: index + 1,
        claimedUntil: new Date(START + index * 1000).toISOString(),
        error: new Error('smtp down'),
      });
    }
    const size = warnedExpiryAuditWindowCountForTests();
    // 最旧键已被淘汰，再失败应再 warn（近似去重）。
    warnExpiryAuditDeliveryFailedForTests({
      taskId: ID,
      generation: 1,
      claimedUntil: new Date(START).toISOString(),
      error: new Error('smtp down'),
    });
    const extra = warn.mock.calls
      .map((args) => args[0])
      .filter((row): row is { kind?: string } => !!row && typeof row === 'object')
      .filter((row) => row.kind === 'expiry_audit_delivery_failed').length;
    warn.mockRestore();
    expect({ size, extra, stillCapped: warnedExpiryAuditWindowCountForTests() })
      .toEqual({
        size: EXPIRY_AUDIT_WARNED_WINDOWS_LIMIT,
        extra: over + 1,
        stillCapped: EXPIRY_AUDIT_WARNED_WINDOWS_LIMIT,
      });
  });
});

describe('M3 C 在途集合', () => {
  testOn('C：当前窗与 backfill 接受即丢统一走在途 TTL', async () => {
    let now = START;
    const sent: SendInput[] = [];
    let failExpiry = false;
    const durables = new Map<string, Task>([
      [ID, submittedTask(ID)],
      [ID_B, submittedTask(ID_B)],
    ]);
    setTaskNowForTests(() => now);
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry && input.headers?.['X-OA-Task-Lease-Event'] === 'expired') {
        throw new Error('drop claim-path audit');
      }
      sent.push(input);
      return { messageId: `<m3-c-${sent.length}>` };
    });
    const currentGrant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const backfillGrant = await claimTask({ id: ID_B, from: B, leaseSec: 300 });
    const claimCurrent = (await parseCaptured(sent.find((mail) => mail.headers?.['X-OA-Task'] === ID)!, 2, ID))!;
    const claimBackfill1 = (await parseCaptured(sent.find((mail) => mail.headers?.['X-OA-Task'] === ID_B)!, 2, ID_B))!;
    durables.set(ID, taskFromMessages(ID, [submittedRaw(ID), claimCurrent])!);
    durables.set(ID_B, taskFromMessages(ID_B, [submittedRaw(ID_B), claimBackfill1])!);
    clearQueuedEventsForTests();
    now = Date.parse(backfillGrant.claimedUntil);
    failExpiry = true;
    await claimTask({ id: ID_B, from: B, leaseSec: 3600 });
    const claimBackfill2 = (await parseCaptured(sent.filter((mail) =>
      mail.headers?.['X-OA-Task'] === ID_B && mail.headers?.['X-OA-Task-Lease-Event'] === 'claim')[1]!, 3, ID_B))!;
    // 接受即丢：durable 不收 expiry；setup 清 overlay/在途后由 reaper 统一发射。
    durables.set(ID, taskFromMessages(ID, [submittedRaw(ID), claimCurrent])!);
    durables.set(ID_B, taskFromMessages(ID_B, [submittedRaw(ID_B), claimBackfill1, claimBackfill2])!);
    clearQueuedEventsForTests();
    failExpiry = false;
    now = Date.parse(currentGrant.claimedUntil);
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const afterAccept = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const inFlightAfterAccept = expiryAuditInFlightCountForTests();
    expect(await reapExpiredTaskLeasesOnce()).toBe(0);
    const withinTtl = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length;
    now += EXPIRY_AUDIT_IN_FLIGHT_TTL_MS + 1;
    expect(await reapExpiredTaskLeasesOnce()).toBeGreaterThan(0);
    const afterTtl = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
    const retryCurrent = afterTtl.filter((mail) => mail.headers?.['X-OA-Task'] === ID)[1];
    const retryBackfill = afterTtl.filter((mail) => mail.headers?.['X-OA-Task'] === ID_B)[1];
    const indexedCurrent = retryCurrent ? await parseCaptured(retryCurrent, 4, ID) : null;
    const indexedBackfill = retryBackfill ? await parseCaptured(retryBackfill, 5, ID_B) : null;
    durables.set(ID, indexedCurrent
      ? taskFromMessages(ID, [submittedRaw(ID), claimCurrent, indexedCurrent])!
      : durables.get(ID)!);
    durables.set(ID_B, indexedBackfill
      ? taskFromMessages(ID_B, [submittedRaw(ID_B), claimBackfill1, claimBackfill2, indexedBackfill])!
      : durables.get(ID_B)!);
    setTaskGetForTests(async (id) => durables.get(id) ?? null);
    setTaskListAllForTests(async () => [...durables.values()]);
    const afterIndex = await reapExpiredTaskLeasesOnce();
    expect({
      acceptCurrent: afterAccept.some((mail) => mail.headers?.['X-OA-Task'] === ID),
      acceptBackfill: afterAccept.some((mail) => mail.headers?.['X-OA-Task'] === ID_B),
      inFlightAfterAccept,
      withinTtl,
      retried: afterTtl.length,
      currentFilled: durables.get(ID)?.leaseClaimWindows?.some((window) =>
        window.generation === 1 && window.hasExpiryReceipt),
      backfillFilled: durables.get(ID_B)?.leaseClaimWindows?.some((window) =>
        window.generation === 1 && window.hasExpiryReceipt),
      inFlightAfterIndex: expiryAuditInFlightCountForTests(),
      afterIndex,
    }).toEqual({
      acceptCurrent: true,
      acceptBackfill: true,
      inFlightAfterAccept: 2,
      withinTtl: 2,
      retried: 4,
      currentFilled: true,
      backfillFilled: true,
      inFlightAfterIndex: 0,
      afterIndex: 0,
    });
  });

  testOn('C2：overlay-only claim 窗永不发射', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskListAllForTests(async () => [submittedTask()]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<m3-c2-overlay-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    // durable 仍是 submitted：claim 只在 overlay，丢失后不得当缺失窗。
    now = Date.parse(first.claimedUntil);
    setTaskGetForTests(async () => submittedTask());
    setTaskListAllForTests(async () => [submittedTask()]);
    expect(await reapExpiredTaskLeasesOnce()).toBe(0);
    expect({
      expiry: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length,
      inFlight: expiryAuditInFlightCountForTests(),
    }).toEqual({ expiry: 0, inFlight: 0 });
  });
});

