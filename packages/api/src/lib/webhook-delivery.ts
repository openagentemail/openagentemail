/**
 * Outbound Webhook Delivery Engine (RFC-0001 §6, §8, §9, §10, §12).
 *
 * Coordinates durable JSONL logging, SSRF pinning, sliding-window rate limiting,
 * per-endpoint and instance-wide concurrency pools, 11-attempt 72h retry backoff,
 * circuit breaker disablement, payload bounding, derived HMAC signing,
 * and boot reconstruction.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { config } from './config.ts';
import { recordAuditEvent } from './audit.ts';
import { describeFailureStack, scrubPayload } from './redact.ts';
import {
  defaultDnsLookup,
  pinnedFetch,
  type DnsLookup,
  type PinnedFetchOptions,
} from './pinned-fetch.ts';
import {
  isBlockedSsrfIp,
  isPrivateOrLoopbackHostname,
  isSsrfBlockedResolvedIp,
} from './net.ts';
import { slidingWindowCheck, slidingWindowRelease } from './ratelimit.ts';
import {
  buildWebhookSignatureHeader,
  deriveWebhookKey,
} from './webhook-signing.ts';
import {
  compactIdempotencyKeys,
  getWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
  WebhookStoreCorruptError,
  type WebhookSubscription,
  type WebhookState,
} from './webhook-store.ts';
import { encodeMailForwardCursor } from './mail-cursor.ts';
import { truncateUtf8Bytes, truncateUtf8Codepoints } from './utf8-truncate.ts';

export function truncateUtf8String(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.byteLength <= maxBytes) return str;
  return truncateUtf8Bytes(buf, maxBytes).toString('utf8');
}

import { getMessage, withInbox, StaleMessageGenerationError } from './imap.ts';
import { getTaskSnapshot } from './tasks-internal.ts';
import { registerWebhookCancelCallback } from './identities.ts';
import { simpleParser } from 'mailparser';

let customDnsLookupForTests: DnsLookup | undefined;
export function setWebhookDnsLookupForTests(fn?: DnsLookup): void {
  customDnsLookupForTests = fn;
}

// ---------------------------------------------------------------------------
// Types and Schemas
// ---------------------------------------------------------------------------

export type WebhookEventType = 'mail.received' | 'approval.requested' | 'webhook.ping';

export type WebhookDeliveryOutcome =
  | 'pending'
  | 'success'
  | 'retryable'
  | 'permanent'
  | 'refused'
  | 'deferred';

export type WebhookDeliveryLogRow = {
  ts: string;
  webhookId: string;
  eventId: string;
  runId: string;
  deliveryId: string;
  type: WebhookEventType;
  address: string | null;
  messageId: string | null;
  uidValidity: number | null;
  rfc822MessageId: string | null;
  taskId: string | null;
  taskCreatedAt: string | null;
  expiresInSec: number | null;
  taskExpiresInSec?: number | null;
  eventCreatedAt: string;
  attempt: number;
  outcome: WebhookDeliveryOutcome;
  status: number | null;
  durationMs: number | null;
  sensitive: boolean;
  replay: boolean;
  nextAttemptAt: string | null;
  reason?: string | null;
};

export type WebhookEnvelopeBase = {
  id: string; // evt_<uuid>
  type: WebhookEventType;
  payloadVersion: 'v1';
  createdAt: string; // ISO RFC 3339
  domain: string;
};

export type MailEventInput = {
  address: string;
  messageId: string;
  uid: number;
  uidValidity: number | null;
  receivedAt: string;
  rfc822MessageId?: string | null;
  from: { address: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  sizeBytes: number;
  hasAttachments: boolean;
  unread: boolean;
  containsSecurityCode: boolean;
  containsLink: boolean;
  textPreview?: string;
  securityCodes?: string[];
  links?: string[];
};

export type ApprovalEventInput = {
  taskId: string;
  taskState: 'input-required';
  from: string;
  to: string;
  reviewer: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
  expiresInSec: number | null;
  digest: string;
  actionType: string;
  actionName: string;
  actionArguments?: unknown;
};

// ---------------------------------------------------------------------------
// Retry Schedule (§8.3)
// ---------------------------------------------------------------------------

export const WEBHOOK_META_FIELD_MAX_BYTES = 400;
export const WEBHOOK_BODY_PREVIEW_CHARS = 280;
export const WEBHOOK_MAX_CODE_ITEMS = 5;
export const WEBHOOK_CODE_ENTRY_CHARS = 200;

/** Cumulative offsets in seconds from the first attempt (11 attempts spanning 72 hours). */
export const RETRY_SCHEDULE_OFFSETS_SEC = [
  0,        // 1: immediate
  5,        // 2: +5s
  300,      // 3: +5m
  1800,     // 4: +30m
  7200,     // 5: +2h
  18000,    // 6: +5h
  36000,    // 7: +10h
  72000,    // 8: +20h
  122400,   // 9: +34h
  172800,   // 10: +48h
  259200,   // 11: +72h (pinned)
] as const;

export const MAX_RETRY_SCHEDULE_ATTEMPTS = 11;
export const MAX_PING_ATTEMPTS = 3;
export const RETRY_HORIZON_SEC = 259200; // 72 hours in seconds

/**
 * 执行前 72h horizon 检查（#294 / RFC §8.3）。
 * 约束的是「本次重试排期」是否超出 firstAttemptAt+72h，而非作业恰在何时被定时器触发。
 * 因此用 nextAttemptAt 判界：计划钉在恰好 +72h 时，即便 now=计划+ε 也不得临门丢弃。
 */
export function isScheduledAttemptBeyondRetryHorizon(
  nextAttemptAt: number,
  firstAttemptAt: number,
): boolean {
  return nextAttemptAt > firstAttemptAt + RETRY_HORIZON_SEC * 1000;
}

/**
 * boot 重建用：从组内日志派生真实 firstAttemptAt（#322 / 硬要求①）。
 * 优先取 attempt===1 行最早 ts（enqueue 时与 job.firstAttemptAt 同墙钟孪生）；
 * 若组内无 attempt=1 行 → 回落 latest.ts（须在完工报明说；禁止静默改用 eventCreatedAt）。
 */
export function deriveFirstAttemptAtMsFromGroup(
  groupRows: ReadonlyArray<Pick<WebhookDeliveryLogRow, 'attempt' | 'ts'>>,
  latest: Pick<WebhookDeliveryLogRow, 'ts'>,
): number {
  let earliest: number | undefined;
  for (const row of groupRows) {
    if (row.attempt !== 1) continue;
    const ms = Date.parse(row.ts);
    if (!Number.isFinite(ms)) continue;
    if (earliest === undefined || ms < earliest) earliest = ms;
  }
  if (earliest !== undefined) return earliest;
  const fallback = Date.parse(latest.ts);
  return Number.isFinite(fallback) ? fallback : Date.now();
}

/** Effective attempt cap for this event type: ping is 3, others follow WEBHOOK_MAX_ATTEMPTS. */
export function maxAttemptsForEventType(type: WebhookEventType): number {
  if (type === 'webhook.ping') return MAX_PING_ATTEMPTS;
  return Math.min(config.webhooks.maxAttempts, MAX_RETRY_SCHEDULE_ATTEMPTS);
}

/**
 * §8.6 step 3: a latest row is final if success/permanent/refused, or a *completed*
 * retryable at the event type's actual cap. A pending row is never final.
 */
export function isTerminalDeliveryRow(
  row: Pick<WebhookDeliveryLogRow, 'outcome' | 'attempt' | 'type'>,
): boolean {
  if (row.outcome === 'success' || row.outcome === 'permanent' || row.outcome === 'refused') {
    return true;
  }
  return row.outcome === 'retryable' && row.attempt >= maxAttemptsForEventType(row.type);
}

/**
 * §5.1 / §8.5: creation-ping (and any ping while unverified) is the setup race.
 * A permanent ping (typically 400/401 signature reject) is never counted.
 */
export function countsTowardCircuitBreaker(
  type: WebhookEventType,
  outcome: WebhookDeliveryOutcome,
  sub: Pick<WebhookSubscription, 'state'>,
): boolean {
  if (outcome !== 'retryable' && outcome !== 'permanent') return false;
  if (type === 'webhook.ping') {
    if (sub.state === 'unverified') return false;
    if (outcome === 'permanent') return false;
  }
  return true;
}

/**
 * Parse HTTP Retry-After as delay-seconds. The entire trimmed value must be a
 * base-10 integer in 1..3600; strings like "3600junk" are rejected.
 */
export function parseRetryAfterSeconds(header: string | null | undefined): number | undefined {
  if (header == null) return undefined;
  const trimmed = header.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1 || n > 3600) return undefined;
  return n;
}

/**
 * Calculates next attempt scheduled time with ±10% non-cumulative gap jitter (§8.3).
 * Attempt 11 is pinned to exactly +72h.
 * Returns null if attempts exhausted.
 */
export function calculateNextAttemptTime(
  currentAttempt: number,
  firstAttemptTimeMs: number,
  options?: {
    isPing?: boolean;
    retryAfterSec?: number;
    receivedAtMs?: number;
    maxAttempts?: number;
    randomFn?: () => number;
  },
): number | null {
  const nextAttempt = currentAttempt + 1;
  const isPing = options?.isPing ?? false;
  const maxAttempts = Math.min(
    options?.maxAttempts ?? config.webhooks.maxAttempts,
    isPing ? MAX_PING_ATTEMPTS : MAX_RETRY_SCHEDULE_ATTEMPTS,
  );

  if (nextAttempt > maxAttempts) {
    return null;
  }

  const rand = options?.randomFn ?? Math.random;

  // Attempt 1 is always immediate (offset 0)
  if (nextAttempt === 1) {
    return firstAttemptTimeMs;
  }

  const idx = nextAttempt - 1;

  // Attempt 11 is pinned to exactly +72h unjittered (§8.3)
  if (nextAttempt === 11) {
    return firstAttemptTimeMs + RETRY_SCHEDULE_OFFSETS_SEC[10]! * 1000;
  }

  // If a sane Retry-After header was received on 429 (1s..3600s), clamp into schedule (§8.2)
  if (
    options?.retryAfterSec !== undefined &&
    Number.isInteger(options.retryAfterSec) &&
    options.retryAfterSec >= 1 &&
    options.retryAfterSec <= 3600
  ) {
    const arrivalTimeMs =
      options.receivedAtMs ??
      firstAttemptTimeMs + (RETRY_SCHEDULE_OFFSETS_SEC[currentAttempt - 1] ?? 0) * 1000;
    const scheduledByArrival = arrivalTimeMs + options.retryAfterSec * 1000;
    const baseOffsetSec = RETRY_SCHEDULE_OFFSETS_SEC[idx]!;
    const scheduledByOffset = firstAttemptTimeMs + baseOffsetSec * 1000;
    const nextTime = Math.max(scheduledByArrival, scheduledByOffset);
    return Math.min(nextTime, firstAttemptTimeMs + (RETRY_HORIZON_SEC - 1) * 1000);
  }

  const prevOffset = RETRY_SCHEDULE_OFFSETS_SEC[idx - 1]!;
  const currOffset = RETRY_SCHEDULE_OFFSETS_SEC[idx]!;
  const gap = currOffset - prevOffset;

  // Jitter shifts each attempt by up to ±10% of its own gap
  const jitterFraction = rand() * 0.2 - 0.1; // [-0.1, +0.1]
  const jitterSec = gap * jitterFraction;

  let computedOffset = currOffset + jitterSec;
  // Clamped so offsets stay strictly monotonically increasing and under 72h
  if (computedOffset <= prevOffset) {
    computedOffset = prevOffset + 1;
  }
  if (computedOffset >= RETRY_HORIZON_SEC) {
    computedOffset = RETRY_HORIZON_SEC - 1;
  }

  return firstAttemptTimeMs + Math.round(computedOffset * 1000);
}

// ---------------------------------------------------------------------------
// Durable Log Persistence (webhook-deliveries.jsonl)
// ---------------------------------------------------------------------------

function deliveryLogPath(): string {
  return join(config.dataDir, 'webhook-deliveries.jsonl');
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // best-effort
  }
}

type DeliveryLogIndex = {
  path: string;
  ino: number | null;
  mtimeMs: number;
  size: number;
  rows: WebhookDeliveryLogRow[];
  latestByWebhook: Map<string, WebhookDeliveryLogRow>;
  /** webhook/event/run 组最新行：ts 先（路由 lastDelivery 等） */
  latestByGroup: Map<string, WebhookDeliveryLogRow>;
  /**
   * 活跃判定专用增量 Map：attempt 先、ts 后（= isPreferredActiveGroupRow）。
   * ⚠️ 禁复用 latestByGroup——后者走 isNewerDeliveryRow（ts 先），复用=语义漂移。
   */
  latestForActiveByGroup: Map<string, WebhookDeliveryLogRow>;
  /**
   * 无可逐出态记忆化：完整扫描 dropped===0 后置位；
   * 置位期间 enforce 早退 O(1)，避免活组超限每次全表扫。
   */
  capScanFutile: boolean;
};

function emptyDeliveryLogIndex(path = ''): DeliveryLogIndex {
  return {
    path,
    ino: null,
    mtimeMs: 0,
    size: 0,
    rows: [],
    latestByWebhook: new Map(),
    latestByGroup: new Map(),
    latestForActiveByGroup: new Map(),
    capScanFutile: false,
  };
}

let deliveryLogIndex: DeliveryLogIndex = emptyDeliveryLogIndex();

/** Delivery-log data-read counters (full vs incremental; stats excluded). Production read paths always increment these; tests observe them. */
type DeliveryLogIoStats = {
  fullReads: number;
  incrementalReads: number;
  bytesRead: number;
};

let deliveryLogIoForTests: DeliveryLogIoStats = {
  fullReads: 0,
  incrementalReads: 0,
  bytesRead: 0,
};

/** #217：内存行上限逐出计数（仿 deliveryLogIoForTests；生产只写、测试可读） */
type DeliveryLogRowCapStats = {
  /** 进程内累计从内存视图逐出的行数（盘不动） */
  evictedTotal: number;
  /** warn-once 触发次数（每进程至多 1） */
  warnCount: number;
  /** rebuildIndexMaps 调用次数（滞回批量负控用） */
  rebuilds: number;
  /** enforce 完整扫描次数（R4 活组超限短路负控用；futile 早退不计） */
  scanCount: number;
};

let deliveryLogRowCapForTests: DeliveryLogRowCapStats = {
  evictedTotal: 0,
  warnCount: 0,
  rebuilds: 0,
  scanCount: 0,
};

/** 每进程只打一行逐出 warn */
let deliveryLogRowCapWarned = false;

/** #268：活组超次级上限（10×maxRows）error 级告警，每进程至多一次 */
let deliveryLogActiveOverflowErrored = false;

/** 可采集事件名：活组 alone 压过次级放大上限（不丢活，仅升 error） */
export const DELIVERY_LOG_ACTIVE_OVERFLOW_EVENT = 'delivery_log_active_overflow';

function groupKeyForRow(row: WebhookDeliveryLogRow): string {
  return `${row.webhookId}:${row.eventId}:${row.runId}`;
}

