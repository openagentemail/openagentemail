// #56 R8a: admin UI close overrides a live lease through the shipped seams.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';
type HonoApp = import('hono').Hono;

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-admin-override-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test: bunTest } = await import('bun:test');
const { Hono } = await import('hono');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');
const {
  clearQueuedEventsForTests,
  isTaskLeaseTokenCurrent,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskService,
  taskFromMessages,
} = await import('../src/lib/tasks.ts');
const { parseTaskMessageForTests, withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'alpha@test.example';
const RECIPIENT = 'bravo@test.example';
const OUTSIDER = 'charlie@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');
const REASON = 'admin override: requester cancelled';

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'Lease this task',
    date: '2026-08-24T00:00:00.000Z',
    state: 'submitted',
    body: 'Please claim.',
  };
}

function submittedTask(): Task {
  return taskFromMessages(ID, [submittedRaw()])!;
}

function source(input: SendInput): Buffer {
  return Buffer.from([
    `From: ${input.from}`,
    `To: ${input.to[0]}`,
    `Subject: ${input.subject}`,
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n'), 'utf8');
}

async function parseCaptured(input: SendInput, uid: number): Promise<RawTaskMessage | null> {
  return parseTaskMessageForTests({
    uid,
    source: source(input),
    envelope: {
      from: [{ address: input.from }],
      to: [{ address: input.to[0] }],
      subject: input.subject,
    },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
}

function uiApp(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
  const sessions = new UiSessionStore({
    resolveToken: (token) => (token === 'session-token' ? auth : null),
  });
  // Session expiry deliberately uses the store's normal wall clock; only the
  // task authority clock is fixed for this proof.
  const session = sessions.create('session-token', '127.0.0.1');
  if (!session.ok) throw new Error('test session was not created');
  const app = new Hono();
  // No task-service injection: this must traverse the shipped taskService.close.
  app.route('/ui/api', createUiApiRoutes(sessions));
  return { app, cookie: `oae_ui=${session.sid}` };
}

function recipientTaskApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { kind: 'identity' as const, address: RECIPIENT });
    await next();
  });
  // No service injection: stale operations use the production TaskService.
  app.route('/v1/tasks', createTaskRoutes({
    findIdentity: (address) => ({ address, createdAt: '2026-08-24T00:00:00.000Z' }),
  }));
  return app;
}

