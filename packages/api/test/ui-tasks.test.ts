import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { UiApiDependencies } from '../src/routes/ui.ts';
import type { Task, TaskState } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const {
  listTaskBoard,
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskSendMailForTests,
  setTaskNowForTests,
  taskService,
  toUiTaskView,
} = await import('../src/lib/tasks.ts');

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

const NOW = '2026-08-12T12:00:00.000Z';

const TASK_A: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  from: 'fox@test.example',
  to: 'owl@test.example',
  subject: 'Ship the board',
  state: 'working',
  createdAt: '2026-08-12T10:00:00.000Z',
  updatedAt: '2026-08-12T11:00:00.000Z',
  messages: [
    {
      id: '1',
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Ship the board',
      date: '2026-08-12T10:00:00.000Z',
      state: 'submitted',
      body: 'please start',
    },
    {
      id: '2',
      from: 'owl@test.example',
      to: 'fox@test.example',
      subject: 'Ship the board',
      date: '2026-08-12T11:00:00.000Z',
      state: 'working',
      body: 'on it',
    },
  ],
};

const TASK_B: Task = {
  id: '22222222-2222-4222-8222-222222222222',
  from: 'cat@test.example',
  to: 'dog@test.example',
  subject: 'Other thread',
  state: 'completed',
  createdAt: '2026-08-12T09:00:00.000Z',
  updatedAt: '2026-08-12T09:30:00.000Z',
  messages: [
    {
      id: '3',
      from: 'cat@test.example',
      to: 'dog@test.example',
      subject: 'Other thread',
      date: '2026-08-12T09:00:00.000Z',
      state: 'submitted',
      body: 'go',
    },
  ],
  result: { ok: true, note: 'done' },
};

const TASK_INPUT: Task = {
  id: '44444444-4444-4444-8444-444444444444',
  from: 'fox@test.example',
  to: 'owl@test.example',
  subject: 'Need a file',
  state: 'input-required',
  createdAt: '2026-08-12T08:00:00.000Z',
  updatedAt: '2026-08-12T08:30:00.000Z',
  messages: [
    {
      id: '4',
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Need a file',
      date: '2026-08-12T08:00:00.000Z',
      state: 'submitted',
      body: 'please attach the spec',
    },
    {
      id: '5',
      from: 'owl@test.example',
      to: 'fox@test.example',
      subject: 'Need a file',
      date: '2026-08-12T08:30:00.000Z',
      state: 'input-required',
      body: 'which spec?',
    },
  ],
};

const APPROVAL_EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const APPROVAL_TASK: Task = {
  id: '55555555-5555-4555-8555-555555555555',
  from: 'fox@test.example', to: 'owl@test.example', subject: 'Approve preview', state: 'input-required',
  createdAt: '2026-08-12T08:00:00.000Z', updatedAt: '2026-08-12T08:00:00.000Z',
  messages: [], kind: 'approval',
  approval: {
    action: { type: 'deployment', name: 'publish-preview', arguments: { dryRun: true } },
    reviewer: 'owl@test.example', expiresAt: APPROVAL_EXPIRES_AT, digest: 'a'.repeat(64),
  },
};

type AuthKind = { kind: 'admin' } | { kind: 'identity'; address: string };

const ORIGIN = { origin: 'http://localhost' };

function overdueNull<T extends Task>(task: T) {
  return { ...task, overdueReason: null, overdueAt: null };
}

