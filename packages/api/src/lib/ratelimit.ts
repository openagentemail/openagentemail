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
/** OAuth 预鉴权 IP 桶（/authorize、/oauth/token、/oauth/revoke）。 */
const oauthIpBuckets = new Map<string, number[]>();
/** MCP 预鉴权 IP 桶（无/坏 token 的 401 挑战路径）。 */
const mcpPreauthIpBuckets = new Map<string, number[]>();

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

/** 测试辅助：清空 send/审计 以及列表 caller 桶（不改生产配额）。 */
export function resetRateLimits(): void {
  buckets.clear();
  resetDelegationDeniedAuditLimits();
  resetListMessagesLimits();
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
 *
 * **键原样使用**——不 toLowerCase。grantId 是 base64url 大小写敏感随机串，
 * 小写化会造成碰撞/错配；address 由调用方先 `.toLowerCase()` 再传入。
 */
export function checkMcpRateLimit(
  key: string,
  bucket: McpRateBucket,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  const map = bucket === 'read' ? mcpReadBuckets : mcpWriteBuckets;
  return slidingWindowCheck(map, key, limit, windowMs, now);
}

/** 测试辅助：清空 MCP 读写桶。 */
export function resetMcpRateLimits(): void {
  mcpReadBuckets.clear();
  mcpWriteBuckets.clear();
}

/**
 * OAuth 公开端点预鉴权 IP 限量。键 = clientIp()（原样，不 toLowerCase）。
 * 复用唯一 slidingWindowCheck——禁止另写窗口。
 */
export function checkOauthIpRateLimit(
  ip: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  return slidingWindowCheck(oauthIpBuckets, ip, limit, windowMs, now);
}

/** 测试辅助：清空 OAuth IP 桶。 */
export function resetOauthIpRateLimits(): void {
  oauthIpBuckets.clear();
}

/**
 * /mcp 预鉴权（401 挑战）IP 限量。键 = clientIp()。
 * 仅无/坏 token 路径计费；已鉴权请求不进此桶。
 */
export function checkMcpPreauthIpRateLimit(
  ip: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  return slidingWindowCheck(mcpPreauthIpBuckets, ip, limit, windowMs, now);
}

/** 测试辅助：清空 MCP 预鉴权 IP 桶。 */
export function resetMcpPreauthIpRateLimits(): void {
  mcpPreauthIpBuckets.clear();
}

/** Delegation denied audit IP 桶（防非授权 token / OAuth 凭证刷爆审计日志）。 */
const delegationDeniedIpBuckets = new Map<string, number[]>();
export const DEFAULT_DELEGATION_DENIED_AUDIT_LIMIT = 10;

/**
 * 校验 delegation.grant.denied 审计写入限速（复用 slidingWindowCheck）。
 * 键为 clientIp。超限仅抑制 audit 落盘防刷盘，不改变 403 状态码。
 */
export function checkDelegationDeniedAuditLimit(
  ip: string,
  limit: number = DEFAULT_DELEGATION_DENIED_AUDIT_LIMIT,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  return slidingWindowCheck(delegationDeniedIpBuckets, ip, limit, windowMs, now);
}

/** 测试辅助：清空 delegation denied 审计 IP 桶。 */
export function resetDelegationDeniedAuditLimits(): void {
  delegationDeniedIpBuckets.clear();
}

/**
 * Concurrency slots for POST /v1/messages/wait.
 *
 * A wait holds one IMAP connection open for up to 600 s, and every identity
 * shares the single catch-all Dovecot account — so unbounded waits let one
 * caller exhaust that account's connection allowance and lock every other
 * identity out of its mail. Ceilings, checked together (Issue #136 R2/R3):
 *
 * - per caller+address slot: one token can't monopolize a mailbox it reads.
 *   Delegates wait on the owner's address under their OWN key, so a delegate
 *   never spends the owner's slot budget;
 * - per address, summed across ALL callers: N distinct delegates can't pool
 *   their slot budgets to squeeze one mailbox either. Delegates (caller ≠
 *   mailbox) top out at MAX_WAITS_PER_ADDRESS - 1 combined — the last slot
 *   on a mailbox is reserved for its owner (caller === address), so a full
 *   delegation fan-in still leaves the owner a way in (R3, CR Major);
 * - instance-wide total: stays under Dovecot's default
 *   mail_max_userip_connections (10) with room to spare for the short-lived
 *   list/read connections.
 *
 * A few concurrent waits per caller+address are legitimate (different filters),
 * so the per-slot ceiling is not 1; the per-address ceiling is higher still so
 * a delegate at its own ceiling leaves the owner room to wait.
 */
export const MAX_WAITS_PER_SLOT = 3;
export const MAX_WAITS_PER_ADDRESS = 5;
export const MAX_WAITS_TOTAL = 8;

const waits = new Map<string, number>();
const waitsPerAddress = new Map<string, number>();
let waitsTotal = 0;

/**
 * Build slot key: `${caller}:${targetAddress}` for a delegated wait, plain
 * caller otherwise. Omitting the target and passing target === caller MUST
 * produce the same key — the tasks route omits while a message wait on the
 * caller's own mailbox passes it explicitly, and two buckets for one
 * caller+mailbox pair would let a caller bypass the per-slot ceiling by
 * mixing the two routes (Issue #136 R5).
 */
export function waitSlotKey(caller: string, targetAddress?: string): string {
  const c = caller.trim().toLowerCase();
  const t = targetAddress?.trim().toLowerCase();
  if (!t || t === c) return c;
  return `${c}:${t}`;
}

/** 聚合键：被读信箱本身（无 target 时即 caller 自己的信箱）。 */
function waitAddressKey(caller: string, targetAddress?: string): string {
  return (targetAddress ?? caller).trim().toLowerCase();
}

/** Take a wait slot; false means the caller should be told 429. */
export function acquireWaitSlot(caller: string, targetAddress?: string): boolean {
  const key = waitSlotKey(caller, targetAddress);
  const addressKey = waitAddressKey(caller, targetAddress);
  if ((waits.get(key) ?? 0) >= MAX_WAITS_PER_SLOT) return false;
  // R3 owner reserve: delegates share MAX_WAITS_PER_ADDRESS - 1 at most, so
  // the mailbox's final slot is always left for the owner's own waits.
  const isOwner = waitAddressKey(caller) === addressKey;
  const addressCeiling = isOwner ? MAX_WAITS_PER_ADDRESS : MAX_WAITS_PER_ADDRESS - 1;
  if ((waitsPerAddress.get(addressKey) ?? 0) >= addressCeiling) return false;
  if (waitsTotal >= MAX_WAITS_TOTAL) return false;
  waits.set(key, (waits.get(key) ?? 0) + 1);
  waitsPerAddress.set(addressKey, (waitsPerAddress.get(addressKey) ?? 0) + 1);
  waitsTotal += 1;
  return true;
}

/** Give the slot back. Safe to call for a slot that was never taken. */
export function releaseWaitSlot(caller: string, targetAddress?: string): void {
  const key = waitSlotKey(caller, targetAddress);
  const current = waits.get(key) ?? 0;
  if (current <= 0) return;
  if (current === 1) waits.delete(key);
  else waits.set(key, current - 1);

  const addressKey = waitAddressKey(caller, targetAddress);
  const addressCount = waitsPerAddress.get(addressKey) ?? 0;
  if (addressCount <= 1) waitsPerAddress.delete(addressKey);
  else waitsPerAddress.set(addressKey, addressCount - 1);
  waitsTotal -= 1;
}

/** Test helper: drop all wait slots. */
export function resetWaitSlots(): void {
  waits.clear();
  waitsPerAddress.clear();
  waitsTotal = 0;
}

/**
 * GET /v1/messages 独立 caller 桶。
 * 与 send/MCP/wait 分图；只复用 slidingWindowCheck，不改那些桶。
 * 生产路径用进程单调流逝毫秒（performance.now），墙钟拨动不改窗口；重启清零。
 * 这不是全局 IMAP 并发保护。
 */
export const LIST_MESSAGES_LIMIT = 60;
export const LIST_MESSAGES_WINDOW_MS = 60_000;
export const LIST_MESSAGES_MAX_BUCKETS = 10_000;
/** 新 key 触顶且无法回收过期桶时的保守提示，不保证届时一定能入场。 */
export const LIST_MESSAGES_CAPACITY_RETRY_SEC = 60;

const listMessagesBuckets = new Map<string, number[]>();
let listMessagesTestNow: (() => number) | null = null;

/** 列表限速时钟：默认进程单调流逝毫秒；测试可整段替换。 */
export function listMessagesMonotonicNow(): number {
  if (listMessagesTestNow) return listMessagesTestNow();
  return performance.now();
}

/** 测试注入/清除列表限速时钟。 */
export function setListMessagesNowForTests(now: number | (() => number) | null): void {
  if (now === null) {
    listMessagesTestNow = null;
    return;
  }
  listMessagesTestNow = typeof now === 'function' ? now : () => now;
}

/**
 * 命名空间桶键：全部 admin 凭证共享 list:admin；
 * 同一 identity 地址（OAuth / oa_ 轮换）共享 list:id:<lowercased>。
 */
export function listMessagesCallerKey(auth: { kind: 'admin' } | { kind: 'identity'; address: string }): string {
  if (auth.kind === 'admin') return 'list:admin';
  return `list:id:${auth.address.trim().toLowerCase()}`;
}

/** 仅新 key 触顶时调用：回收空/过期桶，不驱逐仍有活戳的桶。 */
function reclaimExpiredListBuckets(now: number): void {
  const cutoff = now - LIST_MESSAGES_WINDOW_MS;
  for (const [key, stamps] of listMessagesBuckets) {
    const live = stamps.filter((t) => t > cutoff);
    if (live.length === 0) listMessagesBuckets.delete(key);
    else if (live.length !== stamps.length) listMessagesBuckets.set(key, live);
  }
}

/**
 * 录取 GET /v1/messages。已有 key 只滤本桶最多 60 个戳；
 * 新 key 遇满员才懒清理（最多扫 10000），仍满则 60s 保守提示。
 */
export function checkListMessagesLimit(
  key: string,
  now = listMessagesMonotonicNow(),
): RateLimitResult {
  if (!listMessagesBuckets.has(key) && listMessagesBuckets.size >= LIST_MESSAGES_MAX_BUCKETS) {
    reclaimExpiredListBuckets(now);
    if (listMessagesBuckets.size >= LIST_MESSAGES_MAX_BUCKETS) {
      return {
        allowed: false,
        retryAfterSec: LIST_MESSAGES_CAPACITY_RETRY_SEC,
        count: 0,
      };
    }
  }
  return slidingWindowCheck(
    listMessagesBuckets,
    key,
    LIST_MESSAGES_LIMIT,
    LIST_MESSAGES_WINDOW_MS,
    now,
  );
}

/** 测试辅助：清空列表桶与测试时钟注入。 */
export function resetListMessagesLimits(): void {
  listMessagesBuckets.clear();
  listMessagesTestNow = null;
}

/** 测试辅助：预置某一 caller 的时间戳（容量/回收矩阵）。 */
export function seedListMessagesBucketForTests(key: string, stamps: number[]): void {
  listMessagesBuckets.set(key, [...stamps]);
}

/** 测试辅助：当前桶数。 */
export function listMessagesBucketCountForTests(): number {
  return listMessagesBuckets.size;
}

/** 测试辅助：某 key 是否仍在图中（活桶不得被驱逐）。 */
export function listMessagesHasBucketForTests(key: string): boolean {
  return listMessagesBuckets.has(key);
}
