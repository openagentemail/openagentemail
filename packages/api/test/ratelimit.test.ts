import { describe, expect, test } from 'bun:test';
import {
  MAX_WAITS_PER_ADDRESS,
  MAX_WAITS_TOTAL,
  acquireWaitSlot,
  checkMcpRateLimit,
  checkNotifyUserLimit,
  checkSendLimit,
  releaseNotifyUserLimit,
  releaseWaitSlot,
  resetMcpRateLimits,
  resetNotifyUserLimits,
  resetRateLimits,
  resetWaitSlots,
  slidingWindowCheck,
  slidingWindowRelease,
} from '../src/lib/ratelimit.ts';

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

describe('checkNotifyUserLimit', () => {
  test('uses an independent human-alert budget and refunds local failures', () => {
    resetRateLimits();
    resetNotifyUserLimits();
    checkSendLimit('agent@test.example', 1, 60_000, 10_000);
    expect(checkSendLimit('agent@test.example', 1, 60_000, 10_000).allowed).toBe(false);

    const granted = checkNotifyUserLimit('agent@test.example', 1, 60_000, 10_000);
    expect(granted.allowed).toBe(true);
    expect(checkNotifyUserLimit('agent@test.example', 1, 60_000, 10_000).allowed).toBe(false);
    releaseNotifyUserLimit('agent@test.example', granted.reservation);
    expect(checkNotifyUserLimit('agent@test.example', 1, 60_000, 10_000).allowed).toBe(true);
  });
});

describe('slidingWindow helper（send/notify/MCP 共用）', () => {
  test('check + release 不复制第三份窗口逻辑', () => {
    const map = new Map<string, number[]>();
    const now = 5_000;
    const a = slidingWindowCheck(map, 'k', 2, 60_000, now);
    expect(a.allowed).toBe(true);
    expect(slidingWindowCheck(map, 'k', 2, 60_000, now).allowed).toBe(true);
    expect(slidingWindowCheck(map, 'k', 2, 60_000, now).allowed).toBe(false);
    slidingWindowRelease(map, 'k', a.reservation);
    expect(slidingWindowCheck(map, 'k', 2, 60_000, now).allowed).toBe(true);
  });
});

describe('checkMcpRateLimit 读写分桶', () => {
  test('read/write 互不占额', () => {
    resetMcpRateLimits();
    const now = 2_000;
    expect(checkMcpRateLimit('g1', 'write', 1, 60_000, now).allowed).toBe(true);
    expect(checkMcpRateLimit('g1', 'write', 1, 60_000, now).allowed).toBe(false);
    expect(checkMcpRateLimit('g1', 'read', 1, 60_000, now).allowed).toBe(true);
  });
});

// 每个 POST /v1/messages/wait 都会占住一条 IMAP 长连接，最长 600 秒。
// 没有上限的话，一个身份令牌就能把 catch-all 账号的 Dovecot 连接名额占满，
// 让所有身份都读不了信。
describe('wait 并发槽位', () => {
  test('全局上限必须留在 Dovecot 默认每 IP 连接数（10）之下', () => {
    // 还要给 list / read 这类一次性连接留余量。
    expect(MAX_WAITS_TOTAL).toBeLessThanOrEqual(8);
    expect(MAX_WAITS_PER_ADDRESS).toBeLessThan(MAX_WAITS_TOTAL);
  });

  test('单个地址的并发 wait 有上限', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) {
      expect(acquireWaitSlot('a@x.com')).toBe(true);
    }
    expect(acquireWaitSlot('a@x.com')).toBe(false);
  });

  test('释放一个槽位后又能拿到', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) acquireWaitSlot('a@x.com');
    expect(acquireWaitSlot('a@x.com')).toBe(false);
    releaseWaitSlot('a@x.com');
    expect(acquireWaitSlot('a@x.com')).toBe(true);
  });

  test('地址大小写不同也算同一个身份', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) acquireWaitSlot('A@X.com');
    expect(acquireWaitSlot('a@x.com')).toBe(false);
  });

  test('一个地址占满不影响别的地址', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) acquireWaitSlot('a@x.com');
    expect(acquireWaitSlot('b@x.com')).toBe(true);
  });

  test('全局上限挡住"多身份齐上"的连接耗尽', () => {
    resetWaitSlots();
    let granted = 0;
    for (let i = 0; i < MAX_WAITS_TOTAL * 3; i++) {
      // 每个地址都只用一个槽位，只可能被全局上限挡住。
      if (acquireWaitSlot(`id-${i}@x.com`)) granted++;
    }
    expect(granted).toBe(MAX_WAITS_TOTAL);
  });

  test('释放不存在的槽位不会把计数弄成负数', () => {
    resetWaitSlots();
    releaseWaitSlot('ghost@x.com');
    releaseWaitSlot('ghost@x.com');
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) {
      expect(acquireWaitSlot('ghost@x.com')).toBe(true);
    }
    expect(acquireWaitSlot('ghost@x.com')).toBe(false);
  });
});
