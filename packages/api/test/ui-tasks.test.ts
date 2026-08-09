import { describe, expect, mock, test } from 'bun:test';
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

const TASK_A: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  from: 'fox@test.example',
  to: 'owl@test.example',
  subject: 'Ship the board',
  state: 'working',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  messages: [
    {
      id: '1',
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Ship the board',
      date: '2024-01-01T00:00:00.000Z',
      state: 'submitted',
      body: 'please start',
    },
    {
      id: '2',
      from: 'owl@test.example',
      to: 'fox@test.example',
      subject: 'Ship the board',
      date: '2024-01-02T00:00:00.000Z',
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
  createdAt: '2024-01-03T00:00:00.000Z',
  updatedAt: '2024-01-04T00:00:00.000Z',
  messages: [
    {
      id: '3',
      from: 'cat@test.example',
      to: 'dog@test.example',
      subject: 'Other thread',
      date: '2024-01-03T00:00:00.000Z',
      state: 'submitted',
      body: 'go',
    },
  ],
  result: { ok: true, note: 'done' },
};

type AuthKind = { kind: 'admin' } | { kind: 'identity'; address: string };

function makeApp(
  auth: AuthKind,
  overrides: Partial<UiApiDependencies> = {},
  catalog: Task[] = [TASK_A, TASK_B],
) {
  const listCalls: Array<TaskState | undefined> = [];
  const getCalls: string[] = [];
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
      get: mock(async (id: string) => {
        getCalls.push(id);
        return catalog.find((task) => task.id === id) ?? null;
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
  return { app, deps, cookie: `oae_ui=${created.sid}`, listCalls, getCalls };
}

describe('UI tasks ACL and contract', () => {
  test('admin lists all tasks and can fetch any detail', async () => {
    const { app, cookie, listCalls, getCalls } = makeApp({ kind: 'admin' });

    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tasks: [TASK_A, TASK_B] });
    expect(listCalls).toEqual([undefined]);

    const detail = await app.request(`/ui/api/tasks/${TASK_B.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(TASK_B);
    expect(getCalls).toEqual([TASK_B.id]);
  });

  test('state filter is forwarded to taskService.list', async () => {
    const { app, cookie, listCalls } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/tasks?state=completed', {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: [TASK_B] });
    expect(listCalls).toEqual(['completed']);
  });

  test('identity only sees participated tasks and is forbidden on peers', async () => {
    const { app, cookie, getCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });

    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tasks: [TASK_A] });

    const own = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(TASK_A);

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
    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tasks: [TASK_A] });

    const detail = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(TASK_A);
  });

  test('unrelated identity gets an empty list and 403 on peer detail', async () => {
    const { app, cookie } = makeApp({
      kind: 'identity',
      address: 'stranger@test.example',
    });
    const listed = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ tasks: [] });

    const peer = await app.request(`/ui/api/tasks/${TASK_A.id}`, {
      headers: { cookie },
    });
    expect(peer.status).toBe(403);
    expect(await peer.json()).toEqual({ error: 'forbidden: task participant required' });
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

  test('invalid state filter is rejected with 400', async () => {
    const { app, cookie, listCalls } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/tasks?state=bogus', {
      headers: { cookie },
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_request');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(listCalls).toEqual([]);
  });

  test('unauthenticated sessions cannot read tasks', async () => {
    const { app, listCalls, getCalls } = makeApp({ kind: 'admin' });
    const listed = await app.request('/ui/api/tasks');
    expect(listed.status).toBe(401);
    const detail = await app.request(`/ui/api/tasks/${TASK_A.id}`);
    expect(detail.status).toBe(401);
    expect(listCalls).toEqual([]);
    expect(getCalls).toEqual([]);
  });
});
