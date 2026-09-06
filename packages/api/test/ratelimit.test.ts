import { describe, expect, test } from 'bun:test';
import {
  MAX_WAITS_PER_ADDRESS,
  MAX_WAITS_PER_SLOT,
  MAX_WAITS_TOTAL,
  acquireWaitSlot,
  checkMcpRateLimit,
  checkNotifyUserLimit,
  checkSendLimit,
  releaseNotifyUserLimit,
  releaseWaitSlot,
  checkMcpPreauthIpRateLimit,
  checkOauthIpRateLimit,
  checkDelegationDeniedAuditLimit,
  resetDelegationDeniedAuditLimits,
  DEFAULT_DELEGATION_DENIED_AUDIT_LIMIT,
  waitSlotKey,
  resetMcpPreauthIpRateLimits,
  resetMcpRateLimits,
  resetNotifyUserLimits,
  resetOauthIpRateLimits,
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

  test('grantId 键大小写敏感（不做 toLowerCase）', () => {
    resetMcpRateLimits();
    const now = 3_000;
    expect(checkMcpRateLimit('AbC_grant', 'write', 1, 60_000, now).allowed).toBe(true);
    // 不同大小写 = 不同桶，不得互相占额/错配
    expect(checkMcpRateLimit('abc_grant', 'write', 1, 60_000, now).allowed).toBe(true);
    expect(checkMcpRateLimit('AbC_grant', 'write', 1, 60_000, now).allowed).toBe(false);
  });
});

describe('预鉴权 IP 限量（oauth / mcp-preauth，复用 slidingWindow）', () => {
  test('两桶独立且走同一 helper', () => {
    resetOauthIpRateLimits();
    resetMcpPreauthIpRateLimits();
    const now = 9_000;
    expect(checkOauthIpRateLimit('1.2.3.4', 1, 60_000, now).allowed).toBe(true);
    expect(checkOauthIpRateLimit('1.2.3.4', 1, 60_000, now).allowed).toBe(false);
    // MCP 预鉴权桶不共享 OAuth 计数
    expect(checkMcpPreauthIpRateLimit('1.2.3.4', 1, 60_000, now).allowed).toBe(true);
  });
});

