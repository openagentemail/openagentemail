/**
 * Explicit operational install entry for trusted first provisioning of task lease journal.
 *
 * Policy (Commander Mail 1949 / Proposal v4 §1.3):
 * - Callable ONLY as an explicit install/admin operational procedure.
 * - NEVER called on boot (the API never auto-initializes).
 * - Succeeds ONLY by exclusive directory creation (mkdirSync exclusive).
 *   Fails with lease_journal_already_initialized if the directory already exists.
 * - Total wipe is NOT first enablement: running this after a wipe is out of policy
 *   and NOT an authorized recovery path (loss persists recovery_required).
 * - Retains exclusive create and fail-closed failure handling.
 */
import { bootstrapTaskLeaseJournal, JournalError } from './lib/task-lease-journal.ts';

export function runTaskLeaseProvision(): void {
  try {
    const journal = bootstrapTaskLeaseJournal();
    console.log(
      JSON.stringify({
        status: 'provisioned',
        initializedAt: journal.initializedAt,
        source: journal.source,
        version: journal.version,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof JournalError) {
      console.error(
        JSON.stringify({
          status: 'error',
          code: err.message,
        }),
      );
    } else {
      console.error(
        JSON.stringify({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    process.exit(1);
  }
}

export { bootstrapTaskLeaseJournal, JournalError } from './lib/task-lease-journal.ts';

if (import.meta.main) {
  runTaskLeaseProvision();
}
