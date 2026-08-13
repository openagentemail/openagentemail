// config.ts 在 import 时解析 env；裸 env 单跑会 ZodError/TDZ。套件标准前奏。
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-session-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
// 动态 import 的绑定是值；类型注解用 import() 类型查询，避免 TS2749
type HonoApp = import('hono').Hono;
type UiSessionStoreT = import('../src/lib/ui-session.ts').UiSessionStore;
const {
  UiSessionStore,
  createUiSessionRoutes,
  uiSessionAuth,
  uiSessionBodyLimit,
  requireUiOrigin,
} = await import('../src/lib/ui-session.ts');

const adminToken = 'valid-admin';
const adminTokenHash = createHash('sha256').update(adminToken).digest('hex');

const adminResolver = (token: string): Auth | null =>
  token === adminToken ? { kind: 'admin' } : null;

const adminHashResolver = (tokenHash: string): Auth | null =>
  tokenHash === adminTokenHash ? { kind: 'admin' } : null;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeApp(store: UiSessionStoreT = new UiSessionStore({ resolveToken: adminResolver })) {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(store));
  app.get('/ui/api/private', uiSessionAuth(store), (c) => c.json({ auth: c.get('auth') }));
  return app;
}

function login(app: HonoApp, token: string, url = 'http://localhost/ui/api/session') {
  return app.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: new URL(url).origin,
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ token }),
  });
}

