// #56 R2: production lease event, parser/rebuild, restart, and config gates.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task, TaskService } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-core-'));
process.env.TASK_LEASES_ENABLED = 'true';

const { afterEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { config, parseConfig } = await import('../src/lib/config.ts');
const {
  TASK_LEASE_DEFAULT_SEC,
  TASK_LEASE_MAX_SEC,
  TASK_LEASE_MIN_SEC,
  TASK_LEASE_REASON_MAX_CHARS,
  claimLeaseHeadersForTests,
  claimTask,
  createApprovalTask,
  clearQueuedEventsForTests,
  isTaskLeaseTokenCurrent,
  parseTaskMessageForTests,
  releaseTask,
  setTaskGetForTests,
  setTaskLeasesEnabledForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskService,
  taskFromMessages,
  toTaskView,
} = await import('../src/lib/tasks.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { createTaskRoutes } = await import('../src/routes/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const C = 'charlie@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1, from: A, to: B, subject: 'Lease this task',
    date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'Please claim.',
  };
}

function submittedTask(): Task {
  return taskFromMessages(ID, [submittedRaw()])!;
}

function source(input: SendInput, extra: Record<string, string> = {}): Buffer {
  const headers = { ...(input.headers ?? {}), ...extra };
  return Buffer.from([
    `From: ${input.from}`,
    `To: ${input.to[0]}`,
    `Subject: ${input.subject}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n'), 'utf8');
}

async function parsedClaim(input: SendInput, uid = 2, extra: Record<string, string> = {}) {
  return parseTaskMessageForTests({
    uid,
    source: source(input, extra),
    envelope: { from: [{ address: input.from }], to: [{ address: input.to[0] }], subject: input.subject },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
}

afterEach(() => {
  setTaskLeasesEnabledForTests(undefined);
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

if (process.env.TASK_LEASES_R4_RED === '1') {
  test('#56 R4c executable claim/equality/rebuild authority baseline', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<r4c-baseline>' }; });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(first.leaseGeneration).toBe(1);
    now = Date.parse(first.claimedUntil) - 1;
    expect(isTaskLeaseTokenCurrent(first.task, first.leaseToken)).toBe(true);
    now = Date.parse(first.claimedUntil);
    expect(isTaskLeaseTokenCurrent(first.task, first.leaseToken)).toBe(false);
    const parsed = await parsedClaim(sent[0]!);
    durable = taskFromMessages(ID, [submittedRaw(), parsed!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(second.leaseGeneration).toBe(2);
    expect(isTaskLeaseTokenCurrent(second.task, first.leaseToken)).toBe(false);
    expect(isTaskLeaseTokenCurrent(second.task, second.leaseToken)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(first.leaseToken);
    expect(JSON.stringify(durable)).not.toContain(first.leaseToken);
  });
}

describe('#56 R2 lease authority', () => {
  test('R18 GREEN: shipped Compose deployments expose the opt-in flag with an explicit false default', () => {
    const deployments = [
      {
        name: 'bundled',
        compose: readFileSync(new URL('../../../compose.yaml', import.meta.url), 'utf8'),
        example: readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
      },
      {
        name: 'api-only',
        compose: readFileSync(new URL('../../../compose.api-only.yaml', import.meta.url), 'utf8'),
        example: readFileSync(new URL('../../../.env.api-only.example', import.meta.url), 'utf8'),
      },
    ];
    const observed = deployments.map(({ name, compose, example }) => {
      const fallback = compose.match(/^\s+TASK_LEASES_ENABLED:\s*\$\{TASK_LEASES_ENABLED:-([^}]+)\}\s*$/m)?.[1];
      const interpolate = (value?: string) => value || fallback;
      return {
        name,
        explicitMapping: fallback !== undefined,
        exampleDefaultsFalse: /Default false = disabled\.\r?\nTASK_LEASES_ENABLED=false/m.test(example),
        unsetInterpolation: interpolate(),
        trueInterpolation: interpolate('true'),
      };
    });
    expect(observed).toEqual([
      { name: 'bundled', explicitMapping: true, exampleDefaultsFalse: true, unsetInterpolation: 'false', trueInterpolation: 'true' },
      { name: 'api-only', explicitMapping: true, exampleDefaultsFalse: true, unsetInterpolation: 'false', trueInterpolation: 'true' },
    ]);
  });

  test('config defaults disabled and parses the fixed enable/duration policy', () => {
    const base = {
      DOMAIN: 'test.example', API_KEYS: 'admin-key', IMAP_USER: A, IMAP_PASS: 'imap-secret',
      SMTP_USER: A, SMTP_PASS: 'smtp-secret', DATA_DIR: mkdtempSync(join(tmpdir(), 'oae-lease-config-')),
    };
    expect(parseConfig(base).taskLeasesEnabled).toBe(false);
    expect(parseConfig({ ...base, TASK_LEASES_ENABLED: 'true' }).taskLeasesEnabled).toBe(true);
    expect([TASK_LEASE_MIN_SEC, TASK_LEASE_DEFAULT_SEC, TASK_LEASE_MAX_SEC]).toEqual([30, 300, 3600]);
  });

  test('claim defaults leaseSec to 300 and rejects values outside 30..3600 before delivery', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<lease-bounds>' }; });
    await expect(claimTask({ id: ID, from: B, leaseSec: 29 })).rejects.toThrow('invalid_lease_seconds');
    await expect(claimTask({ id: ID, from: B, leaseSec: 3601 })).rejects.toThrow('invalid_lease_seconds');
    expect(sent).toHaveLength(0);
    const claim = await claimTask({ id: ID, from: B });
    expect(claim.claimedUntil).toBe('2026-08-24T00:05:00.000Z');
  });

  test('disabled claim is 409 before the injected service can mutate', async () => {
    let claims = 0;
    const service: TaskService = {
      async create() { throw new Error('unused'); }, async list() { return []; }, async listBoard() { throw new Error('unused'); },
      async get() { return submittedTask(); }, async update() { throw new Error('unused'); },
      async claim() { claims += 1; throw new Error('must not run'); }, async reply() { throw new Error('unused'); },
      async remind() { throw new Error('unused'); }, async close() { throw new Error('unused'); }, async waitForTerminal() { return null; },
    };
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { kind: 'identity' as const, address: B }); await next(); });
    app.route('/v1/tasks', createTaskRoutes({ service, findIdentity: () => ({ address: B, createdAt: '2026-08-24T00:00:00.000Z' }), leaseEnabledForTests: false }));
    const response = await app.request(`/v1/tasks/${ID}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 300 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'task_leases_disabled' });
    expect(claims).toBe(0);
  });

  test('terminal and admin-closed tasks are not claimable and emit no event', async () => {
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<unexpected>' }; });
    for (const current of [
      { ...submittedTask(), state: 'completed' as const },
      { ...submittedTask(), state: 'failed' as const, result: { closed_by_admin: true } },
    ]) {
      setTaskGetForTests(async () => current);
      await expect(claimTask({ id: ID, from: B })).rejects.toThrow('task_not_claimable');
    }
    expect(sent).toHaveLength(0);
  });

  test('captured production claim event rebuilds across restart, preserves exclusivity, and fences at expiry', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<lease-${sent.length}>` }; });

    const concurrent = await Promise.allSettled([
      claimTask({ id: ID, from: B, leaseSec: 300 }),
      claimTask({ id: ID, from: B, leaseSec: 300 }),
    ]);
    expect(concurrent.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((row) => row.status === 'rejected')[0]?.reason.message).toBe('lease_already_claimed');
    const first = concurrent.find((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof claimTask>>> => row.status === 'fulfilled')!.value;
    expect(first.task.state).toBe('working');
    expect(first.leaseGeneration).toBe(1);
    expect(first.claimedUntil).toBe('2026-08-24T00:05:00.000Z');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain(first.leaseToken);

    const parsed = await parsedClaim(sent[0]!);
    expect(parsed).not.toBeNull();
    const captured = parsed!;
    // Simulate process restart: no plaintext lease map is retained. Rebuild
    // solely from the real signed claim event and the base durable request.
    clearQueuedEventsForTests();
    durable = taskFromMessages(ID, [submittedRaw(), captured])!;
    setTaskGetForTests(async () => durable);
    expect(isTaskLeaseTokenCurrent(durable, first.leaseToken)).toBe(true);
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toThrow('lease_already_claimed');
    expect(sent).toHaveLength(1);

    now = Date.parse(first.claimedUntil);
    expect(isTaskLeaseTokenCurrent(durable, first.leaseToken)).toBe(false);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(second.leaseGeneration).toBe(2);
    expect(isTaskLeaseTokenCurrent(second.task, first.leaseToken)).toBe(false);
    expect(isTaskLeaseTokenCurrent(second.task, second.leaseToken)).toBe(true);
  });

  test('queued claim authority survives the generic overlay TTL and supersedes older generations', async () => {
    let now = START;
    const durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<queued-${sent.length}>` }; });

    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    now = START + 61_000;
    await expect(claimTask({ id: ID, from: B, leaseSec: 300 })).rejects.toThrow('lease_already_claimed');
    expect(sent).toHaveLength(1);
    expect(first.leaseGeneration).toBe(1);

    now = Date.parse(first.claimedUntil);
    const second = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect(second.leaseGeneration).toBe(2);
    expect(sent).toHaveLength(3);

    const rebuilt = taskFromMessages(ID, [
      submittedRaw(),
      (await parsedClaim(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parsedClaim(sent[2]!, 4))!,
    ])!;
    expect(rebuilt.lease?.leaseGeneration).toBe(2);
    expect(isTaskLeaseTokenCurrent(rebuilt, first.leaseToken)).toBe(false);
    expect(isTaskLeaseTokenCurrent(rebuilt, second.leaseToken)).toBe(true);
  });

  test('production approval requests are not claimable or mutated by lease authority', async () => {
    const requester = createIdentity({ localpart: 'lease-approval-requester' })!.identity;
    const reviewer = createIdentity({ localpart: 'lease-approval-reviewer' })!.identity;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<approval-request>' }; });
    const approval = await createApprovalTask({
      from: requester.address,
      to: reviewer.address,
      subject: 'Approval is not a lease',
      action: { type: 'tool', name: 'noop', arguments: {} },
      expiresAt: '2026-08-24T00:05:00.000Z',
    });
    const parsed = await parseTaskMessageForTests({
      uid: 1,
      source: source(sent[0]!),
      envelope: { from: [{ address: requester.address }], to: [{ address: reviewer.address }], subject: approval.subject },
      internalDate: new Date(START),
    } as unknown as FetchMessageObject, approval.id);
    const rebuilt = taskFromMessages(approval.id, [parsed!])!;
    setTaskGetForTests(async () => rebuilt);
    await expect(claimTask({ id: approval.id, from: reviewer.address })).rejects.toThrow('task_not_claimable');
    expect(sent).toHaveLength(1);
    expect(taskFromMessages(approval.id, [parsed!])?.kind).toBe('approval');
  });

  test('real taskService route registration executes production claim authority', async () => {
    const sent: SendInput[] = [];
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<route-claim>' }; });
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('auth', { kind: 'identity' as const, address: B }); await next(); });
    app.route('/v1/tasks', createTaskRoutes({
      findIdentity: (address) => ({ address, createdAt: '2026-08-24T00:00:00.000Z' }),
      leaseEnabledForTests: true,
    }));
    const response = await app.request(`/v1/tasks/${ID}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leaseSec: 300 }),
    });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(((await response.json()) as { leaseToken?: string }).leaseToken).toEqual(expect.any(String));
  });

  test('production parser/rebuild rejects authoritative field tampering and invalid claim authority', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<lease-tamper>' }; });
    await claimTask({ id: ID, from: B });
    const original = sent[0]!;
    const payload = JSON.parse(Buffer.from(original.headers!['X-OA-Task-Lease-Payload']!, 'base64url').toString('utf8')) as Record<string, unknown>;
    for (const field of ['version', 'event', 'actor', 'at', 'generation', 'claimedUntil', 'tokenVerifier'] as const) {
      const tampered = { ...payload, [field]: field === 'generation' ? 2 : `tampered-${field}` };
      const parsed = await parsedClaim(original, 2, {
        'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64url'),
      });
      expect(parsed, `tampered ${field}`).toBeNull();
    }
    const bearer = await parsedClaim(original, 2, {
      'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify({ ...payload, leaseToken: 'forbidden-bearer' }), 'utf8').toString('base64url'),
    });
    expect(bearer).toBeNull();
    const malformedTime = await parsedClaim(original, 2, {
      'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify({ ...payload, at: 'not-a-time' }), 'utf8').toString('base64url'),
    });
    expect(malformedTime).toBeNull();

    const invalidActorEvent = { ...payload, actor: C } as Parameters<typeof claimLeaseHeadersForTests>[0]['event'];
    const invalidActorHeaders = claimLeaseHeadersForTests({ id: ID, state: 'working', from: C, to: A, event: invalidActorEvent });
    const invalidActor = await parseTaskMessageForTests({
      uid: 2, source: source({ ...original, from: C, to: [A], headers: invalidActorHeaders }),
      envelope: { from: [{ address: C }], to: [{ address: A }], subject: original.subject }, internalDate: new Date(START),
    } as unknown as FetchMessageObject, ID);
    expect(invalidActor).not.toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), invalidActor!])).toBeNull();

    const sameGeneration = await parsedClaim(original, 3);
    expect(sameGeneration).not.toBeNull();
    expect(taskFromMessages(ID, [submittedRaw(), (await parsedClaim(original, 2))!, sameGeneration!])).toBeNull();
  });
});

type LeaseGrantBody = {
  leaseToken: string;
  claimedUntil: string;
  leaseGeneration: number;
};

type RouteResult = { status: number; body: unknown };

function productionApp(service: TaskService = taskService, actor = B) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { kind: 'identity' as const, address: actor });
    await next();
  });
  app.route('/v1/tasks', createTaskRoutes({
    service,
    findIdentity: (address) => ({ address, createdAt: '2026-08-24T00:00:00.000Z' }),
    leaseEnabledForTests: true,
  }));
  return app;
}

async function post(app: ReturnType<typeof productionApp>, path: string, body: unknown): Promise<RouteResult> {
  const response = await app.request(`/v1/tasks/${ID}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // Every route under test is expected to return JSON. Keep a malformed
    // response visible in the single composite observation instead of aborting.
  }
  return { status: response.status, body: parsed };
}

