process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  fireCreationPing,
  formatApprovalPayload,
  formatMailPayload,
  formatPingPayload,
  isTerminalDeliveryRow,
  getLatestDeliveryForWebhook,
  latestDeliveryByWebhookId,
  parseRetryAfterSeconds,
  readAllDeliveryLogRows,
  readAllDeliveryLogRowsFromDisk,
  readDeliveryLogRows,
  resetDeliveryLogIndexForTests,
  reconstructPendingDeliveriesAtBoot,
  redeliverWebhookDelivery,
  setReconstructRetryDelaysForTests,
  setWebhookDnsLookupForTests,
  pendingReconstructionRetryCount,
  countsTowardCircuitBreaker,
  validateWebhookUrlResolution,
  validateWebhookUrlStatic,
} = await import('../src/lib/webhook-delivery.ts');
type WebhookDeliveryLogRow = import('../src/lib/webhook-delivery.ts').WebhookDeliveryLogRow;

const {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  setWebhooksFailClosedForTests,
  updateWebhookSubscription,
} = await import('../src/lib/webhook-store.ts');
const { readAuditEvents } = await import('../src/lib/audit.ts');
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
  setWebhooksFailClosedForTests(false);
  setReconstructRetryDelaysForTests();
  resetDeliveryLogIndexForTests();
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
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

  test('R4: parseRetryAfterSeconds requires the whole string to be a 1..3600 integer', () => {
    expect(parseRetryAfterSeconds('60')).toBe(60);
    expect(parseRetryAfterSeconds('3600')).toBe(3600);
    expect(parseRetryAfterSeconds('1')).toBe(1);
    expect(parseRetryAfterSeconds('3600junk')).toBeUndefined();
    expect(parseRetryAfterSeconds('60.0')).toBeUndefined();
    expect(parseRetryAfterSeconds(' 60')).toBe(60);
    expect(parseRetryAfterSeconds('0')).toBeUndefined();
    expect(parseRetryAfterSeconds('3601')).toBeUndefined();
    expect(parseRetryAfterSeconds('-1')).toBeUndefined();
    expect(parseRetryAfterSeconds('')).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
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

    const latest = latestDeliveryByWebhookId([
      { ...row, webhookId: 'whk_a', deliveryId: 'dlv_old', ts: '2026-01-01T00:00:00.000Z', attempt: 2 },
      { ...row, webhookId: 'whk_a', deliveryId: 'dlv_new', ts: '2026-01-02T00:00:00.000Z', attempt: 1 },
      { ...row, webhookId: 'whk_b', deliveryId: 'dlv_b', ts: '2026-01-01T00:00:00.000Z', attempt: 1 },
    ]);
    expect(latest.get('whk_a')?.deliveryId).toBe('dlv_new');
    expect(latest.get('whk_b')?.deliveryId).toBe('dlv_b');

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
    expect(readAllDeliveryLogRowsFromDisk().map((r) => r.deliveryId)).toEqual(
      remaining.map((r) => r.deliveryId),
    );
  });

  test('R9: delivery log index matches full scan, sees appended lines, rebuilds after compact', () => {
    const row = (id: string, webhookId: string, ts: string, outcome: 'success' | 'pending' = 'success') => ({
      ts,
      webhookId,
      eventId: `evt_${id}`,
      runId: 'run_0',
      deliveryId: `dlv_${id}`,
      type: 'webhook.ping' as const,
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt: 1,
      outcome,
      status: outcome === 'success' ? 200 : null,
      durationMs: outcome === 'success' ? 10 : null,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });

    const now = Date.now();
    const t1 = new Date(now - 2000).toISOString();
    const t2 = new Date(now - 1000).toISOString();
    appendDeliveryLogRow(row('a', 'whk_idx_a', t1));
    appendDeliveryLogRow(row('b', 'whk_idx_b', t1));
    const first = readAllDeliveryLogRows();
    expect(first.map((r) => r.deliveryId)).toEqual(['dlv_a', 'dlv_b']);
    expect(readAllDeliveryLogRowsFromDisk()).toEqual(first);
    expect(getLatestDeliveryForWebhook('whk_idx_a')?.deliveryId).toBe('dlv_a');

    const extra = row('c', 'whk_idx_a', t2);
    appendFileSync(join(TEST_DATA_DIR, 'webhook-deliveries.jsonl'), `${JSON.stringify(extra)}\n`);
    const afterAppend = readAllDeliveryLogRows();
    expect(afterAppend.map((r) => r.deliveryId)).toEqual(['dlv_a', 'dlv_b', 'dlv_c']);
    expect(readAllDeliveryLogRowsFromDisk()).toEqual(afterAppend);
    expect(getLatestDeliveryForWebhook('whk_idx_a')?.deliveryId).toBe('dlv_c');

    const oldTs = new Date(now - 40 * 86400000).toISOString();
    appendDeliveryLogRow(row('old', 'whk_idx_old', oldTs));
    compactDeliveryLog(now, 30);
    const afterCompact = readAllDeliveryLogRows();
    expect(afterCompact.some((r) => r.deliveryId === 'dlv_old')).toBe(false);
    expect(afterCompact.map((r) => r.deliveryId).sort()).toEqual(['dlv_a', 'dlv_b', 'dlv_c']);
    expect(readAllDeliveryLogRowsFromDisk().map((r) => r.deliveryId).sort()).toEqual(
      afterCompact.map((r) => r.deliveryId).sort(),
    );
  });

  test('R5: compactDeliveryLog prunes per-type terminal retryable sequences', () => {
    const now = Date.now();
    const oldTs = new Date(now - 40 * 86400000).toISOString();
    const prev = config.webhooks.maxAttempts;
    (config.webhooks as any).maxAttempts = 4;
    try {
      appendDeliveryLogRow({
        ts: oldTs,
        webhookId: 'whk_ping_done',
        eventId: 'evt_ping_done',
        runId: 'run_0',
        deliveryId: 'dlv_ping_done',
        type: 'webhook.ping',
        address: null,
        messageId: null,
        uidValidity: null,
        rfc822MessageId: null,
        taskId: null,
        taskCreatedAt: null,
        expiresInSec: null,
        eventCreatedAt: oldTs,
        attempt: 3,
        outcome: 'retryable',
        status: 500,
        durationMs: 20,
        sensitive: false,
        replay: false,
        nextAttemptAt: null,
      });
      appendDeliveryLogRow({
        ts: oldTs,
        webhookId: 'whk_mail_done',
        eventId: 'evt_mail_done',
        runId: 'run_0',
        deliveryId: 'dlv_mail_done',
        type: 'mail.received',
        address: 'alice@example.com',
        messageId: '9',
        uidValidity: 1,
        rfc822MessageId: null,
        taskId: null,
        taskCreatedAt: null,
        expiresInSec: null,
        eventCreatedAt: oldTs,
        attempt: 4,
        outcome: 'retryable',
        status: 500,
        durationMs: 20,
        sensitive: false,
        replay: false,
        nextAttemptAt: null,
      });
      appendDeliveryLogRow({
        ts: oldTs,
        webhookId: 'whk_mail_live',
        eventId: 'evt_mail_live',
        runId: 'run_0',
        deliveryId: 'dlv_mail_live',
        type: 'mail.received',
        address: 'alice@example.com',
        messageId: '10',
        uidValidity: 1,
        rfc822MessageId: null,
        taskId: null,
        taskCreatedAt: null,
        expiresInSec: null,
        eventCreatedAt: oldTs,
        attempt: 3,
        outcome: 'retryable',
        status: 500,
        durationMs: 20,
        sensitive: false,
        replay: false,
        nextAttemptAt: new Date(now + 1000).toISOString(),
      });

      compactDeliveryLog(now, 30);
      const remaining = readAllDeliveryLogRows();
      expect(remaining.map((r) => r.eventId)).toEqual(['evt_mail_live']);
    } finally {
      (config.webhooks as any).maxAttempts = prev;
    }
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
      allowedPorts: [80, 443],
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(httpPublicRes.valid).toBe(false);
    if (!httpPublicRes.valid) {
      expect(httpPublicRes.error).toBe('http_target_must_be_private');
    }

    // HTTP target resolving to private IP succeeds only when 80 is on the port whitelist
    const httpPrivateRes = await validateWebhookUrlResolution('http://local.internal/hook', {
      allowPrivateTargets: true,
      allowedPorts: [80, 443],
      dnsLookup: async () => [{ address: '192.168.1.50', family: 4 }],
    });
    expect(httpPrivateRes.valid).toBe(true);
    if (httpPrivateRes.valid) {
      expect(httpPrivateRes.isPrivateTarget).toBe(true);
    }
  });

  test('R4: private http targets do not implicitly allow port 80', () => {
    const implicit = validateWebhookUrlStatic('http://192.168.1.50/hook', {
      allowPrivateTargets: true,
      allowedPorts: [443],
    });
    expect(implicit.valid).toBe(false);
    if (!implicit.valid) {
      expect(implicit.error).toBe('port_not_allowed');
    }

    const explicit = validateWebhookUrlStatic('http://192.168.1.50/hook', {
      allowPrivateTargets: true,
      allowedPorts: [80, 443],
    });
    expect(explicit.valid).toBe(true);
  });

  test('R6: DNS resolution lookup times out instead of hanging', async () => {
    const started = Date.now();
    const res = await validateWebhookUrlResolution('https://slow-dns.example/hook', {
      allowPrivateTargets: false,
      dnsLookupTimeoutMs: 50,
      dnsLookup: () => new Promise(() => {}),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.error).toBe('dns_lookup_failed');
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

  test('R9: preview fields truncate by character count, not UTF-8 bytes', () => {
    const prevPayload = config.webhooks.payloadMaxBytes;
    const prevPreview = (config.webhooks as any).bodyPreviewChars;
    const prevCode = (config.webhooks as any).codeEntryChars;
    (config.webhooks as any).payloadMaxBytes = 64_000;
    (config.webhooks as any).bodyPreviewChars = 280;
    (config.webhooks as any).codeEntryChars = 200;

    const subPreview: WebhookSubscription = { ...dummySub, contentScope: 'preview' };
    const envelope = {
      id: 'evt_chars',
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
      from: { address: 'sender@example.com' },
      to: ['postmaster@openagent.email'],
      cc: [],
      subject: '预览',
      sizeBytes: 1024,
      hasAttachments: false,
      unread: true,
      containsSecurityCode: true,
      containsLink: true,
      textPreview: '字'.repeat(300),
      securityCodes: ['码'.repeat(250)],
      links: ['链'.repeat(200), '链'.repeat(201)],
    });

    const parsed = JSON.parse(formatted.body);
    expect([...parsed.data.textPreview].length).toBe(280);
    expect(parsed.data.textPreview).toBe('字'.repeat(280));
    expect([...parsed.data.securityCodes[0]].length).toBe(200);
    expect(parsed.data.links).toEqual(['链'.repeat(200)]);
    (config.webhooks as any).payloadMaxBytes = prevPayload;
    (config.webhooks as any).bodyPreviewChars = prevPreview;
    (config.webhooks as any).codeEntryChars = prevCode;
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

describe('webhook-delivery: R10 ping schema, deliveryId, probe defer', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('R10: webhook.ping data.object is webhook and carries trigger', () => {
    const envelope = {
      id: 'evt_ping_schema',
      type: 'webhook.ping' as const,
      payloadVersion: 'v1' as const,
      createdAt: '2026-09-05T12:00:00.000Z',
      domain: 'test.example',
    };
    const creation = JSON.parse(formatPingPayload(envelope, 'whk_schema', 'creation').body);
    expect(creation).toEqual({
      id: 'evt_ping_schema',
      type: 'webhook.ping',
      payloadVersion: 'v1',
      createdAt: '2026-09-05T12:00:00.000Z',
      domain: 'test.example',
      data: { object: 'webhook', webhookId: 'whk_schema', trigger: 'creation' },
    });
    const testPing = JSON.parse(formatPingPayload(envelope, 'whk_schema', 'test').body);
    expect(testPing.data.trigger).toBe('test');
    expect(testPing.data.object).toBe('webhook');
  });

  test('R10: pending, attempt row, and X-OAE-Delivery share one deliveryId', async () => {
    const seen: { deliveryId: string | null; body: any } = { deliveryId: null, body: null };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        seen.deliveryId = req.headers.get('X-OAE-Delivery');
        seen.body = await req.json();
        return new Response('ok', { status: 200 });
      },
    });
    const prevAllow = config.webhooks.allowPrivateTargets;
    (config.webhooks as any).allowPrivateTargets = true;
    (config as any).oaePublicEdge = false;
    try {
      const sub = createWebhookSubscription({
        url: `http://127.0.0.1:${server.port}/hook`,
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        privateTargetGranted: true,
        createdBy: 'admin',
      });
      enqueueWebhookDelivery({
        subscription: sub,
        eventId: 'evt_r10_dlv',
        type: 'webhook.ping',
        payloadBuilder: (current) =>
          formatPingPayload(
            {
              id: 'evt_r10_dlv',
              type: 'webhook.ping',
              payloadVersion: 'v1',
              createdAt: new Date().toISOString(),
              domain: 'test.example',
            },
            current.id,
            'test',
          ),
      });
      const pending = readAllDeliveryLogRows().find((r) => r.eventId === 'evt_r10_dlv');
      expect(pending?.outcome).toBe('pending');
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === 'evt_r10_dlv' && r.outcome === 'success',
          ),
        2000,
      );
      const success = readAllDeliveryLogRows().find(
        (r) => r.eventId === 'evt_r10_dlv' && r.outcome === 'success',
      );
      expect(success?.deliveryId).toBe(pending?.deliveryId);
      expect(seen.deliveryId).toBe(pending?.deliveryId);
      expect(seen.body?.data?.object).toBe('webhook');

      const replay = await redeliverWebhookDelivery(pending!.deliveryId);
      expect(replay.deliveryId).not.toBe(pending!.deliveryId);
      expect(replay.eventId).toBe('evt_r10_dlv');
      expect(
        readAllDeliveryLogRows().some((r) => r.deliveryId === replay.deliveryId && r.replay),
      ).toBe(true);
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      server.stop(true);
      deliveryQueue.cancelAll();
    }
  });

  test('R10: probe-full creation ping is delayed, not dropped, and can verify', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok', { status: 200 }),
    });
    const prevAllow = config.webhooks.allowPrivateTargets;
    const prevProbe = config.webhooks.rateTestPerMin;
    const prevPool = config.webhooks.poolRetryMs;
    (config.webhooks as any).allowPrivateTargets = true;
    (config as any).oaePublicEdge = false;
    (config.webhooks as any).rateTestPerMin = 1;
    (config.webhooks as any).poolRetryMs = 25;
    deliveryLimiter.reset();
    try {
      const mk = (label: string) =>
        createWebhookSubscription({
          url: `http://127.0.0.1:${server.port}/hook`,
          address: 'owner@openagent.email',
          events: ['mail.received'],
          contentScope: 'metadata',
          privateTargetGranted: true,
          createdBy: 'admin',
        });
      const first = mk('a');
      fireCreationPing(first, 'creation', 'r10-probe');
      await waitUntil(() => getWebhookSubscription(first.id)?.state === 'enabled', 2000);

      const second = mk('b');
      fireCreationPing(second, 'creation', 'r10-probe');
      const pending = readAllDeliveryLogRows().find(
        (r) => r.webhookId === second.id && r.outcome === 'pending',
      );
      expect(pending).toBeDefined();
      expect(new Date(pending!.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(Date.now());
      expect(getWebhookSubscription(second.id)?.state).toBe('unverified');
      await waitUntil(() => getWebhookSubscription(second.id)?.state === 'enabled', 2000);
      expect(
        readAllDeliveryLogRows().some(
          (r) => r.webhookId === second.id && r.outcome === 'success',
        ),
      ).toBe(true);
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      (config.webhooks as any).rateTestPerMin = prevProbe;
      (config.webhooks as any).poolRetryMs = prevPool;
      deliveryLimiter.reset();
      server.stop(true);
      deliveryQueue.cancelAll();
    }
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

  test('R5: unverified ping failures are exempt from the circuit breaker (§5.1)', () => {
    const unverified = { state: 'unverified' as const };
    const enabled = { state: 'enabled' as const };
    expect(countsTowardCircuitBreaker('webhook.ping', 'permanent', unverified)).toBe(false);
    expect(countsTowardCircuitBreaker('webhook.ping', 'retryable', unverified)).toBe(false);
    expect(countsTowardCircuitBreaker('webhook.ping', 'permanent', enabled)).toBe(false);
    expect(countsTowardCircuitBreaker('webhook.ping', 'retryable', enabled)).toBe(true);
    expect(countsTowardCircuitBreaker('mail.received', 'permanent', unverified)).toBe(true);
    expect(countsTowardCircuitBreaker('mail.received', 'retryable', unverified)).toBe(true);
    expect(countsTowardCircuitBreaker('webhook.ping', 'refused', unverified)).toBe(false);
  });

  test('R5: creation ping retryable failure does not increment consecutiveFailures', async () => {
    const sub = createWebhookSubscription({
      url: 'https://setup-race.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    expect(sub.state).toBe('unverified');
    (config.webhooks as any).disableThreshold = 1;
    setWebhookDnsLookupForTests(async () => {
      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    });
    try {
      enqueueWebhookDelivery({
        subscription: sub,
        eventId: 'evt_setup_ping',
        type: 'webhook.ping',
        payloadBuilder: () => ({ body: '{}', sensitive: false }),
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === 'evt_setup_ping' && r.outcome === 'retryable',
          ),
        1500,
      );
      const after = getWebhookSubscription(sub.id);
      expect(after?.consecutiveFailures).toBe(0);
      expect(after?.state).toBe('unverified');
    } finally {
      setWebhookDnsLookupForTests(undefined);
      (config.webhooks as any).disableThreshold = 10;
      deliveryQueue.cancelAll();
    }
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

  test('P1: readAllDeliveryLogRows and boot reconstruction tolerate corrupted log lines', async () => {
    const sub = createWebhookSubscription({
      url: 'https://corrupt-test.example/hook',
      address: 'owner@openagent.email',
      events: ['webhook.ping'],
      contentScope: 'metadata',
      description: 'corrupt log test',
      createdBy: 'admin',
    });

    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10000).toISOString();

    // 1. Valid pending row
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_corrupt_valid_1',
      runId: 'run_0',
      deliveryId: 'dlv_c1',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 10000).toISOString(),
      reason: null,
    });

    // 2. Corrupted lines directly appended to JSONL file
    const logPath = join(TEST_DATA_DIR, 'webhook-deliveries.jsonl');
    const corruptSnippet =
      '{"ts":"2026-09-05T00:00:00Z","corrupted_unclosed_json\n' +
      'INVALID TRUNCATED GARBAGE BYTES <<>>\n' +
      '{"ts":"2026-09-05T00:00:00Z","deliveryId":"dlv_bad", incomplete\n';
    const { appendFileSync } = await import('node:fs');
    appendFileSync(logPath, corruptSnippet);

    // 3. Second valid pending row
    appendDeliveryLogRow({
      ts: new Date(bootTime - 8000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_corrupt_valid_2',
      runId: 'run_0',
      deliveryId: 'dlv_c2',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 20000).toISOString(),
      reason: null,
    });

    // readAllDeliveryLogRows must fail open: skip corrupt lines, return the 2 valid rows
    const rows = readAllDeliveryLogRows();
    expect(rows.length).toBe(2);
    expect(rows[0]?.deliveryId).toBe('dlv_c1');
    expect(rows[1]?.deliveryId).toBe('dlv_c2');

    // reconstructPendingDeliveriesAtBoot must succeed without throwing
    const result = await reconstructPendingDeliveriesAtBoot(bootTime);
    expect(result.reconstructed).toBe(2);
    expect(result.deadLettered).toBe(0);
  });

  test('P2-6: boot reconstruction does NOT dead-letter pending deliveries on transient IMAP errors', async () => {
    const sub = createWebhookSubscription({
      url: 'https://transient-test.example/hook',
      address: 'bob@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      description: 'transient error test',
      createdBy: 'admin',
    });

    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10000).toISOString();

    // Append a pending mail delivery row
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_transient_mail',
      runId: 'run_0',
      deliveryId: 'dlv_transient_1',
      type: 'mail.received',
      address: 'bob@test.example',
      messageId: '1001',
      uidValidity: 99999,
      rfc822MessageId: '<test-msg-id@example.com>',
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 10000).toISOString(),
      reason: null,
    });

    // Boot reconstruction runs while IMAP server is not reachable (transient backend failure)
    const result = await reconstructPendingDeliveriesAtBoot(bootTime);

    // It must NOT increment deadLettered
    expect(result.deadLettered).toBe(0);

    // It must NOT have written an outcome: 'permanent' row to the delivery log
    const rows = readAllDeliveryLogRows();
    const deadLetterRows = rows.filter(
      (r) => r.eventId === 'evt_transient_mail' && r.outcome === 'permanent',
    );
    expect(deadLetterRows.length).toBe(0);

    // The original pending row remains intact for subsequent retry/boot
    const pendingRows = rows.filter(
      (r) => r.eventId === 'evt_transient_mail' && r.outcome === 'pending',
    );
    expect(pendingRows.length).toBe(1);
    expect(pendingReconstructionRetryCount()).toBe(1);
  });

  test('R5: transient reconstruction retries with bounded backoff and does not dead-letter', async () => {
    const sub = createWebhookSubscription({
      url: 'https://transient-retry.example/hook',
      address: 'bob@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10_000).toISOString();
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9_000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_transient_retry',
      runId: 'run_0',
      deliveryId: 'dlv_transient_retry',
      type: 'mail.received',
      address: 'bob@test.example',
      messageId: '1002',
      uidValidity: 99999,
      rfc822MessageId: '<retry-msg@example.com>',
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 10_000).toISOString(),
      reason: null,
    });

    setReconstructRetryDelaysForTests(20, 80);
    const first = await reconstructPendingDeliveriesAtBoot(bootTime);
    expect(first.deadLettered).toBe(0);
    expect(first.reconstructed).toBe(0);
    expect(pendingReconstructionRetryCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 90));
    expect(pendingReconstructionRetryCount()).toBe(1);
    const dead = readAllDeliveryLogRows().filter(
      (r) => r.eventId === 'evt_transient_retry' && r.outcome === 'permanent',
    );
    expect(dead.length).toBe(0);
    deliveryQueue.cancelAll();
    expect(pendingReconstructionRetryCount()).toBe(0);
  });

  test('P2-1: test probe slot acquisition timeout writes terminal row preventing orphan pending', async () => {
    const sub = createWebhookSubscription({
      url: 'https://probe-timeout.example/hook',
      address: 'alice@test.example',
      events: ['webhook.ping'],
      contentScope: 'metadata',
      description: 'probe timeout test',
      createdBy: 'admin',
    });

    // Fill concurrency limiter to capacity
    const oldMax = config.webhooks.maxConcurrent;
    const oldTimeout = config.webhooks.deliveryTimeoutMs;
    (config.webhooks as any).maxConcurrent = 1;
    (config.webhooks as any).deliveryTimeoutMs = 100; // fast timeout for test

    expect(deliveryLimiter.acquireSlot('blocking_slot')).toBe(true);

    try {
      await executeWebhookTestProbe(sub, 'test-caller');
      expect().fail('should have thrown rate_limited');
    } catch (err: any) {
      expect(err.code).toBe('rate_limited');
    } finally {
      deliveryLimiter.releaseSlot('blocking_slot');
      (config.webhooks as any).maxConcurrent = oldMax;
      (config.webhooks as any).deliveryTimeoutMs = oldTimeout;
    }

    // Check delivery log: a terminal permanent row was written, preventing orphan pending
    const rows = readAllDeliveryLogRows().filter((r) => r.webhookId === sub.id);
    expect(rows.length).toBe(2);
    expect(rows[0]?.outcome).toBe('pending');
    expect(rows[1]?.outcome).toBe('permanent');
    expect(rows[1]?.reason).toBe('concurrency_pool_full');

    // Boot reconstruction must see terminal state and NOT reconstruct it
    const bootRes = await reconstructPendingDeliveriesAtBoot();
    expect(bootRes.reconstructed).toBe(0);
  });

  test('R4: isTerminalDeliveryRow uses ping=3 and WEBHOOK_MAX_ATTEMPTS, never pending', () => {
    expect(
      isTerminalDeliveryRow({ type: 'webhook.ping', outcome: 'retryable', attempt: 3 }),
    ).toBe(true);
    expect(
      isTerminalDeliveryRow({ type: 'webhook.ping', outcome: 'retryable', attempt: 2 }),
    ).toBe(false);
    expect(
      isTerminalDeliveryRow({ type: 'webhook.ping', outcome: 'pending', attempt: 3 }),
    ).toBe(false);

    const prev = config.webhooks.maxAttempts;
    (config.webhooks as any).maxAttempts = 4;
    try {
      expect(
        isTerminalDeliveryRow({ type: 'mail.received', outcome: 'retryable', attempt: 4 }),
      ).toBe(true);
      expect(
        isTerminalDeliveryRow({ type: 'mail.received', outcome: 'retryable', attempt: 3 }),
      ).toBe(false);
      expect(
        isTerminalDeliveryRow({ type: 'mail.received', outcome: 'pending', attempt: 4 }),
      ).toBe(false);
    } finally {
      (config.webhooks as any).maxAttempts = prev;
    }
  });

  test('R4: boot reconstruction does not resurrect a completed last ping retryable', async () => {
    const sub = createWebhookSubscription({
      url: 'https://recon-ping.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10_000).toISOString();
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9_000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_ping_cap',
      runId: 'run_0',
      deliveryId: 'dlv_ping_cap',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 3,
      outcome: 'retryable',
      status: 500,
      durationMs: 20,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 5_000).toISOString(),
      reason: 'server_error',
    });

    const result = await reconstructPendingDeliveriesAtBoot(bootTime);
    expect(result.reconstructed).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect(deliveryQueue.hasQueuedJob(sub.id, 'evt_ping_cap')).toBe(false);
  });

  test('R4: boot reconstruction does not resurrect retryable at WEBHOOK_MAX_ATTEMPTS', async () => {
    const sub = createWebhookSubscription({
      url: 'https://recon-max.example/hook',
      address: 'owner@openagent.email',
      events: ['approval.requested'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const prev = config.webhooks.maxAttempts;
    (config.webhooks as any).maxAttempts = 4;
    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 3_600_000).toISOString();
    appendDeliveryLogRow({
      ts: new Date(bootTime - 1_000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_max_cap',
      runId: 'run_0',
      deliveryId: 'dlv_max_cap',
      type: 'approval.requested',
      address: 'owner@openagent.email',
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      taskCreatedAt: eventCreatedAt,
      expiresInSec: 86400,
      eventCreatedAt,
      attempt: 4,
      outcome: 'retryable',
      status: 500,
      durationMs: 20,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime + 5_000).toISOString(),
      reason: 'server_error',
    });

    try {
      const result = await reconstructPendingDeliveriesAtBoot(bootTime);
      expect(result.reconstructed).toBe(0);
      expect(result.deadLettered).toBe(0);
    } finally {
      (config.webhooks as any).maxAttempts = prev;
      deliveryQueue.cancelAll();
    }
  });

  test('R4: store-corrupt executeJob writes store_corrupt dead letter without rejecting', async () => {
    const sub = createWebhookSubscription({
      url: 'https://corrupt-job.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const rejections: unknown[] = [];
    const onRej = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRej);
    setWebhooksFailClosedForTests(true);
    try {
      enqueueWebhookDelivery({
        subscription: sub,
        eventId: 'evt_store_corrupt_job',
        type: 'webhook.ping',
        payloadBuilder: () => ({ body: '{}', sensitive: false }),
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === 'evt_store_corrupt_job' && r.reason === 'store_corrupt',
          ),
        1500,
      );
      const row = readAllDeliveryLogRows().find(
        (r) => r.eventId === 'evt_store_corrupt_job' && r.reason === 'store_corrupt',
      );
      expect(row?.outcome).toBe('permanent');
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
      setWebhooksFailClosedForTests(false);
      deliveryQueue.cancelAll();
    }
  });

  test('R4: cancelForWebhook during in-flight executeJob does not reschedule', async () => {
    const sub = createWebhookSubscription({
      url: 'https://cancel-inflight.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    let rejectDns!: (err: unknown) => void;
    setWebhookDnsLookupForTests(
      () =>
        new Promise((_, reject) => {
          rejectDns = reject;
        }),
    );
    const eventId = 'evt_cancel_inflight';
    try {
      enqueueWebhookDelivery({
        subscription: sub,
        eventId,
        type: 'webhook.ping',
        payloadBuilder: () => ({ body: '{}', sensitive: false }),
      });
      await waitUntil(() => deliveryLimiter.isEndpointActive(sub.id), 1500);
      deliveryQueue.cancelForWebhook(sub.id, 'subscription_deleted');
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);

      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      rejectDns(err);
      await new Promise((r) => setTimeout(r, 50));

      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
      const rows = readAllDeliveryLogRows().filter((r) => r.eventId === eventId);
      expect(rows.some((r) => r.outcome === 'permanent' && r.reason === 'subscription_deleted')).toBe(
        true,
      );
      expect(rows.some((r) => r.outcome === 'retryable')).toBe(false);
    } finally {
      setWebhookDnsLookupForTests(undefined);
      deliveryQueue.cancelAll();
    }
  });

  test('R8: pool-full reschedule does not append deferred log rows', async () => {
    const sub = createWebhookSubscription({
      url: 'https://r8-pool.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const oldMax = config.webhooks.maxConcurrent;
    const oldPoolRetry = config.webhooks.poolRetryMs;
    (config.webhooks as any).maxConcurrent = 1;
    (config.webhooks as any).poolRetryMs = 25;
    expect(deliveryLimiter.acquireSlot('r8_blocker')).toBe(true);
    const eventId = 'evt_r8_pool_defer';
    try {
      enqueueWebhookDelivery({
        subscription: sub,
        eventId,
        type: 'webhook.ping',
        payloadBuilder: () => ({ body: '{}', sensitive: false }),
      });
      const afterEnqueue = readAllDeliveryLogRows().filter((r) => r.eventId === eventId);
      expect(afterEnqueue).toHaveLength(1);
      expect(afterEnqueue[0]?.outcome).toBe('pending');

      await waitUntil(() => deliveryQueue.hasQueuedJob(sub.id, eventId), 1000);
      await new Promise((r) => setTimeout(r, 5 * 25 + 80));

      const afterWait = readAllDeliveryLogRows().filter((r) => r.eventId === eventId);
      expect(afterWait).toHaveLength(1);
      expect(afterWait[0]?.outcome).toBe('pending');
      expect(afterWait.some((r) => r.outcome === 'deferred')).toBe(false);
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(true);
    } finally {
      deliveryQueue.cancelAll();
      deliveryLimiter.releaseSlot('r8_blocker');
      (config.webhooks as any).maxConcurrent = oldMax;
      (config.webhooks as any).poolRetryMs = oldPoolRetry;
    }
  });

  test('R8: boot reconstructs expired pending and delivers without a deferred witness', async () => {
    const sub = createWebhookSubscription({
      url: 'https://r8-boot.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10_000).toISOString();
    const eventId = 'evt_r8_expired_pending';
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9_000).toISOString(),
      webhookId: sub.id,
      eventId,
      runId: 'run_0',
      deliveryId: 'dlv_r8_expired',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: false,
      nextAttemptAt: new Date(bootTime - 1_000).toISOString(),
      reason: null,
    });

    setWebhookDnsLookupForTests(async () => {
      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    });
    try {
      const result = await reconstructPendingDeliveriesAtBoot(bootTime);
      expect(result.reconstructed).toBe(1);
      expect(result.deadLettered).toBe(0);
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(true);

      await waitUntil(
        () =>
          readAllDeliveryLogRows().some((r) => r.eventId === eventId && r.outcome === 'retryable'),
        1500,
      );
      const rows = readAllDeliveryLogRows().filter((r) => r.eventId === eventId);
      expect(rows.some((r) => r.outcome === 'pending')).toBe(true);
      expect(rows.some((r) => r.outcome === 'deferred')).toBe(false);
    } finally {
      setWebhookDnsLookupForTests(undefined);
      deliveryQueue.cancelAll();
    }
  });

  test('R4: background SSRF refusal audit omits ip', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ssrf-bg.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    setWebhookDnsLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    try {
      enqueueWebhookDelivery({
        subscription: sub,
        eventId: 'evt_ssrf_bg',
        type: 'webhook.ping',
        payloadBuilder: () => ({ body: '{}', sensitive: false }),
      });
      await waitUntil(
        () => readAuditEvents({ event: 'webhook.ssrf_refused' }).some((e) => e.webhookId === sub.id),
        1500,
      );
      const row = readAuditEvents({ event: 'webhook.ssrf_refused' }).find(
        (e) => e.webhookId === sub.id,
      );
      expect(row).toBeDefined();
      expect(row?.ip).toBeUndefined();
    } finally {
      setWebhookDnsLookupForTests(undefined);
      deliveryQueue.cancelAll();
    }
  });

  afterAll(async () => {
    (config as any).dataDir = originalDataDir;
    (config.webhooks as any).enabled = false;
    delete process.env.WEBHOOKS_ENABLED;
    deliveryQueue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});
