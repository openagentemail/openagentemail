/**
 * P3 OAuth AS：8414 / 授权流 / token / refresh / revoke / 负例。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-oauth-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-oauth-as-'));
process.env.UI_ENABLED = 'true';

const { describe, expect, test, beforeEach } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { s256Challenge } = await import('../src/lib/oauth-pkce.ts');
const {
  putAccessTokenForTests,
  resetOAuthStoreCacheForTests,
} = await import('../src/lib/oauth-store.ts');
const { clearCimdCacheForTests } = await import('../src/lib/oauth-cimd.ts');
const {
  resolveAccessToken,
  resolveToken,
  resolveUiSessionToken,
} = await import('../src/lib/auth.ts');
const { config } = await import('../src/lib/config.ts');

const adminKey = [...config.apiKeys][0]!;
const CLIENT_ID = 'http://127.0.0.1:9/cimd.json';
const REDIRECT = 'http://127.0.0.1:54321/callback';
const RESOURCE = 'http://localhost/mcp';

function verifier(): string {
  return randomBytes(32).toString('base64url');
}

function cimdDoc(redirect = REDIRECT) {
  return {
    client_id: CLIENT_ID,
    client_name: 'Sim Client',
    redirect_uris: [redirect, 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
  };
}

function cimdFetcher(doc = cimdDoc()) {
  return async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function makeApp() {
  return createApp({
    uiEnabled: true,
    oauth: { cimdFetcher: cimdFetcher() },
  });
}

async function loginCookie(app: ReturnType<typeof createApp>, token = adminKey) {
  const res = await app.request('http://localhost/ui/api/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /oae_ui=([^;]+)/.exec(setCookie);
  expect(m).toBeTruthy();
  return `oae_ui=${m![1]}`;
}

function authQuery(extra: Record<string, string> = {}) {
  const v = verifier();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: s256Challenge(v),
    code_challenge_method: 'S256',
    resource: RESOURCE,
    state: 'st1',
    ...extra,
  });
  return { q, verifier: v };
}

/** 同意批准后为 200 过渡页；从可见链接解析回跳 URL。 */
function redirectFromHandoffHtml(html: string): URL {
  expect(html).toContain('已授权，正在跳回客户端');
  const m = /href="([^"]+)"/.exec(html);
  expect(m).toBeTruthy();
  const href = m![1]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return new URL(href);
}

beforeEach(() => {
  clearCimdCacheForTests();
  resetOAuthStoreCacheForTests();
});

