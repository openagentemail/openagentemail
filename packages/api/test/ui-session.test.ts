import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Auth } from '../src/lib/auth.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  uiSessionAuth,
  uiSessionBodyLimit,
  requireUiOrigin,
} from '../src/lib/ui-session.ts';

const adminResolver = (token: string): Auth | null =>
  token === 'valid-admin' ? { kind: 'admin' } : null;

function makeApp(store = new UiSessionStore({ resolveToken: adminResolver })) {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(store));
  app.get('/ui/api/private', uiSessionAuth(store), (c) => c.json({ auth: c.get('auth') }));
  return app;
}

function login(app: Hono, token: string, url = 'http://localhost/ui/api/session') {
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
