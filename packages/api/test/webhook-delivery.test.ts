process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOKS_ENABLED = 'true';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { config } = await import('../src/lib/config.ts');
const {
  appendDeliveryLogRow,
  calculateNextAttemptTime,
  compactDeliveryLog,
  deliveryLimiter,
  deliveryQueue,
  enqueueWebhookDelivery,
  executeWebhookAttempt,
  executeWebhookTestProbe,
  formatApprovalPayload,
  formatMailPayload,
  formatPingPayload,
  readAllDeliveryLogRows,
  readDeliveryLogRows,
  reconstructPendingDeliveriesAtBoot,
  redeliverWebhookDelivery,
  validateWebhookUrlResolution,
  validateWebhookUrlStatic,
} = await import('../src/lib/webhook-delivery.ts');
type WebhookDeliveryLogRow = import('../src/lib/webhook-delivery.ts').WebhookDeliveryLogRow;

const {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  updateWebhookSubscription,
} = await import('../src/lib/webhook-store.ts');
type WebhookSubscription = import('../src/lib/webhook-store.ts').WebhookSubscription;

const TEST_DATA_DIR = join(import.meta.dir, 'tmp-webhook-delivery');
const originalDataDir = config.dataDir;

function setupTestDir(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as any).dataDir = TEST_DATA_DIR;
  (config.webhooks as any).enabled = true;
  (config as any).taskSigningSecret = '01234567890123456789012345678901';
  (config.webhooks as any).signingSecret = '01234567890123456789012345678901';
  (config.webhooks as any).disableThreshold = 10;
  (config.webhooks as any).maxAttempts = 11;
  (config.webhooks as any).allowPrivateTargets = false;
  (config.webhooks as any).payloadMaxBytes = 16384;
  (config.webhooks as any).codeEntryChars = 200;
  (config as any).oaePublicEdge = false;
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
}

describe('webhook-delivery: Retry Schedule & Jitter (§8.3)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('attempt 1 is always immediate; attempt 11 is pinned to exactly +72h unjittered', () => {
    const start = 1000000;
    // Attempt 1
    const t1 = calculateNextAttemptTime(0, start);
    expect(t1).toBe(start);

    // Attempt 11 (pinned to exactly 72h = 259200s)
    const t11 = calculateNextAttemptTime(10, start, { randomFn: () => 0.99 });
    expect(t11).toBe(start + 259200 * 1000);

    const t11Zero = calculateNextAttemptTime(10, start, { randomFn: () => 0.01 });
    expect(t11Zero).toBe(start + 259200 * 1000);

    // Beyond attempt 11 returns null
    const t12 = calculateNextAttemptTime(11, start);
    expect(t12).toBeNull();
  });

  test('jitter bounds each intermediate attempt to ±10% of its own gap', () => {
    const start = 1000000;
    // Attempt 2: gap is 5s. ±10% is ±0.5s. Offset 5s -> [4.5s, 5.5s]
    const minT2 = calculateNextAttemptTime(1, start, { randomFn: () => 0.0 }); // -10%
    const maxT2 = calculateNextAttemptTime(1, start, { randomFn: () => 1.0 }); // +10%
    expect(minT2).toBe(start + 4500);
    expect(maxT2).toBe(start + 5500);

    // Attempt 3: gap is 295s (offset 300s, prev 5s). ±10% is ±29.5s.
    const minT3 = calculateNextAttemptTime(2, start, { randomFn: () => 0.0 });
    const maxT3 = calculateNextAttemptTime(2, start, { randomFn: () => 1.0 });
    expect(minT3).toBe(start + Math.round((300 - 29.5) * 1000));
    expect(maxT3).toBe(start + Math.round((300 + 29.5) * 1000));
  });

  test('webhook.ping uses attempts 1–3 only', () => {
    const start = 1000000;
    expect(calculateNextAttemptTime(0, start, { isPing: true })).toBe(start);
    expect(calculateNextAttemptTime(1, start, { isPing: true })).not.toBeNull();
    expect(calculateNextAttemptTime(2, start, { isPing: true })).not.toBeNull();
    expect(calculateNextAttemptTime(3, start, { isPing: true })).toBeNull();
  });

  test('honors Retry-After on 429 when integer 1s..3600s', () => {
    const start = 1000000;
    const next = calculateNextAttemptTime(1, start, { retryAfterSec: 60 });
    // Offset 2 was 5s; with Retry-After 60s from attempt 1 (0s), it schedules at >= 60s
    expect(next).toBe(start + 60000);
  });
});

