/**
 * #234 CI 常驻：真实 Chromium 同意页 Approve 表单 POST 头形态回归。
 * 断言：
 * 1) 浏览器实发 Origin===null 且 Sec-Fetch-Site===same-origin（与 R0 矩阵一致）
 * 2) 响应非 403，且成功 HTML 含「已授权」
 *
 * 成功等待（禁 sleep / 禁立即读 content）：
 * - Bun.serve 包装在收到真实浏览器 POST 时 resolve 有类型 Promise（头+状态+正文）
 *   （CDP getResponseBody 在全量并行下会 No resource；DOM 会被 meta refresh 读空）
 * - click 前注册该 Promise；click 后 await 它，再 waitForURL + waitForLoadState
 *
 * 浏览器二进制：`bunx playwright install chromium`（CI workflow 已装）。
 * 本地未装浏览器且非 CI 时 skip；CI / OAE_REQUIRE_PLAYWRIGHT=1 则硬失败。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-pw-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-234-pw-'));
process.env.UI_ENABLED = 'true';
process.env.NTFY_ENABLED = 'false';
process.env.WEBHOOKS_ENABLED = 'false';

const { describe, expect, test, beforeAll, afterAll } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { s256Challenge } = await import('../src/lib/oauth-pkce.ts');
const { config } = await import('../src/lib/config.ts');
const adminKey = [...config.apiKeys][0]!;

const CLIENT_ID = 'http://127.0.0.1:9/cimd.json';
const REDIRECT = 'http://127.0.0.1:54321/callback';
const requirePw = process.env.CI === 'true' || process.env.OAE_REQUIRE_PLAYWRIGHT === '1';

/** Approve POST 捕获结果（显式类型，避免回调赋值收窄失败） */
type ApproveCapture = {
  status: number;
  origin: string | null;
  secFetchSite: string | null;
  body: string;
};

describe('playwright consent Approve origin regression (#234)', () => {
  let base = '';
  // 显式声明，消除 TS7034「变量隐式 any」
  let server: ReturnType<typeof Bun.serve> | null = null;
  let sid = '';
  let address = '';
  let chromiumAvailable = false;
  let appFetch: (req: Request) => Response | Promise<Response> = () =>
    new Response('app not ready', { status: 500 });

  /** 每次用例挂接：服务端见到 Approve POST 时 resolve */
  let resolveApproveHit: ((value: ApproveCapture) => void) | null = null;

  beforeAll(async () => {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      chromiumAvailable = true;
    } catch (err) {
      if (requirePw) {
        throw new Error(
          `playwright chromium required in CI but unavailable: ${String(err)}`,
        );
      }
      chromiumAvailable = false;
      return;
    }

    const app = createApp({
      uiEnabled: true,
      oauth: {
        cimdFetcher: async () =>
          new Response(
            JSON.stringify({
              client_id: CLIENT_ID,
              client_name: 'PW Client',
              redirect_uris: [REDIRECT, 'http://127.0.0.1/callback'],
              token_endpoint_auth_method: 'none',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    });
    appFetch = app.fetch.bind(app);

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/ui/oauth/authorize') {
          const origin = req.headers.get('origin');
          const secFetchSite = req.headers.get('sec-fetch-site');
          const res = await appFetch(req);
          const body = await res.clone().text();
          resolveApproveHit?.({
            status: res.status,
            origin,
            secFetchSite,
            body,
          });
          resolveApproveHit = null;
          return res;
        }
        return appFetch(req);
      },
    });
    base = `http://127.0.0.1:${server.port}`;

    const created = createIdentity({ localpart: 'pw-consent' });
    if (!created) throw new Error('createIdentity failed');
    address = created.identity.address;

    const login = await fetch(`${base}/ui/api/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
      },
      body: JSON.stringify({ token: adminKey }),
    });
    if (login.status !== 200) {
      throw new Error(`login ${login.status}`);
    }
    const setCookie = login.headers.get('set-cookie') ?? '';
    const m = /oae_ui=([^;]+)/.exec(setCookie);
    if (!m) throw new Error('no session cookie');
    sid = m[1]!;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test('real browser form Approve sends Origin:null + SFS:same-origin and is not 403', async () => {
    if (!chromiumAvailable) {
      expect(requirePw).toBe(false);
      return;
    }

    const { chromium } = await import('playwright');
    const challenge = s256Challenge(randomBytes(32).toString('base64url'));
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${base}/mcp`,
      state: 'pw-st',
    });
    const consentUrl = `${base}/ui/oauth/authorize?${q}`;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: 'oae_ui',
        value: sid,
        domain: '127.0.0.1',
        path: '/ui',
        httpOnly: true,
        sameSite: 'Strict',
      },
    ]);
    const page = await context.newPage();

    // click 前注册：服务端命中后 resolve（有类型 Promise，非回调赋值收窄）
    const approveHitPromise: Promise<ApproveCapture> = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for Approve POST at server')),
        15_000,
      );
      resolveApproveHit = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });

    await page.goto(consentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[value="approve"]');
    await page.selectOption('select[name="address"]', address).catch(() => {});

    // POST 导航到同意页响应；随后 meta refresh 外跳属预期
    const postNav = page.waitForURL(
      (url) => url.pathname === '/ui/oauth/authorize',
      { timeout: 15_000 },
    );

    await page.click('button[value="approve"]');

    const postResult: ApproveCapture = await approveHitPromise;
    await postNav.catch(() => null);
    await page.waitForLoadState('domcontentloaded').catch(() => null);

    await browser.close();

    // 浏览器实发头（服务端实收 = 真值）+ 成功正文（响应体，非 DOM 竞态）
    expect(postResult.origin).toBe('null');
    expect(postResult.secFetchSite).toBe('same-origin');
    expect(postResult.status).not.toBe(403);
    expect(postResult.status).toBe(200);
    expect(postResult.body).toContain('已授权');
    expect(postResult.body).not.toContain('forbidden_origin');
  }, 60_000);
});
