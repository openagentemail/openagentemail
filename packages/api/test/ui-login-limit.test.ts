import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Auth } from '../src/lib/auth.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from '../src/lib/ui-session.ts';

const anyToken = (_token: string): Auth => ({ kind: 'admin' });

function makeApp(store: UiSessionStore) {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(store));
  return app;
}

function login(app: Hono, token: string, extra: Record<string, unknown> = {}) {
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

  test('one principal gets at most five active sessions', () => {
    const store = new UiSessionStore({ resolveToken: anyToken });
    for (let i = 0; i < 5; i++) {
      expect(store.create('same-token', `192.0.2.${i}`, i).ok).toBe(true);
    }
    expect(store.create('same-token', '192.0.2.99', 10)).toEqual({
      ok: false,
      reason: 'principal_limit',
    });
  });

  test('whitespace aliases resolve and count as the same token principal', () => {
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'same-token' ? { kind: 'admin' } : null),
    });
    for (let i = 0; i < 5; i++) {
      expect(store.create(`same-token${' '.repeat(i)}`, `192.0.2.${i}`, i).ok).toBe(true);
    }
    expect(store.create('\tsame-token\t', '192.0.2.99', 10)).toEqual({
      ok: false,
      reason: 'principal_limit',
    });
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
