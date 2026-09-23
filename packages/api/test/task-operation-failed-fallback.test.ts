/**
 * #330：租约/状态六路由 + UI 突变兜底码 smtp_error → task_operation_failed
 *
 * 正控：7 处各注入未映射异常码 ⇒ 502 + toEqual({error:'task_operation_failed'})
 * 守门负控：各路由已映射域码 / UI 已映射族 / journal 503 逐字节锁住
 * 夹具：纯 service 注入，不依赖真 SMTP/网络/环境变量
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Task, TaskService } from '../src/lib/tasks.ts';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-tof-fallback-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, mock, spyOn, test } = await import('bun:test');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { InvalidTaskCursorError } = await import('../src/lib/task-cursor.ts');
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
const ORIGIN = { origin: 'http://localhost' };

for (const localpart of ['alpha', 'bravo', 'fox', 'owl']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

/** 普通 submitted 任务（claim/lease/release/state 用） */
function submittedTask(): Task {
  return {
    id: ID,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'TOF fallback',
    state: 'submitted',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: '1', from: REQUESTER, to: RECIPIENT, subject: 'TOF fallback',
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

/** UI 侧工作中任务 */
const UI_TASK: Task = {
  id: '11111111-1111-4111-8111-111111111111',
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

function makeUiApp(taskServiceOverride: Partial<UiApiDependencies['taskService']>) {
  setTaskNowForTests(() => Date.parse('2026-08-12T12:00:00.000Z'));
  setTaskListAllForTests(async () => [UI_TASK]);
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
      list: mock(async () => [UI_TASK]),
      listBoard: mock(async () => ({
        tasks: [UI_TASK], nextCursor: null, totalApprox: 1, queryNow: '2026-08-12T12:00:00.000Z',
      })),
      get: mock(async (id: string) => (id === UI_TASK.id ? UI_TASK : null)),
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

/** 未映射哨兵码：保证落入兜底（非任何已映射域码） */
const UNMAPPED = 'unmapped_sentinel_for_330';

describe('#330 正控 · 七处兜底 → 502 task_operation_failed', () => {
  test('POST /:id/claim 未映射码 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async claim() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim`, { leaseSec: 300 });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    });
  });

  // #340 C1：既有兜底路径已命中 warn；补断言载荷带 errorCode（与 claim 同族）
  test('POST /:id/lease 未映射码 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const warns: unknown[][] = [];
      const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warns.push(args);
      });
      try {
        const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
          async renew() { throw new Error(UNMAPPED); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'task_operation_failed' });
        const hit = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('[task] renew failed'));
        expect(hit).toBeTruthy();
        expect(hit?.[1]).toBe(UNMAPPED);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('POST /:id/release 未映射码 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const warns: unknown[][] = [];
      const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warns.push(args);
      });
      try {
        const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
          async release() { throw new Error(UNMAPPED); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'task_operation_failed' });
        const hit = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('[task] release failed'));
        expect(hit).toBeTruthy();
        expect(hit?.[1]).toBe(UNMAPPED);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('POST /:id/claim-lost 未映射码 → 502 task_operation_failed', async () => {
    await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, baseService({
        async claimLost() { throw new Error(UNMAPPED); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: 'task_operation_failed' });
    }));
  });

  test('POST /:id/decision 未映射码 → 502 task_operation_failed', async () => {
    const app = appFor({ kind: 'identity', address: REVIEWER }, baseService({
      async get() { return approvalTask(); },
      async decideApproval() { throw new Error(UNMAPPED); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/decision`, { decision: 'approved' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'task_operation_failed' });
  });

  test('POST /:id/state 未映射码 → 502 task_operation_failed', async () => {
    const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
      async update() { throw new Error(UNMAPPED); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/state`, { state: 'working' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'task_operation_failed' });
  });

  test('UI task 突变未映射码 → 502 task_operation_failed', async () => {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === UI_TASK.id ? UI_TASK : null)),
      remind: mock(async () => { throw new Error(UNMAPPED); }),
    });
    const res = await app.request(`/ui/api/tasks/${UI_TASK.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'task_operation_failed' });
  });
});

describe('#330 守门负控 · claim 已映射码逐字节', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'lease_already_claimed', status: 409, body: { error: 'lease_already_claimed' } },
    { code: 'task_not_claimable', status: 409, body: { error: 'task_not_claimable' } },
    { code: 'lease_task_cap_exhausted', status: 409, body: { error: 'lease_task_cap_exhausted' } },
    { code: 'lease_overlay_pending_index', status: 409, body: { error: 'lease_overlay_pending_index' } },
    { code: 'invalid_lease_seconds', status: 400, body: { error: 'invalid_request' } },
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'lease_recipient_required', status: 403, body: { error: 'forbidden: task recipient required' } },
    // #340 C3：与 lease/release/claim-lost 同族归位（旧 502 → 新 503）
    { code: 'lease_service_unavailable', status: 503, body: { error: 'lease_service_unavailable' } },
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
});

describe('#330 守门负控 · lease/release 已映射码逐字节', () => {
  const leaseCases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'lease_recipient_required', status: 403, body: { error: 'forbidden: task recipient required' } },
    { code: 'lease_service_unavailable', status: 503, body: { error: 'lease_service_unavailable' } },
    { code: 'invalid_lease_seconds', status: 400, body: { error: 'invalid_request' } },
    { code: 'invalid_request', status: 400, body: { error: 'invalid_request' } },
    { code: 'stale_lease', status: 409, body: { error: 'stale_lease' } },
    { code: 'task_not_claimable', status: 409, body: { error: 'task_not_claimable' } },
    { code: 'task_already_terminal', status: 409, body: { error: 'task_already_terminal' } },
    { code: 'lease_tenure_exhausted', status: 409, body: { error: 'lease_tenure_exhausted' } },
    { code: 'lease_task_cap_exhausted', status: 409, body: { error: 'lease_task_cap_exhausted' } },
    { code: 'lease_overlay_pending_index', status: 409, body: { error: 'lease_overlay_pending_index' } },
  ];
  for (const row of leaseCases) {
    test(`lease ${row.code} → ${row.status}`, async () => {
      await withTaskLeasesEnabledForTests(true, async () => {
        const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
          async renew() { throw new Error(row.code); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
        expect(res.status).toBe(row.status);
        expect(res.body).toEqual(row.body);
      });
    });
  }

  const releaseCases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'lease_recipient_required', status: 403, body: { error: 'forbidden: task recipient required' } },
    { code: 'lease_service_unavailable', status: 503, body: { error: 'lease_service_unavailable' } },
    { code: 'invalid_request', status: 400, body: { error: 'invalid_request' } },
    { code: 'stale_lease', status: 409, body: { error: 'stale_lease' } },
    { code: 'task_not_claimable', status: 409, body: { error: 'task_not_claimable' } },
    { code: 'task_already_terminal', status: 409, body: { error: 'task_already_terminal' } },
    { code: 'lease_overlay_pending_index', status: 409, body: { error: 'lease_overlay_pending_index' } },
  ];
  for (const row of releaseCases) {
    test(`release ${row.code} → ${row.status}`, async () => {
      await withTaskLeasesEnabledForTests(true, async () => {
        const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
          async release() { throw new Error(row.code); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
        expect(res.status).toBe(row.status);
        expect(res.body).toEqual(row.body);
      });
    });
  }

  test('lease journal → 503', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async renew() { throw new Error('lease_journal_corrupt'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/lease`, { leaseToken: 'opaque' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_journal_corrupt' });
    });
  });

  test('release journal → 503', async () => {
    await withTaskLeasesEnabledForTests(true, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async release() { throw new Error('lease_journal_lost'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/release`, { leaseToken: 'opaque' });
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_journal_lost' });
    });
  });
});

describe('#330 守门负控 · claim-lost 已映射码逐字节', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'lease_service_unavailable', status: 503, body: { error: 'lease_service_unavailable' } },
    { code: 'task_not_claimable', status: 409, body: { error: 'task_not_claimable' } },
    { code: 'lease_claim_lost_too_early', status: 409, body: { error: 'lease_claim_lost_too_early' } },
    { code: 'lease_claim_lost_not_eligible', status: 409, body: { error: 'lease_claim_lost_not_eligible' } },
    { code: 'task_leases_pending_journal_disabled', status: 409, body: { error: 'task_leases_pending_journal_disabled' } },
  ];
  for (const row of cases) {
    test(`claim-lost ${row.code} → ${row.status}`, async () => {
      await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
        const app = appFor({ kind: 'admin' }, baseService({
          async claimLost() { throw new Error(row.code); },
        }));
        const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
        expect(res.status).toBe(row.status);
        expect(res.body).toEqual(row.body);
      }));
    });
  }
  test('claim-lost journal → 503', async () => {
    await withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, async () => {
      const app = appFor({ kind: 'admin' }, baseService({
        async claimLost() { throw new Error('lease_journal_not_bootstrapped'); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/claim-lost`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'lease_journal_not_bootstrapped' });
    }));
  });
});

