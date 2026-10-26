/**
 * 自动回复一对一冷却。只服务 POST /v1/send 且 autoReply === true。
 * 键 = 发件身份 × 收件人，两边都只做 trim + 小写（不剥 +tag，不合并点号）。
 * 发件身份与每小时额度同一语义：父代子发信时用子地址。
 *
 * 检查和占位在同一次同步调用里完成，SMTP 之前就挡住同一对。
 * 内存表有上限。只丢掉已经到期的正式冷却；未过期项和进行中的占位都不逐出。
 * 放不下新对时拒绝这次发送。拒绝不写 send-log：信没有交到 SMTP，重建只认 result === "queued"。
 */

/** 冷却表上限。发送日志本身最多一万行，一对一窗口只有几分钟。 */
export const AUTO_REPLY_COOLDOWN_MAX_PAIRS = 10_000;

type CooldownHit = {
  blocked: boolean;
  /** 被挡住的那些对里，剩余秒数的最大值（向上取整，至少 1）。未挡住时为 0。 */
  retryAfterSec: number;
};

/** 进行中的占位。id 为 0 表示这次没有占位（冷却关闭）。 */
export type AutoReplyCooldownReservation = {
  id: number;
  keys: readonly string[];
};

export type AutoReplyCooldownReservationResult =
  | { reserved: true; reservation: AutoReplyCooldownReservation }
  | { reserved: false; retryAfterSec: number };

type CooldownEntry = {
  /** 正式冷却的截止时间；占位期间是预留窗口，完成时会改成完成时刻 + 冷却。 */
  until: number;
  /** 有值表示这格仍属于某次占位，不能当过期项丢掉，也不能被别的释放清掉。 */
  reservationId?: number;
};

const pairs = new Map<string, CooldownEntry>();
let nowFn: () => number = () => Date.now();
let maxPairs = AUTO_REPLY_COOLDOWN_MAX_PAIRS;
let nextReservationId = 1;

const EMPTY_RESERVATION: AutoReplyCooldownReservation = { id: 0, keys: [] };

/** 只去掉首尾空白并小写。保留 +tag 和本地部分里的点。 */
export function normalizeCooldownAddress(address: string): string {
  return address.trim().toLowerCase();
}

function pairKey(sender: string, recipient: string): string {
  return `${normalizeCooldownAddress(sender)}\n${normalizeCooldownAddress(recipient)}`;
}

function uniquePairKeys(from: string, recipients: readonly string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const key = pairKey(from, recipient);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** 只删到期的正式冷却。占位没有完成或释放之前，就算预留窗口过了也留着。 */
function dropExpired(now: number): void {
  for (const [key, entry] of pairs) {
    if (entry.reservationId !== undefined) continue;
    if (entry.until <= now) pairs.delete(key);
  }
}

function retryAfterSecFromMs(remainMs: number): number {
  return Math.max(1, Math.ceil(remainMs / 1000));
}

/**
 * 占位至少挡住 1 秒（预留窗口还在就用剩余时间）。
 * 正式冷却到期后不再挡住。
 */
function blockingRemainMs(entry: CooldownEntry, now: number): number | undefined {
  if (entry.reservationId !== undefined) return Math.max(entry.until - now, 1_000);
  if (entry.until <= now) return undefined;
  return entry.until - now;
}

/** 表满时告诉调用方最早一格什么时候空出来。没有可等的格子时用配置的冷却秒数。 */
function earliestExpiryRetryAfterSec(now: number, cooldownSec: number): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of pairs.values()) {
    if (entry.until < earliest) earliest = entry.until;
  }
  if (!Number.isFinite(earliest)) return Math.max(1, cooldownSec);
  return retryAfterSecFromMs(earliest - now);
}

/**
 * 窗口内是否已有任意一对仍在冷却或占位。cooldownSec <= 0 时不读表。
 * 调用方只应在 autoReply === true 时进来。这是只读检查，发信路径用 checkAndReserve。
 */
export function checkAutoReplyCooldown(
  from: string,
  recipients: readonly string[],
  cooldownSec: number,
): CooldownHit {
  if (cooldownSec <= 0) return { blocked: false, retryAfterSec: 0 };
  const now = nowFn();
  dropExpired(now);
  let maxRemainMs = 0;
  let blocked = false;
  for (const recipient of recipients) {
    const entry = pairs.get(pairKey(from, recipient));
    if (!entry) continue;
    const remain = blockingRemainMs(entry, now);
    if (remain === undefined) continue;
    blocked = true;
    if (remain > maxRemainMs) maxRemainMs = remain;
  }
  if (!blocked) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: retryAfterSecFromMs(maxRemainMs) };
}

/**
 * 同一步里检查并占住全部归一化后的对，中间没有 await。
 * 任一对立刻拒绝，不写新占位。放不下新对也整批拒绝，不挤掉未过期项。
 * cooldownSec <= 0 时不读不写，返回空票。
 */
