// Debt batch 2 R0: contract tests only.  These cases intentionally remain RED
// until #74, #81, #86, and #79 are implemented in the shared production paths.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test as bunTest } from 'bun:test';
import { Hono } from 'hono';
import type { SendInput } from '../src/lib/smtp.ts';
import type { Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-debt-batch2-r0-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const {
  claimTask,
  approvalActionDigest,
  canonicalApprovalAction,
  clearQueuedEventsForTests,
  createApprovalTask,
  renewTask,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskService,
  toTaskView,
  toUiTaskView,
} = await import('../src/lib/tasks.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { createApp } = await import('../src/app.ts');
const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const REQUESTER = 'r0-requester@test.example';
const RECIPIENT = 'r0-recipient@test.example';
const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const START = Date.parse('2026-08-24T00:00:00.000Z');

for (const localpart of ['r0-requester', 'r0-recipient']) {
  const address = `${localpart}@test.example`;
  if (!findIdentity(address)) createIdentity({ localpart, issueToken: false });
}

function submittedTask(): Task {
  return {
    id: ID,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'R0 lease fixture',
    state: 'submitted',
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    messages: [{
      id: '1', from: REQUESTER, to: RECIPIENT, subject: 'R0 lease fixture',
      date: new Date(START).toISOString(), state: 'submitted', body: 'Please work this task.',
    }],
  };
}

function actionAtCanonicalBytes(bytes: number) {
  const action = { type: 'tool', name: 'sized', arguments: { value: '' } };
  action.arguments.value = 'x'.repeat(bytes - canonicalApprovalAction(action).length);
  // Sorting keys does not change this action's serialized byte count.
  expect(Buffer.byteLength(JSON.stringify(action), 'utf8')).toBe(bytes);
  return action;
}

/** Root-inclusive JSON depth: the complete action is depth 1. */
function actionAtDepth(depth: number) {
  let argumentsValue: unknown = 'leaf';
  for (let current = 2; current < depth; current += 1) argumentsValue = { nested: argumentsValue };
  return { type: 'tool', name: `depth-${depth}`, arguments: argumentsValue };
}

function appFor(service: TaskService = taskService, actor = RECIPIENT) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { kind: 'identity' as const, address: actor });
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => findIdentity(address),
  }));
  return app;
}

