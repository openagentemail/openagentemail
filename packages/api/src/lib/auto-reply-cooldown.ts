/**
 * 自动回复一对一冷却。只服务 POST /v1/send 且 autoReply === true。
 * 键 = 发件身份 × 收件人，两边都只做 trim + 小写（不剥 +tag，不合并点号）。
 * 发件身份与每小时额度同一语义：父代子发信时用子地址。
 *
 * 内存表有上限。过期项会丢掉；仍超出上限时丢掉最先到期的项。
 * 拒绝不写 send-log：信没有交到 SMTP，重建只认 result === "queued"。
 */

/** 冷却表上限。发送日志本身最多一万行，一对一窗口只有几分钟。 */
export const AUTO_REPLY_COOLDOWN_MAX_PAIRS = 10_000;

type CooldownHit = {
  blocked: boolean;
  /** 被挡住的那些对里，剩余秒数的最大值（向上取整，至少 1）。未挡住时为 0。 */
  retryAfterSec: number;
};

const pairs = new Map<string, number>();
let nowFn: () => number = () => Date.now();
let maxPairs = AUTO_REPLY_COOLDOWN_MAX_PAIRS;

/** 只去掉首尾空白并小写。保留 +tag 和本地部分里的点。 */
export function normalizeCooldownAddress(address: string): string {
  return address.trim().toLowerCase();
}

function pairKey(sender: string, recipient: string): string {
  return `${normalizeCooldownAddress(sender)}\n${normalizeCooldownAddress(recipient)}`;
}

function prune(now: number): void {
  for (const [key, until] of pairs) {
    if (until <= now) pairs.delete(key);
  }
  if (pairs.size <= maxPairs) return;
  const ranked = [...pairs.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  for (const [key] of ranked) {
    if (pairs.size <= maxPairs) break;
    pairs.delete(key);
  }
}

/**
 * 窗口内是否已有任意一对仍在冷却。cooldownSec <= 0 时不读表。
 * 调用方只应在 autoReply === true 时进来。
 */
export function checkAutoReplyCooldown(
  from: string,
  recipients: readonly string[],
  cooldownSec: number,
): CooldownHit {
  if (cooldownSec <= 0) return { blocked: false, retryAfterSec: 0 };
  const now = nowFn();
  prune(now);
  let maxRemainMs = 0;
  let blocked = false;
  for (const recipient of recipients) {
    const until = pairs.get(pairKey(from, recipient));
    if (until === undefined || until <= now) continue;
    blocked = true;
    const remain = until - now;
    if (remain > maxRemainMs) maxRemainMs = remain;
  }
  if (!blocked) return { blocked: false, retryAfterSec: 0 };
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(maxRemainMs / 1000)) };
}

/**
 * SMTP 已接受，或对端已经返回错误应答时记入冷却。
 * 连接类失败不要调用。cooldownSec <= 0 时不写表。
 * 只改内存，不等发送日志追加成功。
 */
export function recordAutoReplyCooldown(
  from: string,
  recipients: readonly string[],
  cooldownSec: number,
): void {
  if (cooldownSec <= 0) return;
  const now = nowFn();
  const until = now + cooldownSec * 1000;
  for (const recipient of recipients) {
    const key = pairKey(from, recipient);
    const prev = pairs.get(key);
    pairs.set(key, prev === undefined ? until : Math.max(prev, until));
  }
  prune(now);
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
 * 同一对保留更晚的截止时间。cooldownSec <= 0 时清空表，不回放。
 */
export function rebuildAutoReplyCooldownFromRecords(
  records: readonly AutoReplyCooldownReplayRow[],
  cooldownSec: number,
  now = nowFn(),
): void {
  pairs.clear();
  if (cooldownSec <= 0) return;
  const windowMs = cooldownSec * 1000;
  for (const row of records) {
    if (row.autoReply !== true || row.result !== 'queued') continue;
    const sentAt = Date.parse(row.sentAt);
    if (!Number.isFinite(sentAt)) continue;
    const until = sentAt + windowMs;
    if (until <= now) continue;
    for (const recipient of row.to) {
      const key = pairKey(row.from, recipient);
      const prev = pairs.get(key);
      if (prev === undefined || until > prev) pairs.set(key, until);
    }
  }
  prune(now);
}

/** 测试辅助：当前表大小（含尚未被 prune 的过期项，调用前会先 prune）。 */
export function autoReplyCooldownSizeForTests(): number {
  prune(nowFn());
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

/** 测试辅助：清空冷却表、时钟和上限。 */
export function resetAutoReplyCooldownForTests(): void {
  pairs.clear();
  nowFn = () => Date.now();
  maxPairs = AUTO_REPLY_COOLDOWN_MAX_PAIRS;
}
