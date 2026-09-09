import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.ts';

// Tests run files concurrently. This context-local override never mutates the
// boot configuration and is unreachable from the public production registry.
const testLeaseGate = new AsyncLocalStorage<boolean>();
// M3 与 leases 总闸分开覆盖，避免并发单测互相污染。
const testExpiryAuditM3Gate = new AsyncLocalStorage<boolean>();
// M1 公共读有界闸单独覆盖，避免与总闸/M3 并发单测互相污染。
const testOverlayBoundGate = new AsyncLocalStorage<boolean>();
// M2 pending journal 闸单独覆盖，避免与总闸/M1/M3 并发单测互相污染。
const testPendingJournalGate = new AsyncLocalStorage<boolean>();

export function taskLeasesEnabled(): boolean {
  return testLeaseGate.getStore() ?? config.taskLeasesEnabled;
}

/** M3 解耦闸：on 时 claim 到期只派生失活。容忍无条件，不随本闸。 */
export function taskLeaseExpiryAuditM3Enabled(): boolean {
  return testExpiryAuditM3Gate.getStore() ?? config.taskLeasesExpiryAuditM3;
}

/** M1 公共读 overlay 有界闸：on 时 list/详情停播超龄 lease 重放。 */
export function taskLeaseOverlayBoundEnabled(): boolean {
  return testOverlayBoundGate.getStore() ?? config.taskLeasesOverlayBound;
}

/** M2 pending journal：on 且总闸 on 时才写 fence / tombstone / 发射器。 */
export function taskLeasePendingJournalEnabled(): boolean {
  if (!taskLeasesEnabled()) return false;
  return testPendingJournalGate.getStore() ?? config.taskLeasesPendingJournal;
}

/** M2 emitter 独立门禁：在 R2 中全生产入口硬禁（hard-disabled），任何配置不可开启。 */
export function taskLeaseEmitterEnabled(): boolean {
  return false;
}

/** @internal Test-only scoped gate override; do not export through tasks.ts. */
export function withTaskLeasesEnabledForTests<T>(enabled: boolean, work: () => T): T {
  return testLeaseGate.run(enabled, work);
}

/** @internal M3 开关的测试覆盖；不经 tasks.ts 公开导出。 */
export function withTaskLeaseExpiryAuditM3ForTests<T>(enabled: boolean, work: () => T): T {
  return testExpiryAuditM3Gate.run(enabled, work);
}

/** @internal M1 公共读有界闸的测试覆盖；不经 tasks.ts 公开导出。 */
export function withTaskLeaseOverlayBoundForTests<T>(enabled: boolean, work: () => T): T {
  return testOverlayBoundGate.run(enabled, work);
}

/** @internal M2 journal 闸的测试覆盖；不经 tasks.ts 公开导出。 */
export function withTaskLeasePendingJournalForTests<T>(enabled: boolean, work: () => T): T {
  return testPendingJournalGate.run(enabled, work);
}