async function post(app: Hono, path: string, body: unknown) {
  const response = await app.request(`/v1/tasks/${ID}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  setTaskNowForTests(() => START);
});

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#74 approval bounds', () => {
  test('shared core accepts exact bounds and rejects 64KB/depth/lifetime overages before delivery', async () => {
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<unexpected-r0-approval>' };
    });
    const actionAt64KiB = actionAtCanonicalBytes(64 * 1024);
    const cases = [
      {
        expected: 'accepted',
        action: actionAtCanonicalBytes(64 * 1024 - 1),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'accepted',
        action: actionAt64KiB,
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'accepted',
        action: actionAtDepth(9),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'accepted',
        action: actionAtDepth(10),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'accepted',
        action: { type: 'tool', name: 'expiry-before', arguments: {} },
        expiresAt: '2026-09-22T23:59:59.999Z',
      },
      {
        expected: 'accepted',
        action: { type: 'tool', name: 'expiry-exact', arguments: {} },
        expiresAt: '2026-09-23T00:00:00.000Z',
      },
      {
        expected: 'approval_action_too_large',
        action: actionAtCanonicalBytes(64 * 1024 + 1),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'approval_action_too_deep',
        action: actionAtDepth(11),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'approval_action_too_deep',
        action: actionAtDepth(10_000),
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
      {
        expected: 'approval_expiry_too_far',
        action: { type: 'tool', name: 'future', arguments: {} },
        expiresAt: '2026-09-23T00:00:00.001Z',
      },
    ];
    const results = await Promise.all(cases.map(async ({ expected, action, expiresAt }) => {
      try {
        await createApprovalTask({ from: REQUESTER, to: RECIPIENT, subject: expected, action, expiresAt });
        return 'accepted';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }));
    expect({ results, sent: sent.length }).toEqual({
      results: cases.map(({ expected }) => expected),
      sent: 6,
    });
    const stable = await createApprovalTask({
      from: REQUESTER, to: RECIPIENT, subject: 'stable digest',
      action: actionAt64KiB, expiresAt: '2026-08-25T00:00:00.000Z',
    });
    expect(stable.approval.digest).toBe(approvalActionDigest(actionAt64KiB));
    expect(sent).toHaveLength(7);
  });

  test('REST and MCP preserve the same stable 400 approval-bound error envelope', async () => {
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<unexpected-r0-rest-${sent.length}>` };
    });
    const app = appFor(taskService, REQUESTER);
    const body = {
      to: RECIPIENT,
      subject: 'oversize approval',
      kind: 'approval',
      approval: {
        action: { type: 'tool', name: 'large', arguments: { value: 'x'.repeat(70_000) } },
        expiresAt: '2026-08-25T00:00:00.000Z',
      },
    };
    const rest = await app.request('/v1/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const client = new OpenAgentEmailClient('http://test.invalid', 'r0-token', (url, init) =>
      app.request(new Request(String(url), init)),
    );
    const mcp = await client.createApprovalTask(
      RECIPIENT, body.subject, body.approval.action, body.approval.expiresAt,
    ).then(
      () => ({ status: 'accepted', error: null }),
      (error: unknown) => ({ status: (error as { status?: unknown }).status, error: String(error) }),
    );
    const restBody = await rest.json() as { error?: unknown };
    expect({
      rest: { status: rest.status, error: restBody.error ?? null },
      mcp,
      sent: sent.length,
    }).toEqual({
      rest: { status: 400, error: 'approval_action_too_large' },
      mcp: { status: 400, error: expect.stringContaining('approval_action_too_large') },
      sent: 0,
    });
  });
});