describe('#330 守门负控 · decision 已映射码逐字节', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'approval_reviewer_required', status: 403, body: { error: 'forbidden: approval reviewer required' } },
    { code: 'not_approval_task', status: 409, body: { error: 'not_approval_task' } },
    { code: 'not_found', status: 404, body: { error: 'not_found' } },
    { code: 'task_already_decided', status: 409, body: { error: 'task_already_decided' } },
    { code: 'task_expired', status: 409, body: { error: 'task_expired' } },
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
  test('decision journal → 503', async () => {
    const app = appFor({ kind: 'identity', address: REVIEWER }, baseService({
      async get() { return approvalTask(); },
      async decideApproval() { throw new Error('lease_journal_corrupt'); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/decision`, { decision: 'approved' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'lease_journal_corrupt' });
  });
});

describe('#330 守门负控 · state 已映射码逐字节', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'task_already_terminal', status: 409, body: { error: 'task_already_terminal' } },
    { code: 'task_lease_required', status: 409, body: { error: 'task_lease_required' } },
    { code: 'approval_decision_required', status: 409, body: { error: 'approval_decision_required' } },
    { code: 'task_participant_required', status: 403, body: { error: 'forbidden: task participant required' } },
  ];
  for (const row of cases) {
    test(`state ${row.code} → ${row.status}`, async () => {
      const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
        async update() { throw new Error(row.code); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/state`, { state: 'working' });
      expect(res.status).toBe(row.status);
      expect(res.body).toEqual(row.body);
    });
  }
  test('state journal → 503', async () => {
    const app = appFor({ kind: 'identity', address: RECIPIENT }, baseService({
      async update() { throw new Error('lease_journal_lost'); },
    }));
    const res = await postJson(app, `/v1/tasks/${ID}/state`, { state: 'working' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'lease_journal_lost' });
  });
});