async function parseCaptured(input: SendInput, uid: number, extra: Record<string, string> = {}) {
  return parseTaskMessageForTests({
    uid,
    source: source(input, extra),
    envelope: { from: [{ address: input.from }], to: [{ address: input.to[0] }], subject: input.subject },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false;
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret));
  if (value && typeof value === 'object') return Object.values(value).some((entry) => containsSecret(entry, secret));
  return false;
}

async function leaseFixture() {
  const clock = { now: START };
  let durable = submittedTask();
  const sent: SendInput[] = [];
  setTaskNowForTests(() => clock.now);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<r5b-${sent.length}>` };
  });
  const app = productionApp();
  const claim = await post(app, 'claim', { leaseSec: 300 });
  const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
  const grant: LeaseGrantBody = {
    leaseToken: typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '',
    claimedUntil: typeof claimBody.claimedUntil === 'string' ? claimBody.claimedUntil : '',
    leaseGeneration: typeof claimBody.leaseGeneration === 'number' ? claimBody.leaseGeneration : 0,
  };
  const captured = sent[0] ? await parsedClaim(sent[0]) : null;
  if (captured) durable = taskFromMessages(ID, [submittedRaw(), captured]) ?? durable;
  clearQueuedEventsForTests();
  setTaskGetForTests(async () => durable);
  return {
    app,
    claim,
    grant,
    sent,
    clock,
    durable: () => durable,
    replaceDurable: (next: Task) => { durable = next; },
  };
}

async function reclaimAtEquality(fixture: Awaited<ReturnType<typeof leaseFixture>>) {
  fixture.clock.now = Date.parse(fixture.grant.claimedUntil);
  const claim = await post(fixture.app, 'claim', { leaseSec: 300 });
  const body = objectValue(claim.body) as Partial<LeaseGrantBody>;
  const grant: LeaseGrantBody = {
    leaseToken: typeof body.leaseToken === 'string' ? body.leaseToken : '',
    claimedUntil: typeof body.claimedUntil === 'string' ? body.claimedUntil : '',
    leaseGeneration: typeof body.leaseGeneration === 'number' ? body.leaseGeneration : 0,
  };
  const captured = fixture.sent.at(-1);
  const parsed = claim.status === 200 && captured ? await parsedClaim(captured, fixture.sent.length + 1) : null;
  if (parsed) {
    fixture.replaceDurable(taskFromMessages(ID, [submittedRaw(), ...(await Promise.all(
      fixture.sent.filter((input) => input.headers?.['X-OA-Task-Lease-Event'] === 'claim')
        .map((input, index) => parsedClaim(input, index + 2)),
    )).filter((message): message is RawTaskMessage => !!message)]) ?? fixture.durable());
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => fixture.durable());
  }
  return { claim, grant };
}

async function r13bActiveLeaseFixture() {
  const durable = submittedTask();
  const sent: SendInput[] = [];
  clearQueuedEventsForTests();
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<r13b-${sent.length}>` };
  });
  const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
  const active = await taskService.get(ID);
  if (!active?.lease) throw new Error('R13b fixture must retain active authority');
  return { app: productionApp(), active, grant, sent };
}