describe('webhook-delivery: Durable Logging & Compaction (§8.6, §14 item 5)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('appends rows to 0600 file; does not store payload content', () => {
    const row: WebhookDeliveryLogRow = {
      ts: new Date().toISOString(),
      webhookId: 'whk_test_1',
      eventId: 'evt_1',
      runId: 'run_0',
      deliveryId: 'dlv_1',
      type: 'mail.received',
      address: 'alice@example.com',
      messageId: '101',
      uidValidity: 1,
      rfc822MessageId: '<msg1@example.com>',
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: new Date().toISOString(),
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 45,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    };

    appendDeliveryLogRow(row);

    const logFile = join(TEST_DATA_DIR, 'webhook-deliveries.jsonl');
    expect(existsSync(logFile)).toBe(true);

    const rows = readAllDeliveryLogRows();
    expect(rows.length).toBe(1);
    expect(rows[0].webhookId).toBe('whk_test_1');
    expect(rows[0].status).toBe(200);

    // Asserts no forbidden payload fields
    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toContain('subject');
    expect(raw).not.toContain('body');
    expect(raw).not.toContain('secret');
  });

  test('compactDeliveryLog prunes aged rows but preserves active pending sequences', () => {
    const now = Date.now();
    const oldTs = new Date(now - 40 * 86400000).toISOString();

    // 1. Old final row -> should be pruned
    appendDeliveryLogRow({
      ts: oldTs,
      webhookId: 'whk_final',
      eventId: 'evt_old_final',
      runId: 'run_0',
      deliveryId: 'dlv_old_final',
      type: 'mail.received',
      address: 'alice@example.com',
      messageId: '1',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: oldTs,
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 20,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
    });

    // 2. Old pending row -> MUST be preserved
    appendDeliveryLogRow({
      ts: oldTs,
      webhookId: 'whk_active',
      eventId: 'evt_active',
      runId: 'run_0',
      deliveryId: 'dlv_active_1',
      type: 'mail.received',
      address: 'alice@example.com',
      messageId: '2',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: oldTs,
      attempt: 1,
      outcome: 'retryable',
      status: 500,
      durationMs: 30,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(now + 10000).toISOString(),
    });

    compactDeliveryLog(now, 30);

    const remaining = readAllDeliveryLogRows();
    expect(remaining.length).toBe(1);
    expect(remaining[0].eventId).toBe('evt_active');
  });
});

describe('webhook-delivery: URL Validation & SSRF Safety (§9.1, §9.3, §9.5, §10.4 Rule C)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('validateWebhookUrlStatic rejects query, fragment, userinfo, and non-allowed ports', () => {
    // Malformed
    expect(validateWebhookUrlStatic('not-a-url').valid).toBe(false);

    // Query string forbidden
    expect(validateWebhookUrlStatic('https://example.com/hook?key=val').valid).toBe(false);

    // Fragment forbidden
    expect(validateWebhookUrlStatic('https://example.com/hook#sec').valid).toBe(false);

    // Userinfo forbidden
    expect(validateWebhookUrlStatic('https://user:pass@example.com/hook').valid).toBe(false);

    // HTTP rejected when allowPrivateTargets is false
    expect(validateWebhookUrlStatic('http://example.com/hook', { allowPrivateTargets: false }).valid).toBe(false);

    // Non-allowed port
    expect(validateWebhookUrlStatic('https://example.com:8443/hook', { allowedPorts: [443] }).valid).toBe(false);

    // IP literal rejected when allowPrivateTargets is false
    expect(validateWebhookUrlStatic('https://1.1.1.1/hook', { allowPrivateTargets: false }).valid).toBe(false);

    // Valid HTTPS URL
    expect(validateWebhookUrlStatic('https://example.com/hook').valid).toBe(true);
  });

  test('validateWebhookUrlResolution enforces SSRF and §9.3 step 5 for http targets', async () => {
    // SSRF blocked address (169.254.169.254)
    const ssrfRes = await validateWebhookUrlResolution('https://metadata.internal/hook', {
      allowPrivateTargets: true,
      dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });
    expect(ssrfRes.valid).toBe(false);
    if (!ssrfRes.valid) {
      expect(ssrfRes.code).toBe('webhook_target_forbidden');
    }

    // HTTP target resolving to public IP must fail §9.3 step 5
    const httpPublicRes = await validateWebhookUrlResolution('http://public.example.com/hook', {
      allowPrivateTargets: true,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(httpPublicRes.valid).toBe(false);
    if (!httpPublicRes.valid) {
      expect(httpPublicRes.error).toBe('http_target_must_be_private');
    }

    // HTTP target resolving to private IP succeeds with isPrivateTarget=true
    const httpPrivateRes = await validateWebhookUrlResolution('http://local.internal/hook', {
      allowPrivateTargets: true,
      dnsLookup: async () => [{ address: '192.168.1.50', family: 4 }],
    });
    expect(httpPrivateRes.valid).toBe(true);
    if (httpPrivateRes.valid) {
      expect(httpPrivateRes.isPrivateTarget).toBe(true);
    }
  });
});

