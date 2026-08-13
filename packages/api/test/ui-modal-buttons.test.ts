/**
 * R3 P1：共享确认框按钮在成功关窗 bump 代际后必须重新可点。
 * 仓库无 jsdom；用既有 new Function 切片基建，抽出真实 onclick/submit 在假 DOM 上跑。
 */
import { describe, expect, test } from 'bun:test';

const { API_JS } = await import('../src/ui/client/api.ts');
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

/** 模拟 closeAllModals / beginModal：成功路径会 bump 代际。 */
async function runExtractedOnclick(onclick: string): Promise<{
  confirm: FakeButton;
  cancel: FakeButton;
}> {
  const confirm: FakeButton = { disabled: false };
  const cancel: FakeButton = { disabled: false };
  const run = new Function(
    'box',
    `
      return (async function () {
        var modalGeneration = 1;
        var openedGen = 1;
        var confirmModalConfirm = box.confirm;
        var confirmModalCancel = box.cancel;
        var address = 'agent@test.example';
        var grant = { id: 'grant-1' };
        var task = { id: 'task-1' };
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
        async function apiJson() { return { token: 'tok' }; }
        function closeAllModals() { modalGeneration += 1; }
        async function apply() { closeAllModals(); }
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
        ${onclick}
        await confirmModalConfirm.onclick();
      })();
    `,
  ) as (box: { confirm: FakeButton; cancel: FakeButton }) => Promise<void>;
  await run({ confirm, cancel });
  return { confirm, cancel };
}

describe('shared modal buttons re-enable after a successful generation bump', () => {
  test('create submit is clickable again after showTokenModal bumps generation', async () => {
    const start = API_JS.indexOf('async function handleCreateSubmit(');
    const end = API_JS.indexOf('async function handleRotateToken(');
    const fnSrc = API_JS.slice(start, end);
    const submit: FakeButton = { disabled: false };
    const run = new Function(
      'box',
      `
        return (async function () {
          var modalGeneration = 1;
          var createModalSubmit = box.submit;
          var createName = { value: 'Bot' };
          var createLocalpart = {
            value: 'bot',
            checkValidity: function () { return true; },
            reportValidity: function () {}
          };
          function isAdmin() { return true; }
          async function apiJson() { return { token: 'tok' }; }
          function showTokenModal() { modalGeneration += 1; }
          function loadOverviewCycle() {}
          function announce() {}
          var window = { alert: function () {} };
          ${fnSrc}
          await handleCreateSubmit();
        })();
      `,
    ) as (box: { submit: FakeButton }) => Promise<void>;
    await run({ submit });
    expect(submit.disabled).toBe(false);
  });

  test('delete confirm is clickable again after closeAllModals bumps generation', async () => {
    const onclick = extractConfirmOnclick(API_JS, 'function handleDeleteIdentity(');
    const { confirm } = await runExtractedOnclick(onclick);
    expect(confirm.disabled).toBe(false);
  });

  test('overview tier-3 Confirm and Cancel re-enable after a successful PUT', async () => {
    const onclick = extractConfirmOnclick(API_JS, 'function handlePushTierChange(');
    const { confirm, cancel } = await runExtractedOnclick(onclick);
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
  });

  test('configure tier-3 Confirm and Cancel re-enable after a successful PUT', async () => {
    const onclick = extractConfirmOnclick(PUSH_DEVICES_PAGE_JS, 'function handleConfigurePushTier(');
    const { confirm, cancel } = await runExtractedOnclick(onclick);
    expect(confirm.disabled).toBe(false);
    expect(cancel.disabled).toBe(false);
  });

  test('revoke confirm is clickable again after closeAllModals bumps generation', async () => {
    const onclick = extractConfirmOnclick(
      AUTHORIZED_CLIENTS_PAGE_JS,
      'function renderConfigureClients(',
    );
    const { confirm } = await runExtractedOnclick(onclick);
    expect(confirm.disabled).toBe(false);
  });

  test('task-close confirm is clickable again after closeAllModals bumps generation', async () => {
    const onclick = extractConfirmOnclick(TASKS_PAGE_JS, 'confirmModalConfirm.onclick');
    const { confirm } = await runExtractedOnclick(onclick);
    expect(confirm.disabled).toBe(false);
  });
});
