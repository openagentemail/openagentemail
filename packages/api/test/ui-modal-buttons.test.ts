/**
 * R4 P1：共享确认钮双管齐下。
 * T1 stale 请求不得复活新 dialog 的 Confirm；
 * T2 成功关窗 bump 代际后，beginModal 重开必须可点。
 * 仓库无 jsdom；用 new Function 抽出真实 onclick / beginModal 在假按钮上跑。
 */
import { describe, expect, test } from 'bun:test';

const { API_JS } = await import('../src/ui/client/api.ts');
const { MODAL_JS } = await import('../src/ui/client/components/modal.ts');
const { PUSH_DEVICES_PAGE_JS } = await import('../src/ui/client/pages/push-devices.ts');
const { AUTHORIZED_CLIENTS_PAGE_JS } = await import(
  '../src/ui/client/pages/authorized-clients.ts'
);
const { TASKS_PAGE_JS } = await import('../src/ui/client/pages/tasks.ts');

type FakeButton = { disabled: boolean; onclick?: () => Promise<void> };

/** 抽出 confirm 的 async onclick 赋值（到 focus() 之前）。 */
function extractConfirmOnclick(src: string, after: string): string {
  const from = src.indexOf(after);
  if (from < 0) throw new Error('slice start missing: ' + after);
  const region = src.slice(from);
  const start = region.indexOf('confirmModalConfirm.onclick = async function () {');
  if (start < 0) throw new Error('onclick missing after ' + after);
  const focus = region.indexOf('confirmModalConfirm.focus();', start);
  if (focus < 0) throw new Error('focus sentinel missing after ' + after);
  const assignment = region.slice(start, focus).trim();
  if (!assignment.endsWith('};')) throw new Error('onclick assignment truncated');
  return assignment;
}

function extractBeginModal(): string {
  const start = MODAL_JS.indexOf('function beginModal(');
  const end = MODAL_JS.indexOf('function showTokenModal(');
  if (start < 0 || end < 0 || end <= start) throw new Error('beginModal slice missing');
  return MODAL_JS.slice(start, end);
}

function extractCreateSubmit(): string {
  const start = API_JS.indexOf('async function handleCreateSubmit(');
  const end = API_JS.indexOf('async function handleRotateToken(');
  if (start < 0 || end <= start) throw new Error('handleCreateSubmit slice missing');
  return API_JS.slice(start, end);
}

const ONCLICK_STUBS = `
        var address = 'agent@test.example';
        var grant = { id: 'grant-1' };
        var task = { id: 'task-1' };
        var text = 'done';
        var from = address;
        var state = {
          identities: [{ address: address }],
          activeAddress: address,
          messages: [1],
          nextCursor: 'c',
          sourceCache: {},
          returnAddress: address,
          scope: 'configure-identities'
        };
        var window = { alert: function () {} };
        function bumpIdentityEpoch() {}
        function isConfigureScope() { return true; }
        function announce() {}
        function refreshConfigureSurfaces() {}
        function enterOverview() {}
        function loadOverviewCycle() {}
        function clearDetail() {}
        function renderMessages() {}
        function renderIdentities() {}
        function loadConfigureClients() {}
        async function selectTask() {}
        function loadTasks() {}
`;