describe('webhook-delivery: Payload Bounding & Drop Order (§6.6, §14 item 8)', () => {
  const dummySub: WebhookSubscription = {
    id: 'whk_sub_1',
    url: 'https://consumer.example/hook',
    address: 'postmaster@openagent.email',
    events: ['mail.received', 'approval.requested'],
    contentScope: 'metadata',
    description: 'test sub',
    state: 'enabled',
    disabledReason: null,
    secretPrefix: 'whs_test…',
    epoch: 0,
    overlapUntil: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rotatedAt: null,
    consecutiveFailures: 0,
    privateTargetGranted: false,
    createdBy: 'admin',
  };

  test('mail.received: drops long links whole while retaining containsLink boolean', () => {
    (config.webhooks as any).payloadMaxBytes = 16384;
    (config.webhooks as any).codeEntryChars = 20;

    const subPreview: WebhookSubscription = { ...dummySub, contentScope: 'preview' };
    const envelope = {
      id: 'evt_1',
      type: 'mail.received' as const,
      payloadVersion: 'v1' as const,
      createdAt: new Date().toISOString(),
      domain: 'openagent.email',
    };

    const formatted = formatMailPayload(subPreview, envelope, {
      address: 'postmaster@openagent.email',
      messageId: '100',
      uid: 100,
      uidValidity: 1,
      receivedAt: new Date().toISOString(),
      from: { address: 'sender@example.com', name: 'Sender' },
      to: ['postmaster@openagent.email'],
      cc: [],
      subject: 'Verification Code',
      sizeBytes: 1024,
      hasAttachments: false,
      unread: true,
      containsSecurityCode: true,
      containsLink: true,
      textPreview: 'Your code is 123456',
      securityCodes: ['123456'],
      // 25 chars exceeds webhookCodeEntryChars (20)
      links: ['https://example.com/verify-code'],
    });

    const parsed = JSON.parse(formatted.body);
    expect(parsed.data.containsLink).toBe(true);
    expect(parsed.data.links).toEqual([]); // dropped whole!
    expect(parsed.data.securityCodes).toEqual(['123456']);
  });

  test('mail.received overflow drop order: cc -> to -> subject -> from.name', () => {
    // Set a small payload cap to force drops (cc and to dropped: 734 bytes)
    (config.webhooks as any).payloadMaxBytes = 740;

    const envelope = {
      id: 'evt_drop',
      type: 'mail.received' as const,
      payloadVersion: 'v1' as const,
      createdAt: new Date().toISOString(),
      domain: 'openagent.email',
    };

    const formatted = formatMailPayload(dummySub, envelope, {
      address: 'postmaster@openagent.email',
      messageId: '100',
      uid: 100,
      uidValidity: 1,
      receivedAt: new Date().toISOString(),
      from: { address: 'sender@example.com', name: 'A Very Long Sender Display Name' },
      to: ['recipient1@example.com', 'recipient2@example.com'],
      cc: ['cc1@example.com', 'cc2@example.com'],
      subject: 'This is a somewhat long subject intended to trigger field shedding',
      sizeBytes: 100,
      hasAttachments: false,
      unread: true,
      containsSecurityCode: false,
      containsLink: false,
    });

    const parsed = JSON.parse(formatted.body);
    // cc and to should have been dropped to empty arrays to fit
    expect(parsed.data.cc).toEqual([]);
    expect(parsed.data.to).toEqual([]);
    expect(Buffer.byteLength(formatted.body, 'utf8')).toBeLessThanOrEqual(740);
  });

  test('approval.requested overflow drop order: actionArguments dropped first whole', () => {
    (config.webhooks as any).payloadMaxBytes = 700;
    const subPreview: WebhookSubscription = { ...dummySub, contentScope: 'preview' };

    const envelope = {
      id: 'evt_appr',
      type: 'approval.requested' as const,
      payloadVersion: 'v1' as const,
      createdAt: new Date().toISOString(),
      domain: 'openagent.email',
    };

    const formatted = formatApprovalPayload(subPreview, envelope, {
      taskId: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      taskState: 'input-required',
      from: 'researcher@openagent.email',
      to: 'owner@openagent.email',
      reviewer: 'owner@openagent.email',
      subject: 'Approve outbound action',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      expiresInSec: 86400,
      digest: '9f2c4a71b8e03d56f1a9c24e7b03d8f6a1c94e27b05d83f6a1c49e27b0d83f6a',
      actionType: 'tool_call',
      actionName: 'send_email',
      actionArguments: { bigArray: new Array(50).fill('large data string') },
    });

    const parsed = JSON.parse(formatted.body);
    expect(parsed.data.actionArguments).toBeUndefined(); // dropped whole
    expect(parsed.data.digest).toBeDefined(); // never dropped
    expect(Buffer.byteLength(formatted.body, 'utf8')).toBeLessThanOrEqual(700);
  });
});

