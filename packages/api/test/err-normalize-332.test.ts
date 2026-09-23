/**
 * #332：族外 31 处 `(err as Error).message` → `errorCode(err)`
 *
 * 正控：各被改文件非 Error 路径不抛 TypeError，路由落既有兜底/映射码（非 500）
 * 守门负控：Error 输入下现行为逐字节不变（本文件补缺口；其余指证既有套件）
 * 夹具：不依赖真 SMTP/网络/环境变量
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import './support/ui-i18n-shim.ts';
import { Hono } from 'hono';
import type { Task, TaskService } from '../src/lib/tasks.ts';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
// 隔离目录：本套件自用 DATA_DIR，不与其它套件共享
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-err-332-'));
process.env.TASK_LEASES_ENABLED = 'true';
// 不在模块顶置 NTFY_ENABLED：避免抢先 import config 时把默认改成 true
process.env.NTFY_ADMIN_PASSWORD = 'ntfy-admin-secret';
process.env.NOTIFY_PUBLIC_URL = 'https://notify.test';
process.env.NODE_ENV = 'test';

const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { identitiesRoute } = await import('../src/routes/identities.ts');
const { createIdentity, findIdentity, listIdentities } = await import('../src/lib/identities.ts');
const identitiesLib = await import('../src/lib/identities.ts');
const { listDelegations, invalidateDelegationStoreCache, resetDelegationStoreForTests } =
  await import('../src/lib/delegations.ts');
const { resetOAuthStoreCacheForTests, listGrantsForAuth } = await import('../src/lib/oauth-store.ts');
const fs = await import('node:fs');
const {
  appendSendLog,
  resetSendLogForTests,
  sendLogAlertsForTests,
  setSendLogPersistHookForTests,
  startSendLogMaintenance,
  compactSendLog,
} = await import('../src/lib/send-log.ts');
const {
  appendNotificationLog,
  compactNotificationLog,
  resetNotificationLogForTests,
  setNotificationLogNowForTests,
  setNotificationLogPersistHookForTests,
  startNotificationLogMaintenance,
  NOTIFICATION_LOG_RETENTION_MS,
} = await import('../src/lib/notification-log.ts');
const {
  notifyTrustedAgentDelivery,
  resetNotificationStateForTests,
  NtfyNotificationService,
} = await import('../src/lib/notify.ts');
const { startRetentionLoop } = await import('../src/lib/retention.ts');
const imapLib = await import('../src/lib/imap.ts');
const { waitForMessage, setWaitMailserverResolverForTests } = imapLib;
const { config } = await import('../src/lib/config.ts');
const { withTaskLeasesEnabledForTests, withTaskLeasePendingJournalForTests } =
  await import('./support/task-lease-seams.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const NOW = '2026-08-24T00:00:00.000Z';
const ORIGIN = { origin: 'http://localhost' };
const TASK_ID = '11111111-1111-4111-8111-111111111111';

// ── Item 3 自清：跟踪本套件启动的 maintenance/retention 定时器 ──
// real* 仅供 trackTimersDuring / clearTrackedTimers 调度与清理；
// 不在 afterEach/afterAll 无条件写回 globalThis（避免用模块加载时的陈旧引用覆盖共享全局）。
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);
const trackedTimeouts = new Set<ReturnType<typeof setTimeout>>();
const trackedIntervals = new Set<ReturnType<typeof setInterval>>();

/** 清掉本套件跟踪到的 maintenance / retention 定时器 */
function clearTrackedTimers(): void {
  for (const id of trackedTimeouts) realClearTimeout(id);
  trackedTimeouts.clear();
  for (const id of trackedIntervals) realClearInterval(id);
  trackedIntervals.clear();
}

/**
 * 启动 maintenance/retention 时临时包装 setTimeout/setInterval，
 * 记录句柄以便 afterEach 停掉循环；finally 还原**当时**的 prev（不碰陈旧快照）。
 * 不改生产码、不加 stop 探针。
 */
function trackTimersDuring<T>(fn: () => T): T {
  const prevTimeout = globalThis.setTimeout;
  const prevInterval = globalThis.setInterval;
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = realSetTimeout(handler as never, ms as never, ...args);
    trackedTimeouts.add(id);
    return id;
  }) as typeof setTimeout;
  // 保留 .unref 等属性（Bun Timer）
  Object.assign(globalThis.setTimeout, realSetTimeout);
  globalThis.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = realSetInterval(handler as never, ms as never, ...args);
    trackedIntervals.add(id);
    return id;
  }) as typeof setInterval;
  Object.assign(globalThis.setInterval, realSetInterval);
  try {
    return fn();
  } finally {
    globalThis.setTimeout = prevTimeout;
    globalThis.setInterval = prevInterval;
  }
}

