/**
 * 非 Error rejection 归一化 · 路由级正控 + Error 路径守门负控
 *
 * 正控 A：POST /v1/tasks create 段 / post-create 段 — throw undefined / {code:1} ⇒ 非 500、落既有兜底
 * 正控 B：UI task 突变 — 同类非 Error ⇒ 非 500、落 smtp_error
 * 守门负控：Error 路径 status + body 逐字节不变
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import './support/ui-i18n-shim.ts';
import { Hono } from 'hono';
import type { Task, TaskService } from '../src/lib/tasks.ts';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-err-norm-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');

const A = 'alpha@test.example';
const B = 'bravo@test.example';
const CREATED_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = { origin: 'http://localhost' };
const NOW = '2026-08-12T12:00:00.000Z';

for (const localpart of ['fox', 'owl']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

/** 假任务：create 成功后供 wait / 投影使用 */
function createdTask(overrides: Partial<Task> = {}): Task {
  return {
    id: CREATED_ID,
    from: A,
    to: B,
    subject: 'norm',
    state: 'submitted',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [{
      id: '1', from: A, to: B, subject: 'norm',
      date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'go',
    }],
    ...overrides,
  };
}

/** UI 侧工作中任务夹具 */
const TASK_A: Task = {
  id: TASK_ID,
  from: 'fox@test.example',
  to: 'owl@test.example',
  subject: 'Ship',
  state: 'working',
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T11:00:00.000Z',
  messages: [{
    id: '1', from: 'fox@test.example', to: 'owl@test.example', subject: 'Ship',
    date: '2026-08-12T10:00:00.000Z', state: 'submitted', body: 'please',
  }],
};

function unused(): never {
  throw new Error('unused');
}

/** 最小 TaskService 骨架，按用例覆写 create / waitForTerminal */
function baseService(overrides: Partial<TaskService> = {}): TaskService {
  return {
    async create(input) {
      return createdTask({ from: input.from, to: input.to, subject: input.subject });
    },
    async list() { return []; },
    async listBoard() {
      return { tasks: [], nextCursor: null, totalApprox: 0, queryNow: '2026-08-24T00:00:00.000Z' };
    },
    async get() { return null; },
    async update() { return unused(); },
    async reply() { return unused(); },
    async remind() { return unused(); },
    async close() { return unused(); },
    async waitForTerminal() { return null; },
    ...overrides,
  };
}

function appForTasks(service: TaskService) {
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
  return app;
}

async function postCreate(app: Hono, body: Record<string, unknown>) {
  return app.request('/v1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeUiApp(taskServiceOverride: Partial<UiApiDependencies['taskService']>) {
  setTaskNowForTests(() => Date.parse(NOW));
  setTaskListAllForTests(async () => [TASK_A]);
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'admin-ok' ? { kind: 'admin' } : null),
  });
  const created = store.create('admin-ok', '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const deps: UiApiDependencies = {
    listIdentities: () => [],
    listMessages: mock(async () => []),
    setMessageSeen: mock(async () => true),
    getMailboxScan: mock(async () => ({
      kind: 'ready' as const,
      now: Date.now(),
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    })),
    getMessage: mock(async () => null),
    setPushContentTier: mock(() => null),
    taskService: {
      list: mock(async () => [TASK_A]),
      listBoard: mock(async () => ({
        tasks: [TASK_A], nextCursor: null, totalApprox: 1, queryNow: NOW,
      })),
      get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
      reply: mock(async () => unused()),
      remind: mock(async () => unused()),
      close: mock(async () => unused()),
      ...taskServiceOverride,
    } as UiApiDependencies['taskService'],
  };
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  return { app, cookie: `oae_ui=${created.sid}` };
}

const NON_ERROR_BOOMS: unknown[] = [undefined, { code: 1 }];

/** R1：message 取值本身会抛 —— 映射器经 errorCode try/catch 仍须落既有兜底 */
function throwingMessageRejection(): unknown {
  return Object.defineProperty({}, 'message', {
    get() {
      throw new Error('boom');
    },
  });
}