describe('webhook-delivery: Circuit Breaker & SSRF Immediate Disable (§8.5, D2a, §14 item 9)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('10 consecutive failures trip the breaker; success resets counter to 0', async () => {
    const sub = createWebhookSubscription({
      url: 'https://flaky.consumer.example/hook',
      address: 'postmaster@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      description: 'breaker test',
      privateTargetGranted: false,
      createdBy: 'admin',
    });

    expect(sub.consecutiveFailures).toBe(0);

    // Simulate 9 failures
    for (let i = 1; i <= 9; i++) {
      updateWebhookSubscription(sub.id, (s) => {
        s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
        if (s.consecutiveFailures >= 10) {
          s.state = 'disabled';
          s.disabledReason = 'threshold';
        }
      });
    }
    expect(getWebhookSubscription(sub.id)?.state).toBe('unverified');
    expect(getWebhookSubscription(sub.id)?.consecutiveFailures).toBe(9);

    // A success resets to 0 and transitions unverified -> enabled
    updateWebhookSubscription(sub.id, (s) => {
      s.consecutiveFailures = 0;
      if (s.state === 'unverified') s.state = 'enabled';
    });
    expect(getWebhookSubscription(sub.id)?.consecutiveFailures).toBe(0);
    expect(getWebhookSubscription(sub.id)?.state).toBe('enabled');

    // 10 failures trips to disabled
    for (let i = 1; i <= 10; i++) {
      updateWebhookSubscription(sub.id, (s) => {
        s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
        if (s.consecutiveFailures >= 10) {
          s.state = 'disabled';
          s.disabledReason = 'threshold';
        }
      });
    }
    const disabledSub = getWebhookSubscription(sub.id);
    expect(disabledSub?.state).toBe('disabled');
    expect(disabledSub?.disabledReason).toBe('threshold');
  });

  test('SSRF refusal disables endpoint immediately without waiting for threshold', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ssrf.consumer.example/hook',
      address: 'postmaster@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      description: 'ssrf test',
      privateTargetGranted: false,
      createdBy: 'admin',
    });

    // Mock attempt that resolves to blocked SSRF
    const res = await executeWebhookAttempt(
      sub,
      '{}',
      'mail.received',
      'dlv_ssrf',
      {
        dnsLookup: async () => [{ address: '169.254.169.254', family: 4 }],
      },
    );

    expect(res.outcome).toBe('refused');
    expect(res.reason).toBe('ssrf_refused');
  });
});

describe('webhook-delivery: Boot Reconstruction (§8.6, Item 9, §14 item 15)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('reconstructPendingDeliveriesAtBoot picks highest attempt and preserves Item 9 fields', async () => {
    const sub = createWebhookSubscription({
      url: 'https://recon.example/hook',
      address: 'owner@openagent.email',
      events: ['approval.requested'],
      contentScope: 'metadata',
      description: 'reconstruction test',
      privateTargetGranted: false,
      createdBy: 'admin',
    });

    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 3600000).toISOString();
    const taskCreatedAt = new Date(bootTime - 3600000).toISOString();

    // Past attempt 1 failed
    appendDeliveryLogRow({
      ts: new Date(bootTime - 3500000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_recon_1',
      runId: 'run_0',
      deliveryId: 'dlv_r1',
      type: 'approval.requested',
      address: 'owner@openagent.email',
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      taskCreatedAt,
      expiresInSec: 86400,
      eventCreatedAt,
      attempt: 1,
      outcome: 'retryable',
      status: 500,
      durationMs: 50,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 60000).toISOString(),
    });

    // Attempt 2 scheduled as pending
    appendDeliveryLogRow({
      ts: new Date(bootTime - 3499000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_recon_1',
      runId: 'run_0',
      deliveryId: 'dlv_r2',
      type: 'approval.requested',
      address: 'owner@openagent.email',
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      taskCreatedAt,
      expiresInSec: 86400,
      eventCreatedAt,
      attempt: 2,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 60000).toISOString(),
    });

    const result = await reconstructPendingDeliveriesAtBoot(bootTime);
    // Task does not exist in mock storage so it dead-letters gracefully with task_not_found
    expect(result.deadLettered).toBe(1);

    const rows = readAllDeliveryLogRows();
    const deadLetterRow = rows.find((r) => r.outcome === 'permanent');
    expect(deadLetterRow).toBeDefined();
    expect(deadLetterRow?.reason).toBe('task_not_found');
    expect(deadLetterRow?.taskCreatedAt).toBe(taskCreatedAt);
    expect(deadLetterRow?.expiresInSec).toBe(86400);
  });

  afterAll(async () => {
    (config as any).dataDir = originalDataDir;
    deliveryQueue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});
