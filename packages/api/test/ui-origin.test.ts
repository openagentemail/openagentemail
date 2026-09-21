/**
 * #234 requireUiOrigin 放行矩阵全格 + 三负控 + 同意页表单头形态。
 * 套件标准前奏：config.ts 在 import 时解析 env。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-origin-'));
process.env.UI_ENABLED = 'true';

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
const {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} = await import('../src/lib/ui-session.ts');
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { s256Challenge } = await import('../src/lib/oauth-pkce.ts');
const { config } = await import('../src/lib/config.ts');

const resolver = (token: string): Auth | null => (token === 'ok' ? { kind: 'admin' } : null);

function appWithOriginGuard() {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(new UiSessionStore({ resolveToken: resolver })));
  return app;
}

function post(headers: Record<string, string>, body = '{"token":"ok"}') {
  return appWithOriginGuard().request('https://mail.example/ui/api/session', {
    method: 'POST',
    headers,
    body,
  });
}

/** 矩阵格：期望状态 + 头组合 */
type Cell = {
  name: string;
  headers: Record<string, string>;
  status: number;
};

describe('UI unsafe-method Origin gate', () => {
  test('same-origin JSON is accepted', async () => {
    const response = await post({
      'content-type': 'application/json',
      origin: 'https://mail.example',
      'sec-fetch-site': 'same-origin',
    });
    expect(response.status).toBe(200);
  });

  test('application/json from an evil Origin is rejected before login', async () => {
    const response = await post({
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
  });

  test('cross-site text/plain is rejected and no CORS permission leaks', async () => {
    const response = await post({
      'content-type': 'text/plain',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('missing Origin needs an explicit same-origin browser signal', async () => {
    const allowed = await post({
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    });
    expect(allowed.status).toBe(200);

    const ambiguous = await post({ 'content-type': 'application/json' });
    expect(ambiguous.status).toBe(403);
  });

  test('TLS termination may change only the upstream scheme, not the public host', async () => {
    const app = appWithOriginGuard();
    const response = await app.request('http://mail.example/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://mail.example',
        'sec-fetch-site': 'same-origin',
      },
      body: '{"token":"ok"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  // ── #234 终审矩阵全格（SFS × Origin）──────────────────────────────
  test('matrix cells: Sec-Fetch-Site × Origin disposition', async () => {
    const cells: Cell[] = [
      // same-origin 行
      {
        name: 'same-origin + parseable same Origin',
        headers: {
          'content-type': 'application/json',
          origin: 'https://mail.example',
          'sec-fetch-site': 'same-origin',
        },
        status: 200,
      },
      {
        name: 'same-origin + literal Origin null (fix cell)',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
          'sec-fetch-site': 'same-origin',
        },
        status: 200,
      },
      {
        name: 'same-origin + absent Origin',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        status: 200,
      },
      // cross-site / same-site 锁死（任意 Origin）
      {
        name: 'cross-site + matching Origin locked',
        headers: {
          'content-type': 'application/json',
          origin: 'https://mail.example',
          'sec-fetch-site': 'cross-site',
        },
        status: 403,
      },
      {
        name: 'cross-site + absent Origin locked',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        },
        status: 403,
      },
      {
        name: 'cross-site + Origin null locked',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
          'sec-fetch-site': 'cross-site',
        },
        status: 403,
      },
      {
        name: 'same-site + matching Origin locked',
        headers: {
          'content-type': 'application/json',
          origin: 'https://mail.example',
          'sec-fetch-site': 'same-site',
        },
        status: 403,
      },
      {
        name: 'same-site + Origin null locked',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
          'sec-fetch-site': 'same-site',
        },
        status: 403,
      },
      {
        name: 'same-site + absent Origin locked',
        headers: {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-site',
        },
        status: 403,
      },
      // SFS 缺席行（不收紧：可解析同源仍放）
      {
        name: 'absent SFS + parseable same Origin kept open',
        headers: {
          'content-type': 'application/json',
          origin: 'https://mail.example',
        },
        status: 200,
      },
      {
        name: 'absent SFS + Origin null fail-closed',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
        },
        status: 403,
      },
      {
        name: 'absent SFS + absent Origin fail-closed',
        headers: { 'content-type': 'application/json' },
        status: 403,
      },
      // 其它
      {
        name: 'same-origin + evil Origin still rejected',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          'sec-fetch-site': 'same-origin',
        },
        status: 403,
      },
      {
        name: 'absent SFS + evil Origin rejected',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
        },
        status: 403,
      },
    ];

    for (const cell of cells) {
      const res = await post(cell.headers);
      expect(res.status, cell.name).toBe(cell.status);
      if (cell.status === 403) {
        const body = (await res.json()) as { error?: string };
        expect(body.error, cell.name).toBe('forbidden_origin');
      }
    }
  });

  // ── 三负控显式钉（任务卡点名）────────────────────────────────────
  test('three negative controls still 403', async () => {
    const negatives = [
      {
        name: 'SFS cross-site',
        headers: {
          'content-type': 'application/json',
          origin: 'https://mail.example',
          'sec-fetch-site': 'cross-site',
        },
      },
      {
        name: 'evil Origin',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          'sec-fetch-site': 'same-origin',
        },
      },
      {
        name: 'Origin null + SFS cross-site',
        headers: {
          'content-type': 'application/json',
          origin: 'null',
          'sec-fetch-site': 'cross-site',
        },
      },
    ];
    for (const neg of negatives) {
      const res = await post(neg.headers);
      expect(res.status, neg.name).toBe(403);
      expect(((await res.json()) as { error: string }).error, neg.name).toBe(
        'forbidden_origin',
      );
    }
  });
});

