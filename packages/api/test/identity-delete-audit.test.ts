/**
 * #245：identity.delete 审计（入口层）——两有意删除入口 + 四 rollback 负控 + 级联 webhook.delete。
 *
 * rollback 负控：经 setProvisionIdentityNotificationsForTests **确定性抛 NotifyError**，
 * 不依赖 NTFY_ENABLED / adminPassword（CI 全量时 config 可能已被它文件先解析锁定）。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-id-del-audit-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-id-del-audit-'));
process.env.UI_ENABLED = 'true';
process.env.MCP_PUBLIC_URL = 'http://localhost';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { createApp } = await import('../src/app.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const { config } = await import('../src/lib/config.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { createWebhookSubscription } = await import('../src/lib/webhook-store.ts');
const {
  NotifyError,
  setProvisionIdentityNotificationsForTests,
} = await import('../src/lib/notify.ts');
const { s256Challenge } = await import('../src/lib/oauth-pkce.ts');
const { clearCimdCacheForTests } = await import('../src/lib/oauth-cimd.ts');
const { resetOAuthStoreCacheForTests } = await import('../src/lib/oauth-store.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: true });

const CLIENT_ID = 'http://127.0.0.1:9/cimd.json';
const REDIRECT = 'http://127.0.0.1:54321/callback';
const RESOURCE = 'http://localhost/mcp';

/** 确定性失败：路由 catch 内 deleteIdentity 必走，与 CI/本地 env 无关。 */
function forceProvisionFail(): void {
  setProvisionIdentityNotificationsForTests(async () => {
    throw new NotifyError('notifications_unconfigured');
  });
}