/** 身份建在本文件隔离 DATA_DIR，不在模块顶裸跑 */
beforeAll(() => {
  for (const localpart of ['alpha', 'bravo', 'fox', 'owl']) {
    if (!findIdentity(`${localpart}@test.example`)) {
      createIdentity({ localpart, issueToken: false });
    }
  }
});

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
  resetSendLogForTests();
  resetNotificationLogForTests();
  resetNotificationStateForTests();
  setWaitMailserverResolverForTests(undefined);
  // 只清本套件跟踪到的循环句柄；不定时器/ntfy 无条件写回（由用例内保存当时值）
  clearTrackedTimers();
});

afterAll(() => {
  clearTrackedTimers();
});

function unused(): never {
  throw new Error('unused');
}

function submittedTask(): Task {
  return {
    id: ID,
    from: A,
    to: B,
    subject: '332',
    state: 'submitted',
    createdAt: NOW,
    updatedAt: NOW,
    messages: [{
      id: '1', from: A, to: B, subject: '332',
      date: NOW, state: 'submitted', body: 'go',
    }],
  };
}

function approvalTask(): Task {
  return {
    ...submittedTask(),
    state: 'input-required',
    kind: 'approval',
    approval: {
      action: { type: 'deployment', name: 'preview', arguments: {} },
      reviewer: B,
      expiresAt: '2099-01-01T00:00:00.000Z',
      digest: 'a'.repeat(64),
    },
    messages: [],
  };
}

const UI_TASK: Task = {
  id: TASK_ID,
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

async function postJson(app: Hono, path: string, body?: unknown) {
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

/** 非 Error rejection 哨兵 */
const NON_ERROR = undefined;
/** 带 message 的非 Error 鸭子（证明 errorCode 读对象 message，非 instanceof Error） */
const duck = (message: string) => ({ message });

// ──────────────────────────────────────────────
// A 簇 · 路由正控（非 Error → 非 500 + 既有兜底/映射）
// ──────────────────────────────────────────────

describe('#332 A · tasks 租约/状态非 Error → 502 task_operation_failed', () => {
  const routes: Array<{
    name: string;
    path: string;
    body?: unknown;
    auth: { kind: 'admin' } | { kind: 'identity'; address: string };
    service: Partial<TaskService>;
    wrap?: (fn: () => Promise<void>) => Promise<void>;
  }> = [
    {
      name: 'claim',
      path: `/v1/tasks/${ID}/claim`,
      body: { leaseSec: 300 },
      auth: { kind: 'identity', address: B },
      service: { async claim() { throw NON_ERROR; } },
      wrap: (fn) => withTaskLeasesEnabledForTests(true, fn),
    },
    {
      name: 'lease',
      path: `/v1/tasks/${ID}/lease`,
      body: { leaseToken: 'opaque' },
      auth: { kind: 'identity', address: B },
      service: { async renew() { throw NON_ERROR; } },
      wrap: (fn) => withTaskLeasesEnabledForTests(true, fn),
    },
    {
      name: 'release',
      path: `/v1/tasks/${ID}/release`,
      body: { leaseToken: 'opaque' },
      auth: { kind: 'identity', address: B },
      service: { async release() { throw NON_ERROR; } },
      wrap: (fn) => withTaskLeasesEnabledForTests(true, fn),
    },
    {
      name: 'claim-lost',
      path: `/v1/tasks/${ID}/claim-lost`,
      auth: { kind: 'admin' },
      service: { async claimLost() { throw NON_ERROR; } },
      wrap: (fn) => withTaskLeasesEnabledForTests(true, () => withTaskLeasePendingJournalForTests(true, fn)),
    },
    {
      name: 'decision',
      path: `/v1/tasks/${ID}/decision`,
      body: { decision: 'approved' },
      auth: { kind: 'identity', address: B },
      service: {
        async get() { return approvalTask(); },
        async decideApproval() { throw NON_ERROR; },
      },
    },
    {
      name: 'state',
      path: `/v1/tasks/${ID}/state`,
      body: { state: 'working' },
      auth: { kind: 'identity', address: B },
      service: { async update() { throw NON_ERROR; } },
    },
  ];

  for (const row of routes) {
    test(`POST /:id/${row.name} throw undefined → 502 task_operation_failed（非 500）`, async () => {
      const run = async () => {
        const app = appFor(row.auth, baseService(row.service));
        const res = await postJson(app, row.path, row.body);
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'task_operation_failed' });
      };
      if (row.wrap) await row.wrap(run);
      else await run();
    });
  }
});

