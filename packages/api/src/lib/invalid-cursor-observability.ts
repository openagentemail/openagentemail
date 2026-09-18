/**
 * #202 invalid_cursor 可观测性：四族共用拒收日志 helper。
 *
 * 隐私硬线：禁止输出游标原文 / 凭证 / 用户内容。
 * 标签集恰三枚封顶：{family, shape, within_retention}；shape 仅枚举值。
 * 分级：stale → info；anomaly → warn。
 *   - stale：形状合法且游标时间戳落在盘留存窗外（正常过期 / 翻页）
 *   - anomaly：malformed，或窗内 well-formed 但 unmatched（可能后端生成缺陷）
 * 判不准时按 stale（within_retention=false）记，不自创第三级。
 * within_retention 以盘留存窗为准，不用内存截断视图（#217）。
 * 未来时间戳（ts > now）：within_retention=true（语义上仍属「窗内」），走 warn，不得归 stale/info（R2 P1-2）。
 *
 * 结构校验边界（R2 P1-1 / R3）：
 *   软解析只按各族真实 codec 的**必填字段**收紧（缺任一键或类型不符 → malformed）。
 *   **不**做 zod `.strict()` 式额外字段拒绝，避免与 codec 双份漂移；
 *   多余键忽略；可选字段（如 mail-fcursor 的 `s`）仅在出现时做类型校验。
 *   mail v2 的 number 型 `v` 对齐 canonicalizeMailUidValidity：Number.isSafeInteger；
 *   string 型 `v` 仍走 BigInt（任意精度数字串照收）。
 *   deliveries 形状对齐生产可生成域：dlv_+规范 UUID（8-4-4-4-12）与 attempt≥1。
 */

import { config } from './config.ts';
import { SEND_LOG_RETENTION_MS } from './send-log.ts';
import {
  MAIL_CURSOR_PREFIX,
  MAIL_CURSOR_V1_PREFIX,
  MAIL_FORWARD_CURSOR_PREFIX,
  isMailFolder,
} from './mail-cursor.ts';
import {
  TASK_BOARD_CURSOR_PREFIX,
  TASK_CHILDREN_CURSOR_PREFIX,
} from './task-cursor.ts';

export type InvalidCursorFamily = 'deliveries' | 'messages' | 'send' | 'tasks';
export type InvalidCursorShape = 'full' | 'bare_id' | 'malformed';

export type InvalidCursorInspection = {
  shape: InvalidCursorShape;
  within_retention: boolean;
};

export type LogInvalidCursorRejectionInput = {
  family: InvalidCursorFamily;
  shape: InvalidCursorShape;
  within_retention: boolean;
};

/** 单行日志事件名（稳定，便于采集）。 */
export const INVALID_CURSOR_LOG_EVENT = 'invalid_cursor_rejected';

type LogSink = {
  info: (message?: unknown, ...optionalParams: unknown[]) => void;
  warn: (message?: unknown, ...optionalParams: unknown[]) => void;
};

let logSink: LogSink = console;

/** 测试注入日志 sink；传 undefined 恢复 console。 */
export function setInvalidCursorLogSinkForTests(sink?: LogSink): void {
  logSink = sink ?? console;
}

/**
 * stale=info；anomaly=warn。
 * anomaly = malformed | (well-formed ∧ within_retention)。
 */
export function classifyInvalidCursorLevel(
  shape: InvalidCursorShape,
  within_retention: boolean,
): 'info' | 'warn' {
  if (shape === 'malformed' || within_retention) return 'warn';
  return 'info';
}

/** 产出恰含三枚标签的单行 JSON 日志；永不写入游标原文。 */
export function logInvalidCursorRejection(input: LogInvalidCursorRejectionInput): void {
  const level = classifyInvalidCursorLevel(input.shape, input.within_retention);
  const line = JSON.stringify({
    event: INVALID_CURSOR_LOG_EVENT,
    family: input.family,
    shape: input.shape,
    within_retention: input.within_retention,
  });
  if (level === 'warn') logSink.warn(line);
  else logSink.info(line);
}

function retentionCutoffMs(retentionMs: number, now: number): number {
  return now - retentionMs;
}

/**
 * 游标时间戳是否落在盘留存窗内（含未来 ts）。
 * ts > now → true：未来戳本就「未出窗」，诚实归窗内 → 上层 warn，禁止 stale/info。
 */
