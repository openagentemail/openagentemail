import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.ts';

// Tests run files concurrently. This context-local override never mutates the
// boot configuration and is unreachable from the public production registry.
const testLeaseGate = new AsyncLocalStorage<boolean>();

export function taskLeasesEnabled(): boolean {
  return testLeaseGate.getStore() ?? config.taskLeasesEnabled;
}

/** @internal Test-only scoped gate override; do not export through tasks.ts. */
export function withTaskLeasesEnabledForTests<T>(enabled: boolean, work: () => T): T {
  return testLeaseGate.run(enabled, work);
}