/**
 * compact / 内存逐出共用：组内「最新行」比较——attempt 先、ts 后
 * （与历史 compactDeliveryLog sort 同优先级，不许悄悄换序）。
 */
function isPreferredActiveGroupRow(
  candidate: WebhookDeliveryLogRow,
  incumbent: WebhookDeliveryLogRow,
): boolean {
  if (candidate.attempt !== incumbent.attempt) return candidate.attempt > incumbent.attempt;
  return new Date(candidate.ts).getTime() > new Date(incumbent.ts).getTime();
}

/**
 * 盘冷路径专用（compactDeliveryLog）：组内最新行非终态 → 整组 active。
 * 热路径 enforce 改吃 index.latestForActiveByGroup（增量 O(组数)），勿再每 append 全量分组。
 * 比较器=isPreferredActiveGroupRow（attempt 先），与增量 Map 同优先级。
 */
function computeActiveGroupKeys(rows: WebhookDeliveryLogRow[]): Set<string> {
  const latestByGroup = new Map<string, WebhookDeliveryLogRow>();
  for (const row of rows) {
    const key = groupKeyForRow(row);
    const prev = latestByGroup.get(key);
    if (!prev || isPreferredActiveGroupRow(row, prev)) {
      latestByGroup.set(key, row);
    }
  }
  const activeGroupKeys = new Set<string>();
  for (const [key, latest] of latestByGroup) {
    if (!isTerminalDeliveryRow(latest)) activeGroupKeys.add(key);
  }
  return activeGroupKeys;
}

/** 从增量活跃 Map 派生 active 组键集合——O(组数)，供 enforce 热路径 */
function activeGroupKeysFromIndex(index: DeliveryLogIndex): Set<string> {
  const activeGroupKeys = new Set<string>();
  for (const [key, latest] of index.latestForActiveByGroup) {
    if (!isTerminalDeliveryRow(latest)) activeGroupKeys.add(key);
  }
  return activeGroupKeys;
}

/**
 * 活跃判定专用 upsert：attempt 先、ts 后（= isPreferredActiveGroupRow）。
 * 与 upsertLatestRow / isNewerDeliveryRow（ts 先）刻意分离，防语义漂移。
 */
function upsertActiveGroupLatest(
  map: Map<string, WebhookDeliveryLogRow>,
  key: string,
  row: WebhookDeliveryLogRow,
): void {
  const prev = map.get(key);
  if (!prev || isPreferredActiveGroupRow(row, prev)) map.set(key, row);
}

/**
 * 重建 latestByWebhook / latestByGroup / latestForActiveByGroup。
 * 滞回批量逐出后调用；#268 附带：调用方若仍超 maxRows 须立即钉回 capScanFutile。
 */
function rebuildIndexMaps(index: DeliveryLogIndex): void {
  // 测试钩：统计重建次数（滞回批量逐出负控 (g)）
  deliveryLogRowCapForTests.rebuilds += 1;
  index.latestByWebhook.clear();
  index.latestByGroup.clear();
  index.latestForActiveByGroup.clear();
  for (const row of index.rows) {
    upsertLatestRow(index.latestByWebhook, row.webhookId, row);
    upsertLatestRow(index.latestByGroup, groupKeyForRow(row), row);
    // 活跃 Map 必须走 attempt 先比较器，禁 upsertLatestRow
    upsertActiveGroupLatest(index.latestForActiveByGroup, groupKeyForRow(row), row);
  }
  // 重建后保守清位，由下次 enforce 再判定 futile
  index.capScanFutile = false;
}

/**
 * #217 A 案 + R2 滞回 + R4 增量活跃/futile 短路：内存索引行上限。
 * 只裁 rows+三 Map；不写盘。超限时一次逐出到 floor(maxRows*0.9)；≤上限不触发。
 * active 组行永不逐出；剔光非 active 后仍超上限则宁超不丢活并 warn。
 * 活组 alone 超限（dropped=0）→ 置 capScanFutile，后续 append 早退 O(1)。
 * #268：次级放大上限 = floor(10×maxRows)；仍不丢活，但超次级升 error 级
 * `delivery_log_active_overflow`（warn-once 节流）。
 * #268 附带：滞回 rebuild 后若仍超上限（活组 alone），立即钉回 futile，
 * 避免每次 append 再 O(n) 全表扫（滞回 rebuild I/O 放大）。
 */
function enforceDeliveryLogRowCap(index: DeliveryLogIndex): void {
  const maxRows = config.webhooks.logMaxRows;
  if (index.rows.length <= maxRows) return;
  // R4：无可逐出态记忆化——置位期间早退，避免每 append O(n) 全表扫
  if (index.capScanFutile) {
    // 早退路径仍须检查次级上限（活组持续膨胀）
    noteDeliveryLogActiveOverflowIfNeeded(index.rows.length, maxRows);
    return;
  }

  // 测试钩：完整扫描计数（futile 早退不计）
  deliveryLogRowCapForTests.scanCount += 1;

  // 滞回批量：目标长度 = 上限的 90%，至少保留 1 行（maxRows=1 时 floor(0.9)=0 会剔光最新行）
  const targetLength = Math.max(1, Math.floor(maxRows * 0.9));
  // R4：从增量活跃 Map 派生，O(组数)；禁每 append 调 computeActiveGroupKeys
  const activeGroupKeys = activeGroupKeysFromIndex(index);
  const needEvict = index.rows.length - targetLength;
  const drop = new Set<number>();
  let dropped = 0;
  // 始终尽量逐出最旧非 active；不得因 activeCount 已超而整表停裁
  for (let i = 0; i < index.rows.length && dropped < needEvict; i++) {
    if (activeGroupKeys.has(groupKeyForRow(index.rows[i]!))) continue;
    drop.add(i);
    dropped++;
  }

  if (dropped > 0) {
    // 前端截断语义：去掉最旧可逐出行，保留剩余行的 append 序
    const kept: WebhookDeliveryLogRow[] = [];
    for (let i = 0; i < index.rows.length; i++) {
      if (!drop.has(i)) kept.push(index.rows[i]!);
    }
    index.rows = kept;
    rebuildIndexMaps(index);
  }

  // 仍超限 ⟺ 活组 alone 已压过上限（无可再丢的终态）
  const stoppedForActiveOverflow = index.rows.length > maxRows;
  if (stoppedForActiveOverflow) {
    // 含：dropped=0 纯活组；以及滞回剔光终态后仍超限。
    // rebuildIndexMaps 会清 futile——此处钉回，堵住后续每 append O(n) 放大。
    index.capScanFutile = true;
  } else if (dropped === 0) {
    // 完整扫描无可逐出但未超限（理论上达不到：入口已要求 > maxRows）
    index.capScanFutile = true;
  }

  if (dropped > 0 || stoppedForActiveOverflow) {
    noteDeliveryLogRowCapEvent(maxRows, dropped, stoppedForActiveOverflow, targetLength);
  }
  noteDeliveryLogActiveOverflowIfNeeded(index.rows.length, maxRows);
}

/**
 * #268 b 案：总行数超 floor(10×maxRows) 时升 error 级可采集日志；零逐出语义变更。
 * 每进程至多一行（与 warn-once 同节流口径）。
 */
function noteDeliveryLogActiveOverflowIfNeeded(rowCount: number, maxRows: number): void {
  const secondaryCap = Math.floor(maxRows * 10);
  if (rowCount <= secondaryCap) return;
  if (deliveryLogActiveOverflowErrored) return;
  deliveryLogActiveOverflowErrored = true;
  console.error(
    JSON.stringify({
      event: DELIVERY_LOG_ACTIVE_OVERFLOW_EVENT,
      maxRows,
      secondaryCap,
      rows: rowCount,
    }),
  );
}

/** 累计逐出数 + 每进程 warn-once（含上限、滞回目标与累计逐出数） */
function noteDeliveryLogRowCapEvent(
  maxRows: number,
  evictedThisRound: number,
  stoppedForActiveOverflow: boolean,
  targetLength: number,
): void {
  deliveryLogRowCapForTests.evictedTotal += evictedThisRound;
  if (deliveryLogRowCapWarned) return;
  deliveryLogRowCapWarned = true;
  deliveryLogRowCapForTests.warnCount += 1;
  if (stoppedForActiveOverflow) {
    console.warn(
      `[webhooks] delivery-log in-memory index over WEBHOOK_LOG_MAX_ROWS=${maxRows}; ` +
        `active pending-retry rows alone exceed cap — stopping eviction ` +
        `(evictedTotal=${deliveryLogRowCapForTests.evictedTotal}; memory view only)`,
    );
  } else {
    console.warn(
      `[webhooks] delivery-log in-memory index trimmed toward WEBHOOK_LOG_MAX_ROWS=${maxRows} ` +
        `(hysteresis target=${targetLength}); ` +
        `evictedTotal=${deliveryLogRowCapForTests.evictedTotal} (memory view only; disk unchanged)`,
    );
  }
}

function isNewerDeliveryRow(a: WebhookDeliveryLogRow, b: WebhookDeliveryLogRow): boolean {
  const tsA = new Date(a.ts).getTime();
  const tsB = new Date(b.ts).getTime();
  if (tsA !== tsB) return tsA > tsB;
  return a.attempt > b.attempt;
}

function upsertLatestRow(
  map: Map<string, WebhookDeliveryLogRow>,
  key: string,
  row: WebhookDeliveryLogRow,
): void {
  const prev = map.get(key);
  if (!prev || isNewerDeliveryRow(row, prev)) map.set(key, row);
}

function applyRowToIndex(index: DeliveryLogIndex, row: WebhookDeliveryLogRow): void {
  index.rows.push(row);
  upsertLatestRow(index.latestByWebhook, row.webhookId, row);
  upsertLatestRow(index.latestByGroup, groupKeyForRow(row), row);
  // 活跃判定增量维护：attempt 先（禁复用 latestByGroup / isNewerDeliveryRow）
  upsertActiveGroupLatest(index.latestForActiveByGroup, groupKeyForRow(row), row);
  // 终态行=新的可逐出候选 → 清 futile；非终态新行不产生可逐出行，不清位
  if (isTerminalDeliveryRow(row)) {
    index.capScanFutile = false;
  }
}

function parseDeliveryLogText(content: string): WebhookDeliveryLogRow[] {
  const lines = content.split('\n');
  const rows: WebhookDeliveryLogRow[] = [];
  let corruptCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      corruptCount++;
      // 盘文本面 + 对象面均走 scrubPayload 统一发射路径（禁手工直连）
      console.error(
        `[webhooks] corrupted delivery log line ${i + 1} skipped:`,
        scrubPayload(line.slice(0, 100)),
        describeFailureStack(err),
      );
    }
  }

  if (corruptCount > 0) {
    console.error(
      `[webhooks] readAllDeliveryLogRows skipped ${corruptCount} corrupted line(s) in delivery log`,
    );
  }

  return rows;
}

function captureIndexCursor(index: DeliveryLogIndex, path: string): void {
  if (!existsSync(path)) {
    index.path = path;
    index.ino = null;
    index.mtimeMs = 0;
    index.size = 0;
    return;
  }
  const st = statSync(path);
  index.path = path;
  index.ino = st.ino;
  index.mtimeMs = st.mtimeMs;
  index.size = st.size;
}

function adoptDeliveryLogIndex(rows: WebhookDeliveryLogRow[]): void {
  const path = deliveryLogPath();
  const index = emptyDeliveryLogIndex(path);
  for (const row of rows) applyRowToIndex(index, row);
  // 重建后以上限再收敛一次，行为与增量路径一致
  enforceDeliveryLogRowCap(index);
  captureIndexCursor(index, path);
  deliveryLogIndex = index;
}

function rebuildDeliveryLogIndexFromDisk(): DeliveryLogIndex {
  adoptDeliveryLogIndex(readAllDeliveryLogRowsFromDisk());
  return deliveryLogIndex;
}

function ingestIncrementalBytes(index: DeliveryLogIndex, chunk: Buffer): number {
  if (chunk.length === 0) return 0;
  const text = chunk.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return 0;
  const complete = text.slice(0, lastNl + 1);
  for (const line of complete.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      applyRowToIndex(index, JSON.parse(trimmed));
    } catch (err) {
      // 盘文本面 + 对象面均走 scrubPayload 统一发射路径（禁手工直连）
      console.error(
        '[webhooks] corrupted delivery log line skipped during incremental read:',
        scrubPayload(trimmed.slice(0, 100)),
        describeFailureStack(err),
      );
    }
  }
  // 增量 ingest 后收口内存行上限（不写盘）
  enforceDeliveryLogRowCap(index);
  return Buffer.byteLength(complete, 'utf8');
}

function refreshDeliveryLogIndex(): DeliveryLogIndex {
  const path = deliveryLogPath();
  if (!existsSync(path)) {
    deliveryLogIndex = emptyDeliveryLogIndex(path);
    return deliveryLogIndex;
  }
  const st = statSync(path);
  const pathChanged = deliveryLogIndex.path !== path;
  const inodeChanged = deliveryLogIndex.ino !== st.ino;
  const truncated = st.size < deliveryLogIndex.size;
  const rewrittenInPlace =
    st.size === deliveryLogIndex.size &&
    st.mtimeMs !== deliveryLogIndex.mtimeMs &&
    deliveryLogIndex.ino !== null;
  if (pathChanged || inodeChanged || truncated || rewrittenInPlace || deliveryLogIndex.ino === null) {
    return rebuildDeliveryLogIndexFromDisk();
  }
  if (st.size === deliveryLogIndex.size) {
    return deliveryLogIndex;
  }

  const length = st.size - deliveryLogIndex.size;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, deliveryLogIndex.size);
    // Count incremental bytes; the hot path must not reread the whole file.
    deliveryLogIoForTests.incrementalReads += 1;
    deliveryLogIoForTests.bytesRead += n;
    const consumed = ingestIncrementalBytes(deliveryLogIndex, buf.subarray(0, n));
    deliveryLogIndex.size += consumed;
    deliveryLogIndex.mtimeMs = st.mtimeMs;
    deliveryLogIndex.ino = st.ino;
  } finally {
    closeSync(fd);
  }
  return deliveryLogIndex;
}

function syncIndexAfterAppend(row: WebhookDeliveryLogRow, lineBytes: number): void {
  const path = deliveryLogPath();
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (
    deliveryLogIndex.path === path &&
    deliveryLogIndex.ino === st.ino &&
    deliveryLogIndex.size + lineBytes === st.size
  ) {
    applyRowToIndex(deliveryLogIndex, row);
    // append 热路径收口内存行上限
    enforceDeliveryLogRowCap(deliveryLogIndex);
    deliveryLogIndex.size = st.size;
    deliveryLogIndex.mtimeMs = st.mtimeMs;
    return;
  }
  deliveryLogIndex.ino = null;
}

export function resetDeliveryLogIndexForTests(): void {
  deliveryLogIndex = emptyDeliveryLogIndex();
}

export function getDeliveryLogIoForTests(): DeliveryLogIoStats {
  return { ...deliveryLogIoForTests };
}