describe('#332 A · state 409/403 族 Error 守门负控（本卡改动点）', () => {
  const cases: Array<{ code: string; status: number; body: Record<string, unknown> }> = [
    { code: 'task_already_terminal', status: 409, body: { error: 'task_already_terminal' } },
    { code: 'task_lease_required', status: 409, body: { error: 'task_lease_required' } },
    { code: 'approval_decision_required', status: 409, body: { error: 'approval_decision_required' } },
    { code: 'task_participant_required', status: 403, body: { error: 'forbidden: task participant required' } },
  ];
  for (const row of cases) {
    test(`state Error(${row.code}) → ${row.status} 逐字节`, async () => {
      const app = appFor({ kind: 'identity', address: B }, baseService({
        async update() { throw new Error(row.code); },
      }));
      const res = await postJson(app, `/v1/tasks/${ID}/state`, { state: 'working' });
      expect(res.status).toBe(row.status);
      expect(res.body).toEqual(row.body);
    });
  }
});

describe('#332 A · GET /:id/children', () => {
  test('非 Error 鸭子 {message:not_found} → 404（非 500）', async () => {
    const app = appFor({ kind: 'identity', address: A }, baseService({
      async listChildren() { throw duck('not_found'); },
    }));
    const res = await app.request(`/v1/tasks/${PARENT}/children`);
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  test('守门负控 Error(forbidden) → 403 逐字节', async () => {
    const app = appFor({ kind: 'identity', address: A }, baseService({
      async listChildren() { throw new Error('forbidden'); },
    }));
    const res = await app.request(`/v1/tasks/${PARENT}/children`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: task participant required' });
  });
});

describe('#332 A · UI tasks 板 / identities create', () => {
  test('UI listBoard 非 Error 鸭子 lease_journal_* → 503（非 500）', async () => {
    const { app, cookie } = makeUiApp({
      listBoard: mock(async () => { throw duck('lease_journal_lost'); }),
    });
    const res = await app.request('/ui/api/tasks', { headers: { cookie } });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lease_journal_lost' });
  });

  test('UI POST /identities 非 Error 鸭子 invalid_localpart → 400（非 500）', async () => {
    const spy = spyOn(identitiesLib, 'createIdentity').mockImplementation(() => {
      throw duck('invalid_localpart');
    });
    try {
      const { app, cookie } = makeUiApp({});
      const res = await app.request('/ui/api/identities', {
        method: 'POST',
        headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'newagent332' }),
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_localpart' });
    } finally {
      spy.mockRestore();
    }
  });

  test('UI POST /identities 守门负控 Error(invalid_domain) → 400 逐字节', async () => {
    const spy = spyOn(identitiesLib, 'createIdentity').mockImplementation(() => {
      throw new Error('invalid_domain');
    });
    try {
      const { app, cookie } = makeUiApp({});
      const res = await app.request('/ui/api/identities', {
        method: 'POST',
        headers: { cookie, ...ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'newagent332b' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_domain' });
    } finally {
      spy.mockRestore();
    }
  });

  test('REST POST /v1/identities 非 Error 鸭子 invalid_domain → 400（非 500）', async () => {
    const spy = spyOn(identitiesLib, 'createIdentity').mockImplementation(() => {
      throw duck('invalid_domain');
    });
    try {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', { kind: 'admin' });
        await next();
      });
      app.route('/v1/identities', identitiesRoute);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'rest332' }),
      });
      expect(res.status).not.toBe(500);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_domain' });
    } finally {
      spy.mockRestore();
    }
  });

  test('REST POST /v1/identities 守门负控 Error(invalid_localpart) → 400 逐字节', async () => {
    const spy = spyOn(identitiesLib, 'createIdentity').mockImplementation(() => {
      throw new Error('invalid_localpart');
    });
    try {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('auth', { kind: 'admin' });
        await next();
      });
      app.route('/v1/identities', identitiesRoute);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'rest332b' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_localpart' });
    } finally {
      spy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────
// B 簇 · 日志/告警遇非 Error 不抛，且告警/日志载荷含类型标记（errorDetail）
// ──────────────────────────────────────────────

describe('#332 B · send-log 告警路径非 Error 不抛', () => {
  beforeEach(() => {
    resetSendLogForTests();
  });

  test('persist_failed：persistHook throw undefined → 告警载荷非空含类型标记、不抛 TypeError', async () => {
    const details: Record<string, unknown>[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('persist_failed') && args[1] && typeof args[1] === 'object') {
        details.push(args[1] as Record<string, unknown>);
      }
    });
    setSendLogPersistHookForTests(() => {
      throw undefined;
    });
    await expect(
      appendSendLog({
        from: 'fox@test.example',
        to: ['owl@example.net'],
        subject: '332-persist',
        result: 'queued',
        source: 'api',
        messageId: '<m@test.example>',
      }),
    ).rejects.toBeTruthy();
    expect(sendLogAlertsForTests()).toContain('persist_failed');
    // #338：errorDetail 载荷非空且含类型标记
    const hit = details.find((d) => typeof d.error === 'string' && String(d.error).includes('non-error:'));
    expect(hit).toBeTruthy();
    expect(String(hit?.error).length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });

  test('守门负控：persistHook throw Error(ENOSPC) → persist_failed 载荷含 message', async () => {
    const details: Record<string, unknown>[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('persist_failed') && args[1] && typeof args[1] === 'object') {
        details.push(args[1] as Record<string, unknown>);
      }
    });
    setSendLogPersistHookForTests(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    await expect(
      appendSendLog({
        from: 'fox@test.example',
        to: ['owl@example.net'],
        subject: '332-enospc',
        result: 'queued',
        source: 'api',
        messageId: '<m2@test.example>',
      }),
    ).rejects.toMatchObject({ code: 'send_log_persist_failed' });
    // 告警已登记（不依赖 console spy；并行套件下 spy 可能被其它文件抢写）
    expect(sendLogAlertsForTests()).toContain('persist_failed');
    // #342：带 code 的 Error ⇒ "code message"；契约含 ENOSPC
    const { describeFailure } = await import('../src/lib/redact.ts');
    expect(describeFailure(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), [])).toContain(
      'ENOSPC',
    );
    if (details.length > 0) {
      expect(details.some((d) => typeof d.error === 'string' && String(d.error).includes('ENOSPC'))).toBe(
        true,
      );
    }
    errorSpy.mockRestore();
  });

  test('compact_failed：maintenance tick 遇非 Error → 告警不抛', async () => {
    const details: Record<string, unknown>[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('compact_failed') && args[1] && typeof args[1] === 'object') {
        details.push(args[1] as Record<string, unknown>);
      }
    });
    // 让 compact 写盘时抛非 Error（需有可丢弃旧行才会 writeAtomic）
    const old = Date.parse('2020-01-01T00:00:00.000Z');
    const { setSendLogNowForTests } = await import('../src/lib/send-log.ts');
    setSendLogNowForTests(() => old);
    await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'old-row',
      result: 'queued',
      source: 'api',
      messageId: '<old@test.example>',
    });
    setSendLogNowForTests(() => old + 40 * 24 * 60 * 60 * 1000);
    setSendLogPersistHookForTests(() => {
      throw undefined;
    });
    // 跟踪 maintenance 定时器，用例结束 afterEach 清掉
    trackTimersDuring(() => startSendLogMaintenance());
    // maintenance 立即 tick；等队列跑完
    await Bun.sleep(80);
    try {
      await compactSendLog();
    } catch {
      // persist 失败可能从 compact 直接抛；maintenance 路径应已告警
    }
    const typed = details.some((d) => typeof d.error === 'string' && String(d.error).includes('non-error:'));
    expect(typed || sendLogAlertsForTests().includes('compact_failed') || sendLogAlertsForTests().includes('persist_failed')).toBe(true);
    errorSpy.mockRestore();
    setSendLogPersistHookForTests(null);
    setSendLogNowForTests(null);
  });
});

