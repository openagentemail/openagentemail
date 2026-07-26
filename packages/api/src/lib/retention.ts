/**
 * Retention sweeper. The catch-all mailbox is append-only from the agents'
 * point of view; without a sweeper it grows forever. Every
 * RETENTION_CHECK_HOURS we delete messages older than RETENTION_DAYS.
 * RETENTION_DAYS=0 disables the sweeper entirely.
 */

import { config } from './config.ts';
import { deleteMessagesBefore } from './imap.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function sweepOnce(): Promise<number> {
  const cutoff = new Date(Date.now() - config.retentionDays * 86_400_000);
  const deleted = await deleteMessagesBefore(cutoff);
  if (deleted > 0) {
    console.log(`[retention] deleted ${deleted} message(s) older than ${config.retentionDays}d`);
  }
  return deleted;
}

/**
 * Start the background sweeper. First run after a short grace period (let
 * the mailserver finish booting), then on the configured interval. Never
 * throws out of the loop — a failed sweep is logged and retried next tick.
 */
export function startRetentionLoop(): void {
  if (config.retentionDays <= 0) {
    console.log('[retention] disabled (RETENTION_DAYS=0)');
    return;
  }
  const intervalMs = config.retentionCheckHours * 3_600_000;
  console.log(
    `[retention] sweeping every ${config.retentionCheckHours}h, deleting mail older than ${config.retentionDays}d`,
  );

  const tick = async () => {
    try {
      await sweepOnce();
    } catch (err) {
      console.warn('[retention] sweep failed:', (err as Error).message);
    }
  };

  // Don't sweep during the first minute — Dovecot may still be starting.
  sleep(60_000)
    .then(tick)
    .catch(() => {});
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
}
