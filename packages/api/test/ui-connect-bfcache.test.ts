/**
 * R4/R5：bfcache 复活不得带回 Connect reveal 明文；
 * R5：persisted + connect scope 须重跑 loadConnectPage（面板重载、仍遮蔽）。
 * 仓库无 jsdom；抽出真实 clear / load / 监听体，用可控 Promise 模拟。
 */
import { describe, expect, test } from 'bun:test';

const { CONNECT_PAGE_JS } = await import('../src/ui/client/pages/connect.ts');

function extractClearConnectSensitiveState(): string {
  const start = CONNECT_PAGE_JS.indexOf('function clearConnectSensitiveState(');
  const end = CONNECT_PAGE_JS.indexOf('async function loadConnectPage(');
  if (start < 0 || end <= start) throw new Error('clearConnectSensitiveState slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

function extractLoadConnectPage(): string {
  const start = CONNECT_PAGE_JS.indexOf('async function loadConnectPage(');
  const end = CONNECT_PAGE_JS.indexOf('function enterConnect(');
  if (start < 0 || end <= start) throw new Error('loadConnectPage slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

/** 抽出 pagehide / pageshow 注册块。 */
function extractBfcacheListeners(): string {
  const marker = "window.addEventListener('pagehide'";
  const start = CONNECT_PAGE_JS.indexOf(marker);
  if (start < 0) throw new Error('pagehide listener missing');
  return CONNECT_PAGE_JS.slice(start);
}

type ConnectPayload = {
  endpoint: string;
  identity: string | null;
  token: string | null;
  unavailable: string | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type Harness = {
  state: { scope: string };
  connectLoadGen: { value: number };
  connectCredentialValue: { value: string };
  connectRevealed: { value: boolean };
  connectTokenText: { value: string };
  connectTokenRevealText: { value: string };
  connectTokenCopyDisabled: { value: boolean };
  connectCredentialHidden: { value: boolean };
  connectEndpointText: { value: string };
  connectStateText: { value: string };
  loadCalls: { value: number };
  pulls: Array<Deferred<ConnectPayload>>;
  dispatchPagehide: () => void;
  dispatchPageshow: (persisted: boolean) => void | Promise<void>;
};

function makeHarness(initialScope = 'connect'): Harness {
  const box: {
    state?: { scope: string };
    connectLoadGen?: { value: number };
    connectCredentialValue?: { value: string };
    connectRevealed?: { value: boolean };
    connectTokenText?: { value: string };
    connectTokenRevealText?: { value: string };
    connectTokenCopyDisabled?: { value: boolean };
    connectCredentialHidden?: { value: boolean };
    connectEndpointText?: { value: string };
    connectStateText?: { value: string };
    loadCalls?: { value: number };
    pulls: Array<Deferred<ConnectPayload>>;
    dispatchPagehide?: () => void;
    dispatchPageshow?: (persisted: boolean) => void | Promise<void>;
  } = { pulls: [] };

  new Function(
    'box',
    `
      var state = { scope: ${JSON.stringify(initialScope)} };
      var connectLoadGen = 0;
      var connectCredentialValue = 'oa_bfcache-secret';
      var connectEndpointValue = 'https://mail.example/mcp';
      var connectRevealed = true;
      var connectToken = { textContent: 'oa_bfcache-secret' };
      var connectTokenReveal = {
        textContent: 'Hide',
        setAttribute: function () {},
      };
      var connectTokenCopy = {
        disabled: false,
        title: '',
        removeAttribute: function () {},
      };
      var connectEndpoint = { textContent: 'https://mail.example/mcp' };
      var connectIdentity = { textContent: 'fox@test.example' };
      var connectCredential = { hidden: false };
      var connectCards = { replaceChildren: function () {} };
      var connectState = {
        get textContent() { return box.connectStateText.value; },
        set textContent(v) { box.connectStateText.value = v; },
      };
      box.connectStateText = { value: '' };
      box.loadCalls = { value: 0 };
      function renderConnectCards() {}
      async function apiJson() {
        var pending = { promise: null, resolve: null, reject: null };
        pending.promise = new Promise(function (resolve, reject) {
          pending.resolve = resolve;
          pending.reject = reject;
        });
        box.pulls.push(pending);
        return pending.promise;
      }
      ${extractClearConnectSensitiveState()}
      ${extractLoadConnectPage()}
      var _loadConnectPage = loadConnectPage;
      loadConnectPage = async function () {
        box.loadCalls.value += 1;
        return _loadConnectPage();
      };
      var listeners = { pagehide: null, pageshow: null };
      var window = {
        addEventListener: function (type, fn) {
          listeners[type] = fn;
        },
      };
      ${extractBfcacheListeners()}
      box.state = state;
      box.connectLoadGen = {
        get value() { return connectLoadGen; },
      };
      box.connectCredentialValue = {
        get value() { return connectCredentialValue; },
        set value(v) { connectCredentialValue = v; },
      };
      box.connectRevealed = {
        get value() { return connectRevealed; },
        set value(v) { connectRevealed = v; },
      };
      box.connectTokenText = {
        get value() { return connectToken.textContent; },
        set value(v) { connectToken.textContent = v; },
      };
      box.connectTokenRevealText = {
        get value() { return connectTokenReveal.textContent; },
      };
      box.connectTokenCopyDisabled = {
        get value() { return connectTokenCopy.disabled; },
      };
      box.connectCredentialHidden = {
        get value() { return connectCredential.hidden; },
      };
      box.connectEndpointText = {
        get value() { return connectEndpoint.textContent; },
      };
      box.dispatchPagehide = function () {
        listeners.pagehide({ persisted: true });
      };
      box.dispatchPageshow = function (persisted) {
        return listeners.pageshow({ persisted: persisted });
      };
    `,
  )(box);

  return box as Harness;
}

describe('Connect page bfcache reveal guard (R4/R5)', () => {
  test('pagehide clears plaintext via clearConnectSensitiveState', () => {
    const box = makeHarness();
    expect(box.connectCredentialValue.value).toBe('oa_bfcache-secret');
    expect(box.connectRevealed.value).toBe(true);
    expect(box.connectTokenText.value).toBe('oa_bfcache-secret');

    box.dispatchPagehide();

    // pagehide 后堆内无明文，代际自增，DOM 回遮蔽
    expect(box.connectCredentialValue.value).toBe('');
    expect(box.connectRevealed.value).toBe(false);
    expect(box.connectTokenText.value).toBe('••••••••••••');
    expect(box.connectLoadGen.value).toBe(1);
    expect(box.connectTokenCopyDisabled.value).toBe(true);
  });

  test('pageshow persisted on connect reloads panel without plaintext', async () => {
    const box = makeHarness('connect');
    box.dispatchPagehide();
    expect(box.connectCredentialValue.value).toBe('');

    // 负控：敌对回填明文后再 persisted 复活
    box.connectCredentialValue.value = 'oa_bfcache-secret';
    box.connectRevealed.value = true;
    box.connectTokenText.value = 'oa_bfcache-secret';

    const pageshowDone = Promise.resolve(box.dispatchPageshow(true));
    expect(box.loadCalls.value).toBe(1);
    expect(box.pulls.length).toBe(1);

    // 加载途中：clear 已执行，DOM 无明文、reveal 关
    expect(box.connectCredentialValue.value).toBe('');
    expect(box.connectRevealed.value).toBe(false);
    expect(box.connectTokenText.value).toBe('••••••••••••');
    expect(box.connectTokenCopyDisabled.value).toBe(true);

    box.pulls[0]!.resolve({
      endpoint: 'https://mail.example/mcp',
      identity: 'fox@test.example',
      token: 'oa_fresh-after-bfcache',
      unavailable: null,
    });
    await pageshowDone;

    // 面板重载完成：有 endpoint、凭证区可见，但仍遮蔽（须再 Reveal）
    expect(box.connectEndpointText.value).toBe('https://mail.example/mcp');
    expect(box.connectCredentialHidden.value).toBe(false);
    expect(box.connectCredentialValue.value).toBe('oa_fresh-after-bfcache');
    expect(box.connectRevealed.value).toBe(false);
    expect(box.connectTokenText.value).toBe('••••••••••••');
    expect(box.connectTokenRevealText.value).toBe('Reveal');
    expect(box.connectTokenCopyDisabled.value).toBe(true);
    expect(box.connectTokenText.value).not.toBe('oa_fresh-after-bfcache');
    expect(box.connectTokenText.value).not.toBe('oa_bfcache-secret');
  });

  test('pageshow persisted off connect only clears, does not reload', () => {
    const box = makeHarness('overview');
    box.dispatchPagehide();
    box.dispatchPageshow(true);
    expect(box.loadCalls.value).toBe(0);
    expect(box.connectCredentialValue.value).toBe('');
    expect(box.connectRevealed.value).toBe(false);
    expect(box.connectTokenText.value).toBe('••••••••••••');
  });

  test('pageshow without persisted leaves reveal state alone', () => {
    const box = makeHarness();
    // 首次 pageshow persisted=false 不得误清（正常导航进入）
    box.dispatchPageshow(false);
    expect(box.loadCalls.value).toBe(0);
    expect(box.connectCredentialValue.value).toBe('oa_bfcache-secret');
    expect(box.connectRevealed.value).toBe(true);
    expect(box.connectTokenText.value).toBe('oa_bfcache-secret');
  });
});
