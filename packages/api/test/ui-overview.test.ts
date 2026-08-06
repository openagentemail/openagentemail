// Overview 的端点契约、缓存状态机与统计口径。
//
// 三条主线：
//  1. 授权与载荷形状（键集合严格等于契约，内部字段一个都不外泄）；
//  2. 统计口径（一次扫描 + per-UID 快照，去重、未读、截断诚实性）；
//  3. 缓存状态机（新鲜/stale/硬过期、单飞、失败冷却、真取消、单一时钟域）。
//
// 状态机全部走注入的假时钟与可控 promise：真时间只用来做"多久之内跑完"这类
// 上界断言，绝不用来推进 TTL 或冷却。
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { ImapFlow } from 'imapflow';
import type { MailboxScanResult, ScanRecord } from '../src/lib/imap.ts';
import type { MailboxSnapshot, ScanOutcome } from '../src/lib/overview-cache.ts';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

/* ---------- 假 IMAP 服务器（listMessages 与 scanMailboxWindow 共用同一个信箱） ---------- */

type FakeMessage = {
  uid: number;
  envelope?: {
    from: { address: string }[];
    to: { address: string }[];
    subject: string;
    date: Date;
  };
  internalDate?: Date;
  flags: Set<string>;
  headers?: Buffer;
};

let mailbox: FakeMessage[] = [];
let mailboxUids: number[] | null = null;
let fetchOptionsSeen: unknown[] = [];
let connections = 0;

class FakeImapFlow {
  constructor() {
    connections += 1;
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search() {
    return mailboxUids ?? mailbox.map((message) => message.uid);
  }
  async *fetch(range: number[], options: unknown) {
    fetchOptionsSeen.push(options);
    const wanted = new Set(range);
    for (const message of mailbox) {
      if (wanted.has(message.uid)) yield message;
    }
  }
  async fetchOne(uid: number) {
    const message = mailbox.find((candidate) => candidate.uid === uid);
    if (!message) return false;
    return {
      ...message,
      source: Buffer.from('From: sender@example.net\r\nSubject: hi\r\n\r\nbody'),
    };
  }
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createOverviewCache } = await import('../src/lib/overview-cache.ts');
const { listMessages, scanMailboxWindow } = await import('../src/lib/imap.ts');

const T0 = Date.parse('2026-07-27T15:00:00.000Z');
const HOUR = 3_600_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const identities = [
  {
    address: 'fox@test.example',
    name: 'Billing bot',
    createdAt: '2026-07-02T08:11:00.000Z',
    tokenHash: 'must-never-leak',
  },
  {
    address: 'owl@test.example',
    createdAt: '2026-07-20T09:00:00.000Z',
  },
];

function resetMailbox() {
  mailbox = [];
  mailboxUids = null;
  fetchOptionsSeen = [];
  connections = 0;
}

function fakeMessage(
  uid: number,
  options: {
    to?: string[];
    seen?: boolean;
    internal?: string;
    headers?: string;
    noEnvelope?: boolean;
    claimedDate?: string;
  } = {},
): FakeMessage {
  return {
    uid,
    ...(options.noEnvelope
      ? {}
      : {
          envelope: {
            from: [{ address: 'sender@example.net' }],
            to: (options.to ?? []).map((address) => ({ address })),
            subject: 'hello',
            date: new Date(options.claimedDate ?? '2026-07-27T14:00:00.000Z'),
          },
        }),
    ...(options.internal === undefined ? {} : { internalDate: new Date(options.internal) }),
    flags: new Set<string>(options.seen ? ['\\Seen'] : []),
    ...(options.headers === undefined
      ? {}
      : { headers: Buffer.from(options.headers, 'utf8') }),
  };
}

/* ---------- 路由夹具 ---------- */

function zeroSnapshotOutcome(now = T0): ScanOutcome {
  return {
    kind: 'ready',
    now,
    snapshot: null,
    cached: false,
    revalidating: false,
    refreshError: false,
  };
}

function makeSnapshot(
  records: ScanRecord[],
  overrides: Partial<MailboxSnapshot> = {},
): MailboxSnapshot {
  return {
    records,
    scanned: records.length,
    mailboxTotal: records.length,
    truncated: false,
    partial: false,
    incompleteFor: new Set<string>(),
    identityAddressesAtScan: identities.map((identity) => identity.address),
    scannedAt: T0,
    ...overrides,
  };
}

function readyOutcome(
  snapshot: MailboxSnapshot,
  overrides: Partial<Extract<ScanOutcome, { kind: 'ready' | 'stale' }>> = {},
): ScanOutcome {
  return {
    kind: 'ready',
    now: T0,
    snapshot,
    cached: false,
    revalidating: false,
    refreshError: false,
    ...overrides,
  };
}

function makeApp(overrides: Partial<UiApiDependencies> = {}) {
  const deps: UiApiDependencies = {
    listIdentities: mock(() => identities),
    listMessages: mock(async () => []),
    getMessage: mock(async () => null),
    setMessageSeen: mock(async () => true),
    getMailboxScan: mock(async () => zeroSnapshotOutcome()),
    setPushContentTier: mock(() => null),
    ...overrides,
  };
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'ok' ? { kind: 'admin' } : null),
  });
  const created = store.create('ok', '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  // 与 app.ts 一致的兜底：抛出的 identity_store_corrupt 映射成 500 internal_error
  app.onError((_error, c) => c.json({ error: 'internal_error' }, 500));
  return { app, deps, cookie: `oae_ui=${created.sid}` };
}

async function overviewRequest(
  app: Hono,
  cookie: string,
  query = '',
): Promise<Response> {
  return app.request(`/ui/api/overview${query}`, { headers: { cookie } });
}

type OverviewBody = {
  status: string;
  generatedAt: string;
  ageSeconds: number;
  cached: boolean;
  revalidating: boolean;
  refreshError: boolean;
  retryAfterMs?: number;
  scan: {
    scanBack: number;
    scanned: number | null;
    mailboxTotal: number | null;
    truncated: boolean;
    skipped: boolean;
    partial: boolean;
  };
  totals: {
    addresses: number;
    matchedInWindow: number;
    unmatchedInWindow: number | null;
    unseenInWindow: number;
    activeAddresses: number;
    exact: boolean;
    recentHours: number;
    recentSince: string;
  };
  addresses: Array<{
    address: string;
    name?: string;
    createdAt: string;
    complete: boolean;
    count: number;
    unseen: number;
    lastReceivedAt: string | null;
  }>;
};

