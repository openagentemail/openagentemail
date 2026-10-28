/**
 * 进程启动时从 send-log.jsonl 回放三张内存表：
 * 每小时发信额度、自动回复一对一冷却，以及已完成的发信幂等记录。
 * 额度和冷却都认 queued，再加上 SMTP 已应答的失败行（failureKind === "smtp_response"）。
 * 冷却还要求 autoReply === true。没有该字段的旧失败行不计入。
 * 幂等只认带 idempotencyKeyHash 与 requestHash 的 queued 行、smtp_response 失败行，
 * 以及同样带这两个字段的 local 行（DATA 阶段不确定失败），并且 sentAt 落在 24 小时窗口内。
 * 早于该地址当前身份 createdAt 的行忽略。没有这两个字段的旧行忽略。
 * 身份库读失败时不重建幂等行（额度与冷却仍回放），避免没有 createdAt 时装入上一任。
 * 发送日志读失败或回放抛错时，带键发送失败关闭，直到下一次幂等回放成功。
 * 额度用准入时刻 rateLimitAt（没有或非法则 sentAt）。冷却和幂等仍用 sentAt。
 * 读盘失败只告警，不抛出，避免坏日志挡住 API 启动。
 */

import { config } from './config.ts';
import { describeFailure } from './redact.ts';
import { listIdentities } from './identities.ts';
import { rebuildAutoReplyCooldownFromRecords } from './auto-reply-cooldown.ts';
import { rebuildSendLimitFromRecords } from './ratelimit.ts';
import {
  markSendIdempotencyReplayFailed,
  markSendIdempotencyReplaySucceeded,
  rebuildSendIdempotencyFromRecords,
} from './send-idempotency.ts';
import { readSendLogRecordsForReplay, type SendLogRecord } from './send-log.ts';

/**
 * 当前身份的创建时间。
 * 读失败返回 undefined：调用方跳过幂等重建，不能把 undefined 当成“不过滤”。
 * 读成功但库是空的，返回空 Map，照常按 createdAt 过滤。
 */
function currentIdentityCreatedAtMs(): Map<string, number> | undefined {
  try {
    const map = new Map<string, number>();
    for (const identity of listIdentities()) {
      const created = Date.parse(identity.createdAt);
      if (!Number.isFinite(created)) continue;
      map.set(identity.address.toLowerCase(), created);
    }
    return map;
  } catch (err) {
    console.warn('[api] identity createdAt skipped for send idempotency replay:', describeFailure(err));
    return undefined;
  }
}

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
    // 日志没读上来就保持已有额度，避免半次失败把活计数清掉。
    // 幂等表也不重建。带键发送失败关闭，避免空表把重试当成新信。
    console.warn('[api] send-log replay skipped:', describeFailure(err));
    markSendIdempotencyReplayFailed();
    return;
  }
  try {
    rebuildSendLimitFromRecords(records, now);
    rebuildAutoReplyCooldownFromRecords(records, config.autoReplyCooldownSec, now);
  } catch (err) {
    console.warn('[api] send-log replay skipped:', describeFailure(err));
    markSendIdempotencyReplayFailed();
    return;
  }
  const createdAt = currentIdentityCreatedAtMs();
  if (createdAt === undefined) {
    // 身份库读失败。不重建幂等行，避免没有 createdAt 过滤时把上一任的回放装进来。
    // 额度与冷却已经灌好。不因此把带键发送打成 503，内存里已有的幂等表保持原样。
    return;
  }
  try {
    // 与额度、冷却同一次读盘。只重建已完成项，不恢复进程死掉时还在飞的占位。
    rebuildSendIdempotencyFromRecords(records, now, createdAt);
    markSendIdempotencyReplaySucceeded();
  } catch (err) {
    console.warn('[api] send-log replay skipped:', describeFailure(err));
    markSendIdempotencyReplayFailed();
  }
}