export function resetDeliveryLogIoForTests(): void {
  deliveryLogIoForTests = { fullReads: 0, incrementalReads: 0, bytesRead: 0 };
}

/** #217：内存行上限逐出统计（测试断言用） */
export function getDeliveryLogRowCapForTests(): DeliveryLogRowCapStats {
  return { ...deliveryLogRowCapForTests };
}

/** #217：重置逐出计数与 warn-once 门闩 */
export function resetDeliveryLogRowCapForTests(): void {
  deliveryLogRowCapForTests = { evictedTotal: 0, warnCount: 0, rebuilds: 0, scanCount: 0 };
  deliveryLogRowCapWarned = false;
  deliveryLogActiveOverflowErrored = false;
}

/** Full-file parse used by boot reconstruction and compaction. */
export function readAllDeliveryLogRowsFromDisk(): WebhookDeliveryLogRow[] {
  const path = deliveryLogPath();
  if (!existsSync(path)) return [];
  // Read bytes once; record disk length without a second UTF-8 walk.
  const buf = readFileSync(path);
  deliveryLogIoForTests.fullReads += 1;
  deliveryLogIoForTests.bytesRead += buf.byteLength;
  return parseDeliveryLogText(buf.toString('utf8'));
}

/**
 * #268 P2-2：盘源逐行流式扫描求 (webhookId, eventId) 的 max run_N。
 * 内存 O(1)，不累积行数组；语义与全量读后 filter+match 逐字一致：
 * 仍扫全盘、仍按 `run_(\d+)` 取最大值。
 * 禁止退回内存截断视图（截断欠数会撞历史 run 号、boot 丢重试链）。
 */
/**
 * 盘源流式求某 webhookId+eventId 的最大 run_N（#268）。
 * 内存 O(1)：64KiB 分块 + StringDecoder 跨 chunk 保多字节 UTF-8；语义等同全盘扫。
 * @param webhookId 目标订阅 id（可含多字节）
 * @param eventId 目标事件 id
 * @param chunkSize 分块字节数；负控可注入小值以逼出跨 chunk 切分
 */
export function scanMaxRunNumFromDisk(
  webhookId: string,
  eventId: string,
  chunkSize = 64 * 1024,
): number {
  const path = deliveryLogPath();
  if (!existsSync(path)) return 0;

  const fd = openSync(path, 'r');
  let maxRunNum = 0;
  let leftover = '';
  let totalBytes = 0;
  const buf = Buffer.alloc(chunkSize);
  // StringDecoder 保留跨 chunk 残缺 UTF-8 字节，避免 toString 换成 U+FFFD
  const decoder = new StringDecoder('utf8');
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, chunkSize, null);
      if (n <= 0) break;
      totalBytes += n;
      const text = leftover + decoder.write(buf.subarray(0, n));
      const lines = text.split('\n');
      // 末段可能是半行，留到下一轮
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        maxRunNum = considerRunNumLine(line, webhookId, eventId, maxRunNum);
      }
    }
    // 冲刷 decoder 内残余码点，再收尾可能无换行的最后一行
    leftover += decoder.end();
    if (leftover.length > 0) {
      maxRunNum = considerRunNumLine(leftover, webhookId, eventId, maxRunNum);
    }
  } finally {
    closeSync(fd);
  }
  // 与全量读同口径计入盘读统计（仍是一次全盘扫描）
  deliveryLogIoForTests.fullReads += 1;
  deliveryLogIoForTests.bytesRead += totalBytes;
  return maxRunNum;
}

/**
 * 流式扫描单行：坏行跳过（与 parseDeliveryLogText fail-open 一致）。
 * 按 run_(\d+) 取最大 runNum；webhookId/eventId 不匹配则忽略。
 */
function considerRunNumLine(
  line: string,
  webhookId: string,
  eventId: string,
  maxRunNum: number,
): number {
  const trimmed = line.trim();
  if (!trimmed) return maxRunNum;
  try {
    const row = JSON.parse(trimmed) as WebhookDeliveryLogRow;
    if (row.webhookId !== webhookId || row.eventId !== eventId) return maxRunNum;
    if (typeof row.runId !== 'string') return maxRunNum;
    const m = row.runId.match(/^run_(\d+)$/);
    if (!m) return maxRunNum;
    return Math.max(maxRunNum, Number.parseInt(m[1]!, 10));
  } catch {
    return maxRunNum;
  }
}

function sanitizeDeliveryLogRow(row: WebhookDeliveryLogRow): WebhookDeliveryLogRow {
  return {
    ts: row.ts,
    webhookId: row.webhookId,
    eventId: row.eventId,
    runId: row.runId,
    deliveryId: row.deliveryId,
    type: row.type,
    address: row.address,
    messageId: row.messageId,
    uidValidity: row.uidValidity,
    rfc822MessageId: row.rfc822MessageId,
    taskId: row.taskId,
    taskCreatedAt: row.taskCreatedAt ?? null,
    expiresInSec: row.expiresInSec ?? row.taskExpiresInSec ?? null,
    taskExpiresInSec: row.taskExpiresInSec ?? row.expiresInSec ?? null,
    eventCreatedAt: row.eventCreatedAt,
    attempt: row.attempt,
    outcome: row.outcome,
    status: row.status,
    durationMs: row.durationMs,
    sensitive: row.sensitive,
    replay: row.replay,
    nextAttemptAt: row.nextAttemptAt,
    reason: row.reason ?? null,
  };
}

/** Append a single row to DATA_DIR/webhook-deliveries.jsonl (0600 mode). */
export function appendDeliveryLogRow(row: WebhookDeliveryLogRow): void {
  ensureDataDir();
  const path = deliveryLogPath();
  const sanitizedRow = sanitizeDeliveryLogRow(row);
  const line = `${JSON.stringify(sanitizedRow)}\n`;
  const fd = openSync(path, 'a', 0o600);
  try {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
    const buf = Buffer.from(line, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) throw new Error('short_write');
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncIndexAfterAppend(sanitizedRow, Buffer.byteLength(line, 'utf8'));
}

/**
 * Stale / unknown delivery-list cursor → 400 invalid_cursor（#216）。
 * 仿 InvalidSendCursorError：只携带稳定 code，不泄漏内部细节。
 * #270：带 kind（parse_fail vs lookup_miss）供观测 helper 直传。
 */
export class InvalidDeliveryCursorError extends Error {
  readonly code = 'invalid_cursor';
  readonly kind: 'parse_fail' | 'lookup_miss';
  /** lookup_miss 全形态游标的时间戳（ms）；bare_id 无 ts */
  readonly cursorTs?: number;
  constructor(kind: 'parse_fail' | 'lookup_miss' = 'parse_fail', cursorTs?: number) {
    super('invalid_cursor');
    this.name = 'InvalidDeliveryCursorError';
    this.kind = kind;
    if (cursorTs !== undefined) this.cursorTs = cursorTs;
  }
}

/** deliveries 游标 query 硬限（对齐 send/tasks/ui 族 1024）。 */
export const DELIVERIES_CURSOR_MAX_LENGTH = 1024;

/** 生产可生成的 deliveryId：dlv_ + 规范 UUID（8-4-4-4-12）。 */
const DELIVERY_ID_RE =
  /^dlv_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** attempt 规范十进制：无前导零、≥1（生产 Number 序列化）。 */
const DELIVERY_ATTEMPT_RE = /^[1-9]\d*$/;
/** ts 必须是 toISOString 完整形（含毫秒与 Z）；Date.parse 可解的残缺串一律拒。 */
const DELIVERY_ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ParsedDeliveryListCursor =
  | { form: 'full'; deliveryId: string; attempt: number; ts: string; cursorTs: number }
  | { form: 'bare_id'; deliveryId: string };

/**
 * 解析 deliveries 列表游标；非生产可生成域 → parse_fail。
 * 全形态 = deliveryId|attempt|ts；裸 id = 仅 deliveryId。
 */
export function parseDeliveryListCursor(cursor: string): ParsedDeliveryListCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new InvalidDeliveryCursorError('parse_fail');
  }
  if (cursor.length > DELIVERIES_CURSOR_MAX_LENGTH) {
    throw new InvalidDeliveryCursorError('parse_fail');
  }
  const pipe = cursor.indexOf('|');
  if (pipe < 0) {
    if (!DELIVERY_ID_RE.test(cursor)) throw new InvalidDeliveryCursorError('parse_fail');
    return { form: 'bare_id', deliveryId: cursor };
  }
  const deliveryId = cursor.slice(0, pipe);
  const rest = cursor.slice(pipe + 1);
  const pipe2 = rest.indexOf('|');
  if (pipe2 < 0) throw new InvalidDeliveryCursorError('parse_fail');
  const attemptRaw = rest.slice(0, pipe2);
  const ts = rest.slice(pipe2 + 1);
  if (!DELIVERY_ID_RE.test(deliveryId)) throw new InvalidDeliveryCursorError('parse_fail');
  if (!DELIVERY_ATTEMPT_RE.test(attemptRaw)) throw new InvalidDeliveryCursorError('parse_fail');
  if (!DELIVERY_ISO_TS_RE.test(ts)) throw new InvalidDeliveryCursorError('parse_fail');
  const attempt = Number(attemptRaw);
  // 309+ 位纯数字经 Number()→Infinity，不得当合法 full cursor 进查找（会误记 stale）
  if (!Number.isSafeInteger(attempt)) throw new InvalidDeliveryCursorError('parse_fail');
  const cursorTs = Date.parse(ts);
  if (!Number.isFinite(cursorTs)) throw new InvalidDeliveryCursorError('parse_fail');
  // 日历无效值（如 2024-02-30）会被 Date.parse 归一化；round-trip 钉死生产 toISOString 域
  if (new Date(ts).toISOString() !== ts) throw new InvalidDeliveryCursorError('parse_fail');
  return { form: 'full', deliveryId, attempt, ts, cursorTs };
}

/**
 * Reads all delivery log rows, parsing only bytes appended since the last
 * cursor (offset + mtime/inode). Compaction rename rebuilds the index.
 *
 * Semantic distinction:
 * - Webhook configuration store (`webhooks.json`): fail-closed on read.
 * - Webhook delivery log (`webhook-deliveries.jsonl`): append-only event log.
 *   Writes are fail-closed (atomic fsync append), but reads fail open:
 *   corrupted or partial lines are skipped so a single bad line does not crash
 *   the API on startup or cause 500s across read endpoints.
 *   Cursor miss is an explicit rejection (400 invalid_cursor), not fail-open
 *   rewind to page 1 (#216).
 */
export function readAllDeliveryLogRows(): WebhookDeliveryLogRow[] {
  return refreshDeliveryLogIndex().rows.slice();
}

/**
 * Filtered reader for GET /v1/webhooks/:id/deliveries.
 * Returns newest rows first.
 * 列表读只吃增量内存索引，过滤/排序/游标语义保持不变。
 * 提供 cursor 且双匹配均 miss 时抛 InvalidDeliveryCursorError（#216）。
 */
export function readDeliveryLogRows(options?: {
  webhookId?: string;
  limit?: number;
  cursor?: string;
}): { deliveries: WebhookDeliveryLogRow[]; nextCursor?: string } {
  // 数据源切到索引 rows；无 webhookId 时复制后再 sort，避免打乱索引内部顺序
  const all = refreshDeliveryLogIndex().rows;
  let filtered = options?.webhookId
    ? all.filter((r) => r.webhookId === options.webhookId)
    : all.slice();

  // Sort newest first by ts, tie-break by attempt desc
  filtered.sort((a, b) => {
    const tA = new Date(a.ts).getTime();
    const tB = new Date(b.ts).getTime();
    if (tA !== tB) return tB - tA;
    return b.attempt - a.attempt;
  });

  const limit = Math.min(Math.max(1, options?.limit ?? 20), 100);
  let startIndex = 0;

  if (options?.cursor) {
    // #270：先规范解析（非生产可生成域 → parse_fail），再双匹配；均 miss → lookup_miss
    const parsed = parseDeliveryListCursor(options.cursor);
    const idx = filtered.findIndex((r) => {
      if (parsed.form === 'bare_id') return r.deliveryId === parsed.deliveryId;
      return (
        r.deliveryId === parsed.deliveryId &&
        r.attempt === parsed.attempt &&
        r.ts === parsed.ts
      );
    });
    if (idx < 0) {
      throw new InvalidDeliveryCursorError(
        'lookup_miss',
        parsed.form === 'full' ? parsed.cursorTs : undefined,
      );
    }
    startIndex = idx + 1;
  }

  const paged = filtered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < filtered.length;
  const nextCursor =
    hasMore && paged.length > 0 ? deliveryRowCursor(paged[paged.length - 1]!) : undefined;

  return { deliveries: paged, nextCursor };
}

function deliveryRowCursor(row: WebhookDeliveryLogRow): string {
  return `${row.deliveryId}|${row.attempt}|${row.ts}`;
}

function latestRowForDeliveryId(
  rows: WebhookDeliveryLogRow[],
  deliveryId: string,
): WebhookDeliveryLogRow | undefined {
  let latest: WebhookDeliveryLogRow | undefined;
  for (const row of rows) {
    if (row.deliveryId !== deliveryId) continue;
    if (!latest || isNewerDeliveryRow(row, latest)) latest = row;
  }
  return latest;
}

/** Latest attempt per webhook from an already-read log (one parse per request). */
export function latestDeliveryByWebhookId(
  rows: WebhookDeliveryLogRow[],
): Map<string, WebhookDeliveryLogRow> {
  const latest = new Map<string, WebhookDeliveryLogRow>();
  for (const row of rows) {
    const prev = latest.get(row.webhookId);
    if (!prev) {
      latest.set(row.webhookId, row);
      continue;
    }
    const ts = new Date(row.ts).getTime();
    const prevTs = new Date(prev.ts).getTime();
    if (ts > prevTs || (ts === prevTs && row.attempt > prev.attempt)) {
      latest.set(row.webhookId, row);
    }
  }
  return latest;
}

/** Returns the latest delivery attempt for an endpoint, if any. */
export function getLatestDeliveryForWebhook(webhookId: string): WebhookDeliveryLogRow | null {
  return refreshDeliveryLogIndex().latestByWebhook.get(webhookId) ?? null;
}

/**
 * #217：列表/详情/更新端点用的 webhookId→最新行批量视图。
 * 返回索引 Map 的浅拷贝，禁止路由层直接摸模块内变量。
 */
export function getLatestDeliveryByWebhookMap(): Map<string, WebhookDeliveryLogRow> {
  return new Map(refreshDeliveryLogIndex().latestByWebhook);
}

/**
 * Compaction: prune rows older than retention days, preserving pending sequences.
 */
