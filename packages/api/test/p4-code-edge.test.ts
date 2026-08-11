/**
 * P4-code 通用能力：等待钳制 / XFF / 预鉴权 IP 限量 / SSRF 公网开关 / 401 URL / 审计 ip。
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-p4-edge-'));
process.env.UI_ENABLED = 'false';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');

const { clampWaitSeconds, parseConfig } = await import('../src/lib/config.ts');
const {
  allowsPrivateCimdException,
  clientIp,
  isSsrfBlockedResolvedIp,
} = await import('../src/lib/net.ts');
const { validateClientIdUrl } = await import('../src/lib/oauth-cimd.ts');
const {
  checkMcpPreauthIpRateLimit,
  checkOauthIpRateLimit,
  resetMcpPreauthIpRateLimits,
  resetOauthIpRateLimits,
} = await import('../src/lib/ratelimit.ts');
const {
  recordAuditEvent,
  readAuditEvents,
  resetAuditForTests,
} = await import('../src/lib/audit.ts');
const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');

const requiredEnv: NodeJS.ProcessEnv = {
  DOMAIN: 'example.com',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.com',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.com',
  SMTP_PASS: 'smtp-secret',
};

beforeEach(() => {
  resetOauthIpRateLimits();
  resetMcpPreauthIpRateLimits();
  resetAuditForTests();
});

afterEach(() => {
  resetOauthIpRateLimits();
  resetMcpPreauthIpRateLimits();
});

describe('MCP_MAX_WAIT_SECONDS / clampWaitSeconds', () => {
  test('默认 60；非法值拒；可配 1..600', () => {
    expect(parseConfig(requiredEnv).mcpMaxWaitSeconds).toBe(60);
    expect(
      parseConfig({ ...requiredEnv, MCP_MAX_WAIT_SECONDS: '30' }).mcpMaxWaitSeconds,
    ).toBe(30);
    expect(
      parseConfig({ ...requiredEnv, MCP_MAX_WAIT_SECONDS: '600' }).mcpMaxWaitSeconds,
    ).toBe(600);
    expect(() =>
      parseConfig({ ...requiredEnv, MCP_MAX_WAIT_SECONDS: '0' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...requiredEnv, MCP_MAX_WAIT_SECONDS: '601' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...requiredEnv, MCP_MAX_WAIT_SECONDS: 'nope' }),
    ).toThrow();
  });

  test('行为：MCP_MAX_WAIT_SECONDS=30 时 timeoutSec=600 钳到 30', () => {
    const cap = parseConfig({
      ...requiredEnv,
      MCP_MAX_WAIT_SECONDS: '30',
    }).mcpMaxWaitSeconds;
    expect(cap).toBe(30);
    // 路由与 task wait 均经 clampWaitSeconds；超参静默钳制（不 400）
    expect(clampWaitSeconds(600, cap)).toBe(30);
    expect(clampWaitSeconds(120, cap)).toBe(30);
    expect(clampWaitSeconds(1, cap)).toBe(1);
    expect(clampWaitSeconds(30, cap)).toBe(30);
  });

  test('默认 60 生效；进程 config 与 clamp 一致', () => {
    expect(clampWaitSeconds(600)).toBe(config.mcpMaxWaitSeconds);
    expect(config.mcpMaxWaitSeconds).toBeGreaterThanOrEqual(1);
    expect(config.mcpMaxWaitSeconds).toBeLessThanOrEqual(600);
  });

  test('路由暴露有效钳制值（头 + 408 体）', async () => {
    // 本地迷你路由：复用生产 clamp + 响应形状，避免 mock.module 污染 IMAP 套件
    const { clampWaitSeconds: clamp } = await import('../src/lib/config.ts');
    const app = new Hono();
    app.post('/wait', async (c) => {
      const body = (await c.req.json()) as { timeoutSec?: number };
      const effective = clamp(body.timeoutSec ?? 120);
      c.header('X-OAE-Wait-Timeout-Sec', String(effective));
      return c.json({ error: 'timeout', timeoutSec: effective }, 408);
    });
    const res = await app.request('/wait', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutSec: 600 }),
    });
    expect(res.status).toBe(408);
    expect(res.headers.get('X-OAE-Wait-Timeout-Sec')).toBe(String(config.mcpMaxWaitSeconds));
    const json = (await res.json()) as { timeoutSec: number };
    expect(json.timeoutSec).toBe(config.mcpMaxWaitSeconds);
  });
});

describe('TRUST_PROXY_HEADERS / clientIp', () => {
  test('parse 默认 false；true/false 可配', () => {
    expect(parseConfig(requiredEnv).trustProxyHeaders).toBe(false);
    expect(
      parseConfig({ ...requiredEnv, TRUST_PROXY_HEADERS: 'true' }).trustProxyHeaders,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...requiredEnv, TRUST_PROXY_HEADERS: 'yes' }),
    ).toThrow();
  });

  test('false 忽略 XFF；true 取首跳；伪造在 false 下不影响键', async () => {
    const app = new Hono();
    app.get('/ip', (c) => {
      const trust = c.req.query('trust') === '1';
      return c.text(clientIp(c, { trustProxy: trust }));
    });

    const forged = await app.request('/ip?trust=0', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    // 测试客户端无 conninfo → unknown；XFF 被忽略
    expect(await forged.text()).toBe('unknown');

    const trusted = await app.request('/ip?trust=1', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(await trusted.text()).toBe('203.0.113.9');
  });

  test('true 时垃圾首跳回落连接 IP；合法首跳正常采用', async () => {
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientIp(c, { trustProxy: true })));

    // 非 IP 字面量（轮换垃圾值）不得当限流键——回落 getConnInfo（测试客户端=unknown）
    const garbage = await app.request('/ip', {
      headers: { 'x-forwarded-for': 'not-an-ip, 10.0.0.1' },
    });
    expect(await garbage.text()).toBe('unknown');

    const emptyish = await app.request('/ip', {
      headers: { 'x-forwarded-for': '  , 198.51.100.1' },
    });
    expect(await emptyish.text()).toBe('unknown');

    // 合法 IPv4 / IPv6 首跳仍采用
    const v4 = await app.request('/ip', {
      headers: { 'x-forwarded-for': '198.51.100.20, 10.0.0.1' },
    });
    expect(await v4.text()).toBe('198.51.100.20');
    const v6 = await app.request('/ip', {
      headers: { 'x-forwarded-for': '2001:db8::1, 10.0.0.1' },
    });
    expect(await v6.text()).toBe('2001:db8::1');
  });
});

describe('预鉴权 IP 限量（复用 slidingWindow）', () => {
  test('同 IP 超阈拒绝；不同 IP 互不占额', () => {
    const now = 5_000_000;
    for (let i = 0; i < 3; i++) {
      expect(checkOauthIpRateLimit('198.51.100.1', 3, 60_000, now).allowed).toBe(true);
    }
    const blocked = checkOauthIpRateLimit('198.51.100.1', 3, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(checkOauthIpRateLimit('198.51.100.2', 3, 60_000, now).allowed).toBe(true);
  });

  test('/authorize 超 OAUTH 阈 → 429 + Retry-After', async () => {
    const limit = config.oauthRatePerMin;
    if (limit <= 0) return;
    const now = Date.now();
    for (let i = 0; i < limit; i++) {
      checkOauthIpRateLimit('unknown', limit, 60_000, now);
    }
    const app = createApp({ uiEnabled: false });
    const res = await app.request('/authorize?client_id=https://x.example/c');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('rate_limited');
  });

  test('/mcp 无 token 超 MCP_PREAUTH 阈 → 429；XFF 键语义', async () => {
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      expect(checkMcpPreauthIpRateLimit('203.0.113.50', 2, 60_000, now).allowed).toBe(
        true,
      );
    }
    expect(checkMcpPreauthIpRateLimit('203.0.113.50', 2, 60_000, now).allowed).toBe(
      false,
    );
    expect(checkMcpPreauthIpRateLimit('203.0.113.51', 2, 60_000, now).allowed).toBe(
      true,
    );

    // 开 XFF 后限流键为首跳（与 clientIp 一致）
    const appIp = new Hono();
    appIp.get('/k', (c) => c.text(clientIp(c, { trustProxy: true })));
    const keyRes = await appIp.request('/k', {
      headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.1' },
    });
    expect(await keyRes.text()).toBe('203.0.113.50');

    const preauthLimit = config.mcpPreauthRatePerMin;
    if (preauthLimit <= 0) return;
    resetMcpPreauthIpRateLimits();
    const t = Date.now();
    for (let i = 0; i < preauthLimit; i++) {
      checkMcpPreauthIpRateLimit('unknown', preauthLimit, 60_000, t);
    }
    const app = createApp({ uiEnabled: false });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });
});

describe('OAE_PUBLIC_EDGE / CIMD SSRF', () => {
  test('parse 默认 false', () => {
    expect(parseConfig(requiredEnv).oaePublicEdge).toBe(false);
    expect(
      parseConfig({ ...requiredEnv, OAE_PUBLIC_EDGE: 'true' }).oaePublicEdge,
    ).toBe(true);
  });

  test('默认私网可放行；publicEdge 时私网/loopback 拒、169.254 仍拒', () => {
    expect(isSsrfBlockedResolvedIp('10.1.2.3', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('127.0.0.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('10.1.2.3', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('127.0.0.1', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('100.64.1.2', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('fd12::1', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('169.254.169.254', { publicEdge: true })).toBe(
      true,
    );
    expect(isSsrfBlockedResolvedIp('169.254.169.254', { publicEdge: false })).toBe(
      true,
    );
    expect(allowsPrivateCimdException({ publicEdge: true })).toBe(false);
    expect(
      validateClientIdUrl('http://127.0.0.1:9/cimd.json', { publicEdge: false }).ok,
    ).toBe(true);
    expect(
      validateClientIdUrl('http://127.0.0.1:9/cimd.json', { publicEdge: true }).ok,
    ).toBe(false);
  });
});

describe('401 resource_metadata 读 MCP_PUBLIC_URL', () => {
  test('注入 publicBaseUrl 后挑战头指向它而非请求 origin', async () => {
    const app = createApp({
      uiEnabled: false,
      mcpPublicBaseUrl: 'https://mcp.public.example',
    });
    const res = await app.request('http://evil.internal:3100/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www).toContain(
      'resource_metadata="https://mcp.public.example/.well-known/oauth-protected-resource"',
    );
    expect(www).not.toContain('evil.internal');
  });
});

describe('审计 OAuth 事件带 ip', () => {
  test('显式 ip 落盘；开关两态各验 clientIp', async () => {
    recordAuditEvent({
      event: 'oauth.revoke',
      outcome: 'ok',
      clientId: 'https://c.example/x',
      ip: '203.0.113.7',
    });
    const rows = readAuditEvents({ event: 'oauth.revoke', limit: 1 });
    expect(rows[0]?.ip).toBe('203.0.113.7');

    const app = new Hono();
    app.post('/probe', (c) => {
      const trust = c.req.query('trust') === '1';
      recordAuditEvent({
        event: 'oauth.token.refresh',
        outcome: 'ok',
        clientId: 'c',
        ip: clientIp(c, { trustProxy: trust }),
      });
      return c.json({ ok: true });
    });
    await app.request('/probe?trust=0', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    });
    await app.request('/probe?trust=1', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.20' },
    });
    const refreshes = readAuditEvents({ event: 'oauth.token.refresh', limit: 2 });
    const ips = refreshes.map((e) => e.ip);
    expect(ips).toContain('unknown');
    expect(ips).toContain('198.51.100.20');
  });
});
