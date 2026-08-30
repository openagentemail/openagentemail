import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-r3-'));

const { expect, test, afterEach } = await import('bun:test');
const { Hono } = await import('hono');
const tasks = await import('../src/lib/tasks.ts');
const core = await import('../src/lib/tasks-internal.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const PARENT = 'f0c4a8e6-1e22-4c66-8c2f-0955a20d81bf';
const CHILD = '4a9d58b5-7c2e-4ca0-819a-4c36243695a1';
const HIDDEN = 'b2e4c88a-9f41-4fa7-8d32-c4e7e98b45aa';
const A = 'alpha@test.example'; const B = 'bravo@test.example'; const C = 'charlie@test.example';

function task(id: string, from: string, to: string, state: Task['state'] = 'submitted', parentTaskId?: string): Task {
  return { id, from, to, subject: id, state, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...(parentTaskId ? { parentTaskId } : {}), messages: [] };
}
function app(service: TaskService, address = A) {
  const out = new Hono(); out.use('*', async (c, next) => { c.set('auth', { kind: 'identity', address }); await next(); });
  out.route('/v1/tasks', createTaskRoutes({ service, findIdentity: (value) => [A, B, C].includes(value) ? { address: value, createdAt: '' } : undefined })); return out;
}
afterEach(() => core.setTaskListAllForTests(null));

test('R3 RED: route state filtering uses one snapshot and keeps a readable parent edge', async () => {
  const parent = task(PARENT, A, B, 'completed'); const child = task(CHILD, A, B, 'submitted', PARENT);
  let lists = 0;
  const service = { ...tasks.taskService, list: async () => { lists += 1; return [parent, child]; } } as TaskService;
  const response = await app(service).request('/v1/tasks?state=submitted');
  expect(response.status).toBe(200); expect(lists).toBe(1);
  expect((await response.json() as { tasks: Array<{ parentTaskId?: string }> }).tasks).toEqual([{ ...tasks.toTaskView(child), parentTaskId: PARENT }]);
});

test('R3 RED: shared children ACL, filtering, page cursor, and REST invalid parent are behaviorally enforced', async () => {
  const parent = task(PARENT, A, B); const visible = task(CHILD, A, B, 'submitted', PARENT); const hidden = task(HIDDEN, C, B, 'submitted', PARENT);
  core.setTaskListAllForTests(async () => [parent, hidden, visible]);
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A })).resolves.toMatchObject({ children: [visible], nextCursor: null });
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: C })).rejects.toThrow('forbidden');
  await expect(core.listTaskChildren({ parentTaskId: '61d1105a-4fbd-4e19-b682-754c3ef0f1bc', limit: 20 }, { kind: 'identity', address: A })).rejects.toThrow('not_found');
  let creates = 0; const service = { ...tasks.taskService, create: async () => { creates += 1; return visible; }, list: async () => [parent, hidden, visible] } as TaskService;
  const v7 = '018f8d1d-4d7e-7b0a-8000-000000000000';
  const response = await app(service).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: B, subject: 'x', body: 'x', parentTaskId: v7 }) });
  expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request', details: [{ code: 'custom', path: ['parentTaskId'], message: 'Invalid input' }] }); expect(creates).toBe(0);
});

test('R3 children default page is 20 and continuation is deterministic', async () => {
  const parent = task(PARENT, A, B); const rows = Array.from({ length: 22 }, (_, i) => task(`10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT));
  core.setTaskListAllForTests(async () => [parent, ...rows]);
  const first = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A });
  expect(first.children).toHaveLength(20); expect(first.nextCursor).toBeString(); expect(first.children.map((row) => row.id)).toEqual(rows.slice(2).reverse().map((row) => row.id));
  const second = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor: first.nextCursor! }, { kind: 'identity', address: A });
  expect(second.children).toHaveLength(2); expect(second.nextCursor).toBeNull(); expect(new Set([...first.children, ...second.children].map((row) => row.id)).size).toBe(22);
});

test('R3 children cursor is bound to parent viewer and limit and rejects tampering', async () => {
  const parent = task(PARENT, A, B); const rows = Array.from({ length: 21 }, (_, i) => task(`20000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT));
  core.setTaskListAllForTests(async () => [parent, ...rows]);
  const page = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A }); const cursor = page.nextCursor!;
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 50, cursor }, { kind: 'identity', address: A })).rejects.toThrow('invalid_cursor');
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor: `${cursor}x` }, { kind: 'identity', address: A })).rejects.toThrow('invalid_cursor');
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor }, { kind: 'admin' })).rejects.toThrow('invalid_cursor');
  const otherParent = task('40000000-0000-4000-8000-000000000001', A, B); core.setTaskListAllForTests(async () => [parent, otherParent, ...rows]);
  await expect(core.listTaskChildren({ parentTaskId: otherParent.id, limit: 20, cursor }, { kind: 'identity', address: A })).rejects.toThrow('invalid_cursor');
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor }, { kind: 'identity', address: B })).rejects.toThrow('invalid_cursor');
  const parts = cursor.split('.'); const body = parts[1]!; parts[1] = `${body.slice(0, -1)}${body.endsWith('A') ? 'B' : 'A'}`;
  await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor: parts.join('.') }, { kind: 'identity', address: A })).rejects.toThrow('invalid_cursor');
});

