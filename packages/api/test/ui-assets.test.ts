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

  test('clipboard fallback selects the visible source for manual copying', () => {
    expect(UI_JS).toContain('function selectForManualCopy(sourceNode)');
    expect(UI_JS).toContain('range.selectNodeContents(sourceNode)');
    expect(UI_JS).toContain('selection.addRange(range)');
    expect(UI_JS).toContain('return selection.toString() === sourceNode.textContent');
  });

  test('unknown UI paths are 404 and UI_ENABLED=false removes the whole surface', async () => {
    expect((await app.request('/ui/unknown')).status).toBe(404);

    const disabled = createApp({ uiEnabled: false });
    for (const path of [
      '/ui',
      '/ui/',
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
    ]) {
      expect(UI_HTML).toContain(`id="${id}"`);
    }
  });

  // A15：landmark 挂在包住两个面板的 inbox 容器上，移动 list 态才有可见 <main>
  test('exactly three mains exist and #main-content wraps the message and detail panels', () => {
    expect(UI_HTML).toContain('<main id="overview-panel" class="overview-panel" tabindex="-1"');
    expect(UI_HTML).toMatch(/<main id="overview-panel"[^>]*\shidden>/);
    expect(UI_HTML).toContain('<main id="main-content" class="inbox-main" tabindex="-1">');
    expect(UI_HTML).toContain('<section id="detail-panel" class="detail-panel" tabindex="-1">');

    const container = UI_HTML.indexOf('id="main-content"');
    const list = UI_HTML.indexOf('id="message-panel"');
    const detail = UI_HTML.indexOf('id="detail-panel"');
    expect(container).toBeGreaterThan(-1);
    expect(container).toBeLessThan(list);
    expect(list).toBeLessThan(detail);
    // #message-panel / #detail-panel 自身不带 hidden：scope 只切两个 <main>
    expect(UI_HTML).not.toMatch(/<section id="(message|detail)-panel"[^>]*\shidden/);

    expect(UI_HTML.split('<main').length - 1).toBe(3);
  });

  // A16 / A17
  test('scope changes move the hidden attribute, never the landmark id', () => {
    expect(UI_JS).toContain('function applyScope(');
    const applyScope = UI_JS.slice(
      UI_JS.indexOf('function applyScope('),
      UI_JS.indexOf('function filteredIdentities('),
    );
    expect(applyScope).toContain('overviewPanel.hidden = !overviewActive;');
    expect(applyScope).toContain('mainContent.hidden = overviewActive;');
    expect(applyScope).toContain("skipLink.textContent = overviewActive ? 'Skip to overview' : 'Skip to inbox';");
    expect(applyScope).toContain("skipLink.setAttribute('href', overviewActive ? '#overview-panel' : '#main-content');");
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

  // F2 / §1.3 / §1.4：侧栏地址与移动 selector 是 Overview 之外的两条入口
  test('the sidebar address and the mobile selector both reach the inbox from the overview', () => {
    // 唯一的移动 selector 必须挂在两个 <main> 之外，否则 scope=overview 会把它一起藏掉
    const layout = UI_HTML.indexOf('<div class="inbox-layout">');
    const selector = UI_HTML.indexOf('id="mobile-identity-select"');
    const overviewMain = UI_HTML.indexOf('<main id="overview-panel"');
    const inboxMain = UI_HTML.indexOf('<main id="main-content"');
    expect(UI_HTML.split('id="mobile-identity-select"').length - 1).toBe(1);
    expect(selector).toBeGreaterThan(layout);
    expect(selector).toBeLessThan(overviewMain);
    expect(selector).toBeLessThan(inboxMain);
    expect(UI_HTML).toContain('<label for="mobile-identity-select">Address</label>');
    // 移动端只有 .inbox-layout 展开成 block，所以这层包装在两个 scope 都可见
    expect(UI_CSS).toContain('.mobile-back, .mobile-identity { display: none; }');
    expect(UI_CSS).toContain('.mobile-identity { display: grid;');

    // 两条入口在 overview scope 下都走 openAddress（它才会切 scope、播报、聚焦）
    expect(UI_JS).toContain('function activateAddress(address) {');
    const activate = UI_JS.slice(
      UI_JS.indexOf('function activateAddress(address) {'),
      UI_JS.indexOf('function filteredIdentities('),
    );
    expect(activate).toContain("if (state.scope === 'overview') {");
    expect(activate).toContain('openAddress(address);');
    expect(activate).toContain('selectIdentity(address);');
    expect(UI_JS).toContain('activateAddress(identity.address);');
    expect(UI_JS).toContain('activateAddress(mobileIdentity.value);');
    // 侧栏/选择器不许再直接调 selectIdentity（那样画面会停在 Overview）
    expect(UI_JS).not.toContain('selectIdentity(identity.address);');
    expect(UI_JS).not.toContain('selectIdentity(mobileIdentity.value);');
  });

  // N1 / §1.4：落焦 Overview 面板不许滚动首屏，聚焦返回行的那条路径照旧滚动
  test('landing on the overview keeps the first screen while a return row still scrolls', () => {
    expect(UI_JS).toContain('overviewPanel.focus({ preventScroll: true });');
    // 面板落焦只有这一个入口，别处不许再裸调 overviewPanel.focus()
    expect(UI_JS).not.toContain('overviewPanel.focus();');
    expect(UI_JS.split('overviewPanel.focus(').length - 1).toBe(1);

    const enter = UI_JS.slice(
      UI_JS.indexOf('function enterOverview('),
      UI_JS.indexOf('function openAddress('),
    );
    expect(enter).toContain('var returnRow = opts.returnTo ? rowButtonFor(opts.returnTo) : null;');
    // 返回行照常 focus()（要滚到那一行）；没有返回行才走不滚动的面板落焦
    expect(enter).toContain('if (returnRow) returnRow.focus();');
    expect(enter).toContain('else focusOverviewPanel();');
    expect(enter).not.toContain('preventScroll');

    // admin 登录落地也走同一个不滚动的入口
    const startSession = UI_JS.slice(
      UI_JS.indexOf('async function startSession('),
      UI_JS.indexOf("loginForm.addEventListener('submit'"),
    );
    expect(startSession).toContain('focusOverviewPanel();');
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

  // F6 / §6 行 19：活动地址消失 → 回 Overview 并播报
  test('a deleted active address migrates the inbox back to the overview', () => {
    const reconcile = UI_JS.slice(
      UI_JS.indexOf('function reconcileActiveAddress() {'),
      UI_JS.indexOf('function refreshInboxIdentities() {'),
    );
    expect(reconcile).toContain('if (!state.activeAddress) return;');
    expect(reconcile).toContain("state.activeAddress = '';");
    expect(reconcile).toContain("if (state.scope !== 'inbox') return;");
    expect(reconcile).toContain("announce: lost + ' is no longer available. Back to overview.'");
    // 两个触发点：Overview 周期的 /identities，以及 inbox 里 admin 的手动 Refresh
    expect(UI_JS).toContain('      reconcileActiveAddress();');
    expect(UI_JS).toContain('if (isAdmin()) refreshInboxIdentities();');
    expect(UI_JS.split('reconcileActiveAddress();').length - 1).toBe(2);
    // Inbox identity refresh shares overviewGen so a late response cannot
    // clobber a push-tier save that bumped the epoch mid-flight.
    const inboxRefresh = UI_JS.slice(
      UI_JS.indexOf('function refreshInboxIdentities() {'),
      UI_JS.indexOf('function loadOverviewCycle('),
    );
    expect(inboxRefresh).toContain('var generation = state.overviewGen;');
    expect(inboxRefresh).toContain('if (generation !== state.overviewGen) return;');
  });

  // A18 / A19 / A20 / A21
  test('the three assets stay free of parser sinks and remote references', () => {
    for (const asset of [UI_HTML, UI_CSS, UI_JS]) {
      expect(asset).not.toMatch(
        /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\s*\(|new\s+Function\b|createElementNS/,
      );
      expect(asset).not.toMatch(/\bhttps?:\/\//);
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
    expect(UI_JS).toContain("'/ui/api/overview?refresh=1'");
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
    expect(UI_CSS).toContain('[data-scope="overview"]');
    expect(UI_CSS).toContain('[data-mobile-view="overview"]');
    expect(flat).toContain('.inbox-layout { min-height: calc(100vh - 74px); display: grid; grid-template-columns: 240px minmax(0, 1fr); }');
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

  // §5.7：截断影响到的行只给下界，绝不显示 0 msgs
  test('truncated rows render a bound or Unknown, never a zero', () => {
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
    // "(no mail in the current window)" 只挂在 complete 且真为 0 的行上
    expect(UI_JS).toContain('if (row && row.complete && row.count === 0) {');
    expect(UI_JS).toContain(
      'Some counts are incomplete for messages with very large recipient lists (shown as ≥ or Unknown).',
    );
    expect(UI_JS).toContain("if (!scan || !scan.skipped) {");
  });

  // F3 / §2.4 / §10 条 1：exact:false 时总计卡片也是下界，不许摆出精确外观
  test('total cards fall back to the same lower-bound format as the rows', () => {
    const bound = UI_JS.slice(
      UI_JS.indexOf('function boundParts(value, exact) {'),
      UI_JS.indexOf('function appendCell('),
    );
    expect(bound).toContain('if (exact) return { text: formatNumber(value) };');
    expect(bound).toContain("text: '≥' + formatNumber(value)");
    expect(bound).toContain("text: 'Unknown'");
    expect(bound).toContain('Lower bound — this scan hit its recipient limit.');
    expect(bound).toContain('Not counted — this scan hit its recipient limit.');

    const stats = UI_JS.slice(
      UI_JS.indexOf('function renderOverviewStats() {'),
      UI_JS.indexOf('function renderOverviewMeta() {'),
    );
    expect(stats).toContain('var exact = !totals || totals.exact !== false;');
    expect(stats).toContain('windowed = boundParts(totals.matchedInWindow, exact);');
    expect(stats).toContain("card('Unseen', totals ? boundParts(totals.unseenInWindow, exact) : fallback);");
    expect(stats).toContain(
      "card('Active 24h', totals ? boundParts(totals.activeAddresses, exact) : fallback);",
    );
    // 三个下界字段都不许再无条件 formatNumber；地址数是身份派生量，仍然精确
    expect(stats).not.toContain('formatNumber(totals.matchedInWindow)');
    expect(stats).not.toContain('formatNumber(totals.unseenInWindow)');
    expect(stats).not.toContain('formatNumber(totals.activeAddresses)');
    expect(stats).toContain('formatNumber(totals.addresses)');
    // unmatchedInWindow 从来不进 DOM
    expect(UI_JS).not.toContain('unmatchedInWindow');
  });

  // §5.5：唯一轮询规则 + 15 次/20 s 上限
  test('polling follows the server retryAfterMs and gives up after the cap', () => {
    expect(UI_JS).toContain('var POLL_LIMIT = 15;');
    expect(UI_JS).toContain('var POLL_WINDOW_MS = 20000;');
    expect(UI_JS).toContain('var delay = Math.max(retryAfterMs || 1500, 1000);');
    expect(UI_JS).toContain('if (payload.revalidating || payload.refreshError) scheduleOverviewPoll(payload.retryAfterMs);');
    expect(UI_JS).toContain('Message counts are taking too long.');
    expect(UI_JS).toContain("'Retrying in ' + Math.ceil(payload.retryAfterMs / 1000) + 's…'");
    // 客户端唯一的新鲜度阈值
    expect(UI_JS).toContain('var FRESH_MS = 15000;');
    expect(UI_JS.split(/\b15000\b/).length - 1).toBe(1);
  });

  // §5.3：两条请求各自落地，地址骨架不被 /overview 拖住
  test('one overview cycle fires both requests under a shared generation guard', () => {
    const cycle = UI_JS.slice(
      UI_JS.indexOf('function loadOverviewCycle('),
      UI_JS.indexOf('function enterOverview('),
    );
    expect(cycle).not.toContain('await ');
    expect(cycle).not.toContain('Promise.all');
    expect(cycle).toContain('var generation = ++state.overviewGen;');
    expect(cycle).toContain('state.overviewCycleGen = generation;');
    expect(cycle.indexOf('identitiesPromise.then')).toBeLessThan(cycle.indexOf('overviewPromise.then'));
    expect(cycle.split('generation !== state.overviewGen').length - 1).toBe(4);
    expect(cycle).toContain('renderOverview();');
    // Stale overview responses clear stuck pending without writing data.
    expect(cycle).toContain('state.overviewCycleGen !== state.overviewGen');
    expect(cycle).toContain('state.overviewPending = false;');
    // Tier save / delete must bump the epoch so a late /identities cannot clobber them.
    expect(UI_JS).toContain('function bumpIdentityEpoch()');
    const saveTier = UI_JS.slice(
      UI_JS.indexOf('async function savePushContentTier('),
      UI_JS.indexOf('function handlePushTierChange('),
    );
    expect(saveTier).toContain('bumpIdentityEpoch()');
    // Tier save restarts the overview cycle so Refresh cannot stick on "Refreshing…".
    const handleTier = UI_JS.slice(
      UI_JS.indexOf('function handlePushTierChange('),
      UI_JS.indexOf('function formatDate('),
    );
    expect(handleTier).toContain("loadOverviewCycle({ refresh: false })");
    // Only restart while still on Overview (do not revive polling after openAddress).
    expect(handleTier).toContain("state.scope === 'overview'");
    // Tier-3 confirm disables Cancel while the PUT is in flight.
    expect(handleTier).toContain('confirmModalCancel.disabled = true;');
    expect(handleTier).toContain('confirmModalCancel.disabled = false;');
    // Per-address pending lock survives re-render so a second select cannot race.
    expect(UI_JS).toContain('tierPending: {}');
    expect(handleTier).toContain('state.tierPending[address] = true;');
    expect(handleTier).toContain('delete state.tierPending[address];');
    const renderRows = UI_JS.slice(
      UI_JS.indexOf('function renderOverviewRows('),
      UI_JS.indexOf('function updateOverviewRefreshButton('),
    );
    expect(renderRows).toContain('state.tierPending[model.identity.address]');
    expect(renderRows).toContain('tierSelect.disabled = true;');
    // F66: tier <select> is not nested under the row nav role=button.
    expect(renderRows).toContain("navNode.className = 'overview-row-nav'");
    expect(renderRows).toContain("navNode.setAttribute('role', 'button')");
    expect(renderRows).toContain("tierSelect.className = 'push-tier-select'");
    expect(renderRows.indexOf("rowNode.append(navNode)")).toBeLessThan(
      renderRows.indexOf('rowNode.append(tierCell)'),
    );
    expect(renderRows).toContain("'push tier ' + currentTier");
    // Row container is neutral (no role=button on overview-row itself).
    expect(renderRows).not.toContain("rowNode.setAttribute('role', 'button')");
    expect(renderRows).not.toContain('rowNode.tabIndex = 0');
    // Return-to-overview focus must land on the focusable nav, not the outer row.
    expect(UI_JS).toContain("querySelector('.overview-row-nav')");
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

    // Fuzzy path: re-fetch list, write select + dataset from server tier, announce refresh.
    expect(catchBody).toContain("apiJson('/ui/api/identities')");
    expect(catchBody).toContain('selectEl.value = String(authoritative)');
    expect(catchBody).toContain('selectEl.dataset.currentTier = String(authoritative)');
    expect(catchBody).toContain("(refreshed).");
    // F53: bump epoch before recovery re-fetch so stale overview identities cannot clobber.
    const fuzzyStart = catchBody.indexOf('// Fuzzy failure');
    expect(fuzzyStart).toBeGreaterThanOrEqual(0);
    const fuzzyBranch = catchBody.slice(fuzzyStart);
    expect(fuzzyBranch.indexOf('bumpIdentityEpoch()')).toBeGreaterThanOrEqual(0);
    expect(fuzzyBranch.indexOf('bumpIdentityEpoch()')).toBeLessThan(
      fuzzyBranch.indexOf("apiJson('/ui/api/identities')"),
    );
    expect(fuzzyBranch).toContain('var recoveryGen = state.overviewGen;');
    expect(fuzzyBranch).toContain('if (recoveryGen !== state.overviewGen) return;');

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

  // §7.6：复制成功态只是附加信号，失败降级路径逐字不动
  test('a successful copy adds a transient class without replacing the announcement', () => {
    expect(UI_JS).toContain("announce('Copied to clipboard');");
    expect(UI_JS).toContain("sourceButton.classList.add('copied');");
    expect(UI_JS).toContain("sourceButton.classList.remove('copied');");
    expect(UI_JS).toContain('}, 1200);');
    expect(UI_CSS).toContain('.copied { border-color: var(--green); color: var(--green); }');
  });
});