export function compactDeliveryLog(
  now = Date.now(),
  retentionDays = config.webhooks.logRetentionDays,
): void {
  const path = deliveryLogPath();
  if (!existsSync(path)) return;

  const rows = readAllDeliveryLogRowsFromDisk();
  const retentionCutoff = now - retentionDays * 86400000;

  // 盘冷路径：全量分组求 active（热路径 enforce 吃增量 Map，此处保留一处真相比较器）
  const activeGroupKeys = computeActiveGroupKeys(rows);

  const retainedRows = rows.filter((row) => {
    const key = groupKeyForRow(row);
    if (activeGroupKeys.has(key)) return true;
    return new Date(row.ts).getTime() > retentionCutoff;
  });

  if (retainedRows.length === rows.length) return;

  const tmpPath = `${path}.tmp.${Date.now()}`;
  const lines = retainedRows.map((r) => JSON.stringify(r)).join('\n') + (retainedRows.length ? '\n' : '');

  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    const buf = Buffer.from(lines, 'utf8');
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) throw new Error('short_write');
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // best effort
  }

  renameSync(tmpPath, path);

  // fsync parent directory (matching webhook-store.ts writeStore)
  try {
    const dirFd = openSync(config.dataDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // best effort
  }

  adoptDeliveryLogIndex(retainedRows);
}

let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;

export function startWebhookMaintenance(): void {
  stopWebhookMaintenance();
  const tick = () => {
    try {
      compactDeliveryLog();
      compactIdempotencyKeys(config.webhooks.logRetentionDays);
    } catch (err) {
      console.error('[webhooks] maintenance failed:', describeFailureStack(err));
    }
  };
  tick();
  const schedule = () => {
    const d = new Date();
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const delay = Math.max(1_000, next - Date.now());
    maintenanceTimer = setTimeout(() => {
      tick();
      schedule();
    }, delay);
    maintenanceTimer.unref?.();
  };
  schedule();
}

export function stopWebhookMaintenance(): void {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = undefined;
  }
}

// ---------------------------------------------------------------------------
// URL Validation (§9.3, §9.5)
// ---------------------------------------------------------------------------

/**
 * Static validation of webhook URL before persistence (§9.5).
 */
/**
 * #289 白名单：可写入调用方响应 `details` 的 URL 拒绝 reason（前 8 条）。
 * 排除 `http_target_must_be_private` / `dns_empty` / `dns_lookup_failed` /
 * `ssrf_blocked_ip`——仅进服务端日志，响应逐字节同现状。
 */
export const WEBHOOK_URL_REJECT_DETAILS_WHITELIST = [
  'malformed_url',
  'unsupported_protocol',
  'http_requires_private_targets',
  'userinfo_forbidden',
  'query_string_forbidden',
  'fragment_forbidden',
  'port_not_allowed',
  'ip_literal_forbidden',
] as const;

export type WebhookUrlRejectDetailsReason =
  (typeof WEBHOOK_URL_REJECT_DETAILS_WHITELIST)[number];

const WEBHOOK_URL_REJECT_DETAILS_SET: ReadonlySet<string> = new Set(
  WEBHOOK_URL_REJECT_DETAILS_WHITELIST,
);

/** 判断 reason 是否允许出现在调用方 `details` 字段。 */
export function isWebhookUrlRejectDetailsWhitelisted(reason: string): boolean {
  return WEBHOOK_URL_REJECT_DETAILS_SET.has(reason);
}

/**
 * 构造 URL 拒绝响应体：白名单内附 `details:'<reason>'`；白名单外仅粗码。
 * `error` 值与改前逐字节一致。
 */
export function webhookUrlRejectionResponseBody(
  code: 'invalid_webhook_url' | 'webhook_target_forbidden',
  reason: string,
): { error: 'invalid_webhook_url' | 'webhook_target_forbidden'; details?: string } {
  const error: 'invalid_webhook_url' | 'webhook_target_forbidden' =
    code === 'webhook_target_forbidden' ? 'webhook_target_forbidden' : 'invalid_webhook_url';
  if (isWebhookUrlRejectDetailsWhitelisted(reason)) {
    return { error, details: reason };
  }
  return { error };
}

/**
 * 拒绝点无条件日志（#289 B）：单行 JSON；不含 URL 原文/查询/用户信息。
 * reason 为机器码，不得回显用户可控子串。
 */
export function logWebhookUrlRejected(fields: {
  reason: string;
  address: string;
  webhookId?: string;
}): void {
  console.warn(
    JSON.stringify({
      kind: 'webhook_url_rejected',
      reason: fields.reason,
      address: fields.address,
      ...(fields.webhookId ? { webhookId: fields.webhookId } : {}),
    }),
  );
}

export function validateWebhookUrlStatic(
  urlStr: string,
  opts?: {
    allowPrivateTargets?: boolean;
    allowedPorts?: number[];
  },
): { valid: true; parsedUrl: URL } | { valid: false; code: 'invalid_webhook_url'; error: string } {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { valid: false, code: 'invalid_webhook_url', error: 'malformed_url' };
  }

  const allowPrivate = opts?.allowPrivateTargets ?? config.webhooks.allowPrivateTargets;

  // Protocol: https required; http permitted only when allowPrivateTargets is true
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { valid: false, code: 'invalid_webhook_url', error: 'unsupported_protocol' };
  }
  if (url.protocol === 'http:' && !allowPrivate) {
    return { valid: false, code: 'invalid_webhook_url', error: 'http_requires_private_targets' };
  }

  // No userinfo
  if (url.username || url.password) {
    return { valid: false, code: 'invalid_webhook_url', error: 'userinfo_forbidden' };
  }

  // No query string
  if (url.search) {
    return { valid: false, code: 'invalid_webhook_url', error: 'query_string_forbidden' };
  }

  // No fragment
  if (url.hash) {
    return { valid: false, code: 'invalid_webhook_url', error: 'fragment_forbidden' };
  }

  // Port in WEBHOOK_ALLOWED_PORTS — no implicit 80 for private http (§9.5)
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  const allowedPorts = opts?.allowedPorts ?? config.webhooks.allowedPorts;
  if (!allowedPorts.includes(port)) {
    return { valid: false, code: 'invalid_webhook_url', error: 'port_not_allowed' };
  }

  // Hostname must be a DNS name, not an IP literal unless allowPrivateTargets
  const literal = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(literal) !== 0 && !allowPrivate) {
    return { valid: false, code: 'invalid_webhook_url', error: 'ip_literal_forbidden' };
  }

  return { valid: true, parsedUrl: url };
}

/**
 * Resolution validation of webhook URL before persistence or on update (§9.3, §9.5, §10.4 Rule C).
 */
export const WEBHOOK_URL_DNS_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns_lookup_timeout')), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function validateWebhookUrlResolution(
  urlStr: string,
  opts: {
    allowPrivateTargets: boolean;
    dnsLookup?: DnsLookup;
    allowedPorts?: number[];
    dnsLookupTimeoutMs?: number;
  },
): Promise<
  | { valid: true; isPrivateTarget: boolean; parsedUrl: URL }
  | { valid: false; code: 'invalid_webhook_url' | 'webhook_target_forbidden'; error: string }
> {
  const staticRes = validateWebhookUrlStatic(urlStr, {
    allowPrivateTargets: opts.allowPrivateTargets,
    allowedPorts: opts.allowedPorts,
  });
  if (!staticRes.valid) return staticRes;

  const url = staticRes.parsedUrl;
  const literal = url.hostname.replace(/^\[(.+)\]$/, '$1');
  const isIpLiteral = isIP(literal) !== 0;
  const dnsLookup = opts.dnsLookup ?? customDnsLookupForTests ?? defaultDnsLookup;

  const publicEdge = !opts.allowPrivateTargets || config.oaePublicEdge;

  let resolvedAddresses: string[] = [];

  if (isIpLiteral) {
    resolvedAddresses = [literal];
  } else {
    try {
      const list = await withTimeout(
        dnsLookup(literal),
        opts.dnsLookupTimeoutMs ?? WEBHOOK_URL_DNS_TIMEOUT_MS,
      );
      if (list.length === 0) {
        return { valid: false, code: 'invalid_webhook_url', error: 'dns_empty' };
      }
      resolvedAddresses = list.map((r) => r.address);
    } catch {
      return { valid: false, code: 'invalid_webhook_url', error: 'dns_lookup_failed' };
    }
  }

  // 1. Check always-blocked SSRF
  for (const ip of resolvedAddresses) {
    if (isBlockedSsrfIp(ip)) {
      return { valid: false, code: 'webhook_target_forbidden', error: 'ssrf_blocked_ip' };
    }
    if (isSsrfBlockedResolvedIp(ip, { publicEdge })) {
      return { valid: false, code: 'webhook_target_forbidden', error: 'ssrf_blocked_ip' };
    }
  }

  // 2. If scheme is http, additionally require that every address resolves private (§9.3 step 5)
  if (url.protocol === 'http:') {
    const allPrivate = resolvedAddresses.every((ip) => isPrivateOrLoopbackHostname(ip));
    if (!allPrivate) {
      return {
        valid: false,
        code: 'webhook_target_forbidden',
        error: 'http_target_must_be_private',
      };
    }
  }

  const isPrivateTarget = resolvedAddresses.some((ip) => isPrivateOrLoopbackHostname(ip));
  return { valid: true, isPrivateTarget, parsedUrl: url };
}

// ---------------------------------------------------------------------------
// Payload Formatting and Bounding (§6.1 – §6.6)
// ---------------------------------------------------------------------------

function getJsonDepth(val: unknown, current = 1): number {
  if (val === null || typeof val !== 'object') return current;
  let max = current;
  if (Array.isArray(val)) {
    for (const item of val) {
      max = Math.max(max, getJsonDepth(item, current + 1));
    }
  } else {
    for (const key of Object.keys(val as Record<string, unknown>)) {
      max = Math.max(max, getJsonDepth((val as Record<string, unknown>)[key], current + 1));
    }
  }
  return max;
}