function withinRetentionMs(ts: number, retentionMs: number, now: number): boolean {
  if (!Number.isFinite(ts)) return false;
  // R2 P1-2：未来时间戳不得归 stale
  if (ts > now) return true;
  // retentionDays=0 → 无界留存：凡过去/现在 ts 都算窗内
  if (!Number.isFinite(retentionMs)) return true;
  return ts >= retentionCutoffMs(retentionMs, now);
}

/** deliveries 盘留存窗（天 → ms）；读 config，避免写死。 */
function deliveriesRetentionMs(): number {
  return config.webhooks.logRetentionDays * 86_400_000;
}

/** messages / tasks 盘（邮件）留存窗。 */
function mailRetentionMs(): number {
  // retentionDays=0 表示不删 → 无界（Infinity）；withinRetentionMs 将过去 ts 视为窗内
  if (config.retentionDays <= 0) return Number.POSITIVE_INFINITY;
  return config.retentionDays * 86_400_000;
}

const DELIVERY_ID_RE =
  /^dlv_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** full = 规范 deliveryId | attempt≥1 | ts；非生产可生成域 → malformed（R3）。 */
const DELIVERY_FULL_RE =
  /^(dlv_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\|(\d+)\|(.+)$/;

/** 只读解析 deliveries 游标形状与盘留存窗归属；不验盘、不读内存索引。 */
export function inspectDeliveryCursor(
  cursor: string | undefined,
  now = Date.now(),
): InvalidCursorInspection {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return { shape: 'malformed', within_retention: false };
  }
  const full = DELIVERY_FULL_RE.exec(cursor);
  if (full) {
    // attempt 必须 ≥1 正整数（生产 attempt 自 1 起）
    const attempt = Number(full[2]);
    if (!Number.isInteger(attempt) || attempt < 1) {
      return { shape: 'malformed', within_retention: false };
    }
    const ts = Date.parse(full[3]!);
    if (!Number.isFinite(ts)) return { shape: 'malformed', within_retention: false };
    return {
      shape: 'full',
      within_retention: withinRetentionMs(ts, deliveriesRetentionMs(), now),
    };
  }
  if (DELIVERY_ID_RE.test(cursor)) {
    // bare_id 无时间戳：判不准 → 按 stale（within_retention=false）
    return { shape: 'bare_id', within_retention: false };
  }
  return { shape: 'malformed', within_retention: false };
}

/**
 * 软解 HMAC 游标 body（不验 MAC），只取结构与时间戳。
 * 解析失败 → null（调用方记 malformed）。
 */
function softParseHmacCursorBody(
  cursor: string,
  allowedPrefixes: readonly string[],
): { prefix: string; body: Record<string, unknown> } | null {
  const parts = cursor.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  if (!allowedPrefixes.includes(parts[0])) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { prefix: parts[0], body: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * mail codec 必填字段（对齐 decodeMailCursor / decodeMailForwardCursor；v1 无 v）。
 * 返回合法 t，否则 null。不拒绝多余键。
 */
function mailRequiredTimestamp(prefix: string, body: Record<string, unknown>): number | null {
  const { f, a, t, u, v, s } = body;
  if (typeof f !== 'string' || !isMailFolder(f)) return null;
  if (typeof a !== 'string' || !a.includes('@')) return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof u !== 'number' || !Number.isInteger(u) || u <= 0) return null;
  if (prefix === MAIL_CURSOR_V1_PREFIX) {
    // 退役 v1：必填 f/a/t/u，无 v
    return t;
  }
  // v2 / fcursor：必填 v。string 分支对齐生产 BigInt 任意精度数字串；
  // v2 number 分支对齐 canonicalizeMailUidValidity：Number.isSafeInteger（R3 P1）。
  // fcursor number 分支对齐 decodeMailForwardCursor：Number.isInteger。
  let vOk = false;
  if (typeof v === 'string' && /^\d+$/.test(v) && BigInt(v) > 0n) {
    vOk = true;
  } else if (typeof v === 'number' && v > 0) {
    if (prefix === MAIL_CURSOR_PREFIX) {
      vOk = Number.isSafeInteger(v);
    } else if (prefix === MAIL_FORWARD_CURSOR_PREFIX) {
      vOk = Number.isInteger(v);
    }
  }
  if (!vOk) return null;
  if (prefix === MAIL_FORWARD_CURSOR_PREFIX) {
    // 前向 codec：t 须为非负整数；可选 s
    if (!Number.isInteger(t) || t < 0) return null;
    if (s !== undefined && (typeof s !== 'number' || !Number.isInteger(s) || s < 0)) return null;
  }
  return t;
}

/**
 * send-log codec 必填：addr / t / id（对齐 decodeCursor；addr 允许空串）。
 * 不拒绝多余键。
 */
function sendRequiredTimestamp(body: Record<string, unknown>): number | null {
  if (!Object.hasOwn(body, 'addr') || !Object.hasOwn(body, 't') || !Object.hasOwn(body, 'id')) {
    return null;
  }
  const { addr, t, id } = body;
  if (typeof addr !== 'string') return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof id !== 'string' || !id) return null;
  return t;
}