function makeApp(
  auth: AuthKind,
  overrides: Partial<UiApiDependencies> = {},
  catalog: Task[] = [TASK_A, TASK_B, TASK_INPUT],
) {
  setTaskNowForTests(() => Date.parse(NOW));
  setTaskListAllForTests(async () => catalog);
  const listCalls: Array<TaskState | undefined> = [];
  const boardCalls: unknown[] = [];
  const getCalls: string[] = [];
  const replyCalls: unknown[] = [];
  const remindCalls: unknown[] = [];
  const closeCalls: unknown[] = [];
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
      list: mock(async (state?: TaskState) => {
        listCalls.push(state);
        return state ? catalog.filter((task) => task.state === state) : catalog;
      }),
      listBoard: mock(async (query, viewer) => {
        boardCalls.push({ query, viewer });
        return listTaskBoard(query, viewer);
      }),
      get: mock(async (id: string) => {
        getCalls.push(id);
        return catalog.find((task) => task.id === id) ?? null;
      }),
      reply: mock(async (input) => {
        replyCalls.push(input);
        const task = catalog.find((row) => row.id === input.id);
        if (!task) throw new Error('not_found');
        if (task.state !== 'input-required') throw new Error('task_not_input_required');
        // 附加键模拟服务层回显放大；路由必须裁掉，identity 不得看到越权字段。
        return {
          ...task,
          state: 'working' as const,
          adminInternal: 'should-not-leak',
          peerMailbox: TASK_B,
        };
      }),
      remind: mock(async (input) => {
        remindCalls.push(input);
        const task = catalog.find((row) => row.id === input.id);
        if (!task) throw new Error('not_found');
        if (task.state === 'completed' || task.state === 'failed') {
          throw new Error('task_already_terminal');
        }
        return { ...task, adminInternal: 'should-not-leak', peerMailbox: TASK_B };
      }),
      close: mock(async (input) => {
        closeCalls.push(input);
        const task = catalog.find((row) => row.id === input.id);
        if (!task) throw new Error('not_found');
        if (task.state === 'completed' || task.state === 'failed') {
          throw new Error('task_already_terminal');
        }
        return {
          ...task,
          state: 'failed' as const,
          result: { closed_by_admin: true, reason: input.reason },
          adminInternal: 'should-not-leak',
          peerMailbox: TASK_B,
        };
      }),
    },
    ...overrides,
  };
  const store = new UiSessionStore({
    resolveToken: (token) => {
      if (token === 'admin-ok' && auth.kind === 'admin') return { kind: 'admin' };
      if (token === 'id-ok' && auth.kind === 'identity') {
        return { kind: 'identity', address: auth.address };
      }
      return null;
    },
  });
  const token = auth.kind === 'admin' ? 'admin-ok' : 'id-ok';
  const created = store.create(token, '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  return {
    app,
    deps,
    cookie: `oae_ui=${created.sid}`,
    listCalls,
    boardCalls,
    getCalls,
    replyCalls,
    remindCalls,
    closeCalls,
  };
}

describe('UI tasks ACL and contract', () => {
  test('admin default list is active and includes overdue + queryNow', async () => {
    const { app, cookie, boardCalls, getCalls } = makeApp({ kind: 'admin' });

    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.queryNow).toBe(NOW);
    expect(body.nextCursor).toBeNull();
    expect(body.totalApprox).toBe(1);
    expect(body.tasks.map((task: Task) => task.id)).toEqual([TASK_A.id]);
    expect(body.tasks[0].overdueReason).toBeNull();
    expect(boardCalls[0]).toEqual({
      query: { status: 'active', period: '30d', limit: 20, cursor: undefined },
      viewer: { kind: 'admin' },
    });

    const detail = await app.request(`/ui/api/tasks/${TASK_B.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(overdueNull(TASK_B));
    expect(getCalls).toEqual([TASK_B.id]);
  });

  test('status filter is forwarded to listBoard', async () => {
    const { app, cookie, boardCalls } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/tasks?status=completed', {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tasks.map((task: Task) => task.id)).toEqual([TASK_B.id]);
    expect(boardCalls[0]).toMatchObject({
      query: { status: 'completed', period: '30d', limit: 20 },
    });
  });

  test('identity only sees participated tasks and is forbidden on peers', async () => {
    const { app, cookie, getCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });

    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.tasks.map((task: Task) => task.id)).toEqual([TASK_A.id]);

    const own = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(overdueNull(TASK_A));

    const peer = await app.request(`/ui/api/tasks/${TASK_B.id}`, {
      headers: { cookie },
    });
    expect(peer.status).toBe(403);
    expect(await peer.json()).toEqual({ error: 'forbidden: task participant required' });
    expect(getCalls).toEqual([TASK_A.id, TASK_B.id]);
  });

  test('identity as task.to participant can list and get the ticket', async () => {
    const { app, cookie } = makeApp({
      kind: 'identity',
      address: 'owl@test.example',
    });
    const listed = await app.request('/ui/api/tasks?status=all', { headers: { cookie } });
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.tasks.map((task: Task) => task.id).sort()).toEqual([TASK_A.id, TASK_INPUT.id].sort());

    const detail = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(overdueNull(TASK_A));
  });

  test('unrelated identity gets an empty list and 403 on peer detail', async () => {
    const { app, cookie } = makeApp({
      kind: 'identity',
      address: 'stranger@test.example',
    });
    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect((await listed.json()).tasks).toEqual([]);

    // 有意口径：任务存在但非参与者 → 403；不存在 → 404（见 missing task）。
    // 存在性侧信道已记档 issue #13，本路由不得擅自改成统一 404。
    const peer = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(peer.status).toBe(403);
    expect(await peer.json()).toEqual({ error: 'forbidden: task participant required' });
  });

  test('mixed-case identity address still matches lowercase task participants', async () => {
    const { app, cookie } = makeApp({
      kind: 'identity',
      address: 'Fox@test.example',
    });
    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect((await listed.json()).tasks.map((task: Task) => task.id)).toEqual([TASK_A.id]);

    const detail = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(overdueNull(TASK_A));
  });

  test('invalid task id is rejected with 400', async () => {
    const { app, cookie, getCalls } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/tasks/not-a-uuid', {
      headers: { cookie },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(getCalls).toEqual([]);
  });

  test('missing task returns 404', async () => {
    const { app, cookie } = makeApp({ kind: 'admin' });
    const response = await app.request(
      '/ui/api/tasks/33333333-3333-4333-8333-333333333333',
      { headers: { cookie } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  test('invalid status/limit filters are rejected with 400', async () => {
    const { app, cookie, boardCalls } = makeApp({ kind: 'admin' });
    for (const query of ['status=bogus', 'limit=20.5', 'limit=999', 'limit=abc', 'period=90d']) {
      const response = await app.request(`/ui/api/tasks?${query}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(Array.isArray(body.details)).toBe(true);
    }
    expect(boardCalls).toEqual([]);
  });

  test('unauthenticated sessions cannot read tasks', async () => {
    const { app, boardCalls, getCalls } = makeApp({ kind: 'admin' });
    const listed = await app.request('/ui/api/tasks');
    expect(listed.status).toBe(401);
    const detail = await app.request(`/ui/api/tasks/${TASK_A.id}`);
    expect(detail.status).toBe(401);
    expect(boardCalls).toEqual([]);
    expect(getCalls).toEqual([]);
  });
});