test('R5a: children cursor rejects every noncanonical body representation with the original MAC', async () => {
  const parent = task(PARENT, A, B);
  const rows = Array.from({ length: 21 }, (_, i) => task(`21000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT));
  core.setTaskListAllForTests(async () => [parent, ...rows]);
  const cursor = (await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A })).nextCursor!;
  const [prefix, body, mac] = cursor.split('.') as [string, string, string];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { fp: string; t: number; id: string };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const variants = [
    `${body}=`,
    encode({ id: payload.id, t: payload.t, fp: payload.fp }),
    encode({ fp: payload.fp, t: payload.t, id: payload.id, extra: 'non-empty' }),
    Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64url'),
  ];
  for (const variant of variants) {
    await expect(core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor: `${prefix}.${variant}.${mac}` }, { kind: 'identity', address: A })).rejects.toThrow('invalid_cursor');
  }
});

test('R3 direct children omit descendants and hidden rows before page fill', async () => {
  const parent = task(PARENT, A, B); const visible = task(CHILD, A, B, 'submitted', PARENT); const descendant = task(HIDDEN, A, B, 'submitted', CHILD); const hidden = task('30000000-0000-4000-8000-000000000001', C, C, 'submitted', PARENT);
  core.setTaskListAllForTests(async () => [parent, visible, descendant, hidden]);
  const page = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A });
  expect(page.children).toEqual([visible]); expect(page.nextCursor).toBeNull(); expect(JSON.stringify(page)).not.toContain(HIDDEN);
});

test('R3 core children exercises 50 100 empty and hidden cursor invariance', async () => {
  const parent = task(PARENT, A, B); const rows = Array.from({ length: 101 }, (_, i) => task(`50000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT));
  core.setTaskListAllForTests(async () => [parent, ...rows]);
  const fifty = await core.listTaskChildren({ parentTaskId: PARENT, limit: 50 }, { kind: 'identity', address: A }); const hundred = await core.listTaskChildren({ parentTaskId: PARENT, limit: 100 }, { kind: 'identity', address: A });
  expect(fifty.children).toHaveLength(50); expect(fifty.nextCursor).toBeString(); expect(hundred.children).toHaveLength(100); expect(hundred.nextCursor).toBeString();
  const hidden = task('60000000-0000-4000-8000-000000000001', C, C, 'submitted', PARENT); core.setTaskListAllForTests(async () => [parent, hidden, ...rows]);
  const withHidden = await core.listTaskChildren({ parentTaskId: PARENT, limit: 50 }, { kind: 'identity', address: A }); expect(withHidden.children.map((row) => row.id)).toEqual(fifty.children.map((row) => row.id)); expect(withHidden.nextCursor).toBe(fifty.nextCursor);
  core.setTaskListAllForTests(async () => [parent]); const empty = await core.listTaskChildren({ parentTaskId: PARENT, limit: 100 }, { kind: 'identity', address: A }); expect(empty.children).toEqual([]); expect(empty.nextCursor).toBeNull(); expect((empty as any).total).toBeUndefined();
});

test('R3 REST ordinary create derives identity sender and reads its parent for projection', async () => {
  const parent = task(PARENT, A, B); let input: any; const reads: string[] = [];
  const child = task(CHILD, A, B, 'submitted', PARENT);
  const service = { ...tasks.taskService, create: async (value: any) => { input = value; return child; }, getForAuthorization: async (id: string) => { reads.push(id); return id === PARENT ? parent : child; } } as TaskService;
  const res = await app(service).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: B, subject: 'x', body: 'b', parentTaskId: PARENT }) });
  expect(res.status).toBe(201); expect(input).toMatchObject({ from: A, to: B, parentTaskId: PARENT }); expect(reads).toEqual([PARENT]); expect((await res.json() as any).parentTaskId).toBe(PARENT);
});

