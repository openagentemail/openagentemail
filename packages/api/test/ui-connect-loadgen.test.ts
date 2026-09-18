/**
 * R2：Connect 页 loadConnectPage 代际守卫。
 * 仓库无 jsdom；抽出真实 loadConnectPage / clearConnectSensitiveState，
 * 用可控 Promise 模拟 logout 后迟到响应不得复活明文。
 */
import { describe, expect, test } from 'bun:test';

const { CONNECT_PAGE_JS } = await import('../src/ui/client/pages/connect.ts');

function extractLoadConnectPage(): string {
  const start = CONNECT_PAGE_JS.indexOf('async function loadConnectPage(');
  const end = CONNECT_PAGE_JS.indexOf('function enterConnect(');
  if (start < 0 || end <= start) throw new Error('loadConnectPage slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

function extractClearConnectSensitiveState(): string {
  const start = CONNECT_PAGE_JS.indexOf('function clearConnectSensitiveState(');
  const end = CONNECT_PAGE_JS.indexOf('async function loadConnectPage(');
  if (start < 0 || end <= start) throw new Error('clearConnectSensitiveState slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type ConnectPayload = {
  endpoint: string;
  identity: string | null;
  token: string | null;
  unavailable: string | null;
};

type Harness = {
  state: { scope: string };
  connectLoadGen: { value: number };
  connectCredentialValue: { value: string };
  connectEndpointValue: { value: string };
  connectRevealed: { value: boolean };
  connectStateText: { value: string };
  connectCredentialHidden: { value: boolean };
  pulls: Array<Deferred<ConnectPayload>>;
  loadConnectPage: () => Promise<void>;
  clearConnectSensitiveState: () => void;
};

function makeHarness(initialScope = 'connect'): Harness {
  const box: {
    state?: Harness['state'];
    connectLoadGen?: { value: number };
    connectCredentialValue?: { value: string };
    connectEndpointValue?: { value: string };
    connectRevealed?: { value: boolean };
    connectStateText?: { value: string };
    connectCredentialHidden?: { value: boolean };
    pulls: Array<Deferred<ConnectPayload>>;
    loadConnectPage?: () => Promise<void>;
    clearConnectSensitiveState?: () => void;
  } = { pulls: [] };

  new Function(
    'box',
    `
      var state = { scope: ${JSON.stringify(initialScope)} };
      var connectLoadGen = 0;
      var connectCredentialValue = '';
      var connectEndpointValue = '';
      var connectRevealed = false;
      var connectToken = { textContent: '••••••••••••' };
      var connectTokenReveal = {
        textContent: 'Reveal',
        setAttribute: function () {},
      };
      var connectTokenCopy = { disabled: true, title: '', removeAttribute: function () {} };
      var connectEndpoint = { textContent: '' };
      var connectIdentity = { textContent: '' };
      var connectCredential = { hidden: true };
      var connectCards = { replaceChildren: function () {} };
      var connectState = {
        get textContent() { return box.connectStateText.value; },
        set textContent(v) { box.connectStateText.value = v; },
      };
      box.connectStateText = { value: '' };
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
      box.state = state;
      box.connectLoadGen = {
        get value() { return connectLoadGen; },
      };
      box.connectCredentialValue = {
        get value() { return connectCredentialValue; },
      };
      box.connectEndpointValue = {
        get value() { return connectEndpointValue; },
      };
      box.connectRevealed = {
        get value() { return connectRevealed; },
      };
      box.connectCredentialHidden = {
        get value() { return connectCredential.hidden; },
      };
      box.loadConnectPage = loadConnectPage;
      box.clearConnectSensitiveState = clearConnectSensitiveState;
    `,
  )(box);

  return box as Harness;
}

describe('Connect page loadConnectPage generation guard (R2)', () => {
  test('logout bumps connectLoadGen so a late response cannot revive plaintext', async () => {
    const box = makeHarness('connect');
    const inflight = box.loadConnectPage();
    expect(box.pulls.length).toBe(1);
    const genDuringLoad = box.connectLoadGen.value;

    // 模拟 showLogin / logout → clearConnectSensitiveState
    box.clearConnectSensitiveState();
    expect(box.connectLoadGen.value).toBe(genDuringLoad + 1);
    expect(box.connectCredentialValue.value).toBe('');

    box.pulls[0]!.resolve({
      endpoint: 'https://mail.example/mcp',
      identity: 'fox@test.example',
      token: 'oa_leaked-secret',
      unavailable: null,
    });
    await inflight;

    // 迟到响应不得写入明文
    expect(box.connectCredentialValue.value).toBe('');
    expect(box.connectEndpointValue.value).toBe('');
    expect(box.connectCredentialHidden.value).toBe(true);
    expect(box.connectRevealed.value).toBe(false);
  });

  test('scope leaving connect also drops a late plaintext payload', async () => {
    const box = makeHarness('connect');
    const inflight = box.loadConnectPage();
    box.state.scope = 'overview';
    box.clearConnectSensitiveState();

    box.pulls[0]!.resolve({
      endpoint: 'https://mail.example/mcp',
      identity: 'fox@test.example',
      token: 'oa_leaked-secret',
      unavailable: null,
    });
    await inflight;
    expect(box.connectCredentialValue.value).toBe('');
  });
});
