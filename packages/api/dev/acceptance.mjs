// Development-only Chromium acceptance probe.
// Start dev/preview.ts first, then run:
// PREVIEW_BASE=http://127.0.0.1:4310 npx -y bun@1.2.21 run dev/acceptance.mjs
//
// Covers the email-isolation probes plus the Overview / R7 checks: landing scope,
// exactly one visible <main> in five states, tab order, skip link, drill-in and
// back, the five Overview fixtures (served by stubbing /ui/api/overview through
// CDP so one preview process is enough), brand geometry, and contrast measured
// from real computed styles.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.PREVIEW_BASE ?? 'http://127.0.0.1:4310';
const debugPort = Number(process.env.CHROME_DEBUG_PORT ?? 9334);
// 慢用例（15 次轮询放弃、20 s 冷却窗口）默认跑；PROBE_SLOW=0 可跳过。
const runSlow = process.env.PROBE_SLOW !== '0';
const candidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((candidate) => existsSync(candidate));
if (!chrome) throw new Error('Chromium executable not found; set CHROME_BIN');

const profile = mkdtempSync(join(tmpdir(), 'oae-ui-acceptance-'));
const shotDir = process.env.SHOT_DIR ?? mkdtempSync(join(tmpdir(), 'oae-ui-shots-'));
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(action, description) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`${description}: ${lastError?.message ?? 'timed out'}`);
}

let socket;
let nextId = 0;
const pending = new Map();
const violations = [];
const requestedExternalUrls = new Set();
const overviewRequests = [];
const messageRequests = [];

function record(kind, value) {
  violations.push(`${kind}: ${String(value).slice(0, 300)}`);
}

function check(condition, description) {
  if (!condition) record('assertion', description);
}

function isExpectedUnauthenticatedProbe(status, url) {
  return status === 401 && url.endsWith('/ui/api/me');
}

// fixture 拦截：null = 放行真实响应；否则用这个函数造响应。
let overviewStub = null;
let identitiesStub = null;

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `browser evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

async function waitFor(expression, description, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  // 超时时把当时的页面状态打出来，否则调 dev 探针只能靠猜。
  const state = await evaluate(`(() => ({
    url: location.href,
    login: document.querySelector('#login-view') ? document.querySelector('#login-view').hidden : null,
    loginError: (document.querySelector('#login-error') || {}).textContent,
    scope: (document.querySelector('#inbox-view') || { dataset: {} }).dataset.scope,
    rows: document.querySelectorAll('.overview-row').length,
    status: (document.querySelector('#status') || {}).textContent,
    notice: (document.querySelector('#overview-notice') || {}).textContent
  }))()`).catch(() => null);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(state)}`);
}

async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { captureBeyondViewport: false });
  const path = join(shotDir, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}

/* ---------------------------------------------------------------------------
 * 页面内共用探针。每次导航后重新注入。
 *  - tabOrder()  DOM 顺序 + 可见性过滤，近似浏览器顺序 tab 序（原生 CSS 没有
 *                "可聚焦"伪类，用伪类选择器会让 querySelectorAll 直接抛错）。
 *  - effectiveBg() 沿祖先链解析有效合成底色，再算 WCAG 对比度。
 * ------------------------------------------------------------------------- */
const PROBES = `(() => {
  const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
                   'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const tabOrder = () => [...document.querySelectorAll(TABBABLE)]
    .filter((el) => el.getClientRects().length > 0 &&
                    getComputedStyle(el).visibility !== 'hidden' &&
                    !el.closest('[hidden]'));

  const parse = (value) => {
    const parts = String(value).match(/[-\\d.]+/g) || [];
    const numbers = parts.map(Number);
    return [numbers[0] || 0, numbers[1] || 0, numbers[2] || 0,
            numbers.length > 3 ? numbers[3] : 1];
  };
  const composite = (layers) => {
    let [r, g, b] = [0, 0, 0];
    let filled = false;
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const [lr, lg, lb, la] = layers[index];
      if (!filled) { r = lr; g = lg; b = lb; filled = true; continue; }
      r = lr * la + r * (1 - la);
      g = lg * la + g * (1 - la);
      b = lb * la + b * (1 - la);
    }
    return [r, g, b];
  };
  function effectiveBg(el) {
    let node = el;
    const acc = [];
    while (node) {
      const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
      if (a > 0) acc.push([r, g, b, a]);
      if (a >= 1) return composite(acc);
      node = node.parentElement;
    }
    return composite([...acc, parse(getComputedStyle(document.documentElement).backgroundColor)]);
  }
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (fg, bg) => {
    const light = Math.max(luminance(fg), luminance(bg));
    const dark = Math.min(luminance(fg), luminance(bg));
    return (light + 0.05) / (dark + 0.05);
  };

  window.__oae = {
    tabOrder,
    ids: () => tabOrder().map((el) => el.id || el.className || el.tagName),
    parse,
    effectiveBg,
    contrast,
    // token 值可能写成 hex，必须让浏览器解析成 rgb 再比，否则拿 hex 里的数字算对比度
    // 会得出毫无意义的结论。
    token: (name) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(' + name + ')';
      probe.style.position = 'absolute';
      document.body.append(probe);
      const value = parse(getComputedStyle(probe).color);
      probe.remove();
      return value;
    },
    visibleMains: () => [...document.querySelectorAll('main')]
      .filter((main) => main.getClientRects().length > 0),
    visible: (selector) => {
      const el = document.querySelector(selector);
      return !!el && el.getClientRects().length > 0;
    },
    text: (selector) => (document.querySelector(selector) || {}).textContent || '',
  };
  return true;
})()`;

async function injectProbes() {
  await evaluate(PROBES);
}

async function login(token) {
  // 每次都从零开始：留着 cookie 会让页面直接进 Overview，登录表单根本不出现。
  // 先真正登出，否则每次换 fixture 都留一个活会话，5 个之后服务端就拒绝登录了。
  await evaluate(
    `fetch('/ui/api/session', { method: 'DELETE' }).then(() => true).catch(() => true)`,
  ).catch(() => {});
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url: `${base}/ui` });
  await waitFor(
    "document.readyState === 'complete' && !document.querySelector('#login-view').hidden",
    'login screen',
  );
  await injectProbes();
  await evaluate(`(() => {
    const input = document.querySelector('#login-token');
    input.value = ${JSON.stringify(token)};
    document.querySelector('#login-form').requestSubmit();
    return true;
  })()`);
}

/** 带着已有 cookie 重新加载：走 /ui/api/me 续期路径（A52）。 */
async function resume() {
  await send('Page.navigate', { url: `${base}/ui` });
  await waitFor("document.readyState === 'complete'", 'reloaded document');
  await injectProbes();
}

