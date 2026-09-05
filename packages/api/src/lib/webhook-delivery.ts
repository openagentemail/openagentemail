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
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { config } from './config.ts';
import { recordAuditEvent } from './audit.ts';
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
import { truncateUtf8Bytes } from './utf8-truncate.ts';

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

/** Append a single row to DATA_DIR/webhook-deliveries.jsonl (0600 mode). */
export function appendDeliveryLogRow(row: WebhookDeliveryLogRow): void {
  ensureDataDir();
  const path = deliveryLogPath();

  // Normalize row fields, ensuring forbidden keys or arbitrary payload never land in log
  const sanitizedRow: WebhookDeliveryLogRow = {
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
      if (written <= 0) break;
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads all delivery log rows from disk, with per-line fault tolerance.
 *
 * Semantic distinction:
 * - Webhook configuration store (`webhooks.json`): fail-closed on read.
 *   If the subscription store is corrupt, serving state is unsafe so we must halt
 *   and refuse mutations to protect customer secrets and invariants.
 * - Webhook delivery log (`webhook-deliveries.jsonl`): append-only event log.
 *   Writes are fail-closed (atomic fsync append), but reads fail open:
 *   corrupted or partial lines (e.g. from power loss before fsync or dirty disk writes)
 *   are skipped and logged as errors so that a single bad line does not crash the entire
 *   API on startup or cause 500s across read endpoints.
 */
export function readAllDeliveryLogRows(): WebhookDeliveryLogRow[] {
  const path = deliveryLogPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const rows: WebhookDeliveryLogRow[] = [];
  let corruptCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      rows.push(parsed);
    } catch (err) {
      corruptCount++;
      console.error(
        `[webhooks] corrupted delivery log line ${i + 1} skipped:`,
        line.slice(0, 100),
        err,
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

/**
 * Filtered reader for GET /v1/webhooks/:id/deliveries.
 * Returns newest rows first.
 */
export function readDeliveryLogRows(options?: {
  webhookId?: string;
  limit?: number;
  cursor?: string;
}): { deliveries: WebhookDeliveryLogRow[]; nextCursor?: string } {
  const all = readAllDeliveryLogRows();
  let filtered = options?.webhookId
    ? all.filter((r) => r.webhookId === options.webhookId)
    : all;

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
    const idx = filtered.findIndex((r) => r.deliveryId === options.cursor);
    if (idx >= 0) {
      startIndex = idx + 1;
    }
  }

  const paged = filtered.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < filtered.length;
  const nextCursor = hasMore && paged.length > 0 ? paged[paged.length - 1]!.deliveryId : undefined;

  return { deliveries: paged, nextCursor };
}

/** Returns the latest delivery attempt for an endpoint, if any. */
export function getLatestDeliveryForWebhook(webhookId: string): WebhookDeliveryLogRow | null {
  const rows = readAllDeliveryLogRows().filter((r) => r.webhookId === webhookId);
  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const tA = new Date(a.ts).getTime();
    const tB = new Date(b.ts).getTime();
    if (tA !== tB) return tB - tA;
    return b.attempt - a.attempt;
  });

  return rows[0] ?? null;
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

  const rows = readAllDeliveryLogRows();
  const retentionCutoff = now - retentionDays * 86400000;

  // Identify groups with pending retries so we never prune them
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

  const activeGroupKeys = new Set<string>();
  for (const [key, groupRows] of groups.entries()) {
    groupRows.sort((a, b) => {
      if (a.attempt !== b.attempt) return b.attempt - a.attempt;
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
    const latest = groupRows[0]!;
    const isFinal =
      latest.outcome === 'success' ||
      latest.outcome === 'permanent' ||
      latest.outcome === 'refused' ||
      (latest.outcome === 'retryable' && latest.attempt >= MAX_RETRY_SCHEDULE_ATTEMPTS);
    if (!isFinal) {
      activeGroupKeys.add(key);
    }
  }

  const retainedRows = rows.filter((row) => {
    const key = `${row.webhookId}:${row.eventId}:${row.runId}`;
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
      if (written <= 0) break;
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
}

export function startWebhookMaintenance(): void {
  const tick = () => {
    try {
      compactDeliveryLog();
      compactIdempotencyKeys(config.webhooks.logRetentionDays);
    } catch (err) {
      console.error('[webhooks] maintenance failed:', err);
    }
  };
  tick();
  const schedule = () => {
    const d = new Date();
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    const delay = Math.max(1_000, next - Date.now());
    const timer = setTimeout(() => {
      tick();
      schedule();
    }, delay);
    timer.unref?.();
  };
  schedule();
}

// ---------------------------------------------------------------------------
// URL Validation (§9.3, §9.5)
// ---------------------------------------------------------------------------

/**
 * Static validation of webhook URL before persistence (§9.5).
 */
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
export async function validateWebhookUrlResolution(
  urlStr: string,
  opts: {
    allowPrivateTargets: boolean;
    dnsLookup?: DnsLookup;
    allowedPorts?: number[];
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
      const list = await dnsLookup(literal);
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
      data.textPreview = truncateUtf8String(
        input.textPreview,
        (config.webhooks as any)?.bodyPreviewChars ?? WEBHOOK_BODY_PREVIEW_CHARS,
      );
    }
    if (input.securityCodes !== undefined) {
      data.securityCodes = input.securityCodes
        .slice(0, (config.webhooks as any)?.maxCodeItems ?? WEBHOOK_MAX_CODE_ITEMS)
        .map((c) =>
          truncateUtf8String(
            c,
            (config.webhooks as any)?.codeEntryChars ?? WEBHOOK_CODE_ENTRY_CHARS,
          ),
        );
    }
    if (input.links !== undefined) {
      // Over-long links (> webhookCodeEntryChars) are dropped whole, never truncated (§6.2, §6.6)
      const codeChars = (config.webhooks as any)?.codeEntryChars ?? WEBHOOK_CODE_ENTRY_CHARS;
      data.links = input.links
        .filter((l) => Buffer.byteLength(l, 'utf8') <= codeChars)
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
      object: 'ping',
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

  reset(): void {
    this.activePerEndpoint.clear();
    this.activeTotal = 0;
    this.deliverLimiters.clear();
    this.testProbeLimiters.clear();
    this.createLimiters.clear();
    this.rotateLimiters.clear();
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
          deliveryId: `dlv_${randomUUID()}`,
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
        console.error('[webhooks] store corrupt during delivery:', err);
      } else {
        console.error('[webhooks] executeJob failed:', err);
      }
      try {
        appendDeliveryLogRow({
          ts: new Date().toISOString(),
          webhookId: job.webhookId,
          eventId: job.eventId,
          runId: job.runId,
          deliveryId: `dlv_${randomUUID()}`,
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
        deliveryId: `dlv_${randomUUID()}`,
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

    // Check item 2: 72h horizon check for job
    if (now > job.firstAttemptAt + RETRY_HORIZON_SEC * 1000) {
      this.jobs.delete(key);
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId: `dlv_${randomUUID()}`,
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
      // Pool saturated or endpoint busy: defer! (§8.2)
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
          deliveryId: `dlv_${randomUUID()}`,
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

      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId: `dlv_${randomUUID()}`,
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
        outcome: 'deferred',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: job.replay,
        nextAttemptAt: new Date(rescheduleAt).toISOString(),
        reason: isPoolFull ? 'concurrency_pool_full' : 'endpoint_busy',
      });

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
          deliveryId: `dlv_${randomUUID()}`,
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

      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: job.webhookId,
        eventId: job.eventId,
        runId: job.runId,
        deliveryId: `dlv_${randomUUID()}`,
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
        outcome: 'deferred',
        status: null,
        durationMs: null,
        sensitive: false,
        replay: job.replay,
        nextAttemptAt: new Date(rescheduleAt).toISOString(),
        reason: 'rate_limited',
      });

      job.nextAttemptAt = rescheduleAt;
      this.scheduleIfStillQueued(key, job);
      return;
    }

    // Build payload and execute attempt
    const deliveryId = `dlv_${randomUUID()}`;
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
    } else if (result.outcome === 'permanent') {
      this.jobs.delete(key);
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
      }
    } else if (result.outcome === 'retryable') {
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
      }

      // Check if breaker tripped; if so, dead-letter and stop retrying
      if (updated?.state === 'disabled') {
        this.jobs.delete(key);
        result.outcome = 'permanent';
        result.reason = 'webhook_disabled';
      } else {
        // Calculate retry schedule
        const retryAfterMatch = result.reason?.match(/^rate_limited_retry_after_(\d+)$/);
        const retryAfterSec = retryAfterMatch ? Number.parseInt(retryAfterMatch[1]!, 10) : undefined;
        nextScheduledTime = calculateNextAttemptTime(currentAttempt, job.firstAttemptAt, {
          isPing: job.type === 'webhook.ping',
          retryAfterSec,
          receivedAtMs: Date.now(),
        });

        if (nextScheduledTime === null) {
          // Max attempts reached: dead-letter (§8.3)
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
  if (!probeCheck.allowed) {
    return;
  }

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
  } else {
    updateWebhookSubscription(subscription.id, (s) => {
      s.consecutiveFailures = (s.consecutiveFailures ?? 0) + 1;
      if (s.consecutiveFailures >= config.webhooks.disableThreshold && s.state !== 'disabled') {
        s.state = 'disabled';
        s.disabledReason = 'threshold';
      }
    });
  }

  let nextScheduledTime: number | null = null;
  if (fetchResult.outcome === 'retryable') {
    nextScheduledTime = calculateNextAttemptTime(1, Date.now(), { isPing: true });
    if (nextScheduledTime) {
      deliveryQueue.schedule({
        webhookId: subscription.id,
        eventId,
        runId: 'run_0',
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
  const original = rows.find((r) => r.deliveryId === deliveryId);
  if (!original) {
    const err: any = new Error('delivery_not_found');
    err.code = 'delivery_not_found';
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
  const matchingRuns = rows.filter(
    (r) => r.webhookId === original.webhookId && r.eventId === original.eventId,
  );
  let maxRunNum = 0;
  for (const r of matchingRuns) {
    const m = r.runId.match(/^run_(\d+)$/);
    if (m) {
      maxRunNum = Math.max(maxRunNum, Number.parseInt(m[1]!, 10));
    }
  }
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
      throw new Error('missing_task_id');
    }
    const task = await getTaskSnapshot(original.taskId);
    if (!task || task.kind !== 'approval' || !task.approval) {
      throw new Error('task_not_found');
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

/**
 * Boot reconstruction algorithm (§8.6).
 * Reconstructs pending delivery attempts from webhook-deliveries.jsonl.
 */
export async function reconstructPendingDeliveriesAtBoot(bootTime = Date.now()): Promise<{
  reconstructed: number;
  deadLettered: number;
}> {
  const rows = readAllDeliveryLogRows();
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
    // 2. Take only the row with highest attempt, tie-broken on ts
    groupRows.sort((a, b) => {
      if (a.attempt !== b.attempt) return b.attempt - a.attempt;
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
    const latest = groupRows[0]!;

    // 3. Discard group if latest row is final (§8.6 step 3) using the
    // event type's actual cap (ping=3, others=WEBHOOK_MAX_ATTEMPTS).
    if (isTerminalDeliveryRow(latest)) {
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
        deliveryId: `dlv_${randomUUID()}`,
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
      continue;
    }

    // Calculate scheduled time: max(nextAttemptAt, bootTime)
    const nextAttemptMs = latest.nextAttemptAt
      ? new Date(latest.nextAttemptAt).getTime()
      : bootTime;
    const scheduledTime = Math.max(nextAttemptMs, bootTime);

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
        } catch {
          throw Object.assign(new Error('task_not_found'), { reason: 'task_not_found' });
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
      deliveryQueue.schedule({
        webhookId: sub.id,
        eventId: latest.eventId,
        runId: latest.runId,
        type: latest.type,
        payloadBuilder,
        firstAttemptAt: new Date(latest.eventCreatedAt).getTime(),
        attempt: latest.outcome === 'pending' ? latest.attempt : latest.attempt + 1,
        nextAttemptAt: scheduledTime,
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
    } catch (err: any) {
      if (err?.isTransient) {
        console.warn(
          `[webhooks] boot reconstruction transient failure for delivery ${latest.eventId} / webhook ${latest.webhookId}, retaining pending state:`,
          err?.message,
        );
        // Do NOT append a permanent dead-letter row!
        // Leave the pending row intact in the delivery log for next boot/retry.
        continue;
      }

      deadLettered++;
      appendDeliveryLogRow({
        ts: new Date().toISOString(),
        webhookId: latest.webhookId,
        eventId: latest.eventId,
        runId: latest.runId,
        deliveryId: `dlv_${randomUUID()}`,
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
    }
  }

  return { reconstructed, deadLettered };
}
