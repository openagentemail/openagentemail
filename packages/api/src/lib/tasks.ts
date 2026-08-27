/** Public task-service facade. Lease test seams live only in tasks-internal.ts
 * and are intentionally absent from the production module registry. */
export {
  TASK_STATES, TERMINAL_TASK_STATES, TASK_WAIT_MAX_SEC, TASK_LEASE_DEFAULT_SEC,
  TASK_LEASE_MIN_SEC, TASK_LEASE_MAX_SEC, TASK_LEASE_REASON_MAX_CHARS,
  TASK_BOARD_STATUSES, TASK_BOARD_PERIODS, TASK_BOARD_LIMITS,
  TASK_BOARD_ACTIVE_STATES, TASK_TERMINAL_VISIBLE_MS, TASK_SUBMITTED_OVERDUE_MS,
  TASK_WORKING_OVERDUE_MS, TASK_LIST_CACHE_MS, TASK_REMIND_COOLDOWN_MS,
  isTaskId, canAdvanceTask, canonicalApprovalAction, approvalActionDigest,
  isApprovalExpired, taskFromMessages, currentTaskMessage, getTask, listTasks,
  createTask, createApprovalTask, setTaskNowForTests, setTaskListAllForTests,
  setTaskGetForTests, setTaskSendMailForTests, clearQueuedEventsForTests,
  invalidateTaskListCache, updateTask, claimTask, toTaskView, toTaskLeaseGrantView,
  isTaskLeaseTokenCurrent, reapExpiredTaskLeasesOnce, renewTask, releaseTask,
  decideApprovalTask, taskParticipants, taskOverdue, toUiTaskView, isClosedByAdmin,
  listTaskBoard, replyTask, remindTask, closeTask, waitForTaskTerminalWith,
  waitForTaskTerminal, approvalEventForWatcher,
  encodeStampedApprovalRequestForTests, encodeStampedApprovalDecisionForTests,
  taskService,
} from './tasks-internal.ts';

export type {
  TaskState, TaskBoardStatus, TaskBoardPeriod, TaskBoardLimit, TaskEventKind,
  ApprovalAction, ApprovalSnapshot, ApprovalEvent, TaskMessage, Task, TaskView,
  TaskLeaseGrant, ApprovalTask, RawTaskMessage, CreateTaskInput,
  CreateApprovalTaskInput, UpdateTaskInput, TaskBoardViewer, TaskBoardQuery,
  TaskOverdue, TaskBoardItem, TaskBoardPage, TaskService, TaskWaitDependencies,
} from './tasks-internal.ts';

export { decodeTaskBoardCursor, encodeTaskBoardCursor, InvalidTaskCursorError } from './task-cursor.ts';