describe('#56 R13b real REST state actor matrix RED', () => {
  test('R13b RED: requester is unfenced while recipient without the current token remains fenced', async () => {
    const effectiveLeaseEnabled = setTaskLeasesEnabledForTests(true);
    console.info(JSON.stringify({ r16CoreLeaseGate: {
      test: 'R13b', configuredSingleton: config.taskLeasesEnabled, effectiveLeaseEnabled,
    } }));
    const requester = await r13bActiveLeaseFixture();
    const requesterUpdate = await post(productionApp(taskService, A), 'state', {
      state: 'input-required',
      body: 'requester update without lease token',
    });
    const requesterBody = objectValue(requesterUpdate.body);

    const worker = await r13bActiveLeaseFixture();
    const workerBefore = worker.active;
    const workerUpdate = await post(worker.app, 'state', {
      state: 'input-required',
      body: 'worker update without lease token',
    });
    const workerBody = objectValue(workerUpdate.body);
    const workerAfter = await taskService.get(ID);

    expect({
      requester: {
        status: requesterUpdate.status,
        state: requesterBody.state ?? null,
        deliveries: requester.sent.length,
        tokenFree: !containsSecret(requesterUpdate.body, requester.grant.leaseToken),
      },
      worker: {
        actorIsRecipient: workerBefore.to === B,
        activeLease: workerBefore.lease?.claimedUntil === worker.grant.claimedUntil,
        status: workerUpdate.status,
        error: workerBody.error ?? null,
        state: workerAfter?.state ?? null,
        deliveries: worker.sent.length,
        events: (workerAfter?.messages.length ?? 0) - workerBefore.messages.length,
        queued: workerAfter?.state === workerBefore.state ? 0 : 1,
        authorityUnchanged: workerAfter?.lease?.claimedUntil === workerBefore.lease?.claimedUntil
          && workerAfter?.lease?.leaseGeneration === workerBefore.lease?.leaseGeneration
          && workerAfter?.lease?.tokenVerifier === workerBefore.lease?.tokenVerifier,
        tokenFree: !containsSecret(workerUpdate.body, worker.grant.leaseToken),
      },
    }).toEqual({
      requester: {
        status: 200,
        state: 'input-required',
        deliveries: 2,
        tokenFree: true,
      },
      worker: {
        actorIsRecipient: true,
        activeLease: true,
        status: 409,
        error: 'task_already_terminal',
        state: 'working',
        deliveries: 1,
        events: 0,
        queued: 0,
        authorityUnchanged: true,
        tokenFree: true,
      },
    });
  });
});

