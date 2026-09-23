/**
 * #336：两条被吞域码归位为 409 同码
 *
 * 正控：claim/lease/release/claim-lost 注入 task_leases_disabled ⇒ 409 同码；
 *       decision 注入 invalid_approval_decision_event ⇒ 409 同码
 * 守门负控：五路由未映射合成码仍 502 task_operation_failed；decision 既有 5 码不变
 * 夹具：纯 service 注入，不依赖真 SMTP/网络/环境变量
 * 不动：test/task-lease-core-gate.test.ts（服务层 toThrow 语义）
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-domain-remap-336-'));
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
const REVIEWER = 'bravo@test.example';
const NOW = '2026-08-24T00:00:00.000Z';
/** 仍未映射的合成哨兵：防「顺手删兜底」 */
const UNMAPPED = 'unmapped_sentinel_for_336';

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

/** 普通 submitted 任务（租约四路由用） */
function submittedTask(): Task {
  return {
    id: ID,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'domain remap 336',
    state: 'submitted',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: '1', from: REQUESTER, to: RECIPIENT, subject: 'domain remap 336',
      date: NOW, state: 'submitted', body: 'go',
    }],
  };
}

/** approval 任务（decision 用） */
function approvalTask(): Task {
  return {
    ...submittedTask(),
    state: 'input-required',
    kind: 'approval',
    approval: {
      action: { type: 'deployment', name: 'preview', arguments: {} },
      reviewer: REVIEWER,
      expiresAt: '2099-01-01T00:00:00.000Z',
      digest: 'a'.repeat(64),
    },
    messages: [],
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

describe('#336 正控 · task_leases_disabled → 409 同码', () => {
  test('POST /:id/claim 注入 task_leases_disabled → 409', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error('task_leases_disabled'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'task_leases_disabled' });
    });
  });

  test('POST /:id/lease 注入 task_leases_disabled → 409', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async renew() { throw new Error('task_leases_disabled'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'task_leases_disabled' });
    });
  });

  test('POST /:id/release 注入 task_leases_disabled → 409', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async release() { throw new Error('task_leases_disabled'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'task_leases_disabled' });
    });
  });

  test('POST /:id/claim-lost 注入 task_leases_disabled → 409', async () => {
    await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, baseService({
        async claimLost() { throw new Error('task_leases_disabled'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'task_leases_disabled' });
    }));
  });
});

describe('#336 正控 · invalid_approval_decision_event → 409 同码', () => {
  test('POST /:id/decision 注入 invalid_approval_decision_event → 409', async () => {
    const app = appFor({ kind: 'identity', address: REVIEWER }, baseService({
      async get() { return approvalTask(); },
      async decideApproval() { throw new Error('invalid_approval_decision_event'); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/decision`, { decision: 'approved' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'invalid_approval_decision_event' });
  });
});

describe('#336 守门负控 · 五路由兜底仍在（未映射合成码 → 502）', () => {
  test('claim 未映射 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    });
  });

  test('lease 未映射 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async renew() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    });
  });

  test('release 未映射 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async release() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    });
  });

  test('claim-lost 未映射 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, baseService({
        async claimLost() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    }));
  });

  test('decision 未映射 → 502 task_operation_failed', async () => {
    const app = appFor({ kind: 'identity', address: REVIEWER }, baseService({
      async get() { return approvalTask(); },
      async decideApproval() { throw new Error(UNMAPPED); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/decision`, { decision: 'approved' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'task_operation_failed' });
  });
});

describe('#336 守门负控 · decision 既有 5 码逐字节不变', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'approval_reviewer_required', status: 403, body: { error: 'forbidden: approval reviewer required' } },
    { code: 'not_approval_task', status: 409, body: { error: 'not_approval_task' } },
    { code: 'task_expired', status: 409, body: { error: 'task_expired' } },
    { code: 'task_already_decided', status: 409, body: { error: 'task_already_decided' } },
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
  ];
  for (const row of cases) {
    test(`decision ${row.code} → ${row.status}`, async () => {
      const app = appFor({ kind: 'identity', address: REVIEWER }, baseService({
        async get() { return approvalTask(); },
        async decideApproval() { throw new Error(row.code); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/decision`, { decision: 'approved' });
      expect(res.status).toBe(row.status);
      expect(res.body).toEqual(row.body);
    });
  }
});