export function checkAndReserveAutoReplyCooldown(
  from: string,
  recipients: readonly string[],
  cooldownSec: number,
): AutoReplyCooldownReservationResult {
  if (cooldownSec <= 0) return { reserved: true, reservation: EMPTY_RESERVATION };
  const now = nowFn();
  dropExpired(now);
  const keys = uniquePairKeys(from, recipients);
  let maxRemainMs = 0;
  let blocked = false;
  for (const key of keys) {
    const entry = pairs.get(key);
    if (!entry) continue;
    const remain = blockingRemainMs(entry, now);
    if (remain === undefined) continue;
    blocked = true;
    if (remain > maxRemainMs) maxRemainMs = remain;
  }
  if (blocked) return { reserved: false, retryAfterSec: retryAfterSecFromMs(maxRemainMs) };
  if (pairs.size + keys.length > maxPairs) {
    return { reserved: false, retryAfterSec: earliestExpiryRetryAfterSec(now, cooldownSec) };
  }
  const id = nextReservationId;
  nextReservationId += 1;
  const until = now + cooldownSec * 1000;
  for (const key of keys) pairs.set(key, { until, reservationId: id });
  return { reserved: true, reservation: { id, keys } };
}

/**
 * 只删掉仍属于这张票的占位。
 * 已经完成的冷却、或被更新的占位接过去的格子，都留着。
 */
export function releaseAutoReplyCooldownReservation(
  reservation: AutoReplyCooldownReservation | undefined,
): void {
  if (!reservation || reservation.id === 0) return;
  for (const key of reservation.keys) {
    const entry = pairs.get(key);
    if (!entry || entry.reservationId !== reservation.id) continue;
    pairs.delete(key);
  }
}

/**
 * SMTP 已接受，或对端已经返回错误应答：截止时间改为完成时刻 + 冷却。
 * 只改这张票仍持有的格子。连接类失败不要调用，改走 release。
 */
export function finalizeAutoReplyCooldownReservation(
  reservation: AutoReplyCooldownReservation | undefined,
  cooldownSec: number,
): void {
  if (!reservation || reservation.id === 0 || cooldownSec <= 0) return;
  const now = nowFn();
  const until = now + cooldownSec * 1000;
  for (const key of reservation.keys) {
    const entry = pairs.get(key);
    if (!entry || entry.reservationId !== reservation.id) continue;
    pairs.set(key, { until });
  }
}

/**
 * 直接写入正式冷却。测试用来种一行，不经过占位。
 * 新增的对放不下时整批不写，避免挤掉还在生效的格子。
 * cooldownSec <= 0 时不写表。
 */
export function recordAutoReplyCooldown(
  from: string,
  recipients: readonly string[],
  cooldownSec: number,
): void {
  if (cooldownSec <= 0) return;
  const now = nowFn();
  dropExpired(now);
  const until = now + cooldownSec * 1000;
  const keys = uniquePairKeys(from, recipients);
  let additions = 0;
  for (const key of keys) {
    if (!pairs.has(key)) additions += 1;
  }
  if (pairs.size + additions > maxPairs) return;
  for (const key of keys) {
    const prev = pairs.get(key);
    if (prev?.reservationId !== undefined) {
      pairs.set(key, { until: Math.max(prev.until, until), reservationId: prev.reservationId });
      continue;
    }
    pairs.set(key, { until: prev === undefined ? until : Math.max(prev.until, until) });
  }
}

export type AutoReplyCooldownReplayRow = {
  from: string;
  to: readonly string[];
  result: string;
  sentAt: string;
  autoReply?: boolean;
};

/**
 * 用发送日志重建冷却表。只留窗口内 autoReply === true 且 result === "queued" 的行。
 * sentAt 在未来的行忽略（与每小时额度同一边界：sentAt > now）。
 * 恰好到期（sentAt + 冷却 <= now）不留。同一对保留更晚的截止时间。
 * 超过上限时留最晚到期的那些对，不按到达顺序挤掉更长的冷却。
 * cooldownSec <= 0 时清空表，不回放。
 */
export function rebuildAutoReplyCooldownFromRecords(
  records: readonly AutoReplyCooldownReplayRow[],
  cooldownSec: number,
  now = nowFn(),
): void {
  pairs.clear();
  if (cooldownSec <= 0) return;
  const windowMs = cooldownSec * 1000;
  const fresh = new Map<string, number>();
  for (const row of records) {
    if (row.autoReply !== true || row.result !== 'queued') continue;
    const sentAt = Date.parse(row.sentAt);
    // 与 rebuildSendLimitFromRecords 一样：未来时间戳不占冷却。
    if (!Number.isFinite(sentAt) || sentAt > now) continue;
    const until = sentAt + windowMs;
    if (until <= now) continue;
    for (const recipient of row.to) {
      const key = pairKey(row.from, recipient);
      const prev = fresh.get(key);
      if (prev === undefined || until > prev) fresh.set(key, until);
    }
  }
  const ranked = [...fresh.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const kept = ranked.length > maxPairs ? ranked.slice(0, maxPairs) : ranked;
  for (const [key, until] of kept) pairs.set(key, { until });
}

/** 测试辅助：当前表大小（先丢掉过期的正式冷却；占位仍计数）。 */
export function autoReplyCooldownSizeForTests(): number {
  dropExpired(nowFn());
  return pairs.size;
}

/** 测试注入/清除冷却时钟。null 恢复 Date.now。 */
export function setAutoReplyCooldownNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** 测试辅助：收紧或恢复表上限。 */
export function setAutoReplyCooldownCapForTests(cap: number | null): void {
  maxPairs = cap ?? AUTO_REPLY_COOLDOWN_MAX_PAIRS;
}

/** 测试辅助：清空冷却表、时钟和上限。占位号不回绕，避免旧票碰上新占位。 */
export function resetAutoReplyCooldownForTests(): void {
  pairs.clear();
  nowFn = () => Date.now();
  maxPairs = AUTO_REPLY_COOLDOWN_MAX_PAIRS;
}