if (process.env.TASK_LEASES_R5B_RED === '1') {
  describe('#56 R5b production lease-core matrix RED', () => {
    test('generation-1 current token renews before expiry with one authenticated extended event and closed view', async () => {
      const fixture = await leaseFixture();
      fixture.clock.now = Date.parse(fixture.grant.claimedUntil) - 1;
      const renewed = await post(fixture.app, 'lease', { leaseToken: fixture.grant.leaseToken, leaseSec: 300 });
      const body = objectValue(renewed.body);
      const event = fixture.sent.length > 1 ? await parseCaptured(fixture.sent.at(-1)!, 3) : null;
      const verifier = fixture.durable().lease?.tokenVerifier ?? '';
      expect({
        status: renewed.status,
        sent: fixture.sent.length,
        generation: body.leaseGeneration ?? null,
        claimedUntil: body.claimedUntil ?? null,
        authenticatedEvent: event !== null,
        tokenFree: !containsSecret(renewed.body, fixture.grant.leaseToken) && !containsSecret(renewed.body, verifier),
      }).toEqual({
        status: 200,
        sent: 2,
        generation: 1,
        claimedUntil: new Date(fixture.clock.now + 300_000).toISOString(),
        authenticatedEvent: true,
        tokenFree: true,
      });
    });

    test('renew at exact claimedUntil is stale with no event', async () => {
      const fixture = await leaseFixture();
      fixture.clock.now = Date.parse(fixture.grant.claimedUntil);
      const renewed = await post(fixture.app, 'lease', { leaseToken: fixture.grant.leaseToken });
      expect({ status: renewed.status, sent: fixture.sent.length, generation: fixture.durable().lease?.leaseGeneration ?? null }).toEqual({
        status: 409, sent: 1, generation: 1,
      });
    });

    test('generation-1 renew is fenced after equality reclaim with no event', async () => {
      const fixture = await leaseFixture();
      const second = await reclaimAtEquality(fixture);
      const renewed = await post(fixture.app, 'lease', { leaseToken: fixture.grant.leaseToken });
      expect({
        reclaim: second.claim.status,
        generation: second.grant.leaseGeneration,
        renew: renewed.status,
        sent: fixture.sent.length,
      }).toEqual({ reclaim: 200, generation: 2, renew: 409, sent: 3 });
    });

    test('generation-1 release is fenced after generation-2 reclaim with no event', async () => {
      const fixture = await leaseFixture();
      const second = await reclaimAtEquality(fixture);
      const released = await post(fixture.app, 'release', { leaseToken: fixture.grant.leaseToken });
      expect({
        reclaim: second.claim.status,
        generation: second.grant.leaseGeneration,
        release: released.status,
        sent: fixture.sent.length,
      }).toEqual({ reclaim: 200, generation: 2, release: 409, sent: 3 });
    });

    test('generation-1 ordinary state update is fenced after generation-2 reclaim', async () => {
      const fixture = await leaseFixture();
      const second = await reclaimAtEquality(fixture);
      const updated = await post(fixture.app, 'state', { state: 'input-required', leaseToken: fixture.grant.leaseToken });
      expect({
        reclaim: second.claim.status,
        update: updated.status,
        returnedState: objectValue(updated.body).state ?? null,
        sent: fixture.sent.length,
      }).toEqual({ reclaim: 200, update: 409, returnedState: null, sent: 3 });
    });

    test('generation-1 terminal completion is fenced after generation-2 reclaim', async () => {
      const fixture = await leaseFixture();
      const second = await reclaimAtEquality(fixture);
      const updated = await post(fixture.app, 'state', { state: 'completed', leaseToken: fixture.grant.leaseToken });
      expect({
        reclaim: second.claim.status,
        update: updated.status,
        returnedState: objectValue(updated.body).state ?? null,
        sent: fixture.sent.length,
      }).toEqual({ reclaim: 200, update: 409, returnedState: null, sent: 3 });
    });

    test('current-generation token performs one nonterminal state update', async () => {
      const fixture = await leaseFixture();
      const updated = await post(fixture.app, 'state', { state: 'input-required', leaseToken: fixture.grant.leaseToken });
      expect({
        status: updated.status,
        state: objectValue(updated.body).state ?? null,
        sent: fixture.sent.length,
        tokenFree: !containsSecret(updated.body, fixture.grant.leaseToken),
      }).toEqual({ status: 200, state: 'input-required', sent: 2, tokenFree: true });
    });

    test('current-generation token performs one terminal completion', async () => {
      const fixture = await leaseFixture();
      const updated = await post(fixture.app, 'state', { state: 'completed', leaseToken: fixture.grant.leaseToken });
      expect({
        status: updated.status,
        state: objectValue(updated.body).state ?? null,
        sent: fixture.sent.length,
        tokenFree: !containsSecret(updated.body, fixture.grant.leaseToken),
      }).toEqual({ status: 200, state: 'completed', sent: 2, tokenFree: true });
    });

    test('current-generation release records one event, clears authority, and returns a closed view', async () => {
      const fixture = await leaseFixture();
      const released = await post(fixture.app, 'release', { leaseToken: fixture.grant.leaseToken, reason: 'done' });
      const body = objectValue(released.body);
      const event = fixture.sent.length > 1 ? await parseCaptured(fixture.sent.at(-1)!, 3) : null;
      expect({
        status: released.status,
        sent: fixture.sent.length,
        authenticatedEvent: event !== null,
        activeLease: body.claimedUntil ?? null,
        tokenFree: !containsSecret(released.body, fixture.grant.leaseToken),
      }).toEqual({ status: 200, sent: 2, authenticatedEvent: true, activeLease: null, tokenFree: true });
    });

    test('release replay rebuilds signed history, returns the same closed result, and emits no second event', async () => {
      const fixture = await leaseFixture();
      const first = await post(fixture.app, 'release', { leaseToken: fixture.grant.leaseToken, reason: 'done' });
      const claimEvent = fixture.sent[0] ? await parsedClaim(fixture.sent[0]!, 2) : null;
      const releaseEvent = fixture.sent[1] ? await parseCaptured(fixture.sent[1]!, 3) : null;
      const rebuilt = claimEvent && releaseEvent
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, releaseEvent])
        : null;
      const firstReleaseDeliveries = fixture.sent.filter(
        (input) => input.headers?.['X-OA-Task-Lease-Event'] === 'release',
      ).length;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => rebuilt);
      const replay = await post(fixture.app, 'release', { leaseToken: fixture.grant.leaseToken, reason: 'done' });
      expect({
        first: first.status,
        firstReleaseDeliveries,
        unmodifiedClaimParsed: claimEvent !== null,
        unmodifiedReleaseParsed: releaseEvent !== null,
        rebuilt: rebuilt !== null,
        rebuiltHasNoActiveLease: rebuilt?.lease === undefined,
        replay: replay.status,
        sameBody: JSON.stringify(first.body) === JSON.stringify(replay.body),
        totalDeliveries: fixture.sent.length,
        tokenFree: !containsSecret(first.body, fixture.grant.leaseToken) && !containsSecret(replay.body, fixture.grant.leaseToken),
      }).toEqual({
        first: 200,
        firstReleaseDeliveries: 1,
        unmodifiedClaimParsed: true,
        unmodifiedReleaseParsed: true,
        rebuilt: true,
        rebuiltHasNoActiveLease: true,
        replay: 200,
        sameBody: true,
        totalDeliveries: 2,
        tokenFree: true,
      });
    });

    test('restart rebuild preserves pre-expiry exclusion and fences the old token after equality reclaim', async () => {
      const fixture = await leaseFixture();
      fixture.clock.now = Date.parse(fixture.grant.claimedUntil) - 1;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => fixture.durable());
      const secondBeforeExpiry = await post(fixture.app, 'claim', { leaseSec: 300 });
      const currentUpdate = await post(fixture.app, 'state', { state: 'input-required', leaseToken: fixture.grant.leaseToken });
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => fixture.durable());
      fixture.clock.now = Date.parse(fixture.grant.claimedUntil);
      const reclaim = await post(fixture.app, 'claim', { leaseSec: 300 });
      const staleUpdate = await post(fixture.app, 'state', { state: 'completed', leaseToken: fixture.grant.leaseToken });
      expect({
        secondBeforeExpiry: secondBeforeExpiry.status,
        currentUpdate: currentUpdate.status,
        equalityGeneration: objectValue(reclaim.body).leaseGeneration ?? null,
        staleUpdate: staleUpdate.status,
        staleState: objectValue(staleUpdate.body).state ?? null,
        sent: fixture.sent.length,
      }).toEqual({
        secondBeforeExpiry: 409,
        currentUpdate: 200,
        equalityGeneration: 2,
        staleUpdate: 409,
        staleState: null,
        sent: 4,
      });
    });

    test('captured renew and release events require authentic unmodified history and reject every altered authority field', async () => {
      const fixture = await leaseFixture();
      fixture.clock.now = Date.parse(fixture.grant.claimedUntil) - 1;
      const renew = await post(fixture.app, 'lease', { leaseToken: fixture.grant.leaseToken });
      const release = await post(fixture.app, 'release', { leaseToken: fixture.grant.leaseToken, reason: 'done' });
      const events = fixture.sent.slice(1);
      const originals = await Promise.all(events.map((input, index) => parseCaptured(input, index + 3)));
      const mutationResults = await Promise.all(events.flatMap((input, index) => {
        const payloadHeader = input.headers?.['X-OA-Task-Lease-Payload'];
        if (!payloadHeader) return [];
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(Buffer.from(payloadHeader, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return []; }
        const payloadMutations = Object.keys(payload).map((field) => parseCaptured(input, index + 20, {
          'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify({ ...payload, [field]: `altered-${field}` }), 'utf8').toString('base64url'),
        }));
        return [
          ...payloadMutations,
          parseCaptured(input, index + 40, { 'X-OA-Task-Lease-Event': 'header-payload-disagreement' }),
          parseCaptured(input, index + 60, { 'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify({ ...payload, at: 'not-a-time' }), 'utf8').toString('base64url') }),
          parseCaptured(input, index + 80, { 'X-OA-Task-Lease-Payload': Buffer.from(JSON.stringify({ ...payload, leaseToken: fixture.grant.leaseToken }), 'utf8').toString('base64url') }),
        ];
      }));
      const rebuilt = originals.length === 2 && originals.every((event): event is RawTaskMessage => !!event)
        ? taskFromMessages(ID, [submittedRaw(), (await parsedClaim(fixture.sent[0]!, 2))!, ...originals])
        : null;
      const claimEvent = fixture.sent[0] ? await parsedClaim(fixture.sent[0]!, 2) : null;
      const wrongActorParticipantRejected = claimEvent && originals.length === 2
        && originals.every((event): event is RawTaskMessage => !!event)
        && originals.every((event) => taskFromMessages(ID, [
          submittedRaw(),
          claimEvent,
          // This keeps the parser-authenticated lease payload and stamp intact,
          // while proving rebuild rejects a changed outer actor relation.
          { ...event, from: A, to: B },
        ]) === null);
      const nonMonotonicRejected = claimEvent && originals[0]
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, originals[0], { ...originals[0], uid: 99 }]) === null
        : false;
      expect({
        renew: renew.status,
        release: release.status,
        captured: events.length,
        unmodifiedParsed: originals.filter(Boolean).length,
        rebuilt: rebuilt !== null,
        attemptedAlterations: mutationResults.length > 0,
        allAlterationsRejected: mutationResults.every((event) => event === null),
        wrongActorParticipantRejected,
        nonMonotonicRejected,
      }).toEqual({
        renew: 200,
        release: 200,
        captured: 2,
        unmodifiedParsed: 2,
        rebuilt: true,
        attemptedAlterations: true,
        allAlterationsRejected: true,
        wrongActorParticipantRejected: true,
        nonMonotonicRejected: true,
      });
    });

    test('only the immediate claim grant may contain the bearer or expose no verifier in public or log/error surfaces', async () => {
      const fixture = await leaseFixture();
      // `taskService.list` is intentionally an IMAP scan with no list test
      // seam. Keep the real production operations while replacing only this
      // route's read source with the existing selected-service seam.
      const publicApp = productionApp({ ...taskService, async list() { return [fixture.durable()]; } });
      const warning = console.warn;
      const warnings: unknown[][] = [];
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      let list: RouteResult = { status: 0, body: null };
      let detail: RouteResult = { status: 0, body: null };
      let state: RouteResult = { status: 0, body: null };
      let renew: RouteResult = { status: 0, body: null };
      let release: RouteResult = { status: 0, body: null };
      try {
        const listResponse = await publicApp.request('/v1/tasks');
        list = { status: listResponse.status, body: await listResponse.json() };
        const detailResponse = await publicApp.request(`/v1/tasks/${ID}`);
        detail = { status: detailResponse.status, body: await detailResponse.json() };
        state = await post(publicApp, 'state', { state: 'input-required', leaseToken: fixture.grant.leaseToken });
        renew = await post(publicApp, 'lease', { leaseToken: fixture.grant.leaseToken, leaseSec: 301 });
        release = await post(publicApp, 'release', { leaseToken: fixture.grant.leaseToken });
      } finally {
        console.warn = warning;
      }
      const verifier = fixture.durable().lease?.tokenVerifier ?? '';
      const publicSurfaces = [list.body, detail.body, state.body, renew.body, release.body, warnings];
      expect({
        statuses: [fixture.claim.status, list.status, detail.status, state.status, renew.status, release.status],
        immediateClaimHasBearer: containsSecret(fixture.claim.body, fixture.grant.leaseToken),
        mailAndPrivateHaveNoBearer: !containsSecret([fixture.sent, fixture.durable()], fixture.grant.leaseToken),
        publicHasNoBearer: !containsSecret(publicSurfaces, fixture.grant.leaseToken),
        publicHasNoVerifier: !containsSecret(publicSurfaces, verifier),
        logsAndErrorsHaveNoBearer: !containsSecret([warnings, renew.body, release.body], fixture.grant.leaseToken),
      }).toEqual({
        statuses: [200, 200, 200, 200, 200, 200],
        immediateClaimHasBearer: true,
        mailAndPrivateHaveNoBearer: true,
        publicHasNoBearer: true,
        publicHasNoVerifier: true,
        logsAndErrorsHaveNoBearer: true,
      });
    });
  });
}

