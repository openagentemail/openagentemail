// #56 R1 RED boundary. These tests exercise the real task routes with the
// existing injectable TaskService seam; no lease behavior is implemented here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-leases-red-'));

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { setTaskNowForTests } = await import('../src/lib/tasks.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'alpha@test.example';
const RECIPIENT = 'bravo@test.example';
const OUTSIDER = 'charlie@test.example';
const LEASE_TOKEN = 'opaque-lease-secret-that-must-not-project';

type LeaseMetadata = {
  claimedUntil?: string;
  leaseGeneration?: number;
  leaseToken?: string;
};

function task(overrides: Partial<Task & LeaseMetadata> = {}): Task & LeaseMetadata {
  return {
    id: ID,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'Claim the release task',
    state: 'submitted',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [{
      id: '1', from: REQUESTER, to: RECIPIENT, subject: 'Claim the release task',
      date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim this.',
    }],
    ...overrides,
  };
}

let current = task();
const calls: Array<{ operation: string; input?: unknown }> = [];
let claimed = false;
let widerClaim = false;
const leaseCalls: Array<{ operation: 'renew' | 'release'; input: unknown }> = [];

const service: TaskService = {
  async create() { throw new Error('unused'); },
  async list() { return [current]; },
  async listBoard() { throw new Error('unused'); },
  async get(id) { return id === ID ? current : null; },
  async update(input) {
    calls.push({ operation: 'update', input });
    current = task({ state: input.state });
    return current;
  },
  async claim(input) {
    calls.push({ operation: 'claim', input });
    if (claimed) throw new Error('lease_already_claimed');
    claimed = true;
    current = task({
      state: 'working',
      lease: {
        claimedUntil: '2026-08-24T00:02:00.000Z',
        leaseGeneration: 1,
        tokenVerifier: 'test-only-verifier-which-is-never-projected-000',
      },
    });
    const grant = {
      task: current,
      leaseToken: LEASE_TOKEN,
      claimedUntil: '2026-08-24T00:02:00.000Z',
      leaseGeneration: 1,
    };
    return widerClaim
      ? ({ ...grant, verifier: 'private-verifier', stamp: 'private-stamp', lease: { tokenVerifier: 'private-verifier' }, task: { ...grant.task, tokenVerifier: 'private-verifier', stamp: 'private-stamp' } } as typeof grant)
      : grant;
  },
  async reply() { throw new Error('unused'); },
  async remind() { throw new Error('unused'); },
  async close() { throw new Error('unused'); },
  async waitForTerminal() { return current; },
};

type LeaseCapableService = TaskService & {
  renew(input: { id: string; from: string; leaseToken: string; leaseSec?: number }): Promise<Task>;
  release(input: { id: string; from: string; leaseToken: string; reason?: string }): Promise<Task>;
};

// Test-only structural extension: records the selected operation and returns
// the closed task view. No lease behavior is implemented here.
const capableService = {
  ...service,
  async renew(input: { id: string; from: string; leaseToken: string; leaseSec?: number }) {
    leaseCalls.push({ operation: 'renew', input });
    return task({ state: 'working', leaseToken: undefined });
  },
  async release(input: { id: string; from: string; leaseToken: string; reason?: string }) {
    leaseCalls.push({ operation: 'release', input });
    return task({ state: 'working', leaseToken: undefined });
  },
} as LeaseCapableService;

function appFor(address: string, leaseEnabledForTests = true, selectedService: TaskService = capableService) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { kind: 'identity' as const, address });
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service: selectedService,
    findIdentity: (candidate) => [REQUESTER, RECIPIENT, OUTSIDER].includes(candidate.toLowerCase())
      ? { address: candidate, createdAt: '2026-08-24T00:00:00.000Z' }
      : undefined,
    leaseEnabledForTests,
  }));
  return app;
}

beforeEach(() => {
  setTaskNowForTests(() => Date.parse('2026-08-24T00:01:59.999Z'));
  current = task();
  calls.length = 0;
  claimed = false;
  widerClaim = false;
  leaseCalls.length = 0;
});

afterEach(() => {
  setTaskNowForTests(null);
});

