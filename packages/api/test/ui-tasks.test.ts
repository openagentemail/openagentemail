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
const {
  listTaskBoard,
  setTaskListAllForTests,
  setTaskNowForTests,
} = await import('../src/lib/tasks.ts');

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
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
        return { ...task, state: 'working' as const };
      }),
      remind: mock(async (input) => {
        remindCalls.push(input);
        const task = catalog.find((row) => row.id === input.id);
        if (!task) throw new Error('not_found');
        if (task.state === 'completed' || task.state === 'failed') {
          throw new Error('task_already_terminal');
        }
        return task;
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
    expect(replyCalls).toEqual([
      { id: TASK_INPUT.id, from: 'fox@test.example', body: 'here is the spec' },
    ]);
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
    expect(await ok.json()).toMatchObject({ id: TASK_A.id, state: 'working' });
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

  test('admin close writes structured closed_by_admin; repeat terminal is 409', async () => {
    const { app, cookie, closeCalls } = makeApp({ kind: 'admin' });
    const ok = await app.request(`/ui/api/tasks/${TASK_A.id}/close`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'duplicate work', from: 'fox@test.example' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      state: 'failed',
      result: { closed_by_admin: true, reason: 'duplicate work' },
    });
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