describe('#330 守门负控 · UI taskMutationError 已映射族逐字节', () => {
  async function remindThrows(code: string | Error) {
    const { app, cookie } = makeUiApp({
      get: mock(async (id: string) => (id === UI_TASK.id ? UI_TASK : null)),
      remind: mock(async () => { throw typeof code === 'string' ? new Error(code) : code; }),
    });
    const res = await app.request(`/ui/api/tasks/${UI_TASK.id}/remind`, {
      method: 'POST',
      headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'fox@test.example' }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  test('UI 404 not_found', async () => {
    expect(await remindThrows('not_found')).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  test('UI 409 族：task_already_terminal / task_lease_required / task_expired / task_already_decided / not_approval_task / approval_decision_required / task_not_input_required', async () => {
    for (const code of [
      'task_already_terminal',
      'task_lease_required',
      'task_expired',
      'task_already_decided',
      'not_approval_task',
      'approval_decision_required',
      'task_not_input_required',
    ]) {
      expect(await remindThrows(code)).toEqual({ status: 409, body: { error: code } });
    }
  });

  test('UI 429 task_remind_cooldown', async () => {
    expect(await remindThrows('task_remind_cooldown')).toEqual({
      status: 429, body: { error: 'task_remind_cooldown' },
    });
  });

  test('UI 403 两处：task_participant_required / approval_reviewer_required', async () => {
    expect(await remindThrows('task_participant_required')).toEqual({
      status: 403, body: { error: 'forbidden: task participant required' },
    });
    expect(await remindThrows('approval_reviewer_required')).toEqual({
      status: 403, body: { error: 'forbidden: approval reviewer required' },
    });
  });

  test('UI 400 invalid_cursor（InvalidTaskCursorError）', async () => {
    expect(await remindThrows(new InvalidTaskCursorError('parse_fail'))).toEqual({
      status: 400, body: { error: 'invalid_cursor' },
    });
  });

  test('UI journal 503 lease_journal_*', async () => {
    expect(await remindThrows('lease_journal_corrupt')).toEqual({
      status: 503, body: { error: 'lease_journal_corrupt' },
    });
  });
});