test('R3 REST approval create retains action body expiry and parent', async () => {
  const parent = task(PARENT, A, B); let input: any; const reads: string[] = []; const child = { ...task(CHILD, A, B, 'input-required', PARENT), kind: 'approval' as const, approval: { action: { type: 'x', name: 'n', arguments: {} }, reviewer: B, expiresAt: '2026-09-01T00:00:00.000Z', digest: 'd' } };
  const service = { ...tasks.taskService, createApproval: async (value: any) => { input = value; return child; }, getForAuthorization: async (id: string) => { reads.push(id); return id === PARENT ? parent : child; } } as TaskService;
  const res = await app(service).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: B, subject: 'x', body: 'b', kind: 'approval', parentTaskId: PARENT, approval: { action: { type: 'x', name: 'n', arguments: {} }, expiresAt: '2026-09-01T00:00:00.000Z' } }) });
  expect(res.status).toBe(201); expect(input.parentTaskId).toBe(PARENT); expect(input.action).toEqual({ type: 'x', name: 'n', arguments: {} }); expect(input.expiresAt).toBe('2026-09-01T00:00:00.000Z'); expect(input.body).toBe('b'); expect(reads).toEqual([PARENT]);
});

test('R3 create projection edge depends on the parent authorization read for ordinary and approval', async () => {
  const parent = task(PARENT, A, B); const ordinary = task(CHILD, A, B, 'submitted', PARENT); const approval = { ...task(CHILD, A, B, 'input-required', PARENT), kind: 'approval' as const, approval: { action: { type: 'x', name: 'n', arguments: {} }, reviewer: B, expiresAt: '2026-09-01T00:00:00.000Z', digest: 'd' } };
  for (const [kind, parentRead] of [['ordinary', parent], ['ordinary', null], ['approval', parent], ['approval', null]] as const) {
    const reads: string[] = []; let ordinaryInput: any; let approvalInput: any;
    const service = { ...tasks.taskService, create: async (input: any) => { ordinaryInput = input; return ordinary; }, createApproval: async (input: any) => { approvalInput = input; return approval; }, getForAuthorization: async (id: string) => { reads.push(id); return id === PARENT ? parentRead : ordinary; } } as TaskService;
    const body = kind === 'ordinary' ? { to: B, subject: 'x', body: 'b', parentTaskId: PARENT } : { to: B, subject: 'x', body: 'b', kind: 'approval', parentTaskId: PARENT, approval: { action: { type: 'x', name: 'n', arguments: {} }, expiresAt: '2026-09-01T00:00:00.000Z' } };
    const res = await app(service).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(201); expect(reads).toEqual([PARENT]); expect((await res.json() as any).parentTaskId).toBe(parentRead ? PARENT : undefined);
    if (kind === 'ordinary') expect(ordinaryInput).toMatchObject({ from: A, to: B, parentTaskId: PARENT, body: 'b' });
    else { expect(approvalInput).toMatchObject({ from: A, to: B, parentTaskId: PARENT, body: 'b', action: { type: 'x', name: 'n', arguments: {} }, expiresAt: '2026-09-01T00:00:00.000Z' }); }
  }
});

test('R5e create remains successful when the post-delivery parent projection read fails', async () => {
  const child = task(CHILD, A, B, 'submitted', PARENT);
  let creates = 0;
  const service = {
    ...tasks.taskService,
    create: async () => { creates += 1; return child; },
    getForAuthorization: async () => { throw new Error('transient_imap_failure'); },
  } as TaskService;
  const res = await app(service).request('/v1/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: B, subject: 'x', body: 'b', parentTaskId: PARENT }),
  });
  expect(res.status).toBe(201);
  expect(creates).toBe(1);
  expect(await res.json()).not.toHaveProperty('parentTaskId');
});