describe('#332 B · notification-log 告警路径非 Error 不抛', () => {
  beforeEach(() => {
    resetNotificationLogForTests();
  });

  test('compact_failed：maintenance 遇非 Error → 告警载荷非空含类型标记且不抛出循环', async () => {
    const details: Record<string, unknown>[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && String(args[0]).includes('compact_failed') && args[1] && typeof args[1] === 'object') {
        details.push(args[1] as Record<string, unknown>);
      }
    });
    const old = Date.parse('2020-01-01T00:00:00.000Z');
    setNotificationLogNowForTests(() => old);
    await appendNotificationLog({
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'normal',
      title: 'old',
      message: 'x',
      tags: [],
      sensitive: false,
    });
    setNotificationLogNowForTests(() => old + NOTIFICATION_LOG_RETENTION_MS + 1);
    setNotificationLogPersistHookForTests(() => {
      throw undefined;
    });
    expect(() => trackTimersDuring(() => startNotificationLogMaintenance())).not.toThrow();
    await Bun.sleep(80);
    // 直接 compact 也会走同一告警（若 maintenance 已吞掉）；断言告警载荷
    try {
      await compactNotificationLog();
    } catch {
      // ignore
    }
    const hit = details.find((d) => typeof d.error === 'string' && String(d.error).includes('non-error:'));
    expect(hit).toBeTruthy();
    expect(String(hit?.error).length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });
});

