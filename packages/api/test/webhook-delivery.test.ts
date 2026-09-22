process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  isScheduledAttemptBeyondRetryHorizon,
  deriveFirstAttemptAtMsFromGroup,
  getLatestDeliveryForWebhook,
  latestDeliveryByWebhookId,
  parseRetryAfterSeconds,
  readAllDeliveryLogRows,
  readAllDeliveryLogRowsFromDisk,
  readDeliveryLogRows,
  InvalidDeliveryCursorError,
  scanMaxRunNumFromDisk,
  resetDeliveryLogIndexForTests,
  getDeliveryLogIoForTests,
  resetDeliveryLogIoForTests,
  getDeliveryLogRowCapForTests,
  resetDeliveryLogRowCapForTests,
  DELIVERY_LOG_ACTIVE_OVERFLOW_EVENT,
  getLatestDeliveryByWebhookMap,
  reconstructPendingDeliveriesAtBoot,
  redeliverWebhookDelivery,
  setReconstructRetryDelaysForTests,
  setWebhookDnsLookupForTests,
  pendingReconstructionRetryCount,
  countsTowardCircuitBreaker,
  stopWebhookMaintenance,
  validateWebhookUrlResolution,
  validateWebhookUrlStatic,
  RETRY_HORIZON_SEC,
  RETRY_SCHEDULE_OFFSETS_SEC,
} = await import('../src/lib/webhook-delivery.ts');
type WebhookDeliveryLogRow = import('../src/lib/webhook-delivery.ts').WebhookDeliveryLogRow;

const {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookSubscription,
  resetWebhooksStoreForTests,
  setWebhooksFailClosedForTests,
  updateWebhookSubscription,
} = await import('../src/lib/webhook-store.ts');
const { readAuditEvents } = await import('../src/lib/audit.ts');
const { setTaskGetForTests } = await import('../src/lib/tasks-internal.ts');
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
  resetWebhooksStoreForTests();
  setWebhooksFailClosedForTests(false);
  setReconstructRetryDelaysForTests();
  resetDeliveryLogIndexForTests();
  resetDeliveryLogIoForTests();
  resetDeliveryLogRowCapForTests();
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
  stopWebhookMaintenance();
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

  // #294：pin 值一字不动（OFFSETS[10]=259200）
  test('#294 ① pin 值回归：OFFSETS[10] 仍为恰好 +259200s', () => {
    expect(RETRY_SCHEDULE_OFFSETS_SEC[10]).toBe(259200);
    expect(RETRY_HORIZON_SEC).toBe(259200);
    const start = 1_000_000;
    expect(calculateNextAttemptTime(10, start, { randomFn: () => 0.99 })).toBe(start + 259200 * 1000);
  });

  // #294：纯函数打中 :2229 同源判据
  test('#294 纯函数：计划=+72h 不超窗；计划=+72h+1s 超窗', () => {
    const first = 1_000_000;
    const horizonMs = first + RETRY_HORIZON_SEC * 1000;
    expect(isScheduledAttemptBeyondRetryHorizon(horizonMs, first)).toBe(false);
    expect(isScheduledAttemptBeyondRetryHorizon(horizonMs + 1000, first)).toBe(true);
    // 负控：恰好等于不超；小于不超
    expect(isScheduledAttemptBeyondRetryHorizon(horizonMs - 1, first)).toBe(false);
  });

  // #322：组内 attempt=1 最早 ts 派生真实 firstAttemptAt；无 attempt=1 时回落 latest.ts
  test('#322 deriveFirstAttemptAtMsFromGroup：attempt=1 最早 ts；无则回落 latest.ts', () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z');
    const t1 = Date.parse('2026-09-01T01:00:00.000Z');
    const latestTs = '2026-09-02T00:00:00.000Z';
    expect(
      deriveFirstAttemptAtMsFromGroup(
        [
          { attempt: 1, ts: new Date(t1).toISOString() },
          { attempt: 1, ts: new Date(t0).toISOString() },
          { attempt: 2, ts: latestTs },
        ],
        { ts: latestTs },
      ),
    ).toBe(t0);
    // 回落：组内无 attempt=1
    expect(
      deriveFirstAttemptAtMsFromGroup([{ attempt: 2, ts: latestTs }], { ts: latestTs }),
    ).toBe(Date.parse(latestTs));
  });

  // #294 ⑤ clamp 回归：抖动路径仍钳到 horizon-1；Retry-After 路径同钳
  test('#294 ⑤ clamp 回归：抖动与 Retry-After 不得越出 horizon-1', () => {
    const start = 1_000_000;
    // attempt 10 最大抖动仍远低于 horizon
    const t10Hi = calculateNextAttemptTime(9, start, { randomFn: () => 1.0 });
    expect(t10Hi).toBeLessThan(start + RETRY_HORIZON_SEC * 1000);
    // Retry-After 路径钳到 first+(horizon-1)s
    const lateArrival = start + (RETRY_HORIZON_SEC - 10) * 1000;
    const clamped = calculateNextAttemptTime(1, start, {
      retryAfterSec: 3600,
      receivedAtMs: lateArrival,
    });
    expect(clamped).toBe(start + (RETRY_HORIZON_SEC - 1) * 1000);
  });
});