describe('shared modal buttons: generation-gated finally + beginModal reset', () => {
  test('T1 stale request must not re-enable a newer dialog Confirm', async () => {
    const races: { name: string; src: string; after: string; pair: boolean }[] = [
      { name: 'delete', src: API_JS, after: 'function handleDeleteIdentity(', pair: false },
      { name: 'overview-tier3', src: API_JS, after: 'function handlePushTierChange(', pair: true },
    ];
    for (const race of races) {
      const onclick = extractConfirmOnclick(race.src, race.after);
      const confirm: FakeButton = { disabled: false };
      const cancel: FakeButton = { disabled: false };
      let resolvePending: (value: unknown) => void = () => {};
      const pending = new Promise((resolve) => {
        resolvePending = resolve;
      });
      const run = new Function(
        'box',
        `
          return (async function () {
            var modalGeneration = 1;
            var openedGen = 1;
            var confirmModalConfirm = box.confirm;
            var confirmModalCancel = box.cancel;
            async function apiJson() { return box.pending; }
            function closeAllModals() { modalGeneration += 1; }
            async function apply() { return box.pending; }
            ${ONCLICK_STUBS}
            ${onclick}
            confirmModalConfirm.disabled = true;
            if (box.pair) confirmModalCancel.disabled = true;
            var inflight = confirmModalConfirm.onclick();
            /* Escape / 路由关窗：代际 bump。 */
            closeAllModals();
            /* 新开 dialog：beginModal 复位后再 bump；用户随即点击，钮再次 disabled。 */
            confirmModalConfirm.disabled = false;
            confirmModalCancel.disabled = false;
            modalGeneration += 1;
            confirmModalConfirm.disabled = true;
            confirmModalCancel.disabled = true;
            box.release({ deleted: true });
            await inflight;
            box.finalConfirm = confirmModalConfirm.disabled;
            box.finalCancel = confirmModalCancel.disabled;
          })();
        `,
      ) as (box: {
        confirm: FakeButton;
        cancel: FakeButton;
        pair: boolean;
        pending: Promise<unknown>;
        release: (value: unknown) => void;
        finalConfirm?: boolean;
        finalCancel?: boolean;
      }) => Promise<void>;
      const box = {
        confirm,
        cancel,
        pair: race.pair,
        pending,
        release: (value: unknown) => resolvePending(value),
        finalConfirm: undefined as boolean | undefined,
        finalCancel: undefined as boolean | undefined,
      };
      await run(box);
      expect(box.finalConfirm).toBe(true);
      expect(confirm.disabled).toBe(true);
      if (race.pair) {
        expect(box.finalCancel).toBe(true);
        expect(cancel.disabled).toBe(true);
      }
    }
  });

  test('T2 beginModal re-enables buttons after a successful generation bump', async () => {
    const beginModalSrc = extractBeginModal();
    const flows: { name: string; src: string; after: string; pair: boolean }[] = [
      { name: 'delete', src: API_JS, after: 'function handleDeleteIdentity(', pair: false },
      { name: 'overview-tier3', src: API_JS, after: 'function handlePushTierChange(', pair: true },
      {
        name: 'configure-tier3',
        src: PUSH_DEVICES_PAGE_JS,
        after: 'function handleConfigurePushTier(',
        pair: true,
      },
      {
        name: 'revoke',
        src: AUTHORIZED_CLIENTS_PAGE_JS,
        after: 'function renderConfigureClients(',
        pair: false,
      },
      { name: 'task-close', src: TASKS_PAGE_JS, after: 'confirmModalConfirm.onclick', pair: false },
    ];
    for (const flow of flows) {
      const onclick = extractConfirmOnclick(flow.src, flow.after);
      const confirm: FakeButton = { disabled: false };
      const cancel: FakeButton = { disabled: false };
      const submit: FakeButton = { disabled: false };
      const run = new Function(
        'box',
        `
          return (async function () {
            var modalGeneration = 1;
            var openedGen = 1;
            var confirmModalConfirm = box.confirm;
            var confirmModalCancel = box.cancel;
            var createModalSubmit = box.submit;
            var modalOpener = null;
            var document = { body: { id: 'body' }, activeElement: null };
            function elementInsideModal() { return false; }
            async function apiJson() { return { token: 'tok' }; }
            function closeAllModals(options) {
              var opts = options || {};
              if (!opts.keepGeneration) modalGeneration += 1;
            }
            async function apply() { closeAllModals(); }
            ${ONCLICK_STUBS}
            ${onclick}
            ${beginModalSrc}
            await confirmModalConfirm.onclick();
            box.afterSuccessConfirm = confirmModalConfirm.disabled;
            box.afterSuccessCancel = confirmModalCancel.disabled;
            beginModal();
            box.afterBeginConfirm = confirmModalConfirm.disabled;
            box.afterBeginCancel = confirmModalCancel.disabled;
            box.afterBeginSubmit = createModalSubmit.disabled;
          })();
        `,
      ) as (box: {
        confirm: FakeButton;
        cancel: FakeButton;
        submit: FakeButton;
        afterSuccessConfirm?: boolean;
        afterSuccessCancel?: boolean;
        afterBeginConfirm?: boolean;
        afterBeginCancel?: boolean;
        afterBeginSubmit?: boolean;
      }) => Promise<void>;
      const box = {
        confirm,
        cancel,
        submit,
        afterSuccessConfirm: undefined as boolean | undefined,
        afterSuccessCancel: undefined as boolean | undefined,
        afterBeginConfirm: undefined as boolean | undefined,
        afterBeginCancel: undefined as boolean | undefined,
        afterBeginSubmit: undefined as boolean | undefined,
      };
      await run(box);
      expect(box.afterSuccessConfirm, flow.name + ' leftover after success').toBe(true);
      if (flow.pair) {
        expect(box.afterSuccessCancel, flow.name + ' cancel leftover after success').toBe(true);
      }
      expect(box.afterBeginConfirm, flow.name + ' confirm after beginModal').toBe(false);
      expect(box.afterBeginCancel, flow.name + ' cancel after beginModal').toBe(false);
      expect(box.afterBeginSubmit, flow.name + ' create submit after beginModal').toBe(false);
    }

    const createSrc = extractCreateSubmit();
    const submit: FakeButton = { disabled: false };
    const confirm: FakeButton = { disabled: false };
    const cancel: FakeButton = { disabled: false };
    const runCreate = new Function(
      'box',
      `
        return (async function () {
          var modalGeneration = 1;
          var createModalSubmit = box.submit;
          var confirmModalConfirm = box.confirm;
          var confirmModalCancel = box.cancel;
          var modalOpener = null;
          var document = { body: { id: 'body' }, activeElement: null };
          function elementInsideModal() { return false; }
          var createName = { value: 'Bot' };
          var createLocalpart = {
            value: 'bot',
            checkValidity: function () { return true; },
            reportValidity: function () {}
          };
          function isAdmin() { return true; }
          async function apiJson() { return { token: 'tok' }; }
          function closeAllModals(options) {
            var opts = options || {};
            if (!opts.keepGeneration) modalGeneration += 1;
          }
          function loadOverviewCycle() {}
          function announce() {}
          var window = { alert: function () {} };
          ${beginModalSrc}
          function showTokenModal() { beginModal(); }
          ${createSrc}
          await handleCreateSubmit();
          box.afterSuccess = createModalSubmit.disabled;
          createModalSubmit.disabled = true;
          beginModal();
          box.afterBegin = createModalSubmit.disabled;
        })();
      `,
    ) as (box: {
      submit: FakeButton;
      confirm: FakeButton;
      cancel: FakeButton;
      afterSuccess?: boolean;
      afterBegin?: boolean;
    }) => Promise<void>;
    const createBox = {
      submit,
      confirm,
      cancel,
      afterSuccess: undefined as boolean | undefined,
      afterBegin: undefined as boolean | undefined,
    };
    await runCreate(createBox);
    /* showTokenModal → beginModal 已复位；再 disable 后重开仍可点。 */
    expect(createBox.afterSuccess).toBe(false);
    expect(createBox.afterBegin).toBe(false);
  });
});