describe('#332 B · notify 告警/warn 路径非 Error 不抛', () => {
  test('notifyTrustedAgentDelivery：publish reject undefined → warn 载荷非空含类型标记且不抛', async () => {
    // 只在本用例 mutate：进用例前记下**当时**值，finally 还原（不用模块加载陈旧快照）
    const prevEnabled = config.ntfy.enabled;
    const prevPolicy = config.ntfy.pushPolicy;
    (config.ntfy as { enabled: boolean }).enabled = true;
    (config.ntfy as { pushPolicy: string }).pushPolicy = 'all';
    if (!findIdentity('fox@test.example')) createIdentity({ localpart: 'fox', issueToken: false });

    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    // publish 在 catch 外层前已映射 fetch；直接让 service.publish 抛非 Error
    const pubSpy = spyOn(NtfyNotificationService.prototype, 'publish').mockImplementation(async () => {
      throw undefined;
    });
    try {
      await expect(notifyTrustedAgentDelivery('fox@test.example')).resolves.toBeUndefined();
      const hit = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('trusted agent delivery failed'));
      expect(hit).toBeTruthy();
      // #338：errorDetail 类型化文本，非空
      expect(typeof hit?.[1]).toBe('string');
      expect(String(hit?.[1]).length).toBeGreaterThan(0);
      expect(String(hit?.[1])).toContain('non-error:');
    } finally {
      pubSpy.mockRestore();
      warnSpy.mockRestore();
      (config.ntfy as { enabled: boolean }).enabled = prevEnabled;
      (config.ntfy as { pushPolicy: typeof prevPolicy }).pushPolicy = prevPolicy;
    }
  });
});

