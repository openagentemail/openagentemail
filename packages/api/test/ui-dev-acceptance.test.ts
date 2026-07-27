import { describe, expect, test } from 'bun:test';

// 浏览器验收脚本本身不在 CI 里跑（需要真 Chromium），所以这里守住"探针还在、
// 而且用的是可执行的判定方法"这条底线：一旦有人把关键探针删掉或换成
// querySelectorAll(':focusable') 那种会直接抛错的写法，这些断言就会红。
const source = await Bun.file(new URL('../dev/acceptance.mjs', import.meta.url)).text();
const previewSource = await Bun.file(new URL('../dev/preview.ts', import.meta.url)).text();

describe('development browser acceptance harness', () => {
  test('fails on resource errors as well as script and navigation violations', () => {
    expect(source).toContain('Network.loadingFailed');
    expect(source).toContain('Network.responseReceived');
    expect(source).toContain('Log.entryAdded');
    expect(source).toContain('Page.javascriptDialogOpening');
    expect(source).toContain('Runtime.consoleAPICalled');
    expect(source).toContain("document.querySelector('.detail-header h2')");
    expect(source).toContain("candidate.textContent === 'HTML preview'");
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

  // A56：可见 main 的判定方法
  test('the visible-main probe counts rendered mains', () => {
    expect(source).toContain("document.querySelectorAll('main')");
    expect(source).toContain('visibleMains');
    expect(source).toContain('A56 desktop overview has exactly one visible main');
    expect(source).toContain('A56 mobile list keeps #main-content as the only visible main');
    expect(source).toContain('A56 mobile detail keeps exactly one visible main');
    expect(source).toContain('A56 identity inbox has exactly one visible main');
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

  // A51 / A52 / A54 / A55 / A58：落地、钻入、返回、skip link
  test('overview landing, drill-in, back, and skip-link probes are present', () => {
    expect(source).toContain('A51 overview panel is visible');
    expect(source).toContain('A51 landing issues no /ui/api/messages request');
    expect(source).toContain('A52 session renewal lands on the overview panel');
    expect(source).toContain('A54 active address follows the row');
    expect(source).toContain('A55 focus returns to the row button');
    expect(source).toContain('A55 a fresh snapshot (<15 s) is not refetched when going back');
    expect(source).toContain('A58 activating the skip link focuses #overview-panel');
    expect(source).toContain('A58 mobile list skip link focuses the visible #main-content');
    expect(source).toContain('A58 mobile detail skip link focuses the visible #main-content');
  });

  // A53：identity 会话零 overview 请求
  test('the identity session probe asserts zero overview requests', () => {
    expect(source).toContain('preview-identity-token');
    expect(source).toContain('A53 an identity session never requests /ui/api/overview');
    expect(source).toContain('A53 ← Overview is out of the tab order');
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
    expect(source).toContain('A64 the IN WINDOW card stays out of the DOM');
    expect(source).toContain('A64 no create button is offered');
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

  // A66 / A67 / A68：品牌、安全上下文闸门、复制反馈
  test('brand, insecure-context, and copy probes are present', () => {
    expect(source).toContain('A66 topbar logo is 24x24');
    expect(source).toContain('[class*="brand-mark"]');
    expect(source).toContain('A66 topbar shows OpenAgent.email exactly once');
    expect(source).toContain("fetch('/ui/favicon.svg')");
    expect(source).toContain('securitypolicyviolation');
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
});
