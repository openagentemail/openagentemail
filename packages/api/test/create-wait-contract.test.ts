/**
 * #183：create(wait=true) 错误响应分层（方案 A）
 * - 未创建 = 502 smtp_error 无 id（旧行为）
 * - 已创建后 wait 失败 = 带 taskId（journal→503 / 其他→502 / 429 补 id）
 * - MCP client/tools 透出 taskId + 安全重试口径
 */
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { SendInput } from '../src/lib/smtp.ts';
import type { Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-create-wait-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const { claimTask } = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const {
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} = await import('./support/task-lease-seams.ts');
const {
  JournalError,
  bootstrapTaskLeaseJournal,
  journalPathsForTests,
  resetJournalMemoryForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
} = await import('../src/lib/task-lease-journal.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { ApiError, OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { registerOpenAgentEmailTools } = await import('../src/mcp/tools.ts');
const { McpServer } = await import('@modelcontextprotocol/server');
const {
  MAX_WAITS_PER_SLOT,
  acquireWaitSlot,
  releaseWaitSlot,
  resetWaitSlots,
} = await import('../src/lib/ratelimit.ts');

const A = 'alpha@test.example';
const B = 'bravo@test.example';
const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const START = Date.parse('2026-08-24T00:00:00.000Z');

async function withM2On<T>(work: () => T | Promise<T>): Promise<T> {
  return withTaskLeasesEnabledForTests(true, () =>
    withTaskLeasePendingJournalForTests(true, work));
}

const testOn = (name: string, work: () => void | Promise<void>) =>
  bunTest(name, () => withM2On(work));

function submittedTask(): Task {
  return {
    id: ID,
    from: A,
    to: B,
    subject: 'Lease',
    state: 'submitted',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [{
      id: '1', from: A, to: B, subject: 'Lease',
      date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
    }],
  };
}

function appForCreate() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { kind: 'identity', address: A });
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    findIdentity: (address) => [A, B].includes(address.toLowerCase())
      ? { address, createdAt: '2026-08-24T00:00:00.000Z' }
      : undefined,
  }));
  return app;
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  setJournalCrashHookForTests(null);
  clearQueuedEventsForTests();
  resetJournalMemoryForTests();
  resetWaitSlots();
});

