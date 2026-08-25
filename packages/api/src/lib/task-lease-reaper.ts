import { config } from './config.ts';
import { reapExpiredTaskLeasesOnce } from './tasks.ts';

// #56 requires explicit recovery, not configurability; a tunable cadence is a separate task.
export const TASK_LEASE_REAPER_INTERVAL_MS = 60_000;

type IntervalHandle = { unref?: () => void };

type ReaperScheduler = {
  /** @internal test-only feature-gate seam; production reads config. */
  leaseEnabledForTests?: boolean;
  reapOnce?: () => Promise<number>;
  setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle;
  warn?: (...args: unknown[]) => void;
};

/** Starts the fixed production cadence. The callback is single-flight so a
 * slow IMAP/SMTP round cannot overlap a later tick. */
export function startTaskLeaseReaper(dependencies: ReaperScheduler = {}): void {
  const leasesEnabled = dependencies.leaseEnabledForTests ?? config.taskLeasesEnabled;
  if (!leasesEnabled) return;
  const reapOnce = dependencies.reapOnce ?? reapExpiredTaskLeasesOnce;
  const schedule = dependencies.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
  const warn = dependencies.warn ?? console.warn;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void reapOnce()
      .catch((error: unknown) => {
        warn('[task-lease-reaper] reap failed:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => { running = false; });
  };
  const timer = schedule(tick, TASK_LEASE_REAPER_INTERVAL_MS);
  timer.unref?.();
}
