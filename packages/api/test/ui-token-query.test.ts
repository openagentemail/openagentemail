// Issue #60: ?token= query direct login for bookmarkable admin UI
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-token-query-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const {
  UiSessionStore,
  createUiSessionRoutes,
  uiSessionAuth,
  uiSessionBodyLimit,
  requireUiOrigin,
} = await import('../src/lib/ui-session.ts');

const APP_JS = readFileSync(
  resolve(import.meta.dir, '../src/ui/client/app.js'),
  'utf8',
);

// 提取 app.js 中与 URL query token 登录及 start 流程相关的关键实现
const startConsume = APP_JS.indexOf('function consumeQueryToken() {');
expect(startConsume).toBeGreaterThan(-1);
const endConsume = APP_JS.indexOf('async function loginWithToken(credential) {');
expect(endConsume).toBeGreaterThan(startConsume);
const consumeQueryTokenSrc = APP_JS.slice(startConsume, endConsume);

const startLogin = APP_JS.indexOf('async function loginWithToken(credential) {');
expect(startLogin).toBeGreaterThan(-1);
const endLogin = APP_JS.indexOf('(async function start() {');
expect(endLogin).toBeGreaterThan(startLogin);
const loginWithTokenSrc = APP_JS.slice(startLogin, endLogin);

const startStart = APP_JS.indexOf('(async function start() {');
expect(startStart).toBeGreaterThan(-1);
const endStart = APP_JS.lastIndexOf('})();') + 5;
expect(endStart).toBeGreaterThan(startStart);
const startSrc = APP_JS.slice(startStart, endStart);

const startFormSubmit = APP_JS.indexOf("loginForm.addEventListener('submit', async function (event) {");
expect(startFormSubmit).toBeGreaterThan(-1);
const endFormSubmit = APP_JS.indexOf("byId('logout-button').addEventListener('click',", startFormSubmit);
expect(endFormSubmit).toBeGreaterThan(startFormSubmit);
const formSubmitSrc = APP_JS.slice(startFormSubmit, endFormSubmit);