// 每个 POST /v1/messages/wait 都会占住一条 IMAP 长连接，最长 600 秒。
// 没有上限的话，一个身份令牌就能把 catch-all 账号的 Dovecot 连接名额占满，
// 让所有身份都读不了信。#136 R2 起是双约束并存：槽键 = caller+address
// （delegate 花自己的槽，不占 owner 的），同时每个 address 跨所有 caller
// 有全局上限（N 个受托方合伙也压不死一个信箱），外加实例级总量兜底。
describe('wait 并发槽位（双约束：caller+address 槽 × 每 address 全局）', () => {
  test('三层天花板满足 slot ≤ address < total ≤ 8（Dovecot 默认每 IP 10 连接）', () => {
    // 还要给 list / read 这类一次性连接留余量。
    expect(MAX_WAITS_TOTAL).toBeLessThanOrEqual(8);
    expect(MAX_WAITS_PER_ADDRESS).toBeLessThan(MAX_WAITS_TOTAL);
    expect(MAX_WAITS_PER_SLOT).toBeLessThanOrEqual(MAX_WAITS_PER_ADDRESS);
  });

  test('同一 caller 对同一地址的并发 wait 有槽位上限', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) {
      expect(acquireWaitSlot('a@x.com')).toBe(true);
    }
    expect(acquireWaitSlot('a@x.com')).toBe(false);
  });

  test('释放一个槽位后又能拿到', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) acquireWaitSlot('a@x.com');
    expect(acquireWaitSlot('a@x.com')).toBe(false);
    releaseWaitSlot('a@x.com');
    expect(acquireWaitSlot('a@x.com')).toBe(true);
  });

  test('地址大小写不同也算同一个身份', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) acquireWaitSlot('A@X.com');
    expect(acquireWaitSlot('a@x.com')).toBe(false);
  });

  test('一个地址占满不影响别的地址', () => {
    resetWaitSlots();
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) acquireWaitSlot('a@x.com');
    expect(acquireWaitSlot('b@x.com')).toBe(true);
  });

  test('每 address 全局上限 + owner 保留槽：受托合计最多 MAX-1，最后一槽留给 owner（Issue #136 R2/R3）', () => {
    resetWaitSlots();
    // N 个不同受托方各开 1 个 wait——谁都没碰到自己 slot=3 的上限——
    // 合计到 MAX_WAITS_PER_ADDRESS - 1 后，这个信箱对受托方关门。
    let granted = 0;
    for (let i = 0; i < MAX_WAITS_PER_ADDRESS; i++) {
      if (acquireWaitSlot(`delegate-${i}@x.com`, 'alice@x.com')) granted++;
    }
    expect(granted).toBe(MAX_WAITS_PER_ADDRESS - 1);

    // 新老受托方都被"受托合计上限"挡住（各自 slot 仍有余量）
    expect(acquireWaitSlot('yet-another@x.com', 'alice@x.com')).toBe(false);
    expect(acquireWaitSlot('delegate-0@x.com', 'alice@x.com')).toBe(false);

    // R3 必修（CR Major）：受托占满后 owner 本人仍可进——保留槽生效
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(true);
    // owner 拿走最后一槽后（合计已到 MAX），所有人都进不来，包括 owner 自己
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(false);
    expect(acquireWaitSlot('delegate-0@x.com', 'alice@x.com')).toBe(false);

    // 别的信箱不受影响
    expect(acquireWaitSlot('someone@x.com', 'bob@x.com')).toBe(true);

    // 释放 owner 的槽（合计回到 MAX-1）后，受托方仍被挡——保留槽不因
    // owner 不用而回收到受托方池子
    releaseWaitSlot('alice@x.com', 'alice@x.com');
    expect(acquireWaitSlot('yet-another@x.com', 'alice@x.com')).toBe(false);
    // 再释放一个受托名额（合计 MAX-2）后，受托方能补位
    releaseWaitSlot('delegate-0@x.com', 'alice@x.com');
    expect(acquireWaitSlot('yet-another@x.com', 'alice@x.com')).toBe(true);
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
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) {
      expect(acquireWaitSlot('ghost@x.com')).toBe(true);
    }
    expect(acquireWaitSlot('ghost@x.com')).toBe(false);
  });

  test('waitSlotKey 构造 caller+target 键并小写规范化', () => {
    expect(waitSlotKey('Alice@X.com')).toBe('alice@x.com');
    expect(waitSlotKey('Bob@X.com', 'Alice@X.com')).toBe('bob@x.com:alice@x.com');
    // 省略 target 与 target===caller 归一到同一个键（大小写/空白无关）
    expect(waitSlotKey('Alice@X.com', 'alice@x.com')).toBe('alice@x.com');
    expect(waitSlotKey(' Alice@X.com ', ' Alice@X.com ')).toBe('alice@x.com');
  });

  test('task wait 与 message wait 同 caller+mailbox 归一到同一槽桶，不拆桶绕上限（Issue #136 R5）', () => {
    resetWaitSlots();
    // tasks 路由形态（无 target）与 messages 路由 owner 形态（target=caller）
    // 必须合计计入同一个 slot 桶
    expect(acquireWaitSlot('alice@x.com')).toBe(true);
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(true);
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(true);
    // 两形态混用也封在 MAX_WAITS_PER_SLOT，而不是各得 3 个
    expect(acquireWaitSlot('alice@x.com')).toBe(false);
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(false);

    // delegate 形态（caller≠target）仍是独立桶，不受 owner 桶影响
    expect(acquireWaitSlot('bob@x.com', 'alice@x.com')).toBe(true);

    // 释放走任一形态都能还给同一个桶
    releaseWaitSlot('alice@x.com', 'alice@x.com');
    expect(acquireWaitSlot('alice@x.com')).toBe(true);
  });

  test('delegate 占满自己的槽不占 owner 的槽（Issue #136 Item 2 / R2）', () => {
    resetWaitSlots();
    // Bob (delegate) fills his OWN slot budget on Alice's mailbox
    for (let i = 0; i < MAX_WAITS_PER_SLOT; i++) {
      expect(acquireWaitSlot('bob@x.com', 'alice@x.com')).toBe(true);
    }
    // Bob's next wait is blocked by his own slot ceiling
    expect(acquireWaitSlot('bob@x.com', 'alice@x.com')).toBe(false);

    // Alice (owner) waits under her own caller+address key — Bob's slots
    // never spend HERS. Her ceiling here is the shared per-address budget
    // Bob already ate into (MAX_WAITS_PER_ADDRESS - MAX_WAITS_PER_SLOT = 2),
    // not her own slot budget (3): blocked by the global cap, not by Bob
    // squatting her slot key.
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(true);
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(true);
    expect(acquireWaitSlot('alice@x.com', 'alice@x.com')).toBe(false);

    // Releasing one of Bob's slots is NOT enough while Alice holds two:
    // combined 4 ≥ MAX-1 keeps delegates out — the reserve is unconditional,
    // owner-held slots don't fold back into the delegate budget (R3)
    releaseWaitSlot('bob@x.com', 'alice@x.com');
    expect(acquireWaitSlot('bob@x.com', 'alice@x.com')).toBe(false);
    releaseWaitSlot('alice@x.com', 'alice@x.com');
    expect(acquireWaitSlot('bob@x.com', 'alice@x.com')).toBe(true);
  });
});

describe('checkDelegationDeniedAuditLimit', () => {
  test('同 IP 在 60s 窗口内最多允许 10 次审计写入，超限后拒绝（Issue #136 Item 7）', () => {
    resetDelegationDeniedAuditLimits();
    const ip = '198.51.100.1';

    for (let i = 0; i < DEFAULT_DELEGATION_DENIED_AUDIT_LIMIT; i++) {
      const res = checkDelegationDeniedAuditLimit(ip);
      expect(res.allowed).toBe(true);
      expect(res.count).toBe(i + 1);
    }

    // 11th check is denied
    const blocked = checkDelegationDeniedAuditLimit(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);

    // Different IP has an independent window
    const other = checkDelegationDeniedAuditLimit('198.51.100.2');
    expect(other.allowed).toBe(true);

    // reset clears the limits
    resetDelegationDeniedAuditLimits();
    expect(checkDelegationDeniedAuditLimit(ip).allowed).toBe(true);
  });
});