describe('UI task reply / remind / close', () => {
  test('identity can reply on input-required using itself as from', async () => {
    const { app, cookie, replyCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });
    const response = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'here is the spec' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(toUiTaskView({ ...TASK_INPUT, state: 'working' }));
    expect(body.adminInternal).toBeUndefined();
    expect(body.peerMailbox).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('cat@test.example');
    expect(replyCalls).toEqual([
      { id: TASK_INPUT.id, from: 'fox@test.example', body: 'here is the spec' },
    ]);

    const detail = await app.request(`/ui/api/tasks/${TASK_INPUT.id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(detailBody).sort());
  });

  test('identity reply on a peer task is 403 and does not leak the thread', async () => {
    const { app, cookie, replyCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });
    const response = await app.request(`/ui/api/tasks/${TASK_B.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'should not see this' }),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: 'forbidden: task participant required' });
    expect(JSON.stringify(body)).not.toContain('cat@test.example');
    expect(JSON.stringify(body)).not.toContain('go');
    expect(replyCalls).toEqual([]);
  });

  test('identity cannot spoof from on reply', async () => {
    const { app, cookie, replyCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });
    const response = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'nope', from: 'owl@test.example' }),
    });
    expect(response.status).toBe(403);
    expect(replyCalls).toEqual([]);
  });

  test('reply is rejected unless the task is input-required', async () => {
    const { app, cookie } = makeApp({ kind: 'admin' });
    const response = await app.request(`/ui/api/tasks/${TASK_A.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'too late', from: 'fox@test.example' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'task_not_input_required' });
  });

  test('admin reply requires an explicit participant from', async () => {
    const { app, cookie, replyCalls } = makeApp({ kind: 'admin' });
    const missing = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'spec' }),
    });
    expect(missing.status).toBe(400);

    const outsider = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'spec', from: 'stranger@test.example' }),
    });
    expect(outsider.status).toBe(400);

    const ok = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'spec', from: 'owl@test.example' }),
    });
    expect(ok.status).toBe(200);
    expect(replyCalls).toEqual([
      { id: TASK_INPUT.id, from: 'owl@test.example', body: 'spec' },
    ]);
  });

  test('identity cannot remind or close', async () => {
    const { app, cookie, remindCalls, closeCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });
    const remind = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(remind.status).toBe(403);
    expect(await remind.json()).toEqual({ error: 'forbidden: admin session required' });

    const close = await app.request(`/ui/api/tasks/${TASK_A.id}/close`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop', from: 'fox@test.example' }),
    });
    expect(close.status).toBe(403);
    expect(remindCalls).toEqual([]);
    expect(closeCalls).toEqual([]);
  });

  test('admin remind writes a reminder without changing state; terminal is 409', async () => {
    const { app, cookie, remindCalls } = makeApp({ kind: 'admin' });
    const ok = await app.request(`/ui/api/tasks/${TASK_A.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example', body: 'ping', idempotencyKey: 'k1' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(toUiTaskView(TASK_A));
    expect(remindCalls).toEqual([
      {
        id: TASK_A.id,
        from: 'fox@test.example',
        body: 'ping',
        idempotencyKey: 'k1',
      },
    ]);

    const terminal = await app.request(`/ui/api/tasks/${TASK_B.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'cat@test.example' }),
    });
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toEqual({ error: 'task_already_terminal' });
  });

  test('admin reminder rejects an approval before the service can deliver it', async () => {
    const { app, cookie, remindCalls } = makeApp({ kind: 'admin' }, {}, [APPROVAL_TASK]);
    const response = await app.request(`/ui/api/tasks/${APPROVAL_TASK.id}/remind`, {
      method: 'POST', headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example', body: 'Do not remind approval.' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'approval_decision_required' });
    expect(remindCalls).toEqual([]);
  });

  test('admin close writes structured closed_by_admin; repeat terminal is 409', async () => {
    const { app, cookie, closeCalls } = makeApp({ kind: 'admin' });
    const ok = await app.request(`/ui/api/tasks/${TASK_A.id}/close`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'duplicate work', from: 'fox@test.example' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(
      toUiTaskView({
        ...TASK_A,
        state: 'failed',
        result: { closed_by_admin: true, reason: 'duplicate work' },
      }),
    );
    expect(closeCalls).toEqual([
      { id: TASK_A.id, from: 'fox@test.example', reason: 'duplicate work' },
    ]);

    const again = await app.request(`/ui/api/tasks/${TASK_B.id}/close`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'already done', from: 'cat@test.example' }),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'task_already_terminal' });
  });

  test('close without reason is 400', async () => {
    const { app, cookie, closeCalls } = makeApp({ kind: 'admin' });
    const response = await app.request(`/ui/api/tasks/${TASK_A.id}/close`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(response.status).toBe(400);
    expect(closeCalls).toEqual([]);
  });

  test('reply body over the UI envelope is 400, not a silent 413 schema miss', async () => {
    const { app, cookie, replyCalls } = makeApp({ kind: 'admin' });
    const response = await app.request(`/ui/api/tasks/${TASK_INPUT.id}/reply`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(3001), from: 'fox@test.example' }),
    });
    expect(response.status).toBe(400);
    expect(replyCalls).toEqual([]);
  });
});

/* ---- 终审 C2：呈现层钉 overdue 红条 + Overdue 文字（PR4 双通道；不改生产码） ---- */
const { TASKS_PAGE_JS } = await import('../src/ui/client/pages/tasks.ts');
const { PAGES_CSS } = await import('../src/ui/styles/pages.ts');

/** 从 TASKS_PAGE_JS 抽出一段函数源码。 */
function sliceTasksFn(startNeedle: string, endNeedle: string): string {
  const start = TASKS_PAGE_JS.indexOf(startNeedle);
  const end = TASKS_PAGE_JS.indexOf(endNeedle);
  if (start < 0 || end <= start) {
    throw new Error('tasks.ts slice missing: ' + startNeedle);
  }
  return TASKS_PAGE_JS.slice(start, end);
}

type FakeNode = {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  dateTime: string;
  attributes: Record<string, string>;
  childNodes: FakeNode[];
  classList: { add: (name: string) => void; contains: (name: string) => boolean };
  setAttribute: (key: string, value: string) => void;
  append: (...nodes: FakeNode[]) => void;
  replaceChildren: (...nodes: FakeNode[]) => void;
  addEventListener: (event: string, listener: () => void) => void;
  click: () => void;
};

/** 无 jsdom：够 renderTaskRows 建行、加 class、写 Overdue 文案。 */
function fakeEl(tag: string): FakeNode {
  const node: FakeNode = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    dateTime: '',
    attributes: {},
    childNodes: [],
    classList: {
      add(name: string) {
        const parts = node.className.split(/\s+/).filter(Boolean);
        if (!parts.includes(name)) parts.push(name);
        node.className = parts.join(' ');
      },
      contains(name: string) {
        return node.className.split(/\s+/).includes(name);
      },
    },
    setAttribute(key: string, value: string) {
      node.attributes[key] = value;
    },
    append(...nodes: FakeNode[]) {
      node.childNodes.push(...nodes);
    },
    replaceChildren(...nodes: FakeNode[]) {
      node.childNodes = [...nodes];
    },
    addEventListener(event: string, listener: () => void) {
      if (event === 'click') node.click = listener;
    },
    click() {},
  };
  return node;
}

function makeApprovalActionHarness() {
  const state = { me: { address: 'owl@test.example' }, taskDetail: null as unknown, taskDetailStatus: '' };
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const announced: string[] = [];
  let renderCount = 0;
  let loadCount = 0;
  const updated = { ...APPROVAL_TASK, state: 'completed' as const, result: { decision: 'approved' } };
  const source = sliceTasksFn('function approvalCanDecide(', 'function renderTaskRows(');
  const fn = new Function(
    'document', 'state', 'isAdmin', 'apiJson', 'renderTasks', 'loadTasks', 'announce',
    `${source}\nreturn { approvalCanDecide: approvalCanDecide, renderApprovalAction: renderApprovalAction };`,
  );
  const renderer = fn(
    { createElement: fakeEl }, state, () => false,
    async (path: string, init: RequestInit) => { calls.push({ path, init }); return updated; },
    () => { renderCount += 1; }, () => { loadCount += 1; }, (message: string) => { announced.push(message); },
  ) as {
    approvalCanDecide: (task: Task) => boolean;
    renderApprovalAction: (task: Task) => FakeNode | null;
  };
  return { state, calls, announced, renderer, counts: () => ({ renderCount, loadCount }) };
}

function makeAdminTaskDetailHarness(task: Task) {
  const tasksDetailContent = fakeEl('div');
  const state = { activeTaskId: task.id, taskDetailStatus: 'ready', taskDetailMessage: '', taskDetail: task };
  const source = sliceTasksFn('function renderTaskDetail(', 'function renderTasks(');
  const fn = new Function(
    'document', 'state', 'tasksDetailContent', 'isAdmin', 'clearTaskDetail', 'taskStateToken', 'taskStateLabel',
    'formatAgo', 'taskTimelineBody', 'formatDate', 'taskIsClosed', 'renderTaskResultNode', 'renderApprovalAction',
    'fillTaskFromSelect', 'submitTaskReply', 'submitTaskRemind', 'confirmCloseTask', 'TASK_TIMELINE_RENDER_LIMIT',
    `${source}\nreturn renderTaskDetail;`,
  );
  const renderTaskDetail = fn(
    { createElement: fakeEl }, state, tasksDetailContent, () => true, () => {}, () => 'input-required', () => 'Input required',
    () => 'just now', (value: string) => value, () => '2026-08-12', () => false, () => fakeEl('pre'),
    () => {
      const actions = fakeEl('section');
      const approve = fakeEl('button'); approve.type = 'button'; approve.textContent = 'Approve';
      const reject = fakeEl('button'); reject.type = 'button'; reject.textContent = 'Reject';
      actions.append(approve, reject);
      return actions;
    },
    () => {}, () => {}, () => {}, () => {}, 100,
  ) as () => void;
  return { tasksDetailContent, renderTaskDetail };
}

/** 收集叶子 textContent，用来断言 Overdue 文字通道。 */
function leafTexts(node: FakeNode): string[] {
  if (node.childNodes.length === 0) {
    return node.textContent ? [node.textContent] : [];
  }
  return node.childNodes.flatMap(leafTexts);
}

function makeTaskRowHarness() {
  const tasksRows = {
    childNodes: [] as FakeNode[],
    replaceChildren() {
      this.childNodes = [];
    },
    append(node: FakeNode) {
      this.childNodes.push(node);
    },
  };
  const tasksShown = { textContent: '' };
  const tasksStateNode = { textContent: '' };
  const state = {
    tasksFilter: 'active',
    tasksPeriod: '30d',
    tasksLimit: 20,
    tasksFetchKey: 'active|30d|20',
    tasksStatus: 'ready',
    tasksMessage: '',
    tasksTotalApprox: 0,
    activeTaskId: '',
    tasks: [] as Array<Record<string, unknown>>,
  };
  const helpers = sliceTasksFn('function tasksFetchKey(', 'function syncTasksFilters(');
  const render = sliceTasksFn('function renderTaskRows(', 'function fillTaskFromSelect(');
  // 中文：抽出真实 renderTaskRows；formatAgo / selectTask 与逾期标记无关，打桩即可
  const fn = new Function(
    'document',
    'state',
    'tasksRows',
    'tasksShown',
    'tasksStateNode',
    'formatAgo',
    'selectTask',
    `${helpers}\n${render}\nreturn renderTaskRows;`,
  );
  const renderTaskRows = fn(
    { createElement: fakeEl },
    state,
    tasksRows,
    tasksShown,
    tasksStateNode,
    () => 'just now',
    () => {},
  ) as () => void;
  return { state, tasksRows, renderTaskRows };
}

describe('UI approval decision endpoint', () => {
  test('R8-D RED: dashboard preserves task_expired after production detail read materializes expiry', async () => {
    const boundary = '2026-08-24T00:00:00.000Z';
    const sent: unknown[] = [];
    setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<r8-expiry-${sent.length}@test.example>` }; });
    const pending = await taskService.createApproval!({
      from: 'fox@test.example', to: 'owl@test.example', subject: 'R8 dashboard expiry', body: 'record only',
      action: { type: 'deployment', name: 'preview', arguments: {} }, expiresAt: boundary,
    });
    setTaskGetForTests(async () => pending);
    const { app, cookie } = makeApp({ kind: 'identity', address: 'owl@test.example' }, { taskService }, [pending]);
    setTaskNowForTests(() => Date.parse(boundary));
    expect((await app.request(`/ui/api/tasks/${pending.id}`, { headers: { cookie } })).status).toBe(200);
    const responses = await Promise.all([0, 1].map(async () => {
      const response = await app.request(`/ui/api/tasks/${pending.id}/decision`, {
        method: 'POST', headers: { cookie, ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      });
      return { status: response.status, body: await response.json() };
    }));
    expect({ responses, delivered: sent.length }).toEqual({
      responses: [{ status: 409, body: { error: 'task_expired' } }, { status: 409, body: { error: 'task_expired' } }], delivered: 2,
    });
  });

  test('R8-E RED: an injected dashboard service never falls back to global approval decisions', async () => {
    const sent: unknown[] = [];
    setTaskGetForTests(async () => APPROVAL_TASK);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<global-fallback@test.example>' }; });
    const injected = {
      ...taskService,
      get: async () => APPROVAL_TASK,
      decideApproval: undefined,
    } as typeof taskService;
    const { app, cookie } = makeApp({ kind: 'identity', address: 'owl@test.example' }, { taskService: injected }, [APPROVAL_TASK]);
    const response = await app.request(`/ui/api/tasks/${APPROVAL_TASK.id}/decision`, {
      method: 'POST', headers: { cookie, ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
    });
    expect({ status: response.status, sent: sent.length }).toEqual({ status: 502, sent: 0 });
  });

  test('R8-F RED: exact served approval controls follow server state, not an ahead browser clock', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => Date.parse(APPROVAL_EXPIRES_AT) + 1;
      const { renderer } = makeApprovalActionHarness();
      const failed: Task = { ...APPROVAL_TASK, state: 'failed', result: { decision: 'expired' } };
      expect([renderer.approvalCanDecide(APPROVAL_TASK), renderer.approvalCanDecide(failed)]).toEqual([true, false]);
    } finally {
      Date.now = originalNow;
    }
  });

  test('dashboard actor matrix keeps approval authority at the stored reviewer and core service', async () => {
    const decided: unknown[] = [];
    const { app, cookie, deps } = makeApp(
      { kind: 'identity', address: 'owl@test.example' },
      {},
      [APPROVAL_TASK],
    );
    (deps.taskService as any).decideApproval = mock(async (input: unknown) => {
      decided.push(input);
      return { ...APPROVAL_TASK, state: 'completed' as const, result: { decision: 'approved', digest: APPROVAL_TASK.approval!.digest } };
    });
    const ok = await app.request(`/ui/api/tasks/${APPROVAL_TASK.id}/decision`, {
      method: 'POST', headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: 'approval', state: 'completed', approval: { reviewer: 'owl@test.example' } });
    expect(decided).toEqual([{ id: APPROVAL_TASK.id, from: 'owl@test.example', decision: 'approved' }]);

    async function decide(app: Hono, cookie: string, body: unknown) {
      return app.request(`/ui/api/tasks/${APPROVAL_TASK.id}/decision`, {
        method: 'POST', headers: { cookie, ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    }

    for (const address of ['fox@test.example']) {
      const denied = makeApp({ kind: 'identity', address }, {}, [APPROVAL_TASK]);
      const response = await decide(denied.app, denied.cookie, { decision: 'approved' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden: approval reviewer required' });
    }

    // R6 RED: a dashboard outsider guessing an ordinary or approval decision
    // URL sees neither the task kind nor the stored reviewer ACL outcome.
    for (const task of [TASK_A, APPROVAL_TASK]) {
      const outsider = makeApp({ kind: 'identity', address: 'stranger@test.example' }, {}, [task]);
      const response = await outsider.app.request(`/ui/api/tasks/${task.id}/decision`, {
        method: 'POST', headers: { cookie: outsider.cookie, ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }

    const admin = makeApp({ kind: 'admin' }, {}, [APPROVAL_TASK]);
    expect((await decide(admin.app, admin.cookie, { decision: 'approved' })).status).toBe(403);
    expect((await decide(admin.app, admin.cookie, { from: 'fox@test.example', decision: 'approved' })).status).toBe(403);
    (admin.deps.taskService as any).decideApproval = mock(async (input: unknown) => {
      decided.push(input);
      return { ...APPROVAL_TASK, state: 'completed' as const, result: { decision: 'rejected' } };
    });
    const adminOk = await decide(admin.app, admin.cookie, { from: 'owl@test.example', decision: 'rejected' });
    expect(adminOk.status).toBe(200);
    expect(decided.at(-1)).toEqual({ id: APPROVAL_TASK.id, from: 'owl@test.example', decision: 'rejected' });

    const missing = makeApp({ kind: 'identity', address: 'owl@test.example' }, {}, []);
    expect((await decide(missing.app, missing.cookie, { decision: 'approved' })).status).toBe(404);
    const ordinary = makeApp({ kind: 'identity', address: 'owl@test.example' }, {}, [TASK_A]);
    const ordinaryResponse = await ordinary.app.request(`/ui/api/tasks/${TASK_A.id}/decision`, {
      method: 'POST', headers: { cookie: ordinary.cookie, ...ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
    });
    expect(ordinaryResponse.status).toBe(409);
    expect(await ordinaryResponse.json()).toEqual({ error: 'not_approval_task' });

    const terminalTask: Task = { ...APPROVAL_TASK, state: 'completed', result: { decision: 'approved' } };
    const terminal = makeApp({ kind: 'identity', address: 'owl@test.example' }, {}, [terminalTask]);
    (terminal.deps.taskService as any).decideApproval = mock(async () => { throw new Error('task_already_decided'); });
    expect((await decide(terminal.app, terminal.cookie, { decision: 'approved' })).status).toBe(409);

    const coreRecheck = makeApp({ kind: 'identity', address: 'owl@test.example' }, {}, [APPROVAL_TASK]);
    (coreRecheck.deps.taskService as any).decideApproval = mock(async () => { throw new Error('approval_reviewer_required'); });
    const rechecked = await decide(coreRecheck.app, coreRecheck.cookie, { decision: 'approved' });
    expect(rechecked.status).toBe(403);
    expect(await rechecked.json()).toEqual({ error: 'forbidden: approval reviewer required' });
  });

  test('the exact served renderer keeps action text inert and posts an approval decision', async () => {
    const { state, calls, announced, renderer, counts } = makeApprovalActionHarness();
    const malicious: Task = {
      ...APPROVAL_TASK,
      approval: {
        ...APPROVAL_TASK.approval!,
        action: {
          type: 'deployment', name: '<img src=x onerror=alert(1)>',
          arguments: { html: '<img src=x onerror=alert(1)>', flags: ['safe', 'dry-run'] },
        },
      },
    };
    const section = renderer.renderApprovalAction(malicious)!;
    expect(renderer.approvalCanDecide(malicious)).toBe(true);
    expect(leafTexts(section)).toContain('Name: <img src=x onerror=alert(1)>');
    expect(leafTexts(section)).toContain(JSON.stringify(malicious.approval!.action.arguments));
    expect(Object.hasOwn(section, 'innerHTML')).toBe(false);
    const buttons = section.childNodes.filter((node) => node.tagName === 'BUTTON');
    expect(buttons.map((button) => ({ type: button.type, label: button.attributes['aria-label'], text: button.textContent }))).toEqual([
      { type: 'button', label: 'Approve action', text: 'Approve' },
      { type: 'button', label: 'Reject action', text: 'Reject' },
    ]);
    buttons[0]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      path: `/ui/api/tasks/${APPROVAL_TASK.id}/decision`,
      init: {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      },
    });
    expect(state.taskDetail).toEqual({ ...APPROVAL_TASK, state: 'completed', result: { decision: 'approved' } });
    expect(state.taskDetailStatus).toBe('ready');
    expect(counts()).toEqual({ renderCount: 1, loadCount: 1 });
    expect(announced).toEqual(['Approval recorded.']);
  });

  test('the exact served admin detail hides generic actions for approval but retains them for ordinary tasks', () => {
    const approval = makeAdminTaskDetailHarness(APPROVAL_TASK);
    approval.renderTaskDetail();
    expect(leafTexts(approval.tasksDetailContent)).toContain('Approve');
    expect(leafTexts(approval.tasksDetailContent)).toContain('Reject');
    expect(approval.tasksDetailContent.childNodes.some((node) => node.className === 'task-admin-actions')).toBe(false);

    const ordinary = makeAdminTaskDetailHarness(TASK_A);
    ordinary.renderTaskDetail();
    expect(ordinary.tasksDetailContent.childNodes.some((node) => node.className === 'task-admin-actions')).toBe(true);
    expect(leafTexts(ordinary.tasksDetailContent)).toEqual(expect.arrayContaining(['Remind', 'Close']));
  });
});

describe('UI task overdue presentation (PR4 dual channel)', () => {
  test('overdue row has is-overdue class and Overdue text; on-time row has neither', () => {
    const { state, tasksRows, renderTaskRows } = makeTaskRowHarness();
    // 直造 overdue 字段：不走时钟，钉呈现层对 overdueReason 的分支
    state.tasks = [
      {
        id: 'overdue-row',
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Stuck in submitted',
        state: 'submitted',
        updatedAt: '2026-08-12T07:00:00.000Z',
        messages: [],
        overdueReason: 'submitted',
        overdueAt: '2026-08-12T11:00:00.000Z',
      },
      {
        id: 'ontime-row',
        from: 'cat@test.example',
        to: 'dog@test.example',
        subject: 'Still moving',
        state: 'working',
        updatedAt: '2026-08-12T11:50:00.000Z',
        messages: [],
        overdueReason: null,
        overdueAt: null,
      },
    ];
    state.tasksTotalApprox = 2;
    renderTaskRows();

    expect(tasksRows.childNodes).toHaveLength(2);
    const overdueRow = tasksRows.childNodes[0];
    const onTimeRow = tasksRows.childNodes[1];

    expect(overdueRow.classList.contains('task-row')).toBe(true);
    expect(overdueRow.classList.contains('is-overdue')).toBe(true);
    expect(leafTexts(overdueRow)).toContain('Overdue');
    expect(
      overdueRow.childNodes.some((cell) =>
        cell.childNodes.some((child) => child.className === 'task-overdue-flag'),
      ),
    ).toBe(true);

    expect(onTimeRow.classList.contains('is-overdue')).toBe(false);
    expect(leafTexts(onTimeRow)).not.toContain('Overdue');
    expect(
      onTimeRow.childNodes.some((cell) =>
        cell.childNodes.some((child) => child.className === 'task-overdue-flag'),
      ),
    ).toBe(false);
  });

  test('is-overdue CSS is an inset red bar; Overdue flag is red text', () => {
    // 红条通道在 CSS，不只靠 class 名；与 PR4「左侧红条 + Overdue 文字」对齐
    expect(PAGES_CSS).toContain('.task-row.is-overdue {\n  box-shadow: inset 3px 0 0 var(--red);\n}');
    expect(PAGES_CSS).toContain('.task-overdue-flag {\n  display: inline-block;\n  margin-top: 4px;\n  color: var(--red);');
  });
});
