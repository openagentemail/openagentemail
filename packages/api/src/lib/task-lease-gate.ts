import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.ts';

// Tests run files concurrently. This context-local override never mutates the
// boot configuration and is unreachable from the public production registry.
const testLeaseGate = new AsyncLocalStorage<boolean>();
// M3 与 leases 总闸分开覆盖，避免并发单测互相污染。
const testExpiryAuditM3Gate = new AsyncLocalStorage<boolean>();

export function taskLeasesEnabled(): boolean {
  return testLeaseGate.getStore() ?? config.taskLeasesEnabled;
}

/** M3 读侧+发射侧总闸。off 时字节级走现行路径。 */
export function taskLeaseExpiryAuditM3Enabled(): boolean {
  return testExpiryAuditM3Gate.getStore() ?? config.taskLeasesExpiryAuditM3;
}

/** @internal Test-only scoped gate override; do not export through tasks.ts. */
export function withTaskLeasesEnabledForTests<T>(enabled: boolean, work: () => T): T {
  return testLeaseGate.run(enabled, work);
}

/** @internal M3 开关的测试覆盖；不经 tasks.ts 公开导出。 */
export function withTaskLeaseExpiryAuditM3ForTests<T>(enabled: boolean, work: () => T): T {
  return testExpiryAuditM3Gate.run(enabled, work);
}