async function overviewJson(app: Hono, cookie: string, query = ''): Promise<OverviewBody> {
  const response = await overviewRequest(app, cookie, query);
  return (await response.json()) as OverviewBody;
}

function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

/* ---------- 缓存夹具 ---------- */

function scanResult(records: ScanRecord[] = [], overrides: Partial<MailboxScanResult> = {}) {
  return {
    records,
    scanned: records.length,
    mailboxTotal: records.length,
    truncated: false,
    partial: false,
    incompleteFor: new Set<string>(),
    identityAddressesAtScan: ['fox@test.example'],
    ...overrides,
  } satisfies MailboxScanResult;
}

const ADDRESSES = ['fox@test.example'];

/** 可控时钟 + 计数扫描的缓存，所有状态机用例都从这里起。 */
function harness(options: {
  scan?: (opts: { signal: AbortSignal; identityAddresses: string[] }) => Promise<MailboxScanResult>;
  freshMs?: number;
  staleMaxMs?: number;
  refreshFloorMs?: number;
  failureCooldownMs?: number;
  scanDeadlineMs?: number;
  responseBudgetMs?: number;
} = {}) {
  let now = T0;
  let scans = 0;
  let active = 0;
  let peak = 0;
  const cache = createOverviewCache({
    scan: async (opts) => {
      scans += 1;
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await (options.scan ? options.scan(opts) : Promise.resolve(scanResult()));
      } finally {
        active -= 1;
      }
    },
    clock: () => now,
    responseBudgetMs: options.responseBudgetMs ?? 5000,
    ...(options.freshMs === undefined ? {} : { freshMs: options.freshMs }),
    ...(options.staleMaxMs === undefined ? {} : { staleMaxMs: options.staleMaxMs }),
    ...(options.refreshFloorMs === undefined ? {} : { refreshFloorMs: options.refreshFloorMs }),
    ...(options.failureCooldownMs === undefined
      ? {}
      : { failureCooldownMs: options.failureCooldownMs }),
    ...(options.scanDeadlineMs === undefined ? {} : { scanDeadlineMs: options.scanDeadlineMs }),
  });
  return {
    cache,
    get scans() {
      return scans;
    },
    get peak() {
      return peak;
    },
    at: (ms: number) => {
      now = T0 + ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
    ask: (refresh = false) => cache.getOverview({ refresh, identityAddresses: ADDRESSES }),
  };
}

/* ============================ A. 授权与契约 ============================ */

