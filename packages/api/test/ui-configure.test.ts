/**
 * #26 PR 5：Configure 闭环的服务端契约。
 * 前端绕过 confirm_risk、identity 越权、OAuth 吊销即时生效都在这里钉死。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-configure-'));

const { describe, expect, mock, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
type Identity = import('../src/lib/identities.ts').Identity;
type PushContentTier = import('../src/lib/identities.ts').PushContentTier;
type UiApiDependencies = import('../src/routes/ui.ts').UiApiDependencies;

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createUiOAuthApiRoutes, createUiOAuthPageRoutes } = await import(
  '../src/routes/ui-oauth.ts'
);
const { PUSH_TIER3_WARNING } = await import('../src/lib/identities.ts');
const { createGrantAndCode, getGrant, listGrantsForAuth } = await import(
  '../src/lib/oauth-store.ts'
);

const fox: Identity = {
  address: 'fox@test.example',
  name: 'Fox',
  createdAt: '2026-07-27T00:00:00.000Z',
  tokenHash: 'must-never-leak',
  pushContentTier: 1,
};

function jsonHeaders(cookie: string) {
  return {
    cookie,
    origin: 'http://localhost',
    'content-type': 'application/json',
  };
}

function dependencies(store: { current: Identity }): UiApiDependencies {
  return {
    listIdentities: mock(() => [store.current]),
    listMessages: mock(async () => []),
    getMessage: mock(async () => null),
    setMessageSeen: mock(async () => true),
    getMailboxScan: mock(async () => ({
      kind: 'ready' as const,
      now: Date.now(),
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    })),
    setPushContentTier: mock((address: string, tier: PushContentTier) => {
      if (address.toLowerCase() !== store.current.address) return null;
      store.current = { ...store.current, pushContentTier: tier };
      return store.current;
    }),
  };
}

function authenticatedApp(auth: Auth, store = { current: { ...fox } }) {
  const sessions = new UiSessionStore({
    resolveToken: (token) => (token === 'session-token' ? auth : null),
  });
  const created = sessions.create('session-token', '127.0.0.1', Date.now());
  if (!created.ok) throw new Error('test session was not created');
  const deps = dependencies(store);
  const app = new Hono();
  app.route('/ui/api/oauth', createUiOAuthApiRoutes(sessions));
  app.route('/ui/api', createUiApiRoutes(sessions, deps));
  app.route('/ui/oauth', createUiOAuthPageRoutes(sessions));
  return { app, cookie: `oae_ui=${created.sid}`, deps, store, sessions };
}

describe('Configure UI APIs (#26 PR 5)', () => {
  test('UI push-tier 3 without confirm_risk is 400 even if the client skipped the dialog', async () => {
    const { app, cookie, store } = authenticatedApp({ kind: 'admin' });
    const denied = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}/push-tier`,
      {
        method: 'PUT',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ pushContentTier: 3 }),
      },
    );
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: 'confirm_risk_required',
      message: PUSH_TIER3_WARNING,
    });
    expect(store.current.pushContentTier).toBe(1);

    const confirmFalse = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}/push-tier`,
      {
        method: 'PUT',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ pushContentTier: 3, confirm_risk: false }),
      },
    );
    expect(confirmFalse.status).toBe(400);

    const allowed = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}/push-tier`,
      {
        method: 'PUT',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ pushContentTier: 3, confirm_risk: true }),
      },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({
      address: fox.address,
      pushContentTier: 3,
      warning: PUSH_TIER3_WARNING,
    });
    expect(store.current.pushContentTier).toBe(3);
  });

  test('identity session cannot create, rotate, delete, or change push tier', async () => {
    const { app, cookie, deps } = authenticatedApp({
      kind: 'identity',
      address: fox.address,
    });
    const headers = jsonHeaders(cookie);

    const created = await app.request('http://localhost/ui/api/identities', {
      method: 'POST',
      headers,
      body: JSON.stringify({ localpart: 'intruder' }),
    });
    expect(created.status).toBe(403);

    const rotated = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}/token`,
      { method: 'POST', headers: { cookie, origin: 'http://localhost' } },
    );
    expect(rotated.status).toBe(403);

    const deleted = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}`,
      { method: 'DELETE', headers: { cookie, origin: 'http://localhost' } },
    );
    expect(deleted.status).toBe(403);

    const tier = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(fox.address)}/push-tier`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ pushContentTier: 2 }),
      },
    );
    expect(tier.status).toBe(403);
    expect(deps.setPushContentTier).not.toHaveBeenCalled();
  });

  test('OAuth grant revoke takes effect immediately for the owning session', async () => {
    const { app, cookie } = authenticatedApp({ kind: 'admin' });
    const issued = createGrantAndCode({
      clientId: 'https://client.example/app',
      clientName: 'Sim Client',
      address: fox.address,
      codeChallenge: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJK',
      redirectUri: 'http://127.0.0.1:9/cb',
      resource: 'http://localhost/mcp',
    });
    expect(getGrant(issued.grantId)).toBeDefined();

    const listed = await app.request('http://localhost/ui/api/oauth/grants', {
      headers: { cookie },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { grants: { id: string }[] };
    expect(body.grants.some((grant) => grant.id === issued.grantId)).toBe(true);

    const revoked = await app.request(
      `http://localhost/ui/api/oauth/grants/${encodeURIComponent(issued.grantId)}`,
      { method: 'DELETE', headers: { cookie, origin: 'http://localhost' } },
    );
    expect(revoked.status).toBe(204);
    expect(getGrant(issued.grantId)).toBeUndefined();
    expect(
      listGrantsForAuth({ kind: 'admin' }).some((grant) => grant.id === issued.grantId),
    ).toBe(false);
  });

  test('unauthenticated /ui/oauth/grants redirects to login; session follows through to Configure', async () => {
    const { app, cookie } = authenticatedApp({ kind: 'admin' });
    const anonymous = await app.request('http://localhost/ui/oauth/grants');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('location')).toBe('/ui');

    const authed = await app.request('http://localhost/ui/oauth/grants', {
      headers: { cookie },
    });
    expect(authed.status).toBe(302);
    expect(authed.headers.get('location')).toBe('/ui/configure/clients');
  });
});
