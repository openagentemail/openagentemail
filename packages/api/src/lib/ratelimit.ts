/**
 * Per-address send rate limiting. In-memory sliding window — resets on
 * process restart, which is acceptable for a guard whose job is to stop a
 * runaway agent or a leaked token from turning the box into a spam cannon,
 * not to enforce billing-grade quotas.
 *
 * Identities each get their own window, so one misbehaving agent can't
 * starve the others.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest message in the window expires (0 if allowed). */
  retryAfterSec: number;
  /** Messages sent within the current window (after counting this one). */
  count: number;
}

const buckets = new Map<string, number[]>();

export function checkSendLimit(
  address: string,
  limit: number,
  windowMs = 3_600_000,
  now = Date.now(),
): RateLimitResult {
  if (limit <= 0) return { allowed: true, retryAfterSec: 0, count: 0 };

  const key = address.toLowerCase();
  const cutoff = now - windowMs;
  const stamps = (buckets.get(key) ?? []).filter((t) => t > cutoff);

  if (stamps.length >= limit) {
    const retryAfterSec = Math.ceil((stamps[0] + windowMs - now) / 1000);
    buckets.set(key, stamps);
    return { allowed: false, retryAfterSec, count: stamps.length };
  }

  stamps.push(now);
  buckets.set(key, stamps);
  return { allowed: true, retryAfterSec: 0, count: stamps.length };
}

/** Test helper: wipe all windows. */
export function resetRateLimits(): void {
  buckets.clear();
}
