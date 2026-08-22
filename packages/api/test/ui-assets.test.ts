import { describe, expect, test } from 'bun:test';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { createApp } = await import('../src/app.ts');
const assets = await import('../src/ui/assets.ts');
const { OUTER_CSP, UI_CSS, UI_HTML, UI_JS, UI_LOGO_SVG } = assets;

/**
 * website/public/logo.svg 的几何片段，逐字。website 是另一个仓库，所以这里保留
 * 一份字面副本作为比对基准 —— 官网改图时这条断言会红，提醒同步。
 */
const WEBSITE_LOGO_GEOMETRY = `  <rect width="32" height="32" rx="7" fill="#0c0d12"/>
  <rect x="5" y="5" width="22" height="22" rx="6" fill="none" stroke="#fbbf24" stroke-width="2.2"/>
  <path d="M11.1 10q.55 1.65 2.2 2.2-1.65.55-2.2 2.2-.55-1.65-2.2-2.2 1.65-.55 2.2-2.2z" fill="#fbbf24"/>
  <path d="M20.9 10q.55 1.65 2.2 2.2-1.65.55-2.2 2.2-.55-1.65-2.2-2.2 1.65-.55 2.2-2.2z" fill="#fbbf24"/>
  <path d="M5.8 15.8 16 23 26.2 15.8" fill="none" stroke="#fbbf24" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;

describe('UI static asset contract', () => {
  const app = createApp({ uiEnabled: true });

  test('/ui and /ui/ serve the same shell with absolute assets', async () => {
    const bare = await app.request('/ui');
    const slash = await app.request('/ui/');
    expect(bare.status).toBe(200);
    expect(slash.status).toBe(200);
    expect(await bare.text()).toBe(await slash.text());
    expect(UI_HTML).toContain('href="/ui/styles.css"');
    expect(UI_HTML).toContain('src="/ui/app.js"');
    expect(UI_HTML).toContain('<link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">');
    expect(OUTER_CSP).toContain("img-src 'self'");
    // 旧外壳可能还在缓存里，.ico 继续给 204 而不是 404
    expect((await app.request('/ui/favicon.ico')).status).toBe(204);

    const favicon = await app.request('/ui/favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(favicon.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(favicon.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await favicon.text()).toBe(UI_LOGO_SVG);
  });

  test('shell and assets have strict types and an outer CSP', async () => {
    const shell = await app.request('/ui');
    expect(shell.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(shell.headers.get('content-security-policy')).toBe(OUTER_CSP);
    expect(shell.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(shell.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(shell.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    expect(OUTER_CSP).toContain("default-src 'none'");
    expect(OUTER_CSP).toContain("frame-src 'self'");
    expect(OUTER_CSP).not.toContain("'unsafe-inline'");

    const script = await app.request('/ui/app.js');
    const styles = await app.request('/ui/styles.css');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(styles.headers.get('content-type')).toContain('text/css');
    expect(await script.text()).toBe(UI_JS);
    expect(await styles.text()).toBe(UI_CSS);
  });

  test('shell has no inline execution hooks', () => {
    expect(UI_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(UI_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(UI_HTML).not.toMatch(/\sstyle\s*=/i);
  });

  // 防回归闸：模块拼接产物必须是合法 JS。缺 async / 括号错位等会让浏览器拒执行整份 /ui/app.js。
  // 注意：这里用 new Function 只做语法解析，不得把该 API 写进 UI_JS 本体（见下方 sink 断言）。
  test('assembled /ui/app.js is syntactically valid', () => {
    expect(() => {
      // 中文：仅校验语法，不执行；解析失败即视为拼装回归
      new Function(UI_JS);
    }).not.toThrow();
  });

  // 拆分后易丢 async：钉死 main 时代关键带 await 的加载器声明
  test('critical UI loaders remain async after modular split', () => {
    const requiredAsync = [
      'apiJson',
      'loadTasks',
      'selectTask',
      'loadNotifyHistory',
      'loadInbox',
      'startSession',
      'selectIdentity',
      'selectMessage',
      'refreshMessages',
      'loadMessageSource',
      'handleCreateSubmit',
      'handleRotateToken',
      'savePushContentTier',
      'fetchNotifyTopic',
      'waitForPreviousRefresh',
      'copyValue',
      'toggleSeen',
      'apply',
      'mapPool',
      'run',
      'start',
    ];
    for (const name of requiredAsync) {
      expect(UI_JS).toContain(`async function ${name}(`);
    }
  });

  // OAuth grant DELETE 返回 204：apiJson 不得无条件 response.json()，否则吊销成功也进 error handler
  test('apiJson treats 204/empty success bodies as null so grant revoke can succeed', () => {
    const apiJson = UI_JS.slice(
      UI_JS.indexOf('async function apiJson('),
      UI_JS.indexOf('async function handleCreateSubmit('),
    );
    expect(apiJson).toContain('response.status === 204');
    expect(apiJson).toContain('response.status === 205');
    expect(apiJson).toContain('await response.text()');
    expect(apiJson).toContain('JSON.parse(raw)');
    // 成功路径不得再无条件 json()；失败路径 try 里解析 error body 仍可保留
    const successTail = apiJson.slice(apiJson.indexOf('throw failure;'));
    expect(successTail).not.toContain('return response.json()');
    expect(UI_JS).toContain(
      "await apiJson('/ui/api/oauth/grants/' + encodeURIComponent(grant.id), { method: 'DELETE' })",
    );
    expect(UI_JS).toContain("announce('Client revoked.')");
    expect(UI_JS).toContain('loadConfigureClients()');
    expect(UI_JS).toContain("'Could not revoke that client.'");
  });

  test('front-end code contains no HTML parser sinks or URL-token reader', () => {
    expect(UI_JS).not.toMatch(
      /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\s*\(|new\s+Function\b/,
    );
    expect(UI_JS).not.toMatch(/URLSearchParams|location\.search|searchParams/);
    expect(UI_JS).toContain('history.replaceState');
    expect(UI_JS).toContain('window.isSecureContext');
  });

  test('a first visit is not mislabeled as an expired session', () => {
    expect(UI_JS).toContain("if (response.status === 401) { showLogin(''); return; }");
  });

  test('link and frame creation retain both execution-point defenses', () => {
    expect(UI_JS).toContain("new URL(");
    expect(UI_JS).toContain("protocol !== 'http:'");
    expect(UI_JS).toContain("setAttribute('sandbox', '')");
    expect(UI_JS).toContain('/ui/frame/');
    expect(UI_JS).not.toContain('allow-same-origin');
    expect(UI_JS).not.toContain('allow-scripts');
  });

  test('oversized HTML disables its tab and explains the plain-text fallback', () => {
    expect(UI_JS).toContain('detail.htmlTooLarge');
    expect(UI_JS).toContain('too large to preview');
  });

  test('PR2 inbox folders, source view, and layered mobile back', () => {
    expect(UI_HTML).toContain('id="folder-list"');
    expect(UI_JS).toContain("id: 'inbox', label: 'Inbox'");
    expect(UI_JS).toContain("id: 'sent', label: 'Sent'");
    expect(UI_JS).toContain("'/ui/api/send-log?address='");
    expect(UI_JS).toContain("'/ui/api/send-log/'");
    expect(UI_JS).toContain('No API/MCP sends in 30 days');
    expect(UI_JS).toContain('Direct SMTP is not listed');
    expect(UI_JS).toContain("badge.textContent = message.result === 'failed' ? 'Failed' : 'Queued'");
    expect(UI_CSS).toContain('.send-result-badge[data-result="queued"]');
    expect(UI_CSS).toContain('.send-result-badge[data-result="failed"]');
    expect(UI_JS).toContain("id: 'all', label: 'All Mail'");
    expect(UI_HTML).not.toContain('Scheduled');
    expect(UI_HTML).not.toContain('Trash');
    expect(UI_JS).not.toContain('Scheduled');
    expect(UI_JS).not.toContain("'trash'");
    expect(UI_JS).toContain("textContent = 'Rendered'");
    expect(UI_JS).toContain("textContent = 'Source'");
    expect(UI_JS).toContain('createTextNode(payload.source');
    expect(UI_JS).toContain('/source?address=');
    expect(UI_JS).toContain("setAttribute('sandbox', '')");
    expect(UI_JS).toContain('/ui/frame/');
    expect(UI_JS).toContain('history.back()');
    expect(UI_JS).toContain("mobileView: 'detail'");
    expect(UI_JS).toContain("mobileView: 'folders'");
    expect(UI_CSS).toContain('.inbox-view[data-scope="inbox"][data-mobile-view="folders"] .identity-panel');
    expect(UI_JS).toContain('&folder=');
    expect(UI_JS).toContain('&cursor=');
    expect(UI_JS).toContain('renderEmptyState(');
    expect(UI_JS).toContain('fromFolders && nextView === \'list\'');
    expect(UI_JS).toContain('inboxOnFolders');
  });

  test('detail requests cannot cross an identity switch or overwrite newer state', () => {
    expect(UI_JS).toContain('var requestedDetailAddress = state.activeAddress;');
    expect(UI_JS).toContain('state.activeAddress !== requestedDetailAddress');

    const selectIdentity = UI_JS.slice(
      UI_JS.indexOf('async function selectIdentity'),
      UI_JS.indexOf('async function refreshMessages'),
    );
    expect(selectIdentity.indexOf('detailController.abort()')).toBeGreaterThan(-1);
    expect(selectIdentity.indexOf('detailController.abort()')).toBeLessThan(
      selectIdentity.indexOf('await waitForPreviousRefresh()'),
    );
  });

  test('source loader ignores a late response after switching identity with the same UID', () => {
    const load = UI_JS.slice(
      UI_JS.indexOf('async function loadMessageSource'),
      UI_JS.indexOf('function fillMetadata'),
    );
    expect(load).toContain('var requestedSourceAddress = state.activeAddress;');
    expect(load).toContain('state.activeAddress !== requestedSourceAddress');
    expect(load).toContain('state.activeMessageId !== detail.id');
    expect(load).toContain('sourceCache.address === requestedSourceAddress');
    expect(load).toContain('address: requestedSourceAddress');
    expect(load).toContain('encodeURIComponent(requestedSourceAddress)');
    expect(load).not.toContain("encodeURIComponent(state.activeAddress)");
    expect(load).toContain('signal: controller.signal');

    const selectIdentity = UI_JS.slice(
      UI_JS.indexOf('async function selectIdentity'),
      UI_JS.indexOf('async function refreshMessages'),
    );
    expect(selectIdentity).toContain('sourceController.abort()');
    expect(selectIdentity.indexOf('sourceController.abort()')).toBeGreaterThan(-1);
    expect(selectIdentity.indexOf('sourceController.abort()')).toBeLessThan(
      selectIdentity.indexOf('await waitForPreviousRefresh()'),
    );
  });

  test('clipboard fallback selects the visible source for manual copying', () => {
    expect(UI_JS).toContain('function selectForManualCopy(sourceNode)');
    expect(UI_JS).toContain('range.selectNodeContents(sourceNode)');
    expect(UI_JS).toContain('selection.addRange(range)');
    expect(UI_JS).toContain('return selection.toString() === sourceNode.textContent');
  });

  test('shell deep-links register after api/oauth/frame and do not swallow them', async () => {
    const full = createApp({ uiEnabled: true });
    const paths = full.routes.map((route) => `${route.method} ${route.path}`);
    const shellIdx = paths.indexOf('GET /ui/inbox');
    const apiIdx = paths.indexOf('GET /ui/api/me');
    const frameIdx = paths.findIndex((p) => p.includes('/ui/frame'));
    const oauthIdx = paths.findIndex((p) => p.includes('/ui/oauth'));
    expect(shellIdx).toBeGreaterThan(-1);
    expect(apiIdx).toBeGreaterThan(-1);
    expect(frameIdx).toBeGreaterThan(-1);
    expect(oauthIdx).toBeGreaterThan(-1);
    // ADR：shell 必须在专用路由之后
    expect(shellIdx).toBeGreaterThan(apiIdx);
    expect(shellIdx).toBeGreaterThan(frameIdx);
    expect(shellIdx).toBeGreaterThan(oauthIdx);

    // 专用路由仍可达，不被 shell 抢走
    expect((await full.request('/ui/api/me')).status).not.toBe(200); // 未登录 → 401
    expect((await full.request('/ui/api/me')).status).toBe(401);
    expect((await full.request('/ui/oauth/grants')).status).toBe(302);
    expect((await full.request('/ui/inbox')).status).toBe(200);
  });

  // 路由表层级：真发通配形态请求，断言 api/oauth/frame 不被 shell HTML 吞掉（纵深防御，不只看 routes 顺序）
  test('wildcard-shaped reserved paths are not swallowed by the dashboard shell', async () => {
    const { FRAME_CSP } = await import('../src/routes/ui-frame.ts');
    const full = createApp({ uiEnabled: true });

    async function hit(path: string) {
      const res = await full.request(path);
      const body = await res.text();
      return { res, body };
    }

    function isDashboardShell(hit: { res: { status: number; headers: Headers }; body: string }) {
      return (
        hit.res.headers.get('content-type') === 'text/html; charset=utf-8' &&
        hit.res.headers.get('content-security-policy') === OUTER_CSP &&
        hit.body.includes('id="app-nav"')
      );
    }

    // 对照：合法 shell 深链仍是 dashboard HTML
    const inbox = await hit('/ui/inbox');
    expect(inbox.res.status).toBe(200);
    expect(isDashboardShell(inbox)).toBe(true);
    const taskDeep = await hit('/ui/tasks/demo-id');
    expect(isDashboardShell(taskDeep)).toBe(true);

    // /ui/api/* 必须是 JSON API，绝不能落到 shell
    const apiMe = await hit('/ui/api/me');
    expect(apiMe.res.status).toBe(401);
    expect(apiMe.res.headers.get('content-type')).toContain('application/json');
    expect(isDashboardShell(apiMe)).toBe(false);
    expect(apiMe.body).not.toContain('id="app-nav"');

    const apiOverview = await hit('/ui/api/overview');
    expect(isDashboardShell(apiOverview)).toBe(false);
    expect(apiOverview.body).not.toContain('id="app-nav"');

    const apiSession = await hit('/ui/api/session');
    expect(isDashboardShell(apiSession)).toBe(false);

    // /ui/oauth/* 是 OAuth 面，不是 dashboard shell
    const oauthGrants = await hit('/ui/oauth/grants');
    expect(oauthGrants.res.status).toBe(302);
    expect(isDashboardShell(oauthGrants)).toBe(false);

    const oauthAuthorize = await hit('/ui/oauth/authorize');
    expect(isDashboardShell(oauthAuthorize)).toBe(false);
    expect(oauthAuthorize.body).not.toContain('id="app-nav"');

    // /ui/frame/* 用 FRAME_CSP，不是 OUTER_CSP dashboard
    const frame = await hit('/ui/frame/1?address=fox%40test.example');
    expect(isDashboardShell(frame)).toBe(false);
    expect(frame.res.headers.get('content-security-policy')).toBe(FRAME_CSP);
    expect(frame.res.headers.get('content-security-policy')).not.toBe(OUTER_CSP);
    expect(frame.body).not.toContain('id="app-nav"');
  });

  test('unknown UI paths are 404, old Overview bookmarks redirect, and UI_ENABLED=false removes the whole surface', async () => {
    expect((await app.request('/ui/unknown')).status).toBe(404);

    for (const path of ['/ui/overview', '/ui/overview/']) {
      const legacy = await app.request(path);
      expect(legacy.status).toBe(301);
      expect(legacy.headers.get('location')).toBe('/ui');
      expect(legacy.headers.get('cache-control')).toBe('no-store');
    }

    // ADR #26 PR1：真实 /ui/* shell 子路径刷新不 404（含尾斜杠变体）
    const { UI_SHELL_EXACT_PATHS, UI_SHELL_PREFIX_PATHS } = await import(
      '../src/ui/shell-routes.ts'
    );
    for (const path of [
      '/ui/inbox',
      '/ui/tasks',
      '/ui/tasks/demo-id',
      '/ui/notifications',
      '/ui/configure/identities',
      '/ui/configure/push',
      '/ui/configure/clients',
      '/ui/configure/domains',
      '/ui/plan',
      '/ui/inbox/agent%40test.example/inbox',
      ...UI_SHELL_EXACT_PATHS.map((p) => `${p}/`),
      ...UI_SHELL_PREFIX_PATHS.map((p) => `${p}/`),
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }

    // 旧 OAuth grants 书签：未登录先去 Dashboard 登录，不把匿名请求 302 进 Configure
    const grants = await app.request('/ui/oauth/grants');
    expect(grants.status).toBe(302);
    expect(grants.headers.get('location')).toBe('/ui');

    const disabled = createApp({ uiEnabled: false });
    for (const path of [
      '/ui',
      '/ui/',
      '/ui/inbox',
      '/ui/app.js',
      '/ui/styles.css',
      '/ui/favicon.svg',
      '/ui/fonts/Satoshi-Regular.woff2',
      '/ui/api/me',
      '/ui/api/overview',
      '/ui/frame/1?address=fox%40test.example',
    ]) {
      expect((await disabled.request(path)).status).toBe(404);
    }
  });

  // 客户端 pathForScope / parse 字面量与 shell-routes 单一事实源对齐，防刷新 404
  test('client shell paths stay aligned with UI_SHELL_* single source of truth', async () => {
    const { UI_SHELL_EXACT_PATHS, UI_SHELL_PREFIX_PATHS, uiShellRegisterPaths } =
      await import('../src/ui/shell-routes.ts');
    for (const path of UI_SHELL_EXACT_PATHS) {
      expect(UI_JS).toContain(`return '${path}'`);
      expect(UI_JS).toContain(`path === '${path}'`);
    }
    for (const prefix of UI_SHELL_PREFIX_PATHS) {
      expect(UI_JS).toContain(`'${prefix}/'`);
      expect(UI_JS).toContain(`path === '${prefix}'`);
    }
    // 服务端注册表必须覆盖精确路径的尾斜杠，且仍含动态前缀 /*
    const registered = uiShellRegisterPaths();
    for (const path of UI_SHELL_EXACT_PATHS) {
      expect(registered).toContain(path);
      expect(registered).toContain(`${path}/`);
    }
    for (const prefix of UI_SHELL_PREFIX_PATHS) {
      expect(registered).toContain(prefix);
      expect(registered).toContain(`${prefix}/*`);
    }
  });

  // 畸形百分号编码不得让 parseLocationRoute 同步抛 URIError（深链启动白屏）
  test('parseLocationRoute tolerates malformed percent-encoding without throwing', async () => {
    const { ROUTER_JS } = await import('../src/ui/client/router.ts');
    expect(ROUTER_JS).toContain('function safeDecodeURIComponent(');
    expect(ROUTER_JS).toContain('catch (_err)');
    const start = ROUTER_JS.indexOf('function safeDecodeURIComponent(');
    const end = ROUTER_JS.indexOf('function pathForScope(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const parseOnly = ROUTER_JS.slice(start, end);
    // 中文：仅抽出纯函数，闭包注入假 window.location，断言畸形深链不抛
    const makeParser = new Function(`
      return function (pathname) {
        var window = { location: { pathname: pathname } };
        ${parseOnly}
        return parseLocationRoute();
      };
    `);
    const wrap = makeParser() as (pathname: string) => {
      scope: string;
      taskId: string;
      address: string;
      folder: string;
      unknown?: boolean;
    };
    expect(() => wrap('/ui/tasks/%E4%B8')).not.toThrow();
    expect(wrap('/ui/tasks/%E4%B8')).toEqual({
      scope: 'inbox',
      taskId: '',
      address: '',
      folder: '',
      unknown: true,
    });
    expect(() => wrap('/ui/inbox/%E4%B8/inbox')).not.toThrow();
    expect(wrap('/ui/inbox/%E4%B8/inbox').unknown).toBe(true);
    expect(() => wrap('/ui/inbox/agent%40test.example/%ZZ')).not.toThrow();
    expect(wrap('/ui/inbox/agent%40test.example/%ZZ').unknown).toBe(true);
    // 合法编码仍可用
    const ok = wrap('/ui/tasks/%E4%B8%AD');
    expect(ok.scope).toBe('tasks');
    expect(ok.taskId).toBe('中');
    expect(ok.unknown).toBeUndefined();
  });

  // popstate / 客户端路由：api、oauth、frame 不得被解析成 dashboard scope（与服务端后挂 shell 对偶）
  test('parseLocationRoute does not claim api/oauth/frame reserved prefixes', async () => {
    expect(UI_JS).toContain("window.addEventListener('popstate'");
    expect(UI_JS).toContain('applyRoute(parseLocationRoute()');
    const { ROUTER_JS } = await import('../src/ui/client/router.ts');
    const start = ROUTER_JS.indexOf('function safeDecodeURIComponent(');
    const end = ROUTER_JS.indexOf('function pathForScope(');
    const parseOnly = ROUTER_JS.slice(start, end);
    const makeParser = new Function(`
      return function (pathname) {
        var window = { location: { pathname: pathname } };
        ${parseOnly}
        return parseLocationRoute();
      };
    `);
    const wrap = makeParser() as (pathname: string) => {
      scope: string;
      unknown?: boolean;
    };
    for (const path of [
      '/ui/api/me',
      '/ui/api/overview',
      '/ui/api/session',
      '/ui/oauth/grants',
      '/ui/oauth/authorize',
      '/ui/frame/1',
    ]) {
      const route = wrap(path);
      expect(route.unknown).toBe(true);
      expect(route.scope).toBe('inbox');
    }
    // Home 是唯一的 Overview 数据壳入口；旧 History API 条目也会在客户端归一化。
    expect(wrap('/ui').scope).toBe('overview');
    expect(wrap('/ui').unknown).toBeUndefined();
    expect(wrap('/ui/overview').scope).toBe('overview');
    expect(wrap('/ui/overview').unknown).toBeUndefined();
    expect(wrap('/ui/inbox').unknown).toBeUndefined();
  });

  // B6 0 期：Home 对所有会话可见；身份会话只看壳，不得到管理员概览数据。
  test('Home global nav is visible to every session while admin-only controls remain guarded', () => {
    expect(UI_HTML).toContain('<a class="app-nav-link" data-nav="overview" href="/ui">Home</a>');
    expect(UI_HTML).not.toContain('nav-overview-item');
    expect(UI_JS).not.toContain('navOverviewItem.hidden');
    expect(UI_CSS).not.toContain('#nav-overview-item');

    const start = UI_JS.indexOf('function isAdmin()');
    const end = UI_JS.indexOf('async function apiJson(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const snippet = UI_JS.slice(start, end);
    const run = new Function(`
      return function (kind) {
        var inboxView = { dataset: {} };
        var backToOverview = { hidden: false };
        var createIdentityButton = { hidden: true };
        var configureIdentitiesCreate = { hidden: true };
        var state = { me: { kind: kind } };
        ${snippet}
        configureSession();
        return {
          session: inboxView.dataset.session,
          backToHomeHidden: backToOverview.hidden
        };
      };
    `)() as (kind: string) => {
      session: string;
      backToHomeHidden: boolean;
    };

    const identity = run('identity');
    expect(identity.session).toBe('identity');
    expect(identity.backToHomeHidden).toBe(false);

    const admin = run('admin');
    expect(admin.session).toBe('admin');
    expect(admin.backToHomeHidden).toBe(false);
  });

  // A14
  test('the shell carries every overview hook the front-end code looks up', () => {
    for (const id of [
      'overview-panel',
      'overview-title',
      'overview-stats',
      'overview-rows',
      'overview-search',
      'overview-sort',
      'overview-state',
      'overview-refresh',
      'back-to-overview',
      'skip-link',
      'notify-panel',
      'notify-title',
      'notify-rows',
      'notify-state',
      'notify-refresh',
      'notify-topic-filter',
      'notify-notice',
      'notify-updated',
      'notify-shown',
      'notify-summary',
      'notify-diagnostics',
      'notify-verify',
      'notify-level-filter',
      'notify-from',
      'notify-to',
      'notify-limit',
      'notify-load-more',
      'notify-subtitle',
      'tasks-panel',
      'tasks-title',
      'tasks-rows',
      'tasks-state',
      'tasks-refresh',
      'tasks-status-tabs',
      'tasks-period',
      'tasks-limit',
      'tasks-load-more',
      'tasks-notice',
      'tasks-updated',
      'tasks-shown',
      'tasks-detail-content',
    ]) {
      expect(UI_HTML).toContain(`id="${id}"`);
    }
  });

  test('confirm modal exposes dialog semantics for tier-3 risk (F89)', () => {
    expect(UI_HTML).toMatch(
      /id="confirm-modal"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/,
    );
    expect(UI_HTML).toContain('aria-labelledby="confirm-modal-title"');
    expect(UI_HTML).toContain('aria-describedby="confirm-modal-text confirm-modal-risk"');
    expect(UI_HTML).toContain('id="confirm-modal-title"');
    expect(UI_HTML).toContain('id="confirm-modal-text"');
    expect(UI_HTML).toContain('id="confirm-modal-risk"');
  });

  // A15：landmark 挂在 inbox 容器上；scope 在 overview / notifications / tasks / inbox 四个 <main> 间切换
  test('exactly five mains exist and #main-content wraps the message and detail panels', () => {
    expect(UI_HTML).toContain('<main id="overview-panel" class="overview-panel" tabindex="-1"');
    expect(UI_HTML).toMatch(/<main id="overview-panel"[^>]*\shidden>/);
    expect(UI_HTML).toContain('<main id="notify-panel" class="notify-panel" tabindex="-1"');
    expect(UI_HTML).toMatch(/<main id="notify-panel"[^>]*\shidden>/);
    expect(UI_HTML).toContain('<main id="tasks-panel" class="tasks-panel" tabindex="-1"');
    expect(UI_HTML).toMatch(/<main id="tasks-panel"[^>]*\shidden>/);
    expect(UI_HTML).toContain('<main id="main-content" class="inbox-main" tabindex="-1">');
    expect(UI_HTML).toContain('<section id="detail-panel" class="detail-panel" tabindex="-1">');

    const container = UI_HTML.indexOf('id="main-content"');
    const list = UI_HTML.indexOf('id="message-panel"');
    const detail = UI_HTML.indexOf('id="detail-panel"');
    expect(container).toBeGreaterThan(-1);
    expect(container).toBeLessThan(list);
    expect(list).toBeLessThan(detail);
    // #message-panel / #detail-panel 自身不带 hidden：scope 只切四个内容 <main>
    expect(UI_HTML).not.toMatch(/<section id="(message|detail)-panel"[^>]*\shidden/);

    // login + overview + notify + tasks + configure×4 + plan + inbox-main
    expect(UI_HTML.split('<main').length - 1).toBe(10);
    expect(UI_HTML).toContain('id="app-nav"');
    expect(UI_HTML).toContain('id="nav-toggle"');
  });

  // A16 / A17
  test('scope changes move the hidden attribute, never the landmark id', () => {
    expect(UI_JS).toContain('function applyScope(');
    const applyScope = UI_JS.slice(
      UI_JS.indexOf('function applyScope('),
      UI_JS.indexOf('function filteredIdentities('),
    );
    expect(applyScope).toContain('overviewPanel.hidden = !overviewActive;');
    expect(applyScope).toContain('notifyPanel.hidden = !notifyActive;');
    expect(applyScope).toContain('tasksPanel.hidden = !tasksActive;');
    expect(applyScope).toContain('mainContent.hidden = !inboxActive;');
    expect(applyScope).toContain('identityPanel.hidden = !inboxActive;');
    expect(applyScope).toContain('mobileIdentityContainer.hidden = !inboxActive;');
    expect(applyScope).toContain('var SCOPE_META = {');
    expect(applyScope).toContain('skipLink.textContent = meta.skip');
    expect(applyScope).toContain("'Skip to Alerts'");
    expect(applyScope).toContain("'Skip to tasks'");
    expect(applyScope).toContain("'#notify-panel'");
    expect(applyScope).toContain("'#tasks-panel'");
    // landmark 与断点无关，所以不需要 matchMedia
    expect(UI_JS).not.toContain('matchMedia');
    expect(UI_JS).not.toMatch(/\.id\s*=\s*['"]main-content['"]/);

    const selectMessage = UI_JS.slice(
      UI_JS.indexOf('async function selectMessage('),
      UI_JS.indexOf('async function loadInbox('),
    );
    expect(selectMessage).toContain('detailPanel.focus();');
    expect(selectMessage).not.toContain('mainContent.focus()');
  });

  // B6 0 期：地址控件只在 Mail 内可见；未来非 Mail 链接会先进入 Mail。
  test('address controls are Mail-only and a non-Mail address activation enters Mail', () => {
    // 唯一的移动 selector 挂在内容 <main> 之外，由 scope 显式切 hidden。
    const layout = UI_HTML.indexOf('<div class="inbox-layout">');
    const selector = UI_HTML.indexOf('id="mobile-identity-select"');
    const overviewMain = UI_HTML.indexOf('<main id="overview-panel"');
    const notifyMain = UI_HTML.indexOf('<main id="notify-panel"');
    const tasksMain = UI_HTML.indexOf('<main id="tasks-panel"');
    const inboxMain = UI_HTML.indexOf('<main id="main-content"');
    expect(UI_HTML.split('id="mobile-identity-select"').length - 1).toBe(1);
    expect(selector).toBeGreaterThan(layout);
    expect(selector).toBeLessThan(overviewMain);
    expect(selector).toBeLessThan(notifyMain);
    expect(selector).toBeLessThan(tasksMain);
    expect(selector).toBeLessThan(inboxMain);
    expect(UI_HTML).toContain('<label for="mobile-identity-select">Address</label>');
    expect(UI_HTML).toContain('id="identity-panel"');
    expect(UI_HTML).toContain('id="mobile-identity"');
    // 移动端 Mail 仍沿用原有 folder/list/detail stack。
    expect(UI_CSS).toContain('.mobile-back, .mobile-identity { display: none; }');
    expect(UI_CSS).toContain('.mobile-identity { display: grid;');

    // 非 Mail scope 下都走 openAddress（它才会切 scope、播报、聚焦）。
    expect(UI_JS).toContain('function activateAddress(address) {');
    const activate = UI_JS.slice(
      UI_JS.indexOf('function activateAddress(address) {'),
      UI_JS.indexOf('function filteredIdentities('),
    );
    expect(activate).toContain("if (state.scope !== 'inbox') {");
    expect(activate).toContain('openAddress(address);');
    expect(activate).toContain('selectIdentity(address);');
    expect(UI_JS).toContain('activateAddress(identity.address);');
    expect(UI_JS).toContain('if (mobileIdentity.value) activateAddress(mobileIdentity.value);');
    // 地址控件不保留伪造页面跳转选项。
    expect(UI_JS).not.toContain('__notifications__');
    expect(UI_JS).not.toContain('__tasks__');
    // 侧栏/选择器不许再直接调 selectIdentity（那样会绕开 openAddress 的路由处理）。
    expect(UI_JS).not.toContain('selectIdentity(identity.address);');
    expect(UI_JS).not.toContain('selectIdentity(mobileIdentity.value);');
  });

  // 通知记录：30 天日志为主数据源；12h cache fallback 用人话说明。
  test('notifications panel loads history via /ui/api/notify/messages with session-scoped topics', () => {
    expect(UI_JS).toContain('function enterNotifications(');
    expect(UI_JS).toContain('function loadNotificationLog(');
    expect(UI_JS).toContain("'/ui/api/notifications?'");
    expect(UI_JS).toContain("'/ui/api/notify/summary?date=today&tz='");
    expect(UI_JS).toContain("'/ui/api/notify/diagnostics'");
    expect(UI_JS).toContain("'/ui/api/notify/verify'");
    expect(UI_JS).toContain('function loadNotifyHistory(');
    expect(UI_JS).toContain('function mapPool(');
    expect(UI_JS).toContain('function fetchNotifyTopic(');
    expect(UI_JS).toContain("'/ui/api/notify/messages?topic='");
    expect(UI_JS).toContain('&since=12h');
    expect(UI_JS).toContain('mapPool(topics, 6,');
    expect(UI_JS).toContain('error.status === 404');
    expect(UI_JS).toContain("return ['self']");
    expect(UI_JS).toContain("'user-alerts'");
    expect(UI_JS).toContain("'user-low'");
    expect(UI_JS).toContain("'agent:' + localpart");
    expect(UI_JS).not.toContain("value = '__notifications__'");
    expect(UI_JS).toContain('notifyPanel.focus({ preventScroll: true })');
    expect(UI_JS).toContain('tierFromPriority');
    expect(UI_JS).toContain("priority === 5");
    expect(UI_JS).toContain("priority === 1");
    expect(UI_JS).toContain("return 'unknown'");
    expect(UI_JS).toContain('What we tried to send to your phone and computers in the last 12 hours. This is not a 30-day audit log.');
    expect(UI_JS).not.toContain('Transport cache (ntfy 12h)');
    expect(UI_JS).toContain('renderSensitiveText');
    expect(UI_JS).toContain("'•••'");
    // 前端不得直接打 Bearer 的 /v1/notify
    expect(UI_JS).not.toContain('/v1/notify');
  });

  // 任务工单：入口、API 与 landmark 与 Notifications 同级钉在静态契约里
  test('tasks panel loads tickets via /ui/api/tasks with session-scoped ACL', () => {
    expect(UI_JS).toContain('function enterTasks(');
    expect(UI_JS).toContain('async function loadTasks(');
    expect(UI_JS).toContain('async function selectTask(');
    expect(UI_JS).toContain("'/ui/api/tasks?' + params.join('&')");
    expect(UI_JS).toContain("'/ui/api/tasks/' + encodeURIComponent(id)");
    expect(UI_JS).not.toContain("value = '__tasks__'");
    expect(UI_JS).toContain("return 'Waiting for you'");
    expect(UI_JS).toContain('Write a reply. This goes back to the agent as a working update.');
    expect(UI_JS).toContain('tasksPanel.focus({ preventScroll: true })');
    expect(UI_JS).toContain('function clearTasksState(');
    expect(UI_JS).toContain('function cancelTasksLoad(');
    expect(UI_JS).toContain('function taskTimelineBody(');
    expect(UI_JS).toContain("taskTimelineBody(message.body)");
    expect(UI_JS).toContain(
      "var TASK_RESULT_MARKER = '<!-- openagent.email task result -->'",
    );
    const stripBody = UI_JS.slice(
      UI_JS.indexOf('function taskTimelineBody('),
      UI_JS.indexOf('function renderTaskRows('),
    );
    expect(stripBody).toContain('text.lastIndexOf(TASK_RESULT_MARKER)');
    expect(stripBody).toContain('String.fromCharCode(96, 96, 96)');
    // 与拆分前 main 一致：RegExp 字符串字面量里是 \\s（源码两反斜杠 → 运行时 \s）。
    // 禁止 JSON 二次转义成 \\\\s（四反斜杠），否则会匹配字面量反斜杠而非空白。
    expect(stripBody).toContain(
      "new RegExp('^\\\\s*' + ticks + 'json\\\\s*\\\\n([\\\\s\\\\S]*?)\\\\n' + ticks + '\\\\s*$')",
    );
    expect(stripBody).toContain(".replace(/\\s+$/, '')");
    expect(stripBody).not.toContain('^\\\\\\\\s*');
    expect(stripBody).toContain('after.match(fence)');
    expect(stripBody).toContain('JSON.parse(match[1])');
    expect(stripBody).not.toContain('text.indexOf(TASK_RESULT_MARKER)');
    expect(UI_JS).toContain('window.scrollTo(0, 0)');
    expect(UI_JS).toContain("state.scope !== 'tasks' || !state.activeTaskId");
    expect(UI_JS).toContain("inboxView.dataset.mobileView === 'tasks-detail'");
    expect(UI_JS).toContain('window.innerWidth > 820');
    expect(UI_CSS).toContain('@media (max-width: 1360px) and (min-width: 821px)');
    // F12：紧凑列查询必须在基础 .task-row 五列声明之后，否则被覆盖
    const headerBase = UI_CSS.indexOf(
      '.tasks-header {\n  display: grid;\n  gap: 10px;\n  grid-template-columns: 110px',
    );
    const rowBase = UI_CSS.indexOf(
      '.task-row {\n  width: 100%;\n  display: grid;\n  gap: 10px;\n  grid-template-columns: 110px',
    );
    const compactMq = UI_CSS.indexOf(
      '@media (max-width: 1360px) and (min-width: 821px)',
    );
    expect(headerBase).toBeGreaterThan(-1);
    expect(rowBase).toBeGreaterThan(-1);
    expect(compactMq).toBeGreaterThan(rowBase);
    // 前端不得直接打 Bearer 的 /v1/tasks
    expect(UI_JS).not.toContain('/v1/tasks');
  });

  // 任务列表改为服务端 20/50/100 + Load more，不再客户端截 500
  test('task board uses server status/period/limit pagination instead of a client 500 cap', () => {
    expect(UI_JS).not.toContain('var TASKS_RENDER_LIMIT = 500');
    expect(UI_JS).toContain("state.tasksFilter || 'input-required'");
    expect(UI_JS).toContain("state.tasksPeriod || '30d'");
    expect(UI_JS).toContain("String(state.tasksLimit || 20)");
    expect(UI_JS).toContain("'/ui/api/tasks?' + params.join('&')");
    expect(UI_JS).toContain("params.push('cursor=' + encodeURIComponent(state.tasksNextCursor))");
    expect(UI_HTML).toContain('id="tasks-load-more"');
    expect(UI_HTML).toContain('data-status="active"');
    expect(UI_HTML).toContain('data-status="input-required"');
    expect(UI_JS).toContain("'/ui/api/tasks/' + encodeURIComponent(task.id) + '/reply'");
    expect(UI_JS).toContain("'/ui/api/tasks/' + encodeURIComponent(task.id) + '/remind'");
    expect(UI_JS).toContain("'/ui/api/tasks/' + encodeURIComponent(task.id) + '/close'");
    expect(UI_JS).toContain("return 'Closed'");
    expect(UI_JS).toContain('task-result-table');
    expect(UI_JS).toContain('Original request');
    const renderRows = UI_JS.slice(
      UI_JS.indexOf('function renderTaskRows('),
      UI_JS.indexOf('function fillTaskFromSelect('),
    );
    expect(renderRows).toContain('rows.forEach');
    expect(renderRows).not.toContain('rows.slice(0, TASKS_RENDER_LIMIT)');
  });

  // 时间线条目上限：长工单不全量建节点
  test('task timeline is capped at TASK_TIMELINE_RENDER_LIMIT with an honest truncation label', () => {
    expect(UI_JS).toContain('var TASK_TIMELINE_RENDER_LIMIT = 200');
    expect(UI_JS).toContain('messages.slice(timelineTotal - TASK_TIMELINE_RENDER_LIMIT)');
    expect(UI_JS).toContain("'Showing latest ' + TASK_TIMELINE_RENDER_LIMIT");
    const detail = UI_JS.slice(
      UI_JS.indexOf('function renderTaskDetail('),
      UI_JS.indexOf('function renderTasks('),
    );
    expect(detail).toContain('timelineTotal > TASK_TIMELINE_RENDER_LIMIT');
    expect(detail).toContain('visibleMessages.forEach');
    expect(detail).not.toContain('task.messages : []).forEach');
  });

  // 切 state 过滤时 fetchKey 变化必须进 loading，禁止立刻渲染假空态/旧缓存
  test('task state filter changes enter loading instead of a false empty or stale list', () => {
    const load = UI_JS.slice(
      UI_JS.indexOf('async function loadTasks('),
      UI_JS.indexOf('async function selectTask('),
    );
    expect(load).toContain('state.tasksFetchKey !== tasksFetchKey()');
    expect(load).toContain("state.tasksStatus = 'loading'");
    expect(load).toContain('state.tasks = []');
    expect(load).toContain('state.tasksFetchKey = tasksFetchKey()');
    const renderRows = UI_JS.slice(
      UI_JS.indexOf('function renderTaskRows('),
      UI_JS.indexOf('function renderTaskDetail('),
    );
    expect(renderRows).toContain('state.tasksFetchKey === tasksFetchKey()');
    expect(renderRows).toContain("state.tasksStatus === 'loading' || !keyMatches");
    expect(renderRows).toContain("'Loading…'");
  });

  // F1：401 → showLogin 必须清掉通知缓存，否则换 token 会渲染上一主体内容
  test('showLogin clears notify cache so a new session cannot reuse prior history (F1)', () => {
    expect(UI_JS).toContain('function clearNotifyState(');
    const showLogin = UI_JS.slice(
      UI_JS.indexOf('function showLogin(message)'),
      UI_JS.indexOf('function showInbox('),
    );
    expect(showLogin).toContain('clearNotifyState()');
    // F5：先钉存在性，避免 indexOf 得到 -1 让顺序断言空转
    expect(showLogin).toContain('cancelNotifyLoad()');
    expect(showLogin.indexOf('cancelNotifyLoad()')).toBeLessThan(
      showLogin.indexOf('clearNotifyState()'),
    );
    const clear = UI_JS.slice(
      UI_JS.indexOf('function clearNotifyState('),
      UI_JS.indexOf('function showLogin(message)'),
    );
    for (const field of [
      'state.notifyMessages = []',
      "state.notifyStatus = 'idle'",
      "state.notifyMessage = ''",
      "state.notifyFilter = ''",
      'state.notifyUpdatedAt = 0',
      "state.notifyFetchKey = ''",
      'state.notifyPending = false',
      'state.notifyLogItems = []',
      "state.notifyLogFetchKey = ''",
      "state.notifyNextCursor = ''",
      'state.notifySummary = null',
      'state.notifyRevealed = {}',
    ]) {
      expect(clear).toContain(field);
    }
    // apiJson 401 走 showLogin（因而间接触发清理），不是只 abort
    expect(UI_JS).toContain("showLogin('Your session expired. Sign in again.')");
  });

  // F1（tasks）：401 → showLogin 必须清掉工单缓存，否则换 token 会渲染上一主体任务
  test('showLogin clears tasks cache so a new session cannot reuse prior tickets (F1)', () => {
    expect(UI_JS).toContain('function clearTasksState(');
    const showLogin = UI_JS.slice(
      UI_JS.indexOf('function showLogin(message)'),
      UI_JS.indexOf('function showInbox('),
    );
    expect(showLogin).toContain('clearTasksState()');
    expect(showLogin).toContain('cancelTasksLoad()');
    expect(showLogin.indexOf('cancelTasksLoad()')).toBeLessThan(
      showLogin.indexOf('clearTasksState()'),
    );
    const clear = UI_JS.slice(
      UI_JS.indexOf('function clearTasksState('),
      UI_JS.indexOf('function showLogin(message)'),
    );
    for (const field of [
      'state.tasks = []',
      "state.tasksStatus = 'idle'",
      "state.tasksMessage = ''",
      "state.tasksFilter = 'input-required'",
      "state.tasksPeriod = '30d'",
      'state.tasksLimit = 20',
      "state.tasksNextCursor = ''",
      'state.tasksUpdatedAt = 0',
      'state.tasksPending = false',
      "state.tasksFetchKey = ''",
      "state.activeTaskId = ''",
      'state.taskDetail = null',
      "state.taskDetailStatus = 'idle'",
      "state.taskDetailMessage = ''",
    ]) {
      expect(clear).toContain(field);
    }
  });

  // F2：渲染行数上限，避免 12h 嘈杂实例卡死页面
  test('notify rows are capped at NOTIFY_RENDER_LIMIT with an honest truncation label (F2)', () => {
    expect(UI_JS).toContain('var NOTIFY_RENDER_LIMIT = 500');
    expect(UI_JS).toContain('rows.slice(0, NOTIFY_RENDER_LIMIT)');
    expect(UI_JS).toContain("'Showing latest ' + NOTIFY_RENDER_LIMIT");
    const renderRows = UI_JS.slice(
      UI_JS.indexOf('function renderNotifyRows('),
      UI_JS.indexOf('function renderNotifyMeta('),
    );
    expect(renderRows).toContain('var truncated = total > NOTIFY_RENDER_LIMIT');
    expect(renderRows).toContain('visible.forEach');
    expect(renderRows).not.toContain('rows.forEach');
  });

  // F4：切频道时 fetchKey 变化必须进 loading，禁止立刻渲染假空态
  test('channel filter changes enter loading instead of a false empty state (F4)', () => {
    const load = UI_JS.slice(
      UI_JS.indexOf('async function loadNotifyHistory('),
      UI_JS.indexOf('function enterNotifications('),
    );
    expect(load).toContain('state.notifyFetchKey !== notifyFetchKey()');
    expect(load).toContain("state.notifyStatus = 'loading'");
    expect(load).toContain('state.notifyMessages = []');
    const renderRows = UI_JS.slice(
      UI_JS.indexOf('function renderNotifyRows('),
      UI_JS.indexOf('function renderNotifyMeta('),
    );
    expect(renderRows).toContain('state.notifyFetchKey === notifyFetchKey()');
    expect(renderRows).toContain("state.notifyStatus === 'loading' || !keyMatches");
    expect(renderRows).toContain("'Loading…'");
  });

  // F7：任一路 503 短路扇出，不再打剩余 topic
  test('a 503 from notify history short-circuits the remaining topic fan-out (F7)', () => {
    expect(UI_JS).toContain('error.status === 503');
    expect(UI_JS).toContain('disabled: true');
    expect(UI_JS).toContain("'Notifications are not configured on this server.'");
    expect(UI_JS).toContain("'Notifications are disabled on this server.'");
    const load = UI_JS.slice(
      UI_JS.indexOf('async function loadNotifyHistory('),
      UI_JS.indexOf('function enterNotifications('),
    );
    expect(load).toContain('if (disabledMessage)');
    expect(load).toContain('controller.abort()');
  });

  // F8：同频道全败刷新不清缓存，诚实保留上一版数据
  test('a total refresh failure keeps previous notify cache for the same fetchKey (F8)', () => {
    const load = UI_JS.slice(
      UI_JS.indexOf('async function loadNotifyHistory('),
      UI_JS.indexOf('function enterNotifications('),
    );
    expect(load).toContain('failures &&');
    expect(load).toContain('merged.length === 0');
    expect(load).toContain('state.notifyMessages.length > 0');
    expect(load).toContain('state.notifyFetchKey === fetchKey');
    expect(load).toContain("'Refresh failed. Showing previous notifications.'");
    // 保留文案必须出现在「写回 merged」之前；else 侧才允许赋值
    const keepMsgIdx = load.indexOf("'Refresh failed. Showing previous notifications.'");
    const assignIdx = load.indexOf('state.notifyMessages = merged;');
    expect(keepMsgIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(keepMsgIdx);
    const beforeAssign = load.slice(0, assignIdx);
    expect(beforeAssign).toContain("'Refresh failed. Showing previous notifications.'");
    expect(beforeAssign).toContain('state.notifyMessages.length > 0');
    // else 侧仍写 merged（部分失败 / 首载全败 / 成功）
    expect(load.slice(assignIdx)).toContain('Some channels could not be loaded');
  });

  // N1：Home 落焦不滚动；一期 Home 不再保留旧的地址行返回焦点。
  test('landing on Home keeps the first screen and starts the operating desk', () => {
    expect(UI_JS).toContain('overviewPanel.focus({ preventScroll: true });');
    // 面板落焦只有这一个入口，别处不许再裸调 overviewPanel.focus()
    expect(UI_JS).not.toContain('overviewPanel.focus();');
    expect(UI_JS.split('overviewPanel.focus(').length - 1).toBe(1);

    const enter = UI_JS.slice(
      UI_JS.indexOf('function enterOverview('),
      UI_JS.indexOf('function openAddress('),
    );
    expect(enter).toContain('focusOverviewPanel();');
    expect(enter).toContain('loadHome({ refresh: false });');
    expect(enter).not.toContain('preventScroll');

    expect(UI_JS).toContain("'Waiting for you'");
    expect(UI_JS).toContain("'Urgent pushes today'");
    expect(UI_JS).toContain("'/ui/api/notify/summary?date=today&tz='");

    // B6 0 期：Home/非 Mail 深链必须在 Mail 初载前落面，慢邮箱不能挡住首屏。
    const startSession = UI_JS.slice(
      UI_JS.indexOf('async function startSession('),
      UI_JS.indexOf("loginForm.addEventListener('submit'"),
    );
    const route = startSession.indexOf('var route = parseLocationRoute();');
    const firstLoad = startSession.indexOf('await loadInbox();');
    expect(route).toBeGreaterThan(-1);
    expect(firstLoad).toBeGreaterThan(route);
    expect(startSession).toContain("if (route.scope !== 'inbox') {");
    expect(startSession).toContain('await applyRoute(route, { replaceUrl: true, announce: \'\', seedMobileStack: true });');
    expect(startSession).toContain('await loadInbox()');
    expect(startSession).toContain('await applyRoute(route, { replaceUrl: true, announce: \'\', seedMobileStack: true });');
    expect(startSession).not.toContain('focusOverviewPanel();');
    expect(UI_JS).toContain('function applyRoute(');
    expect(UI_JS).toContain('function parseLocationRoute(');
    expect(UI_JS).toContain('function renderAppNav(');
  });

  // F5 / §6 行 11：一封信投给多个地址时计数会重叠，页面上必须解释
  test('the overview explains overlapping counts in its own copy', () => {
    expect(UI_HTML).toContain(
      '<p id="overview-overlap" class="overview-subtitle">Counts overlap when one email is addressed to several addresses.</p>',
    );
    const subtitle = UI_HTML.indexOf('id="overview-subtitle"');
    const overlap = UI_HTML.indexOf('id="overview-overlap"');
    const updated = UI_HTML.indexOf('id="overview-updated"');
    expect(subtitle).toBeLessThan(overlap);
    expect(overlap).toBeLessThan(updated);
  });

  // F6：活动地址消失 → 回 Home 并播报
  test('a deleted active address migrates the inbox back to the overview', () => {
    const reconcile = UI_JS.slice(
      UI_JS.indexOf('function reconcileActiveAddress() {'),
      UI_JS.indexOf('function focusOverviewPanel() {'),
    );
    expect(reconcile).toContain('if (!state.activeAddress) return;');
    expect(reconcile).toContain("state.activeAddress = '';");
    expect(reconcile).toContain("if (state.scope === 'inbox') enterOverview({ announce: lost + ' is no longer available. Back to Home.' });");
    // Home roster refresh and inbox admin Refresh both reconcile the active address.
    expect(UI_JS).toContain('      reconcileActiveAddress();');
    expect(UI_JS).toContain('if (isAdmin()) refreshInboxIdentities();');
    expect(UI_JS.split('reconcileActiveAddress();').length - 1).toBeGreaterThanOrEqual(1);
    expect(UI_JS).toContain('function refreshInboxIdentities() {');
  });

  // A18 / A19 / A20 / A21
  // 远程 URL 闸：仅允许 openagent.email/docs 前缀（Plan 自托管文档），其余仍禁 https://。
  const UI_REMOTE_HREF_ALLOWLIST = 'https://openagent.email/docs';
  function withoutAllowedDocsHrefs(asset: string) {
    return asset.split(UI_REMOTE_HREF_ALLOWLIST).join('');
  }

  test('the three assets stay free of parser sinks and remote references', () => {
    expect(UI_JS).toContain('https://openagent.email/docs/reference/api/');
    for (const asset of [UI_HTML, UI_CSS, UI_JS]) {
      expect(asset).not.toMatch(
        /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\s*\(|new\s+Function\b|createElementNS/,
      );
      expect(withoutAllowedDocsHrefs(asset)).not.toMatch(/\bhttps?:\/\//);
      expect(asset).not.toMatch(/["'(=]\s*\/\//);
      expect(asset).not.toContain('@import');
      expect(asset).not.toContain('data:');
      expect(asset).not.toMatch(/tabindex="[1-9]/);
    }
    // @font-face / url() / Satoshi 只允许出现在 CSS 里，且只指向同源 /ui/fonts/
    for (const asset of [UI_HTML, UI_JS]) {
      expect(asset).not.toContain('@font-face');
      expect(asset).not.toContain('url(');
      expect(asset).not.toContain('Satoshi');
    }
    expect(UI_CSS.match(/url\(/g)?.length).toBe(4);
    for (const weight of ['Regular', 'Medium', 'Bold', 'Black']) {
      expect(UI_CSS).toContain(`url('/ui/fonts/Satoshi-${weight}.woff2') format('woff2')`);
    }
    expect(UI_CSS).toContain("--sans: 'Satoshi', system-ui");
    expect(OUTER_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(UI_JS).toContain("'/ui/api/overview'");
    expect(UI_JS).not.toContain("'/ui/api/overview?refresh=1'");
  });

  // Satoshi 与 website/public/fonts/ 同源同文件：sha256 钉死，官网换字体这里会红
  test('font routes serve the website Satoshi files with immutable caching', async () => {
    const expected: Record<string, string> = {
      'Satoshi-Regular.woff2': '5aa97d938f523dd893c52473c3a021a0bf4ba0f95290edcc0749c088717f951f',
      'Satoshi-Medium.woff2': 'd492ce178ab9042bd6bcad1b9ef49b1436ba5f4f833dee4a7a2ed94e9d8c922e',
      'Satoshi-Bold.woff2': '6f979e75eb9d6de6af2eacc0c72fd2cbe613922b27db92217dd204c8080de930',
      'Satoshi-Black.woff2': 'a4f962f7f9c049b2d58d848746206adf99bb7b89407d6cc29a36b7eb0d77d032',
    };
    for (const [name, sha256] of Object.entries(expected)) {
      const res = await app.request(`/ui/fonts/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const digest = new Bun.CryptoHasher('sha256')
        .update(new Uint8Array(await res.arrayBuffer()))
        .digest('hex');
      expect(digest).toBe(sha256);
    }
    expect((await app.request('/ui/fonts/Satoshi-Thin.woff2')).status).toBe(404);
  });

  // A22：断点值不动，其内规则按嵌套栅格适配
  test('both breakpoints survive and the nested inbox grid collapses on mobile', () => {
    const flat = UI_CSS.replace(/\s+/g, ' ');
    expect(UI_CSS).toContain('@media (max-width: 1100px)');
    expect(UI_CSS).toContain('@media (max-width: 820px)');
    expect(UI_CSS).toContain('[data-scope="inbox"]');
    expect(UI_CSS).toContain('[data-mobile-view="overview"]');
    expect(flat).toContain('.inbox-layout { min-height: calc(100vh - 74px); display: grid; grid-template-columns: minmax(0, 1fr); }');
    expect(flat).toContain('.inbox-view[data-scope="inbox"] .inbox-layout { grid-template-columns: 240px minmax(0, 1fr); }');
    expect(flat).toContain('@media (max-width: 1100px) { .inbox-view[data-scope="inbox"] .inbox-layout { grid-template-columns: 210px minmax(0, 1fr); }');
    expect(flat).toContain('.inbox-main { min-width: 0; display: grid; grid-template-columns: 360px minmax(0, 1fr); }');
    expect(flat).toContain('.inbox-main { display: block; }');
    // 仓库里的移动规则是后代选择器，多包一层 <main> 后仍然命中
    expect(UI_CSS).toContain('.inbox-view[data-mobile-view="list"] .detail-panel { display: none; }');
    expect(UI_CSS).toContain('.inbox-view[data-mobile-view="detail"] .message-panel { display: none; }');
  });

  // A22b：logo 只允许一个导出，几何是模块私有的
  test('assets.ts exports exactly one logo constant and its geometry matches the website file', async () => {
    const logoExports = Object.keys(assets).filter((name) => name.includes('LOGO'));
    expect(logoExports).toEqual(['UI_LOGO_SVG']);
    expect((assets as Record<string, unknown>).logoGeometry).toBeUndefined();

    const geometry = UI_LOGO_SVG
      .replace(/^<svg[^>]*>\n/, '')
      .replace(/\n<\/svg>\n$/, '');
    expect(geometry).toBe(WEBSITE_LOGO_GEOMETRY);
    // 单一来源：外壳里的 <symbol> 与 favicon 用同一份几何
    expect(UI_HTML).toContain(`<symbol id="oa-mark" viewBox="0 0 32 32">${geometry}</symbol>`);
  });

  // R7：品牌 lockup 取代 OA 方块，topbar 只出现一次品牌名
  test('the brand lockup replaces the OA placeholder in both places', () => {
    expect(UI_HTML).not.toContain('brand-mark');
    expect(UI_HTML).not.toContain('>OA<');
    expect(UI_CSS).not.toContain('.brand-mark');
    expect(UI_JS).not.toContain('brand-mark');
    expect(UI_HTML).toContain('<use href="#oa-mark"/>');
    expect(UI_HTML.split('<use href="#oa-mark"/>').length - 1).toBe(2);
    expect(UI_HTML).toContain('width="40" height="40"');
    expect(UI_HTML).toContain('width="24" height="24"');

    const topbar = UI_HTML.slice(
      UI_HTML.indexOf('<header class="topbar">'),
      UI_HTML.indexOf('</header>'),
    );
    expect(topbar.split('OpenAgent.email').length - 1).toBe(1);
    expect(topbar).not.toContain('class="eyebrow"');

    // 旧 token 一刀切，不留别名
    for (const stale of ['--panel', '--panel-2', '--text:', '--muted', '--amber', '--danger']) {
      expect(UI_CSS).not.toContain(stale);
    }
    for (const token of ['--bg-raise', '--bg-card', '--ink-dim', '--ink-faint', '--gold', '--green', '--red', '--line-control']) {
      expect(UI_CSS).toContain(token);
    }
    expect(UI_CSS).toContain(
      "--sans: 'Satoshi', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;",
    );
    expect(UI_CSS).not.toContain('Helvetica Neue');
    expect(UI_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    // 11–12 px 的弱字不许用 --ink-faint
    expect(UI_CSS).toContain('.fine-print { margin: 20px 0 0; color: var(--ink-dim); font-size: 12px; }');
    expect(UI_CSS).toContain('.message-date { flex: none; color: var(--ink-dim); font-size: 11px; }');
    expect(UI_CSS).toContain('.link-url { color: var(--ink-dim); font-size: 11px; }');
  });

  // Home 徽标只能读 listBoard 的 totalApprox，不许从列表行数汇总。
  test('Home uses the server task total and server overdue flag without a client count', () => {
    const countParts = UI_JS.slice(
      UI_JS.indexOf('function countParts('),
      UI_JS.indexOf('function appendCell('),
    );
    expect(countParts).toContain("if (row.complete) return");
    expect(countParts).toContain("'≥' + formatNumber(value)");
    expect(countParts).toContain("text: 'Unknown'");
    expect(countParts).toContain('Lower bound — this scan hit its recipient limit.');
    expect(countParts).toContain('Not counted — this scan hit its recipient limit.');
    expect(countParts).toContain("'Unavailable'");
    const home = UI_JS.slice(
      UI_JS.indexOf('function loadHome('),
      UI_JS.indexOf('function stopDashboardPolling('),
    );
    expect(home).toContain('state.homeWaitingTotal = typeof waitingPayload.totalApprox === \'number\'');
    expect(home).toContain('loadHomeActiveOverdue(signal)');
    expect(home).toContain('state.homeStuckTasks = Array.isArray(results[1].payload) ? results[1].payload : [];');
    const activeOverdue = UI_JS.slice(
      UI_JS.indexOf('async function loadHomeActiveOverdue('),
      UI_JS.indexOf('function homeNumber('),
    );
    expect(activeOverdue).toContain('if (task.overdueReason) overdue.push(task);');
    expect(activeOverdue).toContain('while (cursor && overdue.length < HOME_VISIBLE_ROWS);');
    expect(home).toContain('state.homeFailedUrgentCount = typeof summaryPayload.failedUrgentCount === \'number\'');
    expect(home).not.toContain('state.homeWaitingTasks.length');
  });

  test('Home health respects the identity permission matrix', () => {
    const home = UI_JS.slice(
      UI_JS.indexOf('function renderHomeHealth('),
      UI_JS.indexOf('function renderHomeSessionEmpty('),
    );
    expect(home).toContain("if (isAdmin()) {");
    expect(home).toContain("healthCard('Addresses', String(state.identities.length), 'configure-identities')");
    expect(home).toContain("healthCard('Unread mail', homeNumber(state.homeUnseenCount), 'inbox')");
    expect(home).toContain("healthCard('Mail', 'Open mailbox', 'inbox')");
  });

  // N1：仅前台、仅有交互的会话按 30s 轮询；闲置降频，隐藏标签停止。
  test('dashboard polling is visibility-aware, interaction-throttled, and limited to board/notifications', () => {
    expect(UI_JS).toContain('var DASHBOARD_POLL_MS = 30000;');
    expect(UI_JS).toContain('var DASHBOARD_IDLE_POLL_MS = 120000;');
    expect(UI_JS).toContain('!document.hidden');
    expect(UI_JS).toContain('function abortDashboardPollRequests()');
    expect(UI_JS).toContain('abortDashboardPollRequests();');
    expect(UI_JS).toContain("['pointerdown', 'keydown', 'touchstart']");
    expect(UI_JS).toContain('if (dashboardPollTimer === null) scheduleDashboardPolling();');
    expect(UI_JS).toContain("if (state.scope === 'overview') work = loadHome({ poll: true });");
    expect(UI_JS).toContain("else if (state.scope === 'tasks' && !state.tasksPending) work = loadTasks({ poll: true });");
    expect(UI_JS).toContain("else if (state.scope === 'notifications' && !state.notifyPending) work = loadNotificationLog({ poll: true });");
    const notificationPoll = UI_JS.slice(
      UI_JS.indexOf('async function loadNotificationLog('),
      UI_JS.indexOf('async function handleNotifyVerify('),
    );
    expect(notificationPoll).toContain('if (!opts.poll) {\n        await loadNotifySummary(controller.signal);');
    expect(notificationPoll).toContain('if (!opts.poll && isAdmin() && state.identities.length === 0)');
    expect(notificationPoll).toContain('if (opts.poll) trackDashboardPollRequest(controller);');
    expect(notificationPoll).toContain('releaseDashboardPollRequest(controller);');
    const notificationHistory = UI_JS.slice(
      UI_JS.indexOf('async function loadNotifyHistory('),
      UI_JS.indexOf('async function loadNotifySummary('),
    );
    expect(notificationHistory).not.toContain('opts.poll');
    expect(UI_JS).toContain('var FRESH_MS = 15000;');
    expect(UI_JS.split(/\b15000\b/).length - 1).toBe(1);
  });

  test('Home reads two board views plus notification summary without identity overview access', () => {
    const home = UI_JS.slice(
      UI_JS.indexOf('async function loadHome('),
      UI_JS.indexOf('function stopDashboardPolling('),
    );
    expect(home).toContain("homeTaskUrl('input-required')");
    expect(UI_JS).toContain("homeTaskUrl('active', cursor, HOME_ACTIVE_PAGE_LIMIT)");
    expect(home).toContain("'/ui/api/notify/summary?date=today&tz='");
    expect(home).toContain("isAdmin() && !opts.poll");
    expect(home).toContain("apiJson('/ui/api/overview'");
    expect(home).toContain('Promise.resolve(null)');
  });

  // F126: an overview rerender during the tier-3 dialog must not allow a
  // competing tier PUT on a replacement select.
  test('handlePushTierChange locks a pending address and renders pending immediately (F126)', () => {
    const handleTier = UI_JS.slice(
      UI_JS.indexOf('function handlePushTierChange('),
      UI_JS.indexOf('function formatDate('),
    );
    // Entry lock: after the isAdmin gate, before reading the previous tier.
    expect(handleTier.indexOf('if (!isAdmin()) return;')).toBeLessThan(
      handleTier.indexOf('if (state.tierPending[address]) return;'),
    );
    expect(handleTier.indexOf('if (state.tierPending[address]) return;')).toBeLessThan(
      handleTier.indexOf('var previous ='),
    );
    // Pending renders immediately (disabled replacement select) before the PUT.
    const pendingSet = handleTier.indexOf('state.tierPending[address] = true;');
    const putStart = handleTier.indexOf('await savePushContentTier(', pendingSet);
    const prologue = handleTier.slice(pendingSet, putStart);
    expect(prologue).toContain('renderOverview()');
    // F127: apply() rechecks the lock — a stale tier-3 dialog confirm bypasses
    // the entry guard and must drop instead of starting a competing PUT.
    const applyStart = handleTier.indexOf('async function apply(');
    expect(handleTier.indexOf('if (state.tierPending[address]) {', applyStart)).toBeGreaterThan(
      applyStart,
    );
    expect(handleTier.indexOf('if (state.tierPending[address]) {', applyStart)).toBeLessThan(
      pendingSet,
    );
  });

  // F51: fuzzy push-tier PUT failure must re-fetch authoritative tier; known rejects restore.
  test('handlePushTierChange fuzzy failure re-fetches tier; known failures restore (F51)', () => {
    const handleTier = UI_JS.slice(
      UI_JS.indexOf('function handlePushTierChange('),
      UI_JS.indexOf('function formatDate('),
    );
    const catchStart = handleTier.indexOf('} catch (error) {');
    const finallyStart = handleTier.indexOf('} finally {', catchStart);
    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(finallyStart).toBeGreaterThan(catchStart);
    const catchBody = handleTier.slice(catchStart, finallyStart);

    // Fuzzy path: shared recoverPushTier, then write select + dataset from server tier.
    expect(catchBody).toContain('await recoverPushTier(address)');
    expect(catchBody).toContain('selectEl.value = String(recovered.authoritative)');
    expect(catchBody).toContain('selectEl.dataset.currentTier = String(recovered.authoritative)');
    const fuzzyStart = catchBody.indexOf('// Fuzzy failure');
    expect(fuzzyStart).toBeGreaterThanOrEqual(0);
    const fuzzyBranch = catchBody.slice(fuzzyStart);
    expect(fuzzyBranch).toContain("if (recovered.status === 'stale') return");
    expect(fuzzyBranch).not.toContain("apiJson('/ui/api/identities')");

    // confirm_risk_required: restore before announce (server clearly rejected).
    const confirmIdx = catchBody.indexOf("error.body.error === 'confirm_risk_required'");
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    const afterConfirm = catchBody.slice(confirmIdx);
    expect(afterConfirm.indexOf('restore()')).toBeGreaterThanOrEqual(0);
    expect(afterConfirm.indexOf('restore()')).toBeLessThan(
      afterConfirm.indexOf("announce('Tier 3 requires explicit risk confirmation.')"),
    );

    // session_expired: restore only (session flow takes over).
    const sessionIdx = catchBody.indexOf("error.message === 'session_expired'");
    expect(sessionIdx).toBeGreaterThan(confirmIdx);
    const sessionBranch = catchBody.slice(sessionIdx, catchBody.indexOf('} else {', sessionIdx));
    expect(sessionBranch).toContain('restore()');
    // Fuzzy re-fetch must not live inside the session_expired branch.
    expect(sessionBranch).not.toContain("apiJson('/ui/api/identities')");
  });

  // F107: an indirect close (background action) must still restore the tier
  // select; the confirmed success path must not restore.
  test('tier-3 dialog restores on indirect close but not after confirm (F107)', () => {
    const closeAll = UI_JS.slice(
      UI_JS.indexOf('function closeAllModals('),
      UI_JS.indexOf('function showTokenModal('),
    );
    // Pending cancel side-effect is consumed exactly once on any close.
    expect(closeAll).toContain('var onCancel = confirmModalOnCancel;');
    expect(closeAll.indexOf('var onCancel = confirmModalOnCancel;')).toBeLessThan(
      closeAll.indexOf('confirmModalOnCancel = null;'),
    );
    expect(closeAll.indexOf('confirmModalOnCancel = null;')).toBeLessThan(
      closeAll.indexOf('if (onCancel) onCancel();'),
    );
    const handleTier = UI_JS.slice(
      UI_JS.indexOf('function handlePushTierChange('),
      UI_JS.indexOf('function formatDate('),
    );
    // Success path clears the restore hook before closing so a confirmed tier 3 sticks.
    const applyIdx = handleTier.indexOf('await apply(3, true);');
    const clearIdx = handleTier.indexOf('confirmModalOnCancel = null;');
    const closeIdx = handleTier.indexOf('closeAllModals();', applyIdx);
    expect(applyIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeGreaterThan(applyIdx);
    expect(closeIdx).toBeGreaterThan(clearIdx);
  });

  // #26 PR 5：Configure 闭环静态契约（token 仪式 / 人话卡 / 自托管空态 / 债项）
  test('Configure identities uses a single honest token slot and a one-time ceremony', () => {
    const renderCfg = UI_JS.slice(
      UI_JS.indexOf('function renderConfigureIdentities('),
      UI_JS.indexOf('function enterConfigureIdentities('),
    );
    expect(renderCfg).toContain("'Key: set'");
    expect(renderCfg).toContain("'Key: missing'");
    expect(UI_JS).toContain('No connected apps.');
    expect(UI_JS).toContain('Could not load connected apps.');
    expect(UI_JS).not.toContain('authorized clients');
    expect(renderCfg).toContain('if (isAdmin())');
    expect(renderCfg).toContain("rotate.textContent = 'Rotate'");
    expect(renderCfg).toContain("del.textContent = 'Delete'");
    expect(renderCfg).not.toContain('identity.token');
    expect(UI_JS).toContain('showTokenModal(payload.token');
    expect(UI_JS).toContain("showTokenModal(payload.token, 'Rotated Token')");
    expect(UI_HTML).toContain('Copy this token now. It will not be shown again.');
    expect(UI_JS).toContain('isConfigureScope(state.scope)');
    expect(UI_JS).not.toContain("indexOf('configure-')");
  });

  test('Configure push renders three human-language tier cards and server-enforced tier 3 confirm', () => {
    expect(UI_JS).toContain("title: 'Notify only'");
    expect(UI_JS).toContain("summary: 'Just tell me a message arrived.'");
    expect(UI_JS).toContain("title: 'Sender & subject'");
    expect(UI_JS).toContain("title: 'Body & OTP'");
    expect(UI_JS).toContain('function handleConfigurePushTier(');
    const configurePush = UI_JS.slice(
      UI_JS.indexOf('function handleConfigurePushTier('),
      UI_JS.indexOf('function renderConfigurePush('),
    );
    expect(configurePush).toContain('await apply(3, true, openedGen)');
    expect(configurePush).toContain('confirm_risk_required');
    expect(configurePush).toContain('await recoverPushTier(address)');
    expect(configurePush).toContain("if (state.scope === 'overview') renderOverview()");
    const catchStart = configurePush.indexOf('} catch (error) {');
    const finallyStart = configurePush.indexOf('} finally {', catchStart);
    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(finallyStart).toBeGreaterThan(catchStart);
    const catchBody = configurePush.slice(catchStart, finallyStart);
    const fuzzyStart = catchBody.indexOf('// Fuzzy failure');
    expect(fuzzyStart).toBeGreaterThanOrEqual(0);
    const fuzzyBranch = catchBody.slice(fuzzyStart);
    expect(fuzzyBranch).toContain('await recoverPushTier(address)');
    expect(fuzzyBranch).toContain("if (recovered.status === 'stale') return");
    expect(fuzzyBranch).not.toContain("apiJson('/ui/api/identities')");
    const confirmIdx = catchBody.indexOf("error.body.error === 'confirm_risk_required'");
    const sessionIdx = catchBody.indexOf("error.message === 'session_expired'");
    expect(confirmIdx).toBeGreaterThanOrEqual(0);
    expect(sessionIdx).toBeGreaterThan(confirmIdx);
    expect(catchBody.slice(confirmIdx, sessionIdx)).not.toContain('recoverPushTier');
    expect(catchBody.slice(sessionIdx, fuzzyStart)).not.toContain('recoverPushTier');
    const finallyBody = configurePush.slice(finallyStart);
    expect(finallyBody).toContain("delete state.tierPending[address]");
    expect(finallyBody).toContain("if (state.scope === 'overview') renderOverview()");
    expect(UI_HTML).toContain('id="configure-push-cards"');
    expect(UI_HTML).toContain('id="configure-push-devices"');
    expect(UI_HTML).toContain('id="configure-push-add"');
    expect(UI_HTML).toContain('id="device-add-modal"');
    expect(UI_HTML).toContain('id="device-pair-modal"');
    expect(UI_JS).not.toContain("'Device pairing is not in this release'");
    expect(UI_JS).toContain("apiJson('/ui/api/notify/devices'");
    expect(UI_JS).toContain('function renderPairedDevices(');
    expect(UI_JS).toContain('function showDevicePairModal(');
    expect(UI_JS).toContain('function handleRevokeDevice(');
    expect(UI_JS).toContain(
      "'Restore ntfy admin access before revoking. The phone may still receive notifications.'",
    );
    expect(UI_JS).toContain('topicSemantics');
    expect(UI_JS).toContain('User alerts');
    expect(UI_JS).toContain('Paired ');
    expect(UI_HTML).toContain('Copy this password now. It will not be shown again.');
    expect(UI_JS).toContain('devicePairPassword.textContent = ');
    expect(UI_JS).toContain("devicePairPassword.textContent = ''");
    const renderPush = UI_JS.slice(
      UI_JS.indexOf('function renderConfigurePush('),
      UI_JS.indexOf('function enterConfigurePush('),
    );
    expect(renderPush).toContain("role', 'radiogroup'");
    expect(renderPush).toContain("role', 'radio'");
    expect(renderPush).toContain('aria-checked');
    expect(renderPush).not.toContain('aria-pressed');
    expect(renderPush).toContain('Current push content:');
    expect(renderPush).toContain("aria-disabled', 'true'");
  });

  test('Plan & Domains are honest empty states with no fake upgrade or quota controls', () => {
    expect(UI_HTML).not.toContain('Upgrade');
    expect(UI_JS).not.toContain("'Upgrade'");
    expect(UI_JS).not.toContain('Upgrade plan');
    expect(UI_JS).toContain("'Self-hosted instance'");
    expect(UI_JS).toContain("docsLabel: 'Read the self-hosted API docs'");
    expect(UI_JS).toContain("docsHref: 'https://openagent.email/docs/reference/api/'");
    expect(UI_JS).toContain("'Custom domains are on the roadmap'");
    expect(UI_JS).toContain('this page has no controls to click.');
    expect(UI_CSS).toContain('.empty-state-docs');
  });

  test('PR1 P2 stubs are filled: app-nav and modal live in their component modules', async () => {
    const { APP_NAV_JS } = await import('../src/ui/client/components/app-nav.ts');
    const { MODAL_JS } = await import('../src/ui/client/components/modal.ts');
    expect(APP_NAV_JS).toContain('function closeNavDrawer(');
    expect(APP_NAV_JS).toContain('function openNavDrawer(');
    expect(APP_NAV_JS).toContain('function renderAppNav(');
    expect(MODAL_JS).toContain('function closeAllModals(');
    expect(MODAL_JS).toContain('function showTokenModal(');
    expect(MODAL_JS).toContain('function showCreateModal(');
    const { ROUTER_JS } = await import('../src/ui/client/router.ts');
    const { API_JS } = await import('../src/ui/client/api.ts');
    expect(ROUTER_JS).not.toContain('function closeNavDrawer(');
    expect(API_JS).not.toContain('function closeAllModals(');
    expect(API_JS).not.toContain('var confirmModalOnCancel');
  });

  test('applyRoute closes modals so Back cannot leave a token ceremony on the next page', async () => {
    const { ROUTER_JS } = await import('../src/ui/client/router.ts');
    const applyRoute = ROUTER_JS.slice(
      ROUTER_JS.indexOf('async function applyRoute('),
      ROUTER_JS.indexOf('function navigateTo('),
    );
    expect(applyRoute.indexOf('closeNavDrawer();')).toBeGreaterThanOrEqual(0);
    expect(applyRoute.indexOf('closeAllModals();')).toBeGreaterThan(
      applyRoute.indexOf('closeNavDrawer();'),
    );
  });

  test('nav drawer restore focus to the toggle and Escape uses closeNavDrawer', async () => {
    const { APP_NAV_JS } = await import('../src/ui/client/components/app-nav.ts');
    expect(APP_NAV_JS).toContain("var wasOpen = inboxView.getAttribute('data-nav-open') === 'true'");
    expect(APP_NAV_JS).toContain('if (wasOpen) navToggle.focus()');
    expect(APP_NAV_JS).toContain("event.key !== 'Escape'");
    expect(APP_NAV_JS).toContain('closeNavDrawer()');
  });

  test('modals record the opener and restore it through closeAllModals', async () => {
    const { MODAL_JS } = await import('../src/ui/client/components/modal.ts');
    expect(MODAL_JS).toContain('var modalOpener = null');
    expect(MODAL_JS).toContain('var confirmModalOnCancel = null');
    expect(MODAL_JS).toContain('function beginModal(');
    const closeAll = MODAL_JS.slice(
      MODAL_JS.indexOf('function closeAllModals('),
      MODAL_JS.indexOf('function beginModal('),
    );
    expect(closeAll).toContain('var opener = modalOpener');
    expect(closeAll).toContain('opener.isConnected');
    expect(closeAll).toContain('opener.focus()');
    expect(closeAll).toContain('opts.skipFocus');
    expect(MODAL_JS).toContain('function elementInsideModal(');
    expect(MODAL_JS).toContain("node.closest('#create-modal')");
    expect(MODAL_JS).toContain('closeAllModals({ skipFocus: true, keepGeneration: true })');
    expect(MODAL_JS).toContain('var modalGeneration = 0');
    expect(MODAL_JS).toContain('if (!opts.keepGeneration) modalGeneration += 1');
    expect(MODAL_JS).toContain('modalGeneration += 1');
    expect(MODAL_JS).toContain('confirmModalConfirm.disabled = false');
    expect(MODAL_JS).toContain('confirmModalCancel.disabled = false');
    expect(MODAL_JS).toContain('createModalSubmit.disabled = false');
    expect(MODAL_JS).toContain('deviceAddSubmit.disabled = false');
    expect(MODAL_JS).toContain("node.closest('#device-pair-modal')");
    expect(MODAL_JS).toContain('return modalGeneration');
    expect(MODAL_JS).toContain('modalOpener = previous');
    expect(MODAL_JS).toContain('lostFocus && previous');
    expect(MODAL_JS.indexOf('function showTokenModal(')).toBeGreaterThan(
      MODAL_JS.indexOf('function beginModal('),
    );
    const showToken = MODAL_JS.slice(
      MODAL_JS.indexOf('function showTokenModal('),
      MODAL_JS.indexOf('function showCreateModal('),
    );
    expect(showToken).toContain('beginModal();');
    expect(showToken).not.toContain('closeAllModals();');
    const showCreate = MODAL_JS.slice(
      MODAL_JS.indexOf('function showCreateModal('),
    );
    expect(showCreate).toContain('beginModal();');
    expect(MODAL_JS).toContain("event.key !== 'Escape'");
    expect(MODAL_JS).toContain('closeAllModals();');
    expect(UI_JS).toContain('tokenModalClose.addEventListener(\'click\', closeAllModals)');
    expect(UI_JS).toContain('createModalCancel.addEventListener(\'click\', closeAllModals)');
  });

  test('allowedDocsHref permits http(s) and slash-relative hrefs and rejects the rest', async () => {
    const { EMPTY_STATE_JS } = await import('../src/ui/client/components/empty-state.ts');
    expect(EMPTY_STATE_JS).toContain('function allowedDocsHref(');
    expect(EMPTY_STATE_JS).toContain('parsedRel.origin !== window.location.origin');
    expect(EMPTY_STATE_JS).toContain('rel.charAt(1) === \'/\'');
    expect(EMPTY_STATE_JS).toContain("lowered.indexOf('vbscript:') === 0");
    expect(EMPTY_STATE_JS).toContain("lowered.indexOf('data' + ':') === 0");
    expect(EMPTY_STATE_JS).not.toMatch(/\bhttps?:\/\//);
    const allowed = new Function(`
      var window = { location: { href: 'http://localhost/ui/plan', origin: 'http://localhost' } };
      ${EMPTY_STATE_JS}
      return allowedDocsHref;
    `)() as (href: string) => string;
    expect(allowed('https://openagent.email/docs/reference/api/')).toBe(
      'https://openagent.email/docs/reference/api/',
    );
    expect(allowed('http://example.com/docs')).toBe('http://example.com/docs');
    expect(allowed('/docs/local')).toBe('/docs/local');
    expect(allowed('//evil.example/phish')).toBe('');
    expect(allowed('/\\evil.example')).toBe('');
    expect(allowed('/\\\\evil.example')).toBe('');
    expect(allowed('/foo/../\\evil.example')).toBe('');
    expect(allowed('javascript:alert(1)')).toBe('');
    expect(allowed('vbscript:alert(1)')).toBe('');
    expect(allowed('data:text/html,hi')).toBe('');
    expect(allowed('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(allowed('DATA:text/html,hi')).toBe('');
    expect(allowed('')).toBe('');
  });

  test('delete-identity stay-on-configure uses an explicit scope enum', async () => {
    const { API_JS } = await import('../src/ui/client/api.ts');
    const { IDENTITIES_PAGE_JS } = await import('../src/ui/client/pages/identities.ts');
    expect(IDENTITIES_PAGE_JS).toContain('function isConfigureScope(');
    expect(IDENTITIES_PAGE_JS).toContain("scope === 'configure-identities'");
    expect(IDENTITIES_PAGE_JS).toContain("scope === 'configure-push'");
    expect(IDENTITIES_PAGE_JS).toContain("scope === 'configure-clients'");
    expect(IDENTITIES_PAGE_JS).toContain("scope === 'configure-domains'");
    expect(IDENTITIES_PAGE_JS).toContain("scope === 'plan'");
    expect(API_JS).toContain('isConfigureScope(state.scope)');
    expect(API_JS).not.toContain("indexOf('configure-')");
    expect(UI_JS).not.toContain("indexOf('configure-')");
  });

  test('stale modal responses do not close a newer dialog', async () => {
    const { API_JS } = await import('../src/ui/client/api.ts');
    const { AUTHORIZED_CLIENTS_PAGE_JS } = await import(
      '../src/ui/client/pages/authorized-clients.ts'
    );
    const { TASKS_PAGE_JS } = await import('../src/ui/client/pages/tasks.ts');
    const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');
    for (const src of [API_JS, AUTHORIZED_CLIENTS_PAGE_JS, TASKS_PAGE_JS, PUSH_DEVICES_PAGE_JS]) {
      expect(src).toContain('var openedGen =');
      expect(src).toContain('openedGen !== modalGeneration');
    }
    const del = API_JS.slice(
      API_JS.indexOf('function handleDeleteIdentity('),
      API_JS.indexOf('function bumpIdentityEpoch('),
    );
    expect(del.indexOf('openedGen !== modalGeneration')).toBeLessThan(del.indexOf('closeAllModals();'));
    expect(del).toContain('state.activeAddress === address');
    expect(del).toContain("state.activeAddress = ''");
    expect(del).toContain('clearDetail()');
    expect(del).toContain('renderMessages()');
    const create = API_JS.slice(
      API_JS.indexOf('async function handleCreateSubmit('),
      API_JS.indexOf('async function handleRotateToken('),
    );
    expect(create.indexOf('openedGen !== modalGeneration')).toBeLessThan(
      create.indexOf('showTokenModal(payload.token)'),
    );
    const rotate = API_JS.slice(
      API_JS.indexOf('async function handleRotateToken('),
      API_JS.indexOf('function handleDeleteIdentity('),
    );
    expect(rotate.indexOf('openedGen !== modalGeneration')).toBeLessThan(
      rotate.indexOf("showTokenModal(payload.token, 'Rotated Token')"),
    );
    const configurePush = PUSH_DEVICES_PAGE_JS.slice(
      PUSH_DEVICES_PAGE_JS.indexOf('function handleConfigurePushTier('),
      PUSH_DEVICES_PAGE_JS.indexOf('function renderConfigurePush('),
    );
    expect(configurePush).toContain('await apply(3, true, openedGen)');
    expect(configurePush).toContain('closeAllModals({ skipFocus: true })');
    const closeIdx = configurePush.indexOf('closeAllModals({ skipFocus: true })');
    const renderIdx = configurePush.indexOf('renderConfigurePush();', closeIdx);
    expect(renderIdx).toBeGreaterThan(closeIdx);
    expect(configurePush).toContain("querySelector('.push-tier-card.is-selected')");
    // P1 R4：finally 仅当前代际才复位；新窗由 beginModal 统一拉回可点。
    for (const src of [API_JS, AUTHORIZED_CLIENTS_PAGE_JS, TASKS_PAGE_JS, PUSH_DEVICES_PAGE_JS]) {
      expect(src).toContain('if (openedGen === modalGeneration)');
    }
    const { MODAL_JS } = await import('../src/ui/client/components/modal.ts');
    const beginModal = MODAL_JS.slice(
      MODAL_JS.indexOf('function beginModal('),
      MODAL_JS.indexOf('function showTokenModal('),
    );
    expect(beginModal).toContain('confirmModalConfirm.disabled = false');
    expect(beginModal).toContain('confirmModalCancel.disabled = false');
    expect(beginModal).toContain('createModalSubmit.disabled = false');
    expect(beginModal).toContain('deviceAddSubmit.disabled = false');
  });

  test('identity session CSS hides admin-only create controls', () => {
    expect(UI_CSS).toContain(
      '.inbox-view[data-session="identity"] #configure-identities-create',
    );
    expect(UI_CSS).toContain('#configure-push-add { display: none; }');
    expect(UI_JS).toContain('configureIdentitiesCreate.hidden = !isAdmin()');
  });

  // §7.6：复制成功态只是附加信号，失败降级路径逐字不动
  test('a successful copy adds a transient class without replacing the announcement', () => {
    expect(UI_JS).toContain("announce('Copied to clipboard');");
    expect(UI_JS).toContain("sourceButton.classList.add('copied');");
    expect(UI_JS).toContain("sourceButton.classList.remove('copied');");
    expect(UI_JS).toContain('}, 1200);');
    expect(UI_CSS).toContain('.copied { border-color: var(--green); color: var(--green); }');
  });

  test('pairing QR canvas paints a 4-module quiet zone', async () => {
    const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');
    expect(PUSH_DEVICES_PAGE_JS).toContain('var quiet = 4;');
    expect(PUSH_DEVICES_PAGE_JS).toContain('canvas.width = (size + quiet * 2) * scale;');
    expect(PUSH_DEVICES_PAGE_JS).toContain('canvas.height = (size + quiet * 2) * scale;');
    expect(PUSH_DEVICES_PAGE_JS).toContain(
      'ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);',
    );
  });

  test('recoverPushTier is the shared fuzzy-failure helper for Overview and Configure', async () => {
    const { API_JS } = await import('../src/ui/client/api.ts');
    const helper = API_JS.slice(
      API_JS.indexOf('async function recoverPushTier('),
      API_JS.indexOf('async function savePushContentTier('),
    );
    expect(helper.indexOf('bumpIdentityEpoch()')).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf('bumpIdentityEpoch()')).toBeLessThan(
      helper.indexOf("apiJson('/ui/api/identities')"),
    );
    expect(helper).toContain('var recoveryGen = state.overviewGen;');
    expect(helper).toContain("if (recoveryGen !== state.overviewGen) return { status: 'stale' }");
    expect(helper).toContain("(refreshed).");
    expect(UI_JS.indexOf('function handlePushTierChange(')).toBeGreaterThan(
      UI_JS.indexOf('async function recoverPushTier('),
    );
    expect(UI_JS.indexOf('function handleConfigurePushTier(')).toBeGreaterThan(
      UI_JS.indexOf('async function recoverPushTier('),
    );
  });

  test('revoke transient failure immediately reloads paired devices', async () => {
    const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');
    const revoke = PUSH_DEVICES_PAGE_JS.slice(
      PUSH_DEVICES_PAGE_JS.indexOf('function handleRevokeDevice('),
      PUSH_DEVICES_PAGE_JS.indexOf('function renderPairedDevices('),
    );
    const catchStart = revoke.indexOf('} catch (error) {');
    const finallyStart = revoke.indexOf('} finally {', catchStart);
    const catchBody = revoke.slice(catchStart, finallyStart);
    expect(catchBody).toContain('loadPairedDevices()');
    expect(catchBody.indexOf("error.message === 'session_expired'")).toBeLessThan(
      catchBody.indexOf('loadPairedDevices()'),
    );
  });

  test('loadPairedDevices guards writes with deviceLoadGen and logout bumps it', async () => {
    const { STORE_JS } = await import('../src/ui/client/store.ts');
    const { API_JS } = await import('../src/ui/client/api.ts');
    const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');
    expect(STORE_JS).toContain('deviceLoadGen: 0');
    const clear = API_JS.slice(
      API_JS.indexOf('function clearNotifyState('),
      API_JS.indexOf('function clearTasksState('),
    );
    expect(clear).toContain('state.devices = []');
    expect(clear.indexOf('state.devices = []')).toBeLessThan(clear.indexOf('state.deviceLoadGen += 1'));
    const load = PUSH_DEVICES_PAGE_JS.slice(
      PUSH_DEVICES_PAGE_JS.indexOf('async function loadPairedDevices('),
      PUSH_DEVICES_PAGE_JS.indexOf('function enterConfigurePush('),
    );
    expect(load).toContain('var generation = ++state.deviceLoadGen');
    expect(load.split('generation !== state.deviceLoadGen').length - 1).toBe(3);
    const tryIdx = load.indexOf('var payload = await apiJson');
    expect(load.indexOf('if (generation !== state.deviceLoadGen) return;', tryIdx)).toBeGreaterThan(tryIdx);
    expect(load.indexOf('if (generation !== state.deviceLoadGen) return;', tryIdx)).toBeLessThan(
      load.indexOf('state.devices = Array.isArray(payload.devices)', tryIdx),
    );
  });

  test('1280 detail subject wraps as a row, not per-character vertical CJK', () => {
    expect(UI_CSS).toContain('@media (max-width: 1440px)');
    expect(UI_CSS).toContain('@media (max-width: 1100px)');
    expect(UI_CSS).toContain('minmax(12em, 1fr) minmax(0, 240px)');
    expect(UI_CSS).toContain('.detail-header h2 { margin: 5px 0 18px; font-size: clamp(24px, 4vw, 34px); line-height: 1.18; overflow-wrap: break-word; word-break: normal; min-width: 0; }');
    expect(UI_CSS).toContain('.meta { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 5px 14px; margin: 0 0 22px; }');
    expect(UI_CSS).toContain('.folder-nav-title');
    expect(UI_CSS).toContain('color: var(--ink-dim);');
    expect(UI_CSS).toContain('.identity-panel > nav[aria-label="Inbox addresses"]');
  });

  test('task RESULT prefers a key-value table for plain objects', () => {
    expect(UI_JS).toContain('function renderTaskResultNode(');
    expect(UI_JS).toContain("table.className = 'task-result-table'");
    expect(UI_JS).toContain('RESULT 形态：普通对象走键值表');
  });
});
