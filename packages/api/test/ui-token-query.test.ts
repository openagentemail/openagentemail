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

const startFormSubmit = APP_JS.indexOf('var loginGeneration = 0;');
expect(startFormSubmit).toBeGreaterThan(-1);
const endFormSubmit = APP_JS.indexOf("byId('logout-button').addEventListener('click',", startFormSubmit);
expect(endFormSubmit).toBeGreaterThan(startFormSubmit);
const formSubmitSrc = APP_JS.slice(startFormSubmit, endFormSubmit);

const startLogout = APP_JS.indexOf("byId('logout-button').addEventListener('click',");
expect(startLogout).toBeGreaterThan(-1);
const endLogout = APP_JS.indexOf("identitySearch.addEventListener('input',", startLogout);
expect(endLogout).toBeGreaterThan(startLogout);
const logoutSrc = APP_JS.slice(startLogout, endLogout);

class CookieJar {
  private cookies = new Map<string, string>();
  public writes: string[] = [];

  get cookie(): string {
    const pairs: string[] = [];
    for (const [k, v] of this.cookies.entries()) {
      pairs.push(`${k}=${v}`);
    }
    return pairs.join('; ');
  }

  set cookie(cookieStr: string) {
    this.writes.push(cookieStr);
    const parts = cookieStr.split(';');
    const firstPart = parts[0] || '';
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx === -1) return;
    const name = firstPart.slice(0, eqIdx).trim();
    const val = firstPart.slice(eqIdx + 1).trim();

    let isMaxAge0 = false;
    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i].trim().toLowerCase();
      if (attr === 'max-age=0') {
        isMaxAge0 = true;
      }
    }

    if (isMaxAge0 || val === '') {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, val);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, val: string) {
    this.cookies.set(name, val);
  }

  delete(name: string) {
    this.cookies.delete(name);
  }

  clear() {
    this.cookies.clear();
  }
}

interface HarnessOptions {
  initialUrl: string;
  isSecure?: boolean;
  hasReplaceState?: boolean;
  storageThrows?: boolean;
  cookieThrows?: boolean;
  hangStartSession?: Promise<void>;
  initialCookies?: Record<string, string>;
  initialStorage?: Record<string, string>;
  sharedCookieJar?: CookieJar;
  sharedStorage?: Map<string, string>;
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
  const cookieJar = options.sharedCookieJar ?? new CookieJar();
  if (options.initialCookies) {
    for (const [k, v] of Object.entries(options.initialCookies)) {
      cookieJar.set(k, v);
    }
  }
  if (options.initialStorage) {
    for (const [k, v] of Object.entries(options.initialStorage)) {
      cookieJar.set(k, v);
    }
  }

  const bodyClassSet = new Set<string>();
  const mockDocument = {
    get cookie() {
      if (options.cookieThrows || options.storageThrows) {
        throw new Error('Cookies disabled');
      }
      return cookieJar.cookie;
    },
    set cookie(str: string) {
      if (options.cookieThrows || options.storageThrows) {
        throw new Error('Cookies disabled');
      }
      cookieJar.cookie = str;
    },
    body: {
      classList: {
        add: (c: string) => bodyClassSet.add(c),
        remove: (c: string) => bodyClassSet.delete(c),
        contains: (c: string) => bodyClassSet.has(c),
      },
    },
  };

