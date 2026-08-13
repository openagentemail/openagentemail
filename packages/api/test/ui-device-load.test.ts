/**
 * R1 Major：设备列表拉取代际。
 * 仓库无 jsdom；抽出真实 loadPairedDevices / clearNotifyState，用可控 Promise 模拟乱序与登出。
 */
import { describe, expect, test } from 'bun:test';

const { API_JS } = await import('../src/ui/client/api.ts');
const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');

function extractLoadPairedDevices(): string {
  const start = PUSH_DEVICES_PAGE_JS.indexOf('async function loadPairedDevices(');
  const end = PUSH_DEVICES_PAGE_JS.indexOf('function enterConfigurePush(');
  if (start < 0 || end <= start) throw new Error('loadPairedDevices slice missing');
  return PUSH_DEVICES_PAGE_JS.slice(start, end);
}

function extractClearNotifyState(): string {
  const start = API_JS.indexOf('function clearNotifyState(');
  const end = API_JS.indexOf('function clearTasksState(');
  if (start < 0 || end <= start) throw new Error('clearNotifyState slice missing');
  return API_JS.slice(start, end);
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type DeviceRow = { id: string; revokeStatus: string };

type Harness = {
  admin: boolean;
  state: {
    devices: DeviceRow[];
    devicesStatus: string;
    deviceLoadGen: number;
    notifyMessages: unknown[];
    notifyStatus: string;
    notifyMessage: string;
    notifyFilter: string;
    notifyUpdatedAt: number;
    notifyFetchKey: string;
    notifyPending: boolean;
    notifyLogItems: unknown[];
    notifyLogFetchKey: string;
    notifyNextCursor: string;
    notifyLevelFilter: string;
    notifyFrom: string;
    notifyTo: string;
    notifyLimit: number;
    notifySource: string;
    notifySummary: unknown;
    notifySummaryStatus: string;
    notifyDiagnostics: unknown;
    notifyRevealed: Record<string, unknown>;
    notifyVerifyPending: boolean;
  };
  pulls: Array<Deferred<{ devices: DeviceRow[] }>>;
  loadPairedDevices: () => Promise<void>;
  clearNotifyState: () => void;
};

function makeHarness(): Harness {
  const box: {
    admin: boolean;
    state?: Harness['state'];
    pulls: Array<Deferred<{ devices: DeviceRow[] }>>;
    loadPairedDevices?: () => Promise<void>;
    clearNotifyState?: () => void;
  } = { admin: true, pulls: [] };

  new Function(
    'box',
    `
      var state = {
        devices: [],
        devicesStatus: 'idle',
        deviceLoadGen: 0,
        notifyMessages: [],
        notifyStatus: 'idle',
        notifyMessage: '',
        notifyFilter: '',
        notifyUpdatedAt: 0,
        notifyFetchKey: '',
        notifyPending: false,
        notifyLogItems: [],
        notifyLogFetchKey: '',
        notifyNextCursor: '',
        notifyLevelFilter: '',
        notifyFrom: '',
        notifyTo: '',
        notifyLimit: 20,
        notifySource: 'log',
        notifySummary: null,
        notifySummaryStatus: 'idle',
        notifyDiagnostics: null,
        notifyRevealed: {},
        notifyVerifyPending: false
      };
      function isAdmin() { return box.admin; }
      function renderPairedDevices() {}
      async function apiJson() {
        var pending = {
          promise: null,
          resolve: null,
          reject: null
        };
        pending.promise = new Promise(function (resolve, reject) {
          pending.resolve = resolve;
          pending.reject = reject;
        });
        box.pulls.push(pending);
        return pending.promise;
      }
      ${extractClearNotifyState()}
      ${extractLoadPairedDevices()}
      box.state = state;
      box.loadPairedDevices = loadPairedDevices;
      box.clearNotifyState = clearNotifyState;
    `,
  )(box);

  return box as Harness;
}

describe('paired-device list generation guard', () => {
  test('stale load must not overwrite a newer pending_revoke row', async () => {
    const box = makeHarness();
    const older = box.loadPairedDevices();
    const newer = box.loadPairedDevices();
    expect(box.pulls.length).toBe(2);

    box.pulls[1].resolve({
      devices: [{ id: 'dev_new', revokeStatus: 'pending_revoke' }],
    });
    await newer;
    expect(box.state.devices).toEqual([{ id: 'dev_new', revokeStatus: 'pending_revoke' }]);
    expect(box.state.devicesStatus).toBe('ready');

    box.pulls[0].resolve({
      devices: [{ id: 'dev_old', revokeStatus: 'active' }],
    });
    await older;
    expect(box.state.devices).toEqual([{ id: 'dev_new', revokeStatus: 'pending_revoke' }]);
    expect(box.state.devicesStatus).toBe('ready');
  });

  test('logout bumps deviceLoadGen so a late response cannot refill devices', async () => {
    const box = makeHarness();
    const inflight = box.loadPairedDevices();
    expect(box.pulls.length).toBe(1);

    box.clearNotifyState();
    expect(box.state.devices).toEqual([]);
    expect(box.state.devicesStatus).toBe('idle');
    const genAfterLogout = box.state.deviceLoadGen;

    box.pulls[0].resolve({
      devices: [{ id: 'dev_leaked', revokeStatus: 'active' }],
    });
    await inflight;
    expect(box.state.devices).toEqual([]);
    expect(box.state.devicesStatus).toBe('idle');
    expect(box.state.deviceLoadGen).toBe(genAfterLogout);
  });
});
