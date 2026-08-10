/**
 * Per-address / per-grant rate limiting. In-memory sliding window — resets on
 * process restart, which is acceptable for a guard whose job is to stop a
 * runaway agent or a leaked token from turning the box into a spam cannon,
 * not to enforce billing-grade quotas.
 *
 * Identities each get their own window, so one misbehaving agent can't
 * starve the others. MCP 读写分桶与 send/notifyUser 共用下方 slidingWindow*
 * helper——禁止再复制第三份窗口逻辑。
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest message in the window expires (0 if allowed). */
  retryAfterSec: number;
  /** Messages sent within the current window (after counting this one). */
  count: number;
  /** Handle for release*Limit(), set only when the send was allowed. */
  reservation?: number;
}

/**
 * 共享滑动窗口：从 buckets[key] 滤掉过期戳，超限则拒绝并回写；
 * 否则 push(now) 并返回 reservation。
 */
export function slidingWindowCheck(
  buckets: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitResult {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0, count: 0 };

  const cutoff = now - windowMs;
  const stamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (stamps.length >= limit) {
    const retryAfterSec = Math.ceil((stamps[0]! + windowMs - now) / 1000);
    buckets.set(key, stamps);
    return { allowed: false, retryAfterSec, count: stamps.length };
  }

  stamps.push(now);
  buckets.set(key, stamps);
  return { allowed: true, retryAfterSec: 0, count: stamps.length, reservation: now };
}

/** 退还一次 reservation（仅本地失败、请求未达下游时）。 */
export function slidingWindowRelease(
  buckets: Map<string, number[]>,
  key: string,
  reservation: number | undefined,
): void {
  if (reservation === undefined) return;
  const stamps = buckets.get(key);
  if (!stamps) return;
  const index = stamps.lastIndexOf(reservation);
  if (index < 0) return;
  stamps.splice(index, 1);
  if (stamps.length === 0) buckets.delete(key);
}

const buckets = new Map<string, number[]>();
const notifyUserBuckets = new Map<string, number[]>();
/** MCP 读桶（read 级 tools/call）。 */
const mcpReadBuckets = new Map<string, number[]>();
/** MCP 写桶（minimal+ 级 tools/call）。 */
const mcpWriteBuckets = new Map<string, number[]>();

export function checkSendLimit(
  address: string,
  limit: number,
  windowMs = 3_600_000,
  now = Date.now(),
): RateLimitResult {
  return slidingWindowCheck(buckets, address.toLowerCase(), limit, windowMs, now);
}

/**
 * Hand a slot back. Only for failures that never reached the mail server —
 * see isLocalSendFailure(); refunding rejected deliveries would let a caller
 * retry forever without ever spending quota.
 */
export function releaseSendLimit(address: string, reservation: number | undefined): void {
  slidingWindowRelease(buckets, address.toLowerCase(), reservation);
}

/** Test helper: wipe all windows. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * Separate budget for human-alert notifications. This is deliberately not
 * shared with mail_send: one action wakes a person rather than sending mail,
 * so a mail allowance is the wrong safety boundary.
 */
export function checkNotifyUserLimit(
  address: string,
  limit: number,
  windowMs = 3_600_000,
  now = Date.now(),
): RateLimitResult {
  return slidingWindowCheck(
    notifyUserBuckets,
    address.toLowerCase(),
    limit,
    windowMs,
    now,
  );
}

/** Return a user-notification slot when no request reached ntfy. */
export function releaseNotifyUserLimit(address: string, reservation: number | undefined): void {
  slidingWindowRelease(notifyUserBuckets, address.toLowerCase(), reservation);
}

/** Test helper: wipe the independent human-notification budget. */
export function resetNotifyUserLimits(): void {
  notifyUserBuckets.clear();
}

export type McpRateBucket = 'read' | 'write';

/**
 * MCP per-token 限量：OAuth 用 grantId、oa_ 用 address 作 key；
 * admin 由调用方豁免（不进此函数）。读写两桶独立。
 * 默认窗口 60s（env 单位是 per-minute）。
 */
export function checkMcpRateLimit(
  key: string,
  bucket: McpRateBucket,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  const map = bucket === 'read' ? mcpReadBuckets : mcpWriteBuckets;
  return slidingWindowCheck(map, key.toLowerCase(), limit, windowMs, now);
}

/** 测试辅助：清空 MCP 读写桶。 */
export function resetMcpRateLimits(): void {
  mcpReadBuckets.clear();
  mcpWriteBuckets.clear();
}

/**
 * Concurrency slots for POST /v1/messages/wait.
 *
 * A wait holds one IMAP connection open for up to 600 s, and every identity
 * shares the single catch-all Dovecot account — so unbounded waits let one
 * caller exhaust that account's connection allowance and lock every other
 * identity out of its mail. Two ceilings: per address (stops one token from
 * doing it alone) and global (stops several tokens from doing it together).
 *
 * The global ceiling stays under Dovecot's default mail_max_userip_connections
 * (10) with room to spare for the short-lived list/read connections.
 * A few concurrent waits per address are legitimate (different filters), so
 * the per-address ceiling is not 1.
 */
export const MAX_WAITS_PER_ADDRESS = 3;
export const MAX_WAITS_TOTAL = 8;

const waits = new Map<string, number>();
let waitsTotal = 0;

/** Take a wait slot; false means the caller should be told 429. */
export function acquireWaitSlot(address: string): boolean {
  const key = address.toLowerCase();
  const current = waits.get(key) ?? 0;
  if (current >= MAX_WAITS_PER_ADDRESS || waitsTotal >= MAX_WAITS_TOTAL) return false;
  waits.set(key, current + 1);
  waitsTotal += 1;
  return true;
}

/** Give the slot back. Safe to call for a slot that was never taken. */
export function releaseWaitSlot(address: string): void {
  const key = address.toLowerCase();
  const current = waits.get(key) ?? 0;
  if (current <= 0) return;
  if (current === 1) waits.delete(key);
  else waits.set(key, current - 1);
  waitsTotal -= 1;
}

/** Test helper: drop all wait slots. */
export function resetWaitSlots(): void {
  waits.clear();
  waitsTotal = 0;
}