export function formatMailPayload(
  sub: WebhookSubscription,
  envelope: WebhookEnvelopeBase,
  input: MailEventInput,
): { body: string; sensitive: boolean } {
  const sensitive = sub.contentScope === 'preview';
  const isPreview = sub.contentScope === 'preview';

  // Base data object
  const data: Record<string, unknown> = {
    object: 'mail',
    address: input.address,
    messageId: input.messageId,
    cursor: encodeMailForwardCursor(
      {
        folder: 'inbox',
        address: input.address,
        t: new Date(input.receivedAt).getTime(),
        uid: input.uid,
        uidValidity: input.uidValidity !== null ? String(input.uidValidity) : '0',
      },
      config.taskSigningSecret,
    ),
    uid: input.uid,
    uidValidity: input.uidValidity,
    receivedAt: input.receivedAt,
    from: {
      address: truncateUtf8String(
        input.from.address,
        (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES,
      ),
      ...(input.from.name
        ? {
            name: truncateUtf8String(
              input.from.name,
              (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES,
            ),
          }
        : {}),
    },
    to: input.to.map((a) =>
      truncateUtf8String(
        a,
        (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES,
      ),
    ),
    cc: input.cc.map((a) =>
      truncateUtf8String(
        a,
        (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES,
      ),
    ),
    subject: truncateUtf8String(
      input.subject,
      (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES,
    ),
    sizeBytes: input.sizeBytes,
    hasAttachments: input.hasAttachments,
    unread: input.unread,
    containsSecurityCode: input.containsSecurityCode,
    containsLink: input.containsLink,
  };

  if (isPreview) {
    if (input.textPreview !== undefined) {
      data.textPreview = truncateUtf8Codepoints(
        input.textPreview,
        (config.webhooks as any)?.bodyPreviewChars ?? WEBHOOK_BODY_PREVIEW_CHARS,
      );
    }
    if (input.securityCodes !== undefined) {
      data.securityCodes = input.securityCodes
        .slice(0, (config.webhooks as any)?.maxCodeItems ?? WEBHOOK_MAX_CODE_ITEMS)
        .map((c) =>
          truncateUtf8Codepoints(
            c,
            (config.webhooks as any)?.codeEntryChars ?? WEBHOOK_CODE_ENTRY_CHARS,
          ),
        );
    }
    if (input.links !== undefined) {
      // Over-long links (> webhookCodeEntryChars) are dropped whole, never truncated (§6.2, §6.6)
      const codeChars = (config.webhooks as any)?.codeEntryChars ?? WEBHOOK_CODE_ENTRY_CHARS;
      data.links = input.links
        .filter((l) => [...l].length <= codeChars)
        .slice(0, (config.webhooks as any)?.maxCodeItems ?? WEBHOOK_MAX_CODE_ITEMS);
    }
  }

  const payload: Record<string, unknown> = {
    ...envelope,
    data,
  };

  const fits = () =>
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= config.webhooks.payloadMaxBytes;
  if (fits()) {
    return { body: JSON.stringify(payload), sensitive };
  }

  // Overflow drop order (§6.6):
  // 1. preview scope: links -> securityCodes -> textPreview
  if (isPreview) {
    if (data.links !== undefined) {
      delete data.links;
      if (fits()) return { body: JSON.stringify(payload), sensitive };
    }
    if (data.securityCodes !== undefined) {
      delete data.securityCodes;
      if (fits()) return { body: JSON.stringify(payload), sensitive };
    }
    if (data.textPreview !== undefined) {
      delete data.textPreview;
      if (fits()) return { body: JSON.stringify(payload), sensitive };
    }
  }

  // 2. both scopes: cc -> to -> subject -> from.name
  if (Array.isArray(data.cc) && (data.cc as unknown[]).length > 0) {
    data.cc = [];
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }
  if (Array.isArray(data.to) && (data.to as unknown[]).length > 0) {
    data.to = [];
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }
  if (typeof data.subject === 'string' && data.subject.length > 0) {
    data.subject = '';
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }
  const fromObj = data.from as { address: string; name?: string } | undefined;
  if (fromObj && fromObj.name !== undefined) {
    delete fromObj.name;
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }

  // If still does not fit, delivery fails closed (§6.6)
  throw new Error('payload_too_large');
}

export function formatApprovalPayload(
  sub: WebhookSubscription,
  envelope: WebhookEnvelopeBase,
  input: ApprovalEventInput,
): { body: string; sensitive: boolean } {
  const sensitive = sub.contentScope === 'preview';
  const isPreview = sub.contentScope === 'preview';

  const metaFieldMaxBytes =
    (config.webhooks as any)?.metaFieldMaxBytes ?? WEBHOOK_META_FIELD_MAX_BYTES;

  const data: Record<string, unknown> = {
    object: 'approval',
    taskId: input.taskId,
    taskState: 'input-required',
    from: truncateUtf8String(input.from, metaFieldMaxBytes),
    to: truncateUtf8String(input.to, metaFieldMaxBytes),
    reviewer: truncateUtf8String(input.reviewer, metaFieldMaxBytes),
    subject: truncateUtf8String(input.subject, metaFieldMaxBytes),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    expiresInSec: input.expiresInSec,
    digest: input.digest,
    actionType: truncateUtf8String(input.actionType, metaFieldMaxBytes),
    actionName: truncateUtf8String(input.actionName, metaFieldMaxBytes),
  };

  if (isPreview && input.actionArguments !== undefined) {
    const depth = getJsonDepth(input.actionArguments);
    if (
      depth <= config.webhooks.approvalArgsMaxDepth &&
      config.webhooks.approvalArgsMaxBytes > 0
    ) {
      try {
        const serialized = JSON.stringify(input.actionArguments);
        if (Buffer.byteLength(serialized, 'utf8') <= config.webhooks.approvalArgsMaxBytes) {
          data.actionArguments = input.actionArguments;
        }
      } catch {
        // drop if serializing throws
      }
    }
  }

  const payload: Record<string, unknown> = {
    ...envelope,
    data,
  };

  const fits = () =>
    Buffer.byteLength(JSON.stringify(payload), 'utf8') <= config.webhooks.payloadMaxBytes;
  if (fits()) {
    return { body: JSON.stringify(payload), sensitive };
  }

  // Overflow drop order (§6.6 for approval.requested):
  // 1. preview scope: actionArguments first (dropped whole)
  if (isPreview && data.actionArguments !== undefined) {
    delete data.actionArguments;
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }

  // 2. both scopes: subject
  if (typeof data.subject === 'string' && data.subject.length > 0) {
    data.subject = '';
    if (fits()) return { body: JSON.stringify(payload), sensitive };
  }

  // If still does not fit, fail closed
  throw new Error('payload_too_large');
}

export function formatPingPayload(
  envelope: WebhookEnvelopeBase,
  webhookId: string,
  trigger: 'creation' | 'test',
): { body: string; sensitive: boolean } {
  const payload = {
    ...envelope,
    data: {
      object: 'webhook',
      webhookId,
      trigger,
    },
  };
  return { body: JSON.stringify(payload), sensitive: false };
}

// ---------------------------------------------------------------------------
// Egress & Pinned Fetch Wrapper (§9.1, §9.3)
// ---------------------------------------------------------------------------

export type WebhookFetchResult = {
  status: number | null;
  outcome: WebhookDeliveryOutcome;
  durationMs: number;
  reason: string | null;
};

/**
 * Executes a single delivery attempt against the target URL with SSRF pinning.
 */
export async function executeWebhookAttempt(
  subscription: WebhookSubscription,
  rawBody: string,
  eventType: WebhookEventType,
  deliveryId: string,
  options?: {
    dnsLookup?: DnsLookup;
    overrideUrl?: string;
  },
): Promise<WebhookFetchResult> {
  const start = Date.now();
  const targetUrl = options?.overrideUrl ?? subscription.url;
  const url = new URL(targetUrl);

  const t = Math.floor(Date.now() / 1000);
  const signatureResult = buildWebhookSignatureHeader({
    rootSecret: config.webhooks.signingSecret || config.taskSigningSecret,
    previousRootSecret: config.webhooks.signingSecretPrevious,
    webhookId: subscription.id,
    epoch: subscription.epoch,
    overlapUntil: subscription.overlapUntil,
    timestampSec: t,
    rawBody,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'openagentemail-webhooks/1',
    'X-OAE-Event': eventType,
    'X-OAE-Delivery': deliveryId,
    'X-OAE-Signature': signatureResult.headerValue,
  };

  // Rule C: private targets require both global escape hatch and per-subscription grant (§10.4 Rule C)
  const isPrivateTargetAllowed =
    config.webhooks.allowPrivateTargets &&
    !config.oaePublicEdge &&
    subscription.privateTargetGranted === true;

  // SSRF publicEdge option: true when private targets are blocked for this delivery
  const publicEdge = !isPrivateTargetAllowed;

  // Custom DNS lookup to enforce §9.3 step 5 for http targets
  const baseDnsLookup = options?.dnsLookup ?? customDnsLookupForTests ?? defaultDnsLookup;
  const deliveryDnsLookup: DnsLookup = async (hostname) => {
    const list = await baseDnsLookup(hostname);
    if (url.protocol === 'http:') {
      for (const r of list) {
        if (!isPrivateOrLoopbackHostname(r.address)) {
          throw Object.assign(new Error('ssrf_blocked_ip'), { code: 'EACCES' });
        }
      }
    }
    return list;
  };

  // Pre-check for IP literal on http targets
  const literal = url.hostname.replace(/^\[(.+)\]$/, '$1');
  if (isIP(literal) !== 0 && url.protocol === 'http:' && !isPrivateOrLoopbackHostname(literal)) {
    const durationMs = Date.now() - start;
    return { status: null, outcome: 'refused', durationMs, reason: 'ssrf_refused' };
  }

  const fetchOpts: PinnedFetchOptions = {
    method: 'POST',
    headers,
    body: rawBody,
    maxBytes: config.webhooks.responseMaxBytes,
    timeoutMs: config.webhooks.deliveryTimeoutMs,
    deadlineMs: config.webhooks.deliveryTimeoutMs,
    dnsLookup: deliveryDnsLookup,
    ssrfOptions: { publicEdge },
  };

  try {
    const response = await pinnedFetch(targetUrl, fetchOpts);
    const durationMs = Date.now() - start;
    const status = response.status;

    if (status >= 200 && status < 300) {
      return { status, outcome: 'success', durationMs, reason: null };
    }

    if (status >= 300 && status < 400) {
      // 3xx redirects are permanent failures (§8.2, §9.4)
      return { status, outcome: 'permanent', durationMs, reason: 'redirect_forbidden' };
    }

    if (status === 408 || status === 429 || status >= 500) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
      return {
        status,
        outcome: 'retryable',
        durationMs,
        reason: status === 429 ? (retryAfter ? `rate_limited_retry_after_${retryAfter}` : 'rate_limited') : 'server_error',
      };
    }

    // Any other 4xx is permanent
    return { status, outcome: 'permanent', durationMs, reason: `http_${status}` };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);

    if (msg === 'ssrf_blocked_ip') {
      return { status: null, outcome: 'refused', durationMs, reason: 'ssrf_refused' };
    }
    if (msg === 'redirect_forbidden') {
      return { status: null, outcome: 'permanent', durationMs, reason: 'redirect_forbidden' };
    }
    if (msg === 'timeout' || msg === 'deadline_exceeded') {
      return { status: null, outcome: 'retryable', durationMs, reason: 'timeout' };
    }
    if (msg === 'response_too_large') {
      return { status: null, outcome: 'permanent', durationMs, reason: 'response_too_large' };
    }
    if (err?.code === 'ENOTFOUND' || msg === 'dns_empty') {
      return { status: null, outcome: 'retryable', durationMs, reason: 'dns_error' };
    }
    if (err?.code === 'ECONNREFUSED') {
      return { status: null, outcome: 'retryable', durationMs, reason: 'connection_refused' };
    }
    if (err?.code?.startsWith?.('ERR_TLS_') || msg.includes('SSL') || msg.includes('TLS')) {
      return { status: null, outcome: 'retryable', durationMs, reason: 'tls_error' };
    }

    return { status: null, outcome: 'retryable', durationMs, reason: msg || 'network_error' };
  }
}

// ---------------------------------------------------------------------------
// Rate Limiting & Concurrency Manager (§8.7)
// ---------------------------------------------------------------------------

class WebhookDeliveryLimiter {
  private activePerEndpoint = new Set<string>();
  private activeTotal = 0;
  private deliverLimiters = new Map<string, number[]>();
  private testProbeLimiters = new Map<string, number[]>();
  private createLimiters = new Map<string, number[]>();
  private rotateLimiters = new Map<string, number[]>();
  private readLimiters = new Map<string, number[]>();

  getActiveTotal(): number {
    return this.activeTotal;
  }

  isEndpointActive(webhookId: string): boolean {
    return this.activePerEndpoint.has(webhookId);
  }

  acquireSlot(webhookId: string): boolean {
    if (this.activeTotal >= config.webhooks.maxConcurrent) {
      return false;
    }
    if (this.activePerEndpoint.has(webhookId)) {
      return false;
    }
    this.activePerEndpoint.add(webhookId);
    this.activeTotal++;
    return true;
  }

  private slotReleaseListeners = new Set<(webhookId: string) => void>();

  onSlotRelease(listener: (webhookId: string) => void): () => void {
    this.slotReleaseListeners.add(listener);
    return () => this.slotReleaseListeners.delete(listener);
  }

  releaseSlot(webhookId: string): void {
    if (this.activePerEndpoint.delete(webhookId)) {
      this.activeTotal = Math.max(0, this.activeTotal - 1);
      for (const listener of this.slotReleaseListeners) {
        try {
          listener(webhookId);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  checkDeliverRate(webhookId: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    return slidingWindowCheck(
      this.deliverLimiters,
      webhookId,
      config.webhooks.rateDeliverPerMin,
      60_000,
      now,
    );
  }

  checkTestProbeRate(tokenKey: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    return slidingWindowCheck(
      this.testProbeLimiters,
      tokenKey,
      config.webhooks.rateTestPerMin,
      60_000,
      now,
    );
  }

  checkCreateRate(tokenKey: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    return slidingWindowCheck(
      this.createLimiters,
      tokenKey,
      config.webhooks.rateCreatePerMin,
      60_000,
      now,
    );
  }

  /** Independent rotate bucket, sized like the test-probe limit. */
  checkRotateRate(tokenKey: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    return slidingWindowCheck(
      this.rotateLimiters,
      tokenKey,
      config.webhooks.rateTestPerMin,
      60_000,
      now,
    );
  }

  /** Independent GET bucket, sized like create. */
  checkReadRate(tokenKey: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    return slidingWindowCheck(
      this.readLimiters,
      tokenKey,
      config.webhooks.rateCreatePerMin,
      60_000,
      now,
    );
  }

  reset(): void {
    this.activePerEndpoint.clear();
    this.activeTotal = 0;
    this.deliverLimiters.clear();
    this.testProbeLimiters.clear();
    this.createLimiters.clear();
    this.rotateLimiters.clear();
    this.readLimiters.clear();
  }
}

export const deliveryLimiter = new WebhookDeliveryLimiter();

// ---------------------------------------------------------------------------
// Delivery Task & Queue Engine
// ---------------------------------------------------------------------------

export type ScheduledDeliveryJob = {
  webhookId: string;
  eventId: string;
  runId: string;
  deliveryId: string;
  type: WebhookEventType;
  payloadBuilder: (currentSub: WebhookSubscription) => { body: string; sensitive: boolean };
  firstAttemptAt: number;
  attempt: number;
  nextAttemptAt: number;
  replay: boolean;
  address: string | null;
  messageId: string | null;
  uidValidity: number | null;
  rfc822MessageId: string | null;
  taskId: string | null;
  taskCreatedAt: string | null;
  expiresInSec: number | null;
  eventCreatedAt: string;
  deferredCount?: number;
  /** When set, executeJob re-checks the shared probe bucket before sending. */
  probeTokenKey?: string;
};

class WebhookDeliveryQueue {
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private jobs = new Map<string, ScheduledDeliveryJob>();

  constructor() {
    deliveryLimiter.onSlotRelease((releasedWebhookId) => {
      this.wakeUpDeferred(releasedWebhookId);
    });
  }

  wakeUpDeferred(webhookId: string): void {
    for (const [key, job] of this.jobs.entries()) {
      if (job.webhookId === webhookId || deliveryLimiter.getActiveTotal() < config.webhooks.maxConcurrent) {
        if ((job.deferredCount ?? 0) > 0) {
          job.deferredCount = 0;
          this.clearTimer(key);
          job.nextAttemptAt = Date.now();
          void this.executeJob(key);
        }
      }
    }
  }

  private jobKey(webhookId: string, eventId: string, runId: string): string {
    return `${webhookId}:${eventId}:${runId}`;
  }

  schedule(job: ScheduledDeliveryJob): void {
    const key = this.jobKey(job.webhookId, job.eventId, job.runId);
    this.clearTimer(key);
    this.jobs.set(key, job);

    const now = Date.now();
    const delay = Math.max(0, job.nextAttemptAt - now);

    const timer = setTimeout(() => {
      this.activeTimers.delete(key);
      void this.executeJob(key);
    }, delay);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.activeTimers.set(key, timer);
  }

  cancelForWebhook(webhookId: string, reason: string): void {
    for (const [key, job] of this.jobs.entries()) {
      if (job.webhookId === webhookId) {
        this.clearTimer(key);
        this.jobs.delete(key);

        // Record dead-letter row in log for pending attempt
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: job.deliveryId,
          type: job.type,
          address: job.address,
          messageId: job.messageId,
          uidValidity: job.uidValidity,
          rfc822MessageId: job.rfc822MessageId,
          taskId: job.taskId,
          taskCreatedAt: job.taskCreatedAt,
          expiresInSec: job.expiresInSec,
          eventCreatedAt: job.eventCreatedAt,
          attempt: job.attempt,
          outcome: 'permanent',
          status: null,
          durationMs: null,
          sensitive: false,
          replay: job.replay,
          nextAttemptAt: null,
          reason,
        });
      }
    }
  }

  cancelAll(): void {
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.jobs.clear();
    cancelReconstructionRetries();
    stopWebhookMaintenance();
  }

  isJobQueued(webhookId: string, eventId: string, runId: string): boolean {
    return this.jobs.has(`${webhookId}:${eventId}:${runId}`);
  }

  /** 测试钩：窥视已入队作业（#322 断言重建 firstAttemptAt） */
  peekJobForTests(
    webhookId: string,
    eventId: string,
    runId: string,
  ): ScheduledDeliveryJob | undefined {
    return this.jobs.get(this.jobKey(webhookId, eventId, runId));
  }

  hasQueuedJob(webhookId: string, eventId?: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.webhookId !== webhookId) continue;
      if (eventId !== undefined && job.eventId !== eventId) continue;
      return true;
    }
    return false;
  }

  private clearTimer(key: string): void {
    const t = this.activeTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.activeTimers.delete(key);
    }
  }

  private scheduleIfStillQueued(key: string, job: ScheduledDeliveryJob): void {
    if (this.jobs.get(key) !== job) return;
    this.schedule(job);
  }

  private async executeJob(key: string): Promise<void> {
    const job = this.jobs.get(key);
    if (!job) return;
    try {
      await this.runExecuteJob(key, job);
    } catch (err: unknown) {
      this.clearTimer(key);
      this.jobs.delete(key);
      try {
        deliveryLimiter.releaseSlot(job.webhookId);
      } catch {
        // ignore double-release
      }
      const storeCorrupt =
        err instanceof WebhookStoreCorruptError ||
        (err !== null &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === 'store_corrupt');
      if (storeCorrupt) {
        console.error('[webhooks] store corrupt during delivery:', describeFailureStack(err));
      } else {
        console.error('[webhooks] executeJob failed:', describeFailureStack(err));
      }
      try {
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: job.deliveryId,
          type: job.type,
          address: job.address,
          messageId: job.messageId,
          uidValidity: job.uidValidity,
          rfc822MessageId: job.rfc822MessageId,
          taskId: job.taskId,
          taskCreatedAt: job.taskCreatedAt,
          expiresInSec: job.expiresInSec,
          eventCreatedAt: job.eventCreatedAt,
          attempt: job.attempt,
          outcome: 'permanent',
          status: null,
          durationMs: null,
          sensitive: false,
          replay: job.replay,
          nextAttemptAt: null,
          reason: storeCorrupt ? 'store_corrupt' : 'execute_error',
        });
      } catch (logErr) {
        console.error('[webhooks] failed to write executeJob dead letter:', logErr);
      }
    }
  }

  private async runExecuteJob(key: string, job: ScheduledDeliveryJob): Promise<void> {

    const sub = getWebhookSubscription(job.webhookId);
    if (!sub || sub.state === 'disabled') {
      this.jobs.delete(key);
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId: job.deliveryId,
        type: job.type,
        address: job.address,
        messageId: job.messageId,
        uidValidity: job.uidValidity,
        rfc822MessageId: job.rfc822MessageId,
        taskId: job.taskId,
        taskCreatedAt: job.taskCreatedAt,
        expiresInSec: job.expiresInSec,
        eventCreatedAt: job.eventCreatedAt,
        attempt: job.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: job.replay,
        nextAttemptAt: null,
        reason: !sub ? 'subscription_deleted' : 'webhook_disabled',
      });
      return;
    }

    const now = Date.now();

    if (job.probeTokenKey) {
      const probeCheck = deliveryLimiter.checkTestProbeRate(job.probeTokenKey, now);
      if (!probeCheck.allowed) {
        this.jobs.delete(key);
        recordAuditEvent({
          event: 'webhook.probe_rate_limited',
          outcome: 'rate_limited',
          address: sub.address,
          webhookId: sub.id,
        });
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: job.deliveryId,
          type: job.type,
          address: job.address,
          messageId: job.messageId,
          uidValidity: job.uidValidity,
          rfc822MessageId: job.rfc822MessageId,
          taskId: job.taskId,
          taskCreatedAt: job.taskCreatedAt,
          expiresInSec: job.expiresInSec,
          eventCreatedAt: job.eventCreatedAt,
          attempt: job.attempt,
          outcome: 'permanent',
          status: null,
          durationMs: null,
          sensitive: false,
          replay: job.replay,
          nextAttemptAt: null,
          reason: 'probe_rate_limited',
        });
        return;
      }
      // Once admitted, clear probeTokenKey so background retries never re-deduct
      // or re-check the caller's probe rate bucket (§8.7).
      delete job.probeTokenKey;
    }

    // Check item 2: 72h horizon — 约束排期（nextAttemptAt），非执行墙钟 now（#294 1b'）
    if (isScheduledAttemptBeyondRetryHorizon(job.nextAttemptAt, job.firstAttemptAt)) {
      this.jobs.delete(key);
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId: job.deliveryId,
        type: job.type,
        address: job.address,
        messageId: job.messageId,
        uidValidity: job.uidValidity,
        rfc822MessageId: job.rfc822MessageId,
        taskId: job.taskId,
        taskCreatedAt: job.taskCreatedAt,
        expiresInSec: job.expiresInSec,
        eventCreatedAt: job.eventCreatedAt,
        attempt: job.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: job.replay,
        nextAttemptAt: null,
        reason: 'retry_horizon_exceeded',
      });
      return;
    }

    // 1. Check endpoint concurrency & global concurrency pool (§8.7)
    if (!deliveryLimiter.acquireSlot(job.webhookId)) {
      // Pool saturated or endpoint busy: memory-only reschedule (§8.2).
      // The durable pending row already carries nextAttemptAt; do not append
      // a deferred row per tick (that unbounded the JSONL log).
      const isPoolFull = deliveryLimiter.getActiveTotal() >= config.webhooks.maxConcurrent;
      job.deferredCount = (job.deferredCount ?? 0) + 1;
      const delay = isPoolFull
        ? config.webhooks.poolRetryMs
        : Math.min(5000, 500 * Math.pow(1.5, Math.min(job.deferredCount - 1, 6)));
      const rescheduleAt = now + delay;

      // Check item 2: deferred hitting 72h horizon -> terminal outcome=permanent + reason=retry_horizon_exceeded
      if (rescheduleAt > job.firstAttemptAt + RETRY_HORIZON_SEC * 1000) {
        this.jobs.delete(key);
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: job.deliveryId,
          type: job.type,
          address: job.address,
          messageId: job.messageId,
          uidValidity: job.uidValidity,
          rfc822MessageId: job.rfc822MessageId,
          taskId: job.taskId,
          taskCreatedAt: job.taskCreatedAt,
          expiresInSec: job.expiresInSec,
          eventCreatedAt: job.eventCreatedAt,
          attempt: job.attempt,
          outcome: 'permanent',
          status: null,
          durationMs: null,
          sensitive: false,
          replay: job.replay,
          nextAttemptAt: null,
          reason: 'retry_horizon_exceeded',
        });
        return;
      }

      job.nextAttemptAt = rescheduleAt;
      this.scheduleIfStillQueued(key, job);
      return;
    }

    // 2. Check per-endpoint delivery rate limit (§8.7)
    const rateCheck = deliveryLimiter.checkDeliverRate(job.webhookId, now);
    if (!rateCheck.allowed) {
      deliveryLimiter.releaseSlot(job.webhookId);
      const limiterReschedule = now + rateCheck.retryAfterSec * 1000;
      const scheduledOffset = calculateNextAttemptTime(job.attempt - 1, job.firstAttemptAt) ?? limiterReschedule;
      const rescheduleAt = Math.max(limiterReschedule, scheduledOffset);

      // Check item 2: deferred hitting 72h horizon
      if (rescheduleAt > job.firstAttemptAt + RETRY_HORIZON_SEC * 1000) {
        this.jobs.delete(key);
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: job.deliveryId,
          type: job.type,
          address: job.address,
          messageId: job.messageId,
          uidValidity: job.uidValidity,
          rfc822MessageId: job.rfc822MessageId,
          taskId: job.taskId,
          taskCreatedAt: job.taskCreatedAt,
          expiresInSec: job.expiresInSec,
          eventCreatedAt: job.eventCreatedAt,
          attempt: job.attempt,
          outcome: 'permanent',
          status: null,
          durationMs: null,
          sensitive: false,
          replay: job.replay,
          nextAttemptAt: null,
          reason: 'retry_horizon_exceeded',
        });
        return;
      }

      job.nextAttemptAt = rescheduleAt;
      this.scheduleIfStillQueued(key, job);
      return;
    }

    // Build payload and execute attempt — reuse the pending row's deliveryId
    const deliveryId = job.deliveryId;
    let body: string;
    let sensitive = false;

    try {
      const formatted = job.payloadBuilder(sub);
      body = formatted.body;
      sensitive = formatted.sensitive;
    } catch (err: any) {
      deliveryLimiter.releaseSlot(job.webhookId);
      this.jobs.delete(key);
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId,
        type: job.type,
        address: job.address,
        messageId: job.messageId,
        uidValidity: job.uidValidity,
        rfc822MessageId: job.rfc822MessageId,
        taskId: job.taskId,
        taskCreatedAt: job.taskCreatedAt,
        expiresInSec: job.expiresInSec,
        eventCreatedAt: job.eventCreatedAt,
        attempt: job.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: job.replay,
        nextAttemptAt: null,
        reason: err?.message || 'payload_too_large',
      });
      return;
    }

    let result: WebhookFetchResult;
    try {
      result = await executeWebhookAttempt(sub, body, job.type, deliveryId);
    } finally {
      deliveryLimiter.releaseSlot(job.webhookId);
    }

    // cancelForWebhook may have removed this job while the attempt was in flight.
    if (this.jobs.get(key) !== job) {
      return;
    }

    // Process outcome & update circuit breaker (§8.5, D2a)
    const finishedTs = new Date().toISOString();
    const currentAttempt = job.attempt;
    let nextScheduledTime: number | null = null;

    if (result.outcome === 'success') {
      this.jobs.delete(key);
      updateWebhookSubscription(sub.id, (s) => {
        s.consecutiveFailures = 0;
        if (s.state === 'unverified') {
          s.state = 'enabled';
        }
      });
    } else if (result.outcome === 'refused') {
      this.jobs.delete(key);
      updateWebhookSubscription(sub.id, (s) => {
        s.state = 'disabled';
        s.disabledReason = 'refused';
      });

      // Item 3: Background delivery webhook.ssrf_refused audit row omits ip!
      recordAuditEvent({
        event: 'webhook.ssrf_refused',
        outcome: 'denied',
        address: sub.address,
        webhookId: sub.id,
      });
      recordAuditEvent({
        event: 'webhook.disabled',
        outcome: 'ok',
        address: sub.address,
        webhookId: sub.id,
      });
    } else if (result.outcome === 'permanent' || result.outcome === 'retryable') {
      if (result.outcome === 'permanent') {
        this.jobs.delete(key);
      }

      if (countsTowardCircuitBreaker(job.type, result.outcome, sub)) {
        updateWebhookSubscription(sub.id, (s) => {
          s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
          if (s.consecutiveFailures >= config.webhooks.disableThreshold && s.state !== 'disabled') {
            s.state = 'disabled';
            s.disabledReason = 'threshold';
          }
        });

        const updated = getWebhookSubscription(sub.id);
        if (updated?.state === 'disabled') {
          recordAuditEvent({
            event: 'webhook.disabled',
            outcome: 'ok',
            address: sub.address,
            webhookId: sub.id,
          });
          if (result.outcome === 'retryable') {
            this.jobs.delete(key);
            result.outcome = 'permanent';
            result.reason = 'webhook_disabled';
          }
        }
      }

      if (result.outcome === 'retryable') {
        const retryAfterMatch = result.reason?.match(/^rate_limited_retry_after_(\d+)$/);
        const retryAfterSec = retryAfterMatch ? Number.parseInt(retryAfterMatch[1]!, 10) : undefined;
        nextScheduledTime = calculateNextAttemptTime(currentAttempt, job.firstAttemptAt, {
          isPing: job.type === 'webhook.ping',
          retryAfterSec,
          receivedAtMs: Date.now(),
        });

        if (nextScheduledTime === null) {
          this.jobs.delete(key);
        }
      }
    }

    // Append completed attempt row
    appendDeliveryLogRow({
      ts: finishedTs,
      webhookId: job.webhookId,
      eventId: job.eventId,
      runId: job.runId,
      deliveryId,
      type: job.type,
      address: job.address,
      messageId: job.messageId,
      uidValidity: job.uidValidity,
      rfc822MessageId: job.rfc822MessageId,
      taskId: job.taskId,
      taskCreatedAt: job.taskCreatedAt,
      expiresInSec: job.expiresInSec,
      eventCreatedAt: job.eventCreatedAt,
      attempt: currentAttempt,
      outcome: result.outcome,
      status: result.status,
      durationMs: result.durationMs,
      sensitive,
      replay: job.replay,
      nextAttemptAt: nextScheduledTime ? new Date(nextScheduledTime).toISOString() : null,
      reason: result.reason,
    });

    if (result.outcome === 'retryable' && nextScheduledTime !== null) {
      job.attempt = currentAttempt + 1;
      job.nextAttemptAt = nextScheduledTime;
      this.scheduleIfStillQueued(key, job);
    }
  }
}