describe('#183 create(wait=true) 响应契约分层', () => {
  testOn('1: SMTP ACCEPT + journal 未 bootstrap → 503 + taskId + created；任务可查', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-cw-noboot-'));
    setJournalDataDirForTests(dir);
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<cw-noboot-${sent.length}>` };
    });
    // 避开 IMAP：get 缝返回非终态任务，hydrate 仍会走 journal → not_bootstrapped
    setTaskGetForTests(async (id) => ({
      id, from: A, to: B, subject: 'Wait journal', state: 'submitted',
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [{
        id: '1', from: A, to: B, subject: 'Wait journal',
        date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'go',
      }],
    }));

    const res = await appForCreate().request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'Wait journal', body: 'go', wait: true }),
    });
    const body = await res.json() as { error?: string; taskId?: string; created?: boolean };
    expect(res.status).toBe(503);
    expect(body).toEqual({
      error: 'lease_journal_not_bootstrapped',
      taskId: expect.any(String),
      created: true,
    });
    expect(sent).toHaveLength(1);
    // SMTP 已接受且头带同一 task id = 任务确已创建（避免再打 IMAP）
    const headerId = sent[0]?.headers?.['X-OA-Task'] ?? sent[0]?.headers?.['x-oa-task'];
    expect(headerId).toBe(body.taskId);
  });

  testOn('2: SMTP 抛错 → 502 smtp_error、body 无 taskId（旧行为）', async () => {
    setJournalDataDirForTests(mkdtempSync(join(tmpdir(), 'oae-cw-smtp-fail-')));
    setTaskSendMailForTests(async () => {
      throw new Error('smtp_send_boom');
    });
    const res = await appForCreate().request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'SMTP fail', body: 'x', wait: true }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    // 逐字节旧行为：仅 {error:'smtp_error'}，无 taskId/created
    expect(text).toBe(JSON.stringify({ error: 'smtp_error' }));
  });

  testOn('3: journal crash-hook latch 变体 → 503 + lease_journal_crash_* + taskId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-cw-latch-'));
    setJournalDataDirForTests(dir);
    bootstrapTaskLeaseJournal();
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async () => ({ messageId: '<cw-latch-seed>' }));
    // 先用 crash-hook 钉死真实 code 字符串（与 m2 同手法）
    setJournalCrashHookForTests('before-write');
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toMatchObject({
      message: 'lease_journal_crash_before_write',
    });
    // latch 用例之间绝不 resetJournalMemoryForTests（m2 教训）
    setJournalCrashHookForTests(null);

    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<cw-latch-${sent.length}>` };
    });
    // wait 读路径直接抛出 crash code（读路径无 persist hook；映射口径与 journalUnavailable 一致）
    setTaskGetForTests(async () => {
      throw new JournalError('lease_journal_crash_before_write');
    });
    const res = await appForCreate().request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'Latch wait', body: 'go', wait: true }),
    });
    const body = await res.json() as { error?: string; taskId?: string; created?: boolean };
    expect(res.status).toBe(503);
    expect(body.error).toBe('lease_journal_crash_before_write');
    expect(body.created).toBe(true);
    expect(typeof body.taskId).toBe('string');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers?.['X-OA-Task'] ?? sent[0]?.headers?.['x-oa-task']).toBe(body.taskId);
  });

  testOn('3b: 热进程 journal lost latch → 503 + lease_journal_lost + taskId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-cw-lost-'));
    setJournalDataDirForTests(dir);
    bootstrapTaskLeaseJournal();
    const paths = journalPathsForTests();
    unlinkSync(paths.journal);
    // 注意：绝不调用 resetJournalMemoryForTests()
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<cw-lost-${sent.length}>` };
    });
    setTaskGetForTests(async (id) => ({
      id, from: A, to: B, subject: 'Lost wait', state: 'submitted',
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [{
        id: '1', from: A, to: B, subject: 'Lost wait',
        date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'go',
      }],
    }));
    const res = await appForCreate().request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'Lost wait', body: 'go', wait: true }),
    });
    const body = await res.json() as { error?: string; taskId?: string; created?: boolean };
    expect(res.status).toBe(503);
    expect(body).toEqual({
      error: 'lease_journal_lost',
      taskId: expect.any(String),
      created: true,
    });
    expect(sent).toHaveLength(1);
  });

  testOn('4: wait 槽位占满 → 429 + taskId', async () => {
    // 注入 service：create 成功；wait 不应被调用（槽位已满）
    const createdId = 'cccccccc-dddd-eeee-ffff-000000000001';
    const service = {
      async create(input: { from: string; to: string; subject: string; body: string }) {
        return {
          id: createdId, from: input.from, to: input.to, subject: input.subject,
          state: 'submitted' as const,
          createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
          messages: [{
            id: '1', from: input.from, to: input.to, subject: input.subject,
            date: '2026-08-24T00:00:00.000Z', state: 'submitted' as const, body: input.body,
          }],
        };
      },
      async list() { return []; },
      async listBoard() {
        return { tasks: [], nextCursor: null, totalApprox: 0, queryNow: '2026-08-24T00:00:00.000Z' };
      },
      async get() { return null; },
      async update() { throw new Error('unused'); },
      async reply() { throw new Error('unused'); },
      async remind() { throw new Error('unused'); },
      async close() { throw new Error('unused'); },
      async waitForTerminal() { throw new Error('wait_should_not_run'); },
    };
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'identity', address: A });
      await next();
    });
    app.route('/v1/tasks', createTaskRoutes({
      service,
      findIdentity: (address) => [A, B].includes(address.toLowerCase())
        ? { address, createdAt: '2026-08-24T00:00:00.000Z' }
        : undefined,
    }));
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) {
      expect(acquireWaitSlot(A)).toBe(true);
    }
    try {
      const res = await app.request('/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: B, subject: 'Slot full', body: 'go', wait: true }),
      });
      const body = await res.json() as {
        error?: string; retryAfterSec?: number; taskId?: string;
      };
      expect(res.status).toBe(429);
      expect(body.error).toBe('too_many_waits');
      expect(body.taskId).toBe(createdId);
      // retryAfterSec 必须保留自 waitWithSlot 原 body（解析合并），不得硬编码丢失
      expect(body.retryAfterSec).toBe(5);
      expect(body).toEqual({
        error: 'too_many_waits',
        retryAfterSec: 5,
        taskId: createdId,
      });
    } finally {
      for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) releaseWaitSlot(A);
    }
  });

  bunTest('5: MCP client 透出 taskId；tools 失败文案含 id 与勿重新 create', async () => {
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // 502 body 透出
    {
      const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
        new Response(JSON.stringify({ error: 'smtp_error', taskId, created: true }), { status: 502 }));
      let err: unknown;
      try {
        await client.createTask(B, 'x', 'y', true);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      const api = err as InstanceType<typeof ApiError>;
      expect(api.status).toBe(502);
      expect(api.taskId).toBe(taskId);
      expect(api.errorBody).toEqual({ error: 'smtp_error', taskId, created: true });
    }
    // 503 body 透出 + 真实 tools.fail 文案
    {
      const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
        new Response(JSON.stringify({
          error: 'lease_journal_not_bootstrapped', taskId, created: true,
        }), { status: 503 }));
      let err: unknown;
      try {
        await client.createTask(B, 'x', 'y', true);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      expect((err as InstanceType<typeof ApiError>).taskId).toBe(taskId);
      expect((err as InstanceType<typeof ApiError>).status).toBe(503);

      const server = new McpServer({ name: 'cw-183', version: '0.0.0' });
      registerOpenAgentEmailTools(server, client);
      const tool = (server as unknown as {
        _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{
          isError?: boolean; content?: Array<{ text?: string }>;
        }> }>;
      })._registeredTools.task_create;
      const result = await tool.handler({
        to: B, subject: 'x', body: 'y', wait: true,
      });
      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.text ?? '';
      expect(text).toContain(taskId);
      expect(text).toMatch(/task_get/);
      expect(text).toMatch(/do not call task_create again/i);
    }
  });
});