  const mockWindow = {
    isSecureContext: options.isSecure !== false,
    document: mockDocument,
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
      replace: (path: string) => {
        calls.replacedUrls.push(path);
        currentUrl = new URL(path, currentUrl).href;
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
  const linkLoginNotice = { textContent: '', hidden: true };
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
    linkLoginNotice.hidden = true;
    linkLoginNotice.textContent = '';
    bodyClassSet.delete('link-login-active');
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
    if (options.hangStartSession) {
      await options.hangStartSession;
    }
  };

  const consumeReturnTo = (payload: any) => {
    const path = payload && typeof payload.returnTo === 'string' ? payload.returnTo : '';
    if (!path || path.charAt(0) !== '/') return false;
    if (path.length >= 2 && path.charAt(1) === '/') return false;
    if (path.indexOf('/ui/') !== 0 && path !== '/ui') return false;
    mockWindow.location.replace(path);
    return true;
  };

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

  const storageMap = options.sharedStorage ?? new Map<string, string>();
  if (options.initialStorage) {
    for (const [k, v] of Object.entries(options.initialStorage)) {
      storageMap.set(k, v);
    }
  }

  const sessionStorageMock = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error('sessionStorage access denied');
      return storageMap.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.storageThrows) throw new Error('sessionStorage access denied');
      storageMap.set(key, String(value));
    },
    removeItem: (key: string) => {
      if (options.storageThrows) throw new Error('sessionStorage access denied');
      storageMap.delete(key);
    },
    clear: () => {
      if (options.storageThrows) throw new Error('sessionStorage access denied');
      storageMap.clear();
    },
  };

  let logoutClickHandler: any = null;
  const byId = (id: string) => {
    if (id === 'logout-button') {
      return {
        addEventListener: (event: string, fn: any) => {
          if (event === 'click') logoutClickHandler = fn;
        },
      };
    }
    return null;
  };

  const runner = new Function(
    'window',
    'document',
    'fetch',
    'loginToken',
    'loginError',
    'loginSubmit',
    'loginRemember',
    'loginView',
    'inboxView',
    'insecureWarning',
    'linkLoginNotice',
    'state',
    'isLoginContextSafe',
    'configureLoginGate',
    'showLogin',
    'showInbox',
    'startSession',
    'consumeReturnTo',
    'announce',
    'loginForm',
    'byId',
    'sessionStorage',
    `
      ${consumeQueryTokenSrc}
      ${loginWithTokenSrc}
      ${formSubmitSrc}
      ${logoutSrc}
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
    mockDocument,
    mockFetch,
    loginToken,
    loginError,
    loginSubmit,
    loginRemember,
    loginView,
    inboxView,
    insecureWarning,
    linkLoginNotice,
    state,
    isLoginContextSafe,
    configureLoginGate,
    showLogin,
    showInbox,
    startSession,
    consumeReturnTo,
    announce,
    loginForm,
    byId,
    sessionStorageMock,
  );

  const runLogout = async () => {
    if (logoutClickHandler) {
      await logoutClickHandler();
    }
  };

  return {
    mockWindow,
    mockDocument,
    cookieJar,
    loginToken,
    loginError,
    loginSubmit,
    loginRemember,
    loginView,
    inboxView,
    insecureWarning,
    linkLoginNotice,
    sessionStorage: {
      getItem: (key: string) => cookieJar.get(key) ?? null,
      setItem: (key: string, val: string) => cookieJar.set(key, val),
      removeItem: (key: string) => cookieJar.delete(key),
    },
    state,
    calls,
    getCurrentUrl: () => currentUrl,
    instance: {
      ...instance,
      runLogout,
    },
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
    // R6 (ZCode P2-4): 即使前序遗留复选框勾选，链接登录也硬编码 remember: false，绝不继承该复选框
    harness.loginRemember.checked = true;

    await harness.instance.runStart();

    // 断言 1: URL 中 token 已被 replaceState 剥离
    expect(harness.getCurrentUrl()).toBe('https://admin.example/ui');
    expect(harness.calls.replacedUrls).toEqual(['/ui']);

    // 断言 2: 请求了 /ui/api/me 后再请求 /ui/api/session，且 remember 始终为 false（复选框自身不被重置）
    expect(harness.calls.fetches.length).toBe(2);
    expect(harness.calls.fetches[0].url).toBe('/ui/api/me');
    expect(harness.calls.fetches[1].url).toBe('/ui/api/session');
    expect(harness.calls.fetches[1].init?.method).toBe('POST');
    const sentBody = JSON.parse(harness.calls.fetches[1].init?.body as string);
    expect(sentBody).toEqual({ token: 'secret-token-123', remember: false });
    expect(harness.loginRemember.checked).toBe(true);

    // 断言 3: 进入应用
    expect(harness.calls.showInboxCount).toBe(1);
    expect(harness.calls.startSessionCount).toBe(1);
    expect(harness.inboxView.hidden).toBe(false);
    expect(harness.loginView.hidden).toBe(true);
    expect(harness.state.me).toEqual({ kind: 'admin' });

    // 断言 4: 登录输入框被清空，不留 token
    expect(harness.loginToken.value).toBe('');

    // 断言 5: 链接登录成功展示 visible notice banner 且激活 body class
    expect(harness.linkLoginNotice.hidden).toBe(false);
    expect(harness.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(true);
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

    // 断言 3: token 永不回显进输入框，也不展示链接登录提示
    expect(harness.loginToken.value).toBe('');
    expect(harness.loginError.textContent).toBe('');
    expect(harness.calls.announced).toHaveLength(0);
    expect(harness.linkLoginNotice.hidden).toBe(true);
    expect(harness.linkLoginNotice.textContent).toBe('');
  });

  // 10. Fix 2 (ZCode P2-3) & R4 Fix 1 (ZCode P1-1) & R5 & R8: query 链接登录成功展示 visible banner 与 announcement 提示并设置 sessionStorage marker 与 body class，粘贴表单登录不展示且清除 marker 与 class
  test('10. Visible notice appears on query-login success and does NOT appear on paste-form login success', async () => {
    // 场景 A: Admin 身份 query token 登录成功 → 提示 "Signed in via link as Admin session" 并写入 sessionStorage marker 与 body class
    const adminLinkHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=admin-query-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await adminLinkHarness.instance.runStart();
    expect(adminLinkHarness.calls.showInboxCount).toBe(1);
    expect(adminLinkHarness.linkLoginNotice.hidden).toBe(false);
    expect(adminLinkHarness.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');
    expect(adminLinkHarness.calls.announced).toEqual(['Signed in via link as Admin session']);
    expect(adminLinkHarness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(adminLinkHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 场景 B: Identity 身份 query token 登录成功 → 提示 "Signed in via link as <address>" 并写入 marker 与 class
    const identityLinkHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=identity-query-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'identity', address: 'agent-bot@example.com' } },
    });
    await identityLinkHarness.instance.runStart();
    expect(identityLinkHarness.calls.showInboxCount).toBe(1);
    expect(identityLinkHarness.linkLoginNotice.hidden).toBe(false);
    expect(identityLinkHarness.linkLoginNotice.textContent).toBe('Signed in via link as agent-bot@example.com');
    expect(identityLinkHarness.calls.announced).toEqual(['Signed in via link as agent-bot@example.com']);
    expect(identityLinkHarness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(identityLinkHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 场景 C: 表单粘贴输入登录成功 → 不展示 visible banner 与 announcement，且清除 marker 与 class
    const formHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      initialStorage: { 'oae-link-login': '1' },
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    // 启动显示登录表单
    await formHarness.instance.runStart();
    expect(formHarness.calls.showLogin).toEqual(['']);
    expect(formHarness.calls.announced).toHaveLength(0);
    expect(formHarness.linkLoginNotice.hidden).toBe(true);
    // 401 流程清理 marker
    expect(formHarness.sessionStorage.getItem('oae-link-login')).toBeNull();

    // 假设在此期间重新设置了脏 marker
    formHarness.sessionStorage.setItem('oae-link-login', '1');

    // 用户在表单勾选 remember 并粘贴 token 提交（R6: 表单登录路径依然如实传递 checkbox）
    formHarness.loginRemember.checked = true;
    await formHarness.instance.runPasteLogin('admin-paste-token');
    expect(formHarness.calls.showInboxCount).toBe(1);
    expect(formHarness.linkLoginNotice.hidden).toBe(true);
    expect(formHarness.linkLoginNotice.textContent).toBe('');
    expect(formHarness.sessionStorage.getItem('oae-link-login')).toBeNull();
    expect(formHarness.mockDocument.body.classList.contains('link-login-active')).toBe(false);
    const formSessionFetch = formHarness.calls.fetches.find(
      (f) => f.url === '/ui/api/session' && f.init?.method === 'POST',
    );
    expect(formSessionFetch).toBeDefined();
    const formSentBody = JSON.parse(formSessionFetch!.init?.body as string);
    expect(formSentBody).toEqual({ token: 'admin-paste-token', remember: true });
    // 验证：表单登录完全不触发链接登录提示
    const linkAnnouncements = formHarness.calls.announced.filter((m) =>
      m.includes('Signed in via link'),
    );
    expect(linkAnnouncements).toHaveLength(0);
  });

  // 11. R5: Reload simulation — sessionStorage 标记在刷新时持久化展示 link-login notice，无标记不展示
  test('11. Reload simulation: sessionStorage marker persists link-login notice across reloads with correct label, marker absent shows no banner', async () => {
    // 场景 A: Admin 身份会话，刷新时带 sessionStorage marker '1'
    const adminReloadHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      initialStorage: { 'oae-link-login': '1' },
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    await adminReloadHarness.instance.runStart();
    expect(adminReloadHarness.calls.showInboxCount).toBe(1);
    expect(adminReloadHarness.linkLoginNotice.hidden).toBe(false);
    expect(adminReloadHarness.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');
    expect(adminReloadHarness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(adminReloadHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);
    // 刷新不重复播报 aria-live
    expect(adminReloadHarness.calls.announced).toHaveLength(0);

    // 场景 B: Identity 身份会话，刷新时带 sessionStorage marker '1'
    const identityReloadHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      initialStorage: { 'oae-link-login': '1' },
      meResponse: { status: 200, body: { kind: 'identity', address: 'alice@test.example' } },
    });
    await identityReloadHarness.instance.runStart();
    expect(identityReloadHarness.calls.showInboxCount).toBe(1);
    expect(identityReloadHarness.linkLoginNotice.hidden).toBe(false);
    expect(identityReloadHarness.linkLoginNotice.textContent).toBe('Signed in via link as alice@test.example');
    expect(identityReloadHarness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(identityReloadHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);
    expect(identityReloadHarness.calls.announced).toHaveLength(0);

    // 场景 C: 普通会话（无 marker），刷新时不展示 banner
    const normalReloadHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      initialStorage: {},
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    await normalReloadHarness.instance.runStart();
    expect(normalReloadHarness.calls.showInboxCount).toBe(1);
    expect(normalReloadHarness.linkLoginNotice.hidden).toBe(true);
    expect(normalReloadHarness.linkLoginNotice.textContent).toBe('');
    expect(normalReloadHarness.sessionStorage.getItem('oae-link-login')).toBeNull();
    expect(normalReloadHarness.mockDocument.body.classList.contains('link-login-active')).toBe(false);
  });

  // 12. R5: Logout clears sessionStorage marker and resets notice
  test('12. Logout clears sessionStorage marker and resets link-login notice', async () => {
    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      initialStorage: { 'oae-link-login': '1' },
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    // 首次进入现有会话，展示 banner
    await harness.instance.runStart();
    expect(harness.linkLoginNotice.hidden).toBe(false);
    expect(harness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 用户点击登出
    await harness.instance.runLogout();
    expect(harness.calls.showLogin).toContain('');
    expect(harness.sessionStorage.getItem('oae-link-login')).toBeNull();
    expect(harness.linkLoginNotice.hidden).toBe(true);
    expect(harness.linkLoginNotice.textContent).toBe('');
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(false);
  });

  // 13. R5: Storage-throws case: login succeeds even if sessionStorage throws (fail-open try/catch)
  test('13. Storage-throws case: login succeeds even if sessionStorage throws (fail-open try/catch)', async () => {
    // 场景 A: query link 登录在 sessionStorage 抛出异常时仍顺利进入应用
    const queryHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=safe-query-token',
      storageThrows: true,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await queryHarness.instance.runStart();
    expect(queryHarness.calls.showInboxCount).toBe(1);
    expect(queryHarness.linkLoginNotice.hidden).toBe(false);
    expect(queryHarness.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');

    // 场景 B: 表单登录在 sessionStorage 抛出异常时仍顺利进入应用
    const formHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      storageThrows: true,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await formHarness.instance.runStart();
    await formHarness.instance.runPasteLogin('paste-token-xyz');
    expect(formHarness.calls.showInboxCount).toBe(1);
    expect(formHarness.linkLoginNotice.hidden).toBe(true);

    // 场景 C: 刷新在 sessionStorage 抛出异常时不崩溃
    const reloadHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      storageThrows: true,
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    await reloadHarness.instance.runStart();
    expect(reloadHarness.calls.showInboxCount).toBe(1);
  });

  // 14. R7 Fix 2: Prevent stale /ui/api/me 401 from overriding manual form login (login-generation guard)
  test('14. Slow /ui/api/me 401 does not override a manual form login that arrived first', async () => {
    let resolveMe: (resp: Response) => void;
    const mePromise = new Promise<Response>((resolve) => {
      resolveMe = resolve;
    });

    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=query-link-token',
      customFetch: async (url, init) => {
        if (url === '/ui/api/me') {
          return mePromise;
        }
        if (url === '/ui/api/session') {
          const body = JSON.parse(init?.body as string);
          return {
            status: 200,
            ok: true,
            json: async () => ({ kind: 'identity', address: `${body.token}@manual.example` }),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });

    // 1. start() 启动，consumeQueryToken() 剥离参数，发送 /ui/api/me（此时请求挂起未返回）
    const startPromise = harness.instance.runStart();

    // 2. 在 /ui/api/me 挂起期间，用户手动在登录表单输入 token 并提交
    await harness.instance.runPasteLogin('manual-user');

    // 断言：手动登录成功，进入收件箱
    expect(harness.calls.showInboxCount).toBe(1);
    expect(harness.state.me).toEqual({ kind: 'identity', address: 'manual-user@manual.example' });
    const postCallsBeforeMe = harness.calls.fetches.filter(
      (f) => f.url === '/ui/api/session' && f.init?.method === 'POST',
    );
    expect(postCallsBeforeMe).toHaveLength(1);
    expect(JSON.parse(postCallsBeforeMe[0].init?.body as string)).toEqual({
      token: 'manual-user',
      remember: false,
    });

    // 3. 迟到的慢 /ui/api/me 返回 401
    resolveMe!({
      status: 401,
      ok: false,
      json: async () => ({ error: 'unauthorized' }),
    } as unknown as Response);

    await startPromise;

    // 4. 断言：stale 401 被 login-generation 守卫拦截，没有发起第二次 POST /ui/api/session，手动会话未被覆盖
    const postCallsAfterMe = harness.calls.fetches.filter(
      (f) => f.url === '/ui/api/session' && f.init?.method === 'POST',
    );
    expect(postCallsAfterMe).toHaveLength(1); // 仍然只有 1 次 POST，没有为 query token 发送 POST
    expect(harness.state.me).toEqual({ kind: 'identity', address: 'manual-user@manual.example' });
    expect(harness.linkLoginNotice.hidden).toBe(true);
    expect(harness.sessionStorage.getItem('oae-link-login')).toBeNull();
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(false);
  });

  // 15. R8 Fix 1 (Thread 6): Link-login banner is visible immediately after session POST, BEFORE startup awaits finish
  test('15. Link-login banner is visible immediately after session POST, BEFORE startup awaits finish', async () => {
    let resolveHang: () => void;
    const hangPromise = new Promise<void>((resolve) => {
      resolveHang = resolve;
    });

    const harness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=early-banner-token',
      hangStartSession: hangPromise,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });

    const runPromise = harness.instance.runStart();

    // 等待微任务让 fetch(/ui/api/me) 和 POST /ui/api/session 完成，但在 startSession 挂起
    await new Promise((r) => setTimeout(r, 20));

    // 断言 1: POST /ui/api/session 已返回，startSession 正在执行中（挂起）
    expect(harness.calls.startSessionCount).toBe(1);

    // 断言 2: 横幅在 startup 挂起期间就已经立即可见且激活 body class（Thread 6 核心修复）
    expect(harness.linkLoginNotice.hidden).toBe(false);
    expect(harness.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');
    expect(harness.calls.announced).toEqual(['Signed in via link as Admin session']);
    expect(harness.sessionStorage.getItem('oae-link-login')).toBe('1');
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 释放挂起，流程正常结束
    resolveHang!();
    await runPromise;

    expect(harness.linkLoginNotice.hidden).toBe(false);
    expect(harness.mockDocument.body.classList.contains('link-login-active')).toBe(true);
  });

  // 16. R8 Fix 2 (Thread 7): document.body.classList manages link-login-active in sync with link-login notice
  test('16. document.body.classList manages link-login-active in sync with link-login notice', async () => {
    // 场景 A: query login 成功 → 添加 link-login-active
    const linkHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=link-token',
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await linkHarness.instance.runStart();
    expect(linkHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 场景 B: 登出 → 移除 link-login-active
    await linkHarness.instance.runLogout();
    expect(linkHarness.mockDocument.body.classList.contains('link-login-active')).toBe(false);

    // 场景 C: 随后表单登录 → 保持无 link-login-active
    await linkHarness.instance.runPasteLogin('paste-token');
    expect(linkHarness.mockDocument.body.classList.contains('link-login-active')).toBe(false);
  });

  // 17. R9 Fix (Codex Local P1-1) & R11: query login + returnTo sets marker before OAuth redirect, banner restored on subsequent load
  test('17. Query login with returnTo sets marker before redirect, and banner is restored on subsequent load', async () => {
    const sharedCookieJar = new CookieJar();

    // 步骤 1: 首次访问带 ?token=query-token，POST /ui/api/session 返回带 returnTo 的响应
    const oauthLoginHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=query-oauth-token',
      sharedCookieJar,
      meResponse: { status: 401 },
      sessionResponse: {
        status: 200,
        body: { kind: 'identity', address: 'oauth-agent@example.com', returnTo: '/ui/oauth/consent' },
      },
    });

    await oauthLoginHarness.instance.runStart();

    // 断言 1: consumeReturnTo 触发跳转，当前页面未执行 showInbox 或在当前 DOM 展示 banner
    expect(oauthLoginHarness.calls.showInboxCount).toBe(0);
    expect(oauthLoginHarness.linkLoginNotice.hidden).toBe(true);
    expect(oauthLoginHarness.calls.replacedUrls).toContain('/ui/oauth/consent');

    // 断言 2 (R9 核心修复): marker 在重定向之前已经写入 cookie!
    expect(sharedCookieJar.get('oae-link-login')).toBe('1');

    // 步骤 2: 同一个 tab 在同意页重定向之后重新加载 /ui，session 已建立 (/ui/api/me 返回 200)
    const afterRedirectHarness = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      sharedCookieJar,
      meResponse: { status: 200, body: { kind: 'identity', address: 'oauth-agent@example.com' } },
    });

    await afterRedirectHarness.instance.runStart();

    // 断言 3: 后续页面加载识别到 marker，恢复链接登录横幅与 active class
    expect(afterRedirectHarness.calls.showInboxCount).toBe(1);
    expect(afterRedirectHarness.linkLoginNotice.hidden).toBe(false);
    expect(afterRedirectHarness.linkLoginNotice.textContent).toBe('Signed in via link as oauth-agent@example.com');
    expect(afterRedirectHarness.mockDocument.body.classList.contains('link-login-active')).toBe(true);
    expect(sharedCookieJar.get('oae-link-login')).toBe('1');
  });

  // 18. R11 (provenance storage): origin-wide session cookie persists banner across tabs, no Max-Age/Expires on set, cleared across all tabs on logout/form-login
  test('18. Origin-wide JS session cookie shares provenance across tabs and clears on logout or form login', async () => {
    const sharedCookieJar = new CookieJar();

    // Tab 1: 通过 ?token= 链接登录
    const tab1 = createClientHarness({
      initialUrl: 'https://admin.example/ui?token=tab1-link-token',
      sharedCookieJar,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await tab1.instance.runStart();

    // 断言 1: Tab 1 正常展示横幅
    expect(tab1.linkLoginNotice.hidden).toBe(false);
    expect(tab1.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // 断言 2: 写入的 cookie 为 session cookie：无 Max-Age，无 Expires
    const lastWrite = sharedCookieJar.writes[sharedCookieJar.writes.length - 1];
    expect(lastWrite).toBe('oae-link-login=1; path=/; SameSite=Strict');
    expect(lastWrite).not.toContain('Max-Age');
    expect(lastWrite).not.toContain('Expires');
    expect(sharedCookieJar.get('oae-link-login')).toBe('1');

    // Tab 2 (跨标签页仿真): 打开新标签页，共享同一源 cookie 罐，已有会话 (/ui/api/me 返回 200)
    const tab2 = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      sharedCookieJar,
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    await tab2.instance.runStart();

    // 断言 3: Tab 2 继承会话的同时，成功识别跨标签页的 origin-wide cookie marker，展示链接登录警示横幅！
    expect(tab2.calls.showInboxCount).toBe(1);
    expect(tab2.linkLoginNotice.hidden).toBe(false);
    expect(tab2.linkLoginNotice.textContent).toBe('Signed in via link as Admin session');
    expect(tab2.mockDocument.body.classList.contains('link-login-active')).toBe(true);

    // Tab 2 登出 → 清除 origin-wide cookie (Max-Age=0)
    await tab2.instance.runLogout();
    expect(tab2.linkLoginNotice.hidden).toBe(true);
    expect(sharedCookieJar.get('oae-link-login')).toBeUndefined();
    const clearWrite = sharedCookieJar.writes[sharedCookieJar.writes.length - 1];
    expect(clearWrite).toBe('oae-link-login=; path=/; SameSite=Strict; Max-Age=0');

    // Tab 3: 新开或刷新标签页，此时 cookie 已被全局清理，不展示横幅
    const tab3 = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      sharedCookieJar,
      meResponse: { status: 200, body: { kind: 'admin' } },
    });
    await tab3.instance.runStart();
    expect(tab3.linkLoginNotice.hidden).toBe(true);
    expect(tab3.mockDocument.body.classList.contains('link-login-active')).toBe(false);

    // Tab 4 (表单登录测试): 手动表单登录也清除 origin-wide cookie
    sharedCookieJar.cookie = 'oae-link-login=1; path=/; SameSite=Strict';
    expect(sharedCookieJar.get('oae-link-login')).toBe('1');
    const tab4 = createClientHarness({
      initialUrl: 'https://admin.example/ui',
      sharedCookieJar,
      meResponse: { status: 401 },
      sessionResponse: { status: 200, body: { kind: 'admin' } },
    });
    await tab4.instance.runStart();
    await tab4.instance.runPasteLogin('admin-paste-token');
    expect(sharedCookieJar.get('oae-link-login')).toBeUndefined();
    expect(tab4.linkLoginNotice.hidden).toBe(true);
    expect(tab4.mockDocument.body.classList.contains('link-login-active')).toBe(false);
  });
});
