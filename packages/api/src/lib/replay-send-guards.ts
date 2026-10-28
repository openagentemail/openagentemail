/**
 * 进程启动时从 send-log.jsonl 回放三张内存表：
 * 每小时发信额度、自动回复一对一冷却，以及已完成的发信幂等记录。
 * 额度和冷却都认 queued，再加上 SMTP 已应答的失败行（failureKind === "smtp_response"）。
 * 冷却还要求 autoReply === true。没有该字段的旧失败行不计入。
 * 幂等只认带 idempotencyKeyHash 与 requestHash 的 queued 行，以及同样带这两个字段的
 * smtp_response 失败行，并且 sentAt 落在 24 小时窗口内。没有这两个字段的旧行忽略。
 * 额度用准入时刻 rateLimitAt（没有或非法则 sentAt）。冷却和幂等仍用 sentAt。
 * 读盘失败只告警，不抛出，避免坏日志挡住 API 启动。
 */

import { config } from './config.ts';
import { describeFailure } from './redact.ts';
import { rebuildAutoReplyCooldownFromRecords } from './auto-reply-cooldown.ts';
import { rebuildSendLimitFromRecords } from './ratelimit.ts';
import { rebuildSendIdempotencyFromRecords } from './send-idempotency.ts';
import { readSendLogRecordsForReplay, type SendLogRecord } from './send-log.ts';

/**
 * 读一次日志，灌进现有额度桶和冷却表。
 * read 参数只给测试替换；生产走发送日志的原解析器。
 */
export function replaySendGuardsFromLog(
  now = Date.now(),
  read: () => SendLogRecord[] = readSendLogRecordsForReplay,
): void {
  let records: SendLogRecord[];
  try {
    records = read();
  } catch (err) {
    // 日志没读上来就保持空表。已经在内存里的额度不动，避免半次失败把活计数清掉。
    console.warn('[api] send-log replay skipped:', describeFailure(err));
    return;
  }
  try {
    rebuildSendLimitFromRecords(records, now);
    rebuildAutoReplyCooldownFromRecords(records, config.autoReplyCooldownSec, now);
    // 与额度、冷却同一次读盘。只重建已完成项，不恢复进程死掉时还在飞的占位。
    rebuildSendIdempotencyFromRecords(records, now);
  } catch (err) {
    console.warn('[api] send-log replay skipped:', describeFailure(err));
  }
}