interface HarnessOptions {
  initialUrl: string;
  isSecure?: boolean;
  hasReplaceState?: boolean;
  meResponse?: { status: number; body?: unknown; error?: Error };
  sessionResponse?: { status: number; body?: unknown; error?: Error };
  customFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

function createClientHarness(options: HarnessOptions) {
  const calls = {
    fetches: [] as { url: string; init?: RequestInit }[],
    replacedUrls: [] as string[],
    showLogin: [] as string[],
    showInboxCount: 0,
    startSessionCount: 0,
    announced: [] as string[],
  };

  let currentUrl = options.initialUrl;
  const historyState = { count: 0 };

  const mockWindow = {
    isSecureContext: options.isSecure !== false,
    location: {
      get href() {
        return currentUrl;
      },
      set href(val: string) {
        currentUrl = val;
      },
      get pathname() {
        return new URL(currentUrl).pathname;
      },
      get search() {
        return new URL(currentUrl).search;
      },
      get hash() {
        return new URL(currentUrl).hash;
      },
    },
    history: {
      state: historyState,
      replaceState:
        options.hasReplaceState === false
          ? undefined
          : (state: unknown, _title: string, url: string) => {
              const resolved = new URL(url, currentUrl).href;
              currentUrl = resolved;
              calls.replacedUrls.push(url);
            },
    },
  };

  const loginToken = { value: '', focus: () => {}, disabled: false };
  const loginError = { textContent: '' };
  const loginSubmit = { disabled: false };
  const loginRemember = { checked: false };
  const loginView = { hidden: false };
  const inboxView = { hidden: true };
  const insecureWarning = { hidden: true };
  const state = { me: null as unknown };

  const loginForm = {
    submitHandler: null as any,
    addEventListener: (event: string, fn: any) => {
      if (event === 'submit') loginForm.submitHandler = fn;
    },
  };

  const isLoginContextSafe = () => {
    try {
      const u = new URL(currentUrl);
      const isLoopback =
        u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      return mockWindow.isSecureContext || isLoopback;
    } catch {
      return false;
    }
  };

  const configureLoginGate = () => {
    const safe = isLoginContextSafe();
    insecureWarning.hidden = safe;
    loginToken.disabled = !safe;
    loginSubmit.disabled = !safe;
    return safe;
  };

  const showLogin = (msg: string) => {
    calls.showLogin.push(msg);
    inboxView.hidden = true;
    loginView.hidden = false;
    loginError.textContent = msg || '';
    configureLoginGate();
  };

  const showInbox = () => {
    calls.showInboxCount += 1;
    loginView.hidden = true;
    inboxView.hidden = false;
    loginError.textContent = '';
  };

  const startSession = async () => {
    calls.startSessionCount += 1;
  };

  const consumeReturnTo = (_payload: unknown) => false;

  const announce = (msg: string) => {
    calls.announced.push(msg);
  };

  const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.fetches.push({ url, init });
    if (options.customFetch) {
      return options.customFetch(url, init);
    }
    if (url === '/ui/api/me') {
      if (options.meResponse?.error) throw options.meResponse.error;
      const status = options.meResponse?.status ?? 401;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () =>
          options.meResponse?.body ??
          (status === 200 ? { kind: 'admin' } : { error: 'unauthorized' }),
      } as unknown as Response;
    }
    if (url === '/ui/api/session') {
      if (options.sessionResponse?.error) throw options.sessionResponse.error;
      const status = options.sessionResponse?.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () =>
          options.sessionResponse?.body ??
          (status === 200 ? { kind: 'admin' } : { error: 'invalid_token' }),
      } as unknown as Response;
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const runner = new Function(
    'window',
    'fetch',
    'loginToken',
    'loginError',
    'loginSubmit',
    'loginRemember',
    'loginView',
    'inboxView',
    'insecureWarning',
    'state',
    'isLoginContextSafe',
    'configureLoginGate',
    'showLogin',
    'showInbox',
    'startSession',
    'consumeReturnTo',
    'announce',
    'loginForm',
    `
      ${consumeQueryTokenSrc}
      ${loginWithTokenSrc}
      ${formSubmitSrc}
      return {
        consumeQueryToken: consumeQueryToken,
        loginWithToken: loginWithToken,
        runStart: function () {
          return ${startSrc}
        },
        runPasteLogin: async function (token) {
          loginToken.value = token;
          if (loginForm.submitHandler) {
            await loginForm.submitHandler({ preventDefault: function () {} });
          }
        }
      };
    `,
  );

  const instance = runner(
    mockWindow,
    mockFetch,
    loginToken,
    loginError,
    loginSubmit,
    loginRemember,
    loginView,
    inboxView,
    insecureWarning,
    state,
    isLoginContextSafe,
    configureLoginGate,
    showLogin,
    showInbox,
    startSession,
    consumeReturnTo,
    announce,
    loginForm,
  );

  return {
    mockWindow,
    loginToken,
    loginError,
    loginSubmit,
    loginRemember,
    loginView,
    inboxView,
    insecureWarning,
    state,
    calls,
    getCurrentUrl: () => currentUrl,
    instance,
  };
}