describe('#234 consent POST form-header shape', () => {
  const CLIENT_ID = 'http://127.0.0.1:9/cimd.json';
  const REDIRECT = 'http://127.0.0.1:54321/callback';
  const RESOURCE = 'http://localhost/mcp';
  // 全量套件下 config 可能已被其它文件先加载；用现行 apiKeys
  const adminKey = [...config.apiKeys][0]!;

  function cimdFetcher() {
    return async () =>
      new Response(
        JSON.stringify({
          client_id: CLIENT_ID,
          client_name: 'Origin Matrix Client',
          redirect_uris: [REDIRECT, 'http://127.0.0.1/callback'],
          token_endpoint_auth_method: 'none',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
  }

  async function loginCookie(app: ReturnType<typeof createApp>) {
    const res = await app.request('http://localhost/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({ token: adminKey }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const m = /oae_ui=([^;]+)/.exec(setCookie);
    expect(m).toBeTruthy();
    return `oae_ui=${m![1]}`;
  }

  test('Origin null + SFS same-origin form POST leaves requireUiOrigin (not 403)', async () => {
    const app = createApp({
      uiEnabled: true,
      oauth: { cimdFetcher: cimdFetcher() },
    });
    const { identity } = createIdentity({ localpart: 'origin-null-fix' })!;
    const cookie = await loginCookie(app);
    const challenge = s256Challenge(randomBytes(32).toString('base64url'));

    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      resource: RESOURCE,
      state: 'st-null',
      identity_mode: 'existing',
      address: identity.address,
      decision: 'approve',
    });

    // R0 实发头形态：Origin:null + Sec-Fetch-Site:same-origin + navigate/document
    const approved = await app.request('http://localhost/ui/oauth/authorize', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });

    expect(approved.status).not.toBe(403);
    const text = await approved.text();
    expect(text).not.toContain('forbidden_origin');
    // 过闸后应走到业务成功过渡页
    expect(approved.status).toBe(200);
    // #137 B2：handoff 随 locale；缺省 en
    expect(text).toMatch(/已授权|Authorized/);
  });
});