describe('RFC 8414 + PRM issuer 一致', () => {
  test('三标志位 + issuer 与 PRM authorization_servers 一致', async () => {
    const app = makeApp();
    const asRes = await app.request('http://localhost/.well-known/oauth-authorization-server');
    expect(asRes.status).toBe(200);
    const asMeta = (await asRes.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      revocation_endpoint: string;
      code_challenge_methods_supported: string[];
      authorization_response_iss_parameter_supported: boolean;
      client_id_metadata_document_supported: boolean;
      token_endpoint_auth_methods_supported: string[];
      grant_types_supported: string[];
    };
    expect(asMeta.issuer).toBe('http://localhost');
    expect(asMeta.authorization_endpoint).toBe('http://localhost/authorize');
    expect(asMeta.token_endpoint).toBe('http://localhost/oauth/token');
    expect(asMeta.revocation_endpoint).toBe('http://localhost/oauth/revoke');
    expect(asMeta.code_challenge_methods_supported).toEqual(['S256']);
    expect(asMeta.authorization_response_iss_parameter_supported).toBe(true);
    expect(asMeta.client_id_metadata_document_supported).toBe(true);
    expect(asMeta.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(asMeta.grant_types_supported).toEqual([
      'authorization_code',
      'refresh_token',
    ]);

    const prm = await app.request('http://localhost/.well-known/oauth-protected-resource');
    const prmBody = (await prm.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(prmBody.resource).toBe(RESOURCE);
    expect(prmBody.authorization_servers).toContain(asMeta.issuer);
  });
});

describe('完整授权流', () => {
  test('authorize→code→token→/mcp tools/list + mail_list_messages；refresh 轮换；revoke', async () => {
    const app = makeApp();
    const { identity } = createIdentity({ localpart: 'oauth-flow' })!;
    const cookie = await loginCookie(app);
    const { q, verifier: v } = authQuery();

    // GET /authorize → 相对 Location 同意页
    const gate = await app.request(`http://localhost/authorize?${q}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(gate.status).toBe(302);
    const consentUrl = gate.headers.get('location')!;
    expect(consentUrl.startsWith('/ui/oauth/authorize?')).toBe(true);

    const consent = await app.request(`http://localhost${consentUrl}`, {
      headers: { cookie },
    });
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('Sim Client');
    expect(html).toContain('127.0.0.1');

    // POST 批准 → 200 过渡页（非 302）
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: q.get('code_challenge')!,
      resource: RESOURCE,
      state: 'st1',
      identity_mode: 'existing',
      address: identity.address,
      decision: 'approve',
    });
    const approved = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });
    expect(approved.status).toBe(200);
    expect(approved.headers.get('content-security-policy') ?? '').not.toContain(
      'form-action',
    );
    const loc = redirectFromHandoffHtml(await approved.text());
    expect(loc.origin + loc.pathname).toBe('http://127.0.0.1:54321/callback');
    expect(loc.searchParams.get('iss')).toBe('http://localhost');
    expect(loc.searchParams.get('state')).toBe('st1');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();

    // code → token
    const tokenRes = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: v,
        resource: RESOURCE,
      }),
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    expect(tokenRes.headers.get('pragma')).toBe('no-cache');
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.expires_in).toBe(3600);

    // /mcp tools/list
    const mcp = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(200);

    // 真打 /v1：OAuth 票读自己邮件（证明 aud/origin 对齐；禁再出现 403 invalid_audience）
    const v1 = await app.request(
      `http://localhost/v1/messages?address=${encodeURIComponent(identity.address)}&limit=1`,
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    expect(v1.status).not.toBe(403);
    // IMAP 在单测环境常不可达 → 500 可接受；关键是过了 bearerAuth
    expect([200, 500, 503]).toContain(v1.status);

    // 经 MCP 工具回环再打一次（同源断言）
    const toolCall = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'mail_list_messages',
          arguments: { address: identity.address, limit: 1 },
        },
      }),
    });
    expect(toolCall.status).not.toBe(403);
    expect(toolCall.status).toBe(200);
    const toolText = await toolCall.text();
    expect(toolText).not.toContain('invalid_audience');

    // code 重放拒
    const replay = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: v,
        resource: RESOURCE,
      }),
    });
    expect(replay.status).toBe(400);

    // refresh 轮换（须带 client_id）
    const refreshed = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get('cache-control')).toBe('no-store');
    const next = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    // 旧 refresh 重放拒
    const oldReplay = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    });
    expect(oldReplay.status).toBe(400);
    const oldBody = (await oldReplay.json()) as { error_description?: string };
    expect(oldBody.error_description).toBe('refresh token invalid or expired');

    // revoke：无 client_id / 错 client_id 不删仍 200；对的才删
    const noClient = await app.request('http://localhost/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: next.access_token }),
    });
    expect(noClient.status).toBe(200);
    const stillLive = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${next.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(stillLive.status).toBe(200);

    const wrongClient = await app.request('http://localhost/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: next.access_token,
        client_id: 'http://127.0.0.1:9/other-client.json',
      }),
    });
    expect(wrongClient.status).toBe(200);
    const stillLive2 = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${next.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(stillLive2.status).toBe(200);

    const rev = await app.request('http://localhost/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: next.access_token,
        client_id: CLIENT_ID,
      }),
    });
    expect(rev.status).toBe(200);
    const after = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${next.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    });
    expect(after.status).toBe(401);
  });

  test('删身份后旧 access 401、旧 refresh invalid_grant', async () => {
    const app = makeApp();
    const { identity } = createIdentity({ localpart: 'oauth-del' })!;
    const cookie = await loginCookie(app);
    const { q, verifier: v } = authQuery();
    const approved = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_challenge: q.get('code_challenge')!,
        resource: RESOURCE,
        identity_mode: 'existing',
        address: identity.address,
        decision: 'approve',
      }),
    });
    const code = redirectFromHandoffHtml(await approved.text()).searchParams.get(
      'code',
    )!;
    const tokenRes = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: v,
        resource: RESOURCE,
      }),
    });
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const del = await app.request(
      `http://localhost/v1/identities/${encodeURIComponent(identity.address)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${adminKey}` },
      },
    );
    expect(del.status).toBe(200);

    const mcp = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);

    const refresh = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    });
    expect(refresh.status).toBe(400);
    const rb = (await refresh.json()) as { error: string; error_description?: string };
    expect(rb.error).toBe('invalid_grant');
    expect(rb.error_description).toBe('refresh token invalid or expired');
  });
});