describe('Overview 端点契约', () => {
  // A1 / A6
  test('载荷键集合严格等于契约，且内部字段一个都不外泄', async () => {
    const snapshot = makeSnapshot([
      { t: T0 - 60_000, s: false, r: ['fox@test.example'] },
      { t: T0 - 120_000, s: true, r: ['fox@test.example'] },
      { t: T0 - 180_000, s: true, r: [] },
    ]);
    const { app, cookie } = makeApp({
      getMailboxScan: async () => readyOutcome(snapshot, { cached: true }),
    });
    const response = await overviewRequest(app, cookie);
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as OverviewBody;

    expect(Object.keys(body).sort()).toEqual([
      'addresses',
      'ageSeconds',
      'cached',
      'generatedAt',
      'refreshError',
      'revalidating',
      'scan',
      'status',
      'totals',
    ]);
    expect(Object.keys(body.scan).sort()).toEqual([
      'mailboxTotal',
      'partial',
      'scanBack',
      'scanned',
      'skipped',
      'truncated',
    ]);
    expect(Object.keys(body.totals).sort()).toEqual([
      'activeAddresses',
      'addresses',
      'exact',
      'matchedInWindow',
      'recentHours',
      'recentSince',
      'unmatchedInWindow',
      'unseenInWindow',
    ]);
    expect(Object.keys(body.addresses[0]!).sort()).toEqual([
      'address',
      'complete',
      'count',
      'createdAt',
      'hasToken',
      'lastReceivedAt',
      'name',
      'pushContentTier',
      'unseen',
    ]);
    expect(body.scan.scanBack).toBe(500);
    expect(body.status).toBe('ready');
    expect(body.cached).toBe(true);

    // A6：递归键集合里不许出现任何邮件内容或内部字段
    const keys = collectKeys(body);
    for (const forbidden of [
      'html',
      'tokenHash',
      'snippet',
      'subject',
      'from',
      'text',
      'now',
      'snapshot',
      'floored',
      'records',
      'incompleteFor',
      'identityAddressesAtScan',
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(text).not.toContain('must-never-leak');
  });

  // A7
  test('行上的身份三字段与 /ui/api/identities 的投影逐字一致', async () => {
    const { app, cookie } = makeApp({
      getMailboxScan: async () => readyOutcome(makeSnapshot([])),
    });
    const identityBody = (await (
      await app.request('/ui/api/identities', { headers: { cookie } })
    ).json()) as { identities: unknown[] };
    const body = await overviewJson(app, cookie);

    const projected: unknown[] = body.addresses.map((row) => {
      const { complete: _complete, count: _count, unseen: _unseen, lastReceivedAt: _last, ...rest } = row;
      return rest;
    });
    expect(projected).toEqual(identityBody.identities);
  });

  // A8
  test('四种响应形态都带上私有缓存头', async () => {
    const staleOutcome: ScanOutcome = {
      kind: 'stale',
      now: T0,
      snapshot: makeSnapshot([]),
      cached: true,
      revalidating: false,
      refreshError: true,
      retryAfterMs: 1500,
    };
    const cases: ScanOutcome[] = [
      readyOutcome(makeSnapshot([])),
      staleOutcome,
      { kind: 'loading', now: T0, retryAfterMs: 1000 },
      { kind: 'unavailable', now: T0, reason: 'imap_unavailable', retryAfterSeconds: 5 },
    ];
    const expected = [200, 200, 202, 503];
    for (let index = 0; index < cases.length; index += 1) {
      const outcome = cases[index]!;
      const { app, cookie } = makeApp({ getMailboxScan: async () => outcome });
      const response = await overviewRequest(app, cookie);
      expect(response.status).toBe(expected[index]);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Authorization, Cookie');
    }
  });

  // A4（路由侧）：?refresh 只认字面 1
  test('?refresh 只有字面 1 才算强制刷新', async () => {
    const getMailboxScan = mock(
      async (_opts: { refresh: boolean; identityAddresses: string[] }) =>
        readyOutcome(makeSnapshot([])),
    );
    const { app, cookie } = makeApp({ getMailboxScan });
    await overviewRequest(app, cookie, '?refresh=1');
    await overviewRequest(app, cookie, '?refresh=true');
    await overviewRequest(app, cookie, '?refresh=0');
    await overviewRequest(app, cookie);
    expect(getMailboxScan.mock.calls.map((call) => call[0].refresh)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  // A10：Retry-After 头与载荷同一个整数，且冷却期内给剩余冷却
  test('503 的 Retry-After 与 retryAfterSeconds 相等，冷却期内是剩余秒数', async () => {
    let now = T0;
    const cache = createOverviewCache({
      scan: async () => {
        throw new Error('imap down');
      },
      clock: () => now,
      responseBudgetMs: 5000,
    });
    const { app, cookie } = makeApp({
      getMailboxScan: (opts) => cache.getOverview(opts),
      listIdentities: () => identities,
    });

    const first = await overviewRequest(app, cookie);
    expect(first.status).toBe(503);
    const firstBody = (await first.json()) as { retryAfterSeconds: number; reason: string };
    expect(firstBody.reason).toBe('imap_unavailable');
    expect(firstBody.retryAfterSeconds).toBe(5);
    expect(first.headers.get('retry-after')).toBe('5');

    now = T0 + 2600;
    const second = await overviewRequest(app, cookie);
    expect(second.status).toBe(503);
    const secondBody = (await second.json()) as { retryAfterSeconds: number };
    expect(secondBody.retryAfterSeconds).toBe(3);
    expect(second.headers.get('retry-after')).toBe('3');
  });

  // A12：/v1/* 路由表零新增
  test('Overview 只存在于 /ui/api 下，/v1 没有新增路由', async () => {
    const { createApp } = await import('../src/app.ts');
    const full = createApp({ uiEnabled: true });
    // 直接查路由表，避免依赖测试进程里 API_KEYS 的加载顺序
    const overviewRoutes = full.routes
      .filter((route) => route.path.includes('overview'))
      .map((route) => `${route.method} ${route.path}`);
    expect(overviewRoutes).toEqual(['GET /ui/api/overview']);
    expect(full.routes.some((route) => route.path.startsWith('/v1') && route.path.includes('overview'))).toBe(
      false,
    );
  });

  // A30
  test('身份库损坏时是 500 internal_error，绝不返回空 addresses', async () => {
    const getMailboxScan = mock(async () => readyOutcome(makeSnapshot([])));
    const { app, cookie } = makeApp({
      listIdentities: () => {
        throw new Error('identity_store_corrupt');
      },
      getMailboxScan,
    });
    const response = await overviewRequest(app, cookie);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
    expect(getMailboxScan).not.toHaveBeenCalled();
  });
});

/* ============================ D. 统计口径 ============================ */

describe('Overview 统计口径', () => {
  // A27 / A28
  test('一次请求只扫一次，只取信封/标记/收件头，绝不取正文', async () => {
    resetMailbox();
    const many = Array.from({ length: 50 }, (_, index) => ({
      address: `agent-${index}@test.example`,
      createdAt: '2026-07-01T00:00:00.000Z',
    }));
    mailbox = [fakeMessage(1, { to: ['agent-0@test.example'], internal: '2026-07-27T14:00:00.000Z' })];

    let scans = 0;
    const cache = createOverviewCache({
      scan: (opts) => {
        scans += 1;
        return scanMailboxWindow(opts);
      },
      clock: () => T0,
      responseBudgetMs: 5000,
    });
    const { app, cookie, deps } = makeApp({
      listIdentities: () => many,
      getMailboxScan: (opts) => cache.getOverview(opts),
    });

    const body = await overviewJson(app, cookie);
    expect(body.addresses).toHaveLength(50);
    expect(scans).toBe(1);
    expect(connections).toBe(1);
    expect(deps.listMessages).not.toHaveBeenCalled();
    expect(fetchOptionsSeen).toHaveLength(1);
    expect(fetchOptionsSeen[0]).toEqual({
      envelope: true,
      flags: true,
      internalDate: true,
      headers: ['delivered-to'],
    });
    expect(JSON.stringify(fetchOptionsSeen[0])).not.toContain('source');
  });

  // A29：0 身份（终审 v5：门面命中一次短路，底层扫描零次）
  test('0 身份走缓存层短路：门面 1 次、真实扫描 0 次，窗口派生量为 null', async () => {
    resetMailbox();
    let scans = 0;
    const cache = createOverviewCache({
      scan: (opts) => {
        scans += 1;
        return scanMailboxWindow(opts);
      },
      clock: () => T0,
    });
    const getMailboxScan = mock((opts: { refresh: boolean; identityAddresses: string[] }) =>
      cache.getOverview(opts),
    );
    const { app, cookie } = makeApp({ listIdentities: () => [], getMailboxScan });

    const body = await overviewJson(app, cookie);
    expect(getMailboxScan).toHaveBeenCalledTimes(1);
    expect(getMailboxScan.mock.calls[0]![0].identityAddresses).toEqual([]);
    expect(scans).toBe(0);
    expect(connections).toBe(0);

    expect(body.addresses).toEqual([]);
    expect(body.scan.skipped).toBe(true);
    expect(body.scan.scanned).toBeNull();
    expect(body.scan.mailboxTotal).toBeNull();
    expect(body.scan.truncated).toBe(false);
    // 未观测量不得写 0
    expect(body.totals.unmatchedInWindow).toBeNull();
    // 身份派生量是逻辑 0
    expect(body.totals.matchedInWindow).toBe(0);
    expect(body.totals.unseenInWindow).toBe(0);
    expect(body.totals.activeAddresses).toBe(0);
    expect(body.totals.addresses).toBe(0);
    expect(body.totals.exact).toBe(true);
    expect(body.ageSeconds).toBe(0);
    expect(body.generatedAt).toBe(new Date(T0).toISOString());
  });

  // A31 / A32
  test('一封投给两个身份的信：两行各 +1，去重后总计只 +1', async () => {
    const snapshot = makeSnapshot([
      { t: T0 - 10_000, s: false, r: ['fox@test.example', 'owl@test.example'] },
      { t: T0 - 20_000, s: true, r: ['fox@test.example'] },
      { t: T0 - 30_000, s: false, r: [] },
    ]);
    const { app, cookie } = makeApp({
      getMailboxScan: async () => readyOutcome(snapshot),
    });
    const body = await overviewJson(app, cookie);

    expect(body.addresses.map((row) => [row.address, row.count, row.unseen])).toEqual([
      ['fox@test.example', 2, 1],
      ['owl@test.example', 1, 1],
    ]);
    expect(body.totals.matchedInWindow).toBe(2);
    expect(body.totals.unseenInWindow).toBe(1);
    expect(body.totals.unmatchedInWindow).toBe(body.scan.scanned! - 2);
    expect(body.totals.exact).toBe(true);
  });

  // A33
  test('lastReceivedAt 用 INTERNALDATE，伪造的未来 Date 污染不了它', async () => {
    resetMailbox();
    mailbox = [
      fakeMessage(1, {
        to: ['fox@test.example'],
        internal: '2026-07-27T14:50:00.000Z',
        claimedDate: '2099-01-01T00:00:00.000Z',
      }),
      fakeMessage(2, { to: ['owl@test.example'] }),
    ];
    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: identities.map((identity) => identity.address),
    });
    const { app, cookie } = makeApp({
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);

    expect(body.addresses[0]!.lastReceivedAt).toBe('2026-07-27T14:50:00.000Z');
    // 既没有 internalDate 也没有可信 Date → receivedAtMs()===0 → null
    expect(body.addresses[1]!.lastReceivedAt).toBe('2026-07-27T14:00:00.000Z');
    const noDate = makeSnapshot([{ t: 0, s: false, r: ['owl@test.example'] }]);
    const second = makeApp({ getMailboxScan: async () => readyOutcome(noDate) });
    const secondBody = await overviewJson(second.app, second.cookie);
    expect(secondBody.addresses[1]!.lastReceivedAt).toBeNull();
    expect(secondBody.addresses[1]!.count).toBe(1);
  });

  // A34
  test('缓存期内增删身份立刻反映，且不触发第二次扫描', async () => {
    resetMailbox();
    mailbox = [
      fakeMessage(1, { to: ['fox@test.example'], internal: '2026-07-27T14:55:00.000Z' }),
      fakeMessage(2, { to: ['owl@test.example'], internal: '2026-07-27T14:56:00.000Z' }),
    ];
    let scans = 0;
    const cache = createOverviewCache({
      scan: (opts) => {
        scans += 1;
        return scanMailboxWindow(opts);
      },
      clock: () => T0,
      responseBudgetMs: 5000,
    });
    let visible = identities.slice();
    const { app, cookie } = makeApp({
      listIdentities: () => visible,
      getMailboxScan: (opts) => cache.getOverview(opts),
    });

    const first = await overviewJson(app, cookie);
    expect(first.totals.matchedInWindow).toBe(2);
    expect(scans).toBe(1);

    visible = [identities[0]!];
    const afterDelete = await overviewJson(app, cookie);
    expect(afterDelete.addresses.map((row) => row.address)).toEqual(['fox@test.example']);
    expect(afterDelete.totals.matchedInWindow).toBe(1);

    visible = [
      ...identities,
      { address: 'new@test.example', createdAt: '2026-07-27T15:00:00.000Z' },
    ];
    const afterAdd = await overviewJson(app, cookie);
    expect(afterAdd.addresses.map((row) => row.address)).toEqual([
      'fox@test.example',
      'owl@test.example',
      'new@test.example',
    ]);
    // 完整快照下，扫描后才建的身份显示真实观测到的 0
    expect(afterAdd.addresses[2]).toMatchObject({ complete: true, count: 0, lastReceivedAt: null });
    expect(afterAdd.totals.matchedInWindow).toBe(2);
    expect(scans).toBe(1);
  });

  // A35
  test('truncated 由 mailboxTotal 与实际扫描数决定', async () => {
    resetMailbox();
    mailboxUids = Array.from({ length: 1240 }, (_, index) => index + 1);
    mailbox = Array.from({ length: 500 }, (_, index) =>
      fakeMessage(741 + index, { to: ['fox@test.example'] }),
    );
    const truncated = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: ADDRESSES,
    });
    expect(truncated.scanned).toBe(500);
    expect(truncated.mailboxTotal).toBe(1240);
    expect(truncated.truncated).toBe(true);

    resetMailbox();
    mailboxUids = Array.from({ length: 300 }, (_, index) => index + 1);
    mailbox = Array.from({ length: 300 }, (_, index) =>
      fakeMessage(index + 1, { to: ['fox@test.example'] }),
    );
    const whole = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: ADDRESSES,
    });
    expect(whole.scanned).toBe(300);
    expect(whole.truncated).toBe(false);
  });

  // A36：窗口口径与 listMessages 一致（只对精确行成立）
  test('精确行的 count 与同一信箱下 listMessages 的条数相等', async () => {
    resetMailbox();
    mailbox = [
      fakeMessage(1, { to: ['fox@test.example'] }),
      fakeMessage(2, { to: ['fox@test.example', 'owl@test.example'] }),
      fakeMessage(3, { to: ['stranger@test.example'] }),
      fakeMessage(4, { headers: 'Delivered-To: owl@test.example\r\n', to: [] }),
    ];
    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: identities.map((identity) => identity.address),
    });
    const { app, cookie } = makeApp({
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);

    // 前置条件：complete === true。这与 totals.exact **不等价** —— 部分受影响的
    // 快照里，未受影响的行仍然 complete:true，本断言对它们依然有效。
    for (const row of body.addresses) {
      expect(row.complete).toBe(true);
      const live = await listMessages(row.address, 200);
      expect(live.length).toBe(row.count);
    }
    expect(body.addresses.map((row) => row.count)).toEqual([2, 2]);
  });

  // A37：内存上界与身份优先
  test('①只挤掉投机地址时不降级：身份保留、exact 仍为 true', async () => {
    resetMailbox();
    const crowd: string[] = [];
    for (let index = 0; index < 201; index += 1) crowd.push(`bystander-${index}@test.example`);
    crowd.push('fox@test.example');
    mailbox = [fakeMessage(1, { to: crowd, internal: '2026-07-27T14:59:00.000Z' })];

    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: ['fox@test.example'],
    });
    expect(result.partial).toBe(true);
    expect([...result.incompleteFor]).toEqual([]);
    expect(result.records[0]!.r).toContain('fox@test.example');
    expect(result.records[0]!.r).toHaveLength(200);

    const { app, cookie } = makeApp({
      listIdentities: () => [identities[0]!],
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);
    expect(body.scan.partial).toBe(true);
    expect(body.addresses[0]).toMatchObject({ complete: true, count: 1 });
    expect(body.totals.exact).toBe(true);
    expect(body.totals.unmatchedInWindow).toBe(0);
  });

  test('②单封 201 个身份收件人：第 201 个被记名、该行只给下界', async () => {
    resetMailbox();
    const crowd: string[] = [];
    for (let index = 0; index < 201; index += 1) crowd.push(`ident-${index}@test.example`);
    mailbox = [fakeMessage(1, { to: crowd })];

    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: crowd,
    });
    expect(result.records[0]!.r).toHaveLength(200);
    expect([...result.incompleteFor]).toEqual(['ident-200@test.example']);
    expect(result.partial).toBe(true);

    const roster = crowd.map((address) => ({ address, createdAt: '2026-07-01T00:00:00.000Z' }));
    const { app, cookie } = makeApp({
      listIdentities: () => roster,
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);
    const sacrificed = body.addresses.find((row) => row.address === 'ident-200@test.example')!;
    expect(sacrificed.complete).toBe(false);
    expect(sacrificed.count).toBe(0);
    expect(body.totals.exact).toBe(false);
    expect(body.totals.unmatchedInWindow).toBeNull();
    expect(body.addresses.filter((row) => !row.complete)).toHaveLength(1);
  });

  test('③6,000 个地址分布在 30 封上：全局上限生效，晚到的身份仍完整保留', async () => {
    resetMailbox();
    const late = 'late-comer@test.example';
    mailbox = [];
    let serial = 0;
    for (let index = 0; index < 30; index += 1) {
      const recipients: string[] = [];
      for (let slot = 0; slot < 200; slot += 1) {
        recipients.push(`bulk-${serial}@test.example`);
        serial += 1;
      }
      // 夹具安排一个身份直到第 30 封才首次出现
      if (index === 29) recipients[0] = late;
      mailbox.push(fakeMessage(index + 1, { to: recipients, internal: '2026-07-27T14:00:00.000Z' }));
    }

    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: [late],
    });
    const keys = new Set<string>();
    for (const record of result.records) for (const address of record.r) keys.add(address);
    expect(keys.size).toBeLessThanOrEqual(5000);
    expect(result.partial).toBe(true);
    // 投机地址被丢弃不记名，所以集合只可能装身份
    expect([...result.incompleteFor]).toEqual([]);
    expect(keys.has(late)).toBe(true);

    const { app, cookie } = makeApp({
      listIdentities: () => [{ address: late, createdAt: '2026-07-01T00:00:00.000Z' }],
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);
    expect(body.addresses[0]).toMatchObject({ complete: true, count: 1 });
    expect(body.totals.exact).toBe(true);
  });

  test('④外域收件人不进快照', async () => {
    resetMailbox();
    mailbox = [
      fakeMessage(1, { to: ['fox@test.example', 'someone@gmail.com', 'other@elsewhere.net'] }),
    ];
    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: ['fox@test.example'],
    });
    expect(result.records[0]!.r).toEqual(['fox@test.example']);
    expect(result.partial).toBe(false);
  });

  test('⑤身份总数超过全局上限时，超出的身份被记名且其行不完整', async () => {
    resetMailbox();
    const roster = ['a@test.example', 'b@test.example', 'c@test.example'];
    mailbox = [fakeMessage(1, { to: roster })];
    const result = await scanMailboxWindow({
      signal: new AbortController().signal,
      identityAddresses: roster,
      totalKeyMax: 2,
    });
    expect([...result.incompleteFor]).toEqual(['c@test.example']);
    expect(result.partial).toBe(true);

    const { app, cookie } = makeApp({
      listIdentities: () => roster.map((address) => ({ address, createdAt: '2026-07-01T00:00:00.000Z' })),
      getMailboxScan: async () => readyOutcome(makeSnapshot(result.records, result)),
    });
    const body = await overviewJson(app, cookie);
    expect(body.addresses.map((row) => row.complete)).toEqual([true, true, false]);
    expect(body.totals.exact).toBe(false);
    expect(body.totals.unmatchedInWindow).toBeNull();
  });

  test('⑥partial 快照下扫描后才建的身份不完整，完整快照下则显示真实的 0', async () => {
    const records: ScanRecord[] = [{ t: T0 - 1000, s: false, r: ['fox@test.example'] }];
    const partial = makeSnapshot(records, {
      partial: true,
      identityAddressesAtScan: ['fox@test.example'],
    });
    const shared = { listIdentities: () => identities };

    const dirty = makeApp({ ...shared, getMailboxScan: async () => readyOutcome(partial) });
    const dirtyBody = await overviewJson(dirty.app, dirty.cookie);
    expect(dirtyBody.addresses[1]).toMatchObject({
      address: 'owl@test.example',
      complete: false,
      count: 0,
    });
    expect(dirtyBody.totals.exact).toBe(false);
    expect(dirtyBody.totals.unmatchedInWindow).toBeNull();

    const clean = makeApp({
      ...shared,
      getMailboxScan: async () =>
        readyOutcome(makeSnapshot(records, { identityAddressesAtScan: ['fox@test.example'] })),
    });
    const cleanBody = await overviewJson(clean.app, clean.cookie);
    expect(cleanBody.addresses[1]).toMatchObject({ complete: true, count: 0 });
    expect(cleanBody.totals.exact).toBe(true);
  });

  // A38
  test('activeAddresses 与 recentSince 按响应时刻重算', async () => {
    const snapshot = makeSnapshot([
      { t: T0 - 60_000, s: false, r: ['fox@test.example'] },
      { t: T0 - 120_000, s: false, r: ['owl@test.example'] },
    ]);
    const fresh = makeApp({ getMailboxScan: async () => readyOutcome(snapshot, { now: T0 }) });
    const freshBody = await overviewJson(fresh.app, fresh.cookie);
    expect(freshBody.totals.activeAddresses).toBe(2);
    expect(freshBody.totals.recentSince).toBe(new Date(T0 - 24 * HOUR).toISOString());

    const later = makeApp({
      getMailboxScan: async () => readyOutcome(snapshot, { now: T0 + 25 * HOUR }),
    });
    const laterBody = await overviewJson(later.app, later.cookie);
    expect(laterBody.totals.activeAddresses).toBe(0);
    expect(laterBody.totals.recentSince).toBe(new Date(T0 + HOUR).toISOString());
  });
});

