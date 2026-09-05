import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-dispatcher-'));
process.env.NODE_ENV = 'test';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const {
  EventDispatcher,
  getEventDispatcher,
  setEventDispatcherForTests,
  isEventDispatcher,
  isSinkServiceFailure,
} = await import('../src/lib/event-dispatcher.ts');
type EventSink = import('../src/lib/event-dispatcher.ts').EventSink;
type MailReceivedEvent = import('../src/lib/event-dispatcher.ts').MailReceivedEvent;
type ApprovalRequestedEvent = import('../src/lib/event-dispatcher.ts').ApprovalRequestedEvent;
type SinkWatermark = import('../src/lib/event-dispatcher.ts').SinkWatermark;

const {
  createNtfySink,
  isNotificationWatcherEnabled,
  startNotificationWatcher,
  watchConnection,
} = await import('../src/lib/notification-watcher.ts');
type WatchedMessage = import('../src/lib/notification-watcher.ts').WatchedMessage;
type WatcherWatermark = import('../src/lib/notification-watcher.ts').WatcherWatermark;

const { NotifyError } = await import('../src/lib/notify.ts');
const { createApprovalTask } = await import('../src/lib/tasks-internal.ts');
const taskSeams = await import('./support/task-test-seams.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { config } = await import('../src/lib/config.ts');

for (const localpart of ['requester', 'approver']) {
  if (!findIdentity(`${localpart}@test.example`)) {
    createIdentity({ localpart, issueToken: false });
  }
}

const baseIdentities = [
  {
    address: 'approver@test.example',
    name: 'Approver',
    can_notify_user: true,
    created_at: '2026-09-01T00:00:00Z',
  },
  {
    address: 'requester@test.example',
    name: 'Requester',
    can_notify_user: true,
    created_at: '2026-09-01T00:00:00Z',
  },
];

describe('Startup gate widening (§11.4 item 1 & §14 item 4)', () => {
  test('isNotificationWatcherEnabled opens when webhooks enabled even if ntfy disabled', () => {
    // ntfy disabled, webhooks enabled
    expect(
      isNotificationWatcherEnabled({
        ...config,
        ntfy: { ...config.ntfy, enabled: false, pushPolicy: 'otp' },
        webhooks: { ...config.webhooks, enabled: true },
      }),
    ).toBe(true);

    // ntfy enabled, webhooks disabled
    expect(
      isNotificationWatcherEnabled({
        ...config,
        ntfy: { ...config.ntfy, enabled: true, pushPolicy: 'otp' },
        webhooks: { ...config.webhooks, enabled: false },
      }),
    ).toBe(true);

    // ntfy enabled but pushPolicy is none, webhooks disabled
    expect(
      isNotificationWatcherEnabled({
        ...config,
        ntfy: { ...config.ntfy, enabled: true, pushPolicy: 'none' },
        webhooks: { ...config.webhooks, enabled: false },
      }),
    ).toBe(false);

    // ntfy pushPolicy none, but webhooks enabled -> watcher runs!
    expect(
      isNotificationWatcherEnabled({
        ...config,
        ntfy: { ...config.ntfy, enabled: true, pushPolicy: 'none' },
        webhooks: { ...config.webhooks, enabled: true },
      }),
    ).toBe(true);

    // both disabled
    expect(
      isNotificationWatcherEnabled({
        ...config,
        ntfy: { ...config.ntfy, enabled: false, pushPolicy: 'none' },
        webhooks: { ...config.webhooks, enabled: false },
      }),
    ).toBe(false);
  });

  test('startNotificationWatcher returns no-op when gate is closed', () => {
    const stopper = startNotificationWatcher({
      ...config,
      ntfy: { ...config.ntfy, enabled: false },
      webhooks: { ...config.webhooks, enabled: false },
    });
    expect(stopper).toBeFunction();
    stopper();
  });
});

describe('IMAP fetch widening (§11.4 item 2)', () => {
  test('watchConnection requests flags and internalDate in fetch query', async () => {
    let capturedQuery: any = null;
    const controller = new AbortController();
    const client = {
      mailbox: { uidValidity: 100n },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [41],
      fetch: async function* (_pending: any, query: any) {
        capturedQuery = query;
        yield {
          uid: 41,
          envelope: { from: [{ address: 'sender@example.com' }], subject: 'Test' },
          headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
          source: Buffer.from('From: sender@example.com\r\n\r\nHello'),
          flags: new Set(['\\Seen']),
          internalDate: new Date('2026-09-04T12:00:00Z'),
        };
      },
      idle: async () => { controller.abort(); },
      logout: async () => {},
      close() {},
    } as any;

    const dispatcher = new EventDispatcher();
    let receivedMessage: WatchedMessage | null = null;
    dispatcher.registerSink({
      id: 'test',
      isEnabled: () => true,
      watermark: { uid: 40, uidValidity: 100n },
      handleMail: async (event) => {
        receivedMessage = event.message;
      },
    });

    await watchConnection(
      controller.signal,
      client,
      dispatcher,
      { uid: 40, uidValidity: 100n },
      {
        identities: () => baseIdentities as any,
        identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
        wait: async () => {},
        error: () => {},
        now: () => Date.now(),
      },
    );

    expect(capturedQuery).toBeDefined();
    expect(capturedQuery.envelope).toBe(true);
    expect(capturedQuery.headers).toEqual(['delivered-to']);
    expect(capturedQuery.source).toBe(true);
    expect(capturedQuery.flags).toBe(true);
    expect(capturedQuery.internalDate).toBe(true);

    expect(receivedMessage).toBeDefined();
    expect(receivedMessage!.flags).toEqual(new Set(['\\Seen']));
    expect(receivedMessage!.internalDate).toEqual(new Date('2026-09-04T12:00:00Z'));
  });
});

describe('Per-sink watermark isolation (§11.4 item 3 & §14 item 4)', () => {
  function makeMockClient(messages: any[], controller: AbortController) {
    const pendingUids = messages.map((m) => m.uid);
    return {
      mailbox: { uidValidity: 1n },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => pendingUids,
      fetch: async function* (uids: number[]) {
        for (const msg of messages) {
          if (uids.includes(msg.uid)) {
            yield msg;
          }
        }
      },
      idle: async () => {
        controller.abort();
      },
      logout: async () => {},
      close() {},
    } as any;
  }

  test('failing webhook sink does not stall ntfy sink watermark progression', async () => {
    const messages = [
      {
        uid: 41,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 41' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nCode 123456'),
      },
      {
        uid: 42,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 42' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nCode 654321'),
      },
    ];

    const controller = new AbortController();
    const client = makeMockClient(messages, controller);

    const ntfyDelivered: number[] = [];
    const ntfyWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };
    const webhookWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };

    const dispatcher = new EventDispatcher();
    dispatcher.registerSink({
      id: 'ntfy',
      isEnabled: () => true,
      watermark: ntfyWatermark,
      handleMail: async (event) => {
        ntfyDelivered.push(event.message.uid);
      },
    });

    dispatcher.registerSink({
      id: 'webhook',
      isEnabled: () => true,
      watermark: webhookWatermark,
      handleMail: async (event) => {
        // Webhook sink fails with service outage on message 41
        throw new NotifyError('webhook_unavailable' as any, undefined, { failureKind: 'service' });
      },
    });

    const sharedWatermark: WatcherWatermark = { uid: 40, uidValidity: 1n };
    await watchConnection(
      controller.signal,
      client,
      dispatcher,
      sharedWatermark,
      {
        identities: () => baseIdentities as any,
        identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
        wait: async () => {},
        error: () => {},
        now: () => 1000,
      },
    );

    // Ntfy processed both messages 41 and 42!
    expect(ntfyDelivered).toEqual([41, 42]);
    expect(ntfyWatermark.uid).toBe(42);

    // Webhook sink failed on 41, so its watermark remains at 40 (retained)
    expect(webhookWatermark.uid).toBe(40);
    expect(webhookWatermark.serviceFailure?.uid).toBe(41);
  });

  test('failing ntfy sink does not stall webhook sink watermark progression', async () => {
    const messages = [
      {
        uid: 41,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 41' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nCode 123456'),
      },
      {
        uid: 42,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 42' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nCode 654321'),
      },
    ];

    const controller = new AbortController();
    const client = makeMockClient(messages, controller);

    const webhookDelivered: number[] = [];
    const ntfyWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };
    const webhookWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };

    const dispatcher = new EventDispatcher();
    dispatcher.registerSink({
      id: 'ntfy',
      isEnabled: () => true,
      watermark: ntfyWatermark,
      handleMail: async () => {
        throw new NotifyError('ntfy_503_service_down' as any, undefined, { failureKind: 'service' });
      },
    });

    dispatcher.registerSink({
      id: 'webhook',
      isEnabled: () => true,
      watermark: webhookWatermark,
      handleMail: async (event) => {
        webhookDelivered.push(event.message.uid);
      },
    });

    const sharedWatermark: WatcherWatermark = { uid: 40, uidValidity: 1n };
    await watchConnection(
      controller.signal,
      client,
      dispatcher,
      sharedWatermark,
      {
        identities: () => baseIdentities as any,
        identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
        wait: async () => {},
        error: () => {},
        now: () => 1000,
      },
    );

    // Webhook delivered both 41 and 42!
    expect(webhookDelivered).toEqual([41, 42]);
    expect(webhookWatermark.uid).toBe(42);

    // Ntfy watermark was retained at 40
    expect(ntfyWatermark.uid).toBe(40);
    expect(ntfyWatermark.serviceFailure?.uid).toBe(41);
  });

  test('failing sink abandons UID and advances watermark after 10-minute SERVICE_FAILURE_MAX_MS', async () => {
    const messages = [
      {
        uid: 41,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 41' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nBody'),
      },
    ];

    let now = 0;
    const loggedErrors: string[] = [];
    const webhookWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };
    const ntfyWatermark: SinkWatermark = { uid: 40, uidValidity: 1n };

    const dispatcher = new EventDispatcher();
    dispatcher.registerSink({
      id: 'ntfy',
      isEnabled: () => true,
      watermark: ntfyWatermark,
      handleMail: async () => {},
    });
    dispatcher.registerSink({
      id: 'webhook',
      isEnabled: () => true,
      watermark: webhookWatermark,
      handleMail: async () => {
        throw new NotifyError('endpoint_down' as any, undefined, { failureKind: 'service' });
      },
    });

    const makeRun = (nowMs: number) => {
      const c = new AbortController();
      now = nowMs;
      return watchConnection(
        c.signal,
        makeMockClient(messages, c),
        dispatcher,
        { uid: 40, uidValidity: 1n },
        {
          identities: () => baseIdentities as any,
          identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
          wait: async () => {},
          error: (msg: string) => { loggedErrors.push(String(msg)); },
          now: () => now,
        },
      );
    };

    // First run at t = 0
    await makeRun(0);
    expect(webhookWatermark.uid).toBe(40);
    expect(webhookWatermark.serviceFailure?.uid).toBe(41);
    expect(webhookWatermark.serviceFailure?.sinceMs).toBe(0);

    // Second run at t = 599,000 (< 10 minutes) -> still retained
    await makeRun(599_000);
    expect(webhookWatermark.uid).toBe(40);

    // Third run at t = 600,000 (>= 10 minutes) -> abandoned and watermark advanced!
    await makeRun(600_000);
    expect(webhookWatermark.uid).toBe(41);
    expect(webhookWatermark.serviceFailure).toBeUndefined();
    expect(loggedErrors.some((e) => e.includes('CRITICAL IMAP watcher abandoned UID 41'))).toBe(true);
  });

  test('all sinks failing with service failure triggers reconnect throw', async () => {
    const messages = [
      {
        uid: 41,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 41' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nBody'),
      },
    ];

    const controller = new AbortController();
    const client = makeMockClient(messages, controller);

    const dispatcher = new EventDispatcher();
    dispatcher.registerSink({
      id: 'sinkA',
      isEnabled: () => true,
      watermark: { uid: 40, uidValidity: 1n },
      handleMail: async () => {
        throw new NotifyError('outage_a' as any, undefined, { failureKind: 'service' });
      },
    });

    dispatcher.registerSink({
      id: 'sinkB',
      isEnabled: () => true,
      watermark: { uid: 40, uidValidity: 1n },
      handleMail: async () => {
        throw new NotifyError('outage_b' as any, undefined, { failureKind: 'service' });
      },
    });

    await expect(
      watchConnection(
        controller.signal,
        client,
        dispatcher,
        { uid: 40, uidValidity: 1n },
        {
          identities: () => baseIdentities as any,
          identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
          wait: async () => {},
          error: () => {},
          now: () => 0,
        },
      ),
    ).rejects.toThrow();
  });

  test('expunged detained UID does not stall sink, subsequent mail is delivered, and CRITICAL abandonment is logged (Codex P1-1)', async () => {
    const loggedErrors: string[] = [];
    const controller = new AbortController();

    // Mail 41 was expunged, mailbox now only has mail 42!
    const messages = [
      {
        uid: 42,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 42' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nMail 42 body'),
      },
    ];
    const client = makeMockClient(messages, controller);

    const webhookDelivered: number[] = [];
    // Webhook sink had previously failed on UID 41 and recorded serviceFailure
    const webhookWatermark: SinkWatermark = {
      uid: 40,
      uidValidity: 1n,
      serviceFailure: { uid: 41, sinceMs: 1000 },
    };

    const dispatcher = new EventDispatcher();
    dispatcher.registerSink({
      id: 'webhook',
      isEnabled: () => true,
      watermark: webhookWatermark,
      handleMail: async (event) => {
        webhookDelivered.push(event.message.uid);
      },
    });

    await watchConnection(
      controller.signal,
      client,
      dispatcher,
      { uid: 40, uidValidity: 1n },
      {
        identities: () => baseIdentities as any,
        identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
        wait: async () => {},
        error: (msg) => { loggedErrors.push(String(msg)); },
        now: () => 2000,
      },
    );

    // Expunged UID 41 must be abandoned with CRITICAL error log
    expect(loggedErrors.some((e) => e.includes('CRITICAL IMAP watcher abandoned expunged UID 41'))).toBe(true);
    expect(webhookWatermark.serviceFailure).toBeUndefined();

    // Subsequent mail 42 MUST NOT be stalled - delivered successfully!
    expect(webhookDelivered).toEqual([42]);
    expect(webhookWatermark.uid).toBe(42);
  });

  test('dynamically registered and disabled sinks take effect during active IMAP connection (Codex P1-2)', async () => {
    let round = 1;
    let sinkAEnabled = true;
    const sinkADelivered: number[] = [];
    const sinkBDelivered: number[] = [];

    const controller = new AbortController();
    const dispatcher = new EventDispatcher();

    const sinkA: EventSink = {
      id: 'sink-a',
      isEnabled: () => sinkAEnabled,
      watermark: { uid: 40, uidValidity: 1n },
      handleMail: async (event) => {
        sinkADelivered.push(event.message.uid);
      },
    };
    dispatcher.registerSink(sinkA);

    const sinkB: EventSink = {
      id: 'sink-b',
      isEnabled: () => true,
      watermark: { uid: 41, uidValidity: 1n },
      handleMail: async (event) => {
        sinkBDelivered.push(event.message.uid);
      },
    };

    const allMessages: Record<number, any> = {
      41: {
        uid: 41,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 41' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nMail 41'),
      },
      42: {
        uid: 42,
        envelope: { from: [{ address: 'sender@example.com' }], subject: 'Mail 42' },
        headers: Buffer.from('Delivered-To: approver@test.example\r\n\r\n'),
        source: Buffer.from('From: sender@example.com\r\n\r\nMail 42'),
      },
    };

    const client = {
      mailbox: { uidValidity: 1n },
      getMailboxLock: async () => ({ release() {} }),
      search: async () => {
        if (round === 1) return [41];
        return [41, 42];
      },
      fetch: async function* (uids: number[]) {
        for (const uid of uids) {
          if (allMessages[uid]) yield allMessages[uid];
        }
      },
      idle: async () => {
        if (round === 1) {
          round = 2;
          // Dynamically disable sinkA
          sinkAEnabled = false;
          // Dynamically register sinkB
          dispatcher.registerSink(sinkB);
        } else {
          controller.abort();
        }
      },
      logout: async () => {},
      close() {},
    } as any;

    await watchConnection(
      controller.signal,
      client,
      dispatcher,
      { uid: 40, uidValidity: 1n },
      {
        identities: () => baseIdentities as any,
        identity: (addr) => baseIdentities.find((i) => i.address === addr) as any,
        wait: async () => {},
        error: () => {},
        now: () => 1000,
      },
    );

    // Sink A only received 41; after being dynamically disabled, it did not receive 42 and its watermark froze at 41
    expect(sinkADelivered).toEqual([41]);
    expect(sinkA.watermark!.uid).toBe(41);

    // Sink B was dynamically registered in round 2, received 42, and its watermark advanced to 42
    expect(sinkBDelivered).toEqual([42]);
    expect(sinkB.watermark!.uid).toBe(42);
  });
});