describe('授权负例', () => {
  test('无 code_challenge / plain / 非 S256 → 回跳 error + iss', async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);

    const noPkce = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    });
    const r1 = await app.request(`http://localhost/ui/oauth/authorize?${noPkce}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(r1.status).toBe(302);
    const u1 = new URL(r1.headers.get('location')!);
    expect(u1.searchParams.get('error')).toBe('invalid_request');
    expect(u1.searchParams.get('iss')).toBe('http://localhost');

    const plain = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'plain',
      resource: RESOURCE,
    });
    const r2 = await app.request(`http://localhost/ui/oauth/authorize?${plain}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    const u2 = new URL(r2.headers.get('location')!);
    expect(u2.searchParams.get('error')).toBe('invalid_request');
    expect(u2.searchParams.get('iss')).toBe('http://localhost');
  });

  test('redirect_uri 不匹配拒（错误页，禁止开放重定向）；loopback 异端口放行', async () => {
    const app = makeApp();
    const cookie = await loginCookie(app);

    const bad = authQuery({ redirect_uri: 'http://evil.example/callback' });
    const rBad = await app.request(`http://localhost/ui/oauth/authorize?${bad.q}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    // 未登记 redirect 不得 302 到攻击者 URI
    expect(rBad.status).toBe(400);
    expect(await rBad.text()).toContain('redirect_uri is not registered');
    expect(rBad.headers.get('location')).toBeNull();

    // 异端口 loopback：文档写无端口，请求带端口 → 同意页 200
    const app2 = createApp({
      uiEnabled: true,
      oauth: {
        cimdFetcher: cimdFetcher({
          ...cimdDoc('http://127.0.0.1/callback'),
          redirect_uris: ['http://127.0.0.1/callback'],
        }),
      },
    });
    const cookie2 = await loginCookie(app2);
    const q2 = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://127.0.0.1:9999/callback',
      code_challenge: s256Challenge(verifier()),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    const rOk2 = await app2.request(`http://localhost/ui/oauth/authorize?${q2}`, {
      headers: { cookie: cookie2 },
    });
    expect(rOk2.status).toBe(200);
    expect(await rOk2.text()).toContain('Sim Client');
  });

  test('invalid_client（CIMD fetch 失败）→ 错误页且不 302', async () => {
    const app = createApp({
      uiEnabled: true,
      oauth: {
        cimdFetcher: async () => new Response('nope', { status: 500 }),
      },
    });
    const cookie = await loginCookie(app);
    const { q } = authQuery();
    const res = await app.request(`http://localhost/ui/oauth/authorize?${q}`, {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Invalid client');
    expect(res.headers.get('location')).toBeNull();
  });

  test('identity 会话 POST 批准 → 403', async () => {
    const app = makeApp();
    const { token, identity } = createIdentity({ localpart: 'oauth-id-sess' })!;
    const cookie = await loginCookie(app, token);
    const v = verifier();
    const challenge = s256Challenge(v);
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      resource: RESOURCE,
      identity_mode: 'existing',
      address: identity.address,
      decision: 'approve',
    });
    const res = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Admin session required');
    expect(res.headers.get('location')).toBeNull();
  });

  test('token：缺 verifier / resource 错；aud 错 → 403；过期 access → 401', async () => {
    const app = makeApp();
    const { identity } = createIdentity({ localpart: 'oauth-neg' })!;
    const cookie = await loginCookie(app);
    const v = verifier();
    const challenge = s256Challenge(v);
    const approved = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        resource: RESOURCE,
        identity_mode: 'existing',
        address: identity.address,
        decision: 'approve',
      }),
      redirect: 'manual',
    });
    expect(approved.status).toBe(200);
    const code = redirectFromHandoffHtml(await approved.text()).searchParams.get(
      'code',
    )!;

    const noVerifier = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        resource: RESOURCE,
      }),
    });
    expect(noVerifier.status).toBe(400);

    // 用新 code 测 resource 错
    const approved2 = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        resource: RESOURCE,
        identity_mode: 'existing',
        address: identity.address,
        decision: 'approve',
      }),
      redirect: 'manual',
    });
    const code2 = redirectFromHandoffHtml(await approved2.text()).searchParams.get(
      'code',
    )!;
    const badRes = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code2,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: v,
        resource: 'http://evil.example/mcp',
      }),
    });
    expect(badRes.status).toBe(400);

    putAccessTokenForTests({
      token: 'wrong-aud-token-value-32bytes-pad!!',
      grantId: 'g-aud',
      address: 'aud@test.example',
      aud: 'http://evil.example/mcp',
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    const mcp = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-aud-token-value-32bytes-pad!!',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(403);

    const expiredTok = 'expired-access-token-value-pad-ok!!';
    putAccessTokenForTests({
      token: expiredTok,
      grantId: 'g-exp',
      address: 'aud@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() - 1000,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    const exp = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${expiredTok}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(exp.status).toBe(401);
  });

  test('code 过期拒', async () => {
    const { CODE_TTL_MS, consumeAuthorizationCode, createGrantAndCode } =
      await import('../src/lib/oauth-store.ts');
    // 用未来时钟消费：避免 save 时 prune 掉「创建即过期」行
    const issuedAt = Date.now();
    const { code } = createGrantAndCode({
      clientId: CLIENT_ID,
      clientName: 'X',
      address: 'exp@test.example',
      redirectUri: REDIRECT,
      codeChallenge: s256Challenge(verifier()),
      resource: RESOURCE,
      now: issuedAt,
    });
    const consumed = consumeAuthorizationCode(code, issuedAt + CODE_TTL_MS + 1);
    expect(consumed.ok).toBe(false);
    if (!consumed.ok) expect(consumed.reason).toBe('expired');
  });
});

