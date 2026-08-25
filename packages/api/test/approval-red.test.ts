// #55 R1b behavioral RED. This file intentionally changes no production
// source. Every fixture is inert; no credential-like value appears in action
// arguments or in an RFC-822 payload.
import { afterEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { SendInput } from '../src/lib/smtp.ts';
import type { ApprovalTask, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.DATA_DIR = '/tmp/oae-approval-red';

const tasks = await import('../src/lib/tasks.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const { processWatchedMessage } = await import('../src/lib/notification-watcher.ts');
const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');

const REQUESTER = 'requester@test.example';
const REVIEWER = 'reviewer@test.example';
const OUTSIDER = 'outsider@test.example';
const ID = '2c3d77bc-6e13-48bb-b470-f394cd73a60f';
const EXPIRES = '2030-08-25T00:00:00.000Z';
const ACTION = {
  type: 'deployment',
  name: 'publish-preview',
  arguments: { html: '<img src=x onerror=alert(1)>', flags: ['safe', 'dry-run'], retries: 2 },
};

for (const localpart of ['requester', 'reviewer', 'outsider']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

type ApprovalModule = typeof tasks & {
  canonicalApprovalAction?: (action: unknown) => string;
  approvalActionDigest?: (action: unknown) => string;
  createApprovalTask?: (input: {
    from: string; to: string; subject: string; body?: string; action: unknown; expiresAt: string;
  }) => Promise<ApprovalTask>;
  decideApprovalTask?: (input: {
    id: string; from: string; decision: 'approved' | 'rejected';
  }) => Promise<ApprovalTask>;
  /** R1b test seam: invokes the private production IMAP parser on this source. */
  parseStampedTaskMessageForTests?: (input: {
    id: string; uid: number; source: string; internalDate: string;
  }) => Promise<unknown | null>;
  /** R1b test seam: produces a normal server-stamped approval decision event. */
  encodeStampedApprovalDecisionForTests?: (input: {
    id: string; from: string; to: string; subject: string; digest: string;
    decision: 'approved' | 'rejected'; decidedAt: string;
  }) => string;
  /** R1b test seam: produces the same source sent for a server request. */
  encodeStampedApprovalRequestForTests?: (input: {
    id: string; from: string; to: string; subject: string; body: string;
    action: unknown; expiresAt: string;
  }) => string;
};

function api(): ApprovalModule {
  return tasks as ApprovalModule;
}

function rfc822(sent: SendInput): string {
  const headers = Object.entries(sent.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return [`From: ${sent.from}`, `To: ${sent.to.join(', ')}`, `Subject: ${sent.subject}`, headers, '', sent.text].join('\r\n');
}

function installSentCapture() {
  const sent: SendInput[] = [];
  tasks.setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<approval-red-${sent.length}@test.example>` };
  });
  return sent;
}

async function requestFixture(
  expiresAt = EXPIRES,
  action: { type: string; name: string; arguments: unknown } = ACTION,
  body = 'Record only; do not execute.',
): Promise<{ task: ApprovalTask; sent: SendInput[] }> {
  const create = api().createApprovalTask;
  expect(create, 'approval request service behavior is missing').toBeFunction();
  const sent = installSentCapture();
  const task = await create!({
    from: REQUESTER, to: REVIEWER, subject: 'Approve preview',
    body, action, expiresAt,
  });
  return { task, sent };
}

function appFor(
  auth: { kind: 'admin' } | { kind: 'identity'; address: string },
  service = tasks.taskService,
) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => [REQUESTER, REVIEWER, OUTSIDER].includes(address.toLowerCase())
      ? { address, createdAt: '2026-08-24T00:00:00.000Z' }
      : undefined,
  }));
  return app;
}

afterEach(() => {
  tasks.setTaskGetForTests(null);
  tasks.setTaskSendMailForTests(null);
  tasks.clearQueuedEventsForTests();
  tasks.setTaskNowForTests(null);
});

describe('#55 R1b: canonical request behavior', () => {
  test('canonical-equivalent requests receive one digest while changed content and array order diverge', () => {
    const { canonicalApprovalAction, approvalActionDigest } = api();
    expect(canonicalApprovalAction, 'canonical JSON behavior is missing').toBeFunction();
    expect(approvalActionDigest, 'SHA-256 digest behavior is missing').toBeFunction();
    const reordered = {
      arguments: { retries: 2, flags: ['safe', 'dry-run'], html: '<img src=x onerror=alert(1)>' },
      name: 'publish-preview', type: 'deployment',
    };
    const changed = { ...ACTION, arguments: { ...ACTION.arguments, retries: 3 } };
    const reorderedArray = { ...ACTION, arguments: { ...ACTION.arguments, flags: ['dry-run', 'safe'] } };
    expect(canonicalApprovalAction!(ACTION)).toBe(
      '{"arguments":{"flags":["safe","dry-run"],"html":"<img src=x onerror=alert(1)>","retries":2},"name":"publish-preview","type":"deployment"}',
    );
    expect(approvalActionDigest!(reordered)).toBe(approvalActionDigest!(ACTION));
    expect(approvalActionDigest!(changed)).not.toBe(approvalActionDigest!(ACTION));
    expect(approvalActionDigest!(reorderedArray)).not.toBe(approvalActionDigest!(ACTION));
  });

  test('approval creation rejects self at the service boundary and an unknown reviewer at the route boundary before mail writes', async () => {
    const create = api().createApprovalTask;
    expect(create, 'approval creation service behavior is missing').toBeFunction();
    const sent = installSentCapture();
    await expect(create!({
      from: REQUESTER, to: REQUESTER, subject: 'Self approval',
      body: 'Record only; do not execute.', action: ACTION, expiresAt: EXPIRES,
    })).rejects.toThrow('approval_participants_must_differ');
    expect(sent).toHaveLength(0);

    const unknown = await appFor({ kind: 'identity', address: REQUESTER }).request('/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'unknown@test.example', subject: 'Unknown reviewer', body: 'Record only; do not execute.',
        kind: 'approval', approval: { action: ACTION, expiresAt: EXPIRES },
      }),
    });
    expect(unknown.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('an already-expired approval create is a stable client error through REST and MCP client', async () => {
    const sent = installSentCapture();
    const app = appFor({ kind: 'identity', address: REQUESTER });
    const expiredBody = {
      to: REVIEWER, subject: 'Expired approval', body: 'Record only; do not execute.',
      kind: 'approval', approval: { action: ACTION, expiresAt: '2020-01-01T00:00:00.000Z' },
    };
    const rest = await app.request('/v1/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(expiredBody),
    });
    expect(rest.status).toBe(400);
    expect(await rest.json()).toEqual({ error: 'invalid_request' });
    expect(sent).toHaveLength(0);

    const client = new OpenAgentEmailClient('http://test.invalid', 'token', (url, init) =>
      app.request(new Request(String(url), init)),
    );
    const clientError = await client.createApprovalTask(
      REVIEWER, 'Expired approval', ACTION, '2020-01-01T00:00:00.000Z', 'Record only; do not execute.',
    ).catch((error: unknown) => error);
    expect(clientError).toMatchObject({ status: 400 });
    expect(String(clientError)).toContain('invalid_request');
    expect(String(clientError)).not.toMatch(/smtp|upstream/i);
    expect(sent).toHaveLength(0);
  });
});

describe('#55 R1b: one decision, terminal result, and ACL', () => {
  test('two concurrent decisions emit one terminal event; repeat and expiry are conflicts', async () => {
    const decide = api().decideApprovalTask;
    expect(decide, 'lock-protected decision behavior is missing').toBeFunction();
    const { task, sent } = await requestFixture();
    tasks.setTaskGetForTests(async () => task);
    await expect(tasks.updateTask({
      id: task.id, from: REVIEWER, state: 'completed', result: { decision: 'approved' },
    })).rejects.toThrow('approval_decision_required');
    expect(sent).toHaveLength(1);
    const settled = await Promise.allSettled([
      decide!({ id: task.id, from: REVIEWER, decision: 'approved' }),
      decide!({ id: task.id, from: REVIEWER, decision: 'rejected' }),
    ]);
    expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(sent).toHaveLength(2); // request + exactly one terminal decision
    await expect(decide!({ id: task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow('task_already_decided');

    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const expired = await requestFixture('2026-08-24T00:00:00.000Z');
    tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:00:00.000Z'));
    tasks.setTaskGetForTests(async () => expired.task);
    await expect(decide!({ id: expired.task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow('task_expired');
  });

  test('lazy expiry materializes for no-click detail/wait reads and races exactly once at the boundary', async () => {
    const decide = api().decideApprovalTask;
    expect(decide, 'lock-protected expiry materializer is missing').toBeFunction();
    const boundary = '2026-08-24T00:00:00.000Z';

    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const before = await requestFixture(boundary);
    tasks.setTaskGetForTests(async () => before.task);
    await expect(decide!({ id: before.task.id, from: REVIEWER, decision: 'approved' })).resolves.toMatchObject({ state: 'completed' });
    expect(before.sent).toHaveLength(2);
    tasks.clearQueuedEventsForTests();

    const noClick = await requestFixture(boundary);
    tasks.setTaskNowForTests(() => Date.parse(boundary));
    tasks.setTaskGetForTests(async () => noClick.task);
    let noClickTicks = 0;
    const [detail, waited] = await Promise.all([
      tasks.getTask(noClick.task.id),
      tasks.waitForTaskTerminalWith(noClick.task.id, REQUESTER, 1, {
        waitForMessage: async () => null,
        now: () => (++noClickTicks < 4 ? 0 : 2_000),
      }),
    ]);
    expect(detail).toMatchObject({ state: 'failed', result: { decision: 'expired', digest: noClick.task.approval.digest, expiredAt: boundary } });
    expect(waited).toMatchObject({ state: 'failed', result: { decision: 'expired', digest: noClick.task.approval.digest, expiredAt: boundary } });
    expect(noClick.sent).toHaveLength(2); // request + one lazy signed expiry
    tasks.clearQueuedEventsForTests();

    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const raced = await requestFixture(boundary);
    tasks.setTaskNowForTests(() => Date.parse(boundary));
    tasks.setTaskGetForTests(async () => raced.task);
    let raceTicks = 0;
    const [racedDetail, racedWaited, racedDecision] = await Promise.all([
      tasks.getTask(raced.task.id),
      tasks.waitForTaskTerminalWith(raced.task.id, REQUESTER, 1, {
        waitForMessage: async () => null,
        now: () => (++raceTicks < 4 ? 0 : 2_000),
      }),
      decide!({ id: raced.task.id, from: REVIEWER, decision: 'approved' }).catch((error: unknown) => error),
    ]);
    expect(racedDetail).toMatchObject({ state: 'failed', result: { decision: 'expired', digest: raced.task.approval.digest, expiredAt: boundary } });
    expect(racedWaited).toMatchObject({ state: 'failed', result: { decision: 'expired', digest: raced.task.approval.digest, expiredAt: boundary } });
    expect(racedDecision).toBeInstanceOf(Error);
    expect(raced.sent).toHaveLength(2); // request + exactly one terminal expiry
    await expect(decide!({ id: raced.task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow();
    expect(raced.sent).toHaveLength(2);
  });

  test('approve and reject return the waiting requester the persisted structured decision', async () => {
    const decide = api().decideApprovalTask;
    expect(decide, 'decision result behavior is missing').toBeFunction();
    for (const decision of ['approved', 'rejected'] as const) {
      const { task } = await requestFixture();
      tasks.setTaskGetForTests(async () => task);
      const completed = await decide!({ id: task.id, from: REVIEWER, decision });
      const waited = await tasks.waitForTaskTerminal(task.id, REQUESTER, 1);
      expect(completed).toMatchObject({ state: 'completed', result: { decision, digest: task.approval.digest, reviewer: REVIEWER } });
      expect(waited).toMatchObject({ state: 'completed', result: { decision, digest: task.approval.digest, reviewer: REVIEWER } });
      tasks.clearQueuedEventsForTests();
    }
  });

  test('stored reviewer ACL is enforced through the route/service seam and generic state cannot bypass it', async () => {
    const stored: ApprovalTask = {
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Approve preview', state: 'input-required',
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [{ id: '1', from: REQUESTER, to: REVIEWER, subject: 'Approve preview', date: '2026-08-24T00:00:00.000Z', state: 'input-required', body: 'request' }],
      kind: 'approval', approval: { action: ACTION, reviewer: REVIEWER, expiresAt: EXPIRES, digest: 'a'.repeat(64) },
    };
    const ordinary: Task = {
      id: '9ab7d4ad-4051-4b33-a4f0-4c5267ea8800', from: REQUESTER, to: REVIEWER, subject: 'Ordinary task', state: 'input-required',
      createdAt: stored.createdAt, updatedAt: stored.updatedAt, messages: [],
    };
    const service = {
      ...tasks.taskService,
      get: async (id: string) => id === ordinary.id ? ordinary : stored,
      update: async () => { throw new Error('approval_decision_required'); },
      decideApproval: async (input: { from: string; decision: 'approved' | 'rejected' }) => {
        if (input.from !== REVIEWER) throw new Error('approval_reviewer_required');
        return { ...stored, state: 'completed' as const, result: { decision: input.decision, digest: stored.approval.digest, reviewer: REVIEWER } };
      },
    };
    const reviewer = await appFor({ kind: 'identity', address: REVIEWER }, service as typeof tasks.taskService).request(`/v1/tasks/${stored.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
    });
    expect(reviewer.status).toBe(200);
    // A task participant can still discover the approval, but cannot make a
    // decision unless they are its stored reviewer.
    for (const address of [REQUESTER]) {
      const denied = await appFor({ kind: 'identity', address }, service as typeof tasks.taskService).request(`/v1/tasks/${stored.id}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      });
      expect(denied.status).toBe(403);
    }
    // R6 RED: an outsider must not learn either ordinary-vs-approval kind or
    // the stored reviewer from a guessed decision URL.
    for (const id of [ordinary.id, stored.id]) {
      const hidden = await appFor({ kind: 'identity', address: OUTSIDER }, service as typeof tasks.taskService).request(`/v1/tasks/${id}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      });
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual({ error: 'not_found' });
    }
    const admin = await appFor({ kind: 'admin' }, service as typeof tasks.taskService).request(`/v1/tasks/${stored.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: REVIEWER, decision: 'rejected' }),
    });
    expect(admin.status).toBe(200);
    const adminOrdinary = await appFor({ kind: 'admin' }, service as typeof tasks.taskService).request(`/v1/tasks/${ordinary.id}/decision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: REVIEWER, decision: 'rejected' }),
    });
    expect(adminOrdinary.status).toBe(409);
    expect(await adminOrdinary.json()).toEqual({ error: 'not_approval_task' });
    const bypass = await appFor({ kind: 'identity', address: REVIEWER }, service as typeof tasks.taskService).request(`/v1/tasks/${stored.id}/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'completed', result: { decision: 'approved' } }),
    });
    expect(bypass.status).toBe(409);
  });
});

describe('#55 R5: approval reminder integrity', () => {
  test('regression: an approval reminder cannot emit the ordinary event that corrupts reconstruction', async () => {
    const { task, sent } = await requestFixture();
    const parse = api().parseStampedTaskMessageForTests;
    expect(parse, 'production parser seam is missing').toBeFunction();
    tasks.setTaskGetForTests(async () => task);
    await expect(tasks.remindTask({ id: task.id, from: REQUESTER, body: 'This must not become an approval reminder.' }))
      .rejects.toThrow('approval_decision_required');
    expect(sent).toHaveLength(1);
    const request = await parse!({ id: task.id, uid: 1, source: rfc822(sent[0]!), internalDate: '2026-08-24T00:00:00.000Z' });
    expect(tasks.taskFromMessages(task.id, [request!] as Parameters<typeof tasks.taskFromMessages>[1]))
      .toMatchObject({ kind: 'approval', state: 'input-required', approval: { digest: task.approval.digest } });
  });

  test('approval reminder is rejected before delivery and leaves the authenticated request reconstructable', async () => {
    const { task, sent } = await requestFixture();
    const parse = api().parseStampedTaskMessageForTests;
    expect(parse, 'production parser seam is missing').toBeFunction();
    tasks.setTaskGetForTests(async () => task);
    await expect(tasks.remindTask({ id: task.id, from: REQUESTER, body: 'Do not send this.' }))
      .rejects.toThrow('approval_decision_required');
    expect(sent).toHaveLength(1);
    const request = await parse!({ id: task.id, uid: 1, source: rfc822(sent[0]!), internalDate: '2026-08-24T00:00:00.000Z' });
    expect(tasks.taskFromMessages(task.id, [request!] as Parameters<typeof tasks.taskFromMessages>[1]))
      .toMatchObject({ kind: 'approval', state: 'input-required', approval: { digest: task.approval.digest } });
  });
});

describe('#55 R1b: signed IMAP rebuild', () => {
  test('R8-A RED: inert snapshot-marker strings in signed action JSON cannot replace the structural frame', async () => {
    const parse = api().parseStampedTaskMessageForTests;
    expect(parse, 'real IMAP stamp/parser seam is missing').toBeFunction();
    const actions = [
      { ...ACTION, arguments: { inert: '<!-- openagent.email approval snapshot -->' } },
      { ...ACTION, arguments: { inert: '<!-- openagent.email approval snapshot -->\\n```json\\n{ "not": "a frame" }\\n```' } },
    ];
    for (const [uid, action] of actions.entries()) {
      const { task, sent } = await requestFixture(EXPIRES, action);
      const parsed = await parse!({ id: task.id, uid: uid + 40, source: rfc822(sent[0]!), internalDate: '2026-08-24T00:00:00.000Z' });
      expect(parsed).not.toBeNull();
      const rebuilt = tasks.taskFromMessages(task.id, [parsed!] as Parameters<typeof tasks.taskFromMessages>[1]);
      expect(rebuilt).toMatchObject({ kind: 'approval', approval: { digest: api().approvalActionDigest!(action) } });
    }

    const bodyWithEarlierInertFrame = [
      'Legitimate caller-supplied body.',
      '<!-- openagent.email approval snapshot -->',
      '```json',
      '{"not":"a snapshot"}',
      '```',
    ].join('\n');
    const { task, sent } = await requestFixture(EXPIRES, ACTION, bodyWithEarlierInertFrame);
    const parsed = await parse!({ id: task.id, uid: 42, source: rfc822(sent[0]!), internalDate: '2026-08-24T00:00:00.000Z' });
    expect(parsed).not.toBeNull();
    const rebuilt = tasks.taskFromMessages(task.id, [parsed!] as Parameters<typeof tasks.taskFromMessages>[1]);
    expect(rebuilt).toMatchObject({ kind: 'approval', approval: { digest: task.approval.digest } });
  });

  test('R8-B RED: a signed decision overlay survives durable IMAP lag beyond the ordinary TTL', async () => {
    const decide = api().decideApprovalTask!;
    const before = '2026-08-24T00:00:00.000Z';
    tasks.setTaskNowForTests(() => Date.parse(before));
    const { task, sent } = await requestFixture();
    tasks.setTaskGetForTests(async () => task); // durable store deliberately remains request-only
    await decide({ id: task.id, from: REVIEWER, decision: 'approved' });
    tasks.setTaskNowForTests(() => Date.parse(before) + 60_001);
    const opposite = await decide({ id: task.id, from: REVIEWER, decision: 'rejected' }).then(
      () => 'resolved', (error: Error) => error.message,
    );
    expect({ opposite, delivered: sent.length }).toEqual({ opposite: 'task_already_decided', delivered: 2 });
    const parse = api().parseStampedTaskMessageForTests!;
    const request = await parse({ id: task.id, uid: 51, source: rfc822(sent[0]!), internalDate: before });
    const terminal = await parse({ id: task.id, uid: 52, source: rfc822(sent[1]!), internalDate: before });
    expect(request).not.toBeNull();
    expect(terminal).not.toBeNull();
    const indexed = tasks.taskFromMessages(task.id, [request!, terminal!] as Parameters<typeof tasks.taskFromMessages>[1])!;
    tasks.setTaskGetForTests(async () => indexed);
    const stable = await tasks.getTask(task.id);
    expect(stable).toMatchObject({ state: 'completed', result: { decision: 'approved', digest: task.approval.digest } });
    expect(stable?.messages).toHaveLength(indexed.messages.length);
    expect(sent).toHaveLength(2);
  });

  test('R8-B RED: a signed expiry overlay survives durable IMAP lag beyond the ordinary TTL', async () => {
    const boundary = '2026-08-24T00:00:00.000Z';
    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const { task, sent } = await requestFixture(boundary);
    tasks.setTaskGetForTests(async () => task); // durable store deliberately remains request-only
    tasks.setTaskNowForTests(() => Date.parse(boundary));
    await tasks.getTask(task.id); // lazy materializer writes the first signed expiry
    tasks.setTaskNowForTests(() => Date.parse(boundary) + 60_001);
    const repeated = await api().decideApprovalTask!({ id: task.id, from: REVIEWER, decision: 'approved' }).then(
      () => 'resolved', (error: Error) => error.message,
    );
    expect({ repeated, delivered: sent.length }).toEqual({ repeated: 'task_expired', delivered: 2 });
  });

  test('R8-D RED: REST preserves task_expired after a detail read materializes the signed failure', async () => {
    const boundary = '2026-08-24T00:00:00.000Z';
    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const { task, sent } = await requestFixture(boundary);
    tasks.setTaskGetForTests(async () => task);
    tasks.setTaskNowForTests(() => Date.parse(boundary));
    const app = appFor({ kind: 'identity', address: REVIEWER });
    expect((await app.request(`/v1/tasks/${task.id}`)).status).toBe(200);
    const calls = await Promise.all([0, 1].map(async () => {
      const response = await app.request(`/v1/tasks/${task.id}/decision`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }),
      });
      return { status: response.status, body: await response.json() };
    }));
    expect({ calls, delivered: sent.length }).toEqual({
      calls: [{ status: 409, body: { error: 'task_expired' } }, { status: 409, body: { error: 'task_expired' } }], delivered: 2,
    });
  });

  test('R8-E RED: an injected REST service never falls back to global approval create/decision', async () => {
    const pending: ApprovalTask = {
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Injected approval', state: 'input-required',
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [], kind: 'approval',
      approval: { action: ACTION, reviewer: REVIEWER, expiresAt: EXPIRES, digest: api().approvalActionDigest!(ACTION) },
    };
    const ordinary: Task = { id: '4bb0f08f-f90c-4862-a7af-a0db890d76fd', from: REQUESTER, to: REVIEWER, subject: 'Injected ordinary', state: 'submitted', createdAt: pending.createdAt, updatedAt: pending.updatedAt, messages: [] };
    const injected = {
      create: async () => ordinary,
      get: async () => pending,
    } as unknown as typeof tasks.taskService;
    const sent = installSentCapture();
    tasks.setTaskGetForTests(async () => pending);
    const [create, decision] = await Promise.all([
      appFor({ kind: 'identity', address: REQUESTER }, injected).request('/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: REVIEWER, subject: 'Injected approval', body: 'record only', kind: 'approval', approval: { action: ACTION, expiresAt: EXPIRES } }) }),
      appFor({ kind: 'identity', address: REVIEWER }, injected).request(`/v1/tasks/${pending.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) }),
    ]);
    expect({ statuses: [create.status, decision.status], delivered: sent.length }).toEqual({ statuses: [502, 502], delivered: 0 });
  });

  test('the real stamp/parser rejects RFC timestamp tampering; first valid terminal wins', async () => {
    const parse = api().parseStampedTaskMessageForTests;
    expect(parse, 'real IMAP stamp/parser seam is missing').toBeFunction();
    const encodeDecision = api().encodeStampedApprovalDecisionForTests;
    expect(encodeDecision, 'real server-stamped decision encoder is missing').toBeFunction();
    const decide = api().decideApprovalTask;
    expect(decide, 'real approval decision service is missing').toBeFunction();
    const { task, sent } = await requestFixture();
    const requestSource = rfc822(sent[0]!);
    const request = await parse!({ id: task.id, uid: 1, source: requestSource, internalDate: '2026-08-24T00:00:00.000Z' });
    expect(request).not.toBeNull();
    expect(await parse!({ id: task.id, uid: 2, source: requestSource.replace(task.approval.digest, 'b'.repeat(64)), internalDate: '2026-08-24T00:00:01.000Z' })).toBeNull();
    expect(await parse!({ id: task.id, uid: 3, source: requestSource.replace('"retries":2', '"retries":3'), internalDate: '2026-08-24T00:00:02.000Z' })).toBeNull();
    expect(await parse!({ id: task.id, uid: 4, source: requestSource.replace(EXPIRES, '2030-08-25T00:00:01.000Z'), internalDate: '2026-08-24T00:00:03.000Z' })).toBeNull();
    tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:01:00.000Z'));
    tasks.setTaskGetForTests(async () => task);
    await decide!({ id: task.id, from: REVIEWER, decision: 'approved' });
    const approvedSource = rfc822(sent[1]!);
    const approved = await parse!({
      id: task.id, uid: 5, source: approvedSource,
      internalDate: '2026-08-24T00:01:00.000Z',
    });
    expect(await parse!({ id: task.id, uid: 6, source: approvedSource.replace('2026-08-24T00:01:00.000Z', '2026-08-24T00:01:01.000Z'), internalDate: '2026-08-24T00:01:01.000Z' })).toBeNull();
    const expired = await requestFixture();
    tasks.setTaskNowForTests(() => Date.parse(EXPIRES));
    tasks.setTaskGetForTests(async () => expired.task);
    await expect(decide!({ id: expired.task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow('task_expired');
    const expiredSource = rfc822(expired.sent[1]!);
    const expiryRequest = await parse!({ id: expired.task.id, uid: 7, source: rfc822(expired.sent[0]!), internalDate: '2026-08-24T00:00:00.000Z' });
    const expiryTerminal = await parse!({ id: expired.task.id, uid: 8, source: expiredSource, internalDate: EXPIRES });
    expect(expiryTerminal).not.toBeNull();
    expect(tasks.taskFromMessages(expired.task.id, [expiryRequest!, expiryTerminal!] as Parameters<typeof tasks.taskFromMessages>[1])).toMatchObject({
      kind: 'approval', state: 'failed', result: { decision: 'expired', digest: expired.task.approval.digest, expiredAt: EXPIRES },
    });
    expect(await parse!({ id: expired.task.id, uid: 9, source: expiredSource.replace(EXPIRES, '2030-08-25T00:00:01.000Z'), internalDate: '2030-08-25T00:00:01.000Z' })).toBeNull();
    const rejected = await parse!({
      id: task.id, uid: 10,
      source: encodeDecision!({ id: task.id, from: REVIEWER, to: REQUESTER, subject: task.subject, digest: task.approval.digest, decision: 'rejected', decidedAt: '2026-08-24T00:02:00.000Z' }),
      internalDate: '2026-08-24T00:02:00.000Z',
    });
    const rebuilt = tasks.taskFromMessages(task.id, [request!, approved!, rejected!] as Parameters<typeof tasks.taskFromMessages>[1]);
    expect(rebuilt).toMatchObject({ kind: 'approval', state: 'completed', result: { decision: 'approved', digest: task.approval.digest } });
  });
});

describe('#55 R1b: actual UI/watcher seams and compatibility controls', () => {
  test('R8-C RED: parser-authenticated request, decision, and expiry previews pass default otp policy without content escalation', async () => {
    const request = api().encodeStampedApprovalRequestForTests!({ id: ID, from: REQUESTER, to: REVIEWER, subject: 'Approval no OTP', body: 'inert body', action: ACTION, expiresAt: EXPIRES });
    const decision = api().encodeStampedApprovalDecisionForTests!({ id: ID, from: REVIEWER, to: REQUESTER, subject: 'Approval no OTP', digest: api().approvalActionDigest!(ACTION), decision: 'approved', decidedAt: '2026-08-24T00:01:00.000Z' });
    tasks.setTaskNowForTests(() => Date.parse('2026-08-23T23:59:59.999Z'));
    const expiryFixture = await requestFixture('2026-08-24T00:00:00.000Z');
    tasks.setTaskGetForTests(async () => expiryFixture.task);
    tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:00:00.000Z'));
    await expect(api().decideApprovalTask!({ id: expiryFixture.task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow('task_expired');
    const deliveries: Array<Array<{ level: string; message: string }>> = [];
    const cases = [
      { source: request, from: REQUESTER, to: REVIEWER, subject: 'Approval no OTP', recipient: REVIEWER },
      { source: decision, from: REVIEWER, to: REQUESTER, subject: 'Approval no OTP', recipient: REQUESTER },
      { source: rfc822(expiryFixture.sent[1]!), from: REQUESTER, to: REVIEWER, subject: 'Approval no OTP', recipient: REVIEWER },
    ];
    for (const item of cases) {
      const perEvent: Array<{ level: string; message: string }> = [];
      await processWatchedMessage({
        envelope: { from: [{ address: item.from }], to: [{ address: item.to }], subject: item.subject },
        headers: Buffer.from(`Delivered-To: ${item.recipient}\\r\\n`), source: Buffer.from(item.source),
      } as never, [{ address: item.recipient, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'otp', {
        publish: async (input) => { perEvent.push({ level: input.level, message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
      });
      deliveries.push(perEvent);
    }
    const forged: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approval no OTP' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\\r\\n`), source: Buffer.from(request.replace(/X-OA-Task-Stamp: [^\\r\\n]+/, 'X-OA-Task-Stamp: forged')),
    } as never, [{ address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'otp', {
      publish: async (input) => { forged.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    const none: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approval no OTP' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\\r\\n`), source: Buffer.from(request),
    } as never, [{ address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'none', {
      publish: async (input) => { none.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    expect({ deliveries, forged: forged.length, none: none.length }).toEqual({
      deliveries: [
        [{ level: 'normal', message: expect.stringContaining('Approval request recorded.') }],
        [{ level: 'normal', message: expect.stringContaining('Approval decision recorded: approved.') }],
        [{ level: 'normal', message: expect.stringContaining('Approval expired.') }],
      ],
      forged: 0, none: 0,
    });
    expect(deliveries.flat().map(({ message }) => message).join('\n')).not.toContain('<img src=x onerror=alert(1)>');
  });

  test('the real watcher queues an approval preview without action arguments', async () => {
    const encodeRequest = api().encodeStampedApprovalRequestForTests;
    expect(encodeRequest, 'real server-stamped approval request encoder is missing').toBeFunction();
    const source = encodeRequest!({
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Approve preview', body: 'Record only; do not execute.',
      action: ACTION, expiresAt: EXPIRES,
    });
    const calls: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approve preview' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\r\n`), source: Buffer.from(source),
    } as never, [{ address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'all', {
      publish: async (input) => { calls.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.message).not.toContain('<img src=x onerror=alert(1)>');
    expect(calls[0]!.message).not.toContain('dry-run');
    expect(calls[0]!.message).not.toContain('retries');
    expect(calls[0]!.message).toContain('Preview: Approval request recorded. Open the task dashboard to review.');

    const encodeDecision = api().encodeStampedApprovalDecisionForTests;
    expect(encodeDecision).toBeFunction();
    const decisionCalls: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REVIEWER }], to: [{ address: REQUESTER }], subject: 'Approve preview' },
      headers: Buffer.from(`Delivered-To: ${REQUESTER}\r\n`),
      source: Buffer.from(encodeDecision!({ id: ID, from: REVIEWER, to: REQUESTER, subject: 'Approve preview', digest: api().approvalActionDigest!(ACTION), decision: 'approved', decidedAt: '2030-08-24T00:01:00.000Z' })),
    } as never, [{ address: REQUESTER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'all', {
      publish: async (input) => { decisionCalls.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    expect(decisionCalls[0]!.message).toContain('Preview: Approval decision recorded: approved.');

    tasks.setTaskNowForTests(() => Date.parse('2030-08-24T23:59:59.999Z'));
    const expired = await requestFixture(EXPIRES);
    tasks.setTaskNowForTests(() => Date.parse(EXPIRES));
    tasks.setTaskGetForTests(async () => expired.task);
    await expect(api().decideApprovalTask!({ id: expired.task.id, from: REVIEWER, decision: 'approved' })).rejects.toThrow('task_expired');
    const expiryCalls: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approve preview' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\r\n`), source: Buffer.from(rfc822(expired.sent[1]!)),
    } as never, [{ address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'all', {
      publish: async (input) => { expiryCalls.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    expect(expiryCalls[0]!.message).toContain('Preview: Approval expired.');

    const invalidCalls: Array<{ message: string }> = [];
    await processWatchedMessage({
      envelope: { from: [{ address: REQUESTER }], to: [{ address: REVIEWER }], subject: 'Approve preview' },
      headers: Buffer.from(`Delivered-To: ${REVIEWER}\r\n`),
      source: Buffer.from(source.replace(/X-OA-Task-Stamp: [^\r\n]+/, 'X-OA-Task-Stamp: forged')),
    } as never, [{ address: REVIEWER, createdAt: '2026-08-24T00:00:00.000Z', pushContentTier: 3 }], 'all', {
      publish: async (input) => { invalidCalls.push({ message: input.message }); return { target: input.target, title: input.title, level: input.level }; },
    });
    expect(invalidCalls[0]!.message).not.toContain('Approval request recorded.');
    expect(invalidCalls[0]!.message).toContain('<img src=x onerror=alert(1)>');
  });

  test('ordinary REST/MCP/rebuild callers retain their existing task contract', async () => {
    const ordinary = {
      id: ID, from: REQUESTER, to: REVIEWER, subject: 'Ordinary', state: 'submitted' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [{ id: '1', from: REQUESTER, to: REVIEWER, subject: 'Ordinary', date: '2026-08-24T00:00:00.000Z', state: 'submitted' as const, body: 'ordinary body' }],
    };
    expect(tasks.taskFromMessages(ID, [{ uid: 1, ...ordinary.messages[0] }])).toMatchObject({ state: 'submitted', subject: 'Ordinary' });
    let requestBody = '';
    const client = new OpenAgentEmailClient('http://test.invalid', 'token', async (_url, init) => {
      requestBody = String(init?.body); return new Response(JSON.stringify(ordinary), { status: 201 });
    });
    await client.createTask(REVIEWER, 'Ordinary', 'ordinary body');
    expect(JSON.parse(requestBody)).toEqual({ to: REVIEWER, subject: 'Ordinary', body: 'ordinary body', wait: false });

    const calls: Array<{ path: string; body: unknown }> = [];
    const approvalClient = new OpenAgentEmailClient('http://test.invalid', 'token', async (url, init) => {
      calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ...ordinary, kind: 'approval', approval: { action: ACTION, reviewer: REVIEWER, expiresAt: EXPIRES, digest: 'a'.repeat(64) } }), { status: 200 });
    });
    await approvalClient.createApprovalTask(REVIEWER, 'Approve preview', ACTION, EXPIRES, 'Record only; do not execute.');
    await approvalClient.decideTask(ID, 'approved');
    expect(calls).toEqual([
      { path: 'http://test.invalid/v1/tasks', body: { to: REVIEWER, subject: 'Approve preview', body: 'Record only; do not execute.', kind: 'approval', approval: { action: ACTION, expiresAt: EXPIRES }, wait: false } },
      { path: `http://test.invalid/v1/tasks/${ID}/decision`, body: { decision: 'approved' } },
    ]);
  });
});
