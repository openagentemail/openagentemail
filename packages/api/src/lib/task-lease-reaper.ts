import { taskLeasePendingJournalEnabled, taskLeasesEnabled } from './task-lease-gate.ts';
import { emitPendingExpiryAuditsOnce, reapExpiredTaskLeasesOnce } from './tasks.ts';

// #56 requires explicit recovery, not configurability; a tunable cadence is a separate task.
export const TASK_LEASE_REAPER_INTERVAL_MS = 60_000;

type IntervalHandle = { unref?: () => void };

type ReaperScheduler = {
  reapOnce?: () => Promise<number>;
  setInterval?: (callback: () => void, milliseconds: number) => IntervalHandle;
  warn?: (...args: unknown[]) => void;
};

/** Starts the fixed production cadence. The callback is single-flight so a
 * slow IMAP/SMTP round cannot overlap a later tick. */
export function startTaskLeaseReaper(dependencies: ReaperScheduler = {}): void {
  const leasesEnabled = taskLeasesEnabled();
  if (!leasesEnabled) return;
  const warn = dependencies.warn ?? console.warn;
  const reapOnce = dependencies.reapOnce ?? (async () => {
    const reaped = await reapExpiredTaskLeasesOnce();
    if (taskLeasePendingJournalEnabled()) {
      await emitPendingExpiryAuditsOnce().catch((error: unknown) => {
        warn('[task-lease-reaper] m2 emitter failed:', error instanceof Error ? error.message : String(error));
      });
    }
    return reaped;
  });
  const schedule = dependencies.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
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