describe('resolveToken / OAuth 永为 identity', () => {
  test('OAuth 票 → identity；过期 → null；aud 错 → forbidden；无 resource 上下文拒', () => {
    createIdentity({ localpart: 'res' });
    const tok = 'resolve-token-test-opaque-value1';
    putAccessTokenForTests({
      token: tok,
      grantId: 'g-res',
      address: 'res@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    const auth = resolveToken(tok, { resource: RESOURCE });
    expect(auth).toEqual({ kind: 'identity', address: 'res@test.example' });
    // 永非 admin
    expect(auth?.kind).not.toBe('admin');

    const expired = 'resolve-expired-opaque-value!!!!';
    putAccessTokenForTests({
      token: expired,
      grantId: 'g-res2',
      address: 'res@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() - 1,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    expect(resolveToken(expired, { resource: RESOURCE })).toBeNull();

    const badAud = resolveAccessToken(tok, { resource: 'http://other/mcp' });
    expect(badAud.status).toBe('forbidden_audience');

    // 无 MCP_PUBLIC_URL 且未传 resource：完整 resolve 拒 OAuth
    expect(resolveToken(tok)).toBeNull();
    // UI 会话 resolver 显式永不认 OAuth（与 MCP_PUBLIC_URL 无关）
    expect(resolveUiSessionToken(tok)).toBeNull();
  });

  test('OAuth 票换 /ui/api/session → 401', async () => {
    const app = makeApp();
    createIdentity({ localpart: 'ui' });
    const tok = 'ui-session-must-reject-oauth!!!!';
    putAccessTokenForTests({
      token: tok,
      grantId: 'g-ui',
      address: 'ui@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    // 即便完整 resolve 在带 resource 时能认出 identity，会话入口也必须 401
    expect(resolveToken(tok, { resource: RESOURCE })?.kind).toBe('identity');
    const res = await app.request('http://localhost/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ token: tok }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  test('admin 不可经 OAuth 获得：构造路径断言', () => {
    createIdentity({ localpart: 'admin' });
    // 即使 address 碰巧像 admin，kind 仍必须是 identity
    const tok = 'never-admin-oauth-token-value!!';
    putAccessTokenForTests({
      token: tok,
      grantId: 'g-adm',
      address: 'admin@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: CLIENT_ID, clientName: 'X' },
    });
    const r = resolveAccessToken(tok, { resource: RESOURCE });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      // /v1 仍见 identity；attribution 标明 oauth（永不升格 admin）
      expect(r.auth).toEqual({ kind: 'identity', address: 'admin@test.example' });
      expect(r.attribution.kind).toBe('oauth');
      expect(r.attribution.kind === 'oauth' && r.attribution.grantId).toBe('g-adm');
    }
    expect(config.apiKeys.has(tok)).toBe(false);
  });
});

describe('Dashboard 授权管理吊销', () => {
  test('列表可见；吊销后 token 立即失效', async () => {
    const app = makeApp();
    const { identity } = createIdentity({ localpart: 'oauth-grants' })!;
    const cookie = await loginCookie(app);
    const v = verifier();
    const challenge = s256Challenge(v);
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      resource: RESOURCE,
      identity_mode: 'existing',
      address: identity.address,
      decision: 'approve',
    });
    const approved = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });
    const code = redirectFromHandoffHtml(await approved.text()).searchParams.get(
      'code',
    )!;
    const tokenRes = await app.request('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: v,
        resource: RESOURCE,
      }),
    });
    const tokens = (await tokenRes.json()) as { access_token: string };

    const list = await app.request('http://localhost/ui/api/oauth/grants', {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const grants = (await list.json()) as { grants: { id: string; clientName: string }[] };
    expect(grants.grants.length).toBeGreaterThan(0);
    expect(grants.grants[0]!.clientName).toBe('Sim Client');

    const del = await app.request(
      `http://localhost/ui/api/oauth/grants/${grants.grants[0]!.id}`,
      {
        method: 'DELETE',
        headers: { cookie, origin: 'http://localhost' },
      },
    );
    expect(del.status).toBe(204);

    const mcp = await app.request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(401);

    const page = await app.request(`http://localhost/ui/oauth/grants`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Authorized clients');
  });
});