function overviewCount() {
  return overviewRequests.length;
}

// fixture 里只有这个地址有邮件，钻入相关的探针都点它。
const FOX_ROW_CLICK =
  "document.querySelector('.overview-row[data-address=\"fox@preview.test\"]').click()";

try {
  await retry(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (!response.ok) throw new Error(`debug endpoint returned ${response.status}`);
      return response.json();
    },
    'Chromium did not start',
  );

  const target = await retry(
    async () => {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${base}/ui`)}`,
        { method: 'PUT' },
      );
      if (!response.ok) throw new Error(`target endpoint returned ${response.status}`);
      return response.json();
    },
    'Chromium target could not be created',
  );

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }

    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const stub = request.url.includes('/ui/api/overview')
        ? overviewStub
        : request.url.includes('/ui/api/identities')
          ? identitiesStub
          : null;
      if (!stub) {
        void send('Fetch.continueRequest', { requestId });
        return;
      }
      void (async () => {
        const reply = await stub(request);
        await delay(reply.delayMs ?? 0);
        // 页面在这段延迟里可能已经导航掉了，那时 interceptionId 会失效 —— 忽略即可。
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: reply.status,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body: Buffer.from(JSON.stringify(reply.body)).toString('base64'),
        }).catch(() => {});
      })();
      return;
    }

    if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url;
      if (url.includes('/ui/api/overview')) overviewRequests.push(Date.now());
      if (url.includes('/ui/api/messages')) messageRequests.push(url);
      if (!url.startsWith(base) && !url.startsWith('data:') && !url.startsWith('http://0.0.0.0')) {
        requestedExternalUrls.add(url);
      }
      return;
    }

    if (message.method === 'Network.loadingFailed') {
      // 切换 scope 与换 fixture 时客户端会主动 abort 在途取数，那不是资源错误。
      if (message.params.errorText !== 'net::ERR_ABORTED') {
        record('Network.loadingFailed', message.params.errorText);
      }
    } else if (
      message.method === 'Network.responseReceived' &&
      message.params.response.status >= 400 &&
      // 失败态 fixture 故意返回 503/202；未登录探针返回 401。
      message.params.response.status !== 503 &&
      !isExpectedUnauthenticatedProbe(
        message.params.response.status,
        message.params.response.url,
      )
    ) {
      record(
        'Network.responseReceived',
        `${message.params.response.status} ${message.params.response.url}`,
      );
    } else if (
      message.method === 'Log.entryAdded' &&
      message.params.entry.level === 'error' &&
      !(
        message.params.entry.source === 'network' &&
        /^Failed to load resource: the server responded with a status of (401|503)\b/.test(
          message.params.entry.text,
        )
      ) &&
      // A67 故意走 http://0.0.0.0，Chrome 会为此抱怨 COOP/安全上下文 —— 那正是被测行为。
      !/Cross-Origin-Opener-Policy header has been ignored/.test(message.params.entry.text)
    ) {
      record('Log.entryAdded', message.params.entry.text);
    } else if (message.method === 'Page.javascriptDialogOpening') {
      record('Page.javascriptDialogOpening', message.params.message);
      void send('Page.handleJavaScriptDialog', { accept: false });
    } else if (message.method === 'Runtime.exceptionThrown') {
      record(
        'Runtime.exceptionThrown',
        message.params.exceptionDetails.text,
      );
    } else if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'assert') {
        record('Runtime.consoleAPICalled', type);
      }
    } else if (
      message.method === 'Page.frameNavigated' &&
      message.params.frame.parentId === undefined &&
      !message.params.frame.url.startsWith(base) &&
      !message.params.frame.url.startsWith('http://0.0.0.0')
    ) {
      record('Page.frameNavigated', message.params.frame.url);
    }
  });

  await Promise.all([
    send('Page.enable'),
    send('Runtime.enable'),
    send('Network.enable'),
    send('Log.enable'),
    send('Fetch.enable', {
      patterns: [
        { urlPattern: '*/ui/api/overview*', requestStage: 'Request' },
        { urlPattern: '*/ui/api/identities*', requestStage: 'Request' },
      ],
    }),
  ]);
  // headless 下剪贴板默认被拒，A68 需要成功路径与降级路径都能触发。
  await send('Browser.grantPermissions', {
    origin: base,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  }).catch(() => {});

  /* ============ A51 / A52：admin 落地 Inbox（ADR #26）；随后进入 Overview 跑面板用例 ============ */
  // 登录屏是 .fine-print 唯一出现的地方，A70① 的三个点名选择器要在这里各测一次。
  await send('Page.navigate', { url: `${base}/ui` });
  await waitFor(
    "document.readyState === 'complete' && !document.querySelector('#login-view').hidden",
    'login screen for the contrast pass',
  );
  await injectProbes();
  reviewContrast('login', await measureContrast(['.fine-print']));

  await login('preview-token');
  await waitFor(
    "!document.querySelector('#inbox-view').hidden && document.querySelector('#inbox-view').dataset.scope === 'inbox'",
    'inbox after login',
  );
  await injectProbes();

  // A51：落地就是 Inbox（含 admin）
  check(await evaluate("__oae.visible('#main-content')"), 'A51 inbox main is visible');
  check(
    !(await evaluate("__oae.visible('#overview-panel')")),
    'A51 overview panel is hidden on landing',
  );
  check(
    (await evaluate("document.querySelector('#inbox-view').dataset.scope")) === 'inbox',
    'A51 data-scope is inbox',
  );
  check(
    (await evaluate('__oae.visibleMains().length')) === 1 &&
      (await evaluate('__oae.visibleMains()[0].id')) === 'main-content',
    'A51 session lands on the inbox panel',
  );

  // A52：带 cookie 重新加载（/me 续期）同样落地 Inbox
  await resume();
  await waitFor(
    "document.querySelector('#login-view').hidden && document.querySelector('#inbox-view').dataset.scope === 'inbox'",
    'inbox after session renewal',
  );
  await injectProbes();
  check(
    (await evaluate('__oae.visibleMains().length')) === 1 &&
      (await evaluate('__oae.visibleMains()[0].id')) === 'main-content',
    'A52 session renewal lands on the inbox panel',
  );

  // 进入 Overview，后续 A56+ 面板用例复用原路径
  await evaluate("document.querySelector('[data-nav=\"overview\"]').click()");
  await waitFor(
    "!document.querySelector('#inbox-view').hidden && document.querySelectorAll('.overview-row').length > 0",
    'overview rows',
  );
  await injectProbes();

  // 真实 ready 载荷留作后面几个 fixture 的底稿（此刻还没装拦截桩）。
  const readyBody = await evaluate("fetch('/ui/api/overview').then((response) => response.json())");

  // A56①②：桌面 overview 恰好一个可见 main
  check(
    (await evaluate('__oae.visibleMains().length')) === 1 &&
      (await evaluate("__oae.visibleMains()[0].id")) === 'overview-panel',
    'A56 desktop overview has exactly one visible main (#overview-panel)',
  );

  // A57：tab 序按真实 DOM 顺序
  const order = await evaluate(`(() => {
    const nodes = __oae.tabOrder();
    const sorted = [...document.querySelectorAll('#overview-sort .sort-button')];
    const rows = [...document.querySelectorAll('.overview-row')];
    return {
      ids: nodes.map((el) => el.id || el.className),
      firstSortIndex: nodes.indexOf(sorted[0]),
      firstRowIndex: nodes.indexOf(rows[0]),
      searchIndex: nodes.indexOf(document.querySelector('#overview-search')),
      refreshIndex: nodes.indexOf(document.querySelector('#overview-refresh')),
      navIndex: nodes.indexOf(document.querySelector('.overview-nav')),
      identityIndex: nodes.indexOf(
        [...document.querySelectorAll('.identity-button')].filter(
          (el) => !el.classList.contains('overview-nav'),
        )[0],
      ),
      sidebarTotal: document.querySelectorAll('.identity-button').length,
      sidebarCount: [...document.querySelectorAll('.identity-button')].filter(
        (el) => el.getClientRects().length > 0,
      ).length,
      viewport: [window.innerWidth, window.innerHeight],
    };
  })()`);
  check(
    order.ids[0] === 'skip-link' &&
      order.ids[1] === 'logout-button' &&
      order.ids[2] === 'identity-search',
    `A57 tab order starts with skip link, sign out, identity search (saw ${order.ids.slice(0, 3).join(' → ')})`,
  );
  check(
    order.navIndex === 3 &&
      order.identityIndex === 4 &&
      order.refreshIndex > order.identityIndex &&
      order.searchIndex === order.refreshIndex + 1 &&
      order.firstSortIndex > order.searchIndex &&
      order.firstRowIndex > order.firstSortIndex,
    'A57 tab order continues nav → addresses → refresh → filter → sort → rows ' +
      `(nav ${order.navIndex}, address ${order.identityIndex}, refresh ${order.refreshIndex}, ` +
      `filter ${order.searchIndex}, sort ${order.firstSortIndex}, row ${order.firstRowIndex}; ` +
      `order: ${order.ids.slice(0, 8).join(' → ')}; sidebar ${order.sidebarCount}/${order.sidebarTotal})`,
  );

  // A58：skip link 文案/目标随 scope 变，激活后焦点真的落到 overview
  check(
    (await evaluate("__oae.text('#skip-link').trim()")) === 'Skip to overview' &&
      (await evaluate("document.querySelector('#skip-link').getAttribute('href')")) ===
        '#overview-panel',
    'A58 skip link points at the overview panel',
  );
  await evaluate("document.querySelector('#skip-link').click()");
  await delay(100);
  check(
    (await evaluate('document.activeElement.id')) === 'overview-panel',
    'A58 activating the skip link focuses #overview-panel',
  );

  // A66：R7 视觉
  const brand = await evaluate(`(() => {
    const topbarLogo = document.querySelector('.topbar-brand .brand-logo');
    const rect = topbarLogo.getBoundingClientRect();
    return {
      topbar: [Math.round(rect.width), Math.round(rect.height)],
      visible: topbarLogo.getClientRects().length > 0,
      brandMarks: document.querySelectorAll('[class*="brand-mark"]').length,
      wordmarks: [...document.querySelectorAll('#inbox-view .wordmark')]
        .filter((el) => el.textContent.trim() === 'OpenAgent.email').length,
      uses: document.querySelectorAll('use').length,
    };
  })()`);
  check(brand.visible, 'A66 topbar logo is visible');
  check(
    brand.topbar[0] === 24 && brand.topbar[1] === 24,
    `A66 topbar logo is 24x24 (saw ${brand.topbar.join('x')})`,
  );
  check(brand.brandMarks === 0, 'A66 no [class*="brand-mark"] survives');
  check(brand.wordmarks === 1, 'A66 topbar shows OpenAgent.email exactly once');
  const faviconStatus = await evaluate(
    `fetch('/ui/favicon.svg').then((response) => response.status)`,
  );
  check(faviconStatus === 200, `A66 /ui/favicon.svg is 200 (saw ${faviconStatus})`);
  const cspViolations = await evaluate(`(() => {
    if (window.__cspSeen === undefined) {
      window.__cspSeen = 0;
      document.addEventListener('securitypolicyviolation', () => { window.__cspSeen += 1; });
    }
    return window.__cspSeen;
  })()`);
  check(cspViolations === 0, 'A66 no securitypolicyviolation events');

  // A70：对比度按有效合成底色核。selectors 里的元素必须用 --ink-dim 且 ≥4.5:1。
  function measureContrast(selectors) {
    return evaluate(`(() => {
    const dim = __oae.token('--ink-dim');
    const faint = __oae.token('--ink-faint');
    const gold = __oae.token('--gold');
    const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
    const report = { dimMatches: [], dimRatios: [], smallFaint: [], controlRatios: [], goldRatio: null };
    for (const selector of ${JSON.stringify(selectors)}) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.getClientRects().length === 0) continue;
        const color = __oae.parse(getComputedStyle(el).color);
        report.dimMatches.push(same(color, dim));
        report.dimRatios.push(__oae.contrast(color, __oae.effectiveBg(el)));
      }
    }
    for (const el of document.querySelectorAll('body *')) {
      if (el.getClientRects().length === 0) continue;
      const style = getComputedStyle(el);
      if (parseFloat(style.fontSize) >= 14) continue;
      if (!el.textContent.trim()) continue;
      if (same(__oae.parse(style.color), faint)) report.smallFaint.push(el.className || el.tagName);
    }
    for (const el of document.querySelectorAll('input, select')) {
      if (el.getClientRects().length === 0) continue;
      report.controlRatios.push(
        __oae.contrast(__oae.parse(getComputedStyle(el).borderColor), __oae.effectiveBg(el)),
      );
    }
    const anchor = document.querySelector('input:not([hidden])');
    report.goldRatio = anchor ? __oae.contrast(gold, __oae.effectiveBg(anchor)) : null;
    return report;
  })()`);
  }
  function reviewContrast(label, report) {
    check(
      report.dimMatches.length > 0 && report.dimMatches.every(Boolean),
      `A70① ${label}: dim text uses the --ink-dim token`,
    );
    check(
      report.dimRatios.every((ratio) => ratio >= 4.5),
      `A70① ${label}: dim text keeps 4.5:1 (min ${Math.min(...report.dimRatios).toFixed(2)})`,
    );
    check(
      report.smallFaint.length === 0,
      `A70② ${label}: --ink-faint stays off <14px text (${report.smallFaint.join(',')})`,
    );
    check(
      report.controlRatios.every((ratio) => ratio >= 3),
      `A70③ ${label}: control borders keep 3:1 (min ${Math.min(...report.controlRatios).toFixed(2)})`,
    );
    check(
      report.goldRatio !== null && report.goldRatio >= 3,
      `A70④ ${label}: focus ring keeps 3:1 (${report.goldRatio})`,
    );
  }
  reviewContrast(
    'overview',
    await measureContrast(['.overview-updated', '.overview-subtitle', '.stat-label']),
  );

  // A60：筛选与排序
  const rowsBefore = await evaluate("document.querySelectorAll('.overview-row').length");
  await evaluate(`(() => {
    const input = document.querySelector('#overview-search');
    input.value = 'fox';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await delay(150);
  const filtered = await evaluate(`(() => ({
    rows: document.querySelectorAll('.overview-row').length,
    shown: __oae.text('#overview-shown'),
    status: __oae.text('#status')
  }))()`);
  check(filtered.rows < rowsBefore && filtered.rows > 0, 'A60 filtering narrows the row set');
  check(/of/.test(filtered.shown), `A60 filter announces the shown count (${filtered.shown})`);
  await evaluate(`(() => {
    const input = document.querySelector('#overview-search');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelectorAll('#overview-sort .sort-button')[1].click();
    return true;
  })()`);
  await delay(150);
  const pressed = await evaluate(
    "document.querySelectorAll('#overview-sort [aria-pressed=\"true\"]').length",
  );
  check(pressed === 1, `A60 exactly one sort button is pressed (saw ${pressed})`);
  await screenshot('desktop-overview');

  // A65：播报序列
  const announced = await evaluate("__oae.text('#status')");
  check(announced.length > 0, 'A65 the live region receives announcements');

  /* ============ A54 / A55 / A56③：钻入与返回 ============ */
  // 只有 fox@preview.test 在 fixture 里有邮件，所以钻入一律点它那一行。
  await evaluate(FOX_ROW_CLICK);
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'inbox' && document.querySelectorAll('.message-button').length > 0",
    'inbox after drill-in',
  );
  await injectProbes();
  const drill = await evaluate(`(() => ({
    active: __oae.text('#active-address').trim(),
    currents: [...document.querySelectorAll('#identity-list [aria-current="true"]')].map((el) => el.className),
    navCurrent: document.querySelector('.overview-nav').getAttribute('aria-current'),
    mains: __oae.visibleMains().map((main) => main.id),
    skip: [__oae.text('#skip-link').trim(), document.querySelector('#skip-link').getAttribute('href')]
  }))()`);
  check(drill.active === 'fox@preview.test', `A54 active address follows the row (${drill.active})`);
  check(drill.currents.length === 1, 'A54 exactly one sidebar item is aria-current="true"');
  check(drill.navCurrent === 'false', 'A54 the Overview nav item is not current inside an inbox');
  check(
    drill.mains.length === 1 && drill.mains[0] === 'main-content',
    'A56 desktop inbox has exactly one visible main (#main-content)',
  );
  check(
    drill.skip[0] === 'Skip to inbox' && drill.skip[1] === '#main-content',
    'A58 skip link returns to the inbox target',
  );

  const beforeBack = overviewCount();
  await evaluate("document.querySelector('#back-to-overview').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'overview'",
    'overview after going back',
  );
  await delay(300);
  check(
    (await evaluate('document.activeElement.className')).includes('overview-row'),
    'A55 focus returns to the row button',
  );
  check(
    overviewCount() === beforeBack,
    'A55 a fresh snapshot (<15 s) is not refetched when going back',
  );

  /* ============ F2：侧栏地址是 Overview 之外的第二条入口 ============ */
  const sidebarClicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('#identity-list .identity-button')]
      .filter((el) => !el.classList.contains('overview-nav'))
      .filter((el) => el.textContent.includes('fox@preview.test'))[0];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check(sidebarClicked, 'F2 the overview sidebar offers the fox address');
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'inbox' && document.querySelectorAll('.message-button').length > 0",
    'the inbox after activating the sidebar address',
  );
  await injectProbes();
  const sidebarDrill = await evaluate(`(() => ({
    active: __oae.text('#active-address').trim(),
    mains: __oae.visibleMains().map((main) => main.id),
    status: __oae.text('#status')
  }))()`);
  check(
    sidebarDrill.active === 'fox@preview.test',
    `F2 the sidebar address opens its own inbox (saw ${sidebarDrill.active})`,
  );
  check(
    sidebarDrill.mains.length === 1 && sidebarDrill.mains[0] === 'main-content',
    `F2 the sidebar address switches the visible main to the inbox (saw ${sidebarDrill.mains.join(',')})`,
  );
  await evaluate("document.querySelector('#back-to-overview').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'overview'",
    'the overview after the sidebar probe',
  );

  /* ============ A68：复制反馈 ============ */
  await evaluate(FOX_ROW_CLICK);
  await waitFor("document.querySelectorAll('.message-button').length > 0", 'messages for copy probe');
  await evaluate("document.querySelector('.message-button').click()");
  await waitFor("document.querySelector('.detail-header h2') !== null", 'plain-text detail');
  await injectProbes();
  reviewContrast('detail', await measureContrast(['.message-date', '.link-url']));
  const copyProbe = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].filter(
      (candidate) => /^Copy/.test(candidate.textContent)
    )[0];
    if (!button) return { skipped: true };
    button.click();
    return { skipped: false, id: button.textContent };
  })()`);
  if (!copyProbe.skipped) {
    await delay(150);
    check(
      await evaluate("document.querySelectorAll('.copied').length > 0"),
      'A68 a successful copy enters .copied',
    );
    check(
      /Copied to clipboard/.test(await evaluate("__oae.text('#status')")),
      'A68 a successful copy still announces Copied to clipboard',
    );
    await delay(1400);
    check(
      (await evaluate("document.querySelectorAll('.copied').length")) === 0,
      'A68 .copied clears after ~1.2 s',
    );

    // 剪贴板被拒时不得进入 .copied，改走手动选择降级
    await send('Browser.resetPermissions').catch(() => {});
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].filter(
        (candidate) => /^Copy/.test(candidate.textContent)
      )[0];
      button.click();
      return true;
    })()`);
    await delay(300);
    check(
      (await evaluate("document.querySelectorAll('.copied').length")) === 0,
      'A68 a refused clipboard never shows the copied state',
    );
    await send('Browser.grantPermissions', {
      origin: base,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {});
  }

  /* ============ 既有邮件隔离探针（A13 / A69 的"零变化"） ============ */
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.tab')).find(
      (candidate) => candidate.textContent === 'HTML preview'
    );
    tab.click();
    return true;
  })()`);
  await waitFor(
    "document.querySelector('.mail-frame') !== null",
    'isolated HTML frame',
  );
  await delay(250);

  const containment = await evaluate(`(() => {
    const frame = document.querySelector('.mail-frame');
    return {
      parentMarked: document.body.dataset.pwned === 'yes',
      frameOpaque: frame.contentDocument === null,
      location: location.href
    };
  })()`);
  if (containment.parentMarked) record('containment', 'email script changed the parent');
  if (!containment.frameOpaque) record('containment', 'sandboxed frame origin is readable');
  // skip link 会留下 #overview-panel 这样的片段，那不是导航。
  if (containment.location.split('#')[0] !== `${base}/ui`) {
    record('navigation', containment.location);
  }

  /* ============ A56④⑤ / A58 / A59：移动 375×812 三级 ============ */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await login('preview-token');
  await waitFor("document.querySelectorAll('.overview-row').length > 0", 'mobile overview');
  await injectProbes();
  check(
    (await evaluate("document.querySelector('#inbox-view').dataset.mobileView")) === 'overview',
    'A59 mobile lands in the overview view',
  );
  const mobileOverviewShot = await screenshot('mobile-overview');

  /* ============ F2 / §1.4：移动 Overview 必须能看见并使用地址 selector ============ */
  const mobileSelector = await evaluate(`(() => {
    const select = document.querySelector('#mobile-identity-select');
    return {
      visible: __oae.visible('#mobile-identity-select'),
      insideInboxMain: !!select.closest('#main-content'),
      options: [...select.options].map((option) => option.value),
      value: select.value,
      height: Math.round(select.getBoundingClientRect().height)
    };
  })()`);
  check(mobileSelector.visible, 'F2 the mobile overview shows the address selector');
  check(
    !mobileSelector.insideInboxMain,
    'F2 the selector lives outside the inbox main, so scope=overview cannot hide it',
  );
  check(
    mobileSelector.options[0] === '' && mobileSelector.value === '',
    'F2 the selector starts on the empty back-to-overview sentinel',
  );
  check(
    mobileSelector.options.includes('fox@preview.test'),
    'F2 the selector lists the addresses',
  );
  check(
    mobileSelector.height >= 44,
    `A59 the mobile selector keeps a 44px touch target in the overview (saw ${mobileSelector.height})`,
  );
  await evaluate(`(() => {
    const select = document.querySelector('#mobile-identity-select');
    select.value = 'fox@preview.test';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'list' && document.querySelectorAll('.message-button').length > 0",
    'the mobile list after choosing an address in the selector',
  );
  await injectProbes();
  const selectorDrill = await evaluate(`(() => ({
    active: __oae.text('#active-address').trim(),
    scope: document.querySelector('#inbox-view').dataset.scope,
    selectorVisible: __oae.visible('#mobile-identity-select')
  }))()`);
  check(
    selectorDrill.active === 'fox@preview.test' && selectorDrill.scope === 'inbox',
    `F2 the mobile selector enters the chosen inbox (saw ${selectorDrill.scope}/${selectorDrill.active})`,
  );
  check(selectorDrill.selectorVisible, 'F2 the selector stays visible inside the mobile inbox');
  await evaluate("document.querySelector('#back-to-overview').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'overview'",
    'the mobile overview after the selector probe',
  );
  await waitFor(
    "document.querySelectorAll('.overview-row').length > 0",
    'the mobile rows after the selector probe',
  );
  await injectProbes();

  await evaluate(FOX_ROW_CLICK);
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'list'",
    'mobile list',
  );
  await injectProbes();
  const mobileList = await evaluate(`(() => {
    const mains = __oae.visibleMains();
    return {
      mains: mains.map((main) => main.id),
      messageVisible: __oae.visible('#message-panel'),
      detailVisible: __oae.visible('#detail-panel'),
      labelsVisible: [...document.querySelectorAll('.cell-label')].some(
        (el) => el.getClientRects().length > 0
      ),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      touch: [...document.querySelectorAll('.message-button, #mobile-identity-select')]
        .map((el) => Math.round(el.getBoundingClientRect().height))
    };
  })()`);
  check(
    mobileList.mains.length === 1 && mobileList.mains[0] === 'main-content',
    `A56 mobile list keeps #main-content as the only visible main (saw ${mobileList.mains.join(',')})`,
  );
  check(mobileList.messageVisible, 'A56 mobile list shows #message-panel inside that main');
  check(!mobileList.detailVisible, 'A56 mobile list hides #detail-panel');
  check(!mobileList.overflow, 'A59 mobile list has no horizontal scroll');
  check(
    mobileList.touch.every((height) => height >= 44),
    `A59 mobile touch targets stay >=44px (${mobileList.touch.join(',')})`,
  );
  await evaluate("document.querySelector('#skip-link').click()");
  await delay(100);
  check(
    (await evaluate('document.activeElement.id')) === 'main-content',
    'A58 mobile list skip link focuses the visible #main-content',
  );
  const mobileListShot = await screenshot('mobile-list');

  await evaluate("document.querySelector('.message-button').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'detail'",
    'mobile detail',
  );
  await injectProbes();
  const mobileDetail = await evaluate(`(() => ({
    mains: __oae.visibleMains().map((main) => main.id),
    overflow: document.documentElement.scrollWidth > window.innerWidth
  }))()`);
  check(
    mobileDetail.mains.length === 1 && mobileDetail.mains[0] === 'main-content',
    'A56 mobile detail keeps exactly one visible main',
  );
  check(!mobileDetail.overflow, 'A59 mobile detail has no horizontal scroll');
  await evaluate("document.querySelector('#skip-link').click()");
  await delay(100);
  check(
    (await evaluate('document.activeElement.id')) === 'main-content',
    'A58 mobile detail skip link focuses the visible #main-content',
  );
  const mobileDetailShot = await screenshot('mobile-detail');
  await evaluate("document.querySelector('#mobile-back').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'list'",
    'mobile back to list',
  );
  await evaluate("document.querySelector('#back-to-overview').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.mobileView === 'overview'",
    'mobile back to overview',
  );
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  /* ============ A53：identity 会话不碰 Overview ============ */
  const overviewBeforeIdentity = overviewCount();
  await login('preview-identity-token');
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'inbox' && document.querySelectorAll('.message-button').length > 0",
    'identity inbox',
  );
  await injectProbes();
  await delay(300);
  check(
    overviewCount() === overviewBeforeIdentity,
    'A53 an identity session never requests /ui/api/overview',
  );
  const identityProbe = await evaluate(`(() => {
    const back = document.querySelector('#back-to-overview');
    const nav = document.querySelector('.overview-nav');
    const order = __oae.tabOrder();
    return {
      backRects: back.getClientRects().length,
      backTabbable: order.includes(back),
      navPresent: !!nav,
      navTabbable: nav ? order.includes(nav) : false,
      mains: __oae.visibleMains().map((main) => main.id)
    };
  })()`);
  check(identityProbe.backRects === 0, 'A53 ← Overview is invisible for identity sessions');
  check(!identityProbe.backTabbable, 'A53 ← Overview is out of the tab order');
  check(!identityProbe.navTabbable, 'A53 the Overview nav item is out of the tab order');
  check(
    identityProbe.mains.length === 1 && identityProbe.mains[0] === 'main-content',
    'A56 identity inbox has exactly one visible main',
  );

  /* ============ A61 / A61b / A62 / A62b / A63 / A64：五种 fixture ============ */
  function stubbedIdentities(count, delayMs = 0) {
    return () => ({
      status: 200,
      delayMs,
      body: {
        identities: Array.from({ length: count }, (_, index) => ({
          address: `agent-${String(index).padStart(3, '0')}@preview.test`,
          name: `Billing bot ${index}`,
          createdAt: '2026-07-20T08:00:00.000Z',
        })),
      },
    });
  }

  /** 0 身份的 ready 载荷：窗口派生量未被观测，所以是 null（A64 与截图矩阵共用）。 */
  function emptyOverviewStub() {
    return {
      status: 200,
      body: {
        status: 'ready',
        generatedAt: new Date().toISOString(),
        ageSeconds: 0,
        cached: false,
        revalidating: false,
        refreshError: false,
        scan: {
          scanBack: 500,
          scanned: null,
          mailboxTotal: null,
          truncated: false,
          skipped: true,
          partial: false,
        },
        totals: {
          addresses: 0,
          matchedInWindow: 0,
          unmatchedInWindow: null,
          unseenInWindow: 0,
          activeAddresses: 0,
          exact: true,
          recentHours: 24,
          recentSince: new Date().toISOString(),
        },
        addresses: [],
      },
    };
  }

  // A61：loading 骨架 + 轮询 + 放弃
  overviewStub = () => ({
    status: 202,
    body: { status: 'loading', generatedAt: null, retryAfterMs: 200 },
  });
  const loadingStart = overviewCount();
  await login('preview-token');
  await waitFor("document.querySelectorAll('.overview-row').length > 0", 'loading fixture rows');
  await injectProbes();
  check(
    /Loading…/.test(await evaluate("__oae.text('#overview-stats')")),
    'A61 the loading fixture shows a Loading… skeleton',
  );
  check(
    await evaluate("document.querySelectorAll('.overview-row').length > 0"),
    'A61 address rows render while counts are loading',
  );
  await delay(2500);
  check(overviewCount() - loadingStart >= 2, 'A61 the client polls while loading');
  await evaluate("document.querySelector('.overview-row').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'inbox'",
    'drill-in during loading',
  );
  await evaluate("document.querySelector('#back-to-overview').click()");
  if (runSlow) {
    await waitFor(
      "/taking too long/.test(document.querySelector('#overview-notice').textContent)",
      'the give-up notice after 15 polls',
      300,
    );
    check(
      await evaluate("__oae.visible('#overview-refresh')"),
      'A61 Retry stays available after giving up',
    );
  }

  // A61b：骨架不被 Overview 拖住
  identitiesStub = stubbedIdentities(50, 50);
  overviewStub = () => ({ status: 200, delayMs: 3000, body: readyBody });
  await login('preview-token');
  await waitFor("document.querySelectorAll('.overview-row').length === 50", 'the 50 stubbed rows', 40);
  await injectProbes();
  const skeleton = await evaluate(`(() => ({
    rows: document.querySelectorAll('.overview-row').length,
    stats: __oae.text('#overview-stats'),
    firstRow: !!document.querySelector('.overview-row')
  }))()`);
  check(skeleton.rows === 50, `A61b address rows land with /identities (saw ${skeleton.rows})`);
  check(/Loading…/.test(skeleton.stats), 'A61b count columns read Loading… while /overview is in flight');
  check(skeleton.firstRow, 'A61b the first row is present and clickable before /overview resolves');
  identitiesStub = null;
  overviewStub = null;

  // A62b：冷却期不刷屏（stale + 持续失败）
  if (runSlow) {
    let coolDownServed = 0;
    overviewStub = () => {
      coolDownServed += 1;
      return {
        status: 200,
        body: {
          ...readyBody,
          status: 'stale',
          cached: true,
          revalidating: false,
          refreshError: true,
          retryAfterMs: 5000,
        },
      };
    };
    const cooldownStart = overviewCount();
    await login('preview-token');
    await waitFor("document.querySelectorAll('.overview-row').length > 0", 'stale fixture rows');
    await injectProbes();
    const beforeCooldown = await evaluate(
      "document.querySelector('.overview-row').getAttribute('aria-label')",
    );
    await delay(20_000);
    const cooldownRequests = overviewCount() - cooldownStart;
    check(cooldownRequests <= 5, `A62b at most 5 requests in 20 s (saw ${cooldownRequests})`);
    check(coolDownServed <= 5, `A62b the fixture served at most 5 refreshes (saw ${coolDownServed})`);
    check(
      /Retrying in \d+s…/.test(await evaluate("__oae.text('#overview-refresh')")),
      'A62b the Retry button counts down instead of spinning',
    );
    check(
      (await evaluate("document.querySelector('.overview-row').getAttribute('aria-label')")) ===
        beforeCooldown,
      'A62b stale rows keep the previous numbers instead of falling back to 0',
    );
    check(
      /last refresh failed/.test(await evaluate("__oae.text('#overview-updated')")),
      'A62b the header explains that the last refresh failed',
    );
    overviewStub = null;
  }

  // A62：revalidating:true 触发恰好一次后续取数，成功后转 ready
  {
    let served = 0;
    overviewStub = () => {
      served += 1;
      return served === 1
        ? {
            status: 200,
            body: {
              ...readyBody,
              status: 'stale',
              cached: true,
              revalidating: true,
              refreshError: false,
              retryAfterMs: 1000,
            },
          }
        : { status: 200, body: readyBody };
    };
    await login('preview-token');
    await waitFor("document.querySelectorAll('.overview-row').length > 0", 'stale rows before revalidation');
    await injectProbes();
    await waitFor(
      "document.querySelector('#overview-panel').classList.contains('is-ready')",
      'the automatic follow-up turning ready',
      60,
    );
    check(served === 2, `A62 revalidating triggers exactly one follow-up fetch (saw ${served})`);
    overviewStub = null;
  }

  // A63：unavailable
  overviewStub = () => ({
    status: 503,
    body: { status: 'unavailable', reason: 'imap_unavailable', retryAfterSeconds: 5 },
  });
  await login('preview-token');
  await waitFor("document.querySelectorAll('.overview-row').length > 0", 'unavailable fixture rows');
  await injectProbes();
  const unavailable = await evaluate(`(() => ({
    notice: __oae.visible('#overview-notice'),
    noticeText: __oae.text('#overview-notice'),
    cells: __oae.text('.overview-row'),
    retry: __oae.visible('#overview-refresh')
  }))()`);
  check(unavailable.notice && unavailable.noticeText.length > 0, 'A63 unavailable shows a notice');
  check(/Unavailable/.test(unavailable.cells), 'A63 count columns read Unavailable, not 0');
  check(unavailable.retry, 'A63 Retry is offered');
  await screenshot('desktop-unavailable');
  overviewStub = null;

  // A64：0 身份
  identitiesStub = stubbedIdentities(0);
  overviewStub = emptyOverviewStub;
  await login('preview-token');
  await waitFor(
    "/No addresses yet/.test(document.querySelector('#overview-state').textContent)",
    'the empty state',
  );
  await injectProbes();
  const empty = await evaluate(`(() => ({
    stats: __oae.text('#overview-stats'),
    disclosureHidden: document.querySelector('#overview-disclosure').hidden,
    updated: __oae.text('#overview-updated'),
    createButtons: [...document.querySelectorAll('button:not(.sort-button)')]
      .filter((button) => button.getClientRects().length > 0)
      .filter((button) => /create|add address|new address/i.test(button.textContent))
      .map((button) => button.textContent.trim())
  }))()`);
  check(!/In window/.test(empty.stats), 'A64 the IN WINDOW card stays out of the DOM');
  check(!/newest/.test(empty.updated), 'A64 no "newest N of M" disclosure with zero identities');
  check(empty.disclosureHidden, 'A64 the truncation disclosure stays hidden');
  check(
    empty.createButtons.length === 0,
    `A64 no create button is offered (saw ${empty.createButtons.join('|')})`,
  );
  identitiesStub = null;
  overviewStub = null;

  /* ============ F3 / A37：exact:false 时总计卡片也必须是下界 ============ */
  overviewStub = () => ({
    status: 200,
    body: {
      ...readyBody,
      totals: {
        ...readyBody.totals,
        exact: false,
        unmatchedInWindow: null,
        matchedInWindow: 128,
        unseenInWindow: 0,
        activeAddresses: 4,
      },
      addresses: readyBody.addresses.map((row, index) =>
        index === 0 ? { ...row, complete: false, count: 0, unseen: 0 } : row,
      ),
    },
  });
  const inexactAddress = readyBody.addresses[0].address;
  await login('preview-token');
  await waitFor("document.querySelectorAll('.overview-row').length > 0", 'inexact fixture rows');
  await injectProbes();
  const inexact = await evaluate(`(() => ({
    cards: [...document.querySelectorAll('#overview-stats .stat-card')].map((card) => ({
      label: card.querySelector('.stat-label').textContent,
      value: card.querySelector('.stat-value').textContent,
      title: card.querySelector('.stat-value').title
    })),
    disclosureHidden: document.querySelector('#overview-disclosure').hidden,
    disclosure: __oae.text('#overview-disclosure'),
    affectedRow: (document.querySelector(
      '.overview-row[data-address="' + ${JSON.stringify(inexactAddress)} + '"]'
    ) || {}).ariaLabel
  }))()`);
  const cardFor = (label) => inexact.cards.filter((card) => card.label === label)[0];
  check(
    cardFor('In window') !== undefined && /^≥128 \/ /.test(cardFor('In window').value),
    `F3 the IN WINDOW card shows a bound (saw ${cardFor('In window')?.value})`,
  );
  check(
    cardFor('Unseen') !== undefined && cardFor('Unseen').value === 'Unknown',
    `F3 a zero lower bound reads Unknown, never 0 (saw ${cardFor('Unseen')?.value})`,
  );
  check(
    cardFor('Active 24h') !== undefined && cardFor('Active 24h').value === '≥4',
    `F3 the ACTIVE 24H card shows a bound (saw ${cardFor('Active 24h')?.value})`,
  );
  check(
    cardFor('Addresses') !== undefined && /^[\d,]+$/.test(cardFor('Addresses').value),
    `F3 the exact ADDRESSES card keeps its plain number (saw ${cardFor('Addresses')?.value})`,
  );
  check(
    /Lower bound/.test(cardFor('In window')?.title ?? '') &&
      /Not counted/.test(cardFor('Unseen')?.title ?? ''),
    'F3 the bound cards explain themselves in a title',
  );
  check(
    !inexact.disclosureHidden && /shown as ≥ or Unknown/.test(inexact.disclosure),
    'F3 the disclosure now matches what the DOM actually shows',
  );
  check(
    /Unknown/.test(inexact.affectedRow ?? ''),
    `F3 the affected row still reads Unknown (saw ${inexact.affectedRow})`,
  );
  overviewStub = null;

  /* ============ F6 / §6 行 19：活动地址被删 → 回 Overview 并播报 ============ */
  await login('preview-token');
  await waitFor(
    "document.querySelectorAll('.overview-row').length > 0",
    'the overview before the removal probe',
  );
  await evaluate(FOX_ROW_CLICK);
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'inbox' && document.querySelectorAll('.message-button').length > 0",
    'the inbox before the removal probe',
  );
  await injectProbes();
  // 播报会被后续消息覆盖，所以把 live region 的每次变化都记下来
  await evaluate(`(() => {
    window.__announcements = [];
    const region = document.querySelector('#status');
    new MutationObserver(() => {
      const text = region.textContent.trim();
      if (text) window.__announcements.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
    return true;
  })()`);
  // 下一次身份刷新里 fox 不见了；inbox 里的 Refresh 就是发现它的那一刻
  identitiesStub = () => ({
    status: 200,
    body: {
      identities: [
        {
          address: 'empty@preview.test',
          name: 'Empty Inbox',
          createdAt: '2026-07-27T08:05:00.000Z',
        },
      ],
    },
  });
  await evaluate("document.querySelector('#refresh-button').click()");
  await waitFor(
    "document.querySelector('#inbox-view').dataset.scope === 'overview'",
    'the overview after the active address disappeared',
  );
  await injectProbes();
  const removed = await evaluate(`(() => ({
    announcements: window.__announcements || [],
    active: __oae.text('#active-address').trim(),
    addresses: [...document.querySelectorAll('.overview-row')].map((row) => row.dataset.address),
    mains: __oae.visibleMains().map((main) => main.id)
  }))()`);
  check(
    removed.announcements.some((text) => /no longer available/.test(text)),
    `F6 the removal is announced (saw ${removed.announcements.join(' | ')})`,
  );
  check(removed.active === '', `F6 the stale active address is cleared (saw ${removed.active})`);
  check(
    !removed.addresses.includes('fox@preview.test'),
    'F6 the removed address leaves the overview roster',
  );
  check(
    removed.mains.length === 1 && removed.mains[0] === 'overview-panel',
    `F6 the user lands back on the overview (saw ${removed.mains.join(',')})`,
  );
  identitiesStub = null;

  /* ============ A69：五状态 × 桌面/移动 的 10 张截图矩阵 ============ */
  const MATRIX_VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    { name: 'mobile', width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
  ];
  const MATRIX_STATES = [
    {
      name: 'ready',
      overview: () => ({ status: 200, body: readyBody }),
      settled: "document.querySelector('#overview-panel').classList.contains('is-ready')",
    },
    {
      name: 'stale',
      overview: () => ({
        status: 200,
        body: {
          ...readyBody,
          status: 'stale',
          cached: true,
          revalidating: false,
          refreshError: true,
          retryAfterMs: 5000,
        },
      }),
      settled: "document.querySelector('#overview-panel').classList.contains('is-stale')",
    },
    {
      name: 'loading',
      // 3 s 的 retryAfterMs：截图期间只轮询一次，不会跑进放弃态
      overview: () => ({
        status: 202,
        body: { status: 'loading', generatedAt: null, retryAfterMs: 3000 },
      }),
      settled: "/Loading…/.test(document.querySelector('#overview-stats').textContent)",
    },
    {
      name: 'unavailable',
      overview: () => ({
        status: 503,
        body: { status: 'unavailable', reason: 'imap_unavailable', retryAfterSeconds: 5 },
      }),
      settled: "/unavailable/i.test(document.querySelector('#overview-notice').textContent)",
    },
    {
      name: 'empty',
      identities: stubbedIdentities(0),
      overview: emptyOverviewStub,
      settled: "/No addresses yet/.test(document.querySelector('#overview-state').textContent)",
    },
  ];
  const matrixShots = [];
  for (const viewport of MATRIX_VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
    for (const fixture of MATRIX_STATES) {
      overviewStub = fixture.overview;
      identitiesStub = fixture.identities ?? null;
      await login('preview-token');
      await waitFor(
        fixture.settled,
        `the ${fixture.name} state for the ${viewport.name} screenshot`,
      );
      // 让卡片、行与 notice 都画完再拍，否则截到的是半张骨架
      await delay(250);
      // N1 / §1.4：375×812 首屏必须从 topbar 开始，落焦 Overview 面板不许把页面滚下去
      if (viewport.mobile) {
        const firstScreen = await evaluate(`(() => {
          const box = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
          };
          return {
            scrollY: Math.round(window.scrollY),
            viewport: window.innerHeight,
            topbar: box('#inbox-view .topbar'),
            logo: box('.topbar-brand .brand-logo'),
            signOut: box('#logout-button'),
            label: box('.mobile-identity label'),
            labelText: document.querySelector('.mobile-identity label').textContent.trim(),
            selector: box('#mobile-identity-select')
          };
        })()`);
        const inside = (rect) => rect.top >= 0 && rect.bottom <= firstScreen.viewport;
        check(
          firstScreen.scrollY === 0,
          `N1 the ${fixture.name} mobile first screen starts unscrolled (saw scrollY ${firstScreen.scrollY})`,
        );
        check(
          inside(firstScreen.topbar) && inside(firstScreen.logo) && inside(firstScreen.signOut),
          `N1 the ${fixture.name} mobile first screen keeps the topbar, logo and Sign out in the viewport ` +
            `(topbar ${firstScreen.topbar.top}..${firstScreen.topbar.bottom}, ` +
            `logo ${firstScreen.logo.top}, sign out ${firstScreen.signOut.top})`,
        );
        check(
          firstScreen.labelText === 'Address' &&
            inside(firstScreen.label) &&
            inside(firstScreen.selector),
          `N1 the ${fixture.name} mobile first screen keeps the Address label above its selector in the ` +
            `viewport (label ${firstScreen.label.top}..${firstScreen.label.bottom}, ` +
            `selector ${firstScreen.selector.top}..${firstScreen.selector.bottom})`,
        );
      }
      matrixShots.push(await screenshot(`${fixture.name}-${viewport.name}`));
      overviewStub = null;
      identitiesStub = null;
    }
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  await send('Emulation.clearDeviceMetricsOverride');

  /* ============ A67：不安全上下文闸门 ============ */
  const insecure = base.replace(/\/\/[^:]+/, '//0.0.0.0');
  await send('Page.navigate', { url: `${insecure}/ui` });
  await waitFor("document.readyState === 'complete'", 'insecure origin login screen');
  await injectProbes();
  const gate = await evaluate(`(() => ({
    disabled: document.querySelector('#login-token').disabled,
    submitDisabled: document.querySelector('#login-submit').disabled,
    warning: __oae.visible('#insecure-warning')
  }))()`);
  check(gate.disabled && gate.submitDisabled, 'A67 the insecure origin disables token entry');
  check(gate.warning, 'A67 the insecure-origin warning is visible');
  await screenshot('insecure-gate');

  for (const url of requestedExternalUrls) record('external request', url);

  // A69：发布前视觉矩阵必须真的落在磁盘上，五状态 × 两个断点一张都不能少
  const expectedMatrix = [];
  for (const stateName of ['ready', 'stale', 'loading', 'unavailable', 'empty']) {
    for (const viewportName of ['desktop', 'mobile']) {
      expectedMatrix.push(`${stateName}-${viewportName}.png`);
    }
  }
  const missingShots = expectedMatrix.filter((name) => !existsSync(join(shotDir, name)));
  check(
    expectedMatrix.length === 10 && missingShots.length === 0,
    `A69 all 10 matrix screenshots exist (missing ${missingShots.join(',') || 'none'})`,
  );

  if (violations.length) {
    throw new Error(`Browser acceptance violations:\n${violations.join('\n')}`);
  }
  console.log(
    'UI browser acceptance passed: overview landing, single visible main, tab order, skip link, ' +
      'five fixtures, brand geometry, contrast, and email isolation.',
  );
  console.log(`screenshots: ${[mobileOverviewShot, mobileListShot, mobileDetailShot].join(' ')}`);
  console.log(`A69 matrix (${matrixShots.length}): ${matrixShots.join(' ')}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  browser.kill('SIGTERM');
  rmSync(profile, { recursive: true, force: true });
}