/* ============================ E. 缓存状态机 ============================ */

describe('Overview 缓存状态机', () => {
  // A39
  test('新鲜期内命中缓存，跨过新鲜期才重扫', async () => {
    const bench = harness();
    expect((await bench.ask()).kind).toBe('ready');
    expect(bench.scans).toBe(1);

    bench.at(14_999);
    const cached = await bench.ask();
    expect(cached.kind).toBe('ready');
    expect(cached.kind === 'ready' && cached.cached).toBe(true);
    expect(bench.scans).toBe(1);

    bench.at(15_001);
    await bench.ask();
    expect(bench.scans).toBe(2);
  });

  // A40
  test('单飞：5 个并发冷请求只开一次扫描，峰值并发为 1', async () => {
    const bench = harness({ scan: async () => (await delay(20), scanResult()) });
    const outcomes = await Promise.all([
      bench.ask(),
      bench.ask(),
      bench.ask(),
      bench.ask(),
      bench.ask(),
    ]);
    expect(outcomes.every((outcome) => outcome.kind === 'ready')).toBe(true);
    expect(bench.scans).toBe(1);
    expect(bench.peak).toBe(1);
  });

  // A41：分支顺序，逐个年龄点直断
  test('强制刷新只受 5 s 地板约束，不受 15 s 新鲜期约束', async () => {
    async function seeded(ageMs: number) {
      const bench = harness();
      await bench.ask();
      bench.at(ageMs);
      return bench;
    }

    const floored = await seeded(3000);
    const flooredOutcome = await floored.ask(true);
    expect(floored.scans).toBe(1);
    expect(flooredOutcome.kind === 'ready' && flooredOutcome.cached).toBe(true);

    const forced = await seeded(8000);
    await forced.ask(true);
    expect(forced.scans).toBe(2);

    const quiet = await seeded(8000);
    const quietOutcome = await quiet.ask();
    expect(quiet.scans).toBe(1);
    expect(quietOutcome.kind === 'ready' && quietOutcome.cached).toBe(true);

    const expired = await seeded(20_000);
    await expired.ask();
    expect(expired.scans).toBe(2);
  });

  // A42
  test('stale 立刻返回并在后台刷新，revalidating 反映真有在途扫描', async () => {
    let release = () => {};
    const bench = harness({
      scan: () =>
        new Promise((resolve) => {
          release = () => resolve(scanResult());
        }),
    });
    const first = bench.ask();
    release();
    await first;
    expect(bench.scans).toBe(1);

    bench.at(20_000);
    const stale = await bench.ask();
    expect(stale.kind).toBe('stale');
    expect(stale.kind === 'stale' && stale.revalidating).toBe(true);
    expect(stale.kind === 'stale' && stale.cached).toBe(true);
    expect(bench.scans).toBe(2);
    release();
    await delay(5);
  });

  // A43
  test('上一次刷新失败后，下一次 stale 响应带 refreshError', async () => {
    let fail = false;
    const bench = harness({
      scan: async () => {
        if (fail) throw new Error('imap down');
        return scanResult();
      },
    });
    await bench.ask();
    fail = true;
    bench.at(20_000);
    await bench.ask();
    await delay(5);

    const second = await bench.ask();
    expect(second.kind).toBe('stale');
    expect(second.kind === 'stale' && second.refreshError).toBe(true);
    expect(second.kind === 'stale' && second.revalidating).toBe(false);
  });

  // A44
  test('冷启动扫描没在预算内完成 → 202 loading，且期间只有一次扫描', async () => {
    const bench = harness({
      scan: () => new Promise(() => {}),
      responseBudgetMs: 60,
      scanDeadlineMs: 5000,
    });
    const outcome = await bench.ask();
    expect(outcome.kind).toBe('loading');
    expect(outcome.kind === 'loading' && outcome.retryAfterMs).toBe(1000);
    expect(bench.scans).toBe(1);

    const second = await bench.ask();
    expect(second.kind).toBe('loading');
    expect(bench.scans).toBe(1);
  });

  // A44b：失败冷却
  test('失败后进入冷却：连续请求最多再扫一次，?refresh=1 也不例外', async () => {
    let fail = false;
    const bench = harness({
      scan: async () => {
        if (fail) throw new Error('imap down');
        return scanResult();
      },
      freshMs: 1000,
      // 地板设小，好让 ?refresh=1 越过它、真正撞上失败冷却这一关
      refreshFloorMs: 100,
      failureCooldownMs: 5000,
    });
    await bench.ask();
    expect(bench.scans).toBe(1);

    fail = true;
    bench.at(2000);
    const first = await bench.ask();
    expect(first.kind).toBe('stale');
    await delay(5);
    expect(bench.scans).toBe(2);

    for (let step = 1; step < 10; step += 1) {
      bench.at(2000 + step * 200);
      const outcome = await bench.ask(step % 3 === 0);
      expect(outcome.kind).toBe('stale');
      expect(outcome.kind === 'stale' && outcome.revalidating).toBe(false);
      expect(outcome.kind === 'stale' && outcome.refreshError).toBe(true);
      const remaining = 7000 - (2000 + step * 200);
      expect(outcome.kind === 'stale' && outcome.retryAfterMs).toBe(Math.max(remaining, 1500));
      await delay(2);
    }
    // ①总扫描次数 ≤2（第一次成功 + 冷却前的那一次失败）
    expect(bench.scans).toBe(2);

    // ④冷却结束后下一次请求正常开新扫描
    fail = false;
    bench.at(7000);
    await bench.ask();
    await delay(5);
    expect(bench.scans).toBe(3);

    // ⑤成功一次后冷却归零：立刻再要 stale 也会起新 flight
    bench.at(9000);
    const revalidating = await bench.ask();
    expect(revalidating.kind === 'stale' && revalidating.revalidating).toBe(true);
    expect(revalidating.kind === 'stale' && revalidating.refreshError).toBe(false);
    expect(bench.scans).toBe(4);
    await delay(5);
  });

  // A45
  test('无快照 + 扫描 reject → 503 imap_unavailable', async () => {
    const bench = harness({
      scan: async () => {
        throw new Error('imap down');
      },
    });
    const outcome = await bench.ask();
    expect(outcome.kind).toBe('unavailable');
    expect(outcome.kind === 'unavailable' && outcome.reason).toBe('imap_unavailable');
  });

  // A46
  test('快照超过硬过期且 IMAP 正常 → 走 202 再到 ready，不闪旧值', async () => {
    let release = () => {};
    const bench = harness({
      scan: () =>
        new Promise((resolve) => {
          release = () => resolve(scanResult());
        }),
      responseBudgetMs: 40,
    });
    const first = bench.ask();
    release();
    await first;

    bench.at(11 * 60_000);
    const loading = await bench.ask();
    expect(loading.kind).toBe('loading');
    release();
    await delay(10);

    const ready = await bench.ask();
    expect(ready.kind).toBe('ready');
    expect(bench.scans).toBe(2);
  });

  // A46b：硬过期快照不得被失败刷新复活
  test('硬过期 + 刷新失败一律 503，随后一次成功才回 ready', async () => {
    for (const mode of ['reject', 'deadline'] as const) {
      let fail = true;
      const bench = harness({
        scan: async (opts) => {
          if (!fail) return scanResult();
          if (mode === 'reject') throw new Error('imap down');
          return new Promise<MailboxScanResult>((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('scan_aborted')), {
              once: true,
            });
          });
        },
        scanDeadlineMs: 60,
        responseBudgetMs: 2000,
      });
      await ((): Promise<void> => {
        fail = false;
        return bench.ask().then(() => {
          fail = true;
        });
      })();

      bench.at(11 * 60_000);
      const outcome = await bench.ask();
      expect(outcome.kind).toBe('unavailable');
      expect(outcome.kind === 'unavailable' && outcome.reason).toBe(
        mode === 'reject' ? 'imap_unavailable' : 'scan_timeout',
      );
      // 响应体里不含旧快照的任何数值
      expect(JSON.stringify(outcome)).not.toContain('records');

      fail = false;
      bench.advance(6000);
      const revived = await bench.ask();
      expect(revived.kind).toBe('ready');
      expect(revived.kind === 'ready' && revived.cached).toBe(false);
    }
  });

  // A47：截止时间覆盖 connect 与 fetch 两个阶段
  test('connect 与 fetch 两段 stall 都在截止时间被真取消', async () => {
    class ConnectStallClient {
      closeCalls = 0;
      rejectConnect: ((error: Error) => void) | null = null;
      connect() {
        return new Promise<void>((_resolve, reject) => {
          this.rejectConnect = reject;
        });
      }
      async getMailboxLock() {
        return { release() {} };
      }
      async search() {
        return [];
      }
      async *fetch() {}
      async logout() {}
      close() {
        this.closeCalls += 1;
        const reject = this.rejectConnect;
        // 真实的 close() 会让在途 connect() reject —— 但不一定同步，
        // 所以这里也留出一个 tick，好让 inFlight 的清理时机可被观察。
        if (reject) setTimeout(() => reject(new Error('closed during connect')), 20);
      }
    }

    class FetchStallClient {
      closeCalls = 0;
      rejectFetch: ((error: Error) => void) | null = null;
      async connect() {}
      async getMailboxLock() {
        return { release() {} };
      }
      async search() {
        return [1];
      }
      fetch() {
        const self = this;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise((_resolve, reject) => {
                  self.rejectFetch = reject;
                });
              },
            };
          },
        };
      }
      async logout() {}
      close() {
        this.closeCalls += 1;
        const reject = this.rejectFetch;
        if (reject) setTimeout(() => reject(new Error('closed during fetch')), 20);
      }
    }

    for (const stall of ['connect', 'fetch'] as const) {
      resetMailbox();
      const client = stall === 'connect' ? new ConnectStallClient() : new FetchStallClient();
      let aborts = 0;
      let scans = 0;
      const startedAt = Date.now();
      const SCAN_DEADLINE_MS = 200;
      const cache = createOverviewCache({
        scan: (opts) => {
          scans += 1;
          opts.signal.addEventListener('abort', () => {
            aborts += 1;
          });
          return scanMailboxWindow({
            ...opts,
            createClient: () => client as unknown as ImapFlow,
          });
        },
        clock: () => T0,
        scanDeadlineMs: SCAN_DEADLINE_MS,
        responseBudgetMs: 2000,
      });

      const first = cache.getOverview({ refresh: false, identityAddresses: ADDRESSES });
      // ⓓ底层还没 settle 时的第二次请求不得开出第二次扫描
      await delay(SCAN_DEADLINE_MS + 10);
      const second = await cache.getOverview({ refresh: false, identityAddresses: ADDRESSES });
      const outcome = await first;

      expect(aborts).toBe(1);
      expect(client.closeCalls).toBe(1);
      expect(outcome.kind).toBe('unavailable');
      expect(outcome.kind === 'unavailable' && outcome.reason).toBe('scan_timeout');
      expect(second.kind).toBe('unavailable');
      expect(scans).toBe(1);
      // ⓔ整个用例在截止时间 + 1 s 内结束，证明 30 s socket 超时没参与
      expect(Date.now() - startedAt).toBeLessThan(SCAN_DEADLINE_MS + 1000);
    }
  });

  // A48
  test('迟到的结果不写回，且 .catch 不会把同一次失败的冷却延长第二次', async () => {
    for (const late of ['resolve', 'reject'] as const) {
      let settle = () => {};
      const bench = harness({
        scan: () =>
          new Promise<MailboxScanResult>((resolve, reject) => {
            settle = () =>
              late === 'resolve' ? resolve(scanResult()) : reject(new Error('too late'));
          }),
        scanDeadlineMs: 60,
        responseBudgetMs: 120,
        failureCooldownMs: 5000,
      });

      const first = await bench.ask();
      expect(first.kind).toBe('loading');
      await delay(80);
      settle();
      await delay(20);

      // 迟到结果没装上快照，超时态由截止回调写入
      const afterLate = await bench.ask();
      expect(afterLate.kind).toBe('unavailable');
      expect(afterLate.kind === 'unavailable' && afterLate.reason).toBe('scan_timeout');
      expect(afterLate.kind === 'unavailable' && afterLate.retryAfterSeconds).toBe(5);
      expect(bench.scans).toBe(1);

      // 冷却只被置过一次：原始冷却一到就能开新扫描
      bench.advance(5000);
      await bench.ask();
      expect(bench.scans).toBe(2);
      await delay(5);
      settle();
    }
  });

  // A49
  test('getOverview 在任何路径都不 reject，也不留下未处理的 rejection', async () => {
    let unhandled = 0;
    const counter = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', counter);
    try {
      const rejecting = harness({
        scan: async () => {
          throw new Error('imap down');
        },
      });
      const timing = harness({
        scan: (opts) =>
          new Promise<MailboxScanResult>((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('scan_aborted')), {
              once: true,
            });
          }),
        scanDeadlineMs: 40,
        responseBudgetMs: 400,
      });
      const outcomes = await Promise.all([
        rejecting.ask(),
        rejecting.ask(true),
        timing.ask(),
        harness().ask(),
      ]);
      expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
        'ready',
        'unavailable',
        'unavailable',
        'unavailable',
      ]);
      await delay(50);
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', counter);
    }
  });

  // A50
  test('每个 flight 的截止定时器都在 settle 之后被清掉', async () => {
    const SCAN_DEADLINE_MS = 4321;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const deadlines = new Map<unknown, { cleared: boolean; fired: boolean }>();
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      let id: unknown;
      const tracked = ms === SCAN_DEADLINE_MS;
      const wrapped = tracked
        ? () => {
            const entry = deadlines.get(id);
            if (entry) entry.fired = true;
            handler();
          }
        : handler;
      id = (realSetTimeout as unknown as (...args: unknown[]) => unknown)(wrapped, ms, ...rest);
      if (tracked) deadlines.set(id, { cleared: false, fired: false });
      return id;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      const entry = deadlines.get(id);
      if (entry) entry.cleared = true;
      (realClearTimeout as unknown as (value: unknown) => void)(id);
    }) as unknown as typeof globalThis.clearTimeout;

    try {
      const bench = harness({ scanDeadlineMs: SCAN_DEADLINE_MS });
      for (let round = 0; round < 3; round += 1) {
        bench.at(round * 20_000);
        await bench.ask();
        await delay(2);
      }
      expect(bench.scans).toBe(3);
      expect(deadlines.size).toBe(3);
      for (const entry of deadlines.values()) {
        expect(entry.cleared).toBe(true);
        expect(entry.fired).toBe(false);
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  // A49 / A50：同步 throw 的扫描函数（注入依赖完全可以是同步实现）
  test('同步抛错的扫描不会让 getOverview reject，也不会遗留截止定时器', async () => {
    const SCAN_DEADLINE_MS = 7654;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const deadlines = new Map<unknown, { cleared: boolean; fired: boolean }>();
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      let id: unknown;
      const tracked = ms === SCAN_DEADLINE_MS;
      const wrapped = tracked
        ? () => {
            const entry = deadlines.get(id);
            if (entry) entry.fired = true;
            handler();
          }
        : handler;
      id = (realSetTimeout as unknown as (...args: unknown[]) => unknown)(wrapped, ms, ...rest);
      if (tracked) deadlines.set(id, { cleared: false, fired: false });
      return id;
    }) as unknown as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id: unknown) => {
      const entry = deadlines.get(id);
      if (entry) entry.cleared = true;
      (realClearTimeout as unknown as (value: unknown) => void)(id);
    }) as unknown as typeof globalThis.clearTimeout;

    let unhandled = 0;
    const counter = () => {
      unhandled += 1;
    };
    process.on('unhandledRejection', counter);
    try {
      let calls = 0;
      const cache = createOverviewCache({
        // 同步 throw：既没有 async 包装，也没有返回 Promise
        scan: () => {
          calls += 1;
          throw new Error('sync boom');
        },
        clock: () => T0,
        scanDeadlineMs: SCAN_DEADLINE_MS,
        responseBudgetMs: 500,
        failureCooldownMs: 5000,
      });

      // ①不 reject：走的是正常的 unavailable 出口
      const outcome = await cache.getOverview({ refresh: false, identityAddresses: ADDRESSES });
      expect(outcome.kind).toBe('unavailable');
      expect(outcome.kind === 'unavailable' && outcome.reason).toBe('imap_unavailable');
      expect(outcome.kind === 'unavailable' && outcome.retryAfterSeconds).toBe(5);
      expect(calls).toBe(1);

      // ②截止定时器已被 finally 清掉，永远不会烧到 9 s 后才触发
      expect(deadlines.size).toBe(1);
      for (const entry of deadlines.values()) {
        expect(entry.cleared).toBe(true);
        expect(entry.fired).toBe(false);
      }

      // ③失败照常进冷却：期间不再起新扫描，且仍然不 reject
      const cooling = await cache.getOverview({ refresh: true, identityAddresses: ADDRESSES });
      expect(cooling.kind).toBe('unavailable');
      expect(calls).toBe(1);

      // ④没有未处理的 rejection
      await delay(20);
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', counter);
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  // A50b：单一时钟域
  test('整条链路只用注入的时钟，真实 Date.now 拨快一小时也影响不到它', async () => {
    // 注入的时钟永远落后真实时间一小时
    const frozen = Date.now() - HOUR;
    let fail = false;
    let scans = 0;
    const cache = createOverviewCache({
      scan: async () => {
        scans += 1;
        if (fail) throw new Error('imap down');
        return scanResult([{ t: frozen - 30_000, s: false, r: ['fox@test.example'] }]);
      },
      clock: () => frozen,
      responseBudgetMs: 5000,
      failureCooldownMs: 5000,
    });
    const { app, cookie } = makeApp({
      listIdentities: () => [identities[0]!],
      getMailboxScan: (opts) => cache.getOverview(opts),
    });

    // ①scannedAt 由缓存层用注入时钟盖章 → generatedAt 与 ageSeconds 都在假时钟域里
    const body = await overviewJson(app, cookie);
    expect(body.generatedAt).toBe(new Date(frozen).toISOString());
    expect(body.ageSeconds).toBe(0);
    // ④recentSince 也基于 outcome.now
    expect(body.totals.recentSince).toBe(new Date(frozen - 24 * HOUR).toISOString());

    // ②③失败时间戳与 nextRetryAt 同样只来自注入时钟：真实时钟会让 5 s 变成 3605 s
    fail = true;
    const failing = createOverviewCache({
      scan: async () => {
        throw new Error('imap down');
      },
      clock: () => frozen,
      responseBudgetMs: 5000,
      failureCooldownMs: 5000,
    });
    const failed = await failing.getOverview({ refresh: false, identityAddresses: ADDRESSES });
    expect(failed.kind === 'unavailable' && failed.retryAfterSeconds).toBe(5);
    expect(scans).toBe(1);

    // ⑤源码断言：overview-cache.ts 里 Date.now() 只允许出现在 clock 的默认值处，
    //    scanMailboxWindow 所在片段中为 0
    const cacheSource = await Bun.file(
      new URL('../src/lib/overview-cache.ts', import.meta.url),
    ).text();
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const cacheHits = stripComments(cacheSource).match(/Date\.now\(\)/g) ?? [];
    expect(cacheHits).toHaveLength(1);
    expect(cacheSource).toContain('deps.clock ?? (() => Date.now())');

    const imapSource = await Bun.file(new URL('../src/lib/imap.ts', import.meta.url)).text();
    const scanStart = imapSource.indexOf('export async function scanMailboxWindow');
    const scanEnd = imapSource.indexOf('function formatAddresses');
    expect(scanStart).toBeGreaterThan(-1);
    expect(scanEnd).toBeGreaterThan(scanStart);
    expect(stripComments(imapSource.slice(scanStart, scanEnd))).not.toContain('Date.now()');

    // ⑥公开签名里都没有 now 尾参
    expect(cache.getOverview.length).toBe(1);
    expect(cacheSource).not.toMatch(/getOverview\([^)]*now/);
  });
});