describe('#56 R11 public lease expiry', () => {
  test('R11 RED: REST list and detail hide public lease timing at the half-open expiry boundary without writes', async () => {
      const fixture = await leaseFixture();
      const claimedUntil = fixture.grant.claimedUntil;
      const privateVerifier = fixture.durable().lease?.tokenVerifier;
      const publicApp = productionApp({
        ...taskService,
        async list() { return [fixture.durable()]; },
        async get() { return fixture.durable(); },
      });
      const read = async () => {
        const [list, detail] = await Promise.all([
          publicApp.request('/v1/tasks'),
          publicApp.request(`/v1/tasks/${ID}`),
        ]);
        const listBody = await list.json() as { tasks?: Array<Record<string, unknown>> };
        const detailBody = await detail.json() as Record<string, unknown>;
        const listed = listBody.tasks?.[0];
        return {
          statuses: [list.status, detail.status],
          listTiming: [listed?.claimedUntil ?? null, listed?.leaseGeneration ?? null],
          detailTiming: [detailBody.claimedUntil ?? null, detailBody.leaseGeneration ?? null],
        };
      };

      fixture.clock.now = Date.parse(claimedUntil) - 1;
      const deliveriesBeforeReads = fixture.sent.length;
      const before = await read();
      const deliveriesAfterBefore = fixture.sent.length;
      fixture.clock.now = Date.parse(claimedUntil);
      const atBoundary = await read();
      const deliveriesAfterBoundary = fixture.sent.length;

      expect({
        before,
        atBoundary,
        deliveries: [deliveriesBeforeReads, deliveriesAfterBefore, deliveriesAfterBoundary],
        privateAuthorityUnchanged: fixture.durable().lease?.claimedUntil === claimedUntil
          && fixture.durable().lease?.leaseGeneration === fixture.grant.leaseGeneration
          && fixture.durable().lease?.tokenVerifier === privateVerifier,
      }).toEqual({
        before: {
          statuses: [200, 200],
          listTiming: [claimedUntil, fixture.grant.leaseGeneration],
          detailTiming: [claimedUntil, fixture.grant.leaseGeneration],
        },
        atBoundary: {
          statuses: [200, 200],
          listTiming: [null, null],
          detailTiming: [null, null],
        },
        deliveries: [1, 1, 1],
        privateAuthorityUnchanged: true,
      });
  });
});

