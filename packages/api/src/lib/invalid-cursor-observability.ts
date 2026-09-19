/**
 * #202 / #270 invalid_cursor 可观测性：四族共用拒收日志 helper。
 *
 * 根治（#270）：路由把 decoder 真实错误种类（parse_fail / lookup_miss）直传；
 * 不再从游标字符串软解反推形状——软解收紧段全部退役。
 *
 * 隐私硬线：禁止输出游标原文 / 凭证 / 用户内容。
 * 标签集恰三枚封顶：{family, shape, within_retention}；shape 仅枚举值。
 * 分级：stale → info；anomaly → warn。
 *   - stale：lookup_miss 且游标时间戳落在盘留存窗外（正常过期 / 翻页）
 *   - anomaly：parse_fail（malformed），或窗内 lookup_miss（可能后端生成缺陷）
 * 判不准时（lookup_miss 无 cursorTs，如 bare_id）按 stale（within_retention=false）。
 * within_retention 以盘留存窗为准，不用内存截断视图（#217）。
 * 未来时间戳（ts > now）：within_retention=true → warn，不得归 stale/info。
 */

import { config } from './config.ts';
import { SEND_LOG_RETENTION_MS } from './send-log.ts';

export type InvalidCursorFamily = 'deliveries' | 'messages' | 'send' | 'tasks';
export type InvalidCursorShape = 'full' | 'bare_id' | 'malformed';

/** decoder 真实拒收种类：解析失败 vs 解码成功但查找/绑定 miss。 */
export type InvalidCursorKind = 'parse_fail' | 'lookup_miss';

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
  // 未来时间戳不得归 stale
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

function retentionMsFor(family: InvalidCursorFamily): number {
  switch (family) {
    case 'deliveries':
      return deliveriesRetentionMs();
    case 'send':
      return SEND_LOG_RETENTION_MS;
    case 'messages':
    case 'tasks':
      return mailRetentionMs();
  }
}

/**
 * 由 decoder 真实 kind 派生观测标签（零软解）。
 * parse_fail → malformed；lookup_miss + ts → full；lookup_miss 无 ts → bare_id。
 */
export function inspectionFromKind(
  family: InvalidCursorFamily,
  kind: InvalidCursorKind,
  cursorTs?: number,
  now = Date.now(),
): InvalidCursorInspection {
  if (kind === 'parse_fail') {
    return { shape: 'malformed', within_retention: false };
  }
  // lookup_miss：解码已成功
  if (cursorTs === undefined) {
    // bare_id / 无时间戳：判不准 → stale
    return { shape: 'bare_id', within_retention: false };
  }
  return {
    shape: 'full',
    within_retention: withinRetentionMs(cursorTs, retentionMsFor(family), now),
  };
}

/** 路由拒收点：直传 decoder kind（+可选 cursorTs），不再吃游标原文。 */
export function logInvalidCursorRejectionFor(
  family: InvalidCursorFamily,
  kind: InvalidCursorKind,
  opts?: { cursorTs?: number; now?: number },
): void {
  const inspected = inspectionFromKind(family, kind, opts?.cursorTs, opts?.now ?? Date.now());
  logInvalidCursorRejection({ family, ...inspected });
}
