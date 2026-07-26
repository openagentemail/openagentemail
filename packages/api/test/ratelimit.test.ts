import { describe, expect, test } from 'bun:test';
import { checkSendLimit, resetRateLimits } from '../src/lib/ratelimit.ts';

describe('checkSendLimit', () => {
  test('allows up to the limit, then blocks with retryAfter', () => {
    resetRateLimits();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = checkSendLimit('a@x.com', 3, 60_000, now);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i + 1);
    }
    const blocked = checkSendLimit('a@x.com', 3, 60_000, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  test('windows slide: oldest expiry frees a slot', () => {
    resetRateLimits();
    const t0 = 1_000_000;
    checkSendLimit('a@x.com', 2, 60_000, t0);
    checkSendLimit('a@x.com', 2, 60_000, t0 + 30_000);
    expect(checkSendLimit('a@x.com', 2, 60_000, t0 + 30_000).allowed).toBe(false);
    // At t0+61s the first send has aged out.
    const r = checkSendLimit('a@x.com', 2, 60_000, t0 + 61_000);
    expect(r.allowed).toBe(true);
  });

  test('identities have independent windows', () => {
    resetRateLimits();
    checkSendLimit('a@x.com', 1, 60_000);
    expect(checkSendLimit('a@x.com', 1, 60_000).allowed).toBe(false);
    expect(checkSendLimit('b@x.com', 1, 60_000).allowed).toBe(true);
  });

  test('address matching is case-insensitive', () => {
    resetRateLimits();
    checkSendLimit('A@x.com', 1, 60_000);
    expect(checkSendLimit('a@X.com', 1, 60_000).allowed).toBe(false);
  });

  test('limit 0 disables the guard', () => {
    resetRateLimits();
    for (let i = 0; i < 50; i++) {
      expect(checkSendLimit('a@x.com', 0, 60_000).allowed).toBe(true);
    }
  });
});