describe('#56 R12 remaining P1 gates', () => {
  test('R12 RED: production claim rejects input-required without a delivery or queued working projection', async () => {
    let now = START;
    const sent: SendInput[] = [];
    const inputRequired = { ...submittedTask(), state: 'input-required' as const };
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => inputRequired);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<r12-unexpected-claim>' };
    });

    const outcome = await claimTask({ id: ID, from: B, leaseSec: 300 }).then(
      () => 'granted',
      (error: Error) => error.message,
    );
    const projected = await taskService.get(ID);
    expect({
      outcome,
      deliveries: sent.length,
      durableState: inputRequired.state,
      activeLease: inputRequired.lease !== undefined,
      queuedWorkingProjection: projected?.state === 'working',
    }).toEqual({
      outcome: 'task_not_claimable',
      deliveries: 0,
      durableState: 'input-required',
      activeLease: false,
      queuedWorkingProjection: false,
    });
  });

  test('R12 GREEN: queued active lease projection hides at equality without a read write', async () => {
    let now = START;
    const sent: SendInput[] = [];
    const durable = submittedTask();
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<r12-queued-claim>' };
    });
    const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const publicApp = productionApp({
      ...taskService,
      async list() {
        const task = await taskService.get(ID);
        return task ? [task] : [];
      },
      async get() { return taskService.get(ID); },
    });
    const read = async () => {
      const [list, detail] = await Promise.all([
        publicApp.request('/v1/tasks'),
        publicApp.request(`/v1/tasks/${ID}`),
      ]);
      const listBody = await list.json() as { tasks?: Array<Record<string, unknown>> };
      const detailBody = await detail.json() as Record<string, unknown>;
      const listed = listBody.tasks?.[0];
      return {
        statuses: [list.status, detail.status],
        listTiming: [listed?.claimedUntil ?? null, listed?.leaseGeneration ?? null],
        detailTiming: [detailBody.claimedUntil ?? null, detailBody.leaseGeneration ?? null],
      };
    };

    now = Date.parse(grant.claimedUntil) - 1;
    const deliveriesBeforeReads = sent.length;
    const before = await read();
    const deliveriesAfterBefore = sent.length;
    now = Date.parse(grant.claimedUntil);
    const atBoundary = await read();
    const deliveriesAfterBoundary = sent.length;
    const queued = await taskService.get(ID);
    expect({
      before,
      atBoundary,
      deliveries: [deliveriesBeforeReads, deliveriesAfterBefore, deliveriesAfterBoundary],
      privateAuthorityUnchanged: queued?.lease?.claimedUntil === grant.claimedUntil
        && queued.lease?.leaseGeneration === grant.leaseGeneration
        && queued.lease?.tokenVerifier === grant.task.lease?.tokenVerifier,
    }).toEqual({
      before: {
        statuses: [200, 200],
        listTiming: [grant.claimedUntil, grant.leaseGeneration],
        detailTiming: [grant.claimedUntil, grant.leaseGeneration],
      },
      atBoundary: {
        statuses: [200, 200],
        listTiming: [null, null],
        detailTiming: [null, null],
      },
      deliveries: [1, 1, 1],
      privateAuthorityUnchanged: true,
    });
  });

  test('R12 GREEN: released working task reclaims only from its authenticated release receipt', async () => {
    let now = START;
    const durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r12-release-reclaim-${sent.length}>` };
    });
    const first = await claimTask({ id: ID, from: B, leaseSec: 300 });
    const released = await taskService.release!({ id: ID, from: B, leaseToken: first.leaseToken });
    const reclaimed = await claimTask({ id: ID, from: B, leaseSec: 300 });
    expect({
      releasedWorking: released.state,
      authenticatedReleaseReceipt: released.releasedLease?.tokenVerifier === first.task.lease?.tokenVerifier,
      reclaimGeneration: reclaimed.leaseGeneration,
      reclaimedAuthority: reclaimed.task.lease?.leaseGeneration === reclaimed.leaseGeneration
        && reclaimed.task.lease?.claimedUntil === reclaimed.claimedUntil,
      reclaimedHasNoStaleReceipt: reclaimed.task.releasedLease === undefined && reclaimed.task.expiredLease === undefined,
      deliveries: sent.length,
    }).toEqual({
      releasedWorking: 'working',
      authenticatedReleaseReceipt: true,
      reclaimGeneration: 2,
      reclaimedAuthority: true,
      reclaimedHasNoStaleReceipt: true,
      deliveries: 3,
    });
  });

  test('R12 GREEN: terminal queued overlay clears stale expiry receipt privately and publicly', async () => {
    const expired = {
      ...submittedTask(),
      state: 'working' as const,
      expiredLease: {
        leaseGeneration: 1,
        claimedUntil: '2026-08-24T00:05:00.000Z',
        expiredAt: '2026-08-24T00:05:00.000Z',
      },
    };
    const sent: SendInput[] = [];
    setTaskGetForTests(async () => expired);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<r12-terminal-overlay>' };
    });
    await taskService.update({ id: ID, from: A, state: 'completed' });
    const queued = await taskService.get(ID);
    const publicView = queued ? toTaskView(queued) : null;
    expect({
      delivery: sent.length,
      terminal: queued?.state,
      privateExpiredReceipt: queued?.expiredLease !== undefined,
      publicExpiredReceipt: publicView ? Object.hasOwn(publicView, 'expiredLease') : null,
    }).toEqual({
      delivery: 1,
      terminal: 'completed',
      privateExpiredReceipt: false,
      publicExpiredReceipt: false,
    });
  });
});

if (process.env.TASK_LEASES_R6_RED === '1') {
  describe('#56 R6a production lease-core matrix RED', () => {
    test('indexed release dominates queued same-generation claim and renew overlays', async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r6a-indexed-release-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
      const token = typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '';
      now += 1_000;
      const renew = await post(app, 'lease', { leaseToken: token, leaseSec: 300 });
      const firstRelease = await post(app, 'release', { leaseToken: token, reason: 'indexed release' });
      const claimEvent = sent[0] ? await parsedClaim(sent[0]!, 2) : null;
      const renewEvent = sent[1] ? await parseCaptured(sent[1]!, 3) : null;
      const releaseEvent = sent[2] ? await parseCaptured(sent[2]!, 4) : null;
      const indexed = claimEvent && renewEvent && releaseEvent
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, renewEvent, releaseEvent])
        : null;
      // Deliberately retain the queued map while making the durable fixture
      // expose every authenticated event: this is the indexing-race seam.
      if (indexed) durable = indexed;
      setTaskGetForTests(async () => durable);
      expect({
        claim: claim.status,
        renew: renew.status,
        firstRelease: firstRelease.status,
        authenticatedEvents: [claimEvent, renewEvent, releaseEvent].filter(Boolean).length,
        durableReleased: indexed?.lease === undefined && indexed?.releasedLease !== undefined,
        firstDeliveries: sent.length,
      }).toEqual({
        claim: 200,
        renew: 200,
        firstRelease: 200,
        authenticatedEvents: 3,
        durableReleased: true,
        firstDeliveries: 3,
      });

      const detailResponse = await app.request(`/v1/tasks/${ID}`);
      const detail = await detailResponse.json();
      const replay = await post(app, 'release', { leaseToken: token, reason: 'indexed release' });
      expect({
        detail: detailResponse.status,
        publicClaimedUntil: objectValue(detail).claimedUntil ?? null,
        publicLeaseGeneration: objectValue(detail).leaseGeneration ?? null,
        replay: replay.status,
        sameClosedBody: JSON.stringify(firstRelease.body) === JSON.stringify(replay.body),
        deliveries: sent.length,
      }).toEqual({
        detail: 200,
        publicClaimedUntil: null,
        publicLeaseGeneration: null,
        replay: 200,
        sameClosedBody: true,
        deliveries: 3,
      });
    });

    test('a current early short renew is an identical no-op with claim-only history', async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r6a-short-renew-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
      const token = typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '';
      const claimEvent = sent[0] ? await parsedClaim(sent[0]!, 2) : null;
      const original = claimEvent ? taskFromMessages(ID, [submittedRaw(), claimEvent]) : null;
      if (original) durable = original;
      setTaskGetForTests(async () => durable);
      expect({
        claim: claim.status,
        authenticatedClaim: claimEvent !== null,
        originalRebuild: original !== null,
        originalAuthorityCurrent: original ? isTaskLeaseTokenCurrent(original, token, now) : false,
        originalClaimedUntil: original?.lease?.claimedUntil ?? null,
      }).toEqual({
        claim: 200,
        authenticatedClaim: true,
        originalRebuild: true,
        originalAuthorityCurrent: true,
        originalClaimedUntil: claimBody.claimedUntil ?? null,
      });

      now += 1_000;
      const beforeResponse = await app.request(`/v1/tasks/${ID}`);
      const before = await beforeResponse.json();
      const renew = await post(app, 'lease', { leaseToken: token, leaseSec: 30 });
      const renewEvent = sent[1] ? await parseCaptured(sent[1]!, 3) : null;
      const postAttempt = claimEvent && renewEvent
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, renewEvent])
        : original;
      expect({
        status: renew.status,
        error: objectValue(renew.body).error ?? null,
        deliveries: sent.length,
        activeAuthorityUnchanged: postAttempt?.lease?.claimedUntil === claimBody.claimedUntil
          && (postAttempt ? isTaskLeaseTokenCurrent(postAttempt, token, now) : false),
        originalClaimStillRebuilds: original !== null,
        capturedHistoryRebuilds: postAttempt !== null,
        samePublicSnapshot: beforeResponse.status === 200 && JSON.stringify(before) === JSON.stringify(renew.body),
      }).toEqual({
        status: 200,
        error: null,
        deliveries: 1,
        activeAuthorityUnchanged: true,
        originalClaimStillRebuilds: true,
        capturedHistoryRebuilds: true,
        samePublicSnapshot: true,
      });
    });

    test('a current default renew at the frozen clock is an identical no-op with no second event', async () => {
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r7a-default-renew-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
      const token = typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '';
      const beforeResponse = await app.request(`/v1/tasks/${ID}`);
      const before = await beforeResponse.json();
      const renew = await post(app, 'lease', { leaseToken: token });
      const body = objectValue(renew.body) as Partial<LeaseGrantBody>;
      const secondLeaseEvent = sent[1] ? await parseCaptured(sent[1]!, 3) : null;
      expect({
        claim: claim.status,
        status: renew.status,
        error: objectValue(renew.body).error ?? null,
        identicalExpiry: body.claimedUntil === claimBody.claimedUntil,
        identicalGeneration: body.leaseGeneration === claimBody.leaseGeneration,
        sameMessages: beforeResponse.status === 200 && JSON.stringify(before) === JSON.stringify(renew.body),
        claimOnlyDelivery: sent.length,
        secondCapturedLeaseEvent: secondLeaseEvent !== null,
      }).toEqual({
        claim: 200,
        status: 200,
        error: null,
        identicalExpiry: true,
        identicalGeneration: true,
        sameMessages: true,
        claimOnlyDelivery: 1,
        secondCapturedLeaseEvent: false,
      });
    });

    test('an immediate same-token same-reason release replay is closed and emits only one release', async () => {
      const sent: SendInput[] = [];
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => submittedTask());
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r7a-immediate-release-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const token = objectValue(claim.body).leaseToken;
      const leaseToken = typeof token === 'string' ? token : '';
      const first = await post(app, 'release', { leaseToken, reason: 'done' });
      const replay = await post(app, 'release', { leaseToken, reason: 'done' });
      const differentReason = await post(app, 'release', { leaseToken, reason: 'not done' });
      expect({
        claim: claim.status,
        first: first.status,
        replay: replay.status,
        sameClosedSnapshot: JSON.stringify(first.body) === JSON.stringify(replay.body),
        differentReason: differentReason.status,
        deliveries: sent.length,
      }).toEqual({
        claim: 200,
        first: 200,
        replay: 200,
        sameClosedSnapshot: true,
        differentReason: 409,
        deliveries: 2,
      });
    });

    test('a release reason longer than 1000 characters follows the ordinary durable replay contract', async () => {
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r6a-long-reason-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
      const token = typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '';
      const claimEvent = sent[0] ? await parsedClaim(sent[0]!, 2) : null;
      const original = claimEvent ? taskFromMessages(ID, [submittedRaw(), claimEvent]) : null;
      if (original) durable = original;
      setTaskGetForTests(async () => durable);
      expect({
        claim: claim.status,
        authenticatedClaim: claimEvent !== null,
        originalRebuild: original !== null,
        tokenCurrent: original ? isTaskLeaseTokenCurrent(original, token) : false,
      }).toEqual({ claim: 200, authenticatedClaim: true, originalRebuild: true, tokenCurrent: true });

      const reason = 'r'.repeat(1_001);
      const first = await post(app, 'release', { leaseToken: token, reason });
      const releaseEvent = sent[1] ? await parseCaptured(sent[1]!, 3) : null;
      const rebuilt = claimEvent && releaseEvent
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, releaseEvent])
        : null;
      if (rebuilt) durable = rebuilt;
      setTaskGetForTests(async () => durable);
      const replay = await post(app, 'release', { leaseToken: token, reason });
      expect({
        first: first.status,
        authenticatedRelease: releaseEvent !== null,
        productionParserRestoresReason: releaseEvent?.lease?.event === 'release' && releaseEvent.lease.reason === reason,
        releasedRebuild: rebuilt?.lease === undefined && rebuilt?.releasedLease !== undefined,
        rebuildRestoresReason: rebuilt?.releasedLease?.reason === reason,
        replay: replay.status,
        sameClosedBody: JSON.stringify(first.body) === JSON.stringify(replay.body),
        deliveries: sent.length,
      }).toEqual({
        first: 200,
        authenticatedRelease: true,
        productionParserRestoresReason: true,
        releasedRebuild: true,
        rebuildRestoresReason: true,
        replay: 200,
        sameClosedBody: true,
        deliveries: 2,
      });
    });

    test('R17 GREEN: owner-approved release reason limit survives actual folded mail parser and rebuild', async () => {
      const durable = submittedTask();
      const sent: SendInput[] = [];
      const reason = 'r'.repeat(TASK_LEASE_REASON_MAX_CHARS);
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r17-8000-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const leaseToken = objectValue(claim.body).leaseToken;
      const token = typeof leaseToken === 'string' ? leaseToken : '';
      const release = await post(app, 'release', { leaseToken: token, reason });
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
      const serialize = async (input: SendInput) => {
        const result = await transport.sendMail({
          from: input.from, to: input.to, subject: input.subject, text: input.text, headers: input.headers,
        });
        if (!Buffer.isBuffer(result.message)) throw new Error('R17 stream transport must return buffered RFC 5322 source');
        return result.message;
      };
      const claimSource = sent[0] ? await serialize(sent[0]) : null;
      const releaseSource = sent[1] ? await serialize(sent[1]) : null;
      const asFetch = (source: Buffer, input: SendInput, uid: number) => ({
        uid, source,
        envelope: { from: [{ address: input.from }], to: [{ address: input.to[0] }], subject: input.subject },
        internalDate: new Date(START),
      } as unknown as FetchMessageObject);
      const claimEvent = claimSource && sent[0] ? await parseTaskMessageForTests(asFetch(claimSource, sent[0], 2), ID) : null;
      const releaseEvent = releaseSource && sent[1] ? await parseTaskMessageForTests(asFetch(releaseSource, sent[1], 3), ID) : null;
      const headerBlock = releaseSource?.toString('utf8').split(/\r?\n\r?\n/, 1)[0] ?? '';
      const payloadWire = headerBlock.match(/^X-OA-Task-Lease-Payload:[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/mi)?.[0] ?? '';
      const payloadValue = sent[1]?.headers?.['X-OA-Task-Lease-Payload'] ?? '';
      const rebuilt = claimEvent && releaseEvent ? taskFromMessages(ID, [submittedRaw(), claimEvent, releaseEvent]) : null;
      const evidence = {
        reasonChars: reason.length,
        base64PayloadChars: payloadValue.length,
        base64Expanded: payloadValue.length > reason.length,
        payloadFolded: /\r?\n[ \t]/.test(payloadWire),
        payloadUnfoldsExactly: payloadWire.replace(/^X-OA-Task-Lease-Payload:\s*/i, '').replace(/\r?\n[ \t]+/g, '') === payloadValue,
        productionParserRestoresReason: releaseEvent?.lease?.event === 'release' && releaseEvent.lease.reason === reason,
        releasedRebuildRestoresReason: rebuilt?.releasedLease?.reason === reason && rebuilt.lease === undefined,
      };
      console.info(JSON.stringify({ r17Reason8000WireEvidence: evidence }));
      expect({ claim: claim.status, release: release.status, ...evidence }).toEqual({
        claim: 200,
        release: 200,
        reasonChars: TASK_LEASE_REASON_MAX_CHARS,
        base64PayloadChars: expect.any(Number),
        base64Expanded: true,
        payloadFolded: true,
        payloadUnfoldsExactly: true,
        productionParserRestoresReason: true,
        releasedRebuildRestoresReason: true,
      });
    });

    test('R17 GREEN: route rejects an over-limit reason before service, delivery, event, or queue mutation', async () => {
      let serviceCalls = 0;
      const deliveries: SendInput[] = [];
      setTaskSendMailForTests(async (input) => {
        deliveries.push(input);
        return { messageId: '<r17-route-should-not-deliver>' };
      });
      const service: TaskService = {
        ...taskService,
        get: async () => {
          serviceCalls += 1;
          return submittedTask();
        },
        release: async () => {
          serviceCalls += 1;
          return submittedTask();
        },
      };
      const response = await post(productionApp(service), 'release', {
        leaseToken: 'r17-route-token', reason: 'r'.repeat(TASK_LEASE_REASON_MAX_CHARS + 1),
      });
      expect({
        status: response.status,
        error: objectValue(response.body).error ?? null,
        serviceCalls,
        deliveries: deliveries.length,
      }).toEqual({
        status: 400,
        error: 'invalid_request',
        serviceCalls: 0,
        deliveries: 0,
      });
    });

    test('R17 GREEN: core bypass rejects an over-limit reason before side effects and preserves authority', async () => {
      const durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => START);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r17-core-${sent.length}>` };
      });
      const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
      const before = await taskService.get(ID);
      const attempt = await Promise.allSettled([
        releaseTask({ id: ID, from: B, leaseToken: grant.leaseToken, reason: 'r'.repeat(TASK_LEASE_REASON_MAX_CHARS + 1) }),
      ]);
      const after = await taskService.get(ID);
      expect({
        rejectedInvalidRequest: attempt[0]?.status === 'rejected' && String(attempt[0].reason).includes('invalid_request'),
        deliveries: sent.length,
        stateUnchanged: after?.state === before?.state,
        authorityUnchanged: after?.lease?.leaseGeneration === before?.lease?.leaseGeneration
          && after?.lease?.claimedUntil === before?.lease?.claimedUntil
          && after?.lease?.tokenVerifier === before?.lease?.tokenVerifier,
        noReleasedReceipt: after?.releasedLease === undefined,
      }).toEqual({
        rejectedInvalidRequest: true,
        deliveries: 1,
        stateUnchanged: true,
        authorityUnchanged: true,
        noReleasedReceipt: true,
      });
    });

    test('same-generation durable renew dominates its queued claim and renew predecessors', async () => {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r6d-durable-renew-${sent.length}>` };
      });
      const app = productionApp();
      const claim = await post(app, 'claim', { leaseSec: 300 });
      const claimBody = objectValue(claim.body) as Partial<LeaseGrantBody>;
      const token = typeof claimBody.leaseToken === 'string' ? claimBody.leaseToken : '';
      now += 30_000;
      const renew = await post(app, 'lease', { leaseToken: token, leaseSec: 300 });
      const renewBody = objectValue(renew.body) as Partial<LeaseGrantBody>;
      const claimEvent = sent[0] ? await parsedClaim(sent[0]!, 2) : null;
      const renewEvent = sent[1] ? await parseCaptured(sent[1]!, 3) : null;
      const rebuilt = claimEvent && renewEvent
        ? taskFromMessages(ID, [submittedRaw(), claimEvent, renewEvent])
        : null;
      // Replace only the durable read source. The production queued overlay is
      // intentionally retained to exercise its durable-indexing boundary.
      if (rebuilt) durable = rebuilt;
      setTaskGetForTests(async () => durable);
      const originalExpiry = Date.parse(claimBody.claimedUntil ?? '');
      const renewedExpiry = Date.parse(renewBody.claimedUntil ?? '');
      now = originalExpiry + 1;
      const detailResponse = await app.request(`/v1/tasks/${ID}`);
      const detail = await detailResponse.json();
      const release = await post(app, 'release', { leaseToken: token, reason: 'r6d durable renew' });
      expect({
        claim: claim.status,
        renew: renew.status,
        initialDeliveries: sent.length - (release.status === 200 ? 1 : 0),
        rebuiltGeneration: rebuilt?.lease?.leaseGeneration ?? null,
        rebuiltClaimedUntil: rebuilt?.lease?.claimedUntil ?? null,
        detail: detailResponse.status,
        detailClaimedUntil: objectValue(detail).claimedUntil ?? null,
        detailLeaseGeneration: objectValue(detail).leaseGeneration ?? null,
        release: release.status,
        deliveries: sent.length,
        originalBeforeRenewed: originalExpiry < renewedExpiry,
        afterOriginalBeforeRenewed: now > originalExpiry && now < renewedExpiry,
      }).toEqual({
        claim: 200,
        renew: 200,
        initialDeliveries: 2,
        rebuiltGeneration: 1,
        rebuiltClaimedUntil: renewBody.claimedUntil ?? null,
        detail: 200,
        detailClaimedUntil: renewBody.claimedUntil ?? null,
        detailLeaseGeneration: 1,
        release: 200,
        deliveries: 3,
        originalBeforeRenewed: true,
        afterOriginalBeforeRenewed: true,
      });
    });
  });
}
