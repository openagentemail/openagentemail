import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-connect-'));

const { describe, expect, test, beforeEach } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const { Hono } = await import('hono');
const {
  UiSessionStore,
  COOKIE_NAME,
  CONNECT_REVEAL_AUDIT_THROTTLE_MS,
  CONNECT_REVEAL_AUDIT_MAX_TRACKED,
} = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function resolver(token: string) {
  if (token === 'oa_fox-secret') {
    return { kind: 'identity' as const, address: 'fox@test.example' };
  }
  if (token === 'admin-secret') return { kind: 'admin' as const };
  return null;
}

function hashResolver(hash: string) {
  if (hash === tokenHash('oa_fox-secret')) {
    return { kind: 'identity' as const, address: 'fox@test.example' };
  }
  if (hash === tokenHash('admin-secret')) return { kind: 'admin' as const };
  return null;
}

/** Connect 请求默认带 same-origin SFS（浏览器同源 fetch 形态）。 */
const CONNECT_HEADERS = { 'sec-fetch-site': 'same-origin' } as const;

async function login(
  app: ReturnType<typeof createApp>,
  token: string,
): Promise<string> {
  const response = await app.request(
    'https://internal.example/ui/api/session',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://internal.example',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ token }),
    },
  );
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

beforeEach(() => {
  resetAuditForTests();
});

describe('Connect-agent dashboard API', () => {
  test('returns the public MCP endpoint and direct identity session token without caching', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example/base/',
    });
    const cookie = await login(app, 'oa_fox-secret');
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: { cookie, ...CONNECT_HEADERS },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      endpoint: 'https://mail.public.example/base/mcp',
      identity: 'fox@test.example',
      token: 'oa_fox-secret',
      unavailable: null,
    });
  });

  test('never exposes an admin credential', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example',
    });
    const cookie = await login(app, 'admin-secret');
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: { cookie, ...CONNECT_HEADERS },
      },
    );
    expect(await response.json()).toEqual({
      endpoint: 'https://mail.public.example/mcp',
      identity: null,
      token: null,
      unavailable: 'identity_session_required',
    });
  });

  test('P2-1: plaintext token reveal appends identity.token.reveal once per minute per session/IP', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example',
    });
    const cookie = await login(app, 'oa_fox-secret');
    const headers = { cookie, ...CONNECT_HEADERS };

    const first = await app.request('https://internal.example/ui/api/connect', {
      headers,
    });
    expect(first.status).toBe(200);
    expect((await first.json()).token).toBe('oa_fox-secret');

    const second = await app.request('https://internal.example/ui/api/connect', {
      headers,
    });
    expect(second.status).toBe(200);

    const reveals = readAuditEvents({ event: 'identity.token.reveal' });
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({
      event: 'identity.token.reveal',
      address: 'fox@test.example',
      outcome: 'ok',
    });
    expect(typeof reveals[0]!.ip).toBe('string');
  });

  test('P2-2: Sec-Fetch-Site=cross-site is rejected with 403', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example',
    });
    const cookie = await login(app, 'oa_fox-secret');
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: { cookie, 'sec-fetch-site': 'cross-site' },
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(readAuditEvents({ event: 'identity.token.reveal' })).toHaveLength(0);
  });

  test('request-origin fallback: without MCP_PUBLIC_URL endpoint uses request origin', async () => {
    // 钉死存量回退：未注入 publicBaseUrl 且 mcpPublicUrl 空时走请求 origin
    const { config } = await import('../src/lib/config.ts');
    const previous = config.mcpPublicUrl;
    (config as { mcpPublicUrl?: string }).mcpPublicUrl = undefined;
    try {
      const app = createApp({
        uiEnabled: true,
        tokenResolver: resolver,
      });
      const cookie = await login(app, 'oa_fox-secret');
      const response = await app.request(
        'https://internal.example/ui/api/connect',
        {
          headers: { cookie, ...CONNECT_HEADERS },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        endpoint: 'https://internal.example/mcp',
        identity: 'fox@test.example',
        token: 'oa_fox-secret',
        unavailable: null,
      });
    } finally {
      (config as { mcpPublicUrl?: string }).mcpPublicUrl = previous;
    }
  });

  test('exchange-code session returns token_unavailable (no plaintext held)', async () => {
    // link-exchange 建会话故意不存明文；Connect 必须 fail-closed 为 unavailable
    const store = new UiSessionStore({
      resolveToken: resolver,
      resolveTokenHash: hashResolver,
    });
    const mint = store.mintExchangeCode('oa_fox-secret', '127.0.0.1');
    expect(mint.ok).toBe(true);
    if (!mint.ok) return;
    const exchanged = store.exchangeCode(mint.code, '127.0.0.1');
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;

    const app = new Hono();
    app.route(
      '/ui/api',
      createUiApiRoutes(store, undefined, {
        publicBaseUrl: 'https://mail.public.example',
      }),
    );
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: {
          cookie: `${COOKIE_NAME}=${exchanged.sid}`,
          ...CONNECT_HEADERS,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      endpoint: 'https://mail.public.example/mcp',
      identity: 'fox@test.example',
      token: null,
      unavailable: 'token_unavailable',
    });
    expect(readAuditEvents({ event: 'identity.token.reveal' })).toHaveLength(0);
  });
});

