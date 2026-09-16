/**
 * #234 CI 常驻：真实 Chromium 同意页 Approve 表单 POST 头形态回归。
 * 断言：
 * 1) 浏览器实发 Origin===null 且 Sec-Fetch-Site===same-origin（与 R0 矩阵一致）
 * 2) 响应非 403 forbidden_origin
 *
 * 实发头经 page.waitForRequest + request.allHeaders() 捕获（含 Sec-Fetch-*；
 * 同步 headers() 会缺 Fetch Metadata）。
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
  body: string;
  origin: string | null;
  secFetchSite: string | null;
};

function isApprovePost(url: string, method: string): boolean {
  return method === 'POST' && url.includes('/ui/oauth/authorize');
}

describe('playwright consent Approve origin regression (#234)', () => {
  let base = '';
  // 显式声明，消除 TS7034「变量隐式 any」
  let server: ReturnType<typeof Bun.serve> | null = null;
  let sid = '';
  let address = '';
  let chromiumAvailable = false;

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

    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: app.fetch,
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

    await page.goto(consentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[value="approve"]');
    await page.selectOption('select[name="address"]', address).catch(() => {});

    // 先注册有类型的捕获 Promise，再 click；头来自 allHeaders()
    const capturePromise: Promise<ApproveCapture> = page
      .waitForResponse((r) => isApprovePost(r.url(), r.request().method()))
      .then(async (res) => {
        const headers = await res.request().allHeaders();
        return {
          status: res.status(),
          // 文档导航的 body 走页面，不在此读 res.text()（常为空）
          body: '',
          origin: headers['origin'] ?? null,
          secFetchSite: headers['sec-fetch-site'] ?? null,
        };
      });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
      page.click('button[value="approve"]'),
    ]);

    const postResult: ApproveCapture = await capturePromise;
    await browser.close();

    // CodeRabbit Minor：必须钉死浏览器实发头（与 R0 矩阵一致）
    expect(postResult.origin).toBe('null');
    expect(postResult.secFetchSite).toBe('same-origin');
    // 过闸：非 403（过渡页 meta refresh 会立刻外跳，不依赖 DOM 正文）
    expect(postResult.status).not.toBe(403);
    expect(postResult.status).toBe(200);
  }, 60_000);
});