export const deliveryQueue = new WebhookDeliveryQueue();

// Register cascade cancellation hook for deleted identities
registerWebhookCancelCallback((webhookId, reason) => {
  deliveryQueue.cancelForWebhook(webhookId, reason);
});

// ---------------------------------------------------------------------------
// Public Dispatch APIs
// ---------------------------------------------------------------------------

/**
 * Enqueues a delivery for a subscription.
 */
export function enqueueWebhookDelivery(params: {
  subscription: WebhookSubscription;
  eventId: string;
  runId?: string;
  deliveryId?: string;
  type: WebhookEventType;
  payloadBuilder: (currentSub: WebhookSubscription) => { body: string; sensitive: boolean };
  replay?: boolean;
  address?: string | null;
  messageId?: string | null;
  uidValidity?: number | null;
  rfc822MessageId?: string | null;
  taskId?: string | null;
  taskCreatedAt?: string | null;
  expiresInSec?: number | null;
  eventCreatedAt?: string;
  delayMs?: number;
  probeTokenKey?: string;
}): void {
  const sub = params.subscription;
  const now = Date.now();
  const runId = params.runId ?? 'run_0';
  const eventCreatedAt = params.eventCreatedAt ?? new Date().toISOString();
  const nextAttemptAt = now + (params.delayMs ?? 0);
  const deliveryId = params.deliveryId ?? `dlv_${randomUUID()}`;

  // If endpoint is disabled: dead-letter immediately rather than queuing (§8.5)
  if (sub.state === 'disabled') {
    appendDeliveryLogRow({
      ts: new Date().toISOString(),
      webhookId: sub.id,
      eventId: params.eventId,
      runId,
      deliveryId,
      type: params.type,
      address: params.address ?? sub.address ?? null,
      messageId: params.messageId ?? null,
      uidValidity: params.uidValidity ?? null,
      rfc822MessageId: params.rfc822MessageId ?? null,
      taskId: params.taskId ?? null,
      taskCreatedAt: params.taskCreatedAt ?? null,
      expiresInSec: params.expiresInSec ?? null,
      eventCreatedAt,
      attempt: 1,
      outcome: 'permanent',
      status: null,
      durationMs: null,
      sensitive: sub.contentScope === 'preview',
      replay: params.replay ?? false,
      nextAttemptAt: null,
      reason: 'webhook_disabled',
    });
    return;
  }

  // Write durable pending row before scheduling (§8.6, §11.4)
  appendDeliveryLogRow({
    ts: new Date().toISOString(),
    webhookId: sub.id,
    eventId: params.eventId,
    runId,
    deliveryId,
    type: params.type,
    address: params.address ?? sub.address ?? null,
    messageId: params.messageId ?? null,
    uidValidity: params.uidValidity ?? null,
    rfc822MessageId: params.rfc822MessageId ?? null,
    taskId: params.taskId ?? null,
    taskCreatedAt: params.taskCreatedAt ?? null,
    expiresInSec: params.expiresInSec ?? null,
    eventCreatedAt,
    attempt: 1,
    outcome: 'pending',
    status: null,
    durationMs: null,
    sensitive: sub.contentScope === 'preview',
    replay: params.replay ?? false,
    nextAttemptAt: new Date(nextAttemptAt).toISOString(),
    reason: null,
  });

  deliveryQueue.schedule({
    webhookId: sub.id,
    eventId: params.eventId,
    runId,
    deliveryId,
    type: params.type,
    payloadBuilder: params.payloadBuilder,
    firstAttemptAt: now,
    attempt: 1,
    nextAttemptAt,
    replay: params.replay ?? false,
    address: params.address ?? sub.address ?? null,
    messageId: params.messageId ?? null,
    uidValidity: params.uidValidity ?? null,
    rfc822MessageId: params.rfc822MessageId ?? null,
    taskId: params.taskId ?? null,
    taskCreatedAt: params.taskCreatedAt ?? null,
    expiresInSec: params.expiresInSec ?? null,
    eventCreatedAt,
    probeTokenKey: params.probeTokenKey,
  });
}

/**
 * Fires an asynchronous creation ping (§5.1, D12) or URL change ping.
 */