describe('Connect reveal audit throttle map (R2, UiSessionStore cleanup)', () => {
  test('expired connect-reveal throttle entries are pruned on cleanup', () => {
    const store = new UiSessionStore({ resolveToken: resolver });
    const t0 = 1_000_000;
    store.seedConnectRevealAuditForTests('sid-a:10.0.0.1', t0);
    store.seedConnectRevealAuditForTests('sid-b:10.0.0.2', t0);
    expect(store.connectRevealAuditSizeForTests()).toBe(2);

    // 窗口边界（==）不删；对齐 lastMintDeniedAuditAt 的 `>` 语义
    store.cleanupThrottleMapsForTests(t0 + CONNECT_REVEAL_AUDIT_THROTTLE_MS);
    expect(store.connectRevealAuditSizeForTests()).toBe(2);

    store.cleanupThrottleMapsForTests(t0 + CONNECT_REVEAL_AUDIT_THROTTLE_MS + 1);
    expect(store.connectRevealAuditSizeForTests()).toBe(0);
  });

  test('connect-reveal throttle map is capped at MAX_TRACKED_IPS=1000', () => {
    const store = new UiSessionStore({ resolveToken: resolver });
    const now = Date.now();
    for (let i = 0; i < 1005; i += 1) {
      store.seedConnectRevealAuditForTests(`sid-${i}:127.0.0.1`, now);
    }
    expect(store.connectRevealAuditSizeForTests()).toBe(1005);
    store.cleanupThrottleMapsForTests(now);
    expect(store.connectRevealAuditSizeForTests()).toBe(1000);
  });

  test('claimConnectRevealAudit returns false inside the one-minute window', () => {
    const store = new UiSessionStore({ resolveToken: resolver });
    const t0 = 5_000_000;
    expect(store.claimConnectRevealAudit('sid-1', '203.0.113.9', t0)).toBe(true);
    expect(store.claimConnectRevealAudit('sid-1', '203.0.113.9', t0 + 1)).toBe(false);
    expect(
      store.claimConnectRevealAudit(
        'sid-1',
        '203.0.113.9',
        t0 + CONNECT_REVEAL_AUDIT_THROTTLE_MS,
      ),
    ).toBe(true);
  });

  test('R3: claimConnectRevealAudit caps at MAX_TRACKED without cleanup()', () => {
    const store = new UiSessionStore({ resolveToken: resolver });
    const t0 = 9_000_000;
    const max = CONNECT_REVEAL_AUDIT_MAX_TRACKED;
    for (let i = 0; i < max; i += 1) {
      expect(store.claimConnectRevealAudit(`sid-${i}`, '127.0.0.1', t0 + i)).toBe(true);
    }
    expect(store.connectRevealAuditSizeForTests()).toBe(max);
    // 读路径再认领新键：剪最旧，仍 ≤1000，且不经 cleanup()
    expect(store.claimConnectRevealAudit('sid-new', '127.0.0.1', t0 + max)).toBe(true);
    expect(store.connectRevealAuditSizeForTests()).toBe(max);
    // 被剪掉的最旧键可再次认领
    expect(store.claimConnectRevealAudit('sid-0', '127.0.0.1', t0 + max + 1)).toBe(true);
    expect(store.connectRevealAuditSizeForTests()).toBe(max);
  });
});
