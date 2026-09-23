/**
 * #340 C3：claim 路由补映射 lease_service_unavailable → 503
 *
 * 正控：claim 注入 lease_service_unavailable ⇒ 503 + toEqual({error:'lease_service_unavailable'})
 * 守门负控：
 *   - claim 其余已映射码与状态逐字节不变
 *   - 未映射合成码仍 502 {error:'task_operation_failed'}
 *   - 兄弟路由 lease/release/claim-lost 的 lease_service_unavailable→503 不动
 * 夹具：纯 service 注入，不依赖真 SMTP/网络/环境变量
 * 本卡不带 R7（不碰 redact/errors/warn 载荷/errorDetail）
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-claim-lsu-340-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test } = await import('bun:test');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { withTaskLeasesEnabledForTests, withTaskLeasePendingJournalForTests } = await import('./support/task-lease-seams.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'alpha@test.example';
const RECIPIENT = 'bravo@test.example';
const NOW = '2026-08-24T00:00:00.000Z';
/** 仍未映射的合成哨兵：防「顺手删兜底」 */
const UNMAPPED = 'unmapped_sentinel_for_340_c3';

for (const localpart of ['alpha', 'bravo']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

/** 普通 submitted 任务（claim/lease/release 用） */
function submittedTask(): Task {
  return {
    id: ID,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'claim lsu 340',
    state: 'submitted',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: '1', from: REQUESTER, to: RECIPIENT, subject: 'claim lsu 340',
      date: NOW, state: 'submitted', body: 'go',
    }],
  };
}

function unused(): never {
  throw new Error('unused');
}

function baseService(overrides: Partial<TaskService> = {}): TaskService {
  return {
    async create() { return unused(); },
    async list() { return []; },
    async listBoard() {
      return { tasks: [], nextCursor: null, totalApprox: 0, queryNow: NOW };
    },
    async get() { return submittedTask(); },
    async update() { return unused(); },
    async reply() { return unused(); },
    async remind() { return unused(); },
    async close() { return unused(); },
    async waitForTerminal() { return null; },
    ...overrides,
  };
}

function appFor(
  auth: { kind: 'admin' } | { kind: 'identity'; address: string },
  service: TaskService,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => ({ address, createdAt: NOW }),
  }));
  return app;
}

async function postJson(
  app: Hono,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await app.request(path, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('#340 C3 正控 · claim lease_service_unavailable → 503', () => {
  test('POST /:id/claim 注入 lease_service_unavailable → 503 精确 body', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error('lease_service_unavailable'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_service_unavailable' });
    });
  });
});

describe('#340 C3 守门负控 · claim 其余已映射码逐字节', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'lease_recipient_required', status: 403, body: { error: 'forbidden: task recipient required' } },
    { code: 'lease_already_claimed', status: 409, body: { error: 'lease_already_claimed' } },
    { code: 'task_not_claimable', status: 409, body: { error: 'task_not_claimable' } },
    { code: 'lease_task_cap_exhausted', status: 409, body: { error: 'lease_task_cap_exhausted' } },
    { code: 'lease_overlay_pending_index', status: 409, body: { error: 'lease_overlay_pending_index' } },
    { code: 'task_leases_disabled', status: 409, body: { error: 'task_leases_disabled' } },
    { code: 'invalid_lease_seconds', status: 400, body: { error: 'invalid_request' } },
  ];
  for (const row of cases) {
    test(`claim ${row.code} → ${row.status} ${JSON.stringify(row.body)}`, async () => {
      await withTaskLeasesEnabledForTests(true, async () => {
        const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
          async claim() { throw new Error(row.code); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
        expect(res.status).toBe(row.status);
        expect(res.body).toEqual(row.body);
      });
    });
  }

  test('claim journal → 503 lease_journal_*', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error('lease_journal_lost'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_journal_lost' });
    });
  });

  test('claim 未映射合成码 → 502 task_operation_failed（兜底仍在）', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    });
  });
});

describe('#340 C3 守门负控 · 兄弟路由 lease_service_unavailable 映射不动', () => {
  test('lease lease_service_unavailable → 503', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async renew() { throw new Error('lease_service_unavailable'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_service_unavailable' });
    });
  });

  test('release lease_service_unavailable → 503', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async release() { throw new Error('lease_service_unavailable'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_service_unavailable' });
    });
  });

  test('claim-lost lease_service_unavailable → 503', async () => {
    await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, baseService({
        async claimLost() { throw new Error('lease_service_unavailable'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_service_unavailable' });
    }));
  });
});