function cookiePair(response: Response): string {
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

describe('UI session cookie', () => {
  test('valid login creates a host-only, HttpOnly, Strict session cookie', async () => {
    const response = await login(makeApp(), 'valid-admin');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'admin' });

    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('oae_ui=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/ui');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain('Max-Age=');
    expect(setCookie).not.toContain('Secure');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  test('non-local deployments always receive Secure cookies', async () => {
    const response = await login(makeApp(), 'valid-admin', 'https://mail.example/ui/api/session');
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  test('invalid tokens and forged cookies are stable 401s', async () => {
    const app = makeApp();
    const bad = await login(app, 'wrong-token');
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: 'invalid_token' });
    expect(bad.headers.get('set-cookie')).toBeNull();

    const forged = await app.request('http://localhost/ui/api/private', {
      headers: { cookie: 'oae_ui=forged' },
    });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'invalid_token' });
  });

  test('logout destroys the server session and expires the cookie', async () => {
    const app = makeApp();
    const created = await login(app, 'valid-admin');
    const cookie = cookiePair(created);

    const before = await app.request('http://localhost/ui/api/private', {
      headers: { cookie },
    });
    expect(before.status).toBe(200);

    const logout = await app.request('http://localhost/ui/api/session', {
      method: 'DELETE',
      headers: {
        cookie,
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');

    const after = await app.request('http://localhost/ui/api/private', {
      headers: { cookie },
    });
    expect(after.status).toBe(401);
  });

  test('logout is idempotent when no session cookie exists', async () => {
    const logout = await makeApp().request('http://localhost/ui/api/session', {
      method: 'DELETE',
      headers: {
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('idle refresh and absolute expiry use their exact time boundaries', () => {
    const store = new UiSessionStore({ resolveToken: adminResolver });
    const session = store.create('valid-admin', '127.0.0.1', 0);
    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error('expected a session');

    expect(store.authenticate(session.sid, 6 * 60 * 60 * 1000)).not.toBeNull();
    expect(store.authenticate(session.sid, 18 * 60 * 60 * 1000 - 1)).not.toBeNull();
    expect(store.authenticate(session.sid, 24 * 60 * 60 * 1000)).toBeNull();

    const idle = store.create('valid-admin', '127.0.0.1', 0);
    expect(idle.ok).toBe(true);
    if (!idle.ok) throw new Error('expected a session');
    expect(store.authenticate(idle.sid, 12 * 60 * 60 * 1000)).toBeNull();
  });

  test('remembered login sets a persistent 30-day cookie', async () => {
    const app = makeApp();
    const response = await app.request('https://mail.example/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://mail.example',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ token: 'valid-admin', remember: true }),
    });
    expect(response.status).toBe(200);

    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
  });

  test('a non-boolean remember flag is rejected', async () => {
    const response = await makeApp().request('http://localhost/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ token: 'valid-admin', remember: 'yes' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('remembered sessions use the 30-day sliding window instead of the short timeouts', () => {
    const store = new UiSessionStore({ resolveToken: adminResolver });
    const session = store.create('valid-admin', '127.0.0.1', 0, true);
    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error('expected a session');

    // Past the default 12h idle / 24h absolute limits a remembered session
    // is still alive, and activity keeps sliding the 30-day window.
    expect(store.authenticate(session.sid, 25 * 60 * 60 * 1000)).not.toBeNull();
    const lastSeen = 25 * 60 * 60 * 1000 + 30 * 24 * 60 * 60 * 1000 - 1;
    expect(store.authenticate(session.sid, lastSeen)).not.toBeNull();
    expect(store.authenticate(session.sid, lastSeen + 30 * 24 * 60 * 60 * 1000)).toBeNull();

    const idle = store.create('valid-admin', '127.0.0.1', 0, true);
    expect(idle.ok).toBe(true);
    if (!idle.ok) throw new Error('expected a session');
    expect(store.authenticate(idle.sid, 30 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  test('token rotation and deletion invalidate a session', () => {
    let tokenValid = true;
    const store = new UiSessionStore({
      resolveToken: () => (tokenValid ? { kind: 'identity', address: 'fox@test.example' } : null),
    });

    const rotated = store.create('token-b', '127.0.0.1', 1);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('expected a session');
    tokenValid = false;
    expect(store.authenticate(rotated.sid, 2)).toBeNull();
  });
});

describe('UI session persistence', () => {
  test('create → 落盘 → 新 store 加载后 authenticate 命中（tokenHash 反解）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-persist-'));
    const path = join(dir, 'ui-sessions.json');
    // 落盘时间戳须接近墙钟：构造加载用 Date.now()，过旧会被当过期清掉
    const t0 = Date.now();
    const storeA = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const created = storeA.create(adminToken, '127.0.0.1', t0, true);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');

    const storeB = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const auth = storeB.authenticate(created.sid, t0 + 60_000);
    expect(auth).not.toBeNull();
    expect(auth?.auth).toEqual({ kind: 'admin' });
  });

  test('落盘文件不含 raw token / sid，且权限为 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-mode-'));
    const path = join(dir, 'ui-sessions.json');
    const store = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const created = store.create(adminToken, '127.0.0.1', Date.now(), true);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');

    const raw = readFileSync(path, 'utf8');
    // 真实明文不得出现在落盘文件中
    expect(raw).not.toContain(adminToken);
    expect(raw).not.toContain(created.sid);
    expect(raw).toContain(adminTokenHash);
    expect(raw).toContain(sha256Hex(created.sid));

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('重启后 remembered 30d 滑动仍有效；非 remembered 仍受 24h absolute 约束', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-remember-'));
    const path = join(dir, 'ui-sessions.json');
    const t0 = Date.now();
    const writer = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const live = writer.create(adminToken, '127.0.0.1', t0, true);
    const stale = writer.create(adminToken, '127.0.0.2', t0, false);
    expect(live.ok && stale.ok).toBe(true);
    if (!live.ok || !stale.ok) throw new Error('expected sessions');

    // 模拟 api 重启：新 store 从同一文件加载（无明文 token）
    const reloaded = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    // remembered：越过默认 12h/24h 仍存活
    expect(reloaded.authenticate(live.sid, t0 + 25 * 60 * 60 * 1000)).not.toBeNull();
    // 非 remembered：24h absolute 到期
    expect(reloaded.authenticate(stale.sid, t0 + 25 * 60 * 60 * 1000)).toBeNull();
  });

  test('过期条目在启动加载时清除并写回磁盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-loadprune-'));
    const path = join(dir, 'ui-sessions.json');
    const seed = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const old = seed.create(adminToken, '127.0.0.1', 0, true);
    expect(old.ok).toBe(true);
    if (!old.ok) throw new Error('expected a session');

    // lastSeenAt=0 + remembered → 自 epoch 起已远超 30d，Date.now() 加载即过期
    const disk = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      { tokenHash: string; createdAt: number; lastSeenAt: number; remembered: boolean }
    >;
    for (const row of Object.values(disk)) {
      row.lastSeenAt = 0;
      row.createdAt = 0;
    }
    writeFileSync(path, JSON.stringify(disk, null, 2));

    const pruned = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    expect(pruned.sizeForTests()).toBe(0);
    expect(pruned.authenticate(old.sid, Date.now())).toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });

  test('lastSeenAt 节流：间隔内不落盘，越过间隔才写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-throttle-'));
    const path = join(dir, 'ui-sessions.json');
    const interval = 60_000;
    const t0 = Date.now();
    const store = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
      lastSeenPersistIntervalMs: interval,
    });
    const created = store.create(adminToken, '127.0.0.1', t0, true);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');

    const afterCreate = readFileSync(path, 'utf8');
    expect(store.authenticate(created.sid, t0 + 1_000)).not.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(afterCreate); // 节流内未写

    expect(store.authenticate(created.sid, t0 + interval)).not.toBeNull();
    const afterThrottle = readFileSync(path, 'utf8');
    expect(afterThrottle).not.toBe(afterCreate);
    expect(afterThrottle).toContain(`"lastSeenAt": ${t0 + interval}`);
  });

  test('文件不存在的 loadFromDisk 也设置 lastSeenPersistedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-missing-'));
    const path = join(dir, 'ui-sessions.json');
    expect(existsSync(path)).toBe(false);
    const store = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    expect(store.lastSeenPersistedAtForTests()).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
  });

  test('不走 create：从磁盘加载后间隔内 authenticate 不落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-reload-throttle-'));
    const path = join(dir, 'ui-sessions.json');
    const interval = 60_000;
    const t0 = Date.now();
    const writer = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
      lastSeenPersistIntervalMs: interval,
    });
    const created = writer.create(adminToken, '127.0.0.1', t0, true);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');
    const afterCreate = readFileSync(path, 'utf8');

    // 新 store 只 loadFromDisk，不走 create；节流时钟应已钉住
    const reloaded = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
      lastSeenPersistIntervalMs: interval,
    });
    expect(reloaded.lastSeenPersistedAtForTests()).toBeGreaterThan(0);
    expect(reloaded.authenticate(created.sid, t0 + 1_000)).not.toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(afterCreate);
  });

  test('启动时清理 ui-sessions.json.tmp 残留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-tmp-'));
    const path = join(dir, 'ui-sessions.json');
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, '{"stale":true}', { mode: 0o600 });
    expect(existsSync(tmp)).toBe(true);
    new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    expect(existsSync(tmp)).toBe(false);
  });

  test('持久化后 LRU / 容量语义不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-lru-'));
    const path = join(dir, 'ui-sessions.json');
    const t0 = Date.now();
    const store = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
      maxSessions: 3,
      maxSessionsPerToken: 2,
    });
    const a = store.create(adminToken, '127.0.0.1', t0);
    const b = store.create(adminToken, '127.0.0.2', t0 + 1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('expected sessions');
    // 同 principal 第 3 个：驱逐最旧 a
    const c = store.create(adminToken, '127.0.0.3', t0 + 2);
    expect(c.ok).toBe(true);
    expect(store.authenticate(a.sid, t0 + 3)).toBeNull();
    expect(store.authenticate(b.sid, t0 + 3)).not.toBeNull();

    // 重启后容量/驱逐结果仍在盘上
    const reloaded = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
      maxSessions: 3,
      maxSessionsPerToken: 2,
    });
    expect(reloaded.sizeForTests()).toBe(2);
    expect(reloaded.authenticate(a.sid, t0 + 4)).toBeNull();
    expect(reloaded.authenticate(b.sid, t0 + 4)).not.toBeNull();
    if (!c.ok) throw new Error('expected c');
    expect(reloaded.authenticate(c.sid, t0 + 4)).not.toBeNull();
  });

  test('destroy 必落盘；缺 resolveTokenHash 时重启后无法 authenticate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-destroy-'));
    const path = join(dir, 'ui-sessions.json');
    const t0 = Date.now();
    const store = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const created = store.create(adminToken, '127.0.0.1', t0);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');
    store.destroy(created.sid);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});

    const again = new UiSessionStore({
      resolveToken: adminResolver,
      resolveTokenHash: adminHashResolver,
      persistPath: path,
    });
    const live = again.create(adminToken, '127.0.0.1', t0 + 1_000);
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error('expected a session');

    const noHash = new UiSessionStore({
      resolveToken: adminResolver,
      persistPath: path,
    });
    expect(noHash.authenticate(live.sid, t0 + 1_001)).toBeNull();
  });

  test('损坏的 ui-sessions.json fail-closed：抛错且不装入空库冒充成功', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-corrupt-'));
    const path = join(dir, 'ui-sessions.json');
    writeFileSync(path, '{not-json', { mode: 0o600 });
    expect(
      () =>
        new UiSessionStore({
          resolveToken: adminResolver,
          resolveTokenHash: adminHashResolver,
          persistPath: path,
        }),
    ).toThrow('ui_session_store_corrupt');

    writeFileSync(path, JSON.stringify({ bad: { tokenHash: 1 } }, null, 2), { mode: 0o600 });
    expect(
      () =>
        new UiSessionStore({
          resolveToken: adminResolver,
          resolveTokenHash: adminHashResolver,
          persistPath: path,
        }),
    ).toThrow('ui_session_store_corrupt');
  });

  test('生产 resolveUiSessionTokenByHash：identity 命中；OAuth access hash 永不命中', async () => {
    const { createIdentity } = await import('../src/lib/identities.ts');
    const { resolveUiSessionToken, resolveUiSessionTokenByHash } = await import(
      '../src/lib/auth.ts'
    );
    const { putAccessTokenForTests } = await import('../src/lib/oauth-store.ts');

    const issued = createIdentity({ localpart: 'ui-sess-hash' })!;
    const idHash = sha256Hex(issued.token);
    expect(resolveUiSessionTokenByHash(idHash)).toEqual({
      kind: 'identity',
      address: 'ui-sess-hash@test.example',
    });
    expect(resolveUiSessionTokenByHash(sha256Hex('admin-key'))).toEqual({ kind: 'admin' });

    const oauthTok = 'ui-sess-byhash-must-reject-oauth!!!!';
    putAccessTokenForTests({
      token: oauthTok,
      grantId: 'g-ui-sess-byhash',
      address: 'ui-sess-hash@test.example',
      aud: 'http://localhost/mcp',
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: 'http://client.test/cid', clientName: 'X' },
    });
    // 与明文入口一致：即便 OAuth access 行存在，UI session ByHash 也不认
    expect(resolveUiSessionToken(oauthTok)).toBeNull();
    expect(resolveUiSessionTokenByHash(sha256Hex(oauthTok))).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), 'oae-ui-sess-id-'));
    const path = join(dir, 'ui-sessions.json');
    const t0 = Date.now();
    const storeA = new UiSessionStore({
      resolveToken: resolveUiSessionToken,
      resolveTokenHash: resolveUiSessionTokenByHash,
      persistPath: path,
    });
    const created = storeA.create(issued.token, '127.0.0.1', t0, true);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('expected a session');
    const storeB = new UiSessionStore({
      resolveToken: resolveUiSessionToken,
      resolveTokenHash: resolveUiSessionTokenByHash,
      persistPath: path,
    });
    expect(storeB.authenticate(created.sid, t0 + 1_000)?.auth).toEqual({
      kind: 'identity',
      address: 'ui-sess-hash@test.example',
    });
  });
});
