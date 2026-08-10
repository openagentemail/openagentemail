/**
 * P3.5：scrubbed 审计、attribution、工具分层、MCP 限量。
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-audit-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-audit-tier-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, test, beforeEach } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const {
  recordAuditEvent,
  readAuditEvents,
  resetAuditForTests,
  scrubAuditField,
} = await import('../src/lib/audit.ts');
const { resolveAccessToken } = await import('../src/lib/auth.ts');
const { config } = await import('../src/lib/config.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const {
  putAccessTokenForTests,
  resetOAuthStoreCacheForTests,
  revokeToken,
} = await import('../src/lib/oauth-store.ts');
const {
  checkMcpRateLimit,
  checkNotifyUserLimit,
  checkSendLimit,
  resetMcpRateLimits,
  resetNotifyUserLimits,
  resetRateLimits,
} = await import('../src/lib/ratelimit.ts');
const {
  assertAllSpecTiersDeclared,
  assertToolTierDeclared,
  declareToolTier,
  getToolTier,
  isToolTierDeclared,
  resetToolTiersForTests,
  TOOL_TIER_SPEC,
} = await import('../src/lib/tool-tiers.ts');
const { registerOpenAgentEmailTools } = await import('../src/mcp/tools.ts');
const { McpServer } = await import('@modelcontextprotocol/server');
const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');

const adminKey = [...config.apiKeys][0]!;
const RESOURCE = 'http://localhost/mcp';
const MCP_ACCEPT = 'application/json, text/event-stream';
const app = createApp({ uiEnabled: false });

const SECRET_SUBJECT = 'TOPSECRET-SUBJECT-XYZ-999';
const SECRET_BODY = 'sk-proj-FAKESECRET-IN-ARGS-do-not-log';
const SECRET_TOKEN_FRAGMENT = 'oa_should_never_appear_in_audit_file';

beforeEach(() => {
  resetAuditForTests();
  resetMcpRateLimits();
  resetOAuthStoreCacheForTests();
  resetToolTiersForTests();
});

function mcpCall(
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
  id = 1,
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
}

function auditFileText(): string {
  const path = join(config.dataDir, 'audit.jsonl');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

describe('audit JSONL scrubbed + 读端点', () => {
  test('写事件落盘格式正确；秘密值不进文件', () => {
    recordAuditEvent({
      event: 'mcp.tools.call',
      clientId: 'http://client.example/cimd.json',
      grantId: 'grant-abc',
      address: 'bot@test.example',
      tool: 'mail_send',
      tier: 'contained',
      outcome: 'ok',
      durationMs: 12,
    });
    const text = auditFileText();
    expect(text).toContain('"event":"mcp.tools.call"');
    expect(text).toContain('"tier":"contained"');
    expect(text).toContain('"outcome":"ok"');
    // 红线：文件中不得出现这些秘密字面量
    expect(text).not.toContain(SECRET_SUBJECT);
    expect(text).not.toContain(SECRET_BODY);
    expect(text).not.toContain(SECRET_TOKEN_FRAGMENT);
    expect(text).not.toContain('arguments');
  });

  test('含秘密参数的 MCP 写调用后 grep audit.jsonl 无秘密', async () => {
    const { token, identity } = createIdentity({ localpart: 'audit-scrub' })!;
    // mail_send 会进 SDK 后可能因 SMTP mock 失败，但审计仍应落盘且 scrubbed
    await mcpCall(token, 'mail_send', {
      from: identity.address,
      to: 'victim@evil.example',
      subject: SECRET_SUBJECT,
      text: SECRET_BODY,
    });
    const text = auditFileText();
    expect(text).toContain('mcp.tools.call');
    expect(text).toContain('mail_send');
    expect(text).not.toContain(SECRET_SUBJECT);
    expect(text).not.toContain(SECRET_BODY);
    expect(text).not.toContain(token);
    expect(text).not.toContain(SECRET_TOKEN_FRAGMENT);
  });

  test('GET /v1/audit/events admin-only；limit/event 过滤', async () => {
    recordAuditEvent({ event: 'oauth.revoke', outcome: 'ok', clientId: 'c1' });
    recordAuditEvent({
      event: 'mcp.tools.call',
      tool: 'mail_send',
      tier: 'contained',
      outcome: 'ok',
      address: 'a@test.example',
    });

    const { token } = createIdentity({ localpart: 'audit-deny' })!;
    const idForbidden = await app.request('/v1/audit/events', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(idForbidden.status).toBe(403);

    const all = await app.request('/v1/audit/events?limit=100', {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { events: { event: string }[] };
    expect(allBody.events.length).toBeGreaterThanOrEqual(2);

    const filtered = await app.request('/v1/audit/events?event=oauth.revoke', {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const filteredBody = (await filtered.json()) as {
      events: { event: string }[];
    };
    expect(filteredBody.events.every((e) => e.event === 'oauth.revoke')).toBe(
      true,
    );

    const limited = await app.request('/v1/audit/events?limit=1', {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const limitedBody = (await limited.json()) as { events: unknown[] };
    expect(limitedBody.events.length).toBe(1);
  });
});

describe('attribution：三种 caller 落三种行', () => {
  test('OAuth / oa_ / admin 写调用审计字段不同', async () => {
    const { token: oaToken, identity } = createIdentity({
      localpart: 'attr-oa',
    })!;
    const grantId = 'grant-attr-1';
    const clientId = 'http://127.0.0.1:9/cimd.json';
    const oauthTok = 'oauth-access-attr-test-token';
    putAccessTokenForTests({
      token: oauthTok,
      grantId,
      address: identity.address,
      aud: RESOURCE,
      expiresAt: Date.now() + 3_600_000,
      ensureGrant: { clientId, clientName: 'Attr Client' },
    });

    // 确认 attribution 解析分叉
    const oaResolved = resolveAccessToken(oaToken, { resource: RESOURCE });
    expect(oaResolved.status).toBe('ok');
    if (oaResolved.status === 'ok') {
      expect(oaResolved.attribution.kind).toBe('identity');
    }
    const oauthResolved = resolveAccessToken(oauthTok, { resource: RESOURCE });
    expect(oauthResolved.status).toBe('ok');
    if (oauthResolved.status === 'ok') {
      expect(oauthResolved.attribution.kind).toBe('oauth');
      if (oauthResolved.attribution.kind === 'oauth') {
        expect(oauthResolved.attribution.grantId).toBe(grantId);
        expect(oauthResolved.attribution.clientId).toBe(clientId);
      }
    }
    const adminResolved = resolveAccessToken(adminKey, { resource: RESOURCE });
    expect(adminResolved.status).toBe('ok');
    if (adminResolved.status === 'ok') {
      expect(adminResolved.attribution.kind).toBe('admin');
    }

    // 用 mail_send（contained）避免 mail_mark_seen 打真实 IMAP；失败也仍落审计
    const sendArgs = {
      from: identity.address,
      to: 'sink@test.example',
      subject: 'attr',
      text: 'x',
    };
    await mcpCall(oaToken, 'mail_send', sendArgs);
    await mcpCall(oauthTok, 'mail_send', sendArgs);
    await mcpCall(adminKey, 'mail_send', sendArgs);

    const events = readAuditEvents({ event: 'mcp.tools.call', limit: 20 });
    const oaRow = events.find(
      (e) => e.address === identity.address && !e.grantId && e.tool === 'mail_send',
    );
    const oauthRow = events.find((e) => e.grantId === grantId && e.tool === 'mail_send');
    const adminRow = events.find((e) => e.address === 'admin' && e.tool === 'mail_send');
    expect(oaRow).toBeTruthy();
    expect(oauthRow?.clientId).toBe(clientId);
    expect(adminRow?.tier).toBe('contained');
  });
});

describe('工具分层', () => {
  test('规格表 15 工具均有 tier；注册冲突会 throw', () => {
    expect(Object.keys(TOOL_TIER_SPEC).length).toBe(15);
    // SPEC 回落：即使 declared 空也能预检
    resetToolTiersForTests();
    expect(isToolTierDeclared('mail_new_identity')).toBe(false);
    expect(getToolTier('mail_new_identity')).toBe('critical');
    declareToolTier('mail_send', 'contained');
    expect(() => declareToolTier('mail_send', 'read')).toThrow(/conflict/);
  });

  test('注册完整性：未 declare 则 assert 炸；全量注册后规格表覆盖', () => {
    resetToolTiersForTests();
    expect(() => assertToolTierDeclared('mail_send')).toThrow(/not declared/);
    expect(() => assertAllSpecTiersDeclared()).toThrow(/not declared/);
    declareToolTier('mail_send', 'contained');
    expect(() => assertAllSpecTiersDeclared()).toThrow(/not declared/);

    resetToolTiersForTests();
    const server = new McpServer({ name: 'tier-test', version: '0.0.0' });
    const client = new OpenAgentEmailClient('http://localhost', 't', fetch);
    registerOpenAgentEmailTools(server, client);
    for (const name of Object.keys(TOOL_TIER_SPEC)) {
      expect(isToolTierDeclared(name)).toBe(true);
    }
    expect(() => assertAllSpecTiersDeclared()).not.toThrow();
  });

  test('critical 被 OAuth 票调 → 403；oa_ 进 REST scope；admin 通预检', async () => {
    const { token: oaToken, identity } = createIdentity({
      localpart: 'tier-crit',
    })!;
    const grantId = 'grant-crit-1';
    const oauthTok = 'oauth-access-crit-test';
    putAccessTokenForTests({
      token: oauthTok,
      grantId,
      address: identity.address,
      aud: RESOURCE,
      expiresAt: Date.now() + 3_600_000,
      ensureGrant: {
        clientId: 'http://127.0.0.1:9/cimd.json',
        clientName: 'Crit',
      },
    });

    const oauthDenied = await mcpCall(oauthTok, 'mail_new_identity', {
      localpart: 'should-deny',
    });
    expect(oauthDenied.status).toBe(403);
    const deniedBody = (await oauthDenied.json()) as { error: string; tier?: string };
    expect(deniedBody.error).toBe('forbidden_tier');
    expect(deniedBody.tier).toBe('critical');

    const audit = readAuditEvents({ event: 'mcp.tools.call', limit: 5 });
    const deniedRow = audit.find((e) => e.outcome === 'denied' && e.tier === 'critical');
    expect(deniedRow?.grantId).toBe(grantId);

    // oa_：不被 HTTP critical 拦（进 SDK→REST）；admin-only REST → 工具层错误而非 403 tier
    const oaRes = await mcpCall(oaToken, 'mail_new_identity', {
      localpart: 'oa-may-reach-rest',
    });
    // 非 HTTP 403 forbidden_tier（可能 200 JSON-RPC isError）
    expect(oaRes.status).not.toBe(403);

    const adminRes = await mcpCall(adminKey, 'mail_new_identity', {
      localpart: 'admin-crit-ok',
    });
    expect(adminRes.status).toBe(200);
  });

  test('未知工具 default deny 403', async () => {
    const res = await mcpCall(adminKey, 'not_a_real_tool', {});
    expect(res.status).toBe(403);
  });

  test('JSON-RPC batch 拒 400：落 mcp.batch_rejected 并计入写桶', async () => {
    const { identity } = createIdentity({ localpart: 'batch-deny' })!;
    const grantId = 'grant-batch-1';
    const oauthTok = 'oauth-access-batch-test';
    putAccessTokenForTests({
      token: oauthTok,
      grantId,
      address: identity.address,
      aud: RESOURCE,
      expiresAt: Date.now() + 3_600_000,
      ensureGrant: {
        clientId: 'http://127.0.0.1:9/cimd.json',
        clientName: 'Batch',
      },
    });
    const batchBody = JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mail_new_identity', arguments: { localpart: 'x' } },
      },
    ]);
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${oauthTok}`,
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
      },
      body: batchBody,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'batch_not_supported',
    );
    const rejected = readAuditEvents({ event: 'mcp.batch_rejected', limit: 5 });
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]!.outcome).toBe('denied');
    expect(rejected[0]!.grantId).toBe(grantId);

    // 再灌满写桶后 batch → 429 + rate_limited 审计（无成本洪峰不能白送）
    resetMcpRateLimits();
    const writeLimit = config.mcpRateWritePerMin;
    for (let i = 0; i < writeLimit; i++) {
      expect(checkMcpRateLimit(grantId, 'write', writeLimit).allowed).toBe(true);
    }
    const limited = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${oauthTok}`,
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
      },
      body: batchBody,
    });
    expect(limited.status).toBe(429);
    const rlRows = readAuditEvents({ event: 'mcp.batch_rejected', limit: 10 });
    expect(rlRows.some((e) => e.outcome === 'rate_limited')).toBe(true);
  });
});

describe('MCP per-token 限量', () => {
  test('窗口内放行 / 超限 429+Retry-After；读写分桶；admin 豁免', async () => {
    const { token, identity } = createIdentity({ localpart: 'rate-oa' })!;
    const writeLimit = config.mcpRateWritePerMin;
    const key = identity.address.toLowerCase();

    // 预填写桶至上限
    for (let i = 0; i < writeLimit; i++) {
      const r = checkMcpRateLimit(key, 'write', writeLimit);
      expect(r.allowed).toBe(true);
    }

    const blocked = await mcpCall(token, 'mail_send', {
      from: identity.address,
      to: 'sink@test.example',
      subject: 'rl',
      text: 'x',
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const body = (await blocked.json()) as { error: string; bucket: string };
    expect(body.error).toBe('rate_limited');
    expect(body.bucket).toBe('write');

    // 读桶仍独立：写桶满不影响读
    const readOk = await mcpCall(token, 'mail_list_identities');
    expect(readOk.status).not.toBe(429);

    // tools/list 免费
    const list = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(list.status).toBe(200);

    // admin 豁免：不占桶，写桶预满也不 429
    resetMcpRateLimits();
    for (let i = 0; i < writeLimit; i++) {
      checkMcpRateLimit('admin-should-not-matter', 'write', writeLimit);
    }
    const adminCall = await mcpCall(adminKey, 'mail_list_identities');
    expect(adminCall.status).not.toBe(429);
  });

  test('抽离后 send/notifyUser 既有语义不变', () => {
    resetRateLimits();
    resetNotifyUserLimits();
    const now = 1_000_000;
    expect(checkSendLimit('a@x.com', 1, 60_000, now).allowed).toBe(true);
    expect(checkSendLimit('a@x.com', 1, 60_000, now).allowed).toBe(false);
    expect(checkNotifyUserLimit('a@x.com', 1, 60_000, now).allowed).toBe(true);
    expect(checkNotifyUserLimit('a@x.com', 1, 60_000, now).allowed).toBe(false);
  });

  test('读桶超限也落 rate_limited 审计', async () => {
    const { token, identity } = createIdentity({ localpart: 'rate-read' })!;
    const readLimit = config.mcpRateReadPerMin;
    const key = identity.address.toLowerCase();
    for (let i = 0; i < readLimit; i++) {
      expect(checkMcpRateLimit(key, 'read', readLimit).allowed).toBe(true);
    }
    const blocked = await mcpCall(token, 'mail_list_identities');
    expect(blocked.status).toBe(429);
    const rows = readAuditEvents({ event: 'mcp.tools.call', limit: 5 });
    expect(
      rows.some(
        (e) =>
          e.outcome === 'rate_limited' &&
          e.tier === 'read' &&
          e.tool === 'mail_list_identities',
      ),
    ).toBe(true);
  });
});

describe('审计清洗 / 合并读 / revoke 零写', () => {
  test('带换行的 clientId 不落原始形态', () => {
    const dirty = 'evil\r\n{"event":"forged"}\nhttp://x';
    recordAuditEvent({
      event: 'oauth.revoke',
      clientId: dirty,
      outcome: 'ok',
    });
    const text = auditFileText();
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\n{"event":"forged"}');
    expect(scrubAuditField(dirty)).toBe('evil{"event":"forged"}http://x');
    const rows = readAuditEvents({ event: 'oauth.revoke', limit: 1 });
    expect(rows[0]!.clientId).toBe('evil{"event":"forged"}http://x');
  });

  test('合并 audit.jsonl.1 + 当前；新的在前', () => {
    const rotated = join(config.dataDir, 'audit.jsonl.1');
    const current = join(config.dataDir, 'audit.jsonl');
    writeFileSync(
      rotated,
      `${JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', event: 'old.event', outcome: 'ok' })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      current,
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'new.event', outcome: 'ok' })}\n`,
      { mode: 0o600 },
    );
    const rows = readAuditEvents({ limit: 10 });
    expect(rows[0]!.event).toBe('new.event');
    expect(rows.some((e) => e.event === 'old.event')).toBe(true);
    const limited = readAuditEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.event).toBe('new.event');
  });

  test('未知 token revoke：200 且零磁盘写（oauth.json + audit）', async () => {
    const oauthPath = join(config.dataDir, 'oauth.json');
    // 确保有一份 oauth 文件可测 mtime
    putAccessTokenForTests({
      token: 'seed-for-mtime',
      grantId: 'g-seed',
      address: 'seed@test.example',
      aud: RESOURCE,
      expiresAt: Date.now() + 60_000,
      ensureGrant: { clientId: 'http://c', clientName: 'S' },
    });
    createIdentity({ localpart: 'seed' });
    const beforeOauth = statSync(oauthPath);
    const beforeAuditLen = auditFileText().length;

    expect(revokeToken('totally-unknown-token-xyz', 'http://c')).toBe(false);
    const rev = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'totally-unknown-token-xyz',
        client_id: 'http://c',
      }),
    });
    expect(rev.status).toBe(200);

    const afterOauth = statSync(oauthPath);
    expect(afterOauth.mtimeMs).toBe(beforeOauth.mtimeMs);
    expect(afterOauth.size).toBe(beforeOauth.size);
    expect(auditFileText().length).toBe(beforeAuditLen);
  });
});