test('R3 core mixed updatedAt/id ordering continues exactly across the 20-row boundary', async () => {
  const parent = task(PARENT, A, B);
  const timestamps = [
    ...Array(7).fill('2026-08-04T00:00:00.000Z'),
    ...Array(7).fill('2026-08-03T00:00:00.000Z'),
    ...Array(8).fill('2026-08-02T00:00:00.000Z'),
    ...Array(3).fill('2026-08-01T00:00:00.000Z'),
  ];
  const rows = timestamps.map((updatedAt, index) => ({ ...task(`80000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT), updatedAt }));
  const expected = [...rows].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  core.setTaskListAllForTests(async () => [parent, ...rows]);
  const first = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A });
  const second = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20, cursor: first.nextCursor! }, { kind: 'identity', address: A });
  expect(first.children.map((row) => row.id)).toEqual(expected.slice(0, 20).map((row) => row.id)); expect(first.children.at(-1)?.updatedAt).toBe('2026-08-02T00:00:00.000Z'); expect(first.nextCursor).toBeString();
  expect(second.children.map((row) => row.id)).toEqual(expected.slice(20).map((row) => row.id)); expect(second.children[0]?.updatedAt).toBe('2026-08-02T00:00:00.000Z'); expect(second.nextCursor).toBeNull();
  const combined = [...first.children, ...second.children].map((row) => row.id); expect(combined).toEqual(expected.map((row) => row.id)); expect(new Set(combined).size).toBe(expected.length);
});

test('R3 REST create maps core errors without sending service output', async () => {
  for (const [code, status] of [['parent_task_not_found', 404], ['parent_task_sender_not_participant', 403], ['parent_task_invalid_chain', 409]] as const) {
    let calls = 0; const service = { ...tasks.taskService, create: async () => { calls += 1; throw new Error(code); } } as TaskService;
    const res = await app(service).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: B, subject: 'x', body: 'b', parentTaskId: PARENT }) });
    expect(res.status).toBe(status); expect(calls).toBe(1);
  }
});

test('R3 REST get omits hidden parent edge and emits it for admin', async () => {
  const parent = task(PARENT, C, C); const child = task(CHILD, A, B, 'submitted', PARENT);
  const service = { ...tasks.taskService, get: async () => child, getForAuthorization: async (id: string) => id === PARENT ? parent : child } as TaskService;
  const identity = await app(service).request(`/v1/tasks/${CHILD}`); expect(identity.status).toBe(200); expect((await identity.json() as any).parentTaskId).toBeUndefined();
  const adminApp = new Hono(); adminApp.use('*', async (c, next) => { c.set('auth', { kind: 'admin' }); await next(); }); adminApp.route('/v1/tasks', createTaskRoutes({ service, findIdentity: () => undefined }));
  const admin = await adminApp.request(`/v1/tasks/${CHILD}`); expect(admin.status).toBe(200); expect((await admin.json() as any).parentTaskId).toBe(PARENT);
});

test('R3 REST get emits a readable parent edge and silently omits unavailable parent', async () => {
  const parent = task(PARENT, A, B); const child = task(CHILD, A, B, 'submitted', PARENT);
  const readable = { ...tasks.taskService, get: async () => child, getForAuthorization: async (id: string) => id === PARENT ? parent : child } as TaskService;
  const first = await app(readable).request(`/v1/tasks/${CHILD}`); expect(first.status).toBe(200); expect((await first.json() as any).parentTaskId).toBe(PARENT);
  const unavailable = { ...readable, getForAuthorization: async (id: string) => id === CHILD ? child : null } as TaskService;
  const second = await app(unavailable).request(`/v1/tasks/${CHILD}`); expect(second.status).toBe(200); expect((await second.json() as any).parentTaskId).toBeUndefined();
});

test('R3 REST children maps unknown unreadable invalid limit and returns no totals', async () => {
  const parent = task(PARENT, A, B); const child = { ...task(CHILD, A, B, 'submitted', PARENT), descendantIds: ['descendant-sentinel'], childCount: 73, aggregate: { internalRelationship: 'aggregate-sentinel' }, internalRootPointer: 'root-sentinel' } as Task;
  const service = { ...tasks.taskService, getForAuthorization: async (id: string) => id === PARENT ? parent : id === CHILD ? child : null, listChildren: async () => ({ children: [child], nextCursor: null }) } as TaskService;
  const ok = await app(service).request(`/v1/tasks/${PARENT}/children`); expect(ok.status).toBe(200); const body = await ok.json() as any; expect(body).toEqual({ children: [{ ...tasks.toTaskView(child), parentTaskId: PARENT }], nextCursor: null }); expect(Object.keys(body).sort()).toEqual(['children', 'nextCursor']); expect(JSON.stringify(body)).not.toContain('descendant-sentinel'); expect(JSON.stringify(body)).not.toContain('aggregate-sentinel'); expect(JSON.stringify(body)).not.toContain('root-sentinel'); expect(JSON.stringify(body)).not.toMatch(/total|count/i);
  expect((await app(service).request(`/v1/tasks/${PARENT}/children?limit=21`)).status).toBe(400); expect((await app(service).request(`/v1/tasks/61d1105a-4fbd-4e19-b682-754c3ef0f1bc/children`)).status).toBe(404);
});

test('R5e REST children preserves bounded errors from the authoritative list snapshot', async () => {
  const parent = task(PARENT, A, B);
  for (const [code, status, error] of [
    ['not_found', 404, 'not_found'],
    ['forbidden', 403, 'forbidden: task participant required'],
  ] as const) {
    const service = {
      ...tasks.taskService,
      getForAuthorization: async () => parent,
      listChildren: async () => { throw new Error(code); },
    } as TaskService;
    const res = await app(service).request(`/v1/tasks/${PARENT}/children`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  }
});

test('R3 REST children enforces unreadable 403 and forwards exact 20/50/100/default pagination inputs', async () => {
  const parent = task(PARENT, A, B); const child = task(CHILD, A, B, 'submitted', PARENT); const seen: unknown[] = [];
  const service = { ...tasks.taskService, getForAuthorization: async () => parent, listChildren: async (query: unknown) => { seen.push(query); return { children: [child], nextCursor: null }; } } as TaskService;
  for (const suffix of ['', '?limit=20', '?limit=50', '?limit=100']) expect((await app(service).request(`/v1/tasks/${PARENT}/children${suffix}`)).status).toBe(200);
  expect(seen).toEqual([{ parentTaskId: PARENT, limit: 20 }, { parentTaskId: PARENT, limit: 20 }, { parentTaskId: PARENT, limit: 50 }, { parentTaskId: PARENT, limit: 100 }]);
  expect((await app(service, C).request(`/v1/tasks/${PARENT}/children`)).status).toBe(403);
});

test('R3 REST list silently omits hidden parent but admin list emits the same edge', async () => {
  const parent = task(PARENT, C, C); const child = task(CHILD, A, B, 'submitted', PARENT); const service = { ...tasks.taskService, list: async () => [parent, child] } as TaskService;
  const identity = await app(service).request('/v1/tasks'); expect((await identity.json() as any).tasks[0].parentTaskId).toBeUndefined();
  const adminApp = new Hono(); adminApp.use('*', async (c, next) => { c.set('auth', { kind: 'admin' }); await next(); }); adminApp.route('/v1/tasks', createTaskRoutes({ service, findIdentity: () => undefined }));
  const admin = await adminApp.request('/v1/tasks'); const body = await admin.json() as any; expect(body.tasks.find((row: any) => row.id === CHILD).parentTaskId).toBe(PARENT); expect(body.tasks).toHaveLength(2);
});

test('R3 REST list omits unavailable parent in both unfiltered and state-filtered snapshots', async () => {
  const child = task(CHILD, A, B, 'submitted', PARENT); let calls = 0;
  const service = { ...tasks.taskService, list: async () => { calls += 1; return [child]; } } as TaskService;
  for (const suffix of ['', '?state=submitted']) { const res = await app(service).request(`/v1/tasks${suffix}`); expect(res.status).toBe(200); expect((await res.json() as any).tasks[0].parentTaskId).toBeUndefined(); }
  expect(calls).toBe(2);
});

test('R3 filter-before-page fills visible page despite interleaved hidden children', async () => {
  const parent = task(PARENT, A, B); const visible = Array.from({ length: 21 }, (_, i) => task(`70000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, A, B, 'submitted', PARENT));
  const hidden = Array.from({ length: 25 }, (_, i) => task(`71000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`, C, C, 'submitted', PARENT));
  core.setTaskListAllForTests(async () => [parent, ...visible.flatMap((row, i) => [hidden[i]!, row]), ...hidden.slice(21)]);
  const page = await core.listTaskChildren({ parentTaskId: PARENT, limit: 20 }, { kind: 'identity', address: A });
  expect(page.children).toHaveLength(20); expect(page.nextCursor).toBeString(); expect(page.children.every((row) => row.from === A)).toBe(true);
});