describe('#56 lease contract RED', () => {
  test('claim is recipient-only and two concurrent claims yield one grant and one conflict', async () => {
    const outsider = await appFor(OUTSIDER).request(`/v1/tasks/${ID}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 120 }),
    });
    expect(outsider.status).toBe(403);

    const recipient = appFor(RECIPIENT);
    const claims = await Promise.all([
      recipient.request(`/v1/tasks/${ID}/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 120 }),
      }),
      recipient.request(`/v1/tasks/${ID}/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 120 }),
      }),
    ]);
    expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = claims.find((response) => response.status === 200)!;
    expect(await winner.json()).toMatchObject({
      leaseToken: expect.any(String),
      claimedUntil: expect.any(String),
      leaseGeneration: 1,
      task: { id: ID, state: 'working', claimedUntil: expect.any(String), leaseGeneration: 1 },
    });
  });

  test('state accepts an optional leaseToken but preserves the disabled-by-default compatibility path', async () => {
    const response = await appFor(RECIPIENT, false).request(`/v1/tasks/${ID}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'working', leaseToken: LEASE_TOKEN }),
    });
    expect(response.status).toBe(200);
    expect(calls).toContainEqual({
      operation: 'update',
      input: { id: ID, from: RECIPIENT, state: 'working', leaseToken: LEASE_TOKEN },
    });
  });

  test('list and detail may project lease timing and generation but never the lease secret', async () => {
    current = task({
      state: 'working',
      claimedUntil: '2026-08-24T00:02:00.000Z',
      leaseGeneration: 1,
      leaseToken: LEASE_TOKEN,
      lease: {
        claimedUntil: '2026-08-24T00:02:00.000Z',
        leaseGeneration: 1,
        tokenVerifier: 'test-only-verifier-which-is-never-projected-000',
      },
    });
    const app = appFor(RECIPIENT);
    const [list, detail] = await Promise.all([
      app.request('/v1/tasks'),
      app.request(`/v1/tasks/${ID}`),
    ]);
    for (const response of [list, detail]) {
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      const projected = Array.isArray(body.tasks) ? body.tasks[0] : body;
      expect(projected).toMatchObject({ claimedUntil: '2026-08-24T00:02:00.000Z', leaseGeneration: 1 });
      expect(JSON.stringify(projected)).not.toContain(LEASE_TOKEN);
      expect((projected as Record<string, unknown>).leaseToken).toBeUndefined();
    }
  });

  test('claim response is a closed projection even when the selected service result is wider', async () => {
    widerClaim = true;
    const response = await appFor(RECIPIENT).request(`/v1/tasks/${ID}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 120 }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['claimedUntil', 'leaseGeneration', 'leaseToken', 'task']);
    expect(body.verifier).toBeUndefined();
    expect(body.stamp).toBeUndefined();
    expect(body.lease).toBeUndefined();
    expect((body.task as Record<string, unknown>).tokenVerifier).toBeUndefined();
    expect((body.task as Record<string, unknown>).stamp).toBeUndefined();
  });
});

// R4c is opt-in so frozen default counts remain exact. Every case is a
// separately reported executable entry contract; current 404s are observed
// RED mismatches, never substitutes for the expected boundary assertion.
if (process.env.TASK_LEASES_R4_RED === '1') {
  describe('#56 R4c route-entry matrix RED', () => {
    const cases = [
      ['disabled renew', 'lease', false, { leaseToken: LEASE_TOKEN, leaseSec: 300 }, 409],
      ['disabled release', 'release', false, { leaseToken: LEASE_TOKEN, reason: 'done' }, 409],
      ['requester renew ACL', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 300 }, 403],
      ['outsider renew ACL', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 300 }, 403],
      ['requester release ACL', 'release', true, { leaseToken: LEASE_TOKEN }, 403],
      ['outsider release ACL', 'release', true, { leaseToken: LEASE_TOKEN }, 403],
      ['renew malformed UUID', 'lease', true, { leaseToken: LEASE_TOKEN }, 400],
      ['release malformed UUID', 'release', true, { leaseToken: LEASE_TOKEN }, 400],
      ['renew malformed JSON', 'lease', true, null, 400],
      ['release malformed JSON', 'release', true, null, 400],
      ['renew missing token', 'lease', true, { leaseSec: 300 }, 400],
      ['renew empty token', 'lease', true, { leaseToken: '', leaseSec: 300 }, 400],
      ['release missing token', 'release', true, {}, 400],
      ['release empty token', 'release', true, { leaseToken: '' }, 400],
      ['renew leaseSec 29', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 29 }, 400],
      ['renew leaseSec 3601', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 3601 }, 400],
      ['renew leaseSec 30.5', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 30.5 }, 400],
      ['missing selected renew capability fails closed', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 300 }, 503],
      ['missing selected release capability fails closed', 'release', true, { leaseToken: LEASE_TOKEN }, 503],
      ['valid recipient renew maps one selected call', 'lease', true, { leaseToken: LEASE_TOKEN, leaseSec: 300 }, 200],
      ['valid recipient release reason maps one selected call', 'release', true, { leaseToken: LEASE_TOKEN, reason: 'ordinary reason' }, 200],
    ] as const;

    test.each(cases)('%s', async (name, operation, enabled, body, expected) => {
      const actor = name.includes('outsider') ? OUTSIDER : name.includes('requester') ? REQUESTER : RECIPIENT;
      const taskId = name.includes('malformed UUID') ? 'not-a-uuid' : ID;
      const selected = name.includes('missing selected') ? service : capableService;
      const response = await appFor(actor, enabled, selected).request(`/v1/tasks/${taskId}/${operation}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: body === null ? '{' : JSON.stringify(body),
      });
      const selectedCalls = leaseCalls.filter((call) => call.operation === (operation === 'lease' ? 'renew' : 'release')).length;
      expect({ status: response.status, selectedCalls }).toEqual({ status: expected, selectedCalls: expected === 200 ? 1 : 0 });
    });
  });
}