describe('#81 renewal tenure', () => {
  test('a server-clock renewal before the 24h boundary is capped at the initial-claim 24h anchor', async () => {
    let now = START;
    let durable = submittedTask();
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async () => ({ messageId: '<r0-tenure>' }));
    const claim = await claimTask({ id: ID, from: RECIPIENT, leaseSec: 3600 });
    durable = claim.task;
    let renewed = claim.task;
    // The existing maximum duration is one hour, so keep the holder current
    // with production renewals until the 24h initial-claim boundary.
    for (let renewal = 0; renewal < 24; renewal += 1) {
      now = Date.parse(durable.lease!.claimedUntil) - 1;
      clearQueuedEventsForTests(); // each turn is a restart/rebuild boundary.
      renewed = await renewTask({ id: ID, from: RECIPIENT, leaseToken: claim.leaseToken, leaseSec: 3600 });
      durable = renewed;
    }
    expect(renewed.lease?.claimedUntil).toBe('2026-08-25T00:00:00.000Z');
  });

  test('the seven-day task cap rejects a post-cap reclaim without granting a new generation', async () => {
    let now = START;
    let durable = submittedTask();
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async () => ({ messageId: '<r0-task-cap>' }));
    const first = await claimTask({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = first.task;
    clearQueuedEventsForTests();
    now = START + 7 * 24 * 60 * 60 * 1000;
    await expect(claimTask({ id: ID, from: RECIPIENT })).rejects.toThrow('lease_task_cap_exhausted');
  });

  test('REST and MCP relay ordinary-deadline and task-cap conflicts without delivery', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<r0-cap-${sent.length}>` }; });
    const grant = await claimTask({ id: ID, from: RECIPIENT, leaseSec: 3600 });
    durable = grant.task;
    const app = appFor(taskService, RECIPIENT);
    const client = new OpenAgentEmailClient('http://test.invalid', 'r0-token', (url, init) => app.request(new Request(String(url), init)));

    now = START + 24 * 60 * 60 * 1_000;
    const renew = await post(app, 'lease', { leaseToken: grant.leaseToken, leaseSec: 300 });
    const mcpRenew = await client.renewTask(ID, grant.leaseToken, 300).then(
      () => 'accepted', (error: unknown) => ({ status: (error as { status?: unknown }).status, message: String(error) }),
    );
    now = START + 7 * 24 * 60 * 60 * 1_000;
    const claim = await post(app, 'claim', { leaseSec: 300 });
    const mcpClaim = await client.claimTask(ID, 300).then(
      () => 'accepted', (error: unknown) => ({ status: (error as { status?: unknown }).status, message: String(error) }),
    );
    expect({ renew, mcpRenew, claim, mcpClaim, sent: sent.length }).toEqual({
      renew: { status: 409, body: { error: 'stale_lease' } },
      mcpRenew: { status: 409, message: expect.stringContaining('stale_lease') },
      claim: { status: 409, body: { error: 'lease_task_cap_exhausted' } },
      mcpClaim: { status: 409, message: expect.stringContaining('lease_task_cap_exhausted') },
      sent: 1,
    });
  });

  test('lease anchors stay out of REST, MCP, UI, list, and outgoing mail projections', async () => {
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<r0-private-${sent.length}>` }; });
    const grant = await claimTask({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = grant.task;
    const service: TaskService = {
      ...taskService,
      list: async () => [durable],
      get: async () => durable,
      getForAuthorization: async () => durable,
    };
    const app = appFor(service, RECIPIENT);
    const client = new OpenAgentEmailClient('http://test.invalid', 'r0-token', (url, init) => app.request(new Request(String(url), init)));
    const detail = await app.request(`/v1/tasks/${ID}`);
    const list = await app.request('/v1/tasks');
    const publicPayloads = [
      await detail.text(),
      await list.text(),
      JSON.stringify(await client.listTasks()),
      JSON.stringify(toUiTaskView(durable)),
      JSON.stringify(sent),
    ];
    for (const payload of publicPayloads) {
      expect(payload).not.toContain('firstClaimedAt');
      expect(payload).not.toContain('generationClaimedAt');
    }
  });
});

describe('#86 disabled durable leases', () => {
  test('flag-off REST, board/UI projection, and MCP retain the durable lease while labelling it disabled', async () => {
    const durable: Task = {
      ...submittedTask(),
      state: 'working',
      lease: {
        claimedUntil: '2026-08-24T00:05:00.000Z', leaseGeneration: 3,
        tokenVerifier: 'r0-test-verifier-which-is-never-projected-000',
      },
    };
    const service: TaskService = {
      create: async () => { throw new Error('unused'); },
      list: async () => [durable],
      listBoard: async () => ({ tasks: [toUiTaskView(durable)], nextCursor: null, totalApprox: 1, queryNow: new Date(START).toISOString() }),
      get: async () => durable,
      getForAuthorization: async () => durable,
      update: async () => durable,
      reply: async () => durable,
      remind: async () => durable,
      close: async () => durable,
      waitForTerminal: async () => durable,
    };
    await withTaskLeasesEnabledForTests(false, async () => {
      const app = appFor(service);
      const list = await app.request('/v1/tasks');
      const detail = await app.request(`/v1/tasks/${ID}`);
      const client = new OpenAgentEmailClient('http://test.invalid', 'r0-token', (url, init) =>
        app.request(new Request(String(url), init)),
      );
      const restList = (await list.json() as { tasks: Array<Record<string, unknown>> }).tasks[0]!;
      const restDetail = await detail.json() as Record<string, unknown>;
      const ui = toUiTaskView(durable) as Record<string, unknown>;
      const mcp = (await client.listTasks())[0] as unknown as Record<string, unknown>;
      const past = {
        ...durable,
        lease: { ...durable.lease!, claimedUntil: '2026-08-23T23:59:59.999Z' },
      };
      expect({
        restList: [restList.claimedUntil, restList.leaseGeneration, restList.leaseStatus],
        restDetail: [restDetail.claimedUntil, restDetail.leaseGeneration, restDetail.leaseStatus],
        uiBoard: [ui.claimedUntil, ui.leaseGeneration, ui.leaseStatus],
        mcp: [mcp?.claimedUntil, mcp?.leaseGeneration, mcp?.leaseStatus],
        past: [toTaskView(past).claimedUntil, toTaskView(past).leaseGeneration, toTaskView(past).leaseStatus],
        privateFieldsAbsent: !JSON.stringify({ restList, restDetail, ui, mcp, past: toTaskView(past) }).match(/tokenVerifier|leaseToken|firstClaimedAt|generationClaimedAt/),
        durableAuthorityRetained: durable.lease?.leaseGeneration,
      }).toEqual({
        restList: ['2026-08-24T00:05:00.000Z', 3, 'disabled'],
        restDetail: ['2026-08-24T00:05:00.000Z', 3, 'disabled'],
        uiBoard: ['2026-08-24T00:05:00.000Z', 3, 'disabled'],
        mcp: ['2026-08-24T00:05:00.000Z', 3, 'disabled'],
        past: ['2026-08-23T23:59:59.999Z', 3, 'disabled'],
        privateFieldsAbsent: true,
        durableAuthorityRetained: 3,
      });
    });
  });
});