describe('#332 B · retention 日志路径非 Error 不抛', () => {
  test('sweep tick：deleteMessagesBefore throw undefined → warn 载荷非空含类型标记且 tick 不抛', async () => {
    if (config.retentionDays <= 0) {
      // 环境禁用时跳过（本卡夹具默认 30）
      return;
    }
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    const delSpy = spyOn(imapLib, 'deleteMessagesBefore').mockImplementation(async () => {
      throw undefined;
    });
    // 把 60s grace 压成立即，并跟踪 interval/timeout 以便自清
    const prevTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const delay = typeof ms === 'number' && ms >= 60_000 ? 0 : (ms ?? 0);
      const id = realSetTimeout(fn as never, delay, ...args);
      trackedTimeouts.add(id);
      return id;
    }) as typeof setTimeout;
    Object.assign(globalThis.setTimeout, realSetTimeout);
    const prevInterval = globalThis.setInterval;
    globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = realSetInterval(fn as never, ms as never, ...args);
      trackedIntervals.add(id);
      return id;
    }) as typeof setInterval;
    Object.assign(globalThis.setInterval, realSetInterval);
    try {
      expect(() => startRetentionLoop()).not.toThrow();
      await Bun.sleep(80);
      const hit = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('[retention] sweep failed'));
      expect(hit).toBeTruthy();
      expect(typeof hit?.[1]).toBe('string');
      expect(String(hit?.[1]).length).toBeGreaterThan(0);
      expect(String(hit?.[1])).toContain('non-error:');
    } finally {
      globalThis.setTimeout = prevTimeout;
      globalThis.setInterval = prevInterval;
      clearTrackedTimers();
      delSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('#332 B · imap IDLE/poll warn 非 Error 不抛', () => {
  test('waitForMessage：withMailserverReconnect reject undefined → IDLE warn 载荷非空含类型标记后回退不炸', async () => {
    const reconnect = await import('../src/lib/mailserver-reconnect.ts');
    const warns: unknown[][] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args);
    });
    // 让 IDLE 连接路径直接以非 Error rejection 失败，命中 waitForMessage catch 的 warn
    const spy = spyOn(reconnect, 'withMailserverReconnect').mockImplementation(async () => {
      throw undefined;
    });
    try {
      const result = await waitForMessage('fox@test.example', {}, 1);
      expect(result).toBeNull();
      const idle = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('IDLE wait failed'));
      const poll = warns.find((w) => typeof w[0] === 'string' && String(w[0]).includes('poll failed'));
      expect(idle || poll).toBeTruthy();
      const payload = (idle ?? poll)?.[1];
      expect(typeof payload).toBe('string');
      expect(String(payload).length).toBeGreaterThan(0);
      expect(String(payload)).toContain('non-error:');
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────
// C 簇 · store corrupt 判定遇非 Error 不抛、不误判为已 corrupt 再抛原值
// ──────────────────────────────────────────────

describe('#332 C · *_store_corrupt 非 Error 输入', () => {
  test('identities：readFileSync throw undefined → 包装 Error(identity_store_corrupt)，非 TypeError/非 rethrow undefined', () => {
    const path = join(config.dataDir, 'identities.json');
    const good = fs.readFileSync(path, 'utf8');
    // 保持 good+' ' 至断言结束：靠 size 变化确定性打穿 load() 缓存（勿复原 size，否则粗粒度 fs 上可能仍命中缓存）
    writeFileSync(path, good + ' ');
    const original = fs.readFileSync.bind(fs);
    const spy = spyOn(fs, 'readFileSync').mockImplementation((p: any, encoding?: any) => {
      if (String(p).includes('identities.json')) throw undefined as never;
      return encoding !== undefined ? original(p, encoding) : original(p);
    });
    try {
      let caught: unknown;
      try {
        listIdentities();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('identity_store_corrupt');
      // 不误判：若裸读把 undefined 当成已 corrupt 会 rethrow undefined
      expect(caught).not.toBeUndefined();
    } finally {
      spy.mockRestore();
      writeFileSync(path, good);
    }
  });

  test('delegations：readFileSync throw undefined → 包装 delegation_store_corrupt', () => {
    resetDelegationStoreForTests();
    writeFileSync(join(config.dataDir, 'delegations.json'), JSON.stringify({
      schemaVersion: 1,
      grants: [],
    }), { mode: 0o600 });
    invalidateDelegationStoreCache();
    const original = fs.readFileSync.bind(fs);
    const spy = spyOn(fs, 'readFileSync').mockImplementation((p: any, encoding?: any) => {
      if (String(p).includes('delegations.json')) throw undefined as never;
      return encoding !== undefined ? original(p, encoding) : original(p);
    });
    try {
      let caught: unknown;
      try {
        listDelegations();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('delegation_store_corrupt');
    } finally {
      spy.mockRestore();
      resetDelegationStoreForTests();
    }
  });

  test('oauth：loadStore 遇非 Error → 包装 oauth_store_corrupt，不误判 rethrow', () => {
    // 必须先有 oauth.json，否则 existsSync 短路根本不读盘
    const oauthPath = join(config.dataDir, 'oauth.json');
    writeFileSync(oauthPath, JSON.stringify({
      schemaVersion: 1,
      grants: {},
      codes: {},
      access: {},
      refresh: {},
    }), { mode: 0o600 });
    resetOAuthStoreCacheForTests();
    const original = fs.readFileSync.bind(fs);
    const spy = spyOn(fs, 'readFileSync').mockImplementation((p: any, encoding?: any) => {
      if (String(p).includes('oauth.json')) throw undefined as never;
      return encoding !== undefined ? original(p, encoding) : original(p);
    });
    try {
      let caught: unknown;
      try {
        listGrantsForAuth({ kind: 'admin' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('oauth_store_corrupt');
    } finally {
      spy.mockRestore();
      resetOAuthStoreCacheForTests();
    }
  });

  test('守门负控：磁盘损坏 JSON 仍抛 identity_store_corrupt（既有语义）', () => {
    const path = join(config.dataDir, 'identities.json');
    const good = fs.readFileSync(path, 'utf8');
    try {
      writeFileSync(path, '[{"address":"x@test.example"');
      expect(() => listIdentities()).toThrow('identity_store_corrupt');
    } finally {
      writeFileSync(path, good);
    }
  });
});