describe('Second producer hand-off (§11.4 item 4 & §14 item 10)', () => {
  beforeEach(() => {
    taskSeams.setTaskSendMailForTests(async () => ({ messageId: '<approval-test@test.example>' }));
  });

  afterEach(() => {
    taskSeams.setTaskSendMailForTests(null);
  });

  test('createApprovalTask emits approval.requested event to registered sinks', async () => {
    const dispatcher = new EventDispatcher();
    setEventDispatcherForTests(dispatcher);

    let emittedEvent: ApprovalRequestedEvent | null = null;
    const approvalPromise = new Promise<void>((resolve) => {
      dispatcher.registerSink({
        id: 'test-approval-sink',
        isEnabled: () => true,
        handleApproval: async (event) => {
          emittedEvent = event;
          resolve();
        },
      });
    });

    const task = await createApprovalTask({
      from: 'requester@test.example',
      to: 'approver@test.example',
      subject: 'Authorize deployment',
      body: 'Please approve deployment to prod',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      action: {
        type: 'deploy',
        name: 'prod-deploy',
        arguments: { version: '1.2.3' },
      },
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe('input-required');
    expect(task.kind).toBe('approval');

    await approvalPromise;

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent!.type).toBe('approval.requested');
    expect(emittedEvent!.task.id).toBe(task.id);
    expect(emittedEvent!.task.from).toBe('requester@test.example');
    expect(emittedEvent!.task.to).toBe('approver@test.example');
    expect(emittedEvent!.task.approval.reviewer).toBe('approver@test.example');
    expect(emittedEvent!.task.approval.digest).toBe(task.approval.digest);

    setEventDispatcherForTests(null);
  });

  test('hand-off is non-blocking and bounded even when sink is a tarpit (latency < 100ms)', async () => {
    const dispatcher = new EventDispatcher();
    setEventDispatcherForTests(dispatcher);

    let resolveTarpit!: () => void;
    const tarpitPromise = new Promise<void>((r) => {
      resolveTarpit = r;
    });

    // Tarpit sink that never resolves unless explicitly settled
    dispatcher.registerSink({
      id: 'tarpit-webhook-sink',
      isEnabled: () => true,
      handleApproval: async () => {
        await tarpitPromise;
      },
    });

    const startTime = performance.now();
    const task = await createApprovalTask({
      from: 'requester@test.example',
      to: 'approver@test.example',
      subject: 'Tarpit approval test',
      body: 'Testing hand-off non-blocking latency',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      action: {
        type: 'restart',
        name: 'database-restart',
        arguments: {},
      },
    });
    const elapsedMs = performance.now() - startTime;

    // Must be bounded time (< 100ms), NOT awaiting the tarpit!
    expect(elapsedMs).toBeLessThan(100);
    expect(task.id).toBeDefined();
    expect(task.state).toBe('input-required');

    // Clean up tarpit to avoid lingering promises
    resolveTarpit();
    setEventDispatcherForTests(null);
  });

  test('sink failure does not throw or corrupt createApprovalTask return', async () => {
    const dispatcher = new EventDispatcher();
    setEventDispatcherForTests(dispatcher);

    dispatcher.registerSink({
      id: 'failing-sink',
      isEnabled: () => true,
      handleApproval: async () => {
        throw new Error('Immediate delivery rejection');
      },
    });

    const task = await createApprovalTask({
      from: 'requester@test.example',
      to: 'approver@test.example',
      subject: 'Resilience test',
      body: 'Should succeed regardless of sink error',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      action: {
        type: 'action',
        name: 'test',
        arguments: {},
      },
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe('input-required');

    setEventDispatcherForTests(null);
  });

  test('sink throwing in isEnabled does not throw or corrupt createApprovalTask return (Codex P1 R3)', async () => {
    const loggedErrors: string[] = [];
    const dispatcher = new EventDispatcher({
      error: (msg, detail) => {
        loggedErrors.push(`${msg} ${detail ?? ''}`);
      },
    });
    setEventDispatcherForTests(dispatcher);

    let handleApprovalCalled = false;
    dispatcher.registerSink({
      id: 'throwing-isenabled-sink',
      isEnabled: () => {
        throw new Error('Config lookup failed');
      },
      handleApproval: async () => {
        handleApprovalCalled = true;
      },
    });

    const task = await createApprovalTask({
      from: 'requester@test.example',
      to: 'approver@test.example',
      subject: 'isEnabled failure resilience test',
      body: 'Should succeed and return 201 regardless of isEnabled throw',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      action: {
        type: 'action',
        name: 'test',
        arguments: {},
      },
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe('input-required');

    await new Promise((r) => setTimeout(r, 10));

    expect(handleApprovalCalled).toBe(false);
    expect(loggedErrors.some((e) => e.includes('Sink throwing-isenabled-sink threw checking isEnabled'))).toBe(true);

    setEventDispatcherForTests(null);
  });
});

describe('EventDispatcher abstractions and sink contracts', () => {
  test('isSinkServiceFailure classifies failureKind service vs message correctly', () => {
    // Non-NotifyError object with explicit failureKind
    expect(isSinkServiceFailure({ failureKind: 'service' })).toBe(true);
    expect(isSinkServiceFailure({ failureKind: 'message' })).toBe(false);

    // NotifyError with service outage vs message rejection
    expect(isSinkServiceFailure(new NotifyError('notify_unavailable', undefined, { failureKind: 'service' }))).toBe(true);
    expect(isSinkServiceFailure(new NotifyError('message_too_large', undefined, { failureKind: 'message' }))).toBe(false);

    // Cancelled notify is not a service failure
    expect(isSinkServiceFailure(new NotifyError('notify_cancelled'))).toBe(false);

    // Generic error (outage by default)
    expect(isSinkServiceFailure(new Error('connection timeout'))).toBe(true);
  });

  test('createNtfySink adheres to EventSink contract', () => {
    const watermark: SinkWatermark = { uid: 10 };
    const sink = createNtfySink(async () => ({} as any), watermark);
    expect(sink.id).toBe('ntfy');
    expect(sink.watermark).toBe(watermark);
    expect(sink.isEnabled).toBeFunction();
    expect(sink.handleMail).toBeFunction();
  });

  test('EventDispatcher manages sinks and routes mail vs approval sinks', () => {
    const dispatcher = new EventDispatcher();
    const mailSink: EventSink = {
      id: 'mail-only',
      isEnabled: () => true,
      handleMail: async () => {},
    };
    const approvalSink: EventSink = {
      id: 'approval-only',
      isEnabled: () => true,
      handleApproval: async () => {},
    };
    const dualSink: EventSink = {
      id: 'dual',
      isEnabled: () => true,
      handleMail: async () => {},
      handleApproval: async () => {},
    };

    dispatcher.registerSink(mailSink);
    dispatcher.registerSink(approvalSink);
    dispatcher.registerSink(dualSink);

    expect(dispatcher.getSink('mail-only')).toBe(mailSink);
    expect(dispatcher.getAllSinks()).toHaveLength(3);
    expect(dispatcher.getMailSinks()).toEqual([mailSink, dualSink]);
    expect(dispatcher.getApprovalSinks()).toEqual([approvalSink, dualSink]);

    expect(dispatcher.unregisterSink('mail-only')).toBe(true);
    expect(dispatcher.getSink('mail-only')).toBeUndefined();
    expect(dispatcher.getMailSinks()).toEqual([dualSink]);
  });
});