describe('#79 dual-track lease errors', () => {
  test('a wrong authenticated lease credential gets task_lease_required while omission retains task_already_terminal, with no writes', async () => {
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r0-fence-${sent.length}>` };
    });
    const grant = await claimTask({ id: ID, from: RECIPIENT });
    durable = grant.task;
    const app = appFor();
    const omitted = await post(app, 'state', { state: 'input-required' });
    const wrong = await post(app, 'state', { state: 'input-required', leaseToken: 'wrong-r0-lease-token' });
    const empty = await post(app, 'state', { state: 'input-required', leaseToken: '' });
    const client = new OpenAgentEmailClient('http://test.invalid', 'r0-token', (url, init) =>
      app.request(new Request(String(url), init)),
    );
    const mcpError = await client.updateTask(ID, 'input-required', undefined, undefined, 'wrong-r0-lease-token')
      .catch((error: unknown) => error);
    expect({
      omitted,
      wrong,
      empty,
      mcp: { status: (mcpError as { status?: unknown }).status, message: String(mcpError) },
      privateFree: !JSON.stringify({ omitted, wrong, empty, mcpError }).match(/wrong-r0-lease-token|tokenVerifier|firstClaimedAt|generationClaimedAt/),
      sends: sent.length,
      state: durable.state,
    }).toEqual({
      omitted: { status: 409, body: { error: 'task_already_terminal' } },
      wrong: { status: 409, body: { error: 'task_lease_required' } },
      empty: { status: 409, body: { error: 'task_lease_required' } },
      mcp: { status: 409, message: expect.stringContaining('task_lease_required') },
      privateFree: true,
      sends: 1,
      state: 'working',
    });
  });

  test('a truly unauthenticated REST state request remains 401 before task service access', async () => {
    let reads = 0;
    const unused = async () => { throw new Error('unauthenticated route must not invoke this service'); };
    const service: TaskService = {
      create: unused, list: unused, listBoard: unused,
      get: async () => { reads += 1; return submittedTask(); },
      update: unused, reply: unused, remind: unused, close: unused, waitForTerminal: unused,
    };
    const app = createApp({ uiEnabled: false, taskService: service });
    const response = await app.request(`/v1/tasks/${ID}/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'input-required' }),
    });
    expect({ status: response.status, body: await response.json(), reads }).toEqual({
      status: 401, body: { error: 'unauthorized' }, reads: 0,
    });
  });
});