export function fireCreationPing(
  subscription: WebhookSubscription,
  trigger: 'creation' | 'test' = 'creation',
  callerTokenKey?: string,
): void {
  const tokenKey = callerTokenKey ?? subscription.createdBy ?? subscription.address;
  const probeCheck = deliveryLimiter.checkTestProbeRate(tokenKey);
  // Probe-full: enqueue delayed; executeJob re-checks the shared bucket and
  // audits+drops if still full (create+retarget must not bypass the quota).
  const delayMs = probeCheck.allowed ? 0 : Math.max(config.webhooks.poolRetryMs, 1);

  const eventId = `evt_${randomUUID()}`;
  const envelope: WebhookEnvelopeBase = {
    id: eventId,
    type: 'webhook.ping',
    payloadVersion: 'v1',
    createdAt: new Date().toISOString(),
    domain: config.domain,
  };

  enqueueWebhookDelivery({
    subscription,
    eventId,
    type: 'webhook.ping',
    payloadBuilder: (currentSub) => formatPingPayload(envelope, currentSub.id, trigger),
    address: null,
    delayMs,
    probeTokenKey: probeCheck.allowed ? undefined : tokenKey,
  });
}

/**
 * Executes a test probe against an endpoint (POST /v1/webhooks/:id/test).
 * Awaits attempt 1 up to WEBHOOK_DELIVERY_TIMEOUT_MS.
 * If attempt 1 fails and is retryable, background retries continue.
 */
export async function executeWebhookTestProbe(
  subscription: WebhookSubscription,
  callerTokenKey: string,
  options?: { dnsLookup?: DnsLookup; clientIp?: string },
): Promise<{
  deliveryId: string;
  outcome: WebhookDeliveryOutcome;
  status: number | null;
  reason: string | null;
}> {
  // On a disabled endpoint, throw 409 webhook_disabled (§10.3)
  if (subscription.state === 'disabled') {
    const err: any = new Error('webhook_disabled');
    err.code = 'webhook_disabled';
    err.disabledReason = subscription.disabledReason ?? 'manual';
    throw err;
  }

  // Rate limit: check shared test probe bucket (§8.7)
  const probeCheck = deliveryLimiter.checkTestProbeRate(callerTokenKey);
  if (!probeCheck.allowed) {
    const err: any = new Error('rate_limited');
    err.code = 'rate_limited';
    err.retryAfterSec = probeCheck.retryAfterSec;
    throw err;
  }

  const deliveryId = `dlv_${randomUUID()}`;
  const eventId = `evt_${randomUUID()}`;
  const eventCreatedAt = new Date().toISOString();

  const envelope: WebhookEnvelopeBase = {
    id: eventId,
    type: 'webhook.ping',
    payloadVersion: 'v1',
    createdAt: eventCreatedAt,
    domain: config.domain,
  };

  const payloadBuilder = (currentSub: WebhookSubscription) =>
    formatPingPayload(envelope, currentSub.id, 'test');
  const { body } = payloadBuilder(subscription);

  // Write pending row
  appendDeliveryLogRow({
    ts: new Date().toISOString(),
    webhookId: subscription.id,
    eventId,
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
    eventCreatedAt,
    attempt: 1,
    outcome: 'pending',
    status: null,
    durationMs: null,
    sensitive: false,
    replay: false,
    nextAttemptAt: new Date().toISOString(),
    reason: null,
  });

  // Acquire concurrency slot (Item 21)
  const waitTimeout = config.webhooks.deliveryTimeoutMs || 10_000;
  const startWait = Date.now();
  while (!deliveryLimiter.acquireSlot(subscription.id)) {
    if (Date.now() - startWait >= waitTimeout) {
      const isPoolFull = deliveryLimiter.getActiveTotal() >= config.webhooks.maxConcurrent;
      const reason = isPoolFull ? 'concurrency_pool_full' : 'endpoint_busy';
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: subscription.id,
        eventId,
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
        eventCreatedAt,
        attempt: 1,
        outcome: 'permanent',
        status: null,
        durationMs: Date.now() - startWait,
        sensitive: false,
        replay: false,
        nextAttemptAt: null,
        reason,
      });
      const err: any = new Error('rate_limited');
      err.code = 'rate_limited';
      err.retryAfterSec = 5;
      err.reason = reason;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  let fetchResult: WebhookFetchResult;
  try {
    fetchResult = await executeWebhookAttempt(
      subscription,
      body,
      'webhook.ping',
      deliveryId,
      options,
    );
  } finally {
    deliveryLimiter.releaseSlot(subscription.id);
  }

  const finishedTs = new Date().toISOString();

  // Update circuit breaker
  if (fetchResult.outcome === 'success') {
    updateWebhookSubscription(subscription.id, (s) => {
      s.consecutiveFailures = 0;
      if (s.state === 'unverified') s.state = 'enabled';
    });
  } else if (fetchResult.outcome === 'refused') {
    updateWebhookSubscription(subscription.id, (s) => {
      s.state = 'disabled';
      s.disabledReason = 'refused';
    });
    recordAuditEvent({
      event: 'webhook.ssrf_refused',
      outcome: 'denied',
      address: subscription.address,
      webhookId: subscription.id,
      ...(options?.clientIp ? { ip: options.clientIp } : {}),
    });
    recordAuditEvent({
      event: 'webhook.disabled',
      outcome: 'ok',
      address: subscription.address,
      webhookId: subscription.id,
    });
  } else if (countsTowardCircuitBreaker('webhook.ping', fetchResult.outcome, subscription)) {
    // #290 B / R2 P1-2：仅当本次实际完成 threshold→disabled 转换才 audit。
    // 快照仍为 enabled、中途已被手动 /disable 时：不得再 +1 计数、不得重复 audit。
    // （主路径同款终态判定属存量同族，本卡红线不动主路径。）
    let trippedThisAttempt = false;
    updateWebhookSubscription(subscription.id, (s) => {
      // 已 disabled：无变更信号 → 跳过 updatedAt/writeStore（#312 P3-2）
      if (s.state === 'disabled') return false;
      s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
      if (s.consecutiveFailures >= config.webhooks.disableThreshold) {
        s.state = 'disabled';
        s.disabledReason = 'threshold';
        trippedThisAttempt = true;
      }
    });

    if (trippedThisAttempt) {
      recordAuditEvent({
        event: 'webhook.disabled',
        outcome: 'ok',
        address: subscription.address,
        webhookId: subscription.id,
      });
      if (fetchResult.outcome === 'retryable') {
        fetchResult = {
          ...fetchResult,
          outcome: 'permanent',
          reason: 'webhook_disabled',
        };
      }
    } else if (
      getWebhookSubscription(subscription.id)?.state === 'disabled'
      && fetchResult.outcome === 'retryable'
    ) {
      // 中途已禁用：抑制 attempt-2（死信结算），不写第二份 disable audit
      fetchResult = {
        ...fetchResult,
        outcome: 'permanent',
        reason: 'webhook_disabled',
      };
    }
  }

  let nextScheduledTime: number | null = null;
  // 熔断转 permanent 后此处不再进分支，故不调 deliveryQueue.schedule
  if (fetchResult.outcome === 'retryable') {
    nextScheduledTime = calculateNextAttemptTime(1, Date.now(), { isPing: true });
    if (nextScheduledTime) {
      deliveryQueue.schedule({
        webhookId: subscription.id,
        eventId,
        runId: 'run_0',
        deliveryId,
        type: 'webhook.ping',
        payloadBuilder,
        firstAttemptAt: Date.now(),
        attempt: 2,
        nextAttemptAt: nextScheduledTime,
        replay: false,
        address: null,
        messageId: null,
        uidValidity: null,
        rfc822MessageId: null,
        taskId: null,
        taskCreatedAt: null,
        expiresInSec: null,
        eventCreatedAt,
      });
    }
  }

  appendDeliveryLogRow({
    ts: finishedTs,
    webhookId: subscription.id,
    eventId,
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
    eventCreatedAt,
    attempt: 1,
    outcome: fetchResult.outcome,
    status: fetchResult.status,
    durationMs: fetchResult.durationMs,
    sensitive: false,
    replay: false,
    nextAttemptAt: nextScheduledTime ? new Date(nextScheduledTime).toISOString() : null,
    reason: fetchResult.reason,
  });

  return {
    deliveryId,
    outcome: fetchResult.outcome,
    status: fetchResult.status,
    reason: fetchResult.reason,
  };
}

/**
 * Replays an existing delivery (POST /v1/webhooks/deliveries/:deliveryId/redeliver).
 */
export async function redeliverWebhookDelivery(deliveryId: string): Promise<{
  deliveryId: string;
  eventId: string;
  runId: string;
  address: string;
  webhookId: string;
}> {
  const rows = readAllDeliveryLogRows();
  const original = latestRowForDeliveryId(rows, deliveryId);
  if (!original) {
    const err: any = new Error('delivery_not_found');
    err.code = 'delivery_not_found';
    throw err;
  }
  if (!isTerminalDeliveryRow(original)) {
    const err: any = new Error('delivery_not_replayable');
    err.code = 'delivery_not_replayable';
    throw err;
  }

  const sub = getWebhookSubscription(original.webhookId);
  if (!sub) {
    const err: any = new Error('not_found');
    err.code = 'not_found';
    throw err;
  }
  if (sub.state === 'disabled') {
    const err: any = new Error('webhook_disabled');
    err.code = 'webhook_disabled';
    err.disabledReason = sub.disabledReason ?? 'manual';
    throw err;
  }

  // Calculate new runId
  // maxRunNum 必须盘源计算——截断视图欠数会与盘历史 run 撞号，合并组经 attempt
  // 优先比较可误判 pending 为终态（boot 重建丢重试链），故禁止吃内存视图。
  // #268：流式扫描求最大值（O(1) 内存），语义与全量读 filter+match 逐字一致。
  const maxRunNum = scanMaxRunNumFromDisk(original.webhookId, original.eventId);
  const newRunId = `run_${maxRunNum + 1}`;
  const newDeliveryId = `dlv_${randomUUID()}`;

  // Rebuild payload based on event type
  let payloadBuilder: (currentSub: WebhookSubscription) => { body: string; sensitive: boolean };

  if (original.type === 'webhook.ping') {
    const envelope: WebhookEnvelopeBase = {
      id: original.eventId,
      type: 'webhook.ping',
      payloadVersion: 'v1',
      createdAt: original.eventCreatedAt,
      domain: config.domain,
    };
    payloadBuilder = (currentSub) => formatPingPayload(envelope, currentSub.id, 'test');
  } else if (original.type === 'approval.requested') {
    if (!original.taskId) {
      // #280：裸 Error 无 code 会漏过 redeliver 路由映射 → 500；镜像兄弟抛点补 code
      const err: any = new Error('missing_task_id');
      err.code = 'missing_task_id';
      throw err;
    }
    const task = await getTaskSnapshot(original.taskId);
    if (!task || task.kind !== 'approval' || !task.approval) {
      // #280：同 missing_task_id，补 code 供路由 404 映射
      const err: any = new Error('task_not_found');
      err.code = 'task_not_found';
      throw err;
    }
    const envelope: WebhookEnvelopeBase = {
      id: original.eventId,
      type: 'approval.requested',
      payloadVersion: 'v1',
      createdAt: original.eventCreatedAt,
      domain: config.domain,
    };
    payloadBuilder = (currentSub) =>
      formatApprovalPayload(currentSub, envelope, {
        taskId: task.id,
        taskState: 'input-required',
        from: task.from,
        to: task.to,
        reviewer: task.approval!.reviewer,
        subject: task.subject,
        createdAt: original.taskCreatedAt ?? task.createdAt,
        expiresAt: task.approval!.expiresAt,
        expiresInSec: original.expiresInSec ?? original.taskExpiresInSec ?? null,
        digest: task.approval!.digest,
        actionType: task.approval!.action.type,
        actionName: task.approval!.action.name,
        actionArguments: task.approval!.action.arguments,
      });
  } else if (original.type === 'mail.received') {
    if (!original.address || !original.messageId) {
      const err: any = new Error('missing_mail_identifiers');
      err.code = 'missing_mail_identifiers';
      throw err;
    }
    // Fail-closed against generation drift: refuse redelivery if uidValidity is absent (P2-2)
    if (original.uidValidity === null || original.uidValidity === undefined) {
      const err: any = new Error('uidvalidity_required');
      err.code = 'uidvalidity_required';
      err.reason = 'uidvalidity_required';
      throw err;
    }
    let detail: any;
    try {
      detail = await getMessage(original.address, original.messageId, {
        uidValidity: original.uidValidity,
      });
    } catch (err: any) {
      if (err instanceof StaleMessageGenerationError || err?.name === 'StaleMessageGenerationError') {
        const staleErr: any = new Error('stale_message_generation');
        staleErr.code = 'stale_message_generation';
        staleErr.reason = 'stale_message_generation';
        throw staleErr;
      }
      throw err;
    }
    if (!detail) {
      const err: any = new Error('message_not_found');
      err.code = 'message_not_found';
      throw err;
    }

    let unread = true;
    let sizeBytes = 0;
    let hasAttachments = false;
    try {
      await withInbox(async (client) => {
        const uid = Number(detail.id);
        const msg = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
        if (msg) {
          unread = !msg.flags?.has('\\Seen');
          if (msg.source) {
            sizeBytes = msg.source.length;
            try {
              const parsed = await simpleParser(msg.source);
              hasAttachments = (parsed.attachments?.length ?? 0) > 0;
            } catch {
              // ignore parse failure
            }
          }
        }
      });
    } catch {
      // fallback to defaults
    }

    const envelope: WebhookEnvelopeBase = {
      id: original.eventId,
      type: 'mail.received',
      payloadVersion: 'v1',
      createdAt: original.eventCreatedAt,
      domain: config.domain,
    };
    payloadBuilder = (currentSub) =>
      formatMailPayload(currentSub, envelope, {
        address: original.address!,
        messageId: detail.id,
        uid: Number(detail.id),
        uidValidity: original.uidValidity ?? null,
        receivedAt: detail.date,
        from: { address: detail.from },
        to: [detail.to],
        cc: [],
        subject: detail.subject,
        sizeBytes,
        hasAttachments,
        unread,
        containsSecurityCode: detail.otp.codes.length > 0,
        containsLink: detail.otp.links.length > 0,
        textPreview: detail.text,
        securityCodes: detail.otp.codes,
        links: detail.otp.links,
      });
  } else {
    throw new Error('unsupported_event_type');
  }

  enqueueWebhookDelivery({
    subscription: sub,
    eventId: original.eventId,
    runId: newRunId,
    deliveryId: newDeliveryId,
    type: original.type,
    payloadBuilder,
    replay: true,
    address: original.address,
    messageId: original.messageId,
    uidValidity: original.uidValidity,
    rfc822MessageId: original.rfc822MessageId,
    taskId: original.taskId,
    taskCreatedAt: original.taskCreatedAt,
    expiresInSec: original.expiresInSec,
    eventCreatedAt: original.eventCreatedAt,
  });

  return {
    deliveryId: newDeliveryId,
    eventId: original.eventId,
    runId: newRunId,
    address: sub.address,
    webhookId: sub.id,
  };
}

export const RECONSTRUCT_RETRY_INITIAL_MS = 30_000;
export const RECONSTRUCT_RETRY_MAX_MS = 600_000;

