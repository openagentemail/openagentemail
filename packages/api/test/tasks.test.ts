// Task route policy is tested with an in-memory IMAP view. The task library
// itself remains mailbox-backed; this seam keeps ACL and rate-limit failures
// deterministic without needing a mail server in unit tests.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawTaskMessage, Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-tasks-'));

const { beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { checkSendLimit, resetRateLimits, resetWaitSlots, MAX_WAITS_PER_ADDRESS } = await import('../src/lib/ratelimit.ts');
const { canAdvanceTask, currentTaskMessage, taskFromMessages, waitForTaskTerminalWith } = await import('../src/lib/tasks.ts');
const { knownManagedIdentity } = await import('../src/lib/tasks-internal.ts');
const { config } = await import('../src/lib/config.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const C = 'charlie@test.example';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: ID,
    from: A,
    to: B,
    subject: 'Check the release',
    state: 'submitted',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    messages: [{
      id: '1', from: A, to: B, subject: 'Check the release',
      date: '2026-08-04T00:00:00.000Z', state: 'submitted', body: 'Please check it.',
    }],
    ...overrides,
  };
}

let current = task();
const calls: Array<{ operation: string; input?: unknown }> = [];

const service: TaskService = {
  async create(input) {
    calls.push({ operation: 'create', input });
    current = task({ from: input.from, to: input.to, subject: input.subject, messages: [{
      id: 'queued', from: input.from, to: input.to, subject: input.subject,
      date: '2026-08-04T00:00:00.000Z', state: 'submitted', body: input.body,
    }] });
    return current;
  },
  async list(state) {
    calls.push({ operation: 'list', input: state });
    return state && current.state !== state ? [] : [current, task({ id: '61d1105a-4fbd-4e19-b682-754c3ef0f1bc', from: C, to: B })];
  },
  async listBoard() {
    calls.push({ operation: 'listBoard' });
    return { tasks: [], nextCursor: null, totalApprox: 0, queryNow: '2026-08-12T00:00:00.000Z' };
  },
  async reply(input) {
    calls.push({ operation: 'reply', input });
    return current;
  },
  async remind(input) {
    calls.push({ operation: 'remind', input });
    return current;
  },
  async close(input) {
    calls.push({ operation: 'close', input });
    return current;
  },
  async get(id) {
    calls.push({ operation: 'get', input: id });
    return id === current.id ? current : null;
  },
  async update(input) {
    calls.push({ operation: 'update', input });
    current = { ...current, state: input.state };
    return current;
  },
  async waitForTerminal() {
    calls.push({ operation: 'wait' });
    return current;
  },
};

function appFor(
  auth: { kind: 'admin' } | { kind: 'identity'; address: string },
  taskService: TaskService = service,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service: taskService,
    findIdentity: (address) => [A, B, C].includes(address.toLowerCase())
      ? { address, createdAt: '2026-08-04T00:00:00.000Z' }
      : undefined,
  }));
  return app;
}

beforeEach(() => {
  current = task();
  calls.length = 0;
  resetRateLimits();
  resetWaitSlots();
});

