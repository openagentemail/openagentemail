import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-lease-route-contract-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test } = await import('bun:test');
const {
  claimTask,
  releaseTask,
  renewTask,
  taskFromMessages,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const { withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'alpha@test.example';
const RECIPIENT = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedTask(): Task {
  return taskFromMessages(ID, [{
    uid: 1, from: REQUESTER, to: RECIPIENT, subject: 'Lease contract',
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  }])!;
}

function unusedService(): TaskService {
  return {
    async create() { throw new Error('unused'); },
    async list() { return []; },
    async listBoard() { throw new Error('unused'); },
    async get() { return submittedTask(); },
    async update() { throw new Error('unused'); },
    async reply() { throw new Error('unused'); },
    async remind() { throw new Error('unused'); },
    async close() { throw new Error('unused'); },
    async waitForTerminal() { return null; },
  };
}

function appFor(auth: { kind: 'admin' } | { kind: 'identity'; address: string }, service: TaskService) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => ({ address, createdAt: '2026-08-24T00:00:00.000Z' }),
  }));
  return app;
}

async function post(
  app: Hono,
  path: 'claim' | 'lease' | 'release',
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(`/v1/tasks/${ID}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#83 lease 路由/core 契约', () => {
  test('路由源码不再映射 core 不会发出的 lease_already_released', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/routes/tasks.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/code === 'lease_already_released'/);
  });

  test('admin 凭证不能直接 claim/renew/release，须 managed recipient identity', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, unusedService());
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const renew = await post(app, 'lease', { leaseToken: 'opaque' });
      const release = await post(app, 'release', { leaseToken: 'opaque' });
      expect([claim, renew, release]).toEqual([
        { status: 400, body: { error: 'from is required for an admin key' } },
        { status: 400, body: { error: 'from is required for an admin key' } },
        { status: 400, body: { error: 'from is required for an admin key' } },
      ]);
    });
  });

  test('注入 lease_already_released 不再折成 409，证明已删除死映射', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const service: TaskService = {
        ...unusedService(),
        async renew() { throw new Error('lease_already_released'); },
        async release() { throw new Error('lease_already_released'); },
      };
      const app = appFor({ kind: 'identity', address: RECIPIENT }, service);
      const renew = await post(app, 'lease', { leaseToken: 'opaque' });
      const release = await post(app, 'release', { leaseToken: 'opaque' });
      expect(renew).toEqual({ status: 502, body: { error: 'smtp_error' } });
      expect(release).toEqual({ status: 502, body: { error: 'smtp_error' } });
    });
  });

  test('core 释放后重放/续约发 stale_lease 或幂等成功，从不发 lease_already_released', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      let durable = submittedTask();
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async () => ({ messageId: '<lease-contract>' }));
      const grant = await claimTask({ id: ID, from: RECIPIENT, leaseSec: 300 });
      durable = grant.task;
      const released = await releaseTask({ id: ID, from: RECIPIENT, leaseToken: grant.leaseToken, reason: 'done' });
      durable = released;
      await expect(releaseTask({ id: ID, from: RECIPIENT, leaseToken: grant.leaseToken, reason: 'done' }))
        .resolves.toEqual(released);
      await expect(releaseTask({ id: ID, from: RECIPIENT, leaseToken: grant.leaseToken, reason: 'other' }))
        .rejects.toThrow('stale_lease');
      await expect(renewTask({ id: ID, from: RECIPIENT, leaseToken: grant.leaseToken }))
        .rejects.toThrow('stale_lease');
      await expect(releaseTask({ id: ID, from: RECIPIENT, leaseToken: 'wrong', reason: 'done' }))
        .rejects.toThrow('stale_lease');
    });
  });
});
