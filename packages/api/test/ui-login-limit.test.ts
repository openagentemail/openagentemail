// config.ts 在 import 时解析 env；裸 env 单跑会 ZodError/TDZ。套件标准前奏。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-login-limit-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
// 动态 import 的绑定是值；类型注解用 import() 类型查询，避免 TS2749
type HonoApp = import('hono').Hono;
type UiSessionStoreT = import('../src/lib/ui-session.ts').UiSessionStore;
const {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} = await import('../src/lib/ui-session.ts');

const anyToken = (_token: string): Auth => ({ kind: 'admin' });

function makeApp(store: UiSessionStoreT) {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(store));
  return app;
}

function login(app: HonoApp, token: string, extra: Record<string, unknown> = {}) {
  return app.request('http://localhost/ui/api/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ token, ...extra }),
  });
}

describe('UI login resource limits', () => {
  test('the unauthenticated body is rejected above 4 KiB before JSON parsing', async () => {
    const response = await makeApp(new UiSessionStore({ resolveToken: anyToken })).request(
      'http://localhost/ui/api/session',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
        },
        body: `{"token":"${'x'.repeat(4097)}"}`,
      },
    );
    expect(response.status).toBe(413);
  });

  test('only a strict JSON token up to 512 characters is accepted', async () => {
    const app = makeApp(new UiSessionStore({ resolveToken: anyToken }));
    expect((await login(app, 'x'.repeat(513))).status).toBe(400);
    expect((await login(app, 'ok', { padding: 'not allowed' })).status).toBe(400);

    const wrongType = await app.request('http://localhost/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'http://localhost',
        'sec-fetch-site': 'same-origin',
      },
      body: '{"token":"ok"}',
    });
    expect(wrongType.status).toBe(415);
  });

  test('failed-token buckets enforce the documented IP and global limits', () => {
    const store = new UiSessionStore({ resolveToken: () => null });
    for (let i = 0; i < 10; i++) {
      expect(store.create(`bad-${i}`, '192.0.2.1', i).reason).toBe('invalid_token');
    }
    expect(store.create('one-too-many', '192.0.2.1', 11).reason).toBe('rate_limited');

    const global = new UiSessionStore({ resolveToken: () => null });
    for (let i = 0; i < 60; i++) {
      expect(global.create(`bad-${i}`, `192.0.2.${i + 1}`, i).reason).toBe('invalid_token');
    }
    expect(global.create('global-over', '198.51.100.1', 61).reason).toBe('rate_limited');
  });

  test('a sixth login evicts the principal’s own least-recently-used session', () => {
    const store = new UiSessionStore({ resolveToken: anyToken });
    const sids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = store.create('same-token', `192.0.2.${i}`, i);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('expected a session');
      sids.push(created.sid);
      // Touch every session so lastSeenAt ordering is deterministic.
      expect(store.authenticate(created.sid, i + 1)).not.toBeNull();
    }

    const sixth = store.create('same-token', '192.0.2.99', 10);
    expect(sixth.ok).toBe(true);
    // The oldest session is gone; the other four are untouched.
    expect(store.authenticate(sids[0]!, 11)).toBeNull();
    for (const sid of sids.slice(1)) {
      expect(store.authenticate(sid, 11)).not.toBeNull();
    }
  });

  test('whitespace aliases resolve and share the same principal session budget', () => {
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'same-token' ? { kind: 'admin' } : null),
    });
    const sids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = store.create(`same-token${' '.repeat(i)}`, `192.0.2.${i}`, i);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('expected a session');
      sids.push(created.sid);
    }
    const sixth = store.create('\tsame-token\t', '192.0.2.99', 10);
    expect(sixth.ok).toBe(true);
    expect(store.authenticate(sids[0]!, 11)).toBeNull();
  });

  test('a full table never evicts another active session', () => {
    const store = new UiSessionStore({
      resolveToken: anyToken,
      maxSessions: 2,
      maxSessionsPerToken: 2,
    });
    const first = store.create('token-a', '192.0.2.1', 0);
    const second = store.create('token-b', '192.0.2.2', 0);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(store.create('token-c', '192.0.2.3', 0)).toEqual({
      ok: false,
      reason: 'capacity',
    });
    if (!first.ok || !second.ok) throw new Error('expected sessions');
    expect(store.authenticate(first.sid, 1)?.auth.kind).toBe('admin');
    expect(store.authenticate(second.sid, 1)?.auth.kind).toBe('admin');
  });
});