function cimdFetcher() {
  return async () =>
    new Response(
      JSON.stringify({
        client_id: CLIENT_ID,
        client_name: 'Sim Client',
        redirect_uris: [REDIRECT, 'http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function auditFileText(): string {
  const path = join(config.dataDir, 'audit.jsonl');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function identityDeleteRows() {
  return readAuditEvents({ event: 'identity.delete', limit: 50 });
}

beforeEach(() => {
  resetAuditForTests();
  clearCimdCacheForTests();
  resetOAuthStoreCacheForTests();
  setProvisionIdentityNotificationsForTests(null);
});

afterEach(() => {
  setProvisionIdentityNotificationsForTests(null);
});

describe('#245 identity.delete 审计（有意删除入口）', () => {
  test('REST DELETE /v1/identities/:address 成功 → 恰一条 identity.delete（address 小写 / actor=admin）', async () => {
    const created = createIdentity({ localpart: 'del-rest-ok' })!;
    const mixed = created.identity.address.replace(/^del/, 'DEL');
    expect(mixed).not.toBe(created.identity.address);

    const res = await app.request(`/v1/identities/${encodeURIComponent(mixed)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(findIdentity(created.identity.address)).toBeUndefined();

    const rows = identityDeleteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'identity.delete',
      outcome: 'ok',
      address: created.identity.address.toLowerCase(),
      actor: 'admin',
    });
  });

  test('UI DELETE /ui/api/identities/:address 成功 → identity.delete actor=admin', async () => {
    const created = createIdentity({ localpart: 'del-ui-ok' })!;
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'adm' ? { kind: 'admin' } : null),
    });
    const sess = store.create('adm', '203.0.113.10');
    if (!sess.ok) throw new Error('session');
    const uiApp = new Hono();
    uiApp.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: async () => [],
        setMessageSeen: async () => true,
        getMailboxScan: async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        }),
        getMessage: async () => null,
        setPushContentTier: () => null,
      }),
    );

    const res = await uiApp.request(
      `/ui/api/identities/${encodeURIComponent(created.identity.address)}`,
      {
        method: 'DELETE',
        headers: { cookie: `oae_ui=${sess.sid}` },
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const rows = identityDeleteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'identity.delete',
      outcome: 'ok',
      address: created.identity.address.toLowerCase(),
      actor: 'admin',
    });
  });

  test('404 不记 identity.delete', async () => {
    const before = auditFileText().length;
    const res = await app.request('/v1/identities/ghost-no-such@test.example', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(404);
    expect(identityDeleteRows()).toHaveLength(0);
    expect(auditFileText().length).toBe(before);
  });

  test('有意删除级联 webhook.delete 口径不变（逐条 + identity.delete 并存）', async () => {
    const created = createIdentity({ localpart: 'del-wh-cascade' })!;
    const addr = created.identity.address;
    const wh1 = createWebhookSubscription({
      url: 'https://consumer.example/hook-a',
      address: addr,
      events: ['mail.received'],
      createdBy: 'admin',
    });
    const wh2 = createWebhookSubscription({
      url: 'https://consumer.example/hook-b',
      address: addr,
      events: ['mail.received'],
      createdBy: 'admin',
    });

    const res = await app.request(`/v1/identities/${encodeURIComponent(addr)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(200);

    const whDeletes = readAuditEvents({ event: 'webhook.delete', limit: 20 }).filter(
      (e) => e.address === addr,
    );
    expect(whDeletes).toHaveLength(2);
    expect(whDeletes.map((e) => e.webhookId).sort()).toEqual([wh1.id, wh2.id].sort());
    for (const row of whDeletes) {
      expect(row).toMatchObject({
        event: 'webhook.delete',
        outcome: 'ok',
        address: addr,
      });
    }

    const idDel = identityDeleteRows();
    expect(idDel).toHaveLength(1);
    expect(idDel[0]).toMatchObject({
      event: 'identity.delete',
      outcome: 'ok',
      address: addr,
      actor: 'admin',
    });
  });
});

describe('#245 rollback 负控（4 处不得产生 identity.delete）', () => {
  test('1) identities.ts admin 创建 rollback：provision 失败 → 无 identity.delete', async () => {
    forceProvisionFail();
    const res = await app.request('/v1/identities', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ localpart: 'rb-admin-prov' }),
    });
    // 不得是 201：钩子必须拦住创建成功路径
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'notifications_unconfigured' });
    expect(findIdentity('rb-admin-prov@test.example')).toBeUndefined();
    expect(identityDeleteRows()).toHaveLength(0);
  });

  test('2) identities.ts 子身份创建 rollback：provision 失败 → 无 identity.delete', async () => {
    forceProvisionFail();
    const parent = createIdentity({
      localpart: 'rb-parent',
      scopes: ['identities:create', 'read:messages'],
    })!;
    const res = await app.request('/v1/identities', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${parent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ localpart: 'rb-child-prov' }),
    });
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'notifications_unconfigured' });
    expect(findIdentity('rb-child-prov@test.example')).toBeUndefined();
    expect(identityDeleteRows()).toHaveLength(0);
  });

  test('3) ui.ts 创建 rollback：provision 失败 → 无 identity.delete', async () => {
    forceProvisionFail();
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'adm' ? { kind: 'admin' } : null),
    });
    const sess = store.create('adm', '203.0.113.11');
    if (!sess.ok) throw new Error('session');
    const uiApp = new Hono();
    uiApp.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: async () => [],
        setMessageSeen: async () => true,
        getMailboxScan: async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        }),
        getMessage: async () => null,
        setPushContentTier: () => null,
      }),
    );

    const res = await uiApp.request('/ui/api/identities', {
      method: 'POST',
      headers: {
        cookie: `oae_ui=${sess.sid}`,
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ localpart: 'rb-ui-prov' }),
    });
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'notifications_unconfigured' });
    expect(findIdentity('rb-ui-prov@test.example')).toBeUndefined();
    expect(identityDeleteRows()).toHaveLength(0);
  });

  test('4) ui-oauth.ts 同意页创建 rollback：provision 失败 → 无 identity.delete', async () => {
    forceProvisionFail();
    const oauthApp = createApp({
      uiEnabled: true,
      oauth: { cimdFetcher: cimdFetcher() },
    });
    const login = await oauthApp.request('http://localhost/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ token: adminKey }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const m = /oae_ui=([^;]+)/.exec(setCookie);
    expect(m).toBeTruthy();
    const cookie = `oae_ui=${m![1]}`;

    const v = randomBytes(32).toString('base64url');
    const challenge = s256Challenge(v);
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      state: 'st-rb-oauth',
      resource: RESOURCE,
    }).toString();

    await oauthApp.request(`http://localhost/authorize?${q}`, {
      headers: { cookie },
      redirect: 'manual',
    });

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      resource: RESOURCE,
      state: 'st-rb-oauth',
      identity_mode: 'create',
      localpart: 'rb-oauth-prov',
      decision: 'approve',
    });

    const res = await oauthApp.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });
    // provision 失败回同意页（400）并带错误文案；身份不得残留；不得记 identity.delete
    expect(res.status).not.toBe(201);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/[Nn]otification provisioning failed|identity was not created/);
    expect(findIdentity('rb-oauth-prov@test.example')).toBeUndefined();
    expect(identityDeleteRows()).toHaveLength(0);
  });
});
