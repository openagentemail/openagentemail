/**
 * #275 R4 F15：UI 路径直调 rotateIdentityTokenDetailed 的子约束覆盖。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-ui-scoped-rot';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-scoped-rot-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const {
  createIdentity,
  findIdentity,
  rotateIdentityTokenDetailed,
} = await import('../src/lib/identities.ts');

function adminUiApp() {
  const sessions = new UiSessionStore({
    resolveToken: (token) => (token === 'session-token' ? { kind: 'admin' as const } : null),
  });
  const created = sessions.create('session-token', '127.0.0.1', Date.now());
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(sessions));
  return { app, cookie: `oae_ui=${created.sid}` };
}

describe('#275 R4 F15 UI rotate 子约束', () => {
  test('② UI 悬空子 → 400；③ 正常子空 rotate → 200；⑤ 非子不回归', async () => {
    const { app, cookie } = adminUiApp();
    const headers = { cookie, origin: 'http://localhost' };

    const dangling = createIdentity({
      localpart: 'ui-f15-dangling',
      parentIdentity: 'missing-ui-parent@test.example',
      scopes: ['read:messages'],
    })!;
    const bad = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(dangling.identity.address)}/token`,
      { method: 'POST', headers },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: 'invalid_request',
      details: 'child identity has no existing parent identity',
    });
    expect(findIdentity(dangling.identity.address)?.tokenHash).toBe(
      dangling.identity.tokenHash,
    );

    const parent = createIdentity({
      localpart: 'ui-f15-parent',
      scopes: ['identities:create', 'read:messages', 'messages:send'],
    })!;
    const child = createIdentity({
      localpart: 'ui-f15-child',
      parentIdentity: parent.identity.address,
      scopes: ['read:messages'],
    })!;
    const ok = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(child.identity.address)}/token`,
      { method: 'POST', headers },
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { token: string; scopes?: string[] };
    expect(okBody.token.startsWith('oa_')).toBe(true);
    expect(okBody.scopes).toEqual(['read:messages']);

    const plain = createIdentity({
      localpart: 'ui-f15-plain',
      scopes: ['read:messages'],
    })!;
    const plainRot = await app.request(
      `http://localhost/ui/api/identities/${encodeURIComponent(plain.identity.address)}/token`,
      { method: 'POST', headers },
    );
    expect(plainRot.status).toBe(200);
  });

  test('④ UI 同源 store：显式 create/超父/null → 原错误码', () => {
    const parent = createIdentity({
      localpart: 'ui-f15-v-parent',
      scopes: ['identities:create', 'read:messages'],
    })!;
    const child = createIdentity({
      localpart: 'ui-f15-v-child',
      parentIdentity: parent.identity.address,
      scopes: ['read:messages'],
    })!;

    const createDenied = rotateIdentityTokenDetailed(child.identity.address, [
      'identities:create',
    ]);
    expect(createDenied).toEqual({
      ok: false,
      error: 'child_scope_invalid',
      status: 400,
      body: {
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      },
    });

    const exceed = rotateIdentityTokenDetailed(child.identity.address, ['messages:send']);
    expect(exceed).toEqual({
      ok: false,
      error: 'child_scope_invalid',
      status: 403,
      body: { error: 'forbidden: scope exceeds parent permissions' },
    });

    const nullDenied = rotateIdentityTokenDetailed(child.identity.address, null);
    expect(nullDenied).toEqual({
      ok: false,
      error: 'child_scope_invalid',
      status: 400,
      body: {
        error: 'invalid_request',
        details: 'child identity cannot be reset to an unscoped token',
      },
    });
  });
});