let reconstructRetryInitialMs = RECONSTRUCT_RETRY_INITIAL_MS;
let reconstructRetryMaxMs = RECONSTRUCT_RETRY_MAX_MS;
const reconstructRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconstructRetryDelays = new Map<string, number>();

export function setReconstructRetryDelaysForTests(initialMs?: number, maxMs?: number): void {
  cancelReconstructionRetries();
  reconstructRetryInitialMs = initialMs ?? RECONSTRUCT_RETRY_INITIAL_MS;
  reconstructRetryMaxMs = maxMs ?? RECONSTRUCT_RETRY_MAX_MS;
}

export function pendingReconstructionRetryCount(): number {
  return reconstructRetryTimers.size;
}

export function cancelReconstructionRetries(): void {
  for (const timer of reconstructRetryTimers.values()) {
    clearTimeout(timer);
  }
  reconstructRetryTimers.clear();
  reconstructRetryDelays.clear();
}

function nextReconstructRetryDelay(key: string): number {
  const prev = reconstructRetryDelays.get(key);
  const next =
    prev === undefined
      ? reconstructRetryInitialMs
      : Math.min(prev * 2, reconstructRetryMaxMs);
  reconstructRetryDelays.set(key, next);
  return next;
}

function scheduleReconstructionRetry(key: string): void {
  const existing = reconstructRetryTimers.get(key);
  if (existing) clearTimeout(existing);
  const delay = nextReconstructRetryDelay(key);
  const timer = setTimeout(() => {
    reconstructRetryTimers.delete(key);
    void reconstructPendingDeliveriesAtBoot(Date.now(), { onlyKeys: new Set([key]) });
  }, delay);
  timer.unref?.();
  reconstructRetryTimers.set(key, timer);
}

/**
 * Boot reconstruction algorithm (§8.6).
 * Reconstructs pending delivery attempts from webhook-deliveries.jsonl.
 */
export async function reconstructPendingDeliveriesAtBoot(
  bootTime = Date.now(),
  options?: { onlyKeys?: Set<string> },
): Promise<{
  reconstructed: number;
  deadLettered: number;
}> {
  const rows = readAllDeliveryLogRowsFromDisk();
  adoptDeliveryLogIndex(rows);
  if (rows.length === 0) return { reconstructed: 0, deadLettered: 0 };

  // 1. Group rows by (webhookId, eventId, runId)
  const groups = new Map<string, WebhookDeliveryLogRow[]>();
  for (const row of rows) {
    const key = `${row.webhookId}:${row.eventId}:${row.runId}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(row);
  }

  let reconstructed = 0;
  let deadLettered = 0;

  for (const [key, groupRows] of groups.entries()) {
    if (options?.onlyKeys && !options.onlyKeys.has(key)) continue;

    // 2. Take only the row with highest attempt, tie-broken on ts
    groupRows.sort((a, b) => {
      if (a.attempt !== b.attempt) return b.attempt - a.attempt;
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
    const latest = groupRows[0]!;

    // 3. Discard group if latest row is final (§8.6 step 3) using the
    // event type's actual cap (ping=3, others=WEBHOOK_MAX_ATTEMPTS).
    if (isTerminalDeliveryRow(latest)) {
      reconstructRetryDelays.delete(key);
      continue;
    }

    if (deliveryQueue.isJobQueued(latest.webhookId, latest.eventId, latest.runId)) {
      reconstructRetryDelays.delete(key);
      continue;
    }

    // #322 A1/A2：与执行前同构——horizon 判据同一函数；时刻来源=持久化排期（非墙钟）。
    // #322 R1/R2 / #294 1b'：判界与入队 job.nextAttemptAt 均用持久化排期本身。
    // 不得 Math.max(..., bootTime)——否则 attempt 11 钉 +72h、boot=排期+ε 时，
    // 执行前判据会吃到被抬高的 nextAttemptAt 而误杀。schedule() 内部已是
    // delay=Math.max(0, nextAttemptAt-now)，过期排期自然 0 延迟立刻跑、语义时刻不变。
    const firstAttemptAt = deriveFirstAttemptAtMsFromGroup(groupRows, latest);
    let persistedScheduleMs: number;
    if (latest.nextAttemptAt) {
      const parsed = new Date(latest.nextAttemptAt).getTime();
      // 解析失败时与「无排期」同口径，回落 bootTime（无可对照的持久化时刻）
      persistedScheduleMs = Number.isFinite(parsed) ? parsed : bootTime;
    } else {
      // 无 nextAttemptAt：无可持久化排期，回落 bootTime（立刻应跑；注释明说）
      persistedScheduleMs = bootTime;
    }
    if (isScheduledAttemptBeyondRetryHorizon(persistedScheduleMs, firstAttemptAt)) {
      deadLettered++;
      reconstructRetryDelays.delete(key);
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: latest.webhookId,
        eventId: latest.eventId,
        runId: latest.runId,
        deliveryId: latest.deliveryId,
        type: latest.type,
        address: latest.address,
        messageId: latest.messageId,
        uidValidity: latest.uidValidity,
        rfc822MessageId: latest.rfc822MessageId,
        taskId: latest.taskId,
        taskCreatedAt: latest.taskCreatedAt,
        expiresInSec: latest.expiresInSec,
        eventCreatedAt: latest.eventCreatedAt,
        attempt: latest.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: latest.replay,
        nextAttemptAt: null,
        reason: 'retry_horizon_exceeded',
      });
      continue;
    }

    // 4. Otherwise pending!
    const sub = getWebhookSubscription(latest.webhookId);
    if (!sub || sub.state === 'disabled') {
      deadLettered++;
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: latest.webhookId,
        eventId: latest.eventId,
        runId: latest.runId,
        deliveryId: latest.deliveryId,
        type: latest.type,
        address: latest.address,
        messageId: latest.messageId,
        uidValidity: latest.uidValidity,
        rfc822MessageId: latest.rfc822MessageId,
        taskId: latest.taskId,
        taskCreatedAt: latest.taskCreatedAt,
        expiresInSec: latest.expiresInSec,
        eventCreatedAt: latest.eventCreatedAt,
        attempt: latest.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: latest.replay,
        nextAttemptAt: null,
        reason: !sub ? 'subscription_deleted' : 'webhook_disabled',
      });
      reconstructRetryDelays.delete(key);
      continue;
    }

    // 5. Rebuild payload (§8.6 step 5)
    try {
      let payloadBuilder: (currentSub: WebhookSubscription) => { body: string; sensitive: boolean };

      if (latest.type === 'webhook.ping') {
        const envelope: WebhookEnvelopeBase = {
          id: latest.eventId,
          type: 'webhook.ping',
          payloadVersion: 'v1',
          createdAt: latest.eventCreatedAt,
          domain: config.domain,
        };
        payloadBuilder = (currentSub) => formatPingPayload(envelope, currentSub.id, 'test');
      } else if (latest.type === 'approval.requested') {
        if (!latest.taskId) {
          throw Object.assign(new Error('missing_task_id'), { reason: 'task_not_found' });
        }
        let task: any = null;
        try {
          task = await getTaskSnapshot(latest.taskId);
        } catch (err: any) {
          throw Object.assign(new Error(err?.message || 'backend_unreachable'), {
            reason: 'transient_backend_unreachable',
            isTransient: true,
            cause: err,
          });
        }
        if (!task || task.kind !== 'approval' || !task.approval) {
          throw Object.assign(new Error('task_not_found'), { reason: 'task_not_found' });
        }
        const envelope: WebhookEnvelopeBase = {
          id: latest.eventId,
          type: 'approval.requested',
          payloadVersion: 'v1',
          createdAt: latest.eventCreatedAt,
          domain: config.domain,
        };
        // Item 9: restore taskCreatedAt and expiresInSec from row!
        payloadBuilder = (currentSub) =>
          formatApprovalPayload(currentSub, envelope, {
            taskId: task.id,
            taskState: 'input-required',
            from: task.from,
            to: task.to,
            reviewer: task.approval!.reviewer,
            subject: task.subject,
            createdAt: latest.taskCreatedAt ?? task.createdAt,
            expiresAt: task.approval!.expiresAt,
            expiresInSec: latest.expiresInSec ?? (latest as any).taskExpiresInSec ?? null,
            digest: task.approval!.digest,
            actionType: task.approval!.action.type,
            actionName: task.approval!.action.name,
            actionArguments: task.approval!.action.arguments,
          });
      } else if (latest.type === 'mail.received') {
        if (!latest.address || !latest.messageId) {
          throw Object.assign(new Error('missing_mail_identifiers'), {
            reason: 'message_not_found',
            isPermanent: true,
          });
        }

        // Mail reconstruction (§8.6): Generation check & fallback to rfc822MessageId
        let activeUid = latest.messageId;
        let activeUidValidity = latest.uidValidity;

        let mailDetail: any = null;
        let unread = true;
        let sizeBytes = 0;
        let hasAttachments = false;
        try {
          mailDetail = await withInbox(async (client) => {
            const currentGen = client.mailbox ? Number(client.mailbox.uidValidity) : undefined;
            if (
              currentGen !== undefined &&
              latest.uidValidity !== null &&
              currentGen !== latest.uidValidity
            ) {
              // Generation differs: fall back to RFC 822 Message-ID search
              // Item 5: overlong (>512) treated as null
              if (!latest.rfc822MessageId) {
                throw Object.assign(new Error('uidvalidity_changed'), {
                  reason: 'uidvalidity_changed',
                  isPermanent: true,
                });
              }
              const foundUids = await client.search(
                { header: { 'Message-ID': latest.rfc822MessageId } },
                { uid: true },
              );
              if (!foundUids || foundUids.length !== 1) {
                throw Object.assign(new Error('uidvalidity_changed'), {
                  reason: 'uidvalidity_changed',
                  isPermanent: true,
                });
              }
              const newUid = foundUids[0]!;
              activeUid = String(newUid);
              activeUidValidity = currentGen;
              const msg = await client.fetchOne(newUid, { source: true, flags: true }, { uid: true });
              if (msg) {
                unread = !msg.flags?.has('\\Seen');
                if (msg.source) {
                  sizeBytes = msg.source.length;
                  try {
                    const parsed = await simpleParser(msg.source);
                    hasAttachments = (parsed.attachments?.length ?? 0) > 0;
                  } catch {}
                }
              }
              return getMessage(latest.address!, activeUid, { uidValidity: currentGen });
            }

            const uidNum = Number(latest.messageId);
            const msg = await client.fetchOne(uidNum, { source: true, flags: true }, { uid: true });
            if (msg) {
              unread = !msg.flags?.has('\\Seen');
              if (msg.source) {
                sizeBytes = msg.source.length;
                try {
                  const parsed = await simpleParser(msg.source);
                  hasAttachments = (parsed.attachments?.length ?? 0) > 0;
                } catch {}
              }
            }
            return getMessage(latest.address!, latest.messageId!, {
              uidValidity: latest.uidValidity ?? undefined,
            });
          });
        } catch (err: any) {
          if (err?.isPermanent) throw err;
          if (
            err instanceof StaleMessageGenerationError ||
            err?.name === 'StaleMessageGenerationError' ||
            err?.reason === 'uidvalidity_changed'
          ) {
            throw Object.assign(new Error('uidvalidity_changed'), {
              reason: 'uidvalidity_changed',
              isPermanent: true,
            });
          }
          // Backend temporarily unreachable (e.g. Dovecot not started yet in container orchestration)
          // P2-6: Do NOT prematurely dead-letter transient errors.
          throw Object.assign(new Error(err?.message || 'backend_unreachable'), {
            reason: 'transient_backend_unreachable',
            isTransient: true,
            cause: err,
          });
        }

        if (!mailDetail) {
          throw Object.assign(new Error('message_not_found'), {
            reason: 'message_not_found',
            isPermanent: true,
          });
        }

        const envelope: WebhookEnvelopeBase = {
          id: latest.eventId,
          type: 'mail.received',
          payloadVersion: 'v1',
          createdAt: latest.eventCreatedAt,
          domain: config.domain,
        };

        payloadBuilder = (currentSub) =>
          formatMailPayload(currentSub, envelope, {
            address: latest.address!,
            messageId: activeUid,
            uid: Number(activeUid),
            uidValidity: activeUidValidity ?? null,
            receivedAt: mailDetail.date,
            from: { address: mailDetail.from },
            to: [mailDetail.to],
            cc: [],
            subject: mailDetail.subject,
            sizeBytes,
            hasAttachments,
            unread,
            containsSecurityCode: mailDetail.otp.codes.length > 0,
            containsLink: mailDetail.otp.links.length > 0,
            textPreview: mailDetail.text,
            securityCodes: mailDetail.otp.codes,
            links: mailDetail.otp.links,
          });
      } else {
        throw Object.assign(new Error('unsupported_type'), {
          reason: 'unsupported_type',
          isPermanent: true,
        });
      }

      // Reconstructed successfully, enqueue to delivery queue
      // #322 A2：携带组内派生的真实 firstAttemptAt（非 eventCreatedAt）
      deliveryQueue.schedule({
        webhookId: sub.id,
        eventId: latest.eventId,
        runId: latest.runId,
        deliveryId: latest.deliveryId,
        type: latest.type,
        payloadBuilder,
        firstAttemptAt,
        attempt: latest.outcome === 'pending' ? latest.attempt : latest.attempt + 1,
        // #322 R2：语义时刻=持久化排期；禁 bootTime clamp（schedule 内已 max(0, delay)）
        nextAttemptAt: persistedScheduleMs,
        replay: latest.replay,
        address: latest.address,
        messageId: latest.messageId,
        uidValidity: latest.uidValidity,
        rfc822MessageId: latest.rfc822MessageId,
        taskId: latest.taskId,
        taskCreatedAt: latest.taskCreatedAt,
        expiresInSec: latest.expiresInSec,
        eventCreatedAt: latest.eventCreatedAt,
      });

      reconstructed++;
      reconstructRetryDelays.delete(key);
    } catch (err: any) {
      if (err?.isTransient) {
        console.warn(
          `[webhooks] boot reconstruction transient failure for delivery ${latest.eventId} / webhook ${latest.webhookId}, retrying with bounded backoff:`,
          err?.message,
        );
        scheduleReconstructionRetry(key);
        continue;
      }

      deadLettered++;
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: latest.webhookId,
        eventId: latest.eventId,
        runId: latest.runId,
        deliveryId: latest.deliveryId,
        type: latest.type,
        address: latest.address,
        messageId: latest.messageId,
        uidValidity: latest.uidValidity,
        rfc822MessageId: latest.rfc822MessageId,
        taskId: latest.taskId,
        taskCreatedAt: latest.taskCreatedAt,
        expiresInSec: latest.expiresInSec,
        eventCreatedAt: latest.eventCreatedAt,
        attempt: latest.attempt,
        outcome: 'permanent',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: latest.replay,
        nextAttemptAt: null,
        reason: err?.reason || err?.message || 'reconstruction_failed',
      });
      reconstructRetryDelays.delete(key);
    }
  }

  return { reconstructed, deadLettered };
}
