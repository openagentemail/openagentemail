/**
 * #234 CI 常驻：真实 Chromium 同意页 Approve 表单 POST 头形态回归。
 * 断言：不再返回 403 forbidden_origin（R0：Origin:null + SFS:same-origin）。
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

describe('playwright consent Approve origin regression (#234)', () => {
  let base = '';
  /** @type {import('bun').Server | null} */
  let server = null;
  let sid = '';
  let address = '';
  let chromiumAvailable = false;

  beforeAll(async () => {
    // 探测 playwright + chromium 是否可用
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

  test('real browser form Approve does not return forbidden_origin', async () => {
    if (!chromiumAvailable) {
      // 非 CI 且未装浏览器：跳过，避免拖垮本地全量
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

    /** @type {{ status: number, body: string } | null} */
    let postResult = null;
    page.on('response', async (res) => {
      if (res.request().method() === 'POST' && res.url().includes('/ui/oauth/authorize')) {
        postResult = {
          status: res.status(),
          body: await res.text().catch(() => ''),
        };
      }
    });

    await page.goto(consentUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[value="approve"]');
    // 选已有 identity（默认 existing）；确保 address 可见
    await page.selectOption('select[name="address"]', address).catch(() => {});
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
      page.click('button[value="approve"]'),
    ]);

    // 等响应事件
    for (let i = 0; i < 50 && !postResult; i++) {
      await Bun.sleep(100);
    }
    await browser.close();

    expect(postResult).not.toBeNull();
    expect(postResult!.status).not.toBe(403);
    expect(postResult!.body).not.toContain('forbidden_origin');
    // 过闸后应为过渡页 200
    expect(postResult!.status).toBe(200);
    expect(postResult!.body).toContain('已授权');
  }, 60_000);
});