describe('task route ACL and state machine', () => {
  test('scoped sender creates a task without choosing a from address', async () => {
    const response = await appFor({ kind: 'identity', address: A }).request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'Check the release', body: 'Please check it.' }),
    });

    expect(response.status).toBe(201);
    expect(calls).toContainEqual({ operation: 'create', input: {
      from: A, to: B, subject: 'Check the release', body: 'Please check it.',
    } });
  });

  test('a non-participant cannot advance a guessed task id', async () => {
    const response = await appFor({ kind: 'identity', address: C }).request(`/v1/tasks/${ID}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'completed', result: { leaked: true } }),
    });

    expect(response.status).toBe(403);
    expect(calls.some((call) => call.operation === 'update')).toBe(false);
  });

  test('identity task lists are scoped to their own threads', async () => {
    const response = await appFor({ kind: 'identity', address: A }).request('/v1/tasks');
    const body = await response.json() as { tasks: Task[] };
    expect(response.status).toBe(200);
    expect(body.tasks.map((entry) => entry.id)).toEqual([ID]);
  });

  test('terminal states cannot be reopened; non-terminal writes remain last-writer-wins', () => {
    expect(canAdvanceTask('submitted')).toBe(true);
    expect(canAdvanceTask('working')).toBe(true);
    expect(canAdvanceTask('input-required')).toBe(true);
    expect(canAdvanceTask('completed')).toBe(false);
    expect(canAdvanceTask('failed')).toBe(false);
  });

  test('a replayed pre-terminal task email cannot reopen or replace a terminal result', () => {
    const terminal = currentTaskMessage([
      { uid: 1, state: 'submitted' as const, result: { stale: true } },
      { uid: 2, state: 'completed' as const, result: { ok: true } },
      // Same valid historical submitted mail delivered again after completion.
      { uid: 3, state: 'submitted' as const, result: { stale: true } },
    ]);
    expect(terminal.state).toBe('completed');
    expect(terminal.result).toEqual({ ok: true });

    const nonTerminal = currentTaskMessage([
      { uid: 1, state: 'submitted' as const },
      { uid: 2, state: 'working' as const },
    ]);
    expect(nonTerminal.state).toBe('working');
  });

  test('signed historical threads remain visible after either participant is deleted', () => {
    const archived: RawTaskMessage[] = [
      { uid: 1, from: A, to: B, subject: 'Archive', date: '2026-08-04T00:00:00.000Z', state: 'submitted', body: 'Durable.' },
      { uid: 2, from: B, to: A, subject: 'Archive', date: '2026-08-04T00:01:00.000Z', state: 'completed', body: 'Done.', result: { ok: true } },
    ];
    // taskFromMessages intentionally has no identity-store lookup: the
    // server stamp is provenance, while route ACL handles live callers.
    expect(taskFromMessages(ID, archived)).toMatchObject({ state: 'completed', result: { ok: true } });
  });

  test('task create is not blocked by the ordinary email send budget', async () => {
    expect(checkSendLimit(A, 1).allowed).toBe(true);
    expect(checkSendLimit(A, 1).allowed).toBe(false);

    const response = await appFor({ kind: 'identity', address: A }).request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: B, subject: 'Internal task', body: 'This is exempt.' }),
    });
    expect(response.status).toBe(201);
  });

  test('task waits share the normal IMAP connection ceiling', async () => {
    let release!: (value: Task) => void;
    const held = new Promise<Task>((resolve) => { release = resolve; });
    const slow: TaskService = { ...service, waitForTerminal: async () => held };
    const wait = () => appFor({ kind: 'identity', address: A }, slow)
      .request(`/v1/tasks/${ID}?wait=true`);

    const pending = Array.from({ length: MAX_WAITS_PER_ADDRESS }, wait);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blocked = await wait();
    expect(blocked.status).toBe(429);

    release(current);
    expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
  });

  test('wait rechecks the whole task thread when a terminal reply went to the other participant', async () => {
    let reads = 0;
    const waited = await waitForTaskTerminalWith(ID, A, 5, {
      getTask: async () => {
        reads += 1;
        return reads === 1 ? task() : task({ state: 'completed', result: { ok: true } });
      },
      // A's own mailbox has no terminal mail because A sent the terminal
      // response to B. The global thread poll must still finish promptly.
      waitForMessage: async () => null,
    });
    expect(waited).toMatchObject({ state: 'completed', result: { ok: true } });
    expect(reads).toBe(2);
  });
});

describe('multi-domain task routing and known managed identity', () => {
  test('knownManagedIdentity accepts identities across all configured domains', () => {
    (config.allDomains as Set<string>).add('secondary.example');
    try {
      const mockFind = (addr: string) =>
        ['alpha@test.example', 'sec@secondary.example'].includes(addr.toLowerCase())
          ? ({ address: addr } as any)
          : undefined;

      expect(knownManagedIdentity('alpha@test.example', mockFind)).toBe(true);
      expect(knownManagedIdentity('sec@secondary.example', mockFind)).toBe(true);
      expect(knownManagedIdentity('ext@outside.example', mockFind)).toBe(false);
      expect(knownManagedIdentity('ghost@secondary.example', mockFind)).toBe(false);
    } finally {
      (config.allDomains as Set<string>).delete('secondary.example');
    }
  });

  test('task creation works across different configured domains and rejects unconfigured domains', async () => {
    (config.allDomains as Set<string>).add('secondary.example');
    try {
      const SEC = 'agent@secondary.example';
      const multiApp = new Hono();
      multiApp.use('*', async (c, next) => {
        c.set('auth', { kind: 'identity', address: A });
        await next();
      });
      multiApp.route(
        '/v1/tasks',
        createTaskRoutes({
          service,
          findIdentity: (address) =>
            [A, B, C, SEC].includes(address.toLowerCase())
              ? { address, createdAt: '2026-08-04T00:00:00.000Z' }
              : undefined,
        }),
      );

      // Create task from primary domain (A) to secondary domain (SEC)
      const res = await multiApp.request('/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: SEC, subject: 'Cross-domain job', body: 'Please run this' }),
      });
      expect(res.status).toBe(201);
      expect(calls).toContainEqual({
        operation: 'create',
        input: { from: A, to: SEC, subject: 'Cross-domain job', body: 'Please run this' },
      });

      // Target to unconfigured domain is rejected
      const resBad = await multiApp.request('/v1/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'user@unconfigured.example', subject: 'Outside', body: 'hello' }),
      });
      expect(resBad.status).toBe(403);
      const dataBad = (await resBad.json()) as any;
      expect(dataBad.error).toBe('forbidden: task participants must be known identities');
    } finally {
      (config.allDomains as Set<string>).delete('secondary.example');
    }
  });
});

