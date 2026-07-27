import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { Auth } from '../src/lib/auth.ts';
import type { UiApiDependencies } from '../src/routes/ui.ts';
import type { UiFrameDependencies } from '../src/routes/ui-frame.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { bearerAuth } = await import('../src/lib/auth.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');

const identities = [
  {
    address: 'fox@test.example',
    name: 'Fox',
    createdAt: '2026-07-27T00:00:00.000Z',
    tokenHash: 'must-never-leak',
  },
  {
    address: 'owl@test.example',
    createdAt: '2026-07-27T00:01:00.000Z',
  },
];

function dependencies(): UiApiDependencies {
  return {
    listIdentities: mock(() => identities),
    listMessages: mock(async () => []),
    getMessage: mock(async () => null),
    getMailboxScan: mock(async () => ({
      kind: 'ready' as const,
      now: Date.now(),
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    })),
  };
}

function authenticatedApp(auth: Auth, deps = dependencies()) {
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'session-token' ? auth : null),
  });
  const created = store.create('session-token', '127.0.0.1', Date.now());
  if (!created.ok) throw new Error('test session was not created');

  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  return { app, cookie: `oae_ui=${created.sid}`, deps };
}

describe('UI authorization boundaries', () => {
  test('admin sees projected identities without internal token fields', async () => {
    const { app, cookie } = authenticatedApp({ kind: 'admin' });
    const response = await app.request('/ui/api/identities', {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      identities: [
        {
          address: 'fox@test.example',
          name: 'Fox',
          createdAt: '2026-07-27T00:00:00.000Z',
        },
        {
          address: 'owl@test.example',
          createdAt: '2026-07-27T00:01:00.000Z',
        },
      ],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization, Cookie');
  });

  test('identity sees only itself and cannot read another inbox', async () => {
    const deps = dependencies();
    const { app, cookie } = authenticatedApp(
      { kind: 'identity', address: 'fox@test.example' },
      deps,
    );

    const identityResponse = await app.request('/ui/api/identities', {
      headers: { cookie },
    });
    const identityBody = (await identityResponse.json()) as {
      identities: unknown[];
    };
    expect(identityBody.identities).toEqual([
      {
        address: 'fox@test.example',
        name: 'Fox',
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ]);

    const denied = await app.request(
      '/ui/api/messages?address=owl%40test.example',
      { headers: { cookie } },
    );
    expect(denied.status).toBe(403);
    expect(deps.listMessages).not.toHaveBeenCalled();
  });

  test('admin may read any inbox while identity may read its own', async () => {
    for (const auth of [
      { kind: 'admin' } as const,
      { kind: 'identity', address: 'fox@test.example' } as const,
    ]) {
      const deps = dependencies();
      const { app, cookie } = authenticatedApp(auth, deps);
      const response = await app.request(
        '/ui/api/messages?address=fox%40test.example',
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      expect(deps.listMessages).toHaveBeenCalledWith('fox@test.example', 50);
    }
  });

  test('the REST and UI credential entrances never cross', async () => {
    const { app: uiApp, cookie } = authenticatedApp({ kind: 'admin' });
    const bearerAgainstUi = await uiApp.request('/ui/api/me', {
      headers: { authorization: 'Bearer session-token' },
    });
    expect(bearerAgainstUi.status).toBe(401);
    expect(await bearerAgainstUi.json()).toEqual({ error: 'invalid_token' });

    const restApp = new Hono();
    restApp.use('/v1/*', bearerAuth);
    restApp.get('/v1/probe', (c) => c.json({ auth: c.get('auth') }));
    const cookieAgainstRest = await restApp.request('/v1/probe', {
      headers: { cookie },
    });
    expect(cookieAgainstRest.status).toBe(401);
    expect(await cookieAgainstRest.json()).toEqual({ error: 'unauthorized' });
  });

  // A2 / A3 / A4：Overview 是 admin-only，且授权先于一切 I/O。
  test('an identity session is refused the overview before any I/O happens', async () => {
    for (const path of ['/ui/api/overview', '/ui/api/overview?refresh=1']) {
      const deps = dependencies();
      const { app, cookie } = authenticatedApp(
        { kind: 'identity', address: 'fox@test.example' },
        deps,
      );
      const response = await app.request(path, { headers: { cookie } });

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: 'forbidden: admin session required' });
      // 403 的响应体不得提到任何地址
      expect(body).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+/i);
      expect(deps.listIdentities).not.toHaveBeenCalled();
      expect(deps.getMailboxScan).not.toHaveBeenCalled();
    }
  });

  test('the overview is reachable for an admin session and never for a bearer token', async () => {
    const deps = dependencies();
    const { app, cookie } = authenticatedApp({ kind: 'admin' }, deps);

    const allowed = await app.request('/ui/api/overview', { headers: { cookie } });
    expect(allowed.status).toBe(200);
    expect(deps.getMailboxScan).toHaveBeenCalledTimes(1);

    // A9：Bearer 走 REST 入口，UI 入口只认 cookie
    const bearer = await app.request('/ui/api/overview', {
      headers: { authorization: 'Bearer admin-key' },
    });
    expect(bearer.status).toBe(401);
    expect(await bearer.json()).toEqual({ error: 'invalid_token' });

    const anonymous = await app.request('/ui/api/overview');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: 'invalid_token' });
  });

  test('frame authorization uses the same identity boundary', async () => {
    const { createUiFrameRoutes } = await import('../src/routes/ui-frame.ts');
    const store = new UiSessionStore({
      resolveToken: (token) =>
        token === 'frame-token'
          ? { kind: 'identity', address: 'fox@test.example' }
          : null,
    });
    const created = store.create('frame-token', '127.0.0.1');
    if (!created.ok) throw new Error('test session was not created');
    const deps: UiFrameDependencies = {
      getMessage: mock(async () => null),
    };
    const app = new Hono();
    app.route('/ui/frame', createUiFrameRoutes(store, deps));
    const response = await app.request(
      '/ui/frame/1?address=owl%40test.example',
      { headers: { cookie: `oae_ui=${created.sid}` } },
    );
    expect(response.status).toBe(403);
    expect(deps.getMessage).not.toHaveBeenCalled();
  });
});