describe('webhook-delivery: #294 retry horizon execute-before check (1b\')', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  /** 构造可立即触发的 schedule job（nextAttemptAt≈now，延迟 0）。 */
  function scheduleHorizonJob(opts: {
    sub: WebhookSubscription;
    eventId: string;
    firstAttemptAt: number;
    nextAttemptAt: number;
    attempt: number;
    payloadBuilder?: (currentSub: WebhookSubscription) => { body: string; sensitive: boolean };
  }): void {
    deliveryQueue.schedule({
      webhookId: opts.sub.id,
      eventId: opts.eventId,
      runId: 'run_0',
      deliveryId: `dlv_${opts.eventId}`,
      type: 'mail.received',
      payloadBuilder:
        opts.payloadBuilder ??
        (() => ({
          body: JSON.stringify({ id: opts.eventId, type: 'mail.received' }),
          sensitive: false,
        })),
      firstAttemptAt: opts.firstAttemptAt,
      attempt: opts.attempt,
      nextAttemptAt: opts.nextAttemptAt,
      replay: false,
      address: opts.sub.address,
      messageId: '1',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: new Date(opts.firstAttemptAt).toISOString(),
    });
  }

  // #294 ② 新行为：计划=+259200s 且 now=+259200s+ε → 执行前检查通过
  test('#294 ② 计划=+72h 且 now=+72h+ε：执行前检查通过（不丢）', async () => {
    const hits: number[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        hits.push(Date.now());
        return new Response('ok', { status: 200 });
      },
    });
    const prevAllow = config.webhooks.allowPrivateTargets;
    (config.webhooks as any).allowPrivateTargets = true;
    try {
      const sub = createWebhookSubscription({
        url: `http://127.0.0.1:${server.port}/hook`,
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        privateTargetGranted: true,
        createdBy: 'admin',
      });
      // first 在 72h 前；计划钉在 first+72h；定时器触发时 now=计划+ε
      // −1 保证 ε≥1ms 确定性；判据区分力不变（旧判据 now>horizon 仍真、新判据 nextAttemptAt>horizon 仍假）
      const firstAttemptAt = Date.now() - RETRY_HORIZON_SEC * 1000 - 1;
      const nextAttemptAt = firstAttemptAt + RETRY_HORIZON_SEC * 1000;
      const eventId = 'evt_294_pass_eps';
      scheduleHorizonJob({
        sub,
        eventId,
        firstAttemptAt,
        nextAttemptAt,
        attempt: 11,
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === eventId && r.outcome === 'success' && r.attempt === 11,
          ),
        3000,
      );
      const rows = readAllDeliveryLogRows().filter((r) => r.eventId === eventId);
      expect(rows.some((r) => r.reason === 'retry_horizon_exceeded')).toBe(false);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      // 实测：触发时墙钟已越过计划（ε>0），旧判据 now>horizon 会误杀
      expect(hits[0]!).toBeGreaterThan(nextAttemptAt);
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      server.stop(true);
      deliveryQueue.cancelAll();
    }
  });

  // #294 ② 负控：计划=+259201s → 仍丢
  test('#294 ② 负控：计划=+72h+1s → retry_horizon_exceeded', async () => {
    const hits: number[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        hits.push(1);
        return new Response('ok', { status: 200 });
      },
    });
    const prevAllow = config.webhooks.allowPrivateTargets;
    (config.webhooks as any).allowPrivateTargets = true;
    try {
      const sub = createWebhookSubscription({
        url: `http://127.0.0.1:${server.port}/hook`,
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        privateTargetGranted: true,
        createdBy: 'admin',
      });
      const firstAttemptAt = Date.now() - RETRY_HORIZON_SEC * 1000;
      // 计划越出 1s → 必须丢
      const nextAttemptAt = firstAttemptAt + (RETRY_HORIZON_SEC + 1) * 1000;
      const eventId = 'evt_294_neg_plus1';
      scheduleHorizonJob({
        sub,
        eventId,
        firstAttemptAt,
        nextAttemptAt,
        attempt: 11,
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === eventId && r.reason === 'retry_horizon_exceeded',
          ),
        3000,
      );
      const row = readAllDeliveryLogRows().find(
        (r) => r.eventId === eventId && r.reason === 'retry_horizon_exceeded',
      );
      expect(row?.outcome).toBe('permanent');
      expect(row?.attempt).toBe(11);
      expect(hits).toHaveLength(0);
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      server.stop(true);
      deliveryQueue.cancelAll();
    }
  });

  // #294 ③ 直打 retry_horizon_exceeded 路径（原零覆盖）
  test('#294 ③ horizon 超限路径：直打 retry_horizon_exceeded', async () => {
    const sub = createWebhookSubscription({
      url: 'https://294-horizon.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const firstAttemptAt = Date.now() - RETRY_HORIZON_SEC * 1000 - 60_000;
    const nextAttemptAt = firstAttemptAt + RETRY_HORIZON_SEC * 1000 + 30_000;
    const eventId = 'evt_294_horizon_direct';
    expect(isScheduledAttemptBeyondRetryHorizon(nextAttemptAt, firstAttemptAt)).toBe(true);
    scheduleHorizonJob({
      sub,
      eventId,
      firstAttemptAt,
      nextAttemptAt,
      attempt: 5,
    });
    await waitUntil(
      () =>
        readAllDeliveryLogRows().some(
          (r) => r.eventId === eventId && r.reason === 'retry_horizon_exceeded',
        ),
      3000,
    );
    const row = readAllDeliveryLogRows().find((r) => r.eventId === eventId)!;
    expect(row.outcome).toBe('permanent');
    expect(row.reason).toBe('retry_horizon_exceeded');
    expect(row.nextAttemptAt).toBeNull();
    expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
  });

  // #294 ④ 端到端：第 11 次失败 → 不重排 → dead-letter（terminal retryable）
  test('#294 ④ 第 11 次执行失败 → calculateNextAttemptTime(11)=null → 不重排', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => new Response('fail', { status: 500 }),
    });
    const prevAllow = config.webhooks.allowPrivateTargets;
    (config.webhooks as any).allowPrivateTargets = true;
    // 提高阈值，避免 threshold 把 retryable 改成 permanent/webhook_disabled
    const prevThreshold = config.webhooks.disableThreshold;
    (config.webhooks as any).disableThreshold = 100;
    try {
      const sub = createWebhookSubscription({
        url: `http://127.0.0.1:${server.port}/hook`,
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        privateTargetGranted: true,
        createdBy: 'admin',
      });
      const firstAttemptAt = Date.now() - RETRY_HORIZON_SEC * 1000;
      const nextAttemptAt = firstAttemptAt + RETRY_HORIZON_SEC * 1000;
      const eventId = 'evt_294_e2e_dl';
      expect(calculateNextAttemptTime(11, firstAttemptAt)).toBeNull();
      scheduleHorizonJob({
        sub,
        eventId,
        firstAttemptAt,
        nextAttemptAt,
        attempt: 11,
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === eventId && r.attempt === 11 && r.outcome === 'retryable',
          ),
        3000,
      );
      const row = readAllDeliveryLogRows().find(
        (r) => r.eventId === eventId && r.attempt === 11 && r.outcome === 'retryable',
      )!;
      expect(row.nextAttemptAt).toBeNull();
      expect(isTerminalDeliveryRow(row)).toBe(true);
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
      expect(row.reason).not.toBe('retry_horizon_exceeded');
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      (config.webhooks as any).disableThreshold = prevThreshold;
      server.stop(true);
      deliveryQueue.cancelAll();
    }
  });

  // #294 ⑤ 重排超窗仍终态（:2271 pool 饱和路径）
  test('#294 ⑤ 重排超窗：pool 饱和 rescheduleAt 越窗 → retry_horizon_exceeded', async () => {
    const sub = createWebhookSubscription({
      url: 'https://294-resched.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const oldMax = config.webhooks.maxConcurrent;
    const oldPoolRetry = config.webhooks.poolRetryMs;
    (config.webhooks as any).maxConcurrent = 1;
    (config.webhooks as any).poolRetryMs = 5_000;
    expect(deliveryLimiter.acquireSlot('blocker_294_resched')).toBe(true);
    try {
      // first 距今几乎到窗；poolRetry 5s 会使 rescheduleAt 越窗
      const firstAttemptAt = Date.now() - RETRY_HORIZON_SEC * 1000 + 1_000;
      const nextAttemptAt = Date.now(); // 立即触发 → 撞 pool → 重排检查
      const eventId = 'evt_294_resched_over';
      scheduleHorizonJob({
        sub,
        eventId,
        firstAttemptAt,
        nextAttemptAt,
        attempt: 3,
      });
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.eventId === eventId && r.reason === 'retry_horizon_exceeded',
          ),
        3000,
      );
      const row = readAllDeliveryLogRows().find((r) => r.eventId === eventId)!;
      expect(row.outcome).toBe('permanent');
      expect(row.reason).toBe('retry_horizon_exceeded');
      expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
    } finally {
      deliveryQueue.cancelAll();
      deliveryLimiter.releaseSlot('blocker_294_resched');
      (config.webhooks as any).maxConcurrent = oldMax;
      (config.webhooks as any).poolRetryMs = oldPoolRetry;
    }
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
      const beforeSecond = Date.now();
      fireCreationPing(second, 'creation', 'r10-probe');
      const pending = readAllDeliveryLogRows().find(
        (r) => r.webhookId === second.id && r.outcome === 'pending',
      );
      expect(pending).toBeDefined();
      expect(new Date(pending!.nextAttemptAt!).getTime()).toBeGreaterThanOrEqual(beforeSecond);
      expect(getWebhookSubscription(second.id)?.state).toBe('unverified');
      // Quota has room again before the delayed fire (window not required to stay full).
      deliveryLimiter.reset();
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

  test('final: delayed ping still full at fire is audited and dropped', async () => {
    const prevProbe = config.webhooks.rateTestPerMin;
    const prevPool = config.webhooks.poolRetryMs;
    (config.webhooks as any).rateTestPerMin = 1;
    (config.webhooks as any).poolRetryMs = 25;
    deliveryLimiter.reset();
    try {
      const first = createWebhookSubscription({
        url: 'https://probe-drop-a.example/hook',
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        createdBy: 'admin',
      });
      fireCreationPing(first, 'creation', 'final-probe');
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.webhookId === first.id && r.outcome !== 'pending',
          ),
        1500,
      );

      const second = createWebhookSubscription({
        url: 'https://probe-drop-b.example/hook',
        address: 'owner@openagent.email',
        events: ['mail.received'],
        contentScope: 'metadata',
        createdBy: 'admin',
      });
      fireCreationPing(second, 'creation', 'final-probe');
      await waitUntil(
        () =>
          readAllDeliveryLogRows().some(
            (r) => r.webhookId === second.id && r.reason === 'probe_rate_limited',
          ),
        1500,
      );
      expect(getWebhookSubscription(second.id)?.state).toBe('unverified');
      const audit = readAuditEvents({ event: 'webhook.probe_rate_limited' }).find(
        (e) => e.webhookId === second.id,
      );
      expect(audit?.outcome).toBe('rate_limited');
      expect(deliveryQueue.hasQueuedJob(second.id)).toBe(false);
    } finally {
      (config.webhooks as any).rateTestPerMin = prevProbe;
      (config.webhooks as any).poolRetryMs = prevPool;
      deliveryLimiter.reset();
      deliveryQueue.cancelAll();
    }
  });

  test(
    'final2: delayed ping admitted to execution does not re-deduct probe bucket on retries',
    async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === '/first') {
          return new Response('ok', { status: 200 });
        }
        callCount++;
        if (callCount === 1) {
          // First attempt of second ping fails with retryable 429 (Retry-After: 1s)
          return new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } });
        }
        // Retry attempt succeeds
        return new Response('ok', { status: 200 });
      },
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
      const mk = (path: string) =>
        createWebhookSubscription({
          url: `http://127.0.0.1:${server.port}${path}`,
          address: 'owner@openagent.email',
          events: ['mail.received'],
          contentScope: 'metadata',
          privateTargetGranted: true,
          createdBy: 'admin',
        });
      // First ping consumes the 1 probe slot
      const first = mk('/first');
      fireCreationPing(first, 'creation', 'final2-probe');
      await waitUntil(() => getWebhookSubscription(first.id)?.state === 'enabled', 2000);

      // Second ping delayed due to full bucket
      const second = mk('/second');
      fireCreationPing(second, 'creation', 'final2-probe');
      const pending = readAllDeliveryLogRows().find(
        (r) => r.webhookId === second.id && r.outcome === 'pending',
      );
      expect(pending).toBeDefined();

      // Clear quota once so delayed ping can pass initial admission
      deliveryLimiter.reset();

      // Wait until attempt 1 runs and retry (attempt 2) runs and succeeds (200)
      // If probeTokenKey were not cleared, attempt 2 would check the probe bucket
      // (which was filled by attempt 1) and be killed with probe_rate_limited!
      await waitUntil(() => getWebhookSubscription(second.id)?.state === 'enabled', 7000);

      expect(callCount).toBeGreaterThanOrEqual(2);
      const rows = readAllDeliveryLogRows().filter((r) => r.webhookId === second.id);
      expect(rows.some((r) => r.reason === 'probe_rate_limited')).toBe(false);
      expect(rows.some((r) => r.outcome === 'success')).toBe(true);
    } finally {
      (config.webhooks as any).allowPrivateTargets = prevAllow;
      (config.webhooks as any).rateTestPerMin = prevProbe;
      (config.webhooks as any).poolRetryMs = prevPool;
      deliveryLimiter.reset();
      server.stop(true);
      deliveryQueue.cancelAll();
    }
  }, 12000);
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
    setTaskGetForTests(null);
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

    setTaskGetForTests(async () => null);
    try {
      const result = await reconstructPendingDeliveriesAtBoot(bootTime);
      // Task does not exist so it dead-letters gracefully with task_not_found
      expect(result.deadLettered).toBe(1);

      const rows = readAllDeliveryLogRows();
      const deadLetterRow = rows.find((r) => r.outcome === 'permanent');
      expect(deadLetterRow).toBeDefined();
      expect(deadLetterRow?.reason).toBe('task_not_found');
      expect(deadLetterRow?.taskCreatedAt).toBe(taskCreatedAt);
      expect(deadLetterRow?.expiresInSec).toBe(86400);
    } finally {
      setTaskGetForTests(null);
    }
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

  test('final: approval reconstruction retries transient getTaskSnapshot like mail', async () => {
    const sub = createWebhookSubscription({
      url: 'https://approval-transient.example/hook',
      address: 'owner@openagent.email',
      events: ['approval.requested'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    const eventCreatedAt = new Date(bootTime - 10_000).toISOString();
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9_000).toISOString(),
      webhookId: sub.id,
      eventId: 'evt_approval_transient',
      runId: 'run_0',
      deliveryId: 'dlv_approval_transient',
      type: 'approval.requested',
      address: 'owner@openagent.email',
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      taskCreatedAt: eventCreatedAt,
      expiresInSec: 86400,
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

    setTaskGetForTests(async () => {
      throw new Error('imap temporarily unavailable');
    });
    setReconstructRetryDelaysForTests(20, 80);
    try {
      const first = await reconstructPendingDeliveriesAtBoot(bootTime);
      expect(first.deadLettered).toBe(0);
      expect(first.reconstructed).toBe(0);
      expect(pendingReconstructionRetryCount()).toBe(1);
      const dead = readAllDeliveryLogRows().filter(
        (r) => r.eventId === 'evt_approval_transient' && r.outcome === 'permanent',
      );
      expect(dead.length).toBe(0);
    } finally {
      setTaskGetForTests(null);
      deliveryQueue.cancelAll();
    }
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

  // #322 验收①②：replay+重启不被更严死信；负控越界仍死信；重建携带真实 firstAttemptAt
  test('#322 boot：eventCreatedAt 远早但 firstAttempt 未越界 → 重建且 firstAttemptAt=attempt1.ts', async () => {
    const sub = createWebhookSubscription({
      url: 'https://boot-iso.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    // 旧墙钟判据会以 eventCreatedAt 死信（80h 前）；同构判据看 firstAttempt（10h 前）+ scheduled
    const eventCreatedAt = new Date(bootTime - 80 * 3600_000).toISOString();
    const firstAttemptTs = bootTime - 10 * 3600_000;
    const eventId = 'evt_322_replay_ok';
    appendDeliveryLogRow({
      ts: new Date(firstAttemptTs).toISOString(),
      webhookId: sub.id,
      eventId,
      runId: 'run_0',
      deliveryId: 'dlv_322_a1',
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
      outcome: 'retryable',
      status: 500,
      durationMs: 10,
      sensitive: false,
      replay: true, // replay 标记：旧事件经 replay 后重启
      nextAttemptAt: new Date(bootTime + 60_000).toISOString(),
      reason: 'server_error',
    });
    appendDeliveryLogRow({
      ts: new Date(bootTime - 9 * 3600_000).toISOString(),
      webhookId: sub.id,
      eventId,
      runId: 'run_0',
      deliveryId: 'dlv_322_a2',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt,
      attempt: 2,
      outcome: 'pending',
      status: null,
      durationMs: null,
      sensitive: false,
      replay: true,
      nextAttemptAt: new Date(bootTime + 60_000).toISOString(),
      reason: null,
    });

    const result = await reconstructPendingDeliveriesAtBoot(bootTime);
    expect(result.reconstructed).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(
      readAllDeliveryLogRows().some(
        (r) => r.eventId === eventId && r.reason === 'retry_horizon_exceeded',
      ),
    ).toBe(false);

    const job = deliveryQueue.peekJobForTests(sub.id, eventId, 'run_0');
    expect(job).toBeDefined();
    expect(job!.firstAttemptAt).toBe(firstAttemptTs);
    // 负控：绝不能静默用 eventCreatedAt
    expect(job!.firstAttemptAt).not.toBe(Date.parse(eventCreatedAt));
    deliveryQueue.cancelAll();
  });

  test('#322 boot 负控：scheduledTime 真正越出 firstAttempt+72h → 仍死信', async () => {
    const sub = createWebhookSubscription({
      url: 'https://boot-iso-neg.example/hook',
      address: 'owner@openagent.email',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const bootTime = Date.now();
    const firstAttemptTs = bootTime - (RETRY_HORIZON_SEC + 3600) * 1000; // 73h 前
    const eventCreatedAt = new Date(firstAttemptTs).toISOString();
    const eventId = 'evt_322_beyond';
    // scheduledTime = max(nextAttemptAt, bootTime) = bootTime > first+72h → 死信
    appendDeliveryLogRow({
      ts: new Date(firstAttemptTs).toISOString(),
      webhookId: sub.id,
      eventId,
      runId: 'run_0',
      deliveryId: 'dlv_322_neg',
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
      nextAttemptAt: new Date(bootTime - 1000).toISOString(),
      reason: null,
    });

    expect(
      isScheduledAttemptBeyondRetryHorizon(bootTime, firstAttemptTs),
    ).toBe(true);

    const result = await reconstructPendingDeliveriesAtBoot(bootTime);
    expect(result.reconstructed).toBe(0);
    expect(result.deadLettered).toBe(1);
    expect(deliveryQueue.hasQueuedJob(sub.id, eventId)).toBe(false);
    const row = readAllDeliveryLogRows().find(
      (r) => r.eventId === eventId && r.outcome === 'permanent',
    );
    expect(row?.reason).toBe('retry_horizon_exceeded');
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

  test('#146: latest-delivery IO stays bounded across warm/append/compact/replace', () => {
    const logPath = join(TEST_DATA_DIR, 'webhook-deliveries.jsonl');
    const row = (
      id: string,
      webhookId: string,
      ts: string,
      attempt = 1,
    ): WebhookDeliveryLogRow => ({
      ts,
      webhookId,
      eventId: `evt_${id}`,
      runId: 'run_0',
      deliveryId: `dlv_${id}`,
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt,
      outcome: 'success',
      status: 200,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });

    const now = Date.now();
    const t1 = new Date(now - 3000).toISOString();
    const t2 = new Date(now - 1000).toISOString();
    appendDeliveryLogRow(row('a1', 'whk_a', t1, 1));
    const a2 = row('a2', 'whk_a', t1, 2);
    a2.reason = 'café-测试';
    appendDeliveryLogRow(a2);
    appendDeliveryLogRow(row('c1', 'whk_c', t1, 1));
    appendDeliveryLogRow(row('c2', 'whk_c', t2, 1));

    // 无追加/替换时数据读必须为 0：次数与字节一并封顶
    const expectNoDataReads = () => {
      expect(getDeliveryLogIoForTests()).toEqual({
        fullReads: 0,
        incrementalReads: 0,
        bytesRead: 0,
      });
    };

    // 显式冷索引：一次全量读，字节按磁盘长度而非字符数
    resetDeliveryLogIndexForTests();
    resetDeliveryLogIoForTests();
    expect(getLatestDeliveryForWebhook('whk_a')?.deliveryId).toBe('dlv_a2');
    expect(getLatestDeliveryForWebhook('whk_b')).toBeNull();
    expect(getLatestDeliveryForWebhook('whk_c')?.deliveryId).toBe('dlv_c2');
    const seededBuf = readFileSync(logPath);
    const seededText = seededBuf.toString('utf8');
    const cold = getDeliveryLogIoForTests();
    expect(cold.fullReads).toBe(1);
    expect(cold.incrementalReads).toBe(0);
    expect(cold.bytesRead).toBe(seededBuf.byteLength);
    expect(seededBuf.byteLength).toBeGreaterThan(seededText.length);
    resetDeliveryLogIoForTests();
    expect(getLatestDeliveryForWebhook('whk_a')?.deliveryId).toBe('dlv_a2');
    expect(getLatestDeliveryForWebhook('whk_b')).toBeNull();
    expect(getLatestDeliveryForWebhook('whk_c')?.deliveryId).toBe('dlv_c2');
    expectNoDataReads();

    getLatestDeliveryForWebhook('whk_a');
    getLatestDeliveryForWebhook('whk_b');
    getLatestDeliveryForWebhook('whk_c');
    expectNoDataReads();

    for (let i = 0; i < 8; i++) {
      appendDeliveryLogRow(row(`x${i}`, `whk_x${i}`, t2, 1));
    }
    resetDeliveryLogIoForTests();
    for (let i = 0; i < 8; i++) {
      expect(getLatestDeliveryForWebhook(`whk_x${i}`)?.deliveryId).toBe(`dlv_x${i}`);
    }
    expect(getLatestDeliveryForWebhook('whk_a')?.deliveryId).toBe('dlv_a2');
    expectNoDataReads();

    const extra = row('c3', 'whk_c', new Date(now).toISOString(), 1);
    const extraLine = `${JSON.stringify(extra)}\n`;
    const extraBytes = Buffer.byteLength(extraLine, 'utf8');
    appendFileSync(logPath, extraLine);
    resetDeliveryLogIoForTests();
    expect(getLatestDeliveryForWebhook('whk_c')?.deliveryId).toBe('dlv_c3');
    const afterAppend = getDeliveryLogIoForTests();
    expect(afterAppend.fullReads).toBe(0);
    expect(afterAppend.incrementalReads).toBe(1);
    expect(afterAppend.bytesRead).toBe(extraBytes);

    const oldTs = new Date(now - 40 * 86400000).toISOString();
    appendDeliveryLogRow(row('old', 'whk_old', oldTs, 1));
    compactDeliveryLog(now, 30);
    resetDeliveryLogIoForTests();
    expect(getLatestDeliveryForWebhook('whk_old')).toBeNull();
    expect(getLatestDeliveryForWebhook('whk_c')?.deliveryId).toBe('dlv_c3');
    expectNoDataReads();

    const replacement = row('rep', 'whk_a', new Date(now + 1000).toISOString(), 1);
    const replacementLine = `${JSON.stringify(replacement)}\n`;
    const replacementBytes = Buffer.byteLength(replacementLine, 'utf8');
    const tmp = `${logPath}.replace`;
    writeFileSync(tmp, replacementLine);
    renameSync(tmp, logPath);
    resetDeliveryLogIoForTests();
    expect(getLatestDeliveryForWebhook('whk_a')?.deliveryId).toBe('dlv_rep');
    expect(getLatestDeliveryForWebhook('whk_c')).toBeNull();
    const afterReplace = getDeliveryLogIoForTests();
    expect(afterReplace.fullReads).toBe(1);
    expect(afterReplace.incrementalReads).toBe(0);
    expect(afterReplace.bytesRead).toBe(replacementBytes);
  });

  test('#146: deliveries list pages from the in-memory index without extra fullReads', () => {
    // #270：游标解析要求生产形 dlv_+UUID
    const idKeepOld = `dlv_${randomUUID()}`;
    const idKeepTie = `dlv_${randomUUID()}`;
    const idKeepTie2 = `dlv_${randomUUID()}`;
    const idKeepNew = `dlv_${randomUUID()}`;
    const idOther = `dlv_${randomUUID()}`;
    const row = (
      deliveryId: string,
      webhookId: string,
      ts: string,
      attempt = 1,
    ): WebhookDeliveryLogRow => ({
      ts,
      webhookId,
      eventId: `evt_${deliveryId}`,
      runId: 'run_0',
      deliveryId,
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt,
      outcome: 'success',
      status: 200,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });

    const now = Date.now();
    const tOld = new Date(now - 3000).toISOString();
    const tMid = new Date(now - 2000).toISOString();
    const tNew = new Date(now - 1000).toISOString();
    // 同 ts 用 attempt 打破平局；另一订阅不得混入分页
    appendDeliveryLogRow(row(idKeepOld, 'whk_list', tOld, 1));
    appendDeliveryLogRow(row(idKeepTie, 'whk_list', tMid, 1));
    appendDeliveryLogRow(row(idKeepTie2, 'whk_list', tMid, 2));
    appendDeliveryLogRow(row(idKeepNew, 'whk_list', tNew, 1));
    appendDeliveryLogRow(row(idOther, 'whk_other', tNew, 1));

    resetDeliveryLogIndexForTests();
    resetDeliveryLogIoForTests();
    const cold = readDeliveryLogRows({ webhookId: 'whk_list', limit: 2 });
    expect(cold.deliveries.map((r) => r.deliveryId)).toEqual([idKeepNew, idKeepTie2]);
    expect(cold.nextCursor).toBe(`${idKeepTie2}|2|${tMid}`);
    expect(getDeliveryLogIoForTests().fullReads).toBe(1);

    // 暖索引后再翻页：fullReads 不得再增
    resetDeliveryLogIoForTests();
    const page2 = readDeliveryLogRows({
      webhookId: 'whk_list',
      limit: 2,
      cursor: cold.nextCursor,
    });
    expect(page2.deliveries.map((r) => r.deliveryId)).toEqual([idKeepTie, idKeepOld]);
    expect(page2.nextCursor).toBeUndefined();
    expect(getDeliveryLogIoForTests().fullReads).toBe(0);

    const again = readDeliveryLogRows({ webhookId: 'whk_list', limit: 100 });
    expect(again.deliveries).toHaveLength(4);
    expect(getDeliveryLogIoForTests().fullReads).toBe(0);

    // limit 钳制 1..100：0/负数按 1，超 100 按 100
    expect(readDeliveryLogRows({ webhookId: 'whk_list', limit: 0 }).deliveries).toHaveLength(1);
    expect(readDeliveryLogRows({ webhookId: 'whk_list', limit: 999 }).deliveries).toHaveLength(4);
    expect(getDeliveryLogIoForTests().fullReads).toBe(0);
  });

  test('#146: compaction leaves deliveries list identical to a disk-scan page', () => {
    const idGone = `dlv_${randomUUID()}`;
    const idKeepA = `dlv_${randomUUID()}`;
    const idKeepB = `dlv_${randomUUID()}`;
    const idPending = `dlv_${randomUUID()}`;
    const idOther = `dlv_${randomUUID()}`;
    const row = (
      deliveryId: string,
      webhookId: string,
      ts: string,
      outcome: 'success' | 'retryable' = 'success',
    ): WebhookDeliveryLogRow => ({
      ts,
      webhookId,
      eventId: `evt_${deliveryId}`,
      runId: 'run_0',
      deliveryId,
      type: 'webhook.ping',
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
      status: outcome === 'success' ? 200 : 500,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: outcome === 'retryable' ? new Date(Date.now() + 60_000).toISOString() : null,
      reason: null,
    });

    const now = Date.now();
    const oldTs = new Date(now - 40 * 86400000).toISOString();
    const keepTs = new Date(now - 1000).toISOString();
    appendDeliveryLogRow(row(idGone, 'whk_list', oldTs));
    appendDeliveryLogRow(row(idKeepA, 'whk_list', keepTs));
    appendDeliveryLogRow(row(idKeepB, 'whk_list', new Date(now - 500).toISOString()));
    appendDeliveryLogRow(row(idPending, 'whk_list', oldTs, 'retryable'));
    appendDeliveryLogRow(row(idOther, 'whk_other', keepTs));

    compactDeliveryLog(now, 30);

    const pageFromDisk = (opts: { webhookId?: string; limit?: number; cursor?: string }) => {
      const all = readAllDeliveryLogRowsFromDisk();
      let filtered = opts.webhookId ? all.filter((r) => r.webhookId === opts.webhookId) : all.slice();
      filtered.sort((a, b) => {
        const tA = new Date(a.ts).getTime();
        const tB = new Date(b.ts).getTime();
        if (tA !== tB) return tB - tA;
        return b.attempt - a.attempt;
      });
      const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
      let startIndex = 0;
      if (opts.cursor) {
        const idx = filtered.findIndex(
          (r) => `${r.deliveryId}|${r.attempt}|${r.ts}` === opts.cursor || r.deliveryId === opts.cursor,
        );
        if (idx >= 0) startIndex = idx + 1;
      }
      const paged = filtered.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < filtered.length;
      const nextCursor =
        hasMore && paged.length > 0
          ? `${paged[paged.length - 1]!.deliveryId}|${paged[paged.length - 1]!.attempt}|${paged[paged.length - 1]!.ts}`
          : undefined;
      return { deliveries: paged, nextCursor };
    };

    const opts = { webhookId: 'whk_list', limit: 2 };
    const fromIndex = readDeliveryLogRows(opts);
    expect(fromIndex).toEqual(pageFromDisk(opts));
    expect(fromIndex.deliveries.map((r) => r.deliveryId)).toEqual([idKeepB, idKeepA]);
    expect(fromIndex.nextCursor).toBeDefined();
    const page2 = readDeliveryLogRows({ ...opts, cursor: fromIndex.nextCursor });
    expect(page2).toEqual(pageFromDisk({ ...opts, cursor: fromIndex.nextCursor }));
    expect(page2.deliveries.map((r) => r.deliveryId)).toEqual([idPending]);
    expect(page2.deliveries.some((r) => r.deliveryId === idGone)).toBe(false);
  });

  // #216：stale cursor 显式拒绝，禁止静默回卷页 1
  test('#216: unknown cursor throws InvalidDeliveryCursorError', () => {
    const ts = new Date().toISOString();
    appendDeliveryLogRow({
      ts,
      webhookId: 'whk_stale',
      eventId: 'evt_a',
      runId: 'run_0',
      deliveryId: 'dlv_a',
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });
    resetDeliveryLogIndexForTests();

    expect(() =>
      readDeliveryLogRows({ webhookId: 'whk_stale', limit: 10, cursor: 'dlv_missing|1|1970-01-01T00:00:00.000Z' }),
    ).toThrow(InvalidDeliveryCursorError);

    try {
      readDeliveryLogRows({ webhookId: 'whk_stale', limit: 10, cursor: 'not-a-real-cursor' });
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDeliveryCursorError);
      expect((err as InvalidDeliveryCursorError).code).toBe('invalid_cursor');
    }
  });

  test('#216: full-form and bare deliveryId cursors still page; home has no throw', () => {
    const now = Date.now();
    const tOld = new Date(now - 3000).toISOString();
    const tMid = new Date(now - 2000).toISOString();
    const tNew = new Date(now - 1000).toISOString();
    // #270：游标解析对齐生产 dlv_+规范 UUID
    const idOld = `dlv_${randomUUID()}`;
    const idMid = `dlv_${randomUUID()}`;
    const idNew = `dlv_${randomUUID()}`;
    const row = (deliveryId: string, ts: string, attempt = 1): WebhookDeliveryLogRow => ({
      ts,
      webhookId: 'whk_cursor',
      eventId: `evt_${deliveryId}`,
      runId: 'run_0',
      deliveryId,
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt,
      outcome: 'success',
      status: 200,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });
    appendDeliveryLogRow(row(idOld, tOld));
    appendDeliveryLogRow(row(idMid, tMid));
    appendDeliveryLogRow(row(idNew, tNew));
    resetDeliveryLogIndexForTests();

    // 首页：无 cursor 不抛
    const home = readDeliveryLogRows({ webhookId: 'whk_cursor', limit: 2 });
    expect(home.deliveries.map((r) => r.deliveryId)).toEqual([idNew, idMid]);
    expect(home.nextCursor).toBe(`${idMid}|1|${tMid}`);

    // 全形态 cursor 命中分页
    const page2 = readDeliveryLogRows({
      webhookId: 'whk_cursor',
      limit: 2,
      cursor: home.nextCursor,
    });
    expect(page2.deliveries.map((r) => r.deliveryId)).toEqual([idOld]);
    expect(page2.nextCursor).toBeUndefined();

    // 裸 deliveryId 命中：从该 id 之后继续
    const byBare = readDeliveryLogRows({
      webhookId: 'whk_cursor',
      limit: 2,
      cursor: idNew,
    });
    expect(byBare.deliveries.map((r) => r.deliveryId)).toEqual([idMid, idOld]);
  });

  test('#216: empty log + cursor throws InvalidDeliveryCursorError', () => {
    resetDeliveryLogIndexForTests();
    expect(() =>
      readDeliveryLogRows({
        webhookId: 'whk_empty',
        limit: 10,
        cursor: `dlv_${randomUUID()}|1|1970-01-01T00:00:00.000Z`,
      }),
    ).toThrow(InvalidDeliveryCursorError);
    // 空 log 首页仍不抛
    expect(readDeliveryLogRows({ webhookId: 'whk_empty', limit: 10 }).deliveries).toEqual([]);
  });

  afterAll(async () => {
    resetWebhooksStoreForTests();
    (config as any).dataDir = originalDataDir;
    (config.webhooks as any).enabled = false;
    delete process.env.WEBHOOKS_ENABLED;
    deliveryQueue.cancelAll();
    stopWebhookMaintenance();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});

describe('webhook-delivery: #217 in-memory delivery-log row cap', () => {
  const originalLogMaxRows = config.webhooks.logMaxRows;

  beforeEach(() => {
    setupTestDir();
    resetDeliveryLogRowCapForTests();
  });
  afterEach(() => {
    (config.webhooks as any).logMaxRows = originalLogMaxRows;
    deliveryQueue.cancelAll();
    // 恢复 dataDir，避免删目录后污染后续用例（delegations 等）
    (config as any).dataDir = originalDataDir;
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  /** 构造最小成功行；ts 递增保证 append 序=时间序 */
  function successRow(
    id: string,
    ts: string,
    webhookId = 'whk_cap',
  ): WebhookDeliveryLogRow {
    return {
      ts,
      webhookId,
      eventId: `evt_${id}`,
      runId: 'run_0',
      deliveryId: `dlv_${id}`,
      type: 'webhook.ping',
      address: null,
      messageId: null,
      uidValidity: null,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 10,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    };
  }

  // (a) 超限逐出后旧区游标必 400 invalid_cursor 非回卷
  test('#217(a): cursor into evicted zone throws InvalidDeliveryCursorError (no rewind)', () => {
    (config.webhooks as any).logMaxRows = 3; // 滞回目标 floor(3*0.9)=2
    const base = Date.now();
    const rows = [0, 1, 2, 3, 4].map((i) =>
      successRow(String(i), new Date(base + i * 1000).toISOString()),
    );
    for (const r of rows) appendDeliveryLogRow(r);

    // 滞回一次裁到目标 2；最旧区已逐出
    const mem = readAllDeliveryLogRows();
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_3', 'dlv_4']);

    const staleCursor = `${rows[0]!.deliveryId}|1|${rows[0]!.ts}`;
    expect(() =>
      readDeliveryLogRows({ webhookId: 'whk_cap', limit: 10, cursor: staleCursor }),
    ).toThrow(InvalidDeliveryCursorError);

    try {
      readDeliveryLogRows({ webhookId: 'whk_cap', limit: 10, cursor: rows[0]!.deliveryId });
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDeliveryCursorError);
      expect((err as InvalidDeliveryCursorError).code).toBe('invalid_cursor');
    }

    // 负控：合法首页不抛、不回卷成含已逐出行
    const home = readDeliveryLogRows({ webhookId: 'whk_cap', limit: 10 });
    expect(home.deliveries.map((r) => r.deliveryId)).toEqual(['dlv_4', 'dlv_3']);
  });

  // (b) active 组行零逐出
  test('#217(b): active pending-retry group rows are never evicted', () => {
    (config.webhooks as any).logMaxRows = 3; // 目标 2
    const now = Date.now();
    // 先写入 1 条终态，再写入同组 2 条 pending（最新非终态 → 整组 active）
    appendDeliveryLogRow(successRow('old', new Date(now).toISOString(), 'whk_other'));
    appendDeliveryLogRow({
      ...successRow('p1', new Date(now + 1000).toISOString(), 'whk_active'),
      eventId: 'evt_pending',
      outcome: 'retryable',
      status: 500,
      nextAttemptAt: new Date(now + 60_000).toISOString(),
    });
    appendDeliveryLogRow({
      ...successRow('p2', new Date(now + 2000).toISOString(), 'whk_active'),
      eventId: 'evt_pending',
      attempt: 2,
      outcome: 'retryable',
      status: 502,
      nextAttemptAt: new Date(now + 120_000).toISOString(),
    });
    // 再灌入多条终态迫使超限；active 组两行必须全留
    appendDeliveryLogRow(successRow('n1', new Date(now + 3000).toISOString(), 'whk_n'));
    appendDeliveryLogRow(successRow('n2', new Date(now + 4000).toISOString(), 'whk_n'));
    appendDeliveryLogRow(successRow('n3', new Date(now + 5000).toISOString(), 'whk_n'));

    const mem = readAllDeliveryLogRows();
    // 目标 2：仅保留 active 两行（终态全逐出）
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_p1', 'dlv_p2']);
  });

  // (b2) 活组 alone 已超上限：仍须剔光终态，仅对活组宁超
  test('#217(b2): when active alone exceeds cap, terminals still evict; actives retained over cap', () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const now = Date.now();
    appendDeliveryLogRow(successRow('term_a', new Date(now).toISOString(), 'whk_t'));
    appendDeliveryLogRow(successRow('term_b', new Date(now + 500).toISOString(), 'whk_t'));
    // mail.received + attempt≤3 仍非终态（cap=11）；勿用 webhook.ping（attempt=3 已终态）
    for (let i = 1; i <= 3; i++) {
      appendDeliveryLogRow({
        ...successRow(`p${i}`, new Date(now + 1000 * i).toISOString(), 'whk_live'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: String(i),
        uidValidity: 1,
        eventId: 'evt_live',
        attempt: i,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000 * i).toISOString(),
      });
    }
    const mem = readAllDeliveryLogRows();
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_p1', 'dlv_p2', 'dlv_p3']);
    expect(mem.length).toBeGreaterThan(2); // 宁超不丢活
    expect(mem.some((r) => r.deliveryId.startsWith('dlv_term_'))).toBe(false);
  });

  // (c) 逐出前后盘文件字节零变化
  test('#217(c): eviction leaves on-disk jsonl bytes unchanged', () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const logPath = join(TEST_DATA_DIR, 'webhook-deliveries.jsonl');
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      appendDeliveryLogRow(successRow(String(i), new Date(base + i * 1000).toISOString()));
    }
    const diskBefore = readFileSync(logPath);
    expect(readAllDeliveryLogRows().length).toBe(1);

    // 强制冷重建再收敛：盘字节仍应一字不动
    resetDeliveryLogIndexForTests();
    const mem = readAllDeliveryLogRows();
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_4']);
    const diskAfter = readFileSync(logPath);
    expect(Buffer.compare(diskBefore, diskAfter)).toBe(0);
    expect(readAllDeliveryLogRowsFromDisk().map((r) => r.deliveryId)).toEqual([
      'dlv_0',
      'dlv_1',
      'dlv_2',
      'dlv_3',
      'dlv_4',
    ]);
  });

  // (d) Map 视图与全量扫 latestDeliveryByWebhookId 逐字一致
  test('#217(d): getLatestDeliveryByWebhookMap matches scan-built map', () => {
    const base = Date.now();
    appendDeliveryLogRow(successRow('a1', new Date(base).toISOString(), 'whk_a'));
    appendDeliveryLogRow(successRow('a2', new Date(base + 1000).toISOString(), 'whk_a'));
    appendDeliveryLogRow(successRow('b1', new Date(base + 2000).toISOString(), 'whk_b'));

    const fromMap = getLatestDeliveryByWebhookMap();
    const fromScan = latestDeliveryByWebhookId(readAllDeliveryLogRows());
    expect([...fromMap.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual(
      [...fromScan.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(fromMap.get('whk_a')?.deliveryId).toBe('dlv_a2');
    expect(fromMap.get('whk_b')?.deliveryId).toBe('dlv_b1');
  });

  // (e) redeliver 逐出区 id → delivery_not_found
  test('#217(e): redeliver of evicted deliveryId yields delivery_not_found', async () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      appendDeliveryLogRow(successRow(String(i), new Date(base + i * 1000).toISOString()));
    }
    expect(readAllDeliveryLogRows().map((r) => r.deliveryId)).toEqual(['dlv_3']);

    await expect(redeliverWebhookDelivery('dlv_0')).rejects.toMatchObject({
      code: 'delivery_not_found',
    });
  });

  // (f) warn-once 只出一行 + 计数正确（滞回：一次可多丢）
  test('#217(f): warn-once fires once; eviction counter accumulates', () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const base = Date.now();
      // 先灌满上限并预热索引，使后续 append 走热路径 enforce
      appendDeliveryLogRow(successRow('0', new Date(base).toISOString()));
      appendDeliveryLogRow(successRow('1', new Date(base + 1000).toISOString()));
      expect(readAllDeliveryLogRows().map((r) => r.deliveryId)).toEqual(['dlv_0', 'dlv_1']);
      resetDeliveryLogRowCapForTests();
      warns.length = 0;

      // 3 > 2 → 一次裁到目标 1，丢 2 行
      appendDeliveryLogRow(successRow('2', new Date(base + 2000).toISOString()));
      expect(getDeliveryLogRowCapForTests().evictedTotal).toBe(2);
      expect(getDeliveryLogRowCapForTests().warnCount).toBe(1);
      expect(getDeliveryLogRowCapForTests().rebuilds).toBe(1);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain('WEBHOOK_LOG_MAX_ROWS=2');
      expect(warns[0]).toContain('evictedTotal=2');

      // 再 append：长度 2 ≤ 上限，不触发；再超限才第二次重建
      appendDeliveryLogRow(successRow('3', new Date(base + 3000).toISOString()));
      expect(getDeliveryLogRowCapForTests().rebuilds).toBe(1);
      expect(getDeliveryLogRowCapForTests().warnCount).toBe(1);
      expect(warns.length).toBe(1);

      appendDeliveryLogRow(successRow('4', new Date(base + 4000).toISOString()));
      expect(getDeliveryLogRowCapForTests().rebuilds).toBe(2);
      expect(getDeliveryLogRowCapForTests().evictedTotal).toBe(4);
      expect(getDeliveryLogRowCapForTests().warnCount).toBe(1);
      expect(warns.length).toBe(1); // 仍只一行
    } finally {
      console.warn = originalWarn;
    }
  });

  // (g) 滞回：上限+1 触发一次重建；上限+2 仍 ≤ 上限则不再重建
  test('#217(g): hysteresis — second append under cap after batch trim does not rebuild', () => {
    (config.webhooks as any).logMaxRows = 10; // 目标 9
    const base = Date.now();
    for (let i = 0; i < 10; i++) {
      appendDeliveryLogRow(successRow(String(i), new Date(base + i * 1000).toISOString()));
    }
    expect(readAllDeliveryLogRows().length).toBe(10);
    resetDeliveryLogRowCapForTests();

    // 上限+1 → 一次裁到 9
    appendDeliveryLogRow(successRow('10', new Date(base + 10_000).toISOString()));
    expect(readAllDeliveryLogRows().length).toBe(9);
    expect(getDeliveryLogRowCapForTests().rebuilds).toBe(1);

    // 上限+2：现长 10 ≤ 10，不触发重建
    appendDeliveryLogRow(successRow('11', new Date(base + 11_000).toISOString()));
    expect(readAllDeliveryLogRows().length).toBe(10);
    expect(getDeliveryLogRowCapForTests().rebuilds).toBe(1);
  });

  // (h) maxRows=1：目标钳制为 1，连续两笔终态后内存恰剩最新一行
  test('#217(h): maxRows=1 clamps hysteresis target to 1; keeps newest terminal', () => {
    (config.webhooks as any).logMaxRows = 1;
    const base = Date.now();
    appendDeliveryLogRow(successRow('old', new Date(base).toISOString(), 'whk_h'));
    appendDeliveryLogRow(successRow('new', new Date(base + 1000).toISOString(), 'whk_h'));

    const mem = readAllDeliveryLogRows();
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_new']);
    expect(getLatestDeliveryForWebhook('whk_h')?.deliveryId).toBe('dlv_new');
    expect(getLatestDeliveryForWebhook('whk_h')).not.toBeNull();
  });

  // (i) 盘源 maxRunNum：内存逐出 run_3 后 redeliver 得 run_4；boot 不丢新 pending 组
  test('#217(i): redeliver maxRunNum from disk; boot keeps new pending group active', async () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1：最旧 run_3 必被逐出
    (config.webhooks as any).allowPrivateTargets = true;
    const sub = createWebhookSubscription({
      url: 'https://127.0.0.1/cap-runid',
      address: 'alice@test.example',
      events: ['webhook.ping'],
      createdBy: 'alice@test.example',
    });
    setWebhookDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);

    const base = Date.now();
    const mk = (runNum: number, id: string, tsOff: number): WebhookDeliveryLogRow => ({
      ...successRow(id, new Date(base + tsOff).toISOString(), sub.id),
      eventId: 'evt_runid',
      runId: `run_${runNum}`,
      type: 'webhook.ping',
    });
    // 盘序：run_3 最旧 → 将被内存逐出；run_1/run_2 较新
    appendDeliveryLogRow(mk(3, 'r3', 0));
    appendDeliveryLogRow(mk(1, 'r1', 1000));
    appendDeliveryLogRow(mk(2, 'r2', 2000));

    expect(readAllDeliveryLogRowsFromDisk().map((r) => r.runId)).toEqual([
      'run_3',
      'run_1',
      'run_2',
    ]);
    const mem = readAllDeliveryLogRows();
    expect(mem.some((r) => r.runId === 'run_3')).toBe(false);
    expect(mem.some((r) => r.runId === 'run_2')).toBe(true);

    const replay = await redeliverWebhookDelivery('dlv_r2');
    expect(replay.runId).toBe('run_4'); // 盘源 max=3 → +1；若吃内存会错成 run_3
    deliveryQueue.cancelAll();

    // 盘上已有 run_4 pending（enqueue 写入）+ 历史 run_3 终态；冷重建后 pending 组须被 boot 收起
    resetDeliveryLogIndexForTests();
    const boot = await reconstructPendingDeliveriesAtBoot(Date.now());
    expect(boot.reconstructed).toBeGreaterThanOrEqual(1);
    // 负控：若撞成 run_3，高 attempt 终态会压过 pending，boot 会丢组（reconstructed 不含该链）
    const disk = readAllDeliveryLogRowsFromDisk();
    expect(disk.some((r) => r.runId === 'run_4' && r.outcome === 'pending')).toBe(true);
    setWebhookDnsLookupForTests(undefined);
  });

  // (j) 纯活组超限态：futile 置位后连续 append 非终态 → 全表扫描次数=0
  test('#217(j): pure-active over-cap: subsequent non-terminal appends do not full-scan', () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const now = Date.now();
    // 灌入 3 条同组 pending（mail.received），alone 超限 → 置 futile
    for (let i = 1; i <= 3; i++) {
      appendDeliveryLogRow({
        ...successRow(`live${i}`, new Date(now + 1000 * i).toISOString(), 'whk_j'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: String(i),
        uidValidity: 1,
        eventId: 'evt_j_live',
        attempt: i,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000 * i).toISOString(),
      });
    }
    expect(readAllDeliveryLogRows().length).toBe(3); // 宁超不丢活
    // 已进入 futile；重置计数后连续 append 非终态不得再全表扫
    resetDeliveryLogRowCapForTests();
    for (let i = 4; i <= 6; i++) {
      appendDeliveryLogRow({
        ...successRow(`live${i}`, new Date(now + 1000 * i).toISOString(), 'whk_j'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: String(i),
        uidValidity: 1,
        eventId: 'evt_j_live',
        attempt: i,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000 * i).toISOString(),
      });
    }
    expect(getDeliveryLogRowCapForTests().scanCount).toBe(0);
    expect(getDeliveryLogRowCapForTests().rebuilds).toBe(0);
    expect(getDeliveryLogRowCapForTests().evictedTotal).toBe(0);
    expect(readAllDeliveryLogRows().length).toBe(6);
  });

  // (k) futile 置位后 append 终态 → 清位且下一轮 enforce 恢复逐出该终态行
  test('#217(k): terminal after futile clears memo and resumes eviction', () => {
    (config.webhooks as any).logMaxRows = 2; // 目标 1
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      appendDeliveryLogRow({
        ...successRow(`k${i}`, new Date(now + 1000 * i).toISOString(), 'whk_k'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: String(i),
        uidValidity: 1,
        eventId: 'evt_k_live',
        attempt: i,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000 * i).toISOString(),
      });
    }
    expect(readAllDeliveryLogRows().length).toBe(3);
    resetDeliveryLogRowCapForTests();

    // 终态行清 futile；本轮 enforce 须扫描并逐出该终态（活组保留）
    appendDeliveryLogRow(
      successRow('term', new Date(now + 4000).toISOString(), 'whk_k_term'),
    );
    expect(getDeliveryLogRowCapForTests().scanCount).toBe(1);
    expect(getDeliveryLogRowCapForTests().evictedTotal).toBeGreaterThanOrEqual(1);
    const mem = readAllDeliveryLogRows();
    expect(mem.some((r) => r.deliveryId === 'dlv_term')).toBe(false);
    expect(mem.map((r) => r.deliveryId)).toEqual(['dlv_k1', 'dlv_k2', 'dlv_k3']);
  });

  // #268 b 案：超 floor(10×maxRows) 升 error 级 delivery_log_active_overflow；不丢活；once
  test('#268: active overflow past 10×maxRows emits error once; rows retained', () => {
    (config.webhooks as { logMaxRows: number }).logMaxRows = 2; // 次级上限 floor(20)
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
    try {
      const now = Date.now();
      // 21 个独立活组（各 attempt=1），避免 attempt≥cap 变终态被逐出
      for (let i = 1; i <= 21; i++) {
        appendDeliveryLogRow({
          ...successRow(`ov${i}`, new Date(now + 1000 * i).toISOString(), 'whk_ov'),
          type: 'mail.received',
          address: 'alice@test.example',
          messageId: String(i),
          uidValidity: 1,
          eventId: `evt_ov_${i}`,
          attempt: 1,
          outcome: 'retryable',
          status: 500,
          nextAttemptAt: new Date(now + 60_000).toISOString(),
        });
      }
      expect(readAllDeliveryLogRows().length).toBe(21);
      expect(errors.length).toBe(1);
      const payload = JSON.parse(errors[0]!);
      expect(payload.event).toBe(DELIVERY_LOG_ACTIVE_OVERFLOW_EVENT);
      expect(payload.maxRows).toBe(2);
      expect(payload.secondaryCap).toBe(20);
      expect(payload.rows).toBeGreaterThan(20);

      // 再 append 仍 once
      appendDeliveryLogRow({
        ...successRow('ov22', new Date(now + 22_000).toISOString(), 'whk_ov'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: '22',
        uidValidity: 1,
        eventId: 'evt_ov_22',
        attempt: 1,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000).toISOString(),
      });
      expect(errors.length).toBe(1);
      expect(readAllDeliveryLogRows().length).toBe(22);
    } finally {
      console.error = originalError;
    }
  });

  // #268 附带：滞回剔光终态后仍超限 → 钉 futile，后续非终态 append 不再全表扫
  test('#268: hysteresis rebuild while still over cap sets futile (no rescan amplify)', () => {
    (config.webhooks as { logMaxRows: number }).logMaxRows = 3; // 目标 2
    const now = Date.now();
    // 1 终态 + 4 活组行：超限时剔终态后仍 4>3 → 须钉 futile
    appendDeliveryLogRow(successRow('term', new Date(now).toISOString(), 'whk_t'));
    for (let i = 1; i <= 4; i++) {
      appendDeliveryLogRow({
        ...successRow(`h${i}`, new Date(now + 1000 * i).toISOString(), 'whk_hyst'),
        type: 'mail.received',
        address: 'alice@test.example',
        messageId: String(i),
        uidValidity: 1,
        eventId: 'evt_hyst',
        attempt: i,
        outcome: 'retryable',
        status: 500,
        nextAttemptAt: new Date(now + 60_000 * i).toISOString(),
      });
    }
    const mem = readAllDeliveryLogRows();
    expect(mem.some((r) => r.deliveryId === 'dlv_term')).toBe(false);
    expect(mem.length).toBe(4);
    resetDeliveryLogRowCapForTests();
    appendDeliveryLogRow({
      ...successRow('h5', new Date(now + 5000).toISOString(), 'whk_hyst'),
      type: 'mail.received',
      address: 'alice@test.example',
      messageId: '5',
      uidValidity: 1,
      eventId: 'evt_hyst',
      attempt: 5,
      outcome: 'retryable',
      status: 500,
      nextAttemptAt: new Date(now + 60_000 * 5).toISOString(),
    });
    // 若未钉 futile，本轮会再 scan+rebuild；钉死后 scanCount=0
    expect(getDeliveryLogRowCapForTests().scanCount).toBe(0);
    expect(getDeliveryLogRowCapForTests().rebuilds).toBe(0);
    expect(readAllDeliveryLogRows().length).toBe(5);
  });

  // #268 R2：多字节 UTF-8 webhookId 跨分块边界仍能匹配 maxRunNum（StringDecoder）
  test('#268 R2: multi-byte webhookId split across chunk still yields maxRunNum', () => {
    const webhookId = 'whk_测🌿试'; // 多字节序列，逼出跨 chunk 切 UTF-8
    const eventId = 'evt_utf8_chunk';
    const ts = new Date().toISOString();
    const row = {
      ts,
      webhookId,
      eventId,
      runId: 'run_7',
      deliveryId: `dlv_${randomUUID()}`,
      type: 'mail.received',
      address: 'alice@test.example',
      messageId: '1',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 1,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    };
    const line = `${JSON.stringify(row)}\n`;
    const path = join(TEST_DATA_DIR, 'webhook-deliveries.jsonl');
    const fileBuf = Buffer.from(line, 'utf8');
    // 在「测」(3 字节) 的首字节后切开，旧 toString 会变 U+FFFD 导致 webhookId 失配
    const cutAt = fileBuf.indexOf(Buffer.from('测', 'utf8'));
    expect(cutAt).toBeGreaterThan(0);
    writeFileSync(path, fileBuf);
    expect(scanMaxRunNumFromDisk(webhookId, eventId, cutAt + 1)).toBe(7);
    expect(scanMaxRunNumFromDisk('whk_other', eventId, cutAt + 1)).toBe(0);
  });
});