async function postJson(app: HonoApp, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function contains(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((entry) => contains(entry, secret));
  return !!value && typeof value === 'object' && Object.values(value).some((entry) => contains(entry, secret));
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#56 R8a admin close lease override', () => {
  test('admin UI close overrides generation-1 authority, is signed/rebuildable, and fences the old bearer', async () => {
    let durable = submittedTask();
    const sent: SendInput[] = [];
    const warnings: unknown[][] = [];
    const priorWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<admin-override-${sent.length}>` };
      });

      // The actual production claim establishes a current generation-1 lease.
      if (!taskService.claim) throw new Error('shipped claim service is unavailable');
      const grant = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
      expect(isTaskLeaseTokenCurrent(grant.task, grant.leaseToken)).toBe(true);
      expect(sent).toHaveLength(1);

      const { app: admin, cookie } = uiApp({ kind: 'admin' });
      const closed = await postJson(admin, `/ui/api/tasks/${ID}/close`, {
        from: REQUESTER,
        reason: REASON,
      }, { cookie });
      expect({
        status: closed.response.status,
        state: closed.body.state,
        result: closed.body.result,
        claimedUntil: closed.body.claimedUntil,
        leaseGeneration: closed.body.leaseGeneration,
        leaseToken: closed.body.leaseToken,
        tokenVerifier: closed.body.tokenVerifier,
        deliveries: sent.length,
      }).toEqual({
        status: 200,
        state: 'failed',
        result: { closed_by_admin: true, reason: REASON },
        claimedUntil: undefined,
        leaseGeneration: undefined,
        leaseToken: undefined,
        tokenVerifier: undefined,
        deliveries: 2,
      });

      const claim = await parseCaptured(sent[0]!, 2);
      const close = await parseCaptured(sent[1]!, 3);
      expect(claim).not.toBeNull();
      expect(close).not.toBeNull();
      const rebuilt = taskFromMessages(ID, [submittedRaw(), claim!, close!]);
      expect(rebuilt).not.toBeNull();
      expect(rebuilt!.state).toBe('failed');
      expect(rebuilt!.result).toEqual({ closed_by_admin: true, reason: REASON });
      expect(rebuilt!.lease).toBeUndefined();
      expect(rebuilt!.releasedLease).toBeUndefined();

      // Make all post-close operations read only the parser-authenticated durable history.
      durable = rebuilt!;
      clearQueuedEventsForTests();
      const worker = recipientTaskApp();
      const [state, renew, release, reclaim] = await Promise.all([
        postJson(worker, `/v1/tasks/${ID}/state`, { state: 'working', leaseToken: grant.leaseToken }),
        postJson(worker, `/v1/tasks/${ID}/lease`, { leaseToken: grant.leaseToken, leaseSec: 300 }),
        postJson(worker, `/v1/tasks/${ID}/release`, { leaseToken: grant.leaseToken, reason: 'too late' }),
        postJson(worker, `/v1/tasks/${ID}/claim`, { leaseSec: 300 }),
      ]);
      expect({
        state: { status: state.response.status, error: state.body.error },
        renew: { status: renew.response.status, error: renew.body.error },
        release: { status: release.response.status, error: release.body.error },
        reclaim: { status: reclaim.response.status, error: reclaim.body.error },
        deliveries: sent.length,
      }).toEqual({
        state: { status: 409, error: 'task_already_terminal' },
        renew: { status: 409, error: 'task_not_claimable' },
        release: { status: 409, error: 'task_not_claimable' },
        reclaim: { status: 409, error: 'task_not_claimable' },
        deliveries: 2,
      });

      const terminalAgain = await postJson(admin, `/ui/api/tasks/${ID}/close`, {
        from: REQUESTER,
        reason: 'must not create a second audit event',
      }, { cookie });
      expect({ status: terminalAgain.response.status, error: terminalAgain.body.error, deliveries: sent.length }).toEqual({
        status: 409,
        error: 'task_already_terminal',
        deliveries: 2,
      });

      const verifier = grant.task.lease!.tokenVerifier;
      for (const surface of [sent, rebuilt, closed.body, [state.body, renew.body, release.body, reclaim.body], warnings]) {
        expect(contains(surface, grant.leaseToken)).toBe(false);
        expect(contains(surface, verifier)).toBe(false);
      }
    } finally {
      console.warn = priorWarn;
    }
  });

  test('identity and malformed admin calls stop before close delivery', async () => {
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<admin-controls-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });

    const identity = uiApp({ kind: 'identity', address: RECIPIENT });
    const admin = uiApp({ kind: 'admin' });
    const identityDenied = await postJson(identity.app, `/ui/api/tasks/${ID}/close`, {
      from: RECIPIENT,
      reason: REASON,
    }, { cookie: identity.cookie });
    const missingFrom = await postJson(admin.app, `/ui/api/tasks/${ID}/close`, {
      reason: REASON,
    }, { cookie: admin.cookie });
    const outsiderFrom = await postJson(admin.app, `/ui/api/tasks/${ID}/close`, {
      from: OUTSIDER,
      reason: REASON,
    }, { cookie: admin.cookie });

    expect({
      identity: { status: identityDenied.response.status, error: identityDenied.body.error },
      missingFrom: { status: missingFrom.response.status, error: missingFrom.body.error },
      outsiderFrom: { status: outsiderFrom.response.status, error: outsiderFrom.body.error },
      deliveries: sent.length,
    }).toEqual({
      identity: { status: 403, error: 'forbidden: admin session required' },
      missingFrom: { status: 400, error: 'from is required for an admin key' },
      outsiderFrom: { status: 400, error: 'invalid_request: from must be a task participant' },
      deliveries: 1,
    });
  });
});