/**
 * task board/children codec 必填：fp / t / id（对齐 decodeTask*Cursor）。
 * 不拒绝多余键（children 生产 codec 虽禁多余，观测侧不双份 strict）。
 */
function taskRequiredTimestamp(body: Record<string, unknown>): number | null {
  if (!Object.hasOwn(body, 'fp') || !Object.hasOwn(body, 't') || !Object.hasOwn(body, 'id')) {
    return null;
  }
  const { fp, t, id } = body;
  if (typeof fp !== 'string' || !fp) return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof id !== 'string' || !id) return null;
  return t;
}

/** messages：后向 v2 / 退役 v1 / 前向 fcursor；无 bare_id。 */
export function inspectMailCursor(
  cursor: string | undefined,
  now = Date.now(),
): InvalidCursorInspection {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    // 无游标仍 invalid_cursor（如缺 UIDVALIDITY）→ 偏 anomaly
    return { shape: 'malformed', within_retention: false };
  }
  const soft = softParseHmacCursorBody(cursor, [
    MAIL_CURSOR_PREFIX,
    MAIL_CURSOR_V1_PREFIX,
    MAIL_FORWARD_CURSOR_PREFIX,
  ]);
  if (!soft) return { shape: 'malformed', within_retention: false };
  const t = mailRequiredTimestamp(soft.prefix, soft.body);
  if (t === null) return { shape: 'malformed', within_retention: false };
  return { shape: 'full', within_retention: withinRetentionMs(t, mailRetentionMs(), now) };
}

/** send-log HMAC 游标；无 bare_id。 */
export function inspectSendCursor(
  cursor: string | undefined,
  now = Date.now(),
): InvalidCursorInspection {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return { shape: 'malformed', within_retention: false };
  }
  const soft = softParseHmacCursorBody(cursor, ['send-log-cursor-v1']);
  if (!soft) return { shape: 'malformed', within_retention: false };
  const t = sendRequiredTimestamp(soft.body);
  if (t === null) return { shape: 'malformed', within_retention: false };
  return {
    shape: 'full',
    within_retention: withinRetentionMs(t, SEND_LOG_RETENTION_MS, now),
  };
}

/** tasks 板/子树 HMAC 游标；可见窗与盘留存对齐用邮件留存天（默认 30d）。 */
export function inspectTaskCursor(
  cursor: string | undefined,
  now = Date.now(),
): InvalidCursorInspection {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    return { shape: 'malformed', within_retention: false };
  }
  const soft = softParseHmacCursorBody(cursor, [
    TASK_BOARD_CURSOR_PREFIX,
    TASK_CHILDREN_CURSOR_PREFIX,
  ]);
  if (!soft) return { shape: 'malformed', within_retention: false };
  const t = taskRequiredTimestamp(soft.body);
  if (t === null) return { shape: 'malformed', within_retention: false };
  return { shape: 'full', within_retention: withinRetentionMs(t, mailRetentionMs(), now) };
}

/** 按族分流的检验入口，路由 catch 一处调用。 */
export function inspectInvalidCursor(
  family: InvalidCursorFamily,
  cursor: string | undefined,
  now = Date.now(),
): InvalidCursorInspection {
  switch (family) {
    case 'deliveries':
      return inspectDeliveryCursor(cursor, now);
    case 'messages':
      return inspectMailCursor(cursor, now);
    case 'send':
      return inspectSendCursor(cursor, now);
    case 'tasks':
      return inspectTaskCursor(cursor, now);
  }
}

/** 检验 + 打日志一步到位（路由拒收点）。 */
export function logInvalidCursorRejectionFor(
  family: InvalidCursorFamily,
  cursor: string | undefined,
  now = Date.now(),
): void {
  const inspected = inspectInvalidCursor(family, cursor, now);
  logInvalidCursorRejection({ family, ...inspected });
}
