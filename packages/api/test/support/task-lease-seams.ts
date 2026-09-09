import {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  parseStampedTaskMessageForTests,
  type RawTaskMessage,
  type TaskState,
} from '../../src/lib/tasks-internal.ts';
import {
  taskLeaseExpiryAuditM3Enabled,
  taskLeaseOverlayBoundEnabled,
  taskLeasePendingJournalEnabled,
  taskLeasesEnabled,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeaseOverlayBoundForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
} from '../../src/lib/task-lease-gate.ts';

export {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  parseStampedTaskMessageForTests,
  taskLeaseExpiryAuditM3Enabled,
  taskLeaseOverlayBoundEnabled,
  taskLeasePendingJournalEnabled,
  taskLeasesEnabled,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeaseOverlayBoundForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
};
