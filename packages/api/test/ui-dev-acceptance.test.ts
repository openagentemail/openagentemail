import { describe, expect, test } from 'bun:test';
import { resolveInsecureBase } from '../dev/acceptance-insecure-base.mjs';

// 浏览器验收脚本本身不在 CI 里跑（需要真 Chromium），所以这里守住"探针还在、
// 而且用的是可执行的判定方法"这条底线：一旦有人把关键探针删掉或换成
// querySelectorAll(':focusable') 那种会直接抛错的写法，这些断言就会红。
const source = await Bun.file(new URL('../dev/acceptance.mjs', import.meta.url)).text();
const previewSource = await Bun.file(new URL('../dev/preview.ts', import.meta.url)).text();

describe('development browser acceptance harness', () => {
  test('focused A75 skips non-loopback discovery while the full path retains it', async () => {
    let focusedDiscoveryCalls = 0;
    await expect(resolveInsecureBase(true, async () => {
      focusedDiscoveryCalls += 1;
      throw new Error('focused mode must not discover an insecure host');
    })).resolves.toBeNull();
    expect(focusedDiscoveryCalls).toBe(0);

    let fullDiscoveryCalls = 0;
    await expect(resolveInsecureBase(false, async () => {
      fullDiscoveryCalls += 1;
      return 'http://198.51.100.10:4310';
    })).resolves.toBe('http://198.51.100.10:4310');
    expect(fullDiscoveryCalls).toBe(1);

    const resolver = source.indexOf('resolveInsecureBase(approvalKeyboardOnly, findInsecureBase)');
    const focusedBranch = source.indexOf('if (approvalKeyboardOnly) {');
    const fullInsecureProbe = source.indexOf('/* ============ A67');
    expect(resolver).toBeGreaterThanOrEqual(0);
    expect(focusedBranch).toBeGreaterThan(resolver);
    expect(fullInsecureProbe).toBeGreaterThan(focusedBranch);
  });

  test('fails on resource errors as well as script and navigation violations', () => {
    expect(source).toContain('Network.loadingFailed');
    expect(source).toContain('Network.responseReceived');
    expect(source).toContain('Log.entryAdded');
    expect(source).toContain('Page.javascriptDialogOpening');
    expect(source).toContain('Runtime.consoleAPICalled');
    expect(source).toContain("document.querySelector('.detail-header h2')");
    expect(source).toContain("candidate.textContent === 'Rendered'");
    expect(source).toContain("document.querySelector('.mail-frame')");
    expect(source).toContain('isExpectedUnauthenticatedProbe');
  });

  // A53 / A57：tab 序探针必须是自建的 DOM 顺序 + 可见性过滤版本
  test('the tab-order probe is the DOM-order fallback, not an invented pseudo-class', () => {
    expect(source).toContain('const TABBABLE =');
    expect(source).toContain('button:not([disabled])');
    expect(source).toContain('[tabindex]:not([tabindex="-1"])');
    expect(source).toContain('el.getClientRects().length > 0');
    expect(source).toContain("getComputedStyle(el).visibility !== 'hidden'");
    expect(source).toContain("!el.closest('[hidden]')");
    // 原生 CSS 没有"可聚焦"伪类，这类选择器会让 querySelectorAll 直接抛 SyntaxError
    expect(source).not.toContain(':focusable');
    expect(source).not.toContain(':tabbable');
  });

  test('A75 keeps native keyboard, terminal-state, and restoration anchors', () => {
    const sharedStart = source.indexOf('async function runA75ApprovalKeyboard()');
    const sharedEnd = source.indexOf('async function runAcceptance()', sharedStart);
    const targetedStart = source.indexOf('if (approvalKeyboardOnly) {');
    const targetedEnd = source.indexOf('/* ============ A51', targetedStart);
    expect(sharedStart).toBeGreaterThanOrEqual(0);
    expect(sharedEnd).toBeGreaterThan(sharedStart);
    expect(targetedStart).toBeGreaterThanOrEqual(0);
    expect(targetedEnd).toBeGreaterThan(targetedStart);
    const sharedA75 = source.slice(sharedStart, sharedEnd);
    const targetedBranch = source.slice(targetedStart, targetedEnd);
    const sharedCall = targetedBranch.indexOf('await runA75ApprovalKeyboard();');
    const violationCheck = targetedBranch.indexOf('if (violations.length)');
    const normalReturn = targetedBranch.indexOf('return;');
    expect(sharedCall).toBeGreaterThanOrEqual(0);
    expect(violationCheck).toBeGreaterThan(sharedCall);
    expect(normalReturn).toBeGreaterThan(violationCheck);
    expect(sharedA75).toMatch(/Input\.dispatchKeyEvent[\s\S]*rawKeyDown[\s\S]*char[\s\S]*keyUp/);
    expect(sharedA75).toContain(':focus-visible');
    expect(sharedA75).toMatch(/decision.*approved[\s\S]*decision.*rejected/);
    expect(sharedA75).toMatch(/url\.pathname[\s\S]*Object\.hasOwn\(body, 'decision'\)/);
    expect(sharedA75).toContain('requiredStableObservations');
    expect(sharedA75).toContain('exactObservationCount');
    expect(sharedA75).toMatch(/task-detail-head[\s\S]*task-result[\s\S]*#tasks-rows \.task-row/);
    expect(sharedA75).toContain('filteredTerminalListRefresh');
    expect(sharedA75).not.toMatch(/\[aria-label=.*(?:Approve|Reject).*\]\.(?:focus|click)\(\)/);
    const defaultA75Call = source.indexOf('await runA75ApprovalKeyboard();', targetedEnd);
    const restoreAdmin = source.indexOf("await login('preview-token');", defaultA75Call);
    const restoreOverview = source.indexOf("dataset.scope === 'overview'", restoreAdmin);
    const adminProbeInjection = source.indexOf('await injectProbes();', restoreOverview);
    expect(defaultA75Call).toBeGreaterThan(targetedEnd);
    expect(restoreAdmin).toBeGreaterThan(defaultA75Call);
    expect(restoreOverview).toBeGreaterThan(restoreAdmin);
    expect(adminProbeInjection).toBeGreaterThan(restoreOverview);
  });

  // A56：可见 main 的判定方法
  test('the visible-main probe counts rendered mains', () => {
    expect(source).toContain("document.querySelectorAll('main')");
    expect(source).toContain('visibleMains');
    expect(source).toContain('A56 desktop overview has exactly one visible main');
    expect(source).toContain('A56 mobile list keeps #main-content as the only visible main');
    expect(source).toContain('A56 mobile detail keeps exactly one visible main');
    expect(source).toContain('A56 identity Home has exactly one visible main');
  });

  // A70：对比度必须向上解析有效合成底色
  test('the contrast probe resolves the effective composited background', () => {
    expect(source).toContain('function effectiveBg(');
    expect(source).toContain('node = node.parentElement');
    expect(source).toContain('if (a >= 1) return composite(acc)');
    expect(source).toContain('document.documentElement).backgroundColor');
    expect(source).toContain('0.2126');
    expect(source).toContain('__oae.token(');
    expect(source).toContain('ratio >= 4.5');
    expect(source).toContain('ratio >= 3');
  });

  // A51 / A52 / A54 / A55 / A58：落地 Home，再钻入/返回/skip link
  test('Home landing, drill-in, back, and skip-link probes are present', () => {
    expect(source).toContain('A51 Home panel is visible');
    expect(source).toContain('A51 Mail main is hidden on Home landing');
    expect(source).toContain('A51 data-scope is Home');
    expect(source).toContain('A51 session lands on the Home panel');
    expect(source).toContain('A52 session renewal lands on the Home panel');
    expect(source).toContain('A54 active address follows the row');
    expect(source).toContain('A55 focus returns to the row button');
    expect(source).toContain('A55 a fresh snapshot (<15 s) is not refetched when going back');
    expect(source).toContain('A58 activating the skip link focuses #overview-panel');
    expect(source).toContain('A58 mobile list skip link focuses the visible #main-content');
    expect(source).toContain('A58 mobile detail skip link focuses the visible #main-content');
  });

  // A53：identity 会话零 overview 请求、只有 Home 壳
  test('the identity session probe asserts zero overview requests and a data-free Home shell', () => {
    expect(source).toContain('preview-identity-token');
    expect(source).toContain('A53 an identity session never requests /ui/api/overview');
    expect(source).toContain('A53 ← Home return is out of the tab order');
    expect(source).toContain('A53 Home global nav is available to identity sessions');
    expect(source).toContain('A53 identity Home does not render admin overview data');
    expect(source).toContain('[data-nav="overview"]');
    expect(previewSource).toContain('preview-identity-token');
    expect(previewSource).toContain("kind: 'identity'");
  });

  // A61 / A61b / A62 / A62b / A63 / A64：五个 fixture 与骨架/冷却行为
  test('all five overview fixtures are exercised, including the skeleton and cooldown probes', () => {
    expect(source).toContain('Fetch.requestPaused');
    expect(source).toContain('Fetch.fulfillRequest');
    expect(source).toContain('A61 the loading fixture shows a Loading… skeleton');
    expect(source).toContain('A61 the client polls while loading');
    expect(source).toContain('the give-up notice after 15 polls');
    expect(source).toContain('A61b address rows land with /identities');
    expect(source).toContain('A61b count columns read Loading… while /overview is in flight');
    expect(source).toContain('A62 revalidating triggers exactly one follow-up fetch');
    expect(source).toContain('A62b at most 5 requests in 20 s');
    expect(source).toContain('A62b the Retry button counts down instead of spinning');
    expect(source).toContain('A62b stale rows keep the previous numbers instead of falling back to 0');
    expect(source).toContain('A63 count columns read Unavailable, not 0');
    expect(source).toContain('A64 the removed IN WINDOW card stays out of the DOM');
    expect(source).toContain('A64 the existing admin Create Identity control is preserved');
  });

  // A59 / A60：移动三级与 200 行 fixture
  test('mobile and large-roster probes are present', () => {
    expect(source).toContain('Emulation.setDeviceMetricsOverride');
    expect(source).toContain('width: 375');
    expect(source).toContain('A59 mobile list has no horizontal scroll');
    expect(source).toContain('A59 mobile touch targets stay >=44px');
    expect(source).toContain('A60 filtering narrows the row set');
    expect(source).toContain('A60 exactly one sort button is pressed');
  });

  // F2：地址控件只在 Mail 显示；Home 地址行是唯一的跨 scope 入口
  test('Mail-only address controls and Home-to-Mail activation are exercised in a real browser', () => {
    expect(source).toContain('F2 Home hides address and folder controls outside Mail');
    expect(source).toContain('F2 mobile Home hides every Mail address control');
    expect(source).toContain('Home 的实际地址行仍会明确进入 Mail。');
  });

  // F3：exact:false 的总计卡片
  test('the inexact fixture asserts the total cards render bounds', () => {
    expect(source).toContain('F3 the obsolete IN WINDOW card is not rendered');
    expect(source).toContain('F3 a zero lower bound reads Unknown, never 0');
    expect(source).toContain('F3 the exact ADDRESSES card keeps its plain number');
    expect(source).toContain('F3 the disclosure now matches what the DOM actually shows');
    expect(source).toContain('exact: false');
  });

  // F6：活动地址被删后的自愈迁移
  test('the removed-identity probe drives the migration back to Home', () => {
    expect(source).toContain('F6 the removal is announced');
    expect(source).toContain('F6 the stale active address is cleared');
    expect(source).toContain('F6 the user lands back on Home');
    expect(source).toContain("document.querySelector('#refresh-button').click()");
    expect(source).toContain('new MutationObserver(');
  });

  // A69：五状态 × 桌面/移动 的 10 张截图矩阵
  test('the screenshot matrix covers five states on both breakpoints and is verified on disk', () => {
    expect(source).toContain('MATRIX_VIEWPORTS');
    expect(source).toContain('width: 1440');
    expect(source).toContain('height: 900');
    expect(source).toContain('A69 all 10 matrix screenshots exist');
    for (const stateName of ['ready', 'stale', 'loading', 'unavailable', 'empty']) {
      expect(source).toContain(`name: '${stateName}'`);
    }
    expect(source).toContain("for (const viewportName of ['desktop', 'mobile'])");
    expect(source).toContain('missingShots');
  });

  // A66 / A67 / A68：品牌、安全上下文闸门、复制反馈
  test('brand, insecure-context, and copy probes are present', () => {
    expect(source).toContain('A66 topbar logo is 24x24');
    expect(source).toContain('[class*="brand-mark"]');
    expect(source).toContain('A66 topbar shows OpenAgent.email exactly once');
    expect(source).toContain("fetch('/ui/favicon.svg')");
    expect(source).toContain('securitypolicyviolation');
    expect(source).toContain('async function findInsecureBase()');
    expect(source).toContain('No reachable non-loopback IPv4 address');
    expect(source).toContain("await send('Page.navigate', { url: `${insecureBase}/ui` });");
    expect(source).toContain('A67 the insecure origin disables token entry');
    expect(source).toContain('A68 a successful copy enters .copied');
    expect(source).toContain('A68 .copied clears after ~1.2 s');
  });

  // A74：preview 的五个模式与 200 身份开关
  test('the preview fixture exposes all five overview modes and the large roster switch', () => {
    expect(previewSource).toContain('PREVIEW_OVERVIEW');
    expect(previewSource).toContain('PREVIEW_IDENTITIES');
    for (const mode of ['loading', 'unavailable', 'empty', 'stale']) {
      expect(previewSource).toContain(`overviewMode === '${mode}'`);
    }
    expect(previewSource).toContain('getMailboxScan');
  });

  // F3：Notifications 预览必须注入 notifyMessages stub，否则面板永远打真实 ntfy
  test('the preview fixture stubs notifyMessages across tiers and topics (F3)', () => {
    expect(previewSource).toContain('notifyMessages:');
    expect(previewSource).toContain('buildPreviewNotifyMessages');
    expect(previewSource).toContain("'user-alerts'");
    expect(previewSource).toContain("'user-low'");
    expect(previewSource).toContain("'agent:fox'");
    // urgent / normal / low / unknown（priority 2）
    expect(previewSource).toContain('priority: 5');
    expect(previewSource).toContain('priority: 3');
    expect(previewSource).toContain('priority: 1');
    expect(previewSource).toContain('priority: 2');
  });

  // F6：preview stub 用相对时间，并按 since 过滤；12h 查询不含窗口外旧消息
  test('preview notify stubs use relative timestamps and honor since=12h (F6)', () => {
    expect(previewSource).toContain('function previewSinceCutoff(');
    expect(previewSource).toContain('Math.floor(Date.now() / 1000)');
    expect(previewSource).toContain('now - 60');
    expect(previewSource).toContain('now - 48 * 3600');
    expect(previewSource).toContain('entry.time >= cutoff');
    expect(previewSource).toContain('buildPreviewNotifyMessages(topic, since)');
    // 契约：当前 12h 查询只返回窗口内消息（旧消息时间戳在窗口外）
    expect(previewSource).toContain("Should be filtered out when since=12h.");
  });
});
