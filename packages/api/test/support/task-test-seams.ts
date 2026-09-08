import {
  setTaskNowForTests,
  setTaskListAllForTests,
  setTaskGetForTests,
  setTaskSendMailForTests,
  clearQueuedEventsForTests,
  scanDurableTasksForTests,
  takeApprovalWatcherParseCallsForTests,
  expiryAuditDeliveryFailureCountForTests,
  resetExpiryAuditDeliveryFailureCountForTests,
  warnedExpiryAuditWindowCountForTests,
  warnExpiryAuditDeliveryFailedForTests,
  expiryAuditInFlightCountForTests,
  reapExpiredTaskLeasesOnce,
} from '../../src/lib/tasks-internal.ts';
import { taskLeaseExpiryAuditM3Enabled } from '../../src/lib/task-lease-gate.ts';

/** M3-on 回执只走 reaper：既有用例在 reclaim 前先补 durable 窗。 */
export async function emitDurableExpiryIfM3ForTests(): Promise<void> {
  if (!taskLeaseExpiryAuditM3Enabled()) return;
  await reapExpiredTaskLeasesOnce();
}

export {
  setTaskNowForTests,
  setTaskListAllForTests,
  setTaskGetForTests,
  setTaskSendMailForTests,
  clearQueuedEventsForTests,
  scanDurableTasksForTests,
  takeApprovalWatcherParseCallsForTests,
  expiryAuditDeliveryFailureCountForTests,
  resetExpiryAuditDeliveryFailureCountForTests,
  warnedExpiryAuditWindowCountForTests,
  warnExpiryAuditDeliveryFailedForTests,
  expiryAuditInFlightCountForTests,
};