describe('Issue #60: bookmarkable ?token= query parameter direct login', () => {
  // 1. 无会话 + ?token=<valid> → 自动登录成功，进入应用，URL 中 token 已剥离（断言 replaceState 后的 location）。
  test('1. Unauthenticated + ?token=<valid> auto-logins successfully and strips token from URL', async () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=secret-token-123',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });

    await harness.instance.runStart();

    // 断言 1: URL 中 token 已被 replaceState 剥离
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui');
    expect(harness.calls.replacedUrls).toEqual(['/ui']);

    // 断言 2: 请求了 /ui/api/me 后再请求 /ui/api/session
    expect(harness.calls.fetches.length).toBe(2);
    expect(harness.calls.fetches[0].url).toBe('/ui/api/me');
    expect(harness.calls.fetches[1].url).toBe('/ui/api/session');
    expect(harness.calls.fetches[1].init?.method).toBe('POST');
    const sentBody = JSON.parse(harness.calls.fetches[1].init?.body as string);
    expect(sentBody).toEqual({ token: 'secret-token-123', remember: false });

    // 断言 3: 进入应用
    expect(harness.calls.showInboxCount).toBe(1);
    expect(harness.calls.startSessionCount).toBe(1);
    expect(harness.inboxView.hidden).toBe(false);
    expect(harness.loginView.hidden).toBe(true);
    expect(harness.state.me).toEqual({ kind: 'admin' });

    // 断言 4: 登录输入框被清空，不留 token
    expect(harness.loginToken.value).toBe('');
  });

  // 2. 无会话 + ?token=<invalid> → 登录表单显示、错误文案正确、token 不回显、参数已剥离。
  test('2. Unauthenticated + ?token=<invalid> shows login error, strips token from URL, and never echoes token', async () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=bad-token-xyz',
      meResponse: { status: 401 },
      sessionResponse: { status: 401, body: { error: 'invalid_token' } },
    });

    await harness.instance.runStart();

    // 断言 1: 参数已剥离
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui');
    expect(harness.calls.replacedUrls).toEqual(['/ui']);

    // 断言 2: 登录表单显示
    expect(harness.loginView.hidden).toBe(false);
    expect(harness.inboxView.hidden).toBe(true);
    expect(harness.calls.showInboxCount).toBe(0);

    // 断言 3: 错误文案正确
    expect(harness.loginError.textContent).toBe('That token is not valid.');
    expect(harness.calls.showLogin).toContain('That token is not valid.');

    // 断言 4: token 不得回显到输入框或错误文案中
    expect(harness.loginToken.value).toBe('');
    expect(harness.loginError.textContent).not.toContain('bad-token-xyz');
  });

  // 3. 有会话 + ?token=<anything> → 直接进应用、不发起第二个 session POST、参数剥离、原会话保持。
  test('3. Authenticated (200 on /ui/api/me) + ?token=<anything> enters app directly, strips parameter, and skips session POST', async () => {
    const existingSession = { kind: 'admin', email: 'existing@test.example' };
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=ignored-token-override',
      meResponse: { status: 200, body: existingSession },
    });

    await harness.instance.runStart();

    // 断言 1: 参数已被剥离
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui');
    expect(harness.calls.replacedUrls).toEqual(['/ui']);

    // 断言 2: 只请求了 /ui/api/me，绝对不发起第二个 session POST
    expect(harness.calls.fetches.length).toBe(1);
    expect(harness.calls.fetches[0].url).toBe('/ui/api/me');

    // 断言 3: 原会话保持，直接进应用
    expect(harness.state.me).toEqual(existingSession);
    expect(harness.calls.showInboxCount).toBe(1);
    expect(harness.calls.startSessionCount).toBe(1);
    expect(harness.inboxView.hidden).toBe(false);
    expect(harness.loginView.hidden).toBe(true);
  });

  // 4. 剥离后刷新/重进不再用旧 token 重放（参数不在 location）。
  test('4. Reload after parameter stripping has clean location and does not replay old token', async () => {
    // 第一次访问：带 token
    const firstHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=one-time-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await firstHarness.instance.runStart();

    // replaceState 后的 URL 是 clean URL
    const cleanUrl = firstHarness.getCurrentUrl();
    expect(cleanUrl).toBe('https://admin.example/ui');

    // 用户刷新页面（模拟浏览器用当前的 cleanUrl 重新初始化加载）
    const reloadHarness = createClientHarness({
      initialUrl: cleanUrl, // 刷新时已无 token query 参数
      meResponse: { status: 401 }, // 假定 session 此时已失效
    });

    await reloadHarness.instance.runStart();

    // 断言: 刷新时 consumeQueryToken 返回 null，不发送 session POST，直接显示空登录表单
    expect(reloadHarness.calls.fetches.length).toBe(1);
    expect(reloadHarness.calls.fetches[0].url).toBe('/ui/api/me');
    expect(reloadHarness.calls.showLogin).toEqual(['']);
    expect(reloadHarness.loginError.textContent).toBe('');
    expect(reloadHarness.loginToken.value).toBe('');
    expect(reloadHarness.calls.replacedUrls.length).toBe(0);
  });

  // 5. 参数剥离应保留其余 query 参数和 URL hash
  test('5. Parameter stripping preserves other query parameters and URL hash', () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?foo=bar&token=secret123&page=2#tab-settings',
    });

    const consumed = harness.instance.consumeQueryToken();
    expect(consumed).toBe('secret123');
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui?foo=bar&page=2#tab-settings');
    expect(harness.calls.replacedUrls).toEqual(['/ui?foo=bar&page=2#tab-settings']);
  });

  // 6. 不安全 HTTP 环境（非 loopback）剥离 token，且拒绝发送 session POST
  test('6. Insecure HTTP context strips token parameter but refuses to submit token over network', async () => {
    const harness = createClientHarness({
      initialUrl: 'http://remote.example.com/ui?token=secret123',
      isSecure: false,
      meResponse: { status: 401 },
    });

    await harness.instance.runStart();

    // URL token 仍被剥离以防残留
    expect(harness.getCurrentUrl()).toBe('http://remote.example.com/ui');

    // 绝对不向服务端 POST session 凭据
    const sessionPost = harness.calls.fetches.find((f) => f.url === '/ui/api/session');
    expect(sessionPost).toBeUndefined();

    // 提示不安全并禁用登录按钮
    expect(harness.insecureWarning.hidden).toBe(false);
    expect(harness.loginSubmit.disabled).toBe(true);
    expect(harness.loginToken.disabled).toBe(true);
    expect(harness.loginToken.value).toBe('');
  });

  // 7. 深链深层路径（如 /ui/tasks/task-42?token=...）剥离参数时保持路由路径
  test('7. Deep link path is preserved during token consumption', () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui/tasks/task-42?token=secret123',
    });

    const consumed = harness.instance.consumeQueryToken();
    expect(consumed).toBe('secret123');
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui/tasks/task-42');
    expect(harness.calls.replacedUrls).toEqual(['/ui/tasks/task-42']);
  });

  // 8. 与真实服务端 UiSessionStore 端到端集成测试
  test('8. End-to-end integration with real UiSessionStore', async () => {
    const validAdminToken = 'admin-secret-token';
    const validTokenHash = createHash('sha256').update(validAdminToken).digest('hex');

    const store = new UiSessionStore({
      resolveToken: (tok: string) => (tok === validAdminToken ? { kind: 'admin' } : null),
      resolveTokenHash: (h: string) => (h === validTokenHash ? { kind: 'admin' } : null),
    });

    const app = new Hono();
    app.use('/ui/api/session', uiSessionBodyLimit);
    app.use('/ui/api/session', requireUiOrigin);
    app.route('/ui/api/session', createUiSessionRoutes(store));
    app.get('/ui/api/me', uiSessionAuth(store), (c) => c.json(c.get('auth')));

    let cookieHeader = '';

    const e2eFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (cookieHeader) {
        headers.set('cookie', cookieHeader);
      }
      headers.set('origin', 'http://localhost:3100');
      headers.set('sec-fetch-site', 'same-origin');

      const res = await app.request(`http://localhost:3100${url}`, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body,
      });

      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        // 提取 oae_ui=... 部分
        const match = setCookie.match(/oae_ui=[^;]+/);
        if (match) {
          cookieHeader = match[0];
        }
      }
      return res;
    };

    // 场景 A: 无会话访问 http://localhost:3100/ui?token=admin-secret-token
    const clientA = createClientHarness({
      initialUrl: 'http://localhost:3100/ui?token=admin-secret-token',
      customFetch: e2eFetch,
    });

    await clientA.instance.runStart();

    // 成功登录进应用，URL 参数剥离
    expect(clientA.getCurrentUrl()).toBe('http://localhost:3100/ui');
    expect(clientA.calls.showInboxCount).toBe(1);
    expect(clientA.state.me).toEqual({ kind: 'admin' });
    expect(cookieHeader).toContain('oae_ui=');

    // 场景 B: 已有会话，带一个不同的 query token 访问，验证已有会话优先，不轮换或覆盖会话
    const clientB = createClientHarness({
      initialUrl: 'http://localhost:3100/ui?token=another-token-attempt',
      customFetch: e2eFetch,
    });

    const cookieBefore = cookieHeader;
    await clientB.instance.runStart();

    // 剥离参数
    expect(clientB.getCurrentUrl()).toBe('http://localhost:3100/ui');
    // 原会话直接进入，不发起 session POST
    expect(clientB.calls.showInboxCount).toBe(1);
    expect(clientB.state.me).toEqual({ kind: 'admin' });
    const postCalls = clientB.calls.fetches.filter((f) => f.url === '/ui/api/session');
    expect(postCalls.length).toBe(0);
    // Cookie 未被更改
    expect(cookieHeader).toBe(cookieBefore);
  });

  // 9. Fix 1 (ZCode P2-2): history.replaceState 不可用时 fail-closed：拒绝 query 自动登录，退回表单登录，token 不回显
  test('9. Unavailable history.replaceState fails closed: refuses query auto-login, shows form, does not echo token', async () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=super-secret-token',
      hasReplaceState: false,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });

    await harness.instance.runStart();

    // 断言 1: 没有发起 POST /ui/api/session 发送 token（硬性拒绝，避免凭据残留在地址栏）
    expect(harness.calls.fetches.length).toBe(1);
    expect(harness.calls.fetches[0].url).toBe('/ui/api/me');

    // 断言 2: 退回普通表单登录
    expect(harness.loginView.hidden).toBe(false);
    expect(harness.inboxView.hidden).toBe(true);
    expect(harness.calls.showInboxCount).toBe(0);
    expect(harness.calls.showLogin).toEqual(['']);

    // 断言 3: token 永不回显进输入框
    expect(harness.loginToken.value).toBe('');
    expect(harness.loginError.textContent).toBe('');
    expect(harness.calls.announced).toHaveLength(0);
  });

  // 10. Fix 2 (ZCode P2-3): query 链接登录成功展示 announcement 提示，粘贴表单登录不展示
  test('10. Visible notice appears on query-login success and does NOT appear on paste-form login success', async () => {
    // 场景 A: Admin 身份 query token 登录成功 → 提示 "Signed in via link as Admin session"
    const adminLinkHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=admin-query-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await adminLinkHarness.instance.runStart();
    expect(adminLinkHarness.calls.showInboxCount).toBe(1);
    expect(adminLinkHarness.calls.announced).toEqual(['Signed in via link as Admin session']);

    // 场景 B: Identity 身份 query token 登录成功 → 提示 "Signed in via link as <address>"
    const identityLinkHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=identity-query-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'identity', address: 'agent-bot@example.com' } },
    });
    await identityLinkHarness.instance.runStart();
    expect(identityLinkHarness.calls.showInboxCount).toBe(1);
    expect(identityLinkHarness.calls.announced).toEqual(['Signed in via link as agent-bot@example.com']);

    // 场景 C: 表单粘贴输入登录成功 → 不展示 "Signed in via link" 提示
    const formHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    // 启动显示登录表单
    await formHarness.instance.runStart();
    expect(formHarness.calls.showLogin).toEqual(['']);
    expect(formHarness.calls.announced).toHaveLength(0);

    // 用户在表单粘贴 token 提交
    await formHarness.instance.runPasteLogin('admin-paste-token');
    expect(formHarness.calls.showInboxCount).toBe(1);
    // 验证：表单登录完全不触发链接登录提示
    const linkAnnouncements = formHarness.calls.announced.filter((m) =>
      m.includes('Signed in via link'),
    );
    expect(linkAnnouncements).toHaveLength(0);
  });
});
