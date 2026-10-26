/**
 * 进程启动时从 send-log.jsonl 回放两张内存表：
 * 每小时发信额度，以及自动回复一对一冷却。
 * 读盘失败只告警，不抛出，避免坏日志挡住 API 启动。
 */

import { config } from './config.ts';
import { describeFailure } from './redact.ts';
import { rebuildAutoReplyCooldownFromRecords } from './auto-reply-cooldown.ts';
import { rebuildSendLimitFromRecords } from './ratelimit.ts';
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
  } catch (err) {
    console.warn('[api] send-log replay skipped:', describeFailure(err));
  }
}