describe('正控 A · POST /v1/tasks 非 Error rejection 消 500', () => {
  // create 段既有兜底：502 { error: 'smtp_error' }（无 taskId）
  for (const boom of NON_ERROR_BOOMS) {
    const label = boom === undefined ? 'undefined' : '{code:1}';
    test(`create 段 throw ${label} → 502 smtp_error（非 500）`, async () => {
      const app = appForTasks(baseService({
        async create() { throw boom; },
      }));
      const res = await postCreate(app, { to: B, subject: 'boom', body: 'x' });
      const text = await res.text();
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(502);
      expect(text).toBe(JSON.stringify({ error: 'smtp_error' }));
    });
  }

  // R1 可选路由正控：会抛 getter 不得再逸出成 500
  test('create 段 throw 会抛 message getter → 502 smtp_error（非 500）', async () => {
    const app = appForTasks(baseService({
      async create() { throw throwingMessageRejection(); },
    }));
    const res = await postCreate(app, { to: B, subject: 'getter boom', body: 'x' });
    const text = await res.text();
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(502);
    expect(text).toBe(JSON.stringify({ error: 'smtp_error' }));
  });

  // post-create/wait 段既有兜底：502 { error: 'wait_failed', taskId, created: true }
  for (const boom of NON_ERROR_BOOMS) {
    const label = boom === undefined ? 'undefined' : '{code:1}';
    test(`post-create/wait 段 throw ${label} → 502 wait_failed + taskId（非 500）`, async () => {
      const app = appForTasks(baseService({
        async waitForTerminal() { throw boom; },
      }));
      const res = await postCreate(app, { to: B, subject: 'wait boom', body: 'go', wait: true });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: 'wait_failed',
        taskId: CREATED_ID,
        created: true,
      });
    });
  }
});

describe('正控 B · UI task 突变非 Error rejection 消 500', () => {
  for (const boom of NON_ERROR_BOOMS) {
    const label = boom === undefined ? 'undefined' : '{code:1}';
    test(`remind throw ${label} → 502 smtp_error（非 500）`, async () => {
      const { app, cookie } = makeUiApp({
        get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
        remind: mock(async () => { throw boom; }),
      });
      const res = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
        method: 'POST',
        headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'fox@test.example' }),
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'smtp_error' });
    });
  }
});

describe('守门负控 · Error 路径 status/body 逐字节不变', () => {
  test('create 段 Error(smtp_send_boom) → 502 smtp_error 无 id', async () => {
    const app = appForTasks(baseService({
      async create() { throw new Error('smtp_send_boom'); },
    }));
    const res = await postCreate(app, { to: B, subject: 'SMTP fail', body: 'x', wait: true });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).toBe(JSON.stringify({ error: 'smtp_error' }));
  });

  test('post-create wait Error(非 journal) → 502 wait_failed + taskId', async () => {
    const app = appForTasks(baseService({
      async waitForTerminal() { throw new Error('wait_boom_non_journal'); },
    }));
    const res = await postCreate(app, { to: B, subject: 'Wait boom', body: 'go', wait: true });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'wait_failed',
      taskId: CREATED_ID,
      created: true,
    });
  });

  test('post-create journal Error(lease_journal_lost) → 503 + taskId', async () => {
    const app = appForTasks(baseService({
      async waitForTerminal() { throw new Error('lease_journal_lost'); },
    }));
    const res = await postCreate(app, { to: B, subject: 'journal', body: 'go', wait: true });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'lease_journal_lost',
      taskId: CREATED_ID,
      created: true,
    });
  });

  test('create 段 Error(parent_task_not_found) → 404 not_found', async () => {
    const app = appForTasks(baseService({
      async create() { throw new Error('parent_task_not_found'); },
    }));
    const res = await postCreate(app, { to: B, subject: 'parent', body: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('UI remind Error(lease_journal_lost) → 503', async () => {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
      remind: mock(async () => { throw new Error('lease_journal_lost'); }),
    });
    const res = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lease_journal_lost' });
  });

  test('UI remind Error(not_found) → 404', async () => {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
      remind: mock(async () => { throw new Error('not_found'); }),
    });
    const res = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('UI remind Error(task_already_terminal) → 409', async () => {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
      remind: mock(async () => { throw new Error('task_already_terminal'); }),
    });
    const res = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'task_already_terminal' });
  });

  test('UI remind Error(imap_write_failed) → 502 smtp_error', async () => {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === TASK_A.id ? TASK_A : null)),
      remind: mock(async () => { throw new Error('imap_write_failed'); }),
    });
    const res = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'smtp_error' });
  });
});
