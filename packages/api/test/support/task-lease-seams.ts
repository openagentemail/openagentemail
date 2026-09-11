import {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  parseStampedTaskMessageForTests,
  setPostSmtpAcceptHookForTests,
  setPreSmtpHookForTests,
  type RawTaskMessage,
  type TaskState,
} from '../../src/lib/tasks-internal.ts';
import {
  taskLeaseEmitterEnabled,
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
  setPostSmtpAcceptHookForTests,
  setPreSmtpHookForTests,
  taskLeaseEmitterEnabled,
  taskLeaseExpiryAuditM3Enabled,
  taskLeaseOverlayBoundEnabled,
  taskLeasePendingJournalEnabled,
  taskLeasesEnabled,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeaseOverlayBoundForTests,
  withTaskLeasePendingJournalForTests,
  withTaskLeasesEnabledForTests,
};
