import {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  parseStampedTaskMessageForTests,
  type RawTaskMessage,
  type TaskState,
} from '../../src/lib/tasks-internal.ts';
import {
  taskLeaseExpiryAuditM3Enabled,
  taskLeasesEnabled,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasesEnabledForTests,
} from '../../src/lib/task-lease-gate.ts';

export {
  claimLeaseHeadersForTests,
  parseTaskMessageForTests,
  parseStampedTaskMessageForTests,
  taskLeaseExpiryAuditM3Enabled,
  taskLeasesEnabled,
  withTaskLeaseExpiryAuditM3ForTests,
  withTaskLeasesEnabledForTests,
};
