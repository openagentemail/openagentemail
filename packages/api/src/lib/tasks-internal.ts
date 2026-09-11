/**
 * Task threads live entirely in the catch-all mailbox. Every state transition
 * is a new server-stamped mail message, so IMAP remains the only durable
 * store and the task view can always be rebuilt after an API restart.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { FetchMessageObject } from 'imapflow';
import { config } from './config.ts';
import { findIdentity } from './identities.ts';
import { withInbox, waitForMessage } from './imap.ts';
import { notifyTrustedAgentDelivery } from './notify.ts';
import { sendMail, type SendInput } from './smtp.ts';
import {
  taskLeaseEmitterEnabled,
  taskLeaseExpiryAuditM3Enabled,
  taskLeaseOverlayBoundEnabled,
  taskLeasePendingJournalEnabled,
  taskLeasesEnabled,
} from './task-lease-gate.ts';
import {
  JournalError,
  TASK_LEASE_CLAIM_LOST_MS,
  batchRetireAcceptedIndexedRows,
  cloneLoadedLeaseJournal,
  fireJournalBeforeListSelectionForTests,
  journalCanonicalSnapshotFrom,
  journalRecordsFor,
  listHydrationRecords,
  loadLeaseJournal,
  markJournalFate,
  maxJournalGeneration,
  type JournalExitEvidence,
  type JournalFile,
  type JournalRecord,
  type JournalRowKey,
  setJournalExitEvidenceLookup,
  unresolvedClaimFence,
  unresolvedMutationFence,
  upsertJournalRecord,
  journalSuppressesExpiry,
} from './task-lease-journal.ts';
import { isTaskId } from './task-id.ts';
import * as taskBoardCursor from './task-cursor.ts';
import * as taskChildrenCursor from './task-cursor.ts';
import { getEventDispatcher } from './event-dispatcher.ts';

export {
  decodeTaskBoardCursor,
  encodeTaskBoardCursor,
  InvalidTaskCursorError,
} from './task-cursor.ts';
export { isTaskId } from './task-id.ts';

export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed'];
export const TASK_WAIT_MAX_SEC = 600;
export const TASK_LEASE_DEFAULT_SEC = 300;
export const TASK_LEASE_MIN_SEC = 30;
export const TASK_LEASE_MAX_SEC = 3600;
/** Owner-approved product value; selected for single-header line constraints and base64 expansion, not as an RFC universal safe maximum. */
export const TASK_LEASE_REASON_MAX_CHARS = 8_000;

/** 工单板 status 查询；active = submitted+working（Input required 是独立 tab）。 */
export const TASK_BOARD_STATUSES = [
  'active',
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'all',
] as const;
export type TaskBoardStatus = (typeof TASK_BOARD_STATUSES)[number];
export const TASK_BOARD_PERIODS = ['24h', '7d', '14d', '30d'] as const;
export type TaskBoardPeriod = (typeof TASK_BOARD_PERIODS)[number];
export const TASK_BOARD_LIMITS = [20, 50, 100] as const;
export type TaskBoardLimit = (typeof TASK_BOARD_LIMITS)[number];

export const TASK_BOARD_ACTIVE_STATES: readonly TaskState[] = ['submitted', 'working'];
export const TASK_TERMINAL_VISIBLE_MS = 30 * 24 * 60 * 60 * 1000;
export const TASK_SUBMITTED_OVERDUE_MS = 4 * 60 * 60 * 1000;
export const TASK_WORKING_OVERDUE_MS = 24 * 60 * 60 * 1000;
export const TASK_LIST_CACHE_MS = 30 * 1000;
export const TASK_REMIND_COOLDOWN_MS = 15 * 1000;
/** M1：公共读 lease overlay 重放寿命（自 sentAt）。只约束展示，不删 queued 行。 */
export const LEASE_OVERLAY_MAX_LIFETIME_MS = 15 * 60 * 1000;

const PERIOD_MS: Record<TaskBoardPeriod, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** 催办不是状态转移；IMAP 重建时必须能与 working 区分。 */
export type TaskEventKind = 'state' | 'reminder';

export type ApprovalAction = {
  type: string;
  name: string;
  arguments: unknown;
};

export type ApprovalSnapshot = {
  action: ApprovalAction;
  reviewer: string;
  expiresAt: string;
  digest: string;
};

export type ApprovalEvent =
  | { type: 'request'; snapshot: ApprovalSnapshot }
  | { type: 'decision'; digest: string; decision: 'approved' | 'rejected' }
  | { type: 'expired'; digest: string };

/** list/board 只读投影：过期但尚未物化 signed expiry 的中间态。 */
export const APPROVAL_EXPIRY_PROJECTION_PAST_DEADLINE = 'past-deadline-unmaterialized' as const;
export type ApprovalExpiryProjection = typeof APPROVAL_EXPIRY_PROJECTION_PAST_DEADLINE;

type ApprovalEventPayload =
  | { event: 'request'; digest: string; reviewer: string; expiresAt: string }
  | { event: 'decision'; digest: string; decision: 'approved' | 'rejected'; reviewer: string; decidedAt: string }
  | { event: 'expired'; digest: string; expiredAt: string };

/** Frozen v2 root-envelope HMAC domain. Do not rename: durable IMAP history uses it. */
const TASK_ROOT_V2_DOMAIN = 'openagentemail-task-root-v2';
const TASK_ROOT_V2_WITNESS_DOMAIN = 'openagentemail-task-root-v2-witness';
const RESULT_MARKER = '<!-- openagent.email task result -->';
const APPROVAL_MARKER = '<!-- openagent.email approval snapshot -->';
const APPROVAL_DIGEST_RE = /^[a-f0-9]{64}$/;
const APPROVAL_ACTION_MAX_BYTES = 64 * 1024;
const APPROVAL_ACTION_MAX_DEPTH = 10;
const APPROVAL_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const TASK_LEASE_GENERATION_MAX_MS = 24 * 60 * 60 * 1_000;
const TASK_LEASE_TASK_MAX_MS = 7 * 24 * 60 * 60 * 1_000;
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export type TaskMessage = {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  state: TaskState;
  body: string;
  result?: unknown;
  /** 缺省为 state 转移；reminder 不改变 task.state。 */
  kind?: TaskEventKind;
  idempotencyKey?: string;
  approval?: ApprovalEvent;
};

/** Private rebuilt lease authority; never serialize this directly. */
type TaskLeaseAuthority = {
  leaseGeneration: number;
  claimedUntil: string;
  tokenVerifier: string;
  /** Private authenticated `claim.at` for this generation. */
  generationClaimedAt?: string;
  /** Private authenticated first `claim.at` for the task. */
  firstClaimedAt?: string;
};

type ReleasedLeaseReceipt = {
  leaseGeneration: number;
  tokenVerifier: string;
  reason: string;
  /** Private authenticated first `claim.at` for the task. */
  firstClaimedAt?: string;
};

type ClaimLeaseEvent = {
  version: 1;
  event: 'claim';
  actor: string;
  at: string;
  generation: number;
  claimedUntil: string;
  tokenVerifier: string;
};

type RenewLeaseEvent = Omit<ClaimLeaseEvent, 'event'> & { event: 'renew' };

type ReleaseLeaseEvent = {
  version: 1;
  event: 'release';
  actor: string;
  at: string;
  generation: number;
  tokenVerifier: string;
  reason: string;
};

type ExpiredLeaseEvent = {
  version: 1;
  event: 'expired';
  /** Server authority marker, never an identity or envelope participant. */
  actor: 'server';
  at: string;
  generation: number;
  claimedUntil: string;
  expiredAt: string;
};

/** 服务端签名 tombstone：烧掉未决代，不改变当前 task.state。 */
type ClaimLostLeaseEvent = {
  version: 1;
  event: 'claim_lost';
  actor: 'server';
  at: string;
  generation: number;
  claimedUntil: string;
  firstClaimedAt: string;
};

type LeaseEvent = ClaimLeaseEvent | RenewLeaseEvent | ReleaseLeaseEvent | ExpiredLeaseEvent | ClaimLostLeaseEvent;

type ExpiredLeaseReceipt = {
  leaseGeneration: number;
  claimedUntil: string;
  expiredAt: string;
  /** Private authenticated first `claim.at` for the task. */
  firstClaimedAt?: string;
};

export type Task = {
  id: string;
  from: string;
  to: string;
  subject: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Immutable only when authenticated on the root creation record. */
  parentTaskId?: string;
  messages: TaskMessage[];
  result?: unknown;
  kind?: 'approval';
  approval?: ApprovalSnapshot;
  /** Private authority reconstructed only from authenticated lease events. */
  lease?: TaskLeaseAuthority;
  /** Private, non-active durable replay receipt; never serialize this directly. */
  releasedLease?: ReleasedLeaseReceipt;
  /** Durable non-secret record that an expired generation was materialized. */
  expiredLease?: ExpiredLeaseReceipt;
  /** 已接受的 claim_lost 收据；不进公开投影。 */
  lostLease?: LostLeaseReceipt;
  /** Authenticated durable claim_lost receipts including historical no-ops.
   * Evidence only — never authority, never publicly projected. */
  tombstoneReceipts?: ClaimLostLeaseEvent[];
  /** Authenticated durable expiry receipts including historical audit no-ops
   * (#156 accepted-chain nodes). Evidence only — never authority, never
   * publicly projected; used for exact M2 row retirement. */
  expiryReceipts?: ExpiredLeaseReceipt[];
};

type LostLeaseReceipt = {
  leaseGeneration: number;
  claimedUntil: string;
  lostAt: string;
  firstClaimedAt?: string;
};

export type TaskView = Omit<Task, 'parentTaskId' | 'lease' | 'releasedLease' | 'expiredLease' | 'lostLease' | 'tombstoneReceipts' | 'expiryReceipts'> & {
  claimedUntil?: string;
  leaseGeneration?: number;
  leaseStatus?: 'disabled';
  /** 派生只读字段；缺省表示无需投影（未过期或已物化）。 */
  expiryProjection?: ApprovalExpiryProjection;
};

export type TaskLeaseGrant = {
  task: Task;
  leaseToken: string;
  claimedUntil: string;
  leaseGeneration: number;
};

export type ApprovalTask = Task & { kind: 'approval'; approval: ApprovalSnapshot };

function isApprovalTask(task: Task): task is ApprovalTask {
  return task.kind === 'approval' && !!task.approval;
}

export type RawTaskMessage = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  state: TaskState;
  body: string;
  result?: unknown;
  kind?: TaskEventKind;
  idempotencyKey?: string;
  approval?: ApprovalEvent;
  lease?: LeaseEvent;
  /** Present only on a parser-authenticated v2 parented creation root. */
  parentTaskId?: string;
};

/** 私有毒化标记：不得从关系元数据自身填充。uid 透传 IMAP UID，供抑制分支 min-vs-min 序比对。 */
type TaskRelationshipIntegrityFailure = {
  kind: 'relationship-integrity-failure';
  taskId: string;
  /** 与 FetchMessageObject.uid 同型（number），不得 optional——语义比较字段必须有真值。 */
  uid: number;
};
type ParsedTaskMessage = RawTaskMessage | TaskRelationshipIntegrityFailure | null;

export type CreateTaskInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** Internal only in R1; REST/MCP/UI exposure and parent validation are R2+. */
  parentTaskId?: string;
};

export type CreateApprovalTaskInput = {
  from: string;
  to: string;
  subject: string;
  body?: string;
  action: ApprovalAction;
  expiresAt: string;
  /** Internal only in R1; REST/MCP/UI exposure and parent validation are R2+. */
  parentTaskId?: string;
};

export type UpdateTaskInput = {
  id: string;
  from: string;
  state: TaskState;
  body?: string;
  result?: unknown;
  /** Accepted now for disabled-mode compatibility; enforced in a later round. */
  leaseToken?: string;
};

export type TaskBoardViewer =
  | { kind: 'admin' }
  | { kind: 'identity'; address: string };

export type TaskBoardQuery = {
  status: TaskBoardStatus;
  period: TaskBoardPeriod;
  limit: TaskBoardLimit;
  cursor?: string;
};

export type TaskOverdue = {
  overdueReason: 'submitted' | 'working' | null;
  overdueAt: string | null;
};

export type TaskBoardItem = TaskView & TaskOverdue;

export type TaskBoardPage = {
  tasks: TaskBoardItem[];
  nextCursor: string | null;
  totalApprox: number;
  queryNow: string;
};

export type TaskChildrenQuery = { parentTaskId: string; limit: 20 | 50 | 100; cursor?: string };
export type TaskChildrenPage = { children: Task[]; nextCursor: string | null };

export type TaskService = {
  create(input: CreateTaskInput): Promise<Task>;
  list(state?: TaskState): Promise<Task[]>;
  listBoard(query: TaskBoardQuery, viewer: TaskBoardViewer): Promise<TaskBoardPage>;
  listChildren?(query: TaskChildrenQuery, viewer: TaskBoardViewer): Promise<TaskChildrenPage>;
  /** Raw durable/queued view for route authorization; never materializes expiry. */
  getForAuthorization?(id: string): Promise<Task | null>;
  get(id: string): Promise<Task | null>;
  update(input: UpdateTaskInput): Promise<Task | null>;
  claim?(input: { id: string; from: string; leaseSec?: number }): Promise<TaskLeaseGrant>;
  renew?(input: { id: string; from: string; leaseToken: string; leaseSec?: number }): Promise<Task>;
  release?(input: { id: string; from: string; leaseToken: string; reason?: string }): Promise<Task>;
  claimLost?(input: { id: string }): Promise<Task>;
  reply(input: { id: string; from: string; body: string }): Promise<Task>;
  remind(input: {
    id: string;
    from: string;
    body?: string;
    idempotencyKey?: string;
  }): Promise<Task>;
  close(input: { id: string; from: string; reason: string }): Promise<Task>;
  /** Additive #55 core. REST decision routing remains a later round. */
  createApproval?(input: CreateApprovalTaskInput): Promise<ApprovalTask>;
  decideApproval?(input: { id: string; from: string; decision: 'approved' | 'rejected' }): Promise<ApprovalTask>;
  waitForTerminal(id: string, address: string, timeoutSec?: number): Promise<Task | null>;
};

function isTaskState(value: string | undefined): value is TaskState {
  return !!value && (TASK_STATES as readonly string[]).includes(value);
}

/** Terminal task states never reopen, even when a stale participant retries. */
export function canAdvanceTask(current: TaskState): boolean {
  return !TERMINAL_TASK_STATES.includes(current);
}

/** JSON canonicalization used by the approval digest recipe: recursively sort
 * object keys, preserve array order, and serialize without whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid_approval_action');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('invalid_approval_action');
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

/**
 * Bound an approval action before the recursive canonical serializer runs.
 * The byte count is independent of object-key sort order, so this iterative
 * walk measures the exact canonical UTF-8 JSON length without allocating it.
 */
function assertApprovalActionBounds(value: unknown): void {
  type Frame = { kind: 'enter'; value: unknown; depth: number } | { kind: 'exit'; value: object };
  const stack: Frame[] = [{ kind: 'enter', value, depth: 1 }];
  const activeAncestors = new WeakSet<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === 'exit') {
      activeAncestors.delete(current.value);
      continue;
    }
    const composite = Array.isArray(current.value)
      || !!current.value && typeof current.value === 'object' && Object.getPrototypeOf(current.value) === Object.prototype;
    // A repeated active composite is a non-JSON cycle even when the repeated
    // edge itself sits beyond the accepted acyclic depth limit.
    if (composite && activeAncestors.has(current.value as object)) {
      throw new Error('invalid_approval_action');
    }
    if (current.depth > APPROVAL_ACTION_MAX_DEPTH) throw new Error('approval_action_too_deep');
    if (current.value === null || typeof current.value === 'boolean') {
      bytes += current.value === null ? 4 : current.value ? 4 : 5;
    } else if (typeof current.value === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(current.value), 'utf8');
    } else if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) throw new Error('invalid_approval_action');
      bytes += Buffer.byteLength(JSON.stringify(current.value), 'utf8');
    } else if (Array.isArray(current.value)) {
      activeAncestors.add(current.value);
      bytes += 2 + Math.max(0, current.value.length - 1);
      if (bytes > APPROVAL_ACTION_MAX_BYTES) throw new Error('approval_action_too_large');
      stack.push({ kind: 'exit', value: current.value });
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'enter', value: current.value[index], depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === 'object' && Object.getPrototypeOf(current.value) === Object.prototype) {
      const object = current.value as Record<string, unknown>;
      activeAncestors.add(object);
      const keys = Object.keys(object);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
        if (bytes > APPROVAL_ACTION_MAX_BYTES) throw new Error('approval_action_too_large');
      }
      stack.push({ kind: 'exit', value: object });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'enter', value: object[keys[index]!], depth: current.depth + 1 });
      }
    } else {
      throw new Error('invalid_approval_action');
    }
    if (bytes > APPROVAL_ACTION_MAX_BYTES) throw new Error('approval_action_too_large');
  }
}

/** Validate only the fixed approval-action envelope; policy bounds are a
 * creation concern, while signed historical JSON must remain readable. */
function approvalActionFields(value: unknown): ApprovalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_approval_action');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3
    || typeof input.type !== 'string' || !input.type
    || typeof input.name !== 'string' || !input.name
    || !Object.prototype.hasOwnProperty.call(input, 'arguments')
  ) throw new Error('invalid_approval_action');
  return { type: input.type, name: input.name, arguments: input.arguments };
}

function normalizedApprovalAction(value: unknown): ApprovalAction {
  const input = approvalActionFields(value);
  // Parse the canonical form back so callers cannot mutate the persisted
  // snapshot after creation and so only JSON values cross the event boundary.
  return JSON.parse(canonicalJson(input)) as ApprovalAction;
}

/** Reproducible recipe: SHA-256 of canonical UTF-8 JSON, lower-case hex. */
export function canonicalApprovalAction(action: unknown): string {
  return canonicalJson(normalizedApprovalAction(action));
}

export function approvalActionDigest(action: unknown): string {
  return createHash('sha256').update(canonicalApprovalAction(action), 'utf8').digest('hex');
}

function assertApprovalExpiryBound(expiresAt: string, now = nowMs()): void {
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || time <= now) throw new Error('invalid_approval_expiry');
  if (time > now + APPROVAL_MAX_LIFETIME_MS) throw new Error('approval_expiry_too_far');
}

export function isApprovalExpired(expiresAt: string, now = nowMs()): boolean {
  const time = Date.parse(expiresAt);
  return !Number.isFinite(time) || now >= time;
}

/** 已物化的 signed expiry：消息事件或终态 result，任一即可。 */
function hasMaterializedApprovalExpiry(task: Task): boolean {
  if (task.messages.some((message) => message.approval?.type === 'expired')) return true;
  const expiry = readApprovalExpiry(task.result);
  return !!expiry && expiry.digest === task.approval?.digest;
}

/**
 * list/board 只读投影。与 authorized detail/wait/decision 的物化边界对齐
 *（`isApprovalExpired`：now >= expiresAt）。纯函数，零写副作用。
 */
export function approvalExpiryProjection(task: Task, now = nowMs()): ApprovalExpiryProjection | undefined {
  if (task.kind !== 'approval' || !task.approval) return undefined;
  // 只有仍停留在 input-required 的审批才可能是「过期未物化」中间态。
  if (task.state !== 'input-required') return undefined;
  if (!isApprovalExpired(task.approval.expiresAt, now)) return undefined;
  if (hasMaterializedApprovalExpiry(task)) return undefined;
  return APPROVAL_EXPIRY_PROJECTION_PAST_DEADLINE;
}

/** A private signature makes a copied client-side task header non-authoritative. */
function taskStamp(id: string, state: TaskState, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}

type TaskRootEnvelope = { version: 2; parentTaskId: string };

function normalizeParentTaskId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isTaskId(value)) throw new Error('invalid_parent_task_id');
  return value.toLowerCase();
}

/** The v2 root envelope is deliberately tiny and byte-canonical. */
function canonicalTaskRootEnvelope(parentTaskId: string): string {
  return JSON.stringify({ version: 2, parentTaskId });
}

function taskRootEnvelopeHeader(parentTaskId: string): { canonical: string; header: string } {
  const canonical = canonicalTaskRootEnvelope(parentTaskId);
  return { canonical, header: Buffer.from(canonical, 'utf8').toString('base64url') };
}

function readTaskRootEnvelope(value: unknown): { envelope: TaskRootEnvelope; canonical: string } | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== value) return null;
    const canonical = bytes.toString('utf8');
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.version !== 2 || typeof parsed.parentTaskId !== 'string'
      || !isTaskId(parsed.parentTaskId) || Object.keys(parsed).length !== 2
    ) return null;
    const envelope: TaskRootEnvelope = { version: 2, parentTaskId: parsed.parentTaskId.toLowerCase() };
    return canonical === canonicalTaskRootEnvelope(envelope.parentTaskId) ? { envelope, canonical } : null;
  } catch {
    return null;
  }
}

/**
 * Parent v2 roots use a distinct HMAC domain. Approval request payload remains
 * in the signed transcript so adding a relationship never weakens its binding.
 */
function taskRootStamp(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  rootCanonical: string,
  approvalCanonical = '',
): string {
  const witness = createHmac('sha256', config.taskSigningSecret)
    .update(`${TASK_ROOT_V2_WITNESS_DOMAIN}\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
  const rootMac = createHmac('sha256', config.taskSigningSecret)
    .update(`${TASK_ROOT_V2_DOMAIN}\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${rootCanonical}\n${approvalCanonical}`)
    .digest('base64url');
  return `v2.${witness}.${rootMac}`;
}

function hasValidTaskRootWitness(message: FetchMessageObject, id: string, state: unknown, stamp: unknown): boolean {
  if (!message.envelope || typeof state !== 'string' || !isTaskState(state) || typeof stamp !== 'string') return false;
  const from = firstAddress(message.envelope.from);
  const to = firstAddress(message.envelope.to);
  const parts = stamp.split('.');
  if (!from || !to || parts.length !== 3 || parts[0] !== 'v2') return false;
  const expected = createHmac('sha256', config.taskSigningSecret)
    .update(`${TASK_ROOT_V2_WITNESS_DOMAIN}\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
  try {
    const actualBytes = Buffer.from(parts[1]!);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}

function canonicalLeaseEvent(event: LeaseEvent): string {
  if (event.event === 'release') {
    return JSON.stringify({
      version: event.version,
      event: event.event,
      actor: event.actor,
      at: event.at,
      generation: event.generation,
      tokenVerifier: event.tokenVerifier,
      reason: event.reason,
    });
  }
  if (event.event === 'expired') {
    return JSON.stringify({
      version: event.version,
      event: event.event,
      actor: event.actor,
      at: event.at,
      generation: event.generation,
      claimedUntil: event.claimedUntil,
      expiredAt: event.expiredAt,
    });
  }
  if (event.event === 'claim_lost') {
    return JSON.stringify({
      version: event.version,
      event: event.event,
      actor: event.actor,
      at: event.at,
      generation: event.generation,
      claimedUntil: event.claimedUntil,
      firstClaimedAt: event.firstClaimedAt,
    });
  }
  return JSON.stringify({
    version: event.version,
    event: event.event,
    actor: event.actor,
    at: event.at,
    generation: event.generation,
    claimedUntil: event.claimedUntil,
    tokenVerifier: event.tokenVerifier,
  });
}

function leaseTokenVerifier(id: string, generation: number, token: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`task-lease-token-verifier-v1\n${id}\n${generation}\n${token}`)
    .digest('base64url');
}

/** Verifiers are fixed-length HMAC encodings. Reject malformed values as an
 * ordinary failed credential before invoking the constant-time primitive. */
function leaseVerifiersEqual(candidate: unknown, persisted: unknown): boolean {
  if (typeof candidate !== 'string' || typeof persisted !== 'string') return false;
  const left = Buffer.from(candidate, 'utf8');
  const right = Buffer.from(persisted, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Equivalence predicate for server lease-expiry idempotency: same lease
 * generation and exact canonical claimedUntil timestamp.
 */
function isSameLeaseExpiryIdentity(
  a: { leaseGeneration?: number; generation?: number; claimedUntil: string },
  b: { leaseGeneration?: number; generation?: number; claimedUntil: string },
): boolean {
  const genA = a.leaseGeneration ?? a.generation;
  const genB = b.leaseGeneration ?? b.generation;
  return genA !== undefined && genA === genB && a.claimedUntil === b.claimedUntil;
}

/** #85：claim/renew/release 已认证事件的逐字节身份（canonical payload）。 */
function isSameAuthenticatedLeaseEvent(a: LeaseEvent, b: LeaseEvent): boolean {
  return canonicalLeaseEvent(a) === canonicalLeaseEvent(b);
}

function leaseEventStamp(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  canonical: string,
): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`task-lease-event-v1\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${canonical}`)
    .digest('base64url');
}

/** Accept claim records written before lease events were generalized. The
 * payload stays canonical; only the historic signing domain differs. */
function legacyClaimLeaseStamp(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  canonical: string,
): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`task-lease-claim-event-v1\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${canonical}`)
    .digest('base64url');
}

function leaseEventHeaders(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  event: LeaseEvent,
): Record<string, string> {
  const canonical = canonicalLeaseEvent(event);
  return {
    'X-OA-Task': id,
    'X-OA-Task-State': state,
    'X-OA-Task-Lease-Event': event.event,
    'X-OA-Task-Lease-Payload': Buffer.from(canonical, 'utf8').toString('base64url'),
    'X-OA-Task-Stamp': leaseEventStamp(id, state, from, to, canonical),
  };
}

/** Build-excluded seam for lease parser/header tests. The public tasks module
 * deliberately does not re-export it. */
export function claimLeaseHeadersForTests(input: {
  id: string;
  state: TaskState;
  from: string;
  to: string;
  event: LeaseEvent;
}): Record<string, string> {
  return leaseEventHeaders(input.id, input.state, input.from, input.to, input.event);
}

/**
 * approval-event-v1 HMAC 域：id / state / from / to / canonical payload。
 * 展示层 Subject 不进本域，也不得绑进未来 event/stamp 版本——Subject 是 UI
 * 展示语义；绑签名会破坏 v1 兼容，并把展示抬进 integrity 面。
 */
function approvalStamp(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  payload: string,
): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`approval-event-v1\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${payload}`)
    .digest('base64url');
}

/** One canonical, domain-separated signed payload for every authoritative
 * approval event. Headers carry base64url so the RFC field itself is inert. */
function canonicalApprovalEventPayload(payload: ApprovalEventPayload): string {
  return canonicalJson(payload);
}

function approvalPayloadHeader(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function readApprovalPayloadHeader(value: unknown): { payload: ApprovalEventPayload; canonical: string } | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== value) return null;
    const decoded = bytes.toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.event !== 'string') return null;
    let payload: ApprovalEventPayload;
    if (
      parsed.event === 'request'
      && typeof parsed.digest === 'string' && APPROVAL_DIGEST_RE.test(parsed.digest)
      && typeof parsed.reviewer === 'string' && typeof parsed.expiresAt === 'string'
      && Number.isFinite(Date.parse(parsed.expiresAt))
      && Object.keys(parsed).length === 4
    ) payload = { event: 'request', digest: parsed.digest, reviewer: parsed.reviewer.toLowerCase(), expiresAt: parsed.expiresAt };
    else if (
      parsed.event === 'decision'
      && typeof parsed.digest === 'string' && APPROVAL_DIGEST_RE.test(parsed.digest)
      && (parsed.decision === 'approved' || parsed.decision === 'rejected')
      && typeof parsed.reviewer === 'string' && typeof parsed.decidedAt === 'string'
      && Number.isFinite(Date.parse(parsed.decidedAt))
      && Object.keys(parsed).length === 5
    ) payload = { event: 'decision', digest: parsed.digest, decision: parsed.decision, reviewer: parsed.reviewer.toLowerCase(), decidedAt: parsed.decidedAt };
    else if (
      parsed.event === 'expired'
      && typeof parsed.digest === 'string' && APPROVAL_DIGEST_RE.test(parsed.digest)
      && typeof parsed.expiredAt === 'string' && Number.isFinite(Date.parse(parsed.expiredAt))
      && Object.keys(parsed).length === 3
    ) payload = { event: 'expired', digest: parsed.digest, expiredAt: parsed.expiredAt };
    else return null;
    const canonical = canonicalApprovalEventPayload(payload);
    return decoded === canonical ? { payload, canonical } : null;
  } catch {
    return null;
  }
}

function readLeaseEventPayload(value: unknown): { event: LeaseEvent; canonical: string } | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length || bytes.toString('base64url') !== value) return null;
    const canonical = bytes.toString('utf8');
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (
      parsed.version !== 1 || (parsed.event !== 'claim' && parsed.event !== 'renew' && parsed.event !== 'release' && parsed.event !== 'expired' && parsed.event !== 'claim_lost')
      || typeof parsed.actor !== 'string' || !parsed.actor
      || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
      || typeof parsed.generation !== 'number' || !Number.isInteger(parsed.generation) || parsed.generation < 1
    ) return null;
    if (parsed.event === 'claim_lost') {
      if (
        parsed.actor !== 'server'
        || typeof parsed.claimedUntil !== 'string' || !Number.isFinite(Date.parse(parsed.claimedUntil))
        || typeof parsed.firstClaimedAt !== 'string' || !Number.isFinite(Date.parse(parsed.firstClaimedAt))
        || Object.keys(parsed).length !== 7
      ) return null;
      const event: ClaimLostLeaseEvent = {
        version: 1, event: 'claim_lost', actor: 'server', at: parsed.at,
        generation: parsed.generation, claimedUntil: parsed.claimedUntil, firstClaimedAt: parsed.firstClaimedAt,
      };
      return canonical === canonicalLeaseEvent(event) ? { event, canonical } : null;
    }
    if (parsed.event === 'expired') {
      if (
        parsed.actor !== 'server'
        || typeof parsed.claimedUntil !== 'string' || !Number.isFinite(Date.parse(parsed.claimedUntil))
        || typeof parsed.expiredAt !== 'string' || !Number.isFinite(Date.parse(parsed.expiredAt))
        || parsed.at !== parsed.expiredAt || Date.parse(parsed.expiredAt) < Date.parse(parsed.claimedUntil)
        || Object.keys(parsed).length !== 7
      ) return null;
      const event: ExpiredLeaseEvent = {
        version: 1, event: 'expired', actor: 'server', at: parsed.at,
        generation: parsed.generation, claimedUntil: parsed.claimedUntil, expiredAt: parsed.expiredAt,
      };
      return canonical === canonicalLeaseEvent(event) ? { event, canonical } : null;
    }
    if (typeof parsed.tokenVerifier !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(parsed.tokenVerifier)) return null;
    if (parsed.event === 'release') {
      if (typeof parsed.reason !== 'string' || Object.keys(parsed).length !== 7) return null;
      const event: ReleaseLeaseEvent = {
        version: 1, event: 'release', actor: parsed.actor.toLowerCase(), at: parsed.at,
        generation: parsed.generation, tokenVerifier: parsed.tokenVerifier, reason: parsed.reason,
      };
      return canonical === canonicalLeaseEvent(event) ? { event, canonical } : null;
    }
    if (
      typeof parsed.claimedUntil !== 'string' || !Number.isFinite(Date.parse(parsed.claimedUntil))
      || Object.keys(parsed).length !== 7
    ) return null;
    const event: ClaimLeaseEvent | RenewLeaseEvent = {
      version: 1, event: parsed.event, actor: parsed.actor.toLowerCase(), at: parsed.at,
      generation: parsed.generation, claimedUntil: parsed.claimedUntil, tokenVerifier: parsed.tokenVerifier,
    };
    return canonical === canonicalLeaseEvent(event) ? { event, canonical } : null;
  } catch {
    return null;
  }
}

/** 催办 stamp 与状态转移分离，避免伪装成 working。 */
function reminderStamp(id: string, state: TaskState, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`reminder\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}

function taskHeaders(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  parentTaskId?: string,
): Record<string, string> {
  if (parentTaskId !== undefined) {
    const root = taskRootEnvelopeHeader(parentTaskId);
    return {
      'X-OA-Task': id,
      'X-OA-Task-State': state,
      'X-OA-Task-Root': root.header,
      'X-OA-Task-Stamp': taskRootStamp(id, state, from, to, root.canonical),
    };
  }
  return {
    'X-OA-Task': id,
    'X-OA-Task-State': state,
    'X-OA-Task-Stamp': taskStamp(id, state, from, to),
  };
}

export async function parseTaskMessageForTests(
  message: FetchMessageObject,
  id: string,
): Promise<RawTaskMessage | null> {
  return parseTaskMessage(message, id);
}

function approvalHeaders(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  payload: ApprovalEventPayload,
  parentTaskId?: string,
): Record<string, string> {
  const canonical = canonicalApprovalEventPayload(payload);
  const root = parentTaskId === undefined ? undefined : taskRootEnvelopeHeader(parentTaskId);
  return {
    'X-OA-Task': id,
    'X-OA-Task-State': state,
    'X-OA-Task-Approval-Event': payload.event,
    'X-OA-Task-Approval-Digest': payload.digest,
    ...(payload.event === 'decision' ? { 'X-OA-Task-Approval-Decision': payload.decision } : {}),
    'X-OA-Task-Approval-Payload': approvalPayloadHeader(canonical),
    ...(root ? { 'X-OA-Task-Root': root.header } : {}),
    'X-OA-Task-Stamp': root
      ? taskRootStamp(id, state, from, to, root.canonical, canonical)
      : approvalStamp(id, state, from, to, canonical),
  };
}

function firstAddress(list?: Array<{ address?: string }>): string {
  return list?.[0]?.address?.toLowerCase() ?? '';
}

function resultBlock(result: unknown): string {
  return `${RESULT_MARKER}\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

function readResult(body: string): unknown {
  const marker = body.lastIndexOf(RESULT_MARKER);
  if (marker < 0) return undefined;
  const match = body.slice(marker + RESULT_MARKER.length).match(/^\s*```json\s*\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
}

function taskBody(body: string, result: unknown): string {
  const plain = body.trim();
  if (result === undefined) return plain;
  return [plain, resultBlock(result)].filter(Boolean).join('\n\n');
}

function approvalRequestBody(body: string | undefined, snapshot: ApprovalSnapshot): string {
  const plain = (body ?? '').trim();
  const block = `${APPROVAL_MARKER}\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\``;
  return [plain, block].filter(Boolean).join('\n\n');
}

function readApprovalSnapshot(body: string): ApprovalSnapshot | null {
  // The marker is a generated frame delimiter, not an arbitrary payload
  // token: action JSON may safely contain its literal spelling.
  const matches = [...body.matchAll(/(?:^|\n)<!-- openagent\.email approval snapshot -->\n```json\s*\n([\s\S]*?)\n```/g)];
  const match = matches.at(-1);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      Object.keys(parsed).length !== 4
      || !Object.prototype.hasOwnProperty.call(parsed, 'action')
      || typeof parsed.reviewer !== 'string'
      || typeof parsed.expiresAt !== 'string'
      || typeof parsed.digest !== 'string'
      || !APPROVAL_DIGEST_RE.test(parsed.digest)
    ) return null;
    const action = normalizedApprovalAction(parsed.action);
    if (approvalActionDigest(action) !== parsed.digest || !Number.isFinite(Date.parse(parsed.expiresAt))) return null;
    return { action, reviewer: parsed.reviewer.toLowerCase(), expiresAt: parsed.expiresAt, digest: parsed.digest };
  } catch {
    return null;
  }
}

function readApprovalDecision(result: unknown): { decision: 'approved' | 'rejected'; digest: string; reviewer: string; decidedAt: string } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4
    || (value.decision !== 'approved' && value.decision !== 'rejected')
    || typeof value.digest !== 'string' || !APPROVAL_DIGEST_RE.test(value.digest)
    || typeof value.reviewer !== 'string' || typeof value.decidedAt !== 'string'
    || !Number.isFinite(Date.parse(value.decidedAt))
  ) return null;
  return { decision: value.decision, digest: value.digest, reviewer: value.reviewer.toLowerCase(), decidedAt: value.decidedAt };
}

function readApprovalExpiry(result: unknown): { decision: 'expired'; digest: string; expiredAt: string } | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3
    || value.decision !== 'expired'
    || typeof value.digest !== 'string' || !APPROVAL_DIGEST_RE.test(value.digest)
    || typeof value.expiredAt !== 'string' || !Number.isFinite(Date.parse(value.expiredAt))
  ) return null;
  return { decision: 'expired', digest: value.digest, expiredAt: value.expiredAt };
}

function isStampedTaskMessage(
  id: string,
  state: TaskState,
  from: string,
  to: string,
  stamp: string | undefined,
): boolean {
  return !!stamp && stamp === taskStamp(id, state, from, to);
}

async function parseTaskMessage(
  message: FetchMessageObject,
  id: string,
  preParsed?: ParsedMail,
): Promise<RawTaskMessage | null> {
  if (!message.source || !message.envelope) return null;
  const from = firstAddress(message.envelope.from);
  // A task response has a single peer recipient. Reject ambiguous external
  // mail rather than letting a copied header invent a participant set.
  const to = firstAddress(message.envelope.to);
  if (!from || !to) return null;
  const parsed = preParsed ?? await simpleParser(message.source);
  const headerId = parsed.headers.get('x-oa-task');
  const headerState = parsed.headers.get('x-oa-task-state');
  const stamp = parsed.headers.get('x-oa-task-stamp');
  const rootRaw = parsed.headers.get('x-oa-task-root');
  // There is intentionally no standalone parent header. Reject it instead of
  // silently treating attacker-controlled metadata as an authority candidate.
  const nakedParentRaw = parsed.headers.get('x-oa-task-parent');
  const eventRaw = parsed.headers.get('x-oa-task-event');
  const idempotencyRaw = parsed.headers.get('x-oa-task-idempotency-key');
  const approvalEventRaw = parsed.headers.get('x-oa-task-approval-event');
  const approvalDigestRaw = parsed.headers.get('x-oa-task-approval-digest');
  const approvalDecisionRaw = parsed.headers.get('x-oa-task-approval-decision');
  const approvalPayloadRaw = parsed.headers.get('x-oa-task-approval-payload');
  const leaseEventRaw = parsed.headers.get('x-oa-task-lease-event');
  const leasePayloadRaw = parsed.headers.get('x-oa-task-lease-payload');
  if (headerId !== id || typeof headerState !== 'string' || !isTaskState(headerState)) return null;
  if (nakedParentRaw !== undefined) return null;
  const root = rootRaw === undefined ? undefined : readTaskRootEnvelope(rootRaw);
  if (rootRaw !== undefined && !root) return null;
  const body = (parsed.text ?? '').trim();
  const result = readResult(body);
  if (leaseEventRaw !== undefined || leasePayloadRaw !== undefined) {
    if (root) return null;
    if ((leaseEventRaw !== 'claim' && leaseEventRaw !== 'renew' && leaseEventRaw !== 'release' && leaseEventRaw !== 'expired' && leaseEventRaw !== 'claim_lost') || typeof stamp !== 'string') return null;
    const lease = readLeaseEventPayload(leasePayloadRaw);
    if (
      !lease
      || lease.event.event !== leaseEventRaw
      || (lease.event.event === 'expired' || lease.event.event === 'claim_lost'
        ? lease.event.actor !== 'server'
        : lease.event.actor !== from)
      || (lease.event.event !== 'release' && lease.event.event !== 'expired' && lease.event.event !== 'claim_lost' && Date.parse(lease.event.claimedUntil) <= Date.parse(lease.event.at))
      || (stamp !== leaseEventStamp(id, headerState, from, to, lease.canonical)
        && (lease.event.event !== 'claim' || stamp !== legacyClaimLeaseStamp(id, headerState, from, to, lease.canonical)))
    ) return null;
    return {
      uid: message.uid,
      from,
      to,
      subject: parsed.subject ?? message.envelope.subject ?? '',
      date: new Date(message.internalDate ?? message.envelope.date ?? new Date(0)).toISOString(),
      state: headerState,
      body,
      lease: lease.event,
    };
  }
  if (typeof approvalEventRaw === 'string') {
    if (
      (approvalEventRaw !== 'request' && approvalEventRaw !== 'decision' && approvalEventRaw !== 'expired')
      || typeof approvalDigestRaw !== 'string' || !APPROVAL_DIGEST_RE.test(approvalDigestRaw)
      || typeof stamp !== 'string'
    ) return null;
    const payloadHeader = readApprovalPayloadHeader(approvalPayloadRaw);
    if (!payloadHeader || payloadHeader.payload.event !== approvalEventRaw || payloadHeader.payload.digest !== approvalDigestRaw) return null;
    const approvalPayload = payloadHeader.payload;
    const decision = approvalDecisionRaw === 'approved' || approvalDecisionRaw === 'rejected' ? approvalDecisionRaw : undefined;
    if (
      (approvalPayload.event === 'decision' && (decision === undefined || approvalPayload.decision !== decision))
      || (approvalPayload.event !== 'decision' && approvalDecisionRaw !== undefined)
      || (root
        ? (
          approvalEventRaw !== 'request'
          || headerState !== 'input-required'
          || stamp !== taskRootStamp(id, headerState, from, to, root.canonical, payloadHeader.canonical)
        )
        : stamp !== approvalStamp(id, headerState, from, to, payloadHeader.canonical))
    ) return null;
    let approval: ApprovalEvent;
    if (approvalPayload.event === 'request') {
      const snapshot = readApprovalSnapshot(body);
      if (
        headerState !== 'input-required'
        || decision !== undefined
        || !snapshot
        || snapshot.digest !== approvalDigestRaw
        || snapshot.reviewer !== approvalPayload.reviewer
        || snapshot.expiresAt !== approvalPayload.expiresAt
        || snapshot.reviewer !== to
        || snapshot.reviewer === from
      ) return null;
      approval = { type: 'request', snapshot };
    } else if (approvalPayload.event === 'decision') {
      const resultDecision = readApprovalDecision(result);
      if (
        headerState !== 'completed'
        || !decision
        || !resultDecision
        || resultDecision.decision !== decision
        || resultDecision.digest !== approvalDigestRaw
        || resultDecision.reviewer !== approvalPayload.reviewer
        || resultDecision.decidedAt !== approvalPayload.decidedAt
        || resultDecision.reviewer !== from
      ) return null;
      approval = { type: 'decision', digest: approvalDigestRaw, decision };
    } else {
      const resultExpiry = readApprovalExpiry(result);
      if (
        headerState !== 'failed'
        || decision !== undefined
        || !resultExpiry
        || resultExpiry.digest !== approvalDigestRaw
        || resultExpiry.expiredAt !== approvalPayload.expiredAt
      ) return null;
      approval = { type: 'expired', digest: approvalDigestRaw };
    }
    return {
      uid: message.uid,
      from,
      to,
      subject: parsed.subject ?? message.envelope.subject ?? '',
      date: new Date(message.internalDate ?? message.envelope.date ?? new Date(0)).toISOString(),
      state: headerState,
      body,
      ...(approvalPayload.event !== 'request' && result !== undefined ? { result } : {}),
      approval,
      ...(root ? { parentTaskId: root.envelope.parentTaskId } : {}),
    };
  }
  const isReminder = eventRaw === 'reminder';
  if (isReminder) {
    if (root) return null;
    if (typeof stamp !== 'string' || stamp !== reminderStamp(id, headerState, from, to)) return null;
  } else if (root) {
    // Ordinary tasks can carry a relationship only on their submitted root.
    if (headerState !== 'submitted' || typeof stamp !== 'string' || stamp !== taskRootStamp(id, headerState, from, to, root.canonical)) return null;
  } else if (!isStampedTaskMessage(id, headerState, from, to, typeof stamp === 'string' ? stamp : undefined)) {
    return null;
  }

  return {
    uid: message.uid,
    from,
    to,
    subject: parsed.subject ?? message.envelope.subject ?? '',
    date: new Date(message.internalDate ?? message.envelope.date ?? new Date(0)).toISOString(),
    state: headerState,
    body,
    ...(result !== undefined ? { result } : {}),
    ...(isReminder ? { kind: 'reminder' as const } : {}),
    ...(typeof idempotencyRaw === 'string' && idempotencyRaw ? { idempotencyKey: idempotencyRaw } : {}),
    ...(root ? { parentTaskId: root.envelope.parentTaskId } : {}),
  };
}

function isRelationshipIntegrityFailure(value: ParsedTaskMessage): value is TaskRelationshipIntegrityFailure {
  return !!value && value.kind === 'relationship-integrity-failure';
}

/**
 * Only a record already matched to this task id can poison its reconstruction.
 * Only an authenticated v2 witness may fail closed. Header presence alone is
 * attacker-controlled same-id noise and must remain ignorable.
 */
async function relationshipIntegrityFailureFor(
  message: FetchMessageObject,
  id: string,
  preParsed?: ParsedMail,
): Promise<TaskRelationshipIntegrityFailure | null> {
  if (!message.source) return null;
  try {
    const parsed = preParsed ?? await simpleParser(message.source);
    if (parsed.headers.get('x-oa-task') !== id) return null;
    const hasRootWitness = hasValidTaskRootWitness(
      message,
      id,
      parsed.headers.get('x-oa-task-state'),
      parsed.headers.get('x-oa-task-stamp'),
    );
    if (!hasRootWitness) return null;
    // 透传 IMAP UID：抑制分支按 min(root.uid) vs min(marker.uid) 判定，缺 UID 会静默升格 replay。
    return { kind: 'relationship-integrity-failure', taskId: id, uid: message.uid };
  } catch {
    return null;
  }
}

async function parseTaskMessageWithIntegrity(
  message: FetchMessageObject,
  id: string,
  preParsed?: ParsedMail,
): Promise<ParsedTaskMessage> {
  try {
    const parsed = await parseTaskMessage(message, id, preParsed);
    return parsed ?? await relationshipIntegrityFailureFor(message, id, preParsed);
  } catch (err) {
    const failure = await relationshipIntegrityFailureFor(message, id, preParsed);
    if (failure) return failure;
    throw err;
  }
}

function taskFromParsedMessages(id: string, messages: ParsedTaskMessage[]): Task | null {
  const authenticated = messages.filter((message): message is RawTaskMessage => !!message && !isRelationshipIntegrityFailure(message));
  // 抑制分支按 min-vs-min 序敏感（#161 / lowest-UID-root 不变量）：
  // markers = 全部 integrity-failure；roots = authenticated 中带 parentTaskId 的项。
  // - 无 roots：与现状一致，v2 无根不可重建，return null。
  // - min(root.uid) > min(marker.uid)：真根区被毒，幸存认证 replay 不得升格 creation root → null。
  // - min(root.uid) < min(marker.uid)：完好认证根在噪声之下，忽略 markers 照常重建。
  // - 相等不可能（同一 UID 不会既是 marker 又是 authenticated）；若代码上可达则 fail-closed。
  // taskFromMessages 的 roots 循环不动：认证字段一致性与 replay-noise 语义仍由那边钉死。
  const markers = messages.filter(isRelationshipIntegrityFailure);
  if (markers.length > 0) {
    const roots = authenticated.filter((message) => message.parentTaskId !== undefined);
    if (roots.length === 0) return null;
    // 缺 UID / NaN / Infinity 不得进入 Math.min：否则比较全假，会静默升格 replay。
    // 两侧任一 uid 非有限值 → fail-closed（把「缺 UID 静默升格 replay」注释不变量落成代码）。
    if (
      roots.some((root) => !Number.isFinite(root.uid))
      || markers.some((marker) => !Number.isFinite(marker.uid))
    ) return null;
    const minRootUid = Math.min(...roots.map((root) => root.uid));
    const minMarkerUid = Math.min(...markers.map((marker) => marker.uid));
    if (minRootUid >= minMarkerUid) return null;
  }
  return taskFromMessages(id, authenticated);
}

function toPublicTaskMessage(message: RawTaskMessage): TaskMessage {
  const { uid, lease: _lease, parentTaskId: _parentTaskId, ...publicMessage } = message;
  return { id: String(uid), ...publicMessage };
}

export function taskFromMessages(id: string, raw: RawTaskMessage[]): Task | null {
  if (raw.length === 0) return null;
  // IMAP UID order is the durable order for a single mailbox. This gives
  // concurrent non-terminal writes ordinary last-writer-wins semantics.
  const mailboxOrdered = [...raw].sort((a, b) => a.uid - b.uid);
  const first = mailboxOrdered[0]!;
  const participants = new Set([first.from, first.to]);
  if (participants.size !== 2) return null;
  if (mailboxOrdered.some((message) => !participants.has(message.from) || !participants.has(message.to))) return null;
  // Never reconstruct a task from a surviving state transition after its
  // authenticated creation record was deleted. This also prevents a stripped
  // v2 relationship root from being downgraded to a parentless legacy task.
  const firstIsOrdinaryRoot = first.state === 'submitted' && !first.approval && first.kind !== 'reminder' && !first.lease;
  const firstIsApprovalRoot = first.state === 'input-required' && first.approval?.type === 'request';
  if (!firstIsOrdinaryRoot && !firstIsApprovalRoot) return null;
  const rootParent = first.parentTaskId;
  const relationshipRoots = mailboxOrdered.filter((message) => message.parentTaskId !== undefined);
  if (relationshipRoots.length > 0) {
    // A v2 relationship exists only on the immutable first creation event.
    // Only fields authenticated by the v2 root stamp may establish a conflict.
    // Later roots with the same authenticated transcript are replay noise;
    // their unsigned subject/body must never suppress or mutate the first root.
    if (!rootParent || !isTaskId(rootParent) || (!firstIsOrdinaryRoot && !firstIsApprovalRoot)) return null;
    for (const message of relationshipRoots) {
      if (
        message.parentTaskId !== rootParent
        || message.from !== first.from || message.to !== first.to
        || message.state !== first.state
        || JSON.stringify(message.approval) !== JSON.stringify(first.approval)
      ) return null;
    }
  }
  const ordered = mailboxOrdered.filter((message) => message === first || message.parentTaskId === undefined);
  const leaseEvents = ordered.filter((message): message is RawTaskMessage & { lease: LeaseEvent } => !!message.lease);
  let previousGeneration = 0;
  let leaseAuthority: TaskLeaseAuthority | undefined;
  let releasedLease: ReleasedLeaseReceipt | undefined;
  let expiredLease: ExpiredLeaseReceipt | undefined;
  let firstClaimedAt: string | undefined;
  let lostLease: LostLeaseReceipt | undefined;
  const appliedExpiryReceipts = new Map<number, ExpiredLeaseReceipt[]>();
  const appliedClaims = new Map<number, ClaimLeaseEvent>();
  const appliedRenews = new Map<number, RenewLeaseEvent[]>();
  const appliedReleases = new Map<number, ReleaseLeaseEvent>();
  const appliedTombstones = new Map<number, ClaimLostLeaseEvent>();
  // 权威窗身份 = (gen, 续约后最终 claimedUntil)，供迟到回执 M3-3 匹配与
  // renew/release 历史窗校验（保持单一最终窗语义不变）。
  const appliedClaimWindows = new Map<number, { claimedUntil: string }>();
  // #156 accepted 链全史：每个已认证且通过既有 claim/renew 校验的 deadline
  // 节点（含续约前的旧窗），按 UID 序在验证通过后入账。迟到旧窗回执据此
  // 审计 no-op；未知窗/未验证未来窗永远不在集合内，保持 fail-closed。
  const acceptedDeadlineWindows = new Map<number, Set<string>>();
  const recordAcceptedWindow = (generation: number, claimedUntil: string): void => {
    appliedClaimWindows.set(generation, { claimedUntil });
    const windows = acceptedDeadlineWindows.get(generation) ?? new Set<string>();
    windows.add(claimedUntil);
    acceptedDeadlineWindows.set(generation, windows);
  };
  // 传输层精确重复（含 expiry）不进入公开消息序列，也不推进权威。
  const duplicateLeaseMessages = new Set<RawTaskMessage>();
  // 终态前缀：回执 UID 之前任意终态即冻结（含迟到 replayed claim）。
  let seenTerminalBefore = false;
  for (const message of ordered) {
    if (!message.lease) {
      if (isTerminalStateEvent(message)) seenTerminalBefore = true;
      continue;
    }
    const lease = message.lease;
    if (lease.event === 'expired') {
      if (
        lease.actor !== 'server'
        || lease.at !== lease.expiredAt
        || !Number.isFinite(Date.parse(lease.expiredAt))
        || !Number.isFinite(Date.parse(lease.claimedUntil))
        || Date.parse(lease.expiredAt) < Date.parse(lease.claimedUntil)
      ) return null;
      const priorReceipts = appliedExpiryReceipts.get(lease.generation) ?? [];
      // 同身份精确重复（含传输层重投）幂等 no-op；不同身份不再立即冲突，
      // 落到下方窗匹配裁决（#156 配对规则）。
      if (priorReceipts.some((prior) => isSameLeaseExpiryIdentity(prior, lease))) {
        duplicateLeaseMessages.add(message);
        continue;
      }
      const recordReceipt = (): ExpiredLeaseReceipt => {
        const receipt: ExpiredLeaseReceipt = {
          leaseGeneration: lease.generation,
          claimedUntil: lease.claimedUntil,
          expiredAt: lease.expiredAt,
          ...(firstClaimedAt ? { firstClaimedAt } : {}),
        };
        appliedExpiryReceipts.set(lease.generation, [...priorReceipts, receipt]);
        return receipt;
      };
      const matchesCurrentAuthority = !!leaseAuthority?.claimedUntil
        && lease.generation === leaseAuthority.leaseGeneration
        && lease.claimedUntil === leaseAuthority.claimedUntil;
      if (matchesCurrentAuthority) {
        // 终态公共历史冻结：本回执之前任意终态状态事件 → 历史 no-op。
        // 不限 claim 之后，避免迟到索引的 replayed claim 把冻结窗口推到终态后面。
        if (seenTerminalBefore) {
          recordReceipt();
          duplicateLeaseMessages.add(message);
          continue;
        }
        leaseAuthority = undefined;
        releasedLease = undefined;
        expiredLease = recordReceipt();
        continue;
      }
      // M3-3 容忍无条件 + #156：匹配任一 accepted 链节点（含续约前旧窗）的
      // server 签名回执一律审计 no-op——不撤回更晚 deadline/后代、不重开终态。
      // 不随解耦开关：回退 off 后，流中已有的迟到回执若再 fail-closed 会整卡消失。
      if (acceptedDeadlineWindows.get(lease.generation)?.has(lease.claimedUntil)) {
        recordReceipt();
        duplicateLeaseMessages.add(message);
        continue;
      }
      // 未知窗（含同代已入账合法回执后的第二个未知窗）保持 fail-closed。
      return null;
    }
    if (lease.event === 'claim_lost') {
      if (
        lease.actor !== 'server'
        || !Number.isFinite(Date.parse(lease.at))
        || !Number.isFinite(Date.parse(lease.claimedUntil))
        || !Number.isFinite(Date.parse(lease.firstClaimedAt))
      ) return null;
      const priorTombstone = appliedTombstones.get(lease.generation);
      if (priorTombstone) {
        if (isSameAuthenticatedLeaseEvent(priorTombstone, lease)) {
          duplicateLeaseMessages.add(message);
          continue;
        }
        return null;
      }
      if (appliedClaims.has(lease.generation)) {
        // 真 claim 已入账后再到的 tombstone：历史 no-op，不撤回权威。
        appliedTombstones.set(lease.generation, lease);
        duplicateLeaseMessages.add(message);
        continue;
      }
      if (lease.generation > previousGeneration + 1) return null;
      if (lease.generation < previousGeneration + 1 && lease.generation < previousGeneration) {
        appliedTombstones.set(lease.generation, lease);
        duplicateLeaseMessages.add(message);
        continue;
      }
      firstClaimedAt = firstClaimedAt ?? lease.firstClaimedAt;
      previousGeneration = Math.max(previousGeneration, lease.generation);
      lostLease = {
        leaseGeneration: lease.generation,
        claimedUntil: lease.claimedUntil,
        lostAt: lease.at,
        firstClaimedAt,
      };
      appliedTombstones.set(lease.generation, lease);
      recordAcceptedWindow(lease.generation, lease.claimedUntil);
      continue;
    }
    if (
      message.from !== first.to || message.to !== first.from
      || lease.actor !== first.to
      || !Number.isFinite(Date.parse(lease.at))
      || !/^[A-Za-z0-9_-]{32,}$/.test(lease.tokenVerifier)
    ) return null;
    if (lease.event === 'claim') {
      const priorClaim = appliedClaims.get(lease.generation);
      if (priorClaim) {
        // 同 generation 逐字节相同 → 幂等 no-op；任何字段差异仍 fail-closed。
        if (isSameAuthenticatedLeaseEvent(priorClaim, lease)) {
          duplicateLeaseMessages.add(message);
          continue;
        }
        return null;
      }
      if (appliedTombstones.has(lease.generation)) {
        // 迟到真 claim：只和解历史窗，不复活权威、不覆盖后代。
        const claimedAt = Date.parse(lease.at);
        const claimedUntil = Date.parse(lease.claimedUntil);
        if (
          message.state !== 'working'
          || !Number.isFinite(claimedAt)
          || !Number.isFinite(claimedUntil)
          || claimedUntil <= claimedAt
        ) return null;
        firstClaimedAt = firstClaimedAt ?? lease.at;
        appliedClaims.set(lease.generation, lease);
        recordAcceptedWindow(lease.generation, lease.claimedUntil);
        duplicateLeaseMessages.add(message);
        continue;
      }
      const claimedAt = Date.parse(lease.at);
      const claimedUntil = Date.parse(lease.claimedUntil);
      const taskClaimedAt = firstClaimedAt ?? lease.at;
      const taskClaimedAtMs = Date.parse(taskClaimedAt);
      if (
        message.state !== 'working'
        || lease.generation !== previousGeneration + 1
        || !Number.isFinite(claimedAt)
        || !Number.isFinite(claimedUntil)
        || !Number.isFinite(taskClaimedAtMs)
        || (leaseAuthority?.claimedUntil && claimedAt < Date.parse(leaseAuthority.claimedUntil))
        || claimedUntil <= claimedAt
      ) return null;
      firstClaimedAt = taskClaimedAt;
      previousGeneration = lease.generation;
      releasedLease = undefined;
      expiredLease = undefined;
      leaseAuthority = {
        claimedUntil: lease.claimedUntil,
        leaseGeneration: lease.generation,
        tokenVerifier: lease.tokenVerifier,
        generationClaimedAt: lease.at,
        firstClaimedAt,
      };
      appliedClaims.set(lease.generation, lease);
      recordAcceptedWindow(lease.generation, lease.claimedUntil);
      continue;
    }
    if (lease.event === 'renew') {
      const priorRenews = appliedRenews.get(lease.generation) ?? [];
      if (priorRenews.some((prior) => isSameAuthenticatedLeaseEvent(prior, lease))) {
        duplicateLeaseMessages.add(message);
        continue;
      }
      const renewedAt = Date.parse(lease.at);
      const claimedUntil = Date.parse(lease.claimedUntil);
      if (!Number.isFinite(renewedAt) || !Number.isFinite(claimedUntil)) return null;

      if (leaseAuthority && lease.generation === leaseAuthority.leaseGeneration) {
        const generationClaimedAt = Date.parse(leaseAuthority.generationClaimedAt ?? '');
        const taskClaimedAt = Date.parse(leaseAuthority.firstClaimedAt ?? firstClaimedAt ?? '');
        if (
          !leaseAuthority.claimedUntil || !leaseAuthority.tokenVerifier
          || !leaseVerifiersEqual(lease.tokenVerifier, leaseAuthority.tokenVerifier)
          || !Number.isFinite(generationClaimedAt)
          || !Number.isFinite(taskClaimedAt)
          || renewedAt >= Date.parse(leaseAuthority.claimedUntil)
          || claimedUntil <= Date.parse(leaseAuthority.claimedUntil)
        ) return null;
        leaseAuthority = { ...leaseAuthority, claimedUntil: lease.claimedUntil };
        appliedRenews.set(lease.generation, [...priorRenews, lease]);
        recordAcceptedWindow(lease.generation, lease.claimedUntil);
        continue;
      }

      // Late renew for historical generation N (after N+1 or tombstone)
      const historicalClaim = appliedClaims.get(lease.generation);
      if (!historicalClaim) return null;
      if (!leaseVerifiersEqual(lease.tokenVerifier, historicalClaim.tokenVerifier)) return null;
      const priorWindow = appliedClaimWindows.get(lease.generation)?.claimedUntil ?? historicalClaim.claimedUntil;
      const thenClaimedUntil = Date.parse(priorWindow);
      const generationClaimedAt = Date.parse(historicalClaim.at);
      const taskClaimedAt = Date.parse(firstClaimedAt ?? historicalClaim.at);
      if (
        !Number.isFinite(thenClaimedUntil)
        || !Number.isFinite(generationClaimedAt)
        || !Number.isFinite(taskClaimedAt)
        || renewedAt >= thenClaimedUntil
        || claimedUntil <= thenClaimedUntil
        || claimedUntil - generationClaimedAt > TASK_LEASE_GENERATION_MAX_MS
        || claimedUntil - taskClaimedAt > TASK_LEASE_TASK_MAX_MS
      ) return null;
      appliedRenews.set(lease.generation, [...priorRenews, lease]);
      recordAcceptedWindow(lease.generation, lease.claimedUntil);
      duplicateLeaseMessages.add(message);
      continue;
    }
    const priorRelease = appliedReleases.get(lease.generation);
    if (priorRelease) {
      if (isSameAuthenticatedLeaseEvent(priorRelease, lease)) {
        duplicateLeaseMessages.add(message);
        continue;
      }
      return null;
    }
    const releasedAt = Date.parse(lease.at);
    if (!Number.isFinite(releasedAt)) return null;

    if (leaseAuthority && lease.generation === leaseAuthority.leaseGeneration) {
      if (
        !leaseAuthority.claimedUntil || !leaseAuthority.tokenVerifier
        || !leaseVerifiersEqual(lease.tokenVerifier, leaseAuthority.tokenVerifier)
        || releasedAt >= Date.parse(leaseAuthority.claimedUntil)
      ) return null;
      leaseAuthority = undefined;
      expiredLease = undefined;
      releasedLease = {
        leaseGeneration: lease.generation,
        tokenVerifier: lease.tokenVerifier,
        reason: lease.reason,
        ...(firstClaimedAt ? { firstClaimedAt } : {}),
      };
      appliedReleases.set(lease.generation, lease);
      continue;
    }

    // Late release for historical generation N
    const historicalClaim = appliedClaims.get(lease.generation);
    if (!historicalClaim) return null;
    if (!leaseVerifiersEqual(lease.tokenVerifier, historicalClaim.tokenVerifier)) return null;
    const priorWindow = appliedClaimWindows.get(lease.generation)?.claimedUntil ?? historicalClaim.claimedUntil;
    const thenClaimedUntil = Date.parse(priorWindow);
    if (!Number.isFinite(thenClaimedUntil) || releasedAt >= thenClaimedUntil) return null;
    appliedReleases.set(lease.generation, lease);
    duplicateLeaseMessages.add(message);
    continue;
  }
  const request = first.approval;
  if (request?.type === 'request') {
    const snapshot = request.snapshot;
    if (
      first.state !== 'input-required'
      || snapshot.reviewer !== first.to
      || snapshot.reviewer === first.from
      || approvalActionDigest(snapshot.action) !== snapshot.digest
      || !Number.isFinite(Date.parse(snapshot.expiresAt))
      || leaseEvents.length > 0
      || ordered.some((message) => {
        const event = message.approval;
        if (!event) return true;
        if (event.type === 'request') return message !== first;
        return event.digest !== snapshot.digest;
      })
    ) return null;
    // Only parser-validated approval events reach this point. Select the
    // mailbox-first terminal decision deterministically even if a duplicate
    // or a later validly stamped conflicting event exists.
    const terminal = ordered.find((message) =>
      message.approval?.type === 'decision' || message.approval?.type === 'expired',
    ) ?? first;
    const messages = ordered.map(toPublicTaskMessage);
    return {
      id,
      from: first.from,
      to: first.to,
      subject: first.subject,
      state: terminal.state,
      createdAt: first.date,
      updatedAt: boardUpdatedAt(ordered, terminal),
      ...(rootParent !== undefined ? { parentTaskId: rootParent } : {}),
      messages,
      ...(terminal.result !== undefined ? { result: terminal.result } : {}),
      kind: 'approval',
      approval: snapshot,
    };
  }
  // An approval decision without the authenticated immutable request is never
  // allowed to masquerade as an ordinary task thread.
  if (ordered.some((message) => message.approval)) return null;
  // Once an API-stamped terminal event exists it is immutable. A copied old
  // (but validly signed) submitted/working mail can appear again in IMAP, but
  // it cannot reopen the completed/failed task. Before that point normal
  // concurrent writes retain mailbox-order last-writer-wins semantics.
  const durableOrdered = ordered.filter((message) => !duplicateLeaseMessages.has(message)).map((message) => message.lease
    ? { ...message, date: message.lease.at }
    : message);
  const current = currentTaskMessage(durableOrdered);
  const messages = durableOrdered.map((message) => ({
    ...toPublicTaskMessage(message),
    ...(message.lease ? { date: message.lease.at } : {}),
  }));
  const task: Task = {
    id,
    from: first.from,
    to: first.to,
    subject: first.subject,
    state: current.state,
    createdAt: first.date,
    // 催办可把工单顶到列表前；terminal 之后重放的旧状态信不得刷新可见窗。
    updatedAt: boardUpdatedAt(durableOrdered, current),
    ...(rootParent !== undefined ? { parentTaskId: rootParent } : {}),
    messages,
    ...(current.result !== undefined ? { result: current.result } : {}),
  };
  if (leaseAuthority && !TERMINAL_TASK_STATES.includes(current.state)) {
    task.lease = leaseAuthority;
  } else if (releasedLease && !TERMINAL_TASK_STATES.includes(current.state)) {
    task.releasedLease = releasedLease;
  } else if (expiredLease && !TERMINAL_TASK_STATES.includes(current.state)) {
    task.expiredLease = expiredLease;
  }
  if (lostLease && !TERMINAL_TASK_STATES.includes(current.state) && !leaseAuthority) {
    task.lostLease = lostLease;
  }
  // ORDER-2078 clause3: authenticated tombstone history is evidence, not
  // authority — preserve it privately even through terminal reconstruction so
  // exact-evidenced rows can retire on terminal tasks. Never projected.
  if (appliedTombstones.size > 0) {
    task.tombstoneReceipts = [...appliedTombstones.values()];
  }
  // #156：accepted 链回执全史是证据而非权威——终态重建同样私有保留，
  // 供 M2 精确退休；永不公开投影。
  if (appliedExpiryReceipts.size > 0) {
    task.expiryReceipts = [...appliedExpiryReceipts.values()].flat();
  }
  return task;
}

/** 终态状态事件：completed/failed（admin-closed 是带 closed_by_admin 的 failed）。
 * expired 回执即使 stamp 了终态 state，也只是审计信，不算状态转移。 */
function isTerminalStateEvent(message: RawTaskMessage): boolean {
  if (message.kind === 'reminder') return false;
  if (message.lease?.event === 'expired' || message.lease?.event === 'claim_lost') return false;
  return TERMINAL_TASK_STATES.includes(message.state);
}

/** 列表 updatedAt：权威状态事件与 reminder 的较新者。
 * terminal 之后的 reminder（含重放的旧 stamped 催办）不得刷新 30 天可见窗。 */
function boardUpdatedAt<T extends { date: string; state: TaskState; kind?: TaskEventKind }>(
  ordered: T[],
  current: T,
): string {
  let latest = current.date;
  let latestMs = Date.parse(current.date);
  const terminal = TERMINAL_TASK_STATES.includes(current.state);
  const terminalMs = Date.parse(current.date);
  let passedTerminal = false;
  for (const message of ordered) {
    const isTerminalEvent =
      message.kind !== 'reminder' && TERMINAL_TASK_STATES.includes(message.state);
    if (isTerminalEvent) {
      passedTerminal = true;
      continue;
    }
    if (message.kind !== 'reminder') continue;
    // eligible reminder 只认 terminal 事件之前的（顺序 + 时间）。
    if (terminal && passedTerminal) continue;
    const ms = Date.parse(message.date);
    if (!Number.isFinite(ms)) continue;
    if (terminal && ms > terminalMs) continue;
    if (ms >= latestMs) {
      latestMs = ms;
      latest = message.date;
    }
  }
  return latest;
}

/** Select the authoritative event from mailbox-ordered task messages. */
export function currentTaskMessage<T extends { uid: number; state: TaskState; kind?: TaskEventKind }>(
  messages: T[],
): T {
  const ordered = [...messages].sort((a, b) => a.uid - b.uid);
  const stateEvents = ordered.filter((message) => message.kind !== 'reminder');
  const pool = stateEvents.length > 0 ? stateEvents : ordered;
  const firstTerminal = pool.find((message) => TERMINAL_TASK_STATES.includes(message.state));
  return firstTerminal ?? pool[pool.length - 1]!;
}

type TaskLookupResult = {
  messages: ParsedTaskMessage[];
  hadMatchingRows: boolean;
};

async function findTaskMessages(id: string): Promise<TaskLookupResult> {
  if (findTaskMessagesForTests) return findTaskMessagesForTests(id);
  return withInbox(async (client) => {
    const uids = await client.search({ header: { 'x-oa-task': id } }, { uid: true });
    if (!uids || uids.length === 0) return { messages: [], hadMatchingRows: false };
    const messages: ParsedTaskMessage[] = [];
    for await (const message of client.fetch(
      uids,
      { envelope: true, internalDate: true, source: true },
      { uid: true },
    )) {
      // 与 list 扫描对齐：先解析一次 MIME，重建与 integrity witness 共用 preParsed，避免噪声信二次 full parse。
      if (!message.source) continue;
      const preParsed = await simpleParser(message.source);
      const parsed = await parseTaskMessageWithIntegrity(message, id, preParsed);
      if (parsed) messages.push(parsed);
    }
    return { messages, hadMatchingRows: true };
  });
}

/** Raw durable/queued snapshot. Lock-holding writers must use this rather
 * than public getTask(), whose approval read path may itself materialize.
 * mergeOverlay=false 只给调用方要 durable 原样时用。
 * publicRead=true 走 M1 有界 overlay（仅展示）；默认无界，写路径零变化。 */
export async function getTaskSnapshot(id: string, opts?: { mergeOverlay?: boolean; publicRead?: boolean }): Promise<Task | null> {
  if (!isTaskId(id)) return null;
  const mergeOverlay = opts?.mergeOverlay !== false;
  // 公共读才套有界变体；写路径/reaper 默认不传，保持全量 overlay。
  const publicRead = opts?.publicRead === true;
  let raw: Task | null;
  let hadMatchingRows: boolean;

  if (getTaskForTests) {
    raw = await getTaskForTests(id);
    hadMatchingRows = raw !== null;
  } else {
    const lookup = await findTaskMessages(id);
    hadMatchingRows = lookup.hadMatchingRows;
    raw = lookup.messages.length > 0 ? taskFromParsedMessages(id, lookup.messages) : null;
  }

  if (raw) {
    if (mergeOverlay && taskLeasePendingJournalEnabled()) await hydrateOverlaysFromJournal(raw);
    return mergeOverlay ? mergeQueuedEvents(raw, { publicRead }) : raw;
  }

  // Matching rows existed in IMAP but reconstruction failed (e.g. integrity failure).
  // Fail closed: suppress/retire synthetic base and return null.
  if (hadMatchingRows) {
    if (syntheticTaskBases.has(id)) {
      syntheticTaskBases.delete(id);
      invalidateTaskListCache();
    }
    return null;
  }

  const synthetic = getSyntheticTaskBase(id);
  if (!synthetic) return null;
  if (mergeOverlay && taskLeasePendingJournalEnabled()) await hydrateOverlaysFromJournal(synthetic);
  return mergeOverlay ? mergeQueuedEvents(synthetic, { publicRead }) : synthetic;
}

const PARENT_CHAIN_MAX = 64;

function validateParentChain(snapshot: Task[], parentTaskId: string, childId: string, sender: string): void {
  const byId = new Map(snapshot.map((task) => [task.id, task]));
  const first = byId.get(parentTaskId) ?? null;
  if (!first) throw new Error('parent_task_not_found');
  if (!taskParticipants(first).has(sender.toLowerCase())) throw new Error('parent_task_sender_not_participant');
  const seen = new Set<string>();
  let current: Task | null = first;
  for (let depth = 0; current; depth += 1) {
    if (current.id === childId || seen.has(current.id)) throw new Error('parent_task_invalid_chain');
    seen.add(current.id);
    const next: string | undefined = current.parentTaskId;
    if (next === undefined) return;
    if (!isTaskId(next) || seen.size >= PARENT_CHAIN_MAX) throw new Error('parent_task_invalid_chain');
    current = byId.get(next) ?? null;
    if (!current) throw new Error('parent_task_invalid_chain');
  }
}

async function withValidatedParent<T>(
  parentTaskId: string | undefined,
  childId: string,
  sender: string,
  deliver: () => Promise<T>,
): Promise<T> {
  if (parentTaskId === undefined) return deliver();
  // One durable cached IMAP snapshot validates the immutable ancestor chain.
  // The immediate-parent lock serializes only validation; SMTP is deliberately
  // outside the lock so a slow external round-trip cannot block peer creates.
  await withTaskLock(parentTaskId, async () => {
    validateParentChain(await loadImapTaskSnapshot(), parentTaskId, childId, sender);
  });
  return deliver();
}

/** Service detail reads lazily make an expired approval terminal. There is no
 * scheduler or list sweep: only the next detail/wait/decision observes it. */
async function materializeApprovalExpiry(task: Task | null): Promise<Task | null> {
  if (!task || !isApprovalTask(task) || task.state !== 'input-required' || !isApprovalExpired(task.approval.expiresAt)) return task;
  return withTaskLock(task.id, async () => {
    const current = await getTaskSnapshot(task.id);
    if (!current || !isApprovalTask(current) || current.state !== 'input-required' || !isApprovalExpired(current.approval.expiresAt)) return current;
    return materializeApprovalExpiryUnlocked(current);
  });
}

export async function getTask(id: string): Promise<Task | null> {
  // 详情是公共读：overlay 走有界变体。审批过期物化仍在锁内用无界快照。
  return materializeApprovalExpiry(await getTaskSnapshot(id, { publicRead: true }));
}

type TaskListSnapshot = {
  tasks: Task[];
  hadMatchingRowsIds: Set<string>;
};

async function scanDurableTasks(
  parser: (source: Buffer | string) => Promise<ParsedMail> = simpleParser,
): Promise<TaskListSnapshot> {
  return withInbox(async (client) => {
    const uids = await client.search({ header: { 'x-oa-task': true } }, { uid: true });
    if (!uids || uids.length === 0) return { tasks: [], hadMatchingRowsIds: new Set() };
    const hadMatchingRowsIds = new Set<string>();
    const grouped = new Map<string, ParsedTaskMessage[]>();
    for await (const message of client.fetch(
      uids,
      { envelope: true, internalDate: true, source: true },
      { uid: true },
    )) {
      if (!message.source) continue;
      const parsed = await parser(message.source);
      const id = parsed.headers.get('x-oa-task');
      if (typeof id !== 'string' || !isTaskId(id)) continue;
      hadMatchingRowsIds.add(id);
      const taskMessage = await parseTaskMessageWithIntegrity(message, id, parsed);
      if (!taskMessage) continue;
      const entries = grouped.get(id) ?? [];
      entries.push(taskMessage);
      grouped.set(id, entries);
    }
    const tasks = [...grouped.entries()]
      .map(([id, messages]) => taskFromParsedMessages(id, messages))
      .filter((task): task is Task => !!task)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { tasks, hadMatchingRowsIds };
  });
}

/**
 * Project a durable task list snapshot by combining it with allowed unindexed
 * synthetic task bases and applying queued-event overlays.
 */
async function hydrateTaskListFromJournal(tasks: Task[]): Promise<void> {
  if (!taskLeasePendingJournalEnabled()) return;
  // Journal availability is validated even when the eligible task set is
  // empty: an empty list still performs zero batch persists and zero exit
  // lookups, but it must not report success over a missing, lost, corrupt or
  // latched journal.
  await ensureLeaseJournalLoaded();
  if (tasks.length === 0) return;
  const frozen = cloneLoadedLeaseJournal();
  await fireJournalBeforeListSelectionForTests();
  const selected: Array<JournalRowKey & { snapshot: string }> = [];
  for (const task of tasks) {
    await hydrateOverlaysFromLoadedJournal(task, { retireSelections: selected, file: frozen });
  }
  await batchRetireAcceptedIndexedRows(selected);
}

async function projectTaskListSnapshot(snapshot: TaskListSnapshot): Promise<Task[]> {
  const unindexed = getUnindexedSyntheticTaskBases(snapshot.tasks, snapshot.hadMatchingRowsIds);
  const combined = unindexed.length === 0 ? snapshot.tasks : [...snapshot.tasks, ...unindexed];
  // One journal load for the whole list; publicRead keeps the M1 overlay bound.
  await hydrateTaskListFromJournal(combined);
  return combined.map((task) => mergeQueuedEvents(task, { publicRead: true }));
}

export async function listTasks(state?: TaskState): Promise<Task[]> {
  const snapshot = await scanDurableTasks();
  const projected = await projectTaskListSnapshot(snapshot);
  const filtered = state ? projected.filter((task) => task.state === state) : projected;
  return filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function syntheticTask(input: CreateTaskInput, id: string, messageId: string): Task {
  const now = new Date(nowMs()).toISOString();
  return {
    id,
    from: input.from,
    to: input.to,
    subject: input.subject,
    state: 'submitted',
    createdAt: now,
    updatedAt: now,
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    messages: [{ id: messageId, from: input.from, to: input.to, subject: input.subject, date: now, state: 'submitted', body: input.body }],
  };
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const id = taskIdForTests ? taskIdForTests() : randomUUID();
  const parentTaskId = normalizeParentTaskId(input.parentTaskId);
  const normalized = parentTaskId === undefined ? input : { ...input, parentTaskId };
  const deliver = async () => deliverMail({
    from: input.from,
    to: [input.to],
    subject: input.subject,
    text: input.body,
    headers: taskHeaders(id, 'submitted', input.from, input.to, parentTaskId),
  });
  const { messageId } = await withValidatedParent(parentTaskId, id, input.from, deliver);
  // This is a server-authenticated assignment, so it may wake the target's
  // agent route. The generic IMAP watcher never has that authority.
  notifyTrustedTaskDelivery(input.to);
  invalidateTaskListCache();
  const task = syntheticTask(normalized, id, messageId);
  recordSyntheticTaskBase(task);
  return task;
}

export function knownManagedIdentity(
  address: string,
  find: (address: string) => any = findIdentity,
): boolean {
  const domain = address.split('@')[1]?.toLowerCase();
  return !!domain && config.allDomains.has(domain) && !!find(address);
}

/** Creates the only mutable approval request event. The action is recorded,
 * never executed; its canonical snapshot is immutable after this point. */
export async function createApprovalTask(input: CreateApprovalTaskInput): Promise<ApprovalTask> {
  const from = input.from.toLowerCase();
  const to = input.to.toLowerCase();
  const parentTaskId = normalizeParentTaskId(input.parentTaskId);
  if (from === to) throw new Error('approval_participants_must_differ');
  if (!knownManagedIdentity(from) || !knownManagedIdentity(to)) throw new Error('approval_identity_required');
  assertApprovalExpiryBound(input.expiresAt);
  const rawAction = approvalActionFields(input.action);
  assertApprovalActionBounds(rawAction);
  const action = normalizedApprovalAction(rawAction);
  const digest = approvalActionDigest(action);
  const snapshot: ApprovalSnapshot = { action, reviewer: to, expiresAt: input.expiresAt, digest };
  const id = taskIdForTests ? taskIdForTests() : randomUUID();
  const text = approvalRequestBody(input.body, snapshot);
  const deliver = async () => deliverMail({
    from,
    to: [to],
    subject: input.subject,
    text,
    headers: approvalHeaders(id, 'input-required', from, to, {
      event: 'request', digest, reviewer: to, expiresAt: input.expiresAt,
    }, parentTaskId),
  });
  const { messageId } = await withValidatedParent(parentTaskId, id, from, deliver);
  notifyTrustedTaskDelivery(to);
  invalidateTaskListCache();
  const now = new Date(nowMs()).toISOString();
  const task: ApprovalTask = {
    id,
    from,
    to,
    subject: input.subject,
    state: 'input-required',
    createdAt: now,
    updatedAt: now,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    messages: [{
      id: messageId,
      from,
      to,
      subject: input.subject,
      date: now,
      state: 'input-required',
      body: text,
      approval: { type: 'request', snapshot },
    }],
    kind: 'approval',
    approval: snapshot,
  };
  recordSyntheticTaskBase(task);
  getEventDispatcher().dispatchApprovalRequested(task);
  return task;
}

const taskLocks = new Map<string, Promise<void>>();
let nowFn: () => number = () => Date.now();
let listCache: { at: number; snapshot: TaskListSnapshot } | null = null;
let listAllForTests: (() => Promise<Task[]>) | null = null;
let getTaskForTests: ((id: string) => Promise<Task | null>) | null = null;
/** 测试注入 findTaskMessages 结果，用于走 getTaskSnapshot 的 hadMatchingRows 抑制路径。 */
let findTaskMessagesForTests: ((id: string) => Promise<TaskLookupResult>) | null = null;
/** Installed as journal production lookup only in production, or in tests when findTaskMessagesForTests is set. */
let productionJournalExitLookup: ((
  taskId: string,
  opts: { signal: AbortSignal },
) => Promise<JournalExitEvidence>) | null = null;
let sendMailForTests: ((input: SendInput) => Promise<{ messageId: string }>) | null = null;
let preSmtpHookForTests: ((rec: JournalRecord) => void | Promise<void>) | null = null;
let postSmtpAcceptHookForTests: ((rec: JournalRecord) => void | Promise<void>) | null = null;
/** Test-only deterministic child id; production always uses crypto.randomUUID. */
let taskIdForTests: (() => string) | null = null;
type TaskSideEffectObserverForTests = {
  notifications: string[];
  cacheInvalidations: number;
  queuedTaskIds: string[];
};
let taskSideEffectObserverForTests: TaskSideEffectObserverForTests | null = null;
/** IMAP 索引滞后窗口内的已发事件（状态转移 + reminder + lease），供后续读合并。 */
const queuedEvents = new Map<string, QueuedEvent[]>();
const QUEUED_EVENT_TTL_MS = 60 * 1000;
/** M1：task+generation 首次停播去重；插入序淘汰，有界 1024。 */
export const LEASE_OVERLAY_REPLAY_EXPIRED_SEEN_CAP = 1024;
/** M1：进程级 warn 发射限频——窗口内最多 1 条，计数器仍按 key 累计。 */
export const LEASE_OVERLAY_REPLAY_EXPIRED_WARN_INTERVAL_MS = 60 * 1000;
const overlayReplayExpiredSeen = new Map<string, true>();
let overlayReplayExpiredCount = 0;
let overlayReplayExpiredLastWarnAt = 0;

type QueuedEvent = {
  message: TaskMessage;
  sentAt: number;
  lease?: LeaseEvent;
};

type SyntheticTaskBase = {
  task: Task;
  createdAtMs: number;
};

/** Bounded in-memory synthetic task base retained after SMTP acceptance during the IMAP indexing lag window. */
const syntheticTaskBases = new Map<string, SyntheticTaskBase>();
const SYNTHETIC_TASK_TTL_MS = QUEUED_EVENT_TTL_MS;
const SYNTHETIC_TASK_BASE_CAPACITY = 100;

function evictExpiredSyntheticTaskBases(now: number): void {
  for (const [id, entry] of syntheticTaskBases.entries()) {
    if (now - entry.createdAtMs > SYNTHETIC_TASK_TTL_MS) {
      syntheticTaskBases.delete(id);
    }
  }
}

function recordSyntheticTaskBase(task: Task): void {
  const now = nowMs();
  syntheticTaskBases.delete(task.id);

  if (syntheticTaskBases.size >= SYNTHETIC_TASK_BASE_CAPACITY) {
    evictExpiredSyntheticTaskBases(now);
  }

  while (syntheticTaskBases.size >= SYNTHETIC_TASK_BASE_CAPACITY) {
    const oldestId = syntheticTaskBases.keys().next().value;
    if (oldestId === undefined) break;
    syntheticTaskBases.delete(oldestId);
  }

  syntheticTaskBases.set(task.id, {
    task: structuredClone(task),
    createdAtMs: now,
  });
}

function getSyntheticTaskBase(id: string): Task | null {
  const entry = syntheticTaskBases.get(id);
  if (!entry) return null;
  if (nowMs() - entry.createdAtMs > SYNTHETIC_TASK_TTL_MS) {
    syntheticTaskBases.delete(id);
    return null;
  }
  return structuredClone(entry.task);
}

function getUnindexedSyntheticTaskBases(
  indexed: Task[],
  hadMatchingRowsIds: ReadonlySet<string> = new Set(indexed.map((task) => task.id)),
): Task[] {
  const indexedIds = new Set(indexed.map((task) => task.id));
  const now = nowMs();
  const unindexed: Task[] = [];
  for (const [id, entry] of syntheticTaskBases.entries()) {
    if (indexedIds.has(id)) {
      syntheticTaskBases.delete(id);
      continue;
    }
    if (hadMatchingRowsIds.has(id)) {
      // Matching row(s) exist in IMAP but reconstruction failed (e.g. integrity failure).
      // Fail closed: suppress and delete synthetic base so board reads do not expose it.
      syntheticTaskBases.delete(id);
      continue;
    }
    if (now - entry.createdAtMs > SYNTHETIC_TASK_TTL_MS) {
      syntheticTaskBases.delete(id);
      continue;
    }
    unindexed.push(structuredClone(entry.task));
  }
  return unindexed;
}

export function setTaskNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function setTaskListAllForTests(fn: (() => Promise<Task[]>) | null): void {
  listAllForTests = fn;
  listCache = null;
}

export function setTaskGetForTests(fn: ((id: string) => Promise<Task | null>) | null): void {
  getTaskForTests = fn;
}

/** 测试专用：注入 IMAP 查找结果，使 getTaskSnapshot 走真实 hadMatchingRows 分支。 */
export function setFindTaskMessagesForTests(
  fn: ((id: string) => Promise<{ messages: ParsedTaskMessage[]; hadMatchingRows: boolean }>) | null,
): void {
  findTaskMessagesForTests = fn;
  if (process.env.NODE_ENV === 'test') {
    setJournalExitEvidenceLookup(fn && productionJournalExitLookup ? productionJournalExitLookup : null);
  }
}

export function setTaskSendMailForTests(
  fn: ((input: SendInput) => Promise<{ messageId: string }>) | null,
): void {
  sendMailForTests = fn;
}

export function setPreSmtpHookForTests(
  fn: ((rec: JournalRecord) => void | Promise<void>) | null,
): void {
  preSmtpHookForTests = fn;
}

export function setPostSmtpAcceptHookForTests(
  fn: ((rec: JournalRecord) => void | Promise<void>) | null,
): void {
  postSmtpAcceptHookForTests = fn;
}

/** Narrow R2 seam: makes server-generated-child self-reference rejectable in tests. */
export function setTaskIdForTests(fn: (() => string) | null): void {
  taskIdForTests = fn;
}

/** Internal test observer for create-side-effect boundary; production keeps it null. */
export function observeTaskSideEffectsForTests(): TaskSideEffectObserverForTests {
  return taskSideEffectObserverForTests = { notifications: [], cacheInvalidations: 0, queuedTaskIds: [] };
}

export function clearTaskSideEffectObserverForTests(): void {
  taskSideEffectObserverForTests = null;
}

export function clearQueuedEventsForTests(): void {
  queuedEvents.clear();
  syntheticTaskBases.clear();
  // 单测之间清掉停播去重与计数，避免跨用例串味。
  overlayReplayExpiredSeen.clear();
  overlayReplayExpiredCount = 0;
  overlayReplayExpiredLastWarnAt = 0;
}

/** 测试可读：累计首次停播次数。 */
export function takeLeaseOverlayReplayExpiredCountForTests(): number {
  const n = overlayReplayExpiredCount;
  overlayReplayExpiredCount = 0;
  return n;
}

function indexedLeaseGenerationDominates(
  task: Task,
  queuedGeneration: number,
  expiredReceipt: 'exclude' | 'strict' | 'equal-or-newer',
): boolean {
  // A durable authenticated claim_lost receipt burns its generation and every
  // older one: queued rows they would otherwise replay are retired. Newer
  // generations are never dominated by an older tombstone.
  if ((task.lostLease?.leaseGeneration ?? 0) >= queuedGeneration) return true;
  const indexedGeneration = task.lease?.leaseGeneration
    ?? task.releasedLease?.leaseGeneration
    ?? (expiredReceipt === 'exclude' ? undefined : task.expiredLease?.leaseGeneration)
    ?? 0;
  return indexedGeneration > queuedGeneration
    || (expiredReceipt === 'equal-or-newer' && task.expiredLease?.leaseGeneration === queuedGeneration);
}

/** 已索引的事件不再需要 synthetic 补丁。 */
function eventIsIndexed(task: Task, queued: QueuedEvent): boolean {
  if (queued.lease) {
    const authority = task.lease;
    if (queued.lease.event === 'claim_lost') {
      // ORDER-2074 strict: a tombstone row retires ONLY on a durable
      // AUTHENTICATED receipt whose complete event identity matches
      // (generation/at/claimedUntil/firstClaimedAt). No generation-only,
      // dominance, or terminality shortcut retires a tombstone row; without an
      // exact receipt the row stays OPEN (fail-closed default). A historical
      // no-op receipt is still authenticated durable evidence. The effective
      // tombstone behind task.lostLease is itself in tombstoneReceipts, so all
      // authenticated retirements are preserved.
      const queuedLease = queued.lease;
      const receipt = task.tombstoneReceipts?.find((stone) =>
        stone.generation === queuedLease.generation
        && stone.at === queuedLease.at
        && stone.claimedUntil === queuedLease.claimedUntil
        && stone.firstClaimedAt === queuedLease.firstClaimedAt);
      return !!receipt;
    }
    if (queued.lease.event === 'expired') {
      const receipt = task.expiredLease;
      const queuedLease = queued.lease;
      // 身份匹配（含 #156 accepted 链审计回执的精确身份）、后继代已索引、
      // 或 durable 已终态都退休。
      // 终态重建剥离全部 lease 回执，同代无后继可 dominates，不退休则每读重放。
      return (!!receipt && isSameLeaseExpiryIdentity(receipt, queuedLease))
        || !!task.expiryReceipts?.some((accepted) => isSameLeaseExpiryIdentity(accepted, queuedLease))
        || indexedLeaseGenerationDominates(task, queued.lease.generation, 'strict')
        || TERMINAL_TASK_STATES.includes(task.state);
    }
    if (queued.lease.event === 'release') {
      // release 同病：终态剥离 releasedLease，dominates(exclude) 也落空。
      return indexedLeaseGenerationDominates(task, queued.lease.generation, 'exclude')
        || (task.releasedLease?.leaseGeneration === queued.lease.generation
        && leaseVerifiersEqual(task.releasedLease.tokenVerifier, queued.lease.tokenVerifier)
        && task.releasedLease.reason === queued.lease.reason)
        || TERMINAL_TASK_STATES.includes(task.state);
    }
    if (indexedLeaseGenerationDominates(task, queued.lease.generation, 'equal-or-newer')) return true;
    const released = task.releasedLease;
    if (!authority) {
      return !!released
        && (released.leaseGeneration > queued.lease.generation
          || (released.leaseGeneration === queued.lease.generation
            && leaseVerifiersEqual(released.tokenVerifier, queued.lease.tokenVerifier)));
    }
    if (authority.leaseGeneration > queued.lease.generation) return true;
    if (authority.leaseGeneration !== queued.lease.generation) return false;
    return leaseVerifiersEqual(authority.tokenVerifier, queued.lease.tokenVerifier)
      && Date.parse(authority.claimedUntil) >= Date.parse(queued.lease.claimedUntil);
  }
  if (queued.message.kind === 'reminder') {
    return task.messages.some((message) => {
      if (message.kind !== 'reminder') return false;
      if (queued.message.idempotencyKey) {
        return message.idempotencyKey === queued.message.idempotencyKey;
      }
      const at = Date.parse(message.date);
      return (
        message.from === queued.message.from
        && message.body === queued.message.body
        && Number.isFinite(at)
        && at >= queued.sentAt - 1000
      );
    });
  }
  const queuedApproval = queued.message.approval;
  if (queuedApproval?.type === 'decision' || queuedApproval?.type === 'expired') {
    return task.messages.some((message) => {
      const indexed = message.approval;
      if (!indexed || indexed.type !== queuedApproval.type || indexed.digest !== queuedApproval.digest) return false;
      if (indexed.type === 'decision' && (queuedApproval.type !== 'decision' || indexed.decision !== queuedApproval.decision)) return false;
      return message.state === queued.message.state;
    });
  }
  return (
    task.messages.some((message) => {
      if (message.kind === 'reminder' || message.state !== queued.message.state) return false;
      const at = Date.parse(message.date);
      return Number.isFinite(at) && at >= queued.sentAt - 1000;
    })
    // 权威视图已越过该事件：已 terminal，或已有更晚的状态信。
    || TERMINAL_TASK_STATES.includes(task.state)
    || task.messages.some((message) => {
      if (message.kind === 'reminder') return false;
      const at = Date.parse(message.date);
      return Number.isFinite(at) && at > queued.sentAt;
    })
  );
}

function applyOverlayMessages(task: Task, extra: QueuedEvent[]): Task {
  const publicExtra = extra;
  const messages = [...task.messages, ...publicExtra.map((row) => row.message)];
  const ordered = messages.map((message, index) => ({ ...message, uid: index + 1 }));
  const current = currentTaskMessage(ordered);
  const next: Task = {
    ...task,
    state: current.state,
    updatedAt: boardUpdatedAt(ordered, current),
    messages,
  };
  if (current.result !== undefined) next.result = current.result;
  else delete next.result;
  let authority = task.lease;
  let releasedLease = task.releasedLease;
  let expiredLease = task.expiredLease;
  let lostLease = task.lostLease;
  for (const event of extra.map((row) => row.lease).filter((lease): lease is LeaseEvent => !!lease)) {
    if (event.event === 'claim_lost') {
      if (authority?.leaseGeneration === event.generation) continue;
      lostLease = {
        leaseGeneration: event.generation,
        claimedUntil: event.claimedUntil,
        lostAt: event.at,
        firstClaimedAt: event.firstClaimedAt,
      };
      continue;
    }
    if (event.event === 'expired') {
      // A stale queued receipt must never clear a later authority.
      if (
        authority?.leaseGeneration === event.generation
        && authority.claimedUntil === event.claimedUntil
      ) {
        const firstClaimedAt = authority.firstClaimedAt;
        authority = undefined;
        releasedLease = undefined;
        expiredLease = {
          leaseGeneration: event.generation,
          claimedUntil: event.claimedUntil,
          expiredAt: event.expiredAt,
          ...(firstClaimedAt ? { firstClaimedAt } : {}),
        };
      }
      continue;
    }
    if (event.event === 'release') {
      const firstClaimedAt = authority?.firstClaimedAt;
      authority = undefined;
      expiredLease = undefined;
      releasedLease = {
        leaseGeneration: event.generation,
        tokenVerifier: event.tokenVerifier,
        reason: event.reason,
        ...(firstClaimedAt ? { firstClaimedAt } : {}),
      };
    } else if (event.event === 'claim') {
      const firstClaimedAt = authority?.firstClaimedAt ?? releasedLease?.firstClaimedAt ?? expiredLease?.firstClaimedAt ?? event.at;
      releasedLease = undefined;
      expiredLease = undefined;
      authority = {
        leaseGeneration: event.generation,
        claimedUntil: event.claimedUntil,
        tokenVerifier: event.tokenVerifier,
        generationClaimedAt: event.at,
        firstClaimedAt,
      };
    } else if (authority) {
      authority = { ...authority, claimedUntil: event.claimedUntil };
    }
  }
  if (TERMINAL_TASK_STATES.includes(next.state)) {
    delete next.lease;
    delete next.releasedLease;
    delete next.expiredLease;
    delete next.lostLease;
    // tombstoneReceipts are retained on terminal tasks by ORDER-2078 clause3:
    // private authenticated evidence, never authority, never projected.
  } else if (authority) {
    next.lease = authority;
    delete next.releasedLease;
  } else if (releasedLease) {
    delete next.lease;
    next.releasedLease = releasedLease;
    delete next.expiredLease;
  } else if (expiredLease) {
    delete next.lease;
    delete next.releasedLease;
    next.expiredLease = expiredLease;
  } else if (lostLease) {
    next.lostLease = lostLease;
  }
  return next;
}

/** 首次整组停播：计数按 key 累计；console.warn 进程级限频（默认 60s 一条）。 */
function noteLeaseOverlayReplayExpired(taskId: string, generation: number, ageMs: number): void {
  const key = `${taskId}:${generation}`;
  if (overlayReplayExpiredSeen.has(key)) return;
  if (overlayReplayExpiredSeen.size >= LEASE_OVERLAY_REPLAY_EXPIRED_SEEN_CAP) {
    const oldest = overlayReplayExpiredSeen.keys().next().value;
    if (oldest !== undefined) overlayReplayExpiredSeen.delete(oldest);
  }
  overlayReplayExpiredSeen.set(key, true);
  overlayReplayExpiredCount += 1;
  const now = nowMs();
  if (now - overlayReplayExpiredLastWarnAt < LEASE_OVERLAY_REPLAY_EXPIRED_WARN_INTERVAL_MS) return;
  overlayReplayExpiredLastWarnAt = now;
  console.warn({
    kind: 'lease_overlay_replay_expired',
    taskId,
    generation,
    age: ageMs,
  });
}

/**
 * 公共读停播过滤：只改返回视图，不删 queuedEvents。
 * 同一 generation 的 claim/renew/release/expired 并成一组，
 * 组锚=组内 sentAt 最大值；超龄整组停播。approval-terminal 与非 lease 行原样保留。
 */
function filterPublicLeaseOverlay(taskId: string, rows: QueuedEvent[], now: number): {
  overlay: QueuedEvent[];
  stoppedClosingGens: Set<number>;
} {
  const byGeneration = new Map<number, QueuedEvent[]>();
  const keep = new Set<QueuedEvent>();
  const stoppedClosingGens = new Set<number>();
  for (const row of rows) {
    if (!row.lease) {
      keep.add(row);
      continue;
    }
    // release/expired 必须进同一 generation 组，否则关账行被单独丢掉会把旧 claim 复活成活租约。
    const group = byGeneration.get(row.lease.generation) ?? [];
    group.push(row);
    byGeneration.set(row.lease.generation, group);
  }
  for (const [generation, group] of byGeneration) {
    const newest = group.reduce((a, b) => (a.sentAt >= b.sentAt ? a : b));
    const age = now - newest.sentAt;
    if (age > LEASE_OVERLAY_MAX_LIFETIME_MS) {
      noteLeaseOverlayReplayExpired(taskId, generation, age);
      if (group.some((row) => row.lease?.event === 'release' || row.lease?.event === 'expired')) {
        stoppedClosingGens.add(generation);
      }
      continue;
    }
    for (const row of group) keep.add(row);
  }
  // 保持原序，避免权威叠加顺序被打乱。
  return { overlay: rows.filter((row) => keep.has(row)), stoppedClosingGens };
}

/** 案 A：只压掉 durable 同代活 claim 的租约字段；不合并关账行，不动 state/消息。 */
function suppressDurableLeaseProjection(task: Task, stoppedClosingGens: ReadonlySet<number>): Task {
  if (!task.lease || !stoppedClosingGens.has(task.lease.leaseGeneration)) return task;
  const next = { ...task };
  delete next.lease;
  return next;
}

function mergeQueuedEvents(task: Task, opts?: { publicRead?: boolean }): Task {
  const pending = queuedEvents.get(task.id);
  if (!pending || pending.length === 0) return task;
  const now = nowMs();
  const stillLagging = pending.filter((row) => {
    const approvalTerminal = row.message.approval?.type === 'decision' || row.message.approval?.type === 'expired';
    if (!row.lease && !approvalTerminal && now - row.sentAt > QUEUED_EVENT_TTL_MS) return false;
    return !eventIsIndexed(task, row);
  });
  if (stillLagging.length === 0) {
    if (pending.length > 0) invalidateTaskListCache();
    queuedEvents.delete(task.id);
    return task;
  }
  if (stillLagging.length !== pending.length) invalidateTaskListCache();
  // 退休判定仍写回全量 stillLagging；有界过滤只作用于本次返回视图。
  queuedEvents.set(task.id, stillLagging);
  if (opts?.publicRead && taskLeaseOverlayBoundEnabled()) {
    const { overlay, stoppedClosingGens } = filterPublicLeaseOverlay(task.id, stillLagging, now);
    return suppressDurableLeaseProjection(applyOverlayMessages(task, overlay), stoppedClosingGens);
  }
  return applyOverlayMessages(task, stillLagging);
}

function queueEventUntilIndexed(
  taskId: string,
  message: TaskMessage,
  lease?: LeaseEvent,
): void {
  taskSideEffectObserverForTests?.queuedTaskIds.push(taskId);
  const list = queuedEvents.get(taskId) ?? [];
  list.push({
    message,
    sentAt: Date.parse(message.date) || nowMs(),
    ...(lease ? { lease } : {}),
  });
  queuedEvents.set(taskId, list);
}

/** 测试注入未索引 lease overlay，避免为限频用例走 1025 次真实 claim。 */
export function queueLeaseOverlayForTests(input: {
  taskId: string;
  sentAt: number;
  generation?: number;
}): void {
  const at = new Date(input.sentAt).toISOString();
  const generation = input.generation ?? 1;
  queueEventUntilIndexed(input.taskId, {
    id: `overlay-${input.taskId}-${generation}`,
    from: 'alpha@test.example',
    to: 'bravo@test.example',
    subject: 'overlay',
    date: at,
    state: 'working',
    body: 'overlay',
  }, {
    version: 1,
    event: 'claim',
    actor: 'bravo@test.example',
    at,
    generation,
    claimedUntil: new Date(input.sentAt + 3600 * 1000).toISOString(),
    tokenVerifier: `verifier-${input.taskId}`,
  });
}

/** 发信走可注入缝，单测才能钉死并发 reply 只写出一封 working。 */
async function deliverMail(input: SendInput): Promise<{ messageId: string }> {
  return (sendMailForTests ?? sendMail)(input);
}

export function invalidateTaskListCache(): void {
  if (taskSideEffectObserverForTests) taskSideEffectObserverForTests.cacheInvalidations += 1;
  listCache = null;
}

function notifyTrustedTaskDelivery(address: string): void {
  taskSideEffectObserverForTests?.notifications.push(address);
  void notifyTrustedAgentDelivery(address);
}

function nowMs(): number {
  return nowFn();
}

/** Internal server-clock lease boundary: equality is expired. */
function isLeaseDeadlineActive(claimedUntil: string, now = nowMs()): boolean {
  return now < Date.parse(claimedUntil);
}

async function withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = taskLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  taskLocks.set(id, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (taskLocks.get(id) === current) taskLocks.delete(id);
  }
}

/**
 * 已持 per-task 锁时的状态写入。reply/close 必须走这条，禁止再套 withTaskLock
 *（同 id 会自死锁）。调用方负责在锁内完成前置状态断言。
 */
async function updateTaskUnlocked(input: UpdateTaskInput, existing?: Task): Promise<Task | null> {
  const current = existing ?? await getTaskSnapshot(input.id);
  if (!current) return null;
  if (isApprovalTask(current)) throw new Error('approval_decision_required');
  if (!taskParticipants(current).has(input.from)) throw new Error('task_participant_required');
  if (!canAdvanceTask(current.state)) throw new Error('task_already_terminal');

  const to = input.from === current.from ? current.to : current.from;
  const text = taskBody(input.body ?? '', input.result);
  const { messageId } = await deliverMail({
    from: input.from,
    to: [to],
    subject: current.subject,
    text,
    headers: taskHeaders(current.id, input.state, input.from, to),
  });
  void notifyTrustedAgentDelivery(to);
  invalidateTaskListCache();

  const now = new Date(nowMs()).toISOString();
  const eventMessage: TaskMessage = {
    id: messageId,
    from: input.from,
    to,
    subject: current.subject,
    date: now,
    state: input.state,
    body: text,
    ...(input.result !== undefined ? { result: input.result } : {}),
  };
  const queued = { message: eventMessage, sentAt: Date.parse(now) || nowMs() };
  const persisted = await getTaskSnapshot(current.id);
  // IMAP 未索引时不得把旧 state 当真；把 synthetic 转移排进 overlay，后续读才能拒冲突。
  if (persisted && eventIsIndexed(persisted, queued)) return persisted;
  queueEventUntilIndexed(current.id, eventMessage);
  const next: Task = {
    ...current,
    state: input.state,
    updatedAt: now,
    messages: [...current.messages, eventMessage],
    ...(input.result !== undefined ? { result: input.result } : {}),
  };
  if (TERMINAL_TASK_STATES.includes(input.state)) {
    delete next.lease;
    delete next.releasedLease;
    delete next.expiredLease;
  }
  return next;
}

/** Shared core boundary for every lease mutation. Route and reaper callers
 * retain their public behavior, but no in-process caller may bypass this. */
function assertTaskLeasesEnabled(): void {
  if (!taskLeasesEnabled()) throw new Error('task_leases_disabled');
}

function assertActiveRecipientLeaseCredential(
  current: Task | null | undefined,
  from: string,
  leaseToken?: string,
): void {
  if (
    taskLeasesEnabled()
    && current?.to.toLowerCase() === from.toLowerCase()
    && current.lease?.claimedUntil
    && isLeaseDeadlineActive(current.lease.claimedUntil)
  ) {
    // Omission retains the historic opaque conflict so an ordinary recipient
    // cannot learn lease state. A supplied bearer is an authenticated attempt
    // to satisfy the fence, and may receive the stable explicit error.
    if (leaseToken === undefined) throw new Error('task_already_terminal');
    if (!isTaskLeaseTokenCurrent(current, leaseToken)) throw new Error('task_lease_required');
  }
  if (
    taskLeasePendingJournalEnabled()
    && current
    && current.to.toLowerCase() === from.toLowerCase()
  ) {
    const pending = unresolvedClaimFence(current.id);
    // accepted stays OPEN occupancy until indexed retirement, but hydration already
    // projects it as lease authority (branch above). intent/unconfirmed are fences only;
    // a bearer does not resolve an unknown claim.
    if (pending && (pending.fate === 'intent' || pending.fate === 'unconfirmed')) {
      if (leaseToken === undefined) throw new Error('task_already_terminal');
      throw new Error('task_lease_required');
    }
    // An unresolved renewal is never projected as authority, but when the old
    // durable deadline has passed its renewed window may still be live. Fence
    // recipient mutations conservatively ONLY in that gap: while an existing
    // lease window is still active, the established branch above already
    // governs bearer behavior and this fence must not override it. A supplied
    // bearer cannot resolve an unknown renewal either. Recovery of the
    // renewal itself stays with renewTask's authenticated retry path.
    const existingLeaseActive = !!(current.lease?.claimedUntil
      && isLeaseDeadlineActive(current.lease.claimedUntil));
    const pendingRenewal = !existingLeaseActive && journalRecordsFor(current.id).find((row) =>
      row.kind === 'renew'
      && (row.fate === 'intent' || row.fate === 'unconfirmed')
      && !!row.claimedUntil
      && isLeaseDeadlineActive(row.claimedUntil));
    if (pendingRenewal) {
      if (leaseToken === undefined) throw new Error('task_already_terminal');
      throw new Error('task_lease_required');
    }
  }
}

export async function updateTask(input: UpdateTaskInput): Promise<Task | null> {
  return withTaskLock(input.id, async () => {
    const current = await getTaskSnapshot(input.id);
    assertActiveRecipientLeaseCredential(current, input.from, input.leaseToken);
    return updateTaskUnlocked(input, current ?? undefined);
  });
}

function validLeaseSeconds(value: number | undefined): number {
  if (value === undefined) return TASK_LEASE_DEFAULT_SEC;
  if (!Number.isInteger(value) || value < TASK_LEASE_MIN_SEC || value > TASK_LEASE_MAX_SEC) {
    throw new Error('invalid_lease_seconds');
  }
  return value;
}

function taskLeaseFirstClaimedAt(task: Task): string | undefined {
  return task.lease?.firstClaimedAt
    ?? task.releasedLease?.firstClaimedAt
    ?? task.expiredLease?.firstClaimedAt
    ?? task.lostLease?.firstClaimedAt;
}

function capLeaseDeadline(now: number, seconds: number, generationClaimedAt: string, firstClaimedAt: string): string {
  return new Date(Math.min(
    now + seconds * 1_000,
    Date.parse(generationClaimedAt) + TASK_LEASE_GENERATION_MAX_MS,
    Date.parse(firstClaimedAt) + TASK_LEASE_TASK_MAX_MS,
  )).toISOString();
}

function assertTaskLeaseCapAvailable(firstClaimedAt: string | undefined, now: number): void {
  if (firstClaimedAt && now >= Date.parse(firstClaimedAt) + TASK_LEASE_TASK_MAX_MS) {
    throw new Error('lease_task_cap_exhausted');
  }
}

function journalRecordFromLease(
  taskId: string,
  event: LeaseEvent,
  fate: JournalRecord['fate'],
  signedPayload?: string,
  firstClaimedAt?: string,
): JournalRecord {
  const rec: JournalRecord = {
    taskId,
    kind: event.event === 'claim_lost' ? 'tombstone' : event.event,
    generation: event.generation,
    actor: event.actor,
    at: event.at,
    fate,
  };
  if (signedPayload) rec.signedPayload = signedPayload;
  if ('claimedUntil' in event) rec.claimedUntil = event.claimedUntil;
  if ('tokenVerifier' in event) rec.tokenVerifier = event.tokenVerifier;
  if (event.event === 'claim_lost') rec.firstClaimedAt = event.firstClaimedAt;
  else if (firstClaimedAt) rec.firstClaimedAt = firstClaimedAt;
  if (event.event === 'claim') rec.generationClaimedAt = event.at;
  if (event.event === 'release') rec.reason = event.reason;
  return rec;
}

function leaseEventFromJournal(rec: JournalRecord): LeaseEvent | null {
  if (rec.kind === 'claim' || rec.kind === 'renew') {
    if (!rec.claimedUntil || !rec.tokenVerifier) return null;
    return {
      version: 1,
      event: rec.kind,
      actor: rec.actor,
      at: rec.at,
      generation: rec.generation,
      claimedUntil: rec.claimedUntil,
      tokenVerifier: rec.tokenVerifier,
    };
  }
  if (rec.kind === 'release') {
    if (!rec.tokenVerifier) return null;
    return {
      version: 1, event: 'release', actor: rec.actor, at: rec.at,
      generation: rec.generation, tokenVerifier: rec.tokenVerifier, reason: rec.reason ?? '',
    };
  }
  if (rec.kind === 'expired') {
    if (!rec.claimedUntil) return null;
    return {
      version: 1, event: 'expired', actor: 'server', at: rec.at,
      generation: rec.generation, claimedUntil: rec.claimedUntil, expiredAt: rec.at,
    };
  }
  if (rec.kind === 'tombstone') {
    if (!rec.claimedUntil || !rec.firstClaimedAt) return null;
    return {
      version: 1, event: 'claim_lost', actor: 'server', at: rec.at,
      generation: rec.generation, claimedUntil: rec.claimedUntil, firstClaimedAt: rec.firstClaimedAt,
    };
  }
  return null;
}

async function ensureLeaseJournalLoaded(): Promise<void> {
  try {
    await loadLeaseJournal();
  } catch (err) {
    if (err instanceof JournalError) throw err;
    throw new JournalError('lease_journal_corrupt');
  }
}

async function hydrateOverlaysFromLoadedJournal(
  task: Task,
  opts?: {
    retireSelections?: Array<JournalRowKey & { snapshot: string }>;
    file?: JournalFile;
  },
): Promise<void> {
  for (const rec of listHydrationRecords(task.id, opts?.file)) {
    const event = leaseEventFromJournal(rec);
    if (!event) continue;
    const queued: QueuedEvent = {
      message: leaseEventMessage({
        task,
        from: event.event === 'expired' || event.event === 'claim_lost' ? task.from : event.actor,
        to: event.event === 'expired' || event.event === 'claim_lost' ? task.to : task.from,
        state: event.event === 'claim' ? 'working' : task.state,
        at: rec.at,
        body: rec.kind,
      }),
      sentAt: Date.parse(rec.at) || nowMs(),
      lease: event,
    };
    if (eventIsIndexed(task, queued)) {
      if (opts?.retireSelections) {
        if (rec.fate === 'accepted' && opts.file) {
          opts.retireSelections.push({
            taskId: rec.taskId,
            kind: rec.kind,
            generation: rec.generation,
            at: rec.at,
            snapshot: journalCanonicalSnapshotFrom(opts.file, rec.taskId),
          });
        }
      } else if (rec.fate !== 'indexed' && rec.fate !== 'tombstoned' && rec.fate !== 'superseded') {
        await markJournalFate(rec, rec.kind === 'tombstone' ? 'tombstoned' : 'indexed').catch(() => undefined);
      }
      continue;
    }
    // intent/unconfirmed are fences only; applying them would authorize a
    // bearerless release/claim before SMTP fate is known.
    if (rec.fate !== 'accepted') continue;
    const already = (queuedEvents.get(task.id) ?? []).some((row) =>
      row.lease && isSameAuthenticatedLeaseEvent(row.lease, event),
    );
    if (!already) queueEventUntilIndexed(task.id, queued.message, event);
  }
}

async function hydrateOverlaysFromJournal(task: Task): Promise<void> {
  if (!taskLeasePendingJournalEnabled()) return;
  await ensureLeaseJournalLoaded();
  await hydrateOverlaysFromLoadedJournal(task);
}

async function deliverJournalledLeaseMail(input: {
  task: Task;
  event: LeaseEvent;
  from: string;
  to: string;
  text: string;
  state: TaskState;
}): Promise<void> {
  const headers = leaseEventHeaders(input.task.id, input.state, input.from, input.to, input.event);
  if (!taskLeasePendingJournalEnabled()) {
    await deliverMail({
      from: input.from, to: [input.to], subject: input.task.subject, text: input.text, headers,
    });
    return;
  }
  const rec = journalRecordFromLease(
    input.task.id,
    input.event,
    'intent',
    headers['X-OA-Task-Lease-Payload'],
    input.event.event === 'claim_lost' ? input.event.firstClaimedAt : taskLeaseFirstClaimedAt(input.task),
  );
  try {
    await upsertJournalRecord(rec);
  } catch (err) {
    throwIfJournalError(err);
  }
  if (preSmtpHookForTests) {
    await preSmtpHookForTests(rec);
  }
  try {
    await deliverMail({
      from: input.from, to: [input.to], subject: input.task.subject, text: input.text, headers,
    });
  } catch (err) {
    await upsertJournalRecord({ ...rec, fate: 'unconfirmed' }).catch((writeErr) => {
      console.warn(JSON.stringify({
        src: 'task-lease-journal',
        event: 'unconfirmed_persist_failed',
        code: writeErr instanceof Error ? writeErr.message : 'unconfirmed_persist_failed',
      }));
    });
    throw err;
  }
  if (postSmtpAcceptHookForTests) {
    await postSmtpAcceptHookForTests(rec);
  }
  try {
    await upsertJournalRecord({ ...rec, fate: 'accepted' });
  } catch (err) {
    await upsertJournalRecord({ ...rec, fate: 'unconfirmed' }).catch((writeErr) => {
      console.warn(JSON.stringify({
        src: 'task-lease-journal',
        event: 'unconfirmed_persist_failed',
        code: writeErr instanceof Error ? writeErr.message : 'unconfirmed_persist_failed',
      }));
    });
    if (err instanceof JournalError) throw new Error(err.message);
    throw new Error('lease_journal_unconfirmed');
  }
}

async function resendUnconfirmedLease(task: Task, rec: JournalRecord): Promise<void> {
  const event = leaseEventFromJournal(rec);
  if (!event) return;
  const from = event.event === 'expired' || event.event === 'claim_lost' ? task.from : event.actor;
  const to = event.event === 'expired' || event.event === 'claim_lost' ? task.to : task.from;
  const state: TaskState = event.event === 'claim' ? 'working' : task.state;
  const headers = leaseEventHeaders(task.id, state, from, to, event);
  if (rec.signedPayload) {
    headers['X-OA-Task-Lease-Payload'] = rec.signedPayload;
  }
  await deliverMail({
    from,
    to: [to],
    subject: task.subject,
    text: rec.kind,
    headers,
  });
}

function throwIfJournalError(err: unknown): never {
  if (err instanceof JournalError) throw new Error(err.message);
  throw err instanceof Error ? err : new Error(String(err));
}

async function persistAcceptedAfterResend(task: Task, pending: JournalRecord): Promise<void> {
  try {
    await resendUnconfirmedLease(task, pending);
  } catch {
    throw new Error('lease_overlay_pending_index');
  }
  try {
    await upsertJournalRecord({ ...pending, fate: 'accepted' });
  } catch (err) {
    throwIfJournalError(err);
  }
}

/** The only lease grant authority. The durable verifier, rather than any
 * process-local plaintext secret map, preserves the server-time exclusive
 * window through restart/rebuild. */
export async function claimTask(input: {
  id: string;
  from: string;
  leaseSec?: number;
}): Promise<TaskLeaseGrant> {
  assertTaskLeasesEnabled();
  const seconds = validLeaseSeconds(input.leaseSec);
  return withTaskLock(input.id, async () => {
    let current = await getTaskSnapshot(input.id);
    if (!current) throw new Error('not_found');
    const actor = input.from.toLowerCase();
    if (actor !== current.to) throw new Error('lease_recipient_required');
    if (isApprovalTask(current)) throw new Error('task_not_claimable');
    if ((current.state !== 'submitted' && current.state !== 'working') || isClosedByAdmin(current)) {
      throw new Error('task_not_claimable');
    }
    if (taskLeasePendingJournalEnabled()) {
      try {
        await loadLeaseJournal();
      } catch (err) {
        throwIfJournalError(err);
      }
      const pending = unresolvedClaimFence(current.id);
      if (pending) {
        if (pending.fate === 'intent' || pending.fate === 'unconfirmed') {
          await persistAcceptedAfterResend(current, pending);
        }
        throw new Error('lease_overlay_pending_index');
      }
      const blockingMutation = journalRecordsFor(current.id).some((row) =>
        (row.kind === 'release' || row.kind === 'renew')
        && (row.fate === 'intent' || row.fate === 'unconfirmed' || row.fate === 'accepted'),
      );
      if (blockingMutation) {
        throw new Error('lease_overlay_pending_index');
      }
    }
    const beforeMaterialization = nowMs();
    // This must precede expiry materialization: at the absolute boundary a
    // rejected claim is a true zero-side-effect operation.
    assertTaskLeaseCapAvailable(taskLeaseFirstClaimedAt(current), beforeMaterialization);
    const wasWorking = current.state === 'working';
    if (taskLeaseExpiryAuditM3Enabled()) {
      // M3-on：锁内零审计 IO，到期只派生失活。
      const before = current;
      current = deriveExpiredLeaseIfPastDeadline(current);
      if (
        taskLeasePendingJournalEnabled()
        && current.expiredLease
        && current.expiredLease !== before.expiredLease
      ) {
        const window = current.expiredLease;
        // ORDER-2091 accepted cost (comment/documentation only — no runtime
        // guard): expired-kind intent rows for expired claim windows have NO
        // production drain while the emitter is hard-disabled. They stay OPEN,
        // block whole-task exit and can exhaust the 10000-record journal
        // capacity. TASK_LEASES_EXPIRY_AUDIT_M3 MUST NOT be enabled in
        // production before the separately approved emitter work lands; this
        // cost is reassessed on that card.
        if (!journalSuppressesExpiry(current.id, window.leaseGeneration, window.claimedUntil)) {
          await upsertJournalRecord({
            taskId: current.id,
            kind: 'expired',
            generation: window.leaseGeneration,
            actor: 'server',
            at: window.expiredAt,
            fate: 'intent',
            claimedUntil: window.claimedUntil,
            ...(window.firstClaimedAt ? { firstClaimedAt: window.firstClaimedAt } : {}),
          });
        }
      }
    } else {
      current = await materializeLeaseExpiryUnlocked(current);
    }
    const now = nowMs();
    assertTaskLeaseCapAvailable(taskLeaseFirstClaimedAt(current), now);
    if (current.lease?.claimedUntil && now < Date.parse(current.lease.claimedUntil)) {
      throw new Error('lease_already_claimed');
    }
    if (wasWorking && !current.expiredLease && !current.releasedLease && !current.lostLease) throw new Error('task_not_claimable');
    const durableGen = Math.max(
      current.lease?.leaseGeneration ?? 0,
      current.releasedLease?.leaseGeneration ?? 0,
      current.expiredLease?.leaseGeneration ?? 0,
      current.lostLease?.leaseGeneration ?? 0,
    );
    const journalGen = taskLeasePendingJournalEnabled() ? maxJournalGeneration(current.id) : 0;
    const generation = Math.max(durableGen, journalGen) + 1;
    const at = new Date(now).toISOString();
    const firstClaimedAt = taskLeaseFirstClaimedAt(current)
      ?? current.lostLease?.firstClaimedAt
      ?? at;
    const token = randomBytes(32).toString('base64url');
    const claimedUntil = capLeaseDeadline(now, seconds, at, firstClaimedAt);
    const lease: ClaimLeaseEvent = {
      version: 1,
      event: 'claim',
      actor,
      at,
      generation,
      claimedUntil,
      tokenVerifier: leaseTokenVerifier(current.id, generation, token),
    };
    const to = actor === current.from ? current.to : current.from;
    const text = 'Lease claimed.';
    await deliverJournalledLeaseMail({
      task: current, event: lease, from: actor, to, text, state: 'working',
    });
    void notifyTrustedAgentDelivery(to);
    invalidateTaskListCache();
    const eventMessage: TaskMessage = {
      id: String(current.messages.length + 1),
      from: actor,
      to,
      subject: current.subject,
      date: at,
      state: 'working',
      body: text,
    };
    queueEventUntilIndexed(current.id, eventMessage, lease);
    if (taskLeasePendingJournalEnabled()) {
      for (const row of journalRecordsFor(current.id)) {
        // Tombstone-kind rows are skipped entirely: their retirement requires an
        // exact authenticated durable receipt on the read path (ORDER-2074/2078);
        // a newer claim's send is not indexing proof. Claim-kind rows keep their
        // fate and only gain the supersededBy annotation.
        if (row.generation < generation && row.kind === 'claim' && !row.supersededBy) {
          await markJournalFate(row, row.fate, { supersededBy: generation }).catch(() => undefined);
        }
      }
    }
    return {
      task: {
        ...current,
        state: 'working',
        updatedAt: at,
        messages: [...current.messages, eventMessage],
        lease: {
          claimedUntil,
          leaseGeneration: generation,
          tokenVerifier: lease.tokenVerifier,
          generationClaimedAt: at,
          firstClaimedAt,
        },
        releasedLease: undefined,
        expiredLease: undefined,
      },
      leaseToken: token,
      claimedUntil,
      leaseGeneration: generation,
    };
  });
}

/** Public task projection used by REST success responses. */
export function toTaskView(task: Task, now = nowMs()): TaskView {
  const expiryProjection = approvalExpiryProjection(task, now);
  return {
    id: task.id,
    from: task.from,
    to: task.to,
    subject: task.subject,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    messages: task.messages,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.kind === 'approval' && task.approval ? { kind: task.kind, approval: task.approval } : {}),
    ...publicLeaseProjection(task, now),
    ...(expiryProjection ? { expiryProjection } : {}),
  };
}

/** Closed projection of durable lease authority. Disabled mode preserves the
 * authority visibly, including a past deadline that must not be reaped while
 * the gate is off; enabled mode retains the existing half-open projection. */
function publicLeaseProjection(task: Task, now = nowMs()): Pick<TaskView, 'claimedUntil' | 'leaseGeneration' | 'leaseStatus'> {
  const lease = task.lease;
  if (!lease?.claimedUntil || typeof lease.leaseGeneration !== 'number') return {};
  if (!taskLeasesEnabled()) {
    return { claimedUntil: lease.claimedUntil, leaseGeneration: lease.leaseGeneration, leaseStatus: 'disabled' };
  }
  return isLeaseDeadlineActive(lease.claimedUntil, now)
    ? { claimedUntil: lease.claimedUntil, leaseGeneration: lease.leaseGeneration }
    : {};
}

export function toTaskLeaseGrantView(grant: TaskLeaseGrant): {
  task: TaskView;
  leaseToken: string;
  claimedUntil: string;
  leaseGeneration: number;
} {
  return {
    task: toTaskView(grant.task),
    leaseToken: grant.leaseToken,
    claimedUntil: grant.claimedUntil,
    leaseGeneration: grant.leaseGeneration,
  };
}

/** Verify a bearer against the durable authority without making expiry an
 * oracle. Callers that expose a state-specific result must authenticate first. */
function isTaskLeaseTokenVerified(task: Task, token: unknown): boolean {
  const lease = task.lease;
  return !!lease
    && typeof lease.tokenVerifier === 'string'
    && typeof token === 'string'
    && leaseVerifiersEqual(leaseTokenVerifier(task.id, lease.leaseGeneration, token), lease.tokenVerifier);
}

/** Shared core validation for future renew/release/state enforcement. */
export function isTaskLeaseTokenCurrent(task: Task, token: unknown, now = nowMs()): boolean {
  const lease = task.lease;
  return !!lease
    && typeof lease.claimedUntil === 'string'
    && isLeaseDeadlineActive(lease.claimedUntil, now)
    && isTaskLeaseTokenVerified(task, token);
}

function leaseRecipientAndCurrent(task: Task, actor: string, token: string, now = nowMs()): void {
  if (actor !== task.to) throw new Error('lease_recipient_required');
  if (isApprovalTask(task) || !canAdvanceTask(task.state) || isClosedByAdmin(task)) throw new Error('task_not_claimable');
  if (!isTaskLeaseTokenCurrent(task, token, now)) throw new Error('stale_lease');
}

function leaseEventMessage(input: {
  task: Task;
  from: string;
  to: string;
  state: TaskState;
  at: string;
  body: string;
}): TaskMessage {
  return {
    // Lease audit messages rebuild by IMAP UID. Keeping the synthetic ID in
    // that same order makes a just-accepted view identical after re-indexing.
    id: String(input.task.messages.length + 1),
    from: input.from,
    to: input.to,
    subject: input.task.subject,
    date: input.at,
    state: input.state,
    body: input.body,
  };
}

/** server-time 派生失活：不发信、不入 overlay，durable 回执仍缺。 */
function deriveExpiredLeaseIfPastDeadline(current: Task): Task {
  const active = current.lease;
  const now = nowMs();
  if (
    !active?.claimedUntil
    || now < Date.parse(active.claimedUntil)
    || isApprovalTask(current)
    || !canAdvanceTask(current.state)
    || isClosedByAdmin(current)
  ) return current;
  return {
    ...current,
    lease: undefined,
    releasedLease: undefined,
    expiredLease: {
      leaseGeneration: active.leaseGeneration,
      claimedUntil: active.claimedUntil,
      expiredAt: new Date(now).toISOString(),
      ...(active.firstClaimedAt ? { firstClaimedAt: active.firstClaimedAt } : {}),
    },
  };
}

/** M3-off 内联物化：SMTP 接受后才记 overlay。M3-on 不走这条。 */
async function emitExpiryAuditUnlocked(
  current: Task,
  window: { generation: number; claimedUntil: string },
): Promise<Task> {
  if (taskLeasePendingJournalEnabled()) {
    // Reuse an existing unresolved expiry identity for this authority window
    // instead of minting a new one: repeated send failures or an
    // accepted-but-uncommitted send keep ONE journal record with the original
    // at/expiredAt, and a later retry resends the identical signed payload.
    const pendingExpiry = journalRecordsFor(current.id).find((row) =>
      row.kind === 'expired'
      && (row.fate === 'intent' || row.fate === 'unconfirmed')
      && row.generation === window.generation
      && row.claimedUntil === window.claimedUntil);
    const pendingEvent = pendingExpiry ? leaseEventFromJournal(pendingExpiry) : null;
    if (pendingExpiry && pendingEvent?.event === 'expired') {
      // On resend failure the original error propagates unchanged and the
      // pending row keeps its fate — still a single OPEN identity.
      await resendUnconfirmedLease(current, pendingExpiry);
      try {
        await upsertJournalRecord({ ...pendingExpiry, fate: 'accepted' });
      } catch (err) {
        throwIfJournalError(err);
      }
      invalidateTaskListCache();
      const reusedText = 'Lease expired.';
      const reusedMessage = leaseEventMessage({
        task: current, from: current.from, to: current.to, state: current.state,
        at: pendingEvent.at, body: reusedText,
      });
      queueEventUntilIndexed(current.id, reusedMessage, pendingEvent);
      return {
        ...current,
        updatedAt: pendingEvent.at,
        messages: [...current.messages, reusedMessage],
        lease: undefined,
        releasedLease: undefined,
        expiredLease: {
          leaseGeneration: pendingEvent.generation,
          claimedUntil: pendingEvent.claimedUntil,
          expiredAt: pendingEvent.expiredAt,
          ...(current.lease?.firstClaimedAt ? { firstClaimedAt: current.lease.firstClaimedAt } : {}),
        },
      };
    }
  }
  const expiredAt = new Date(nowMs()).toISOString();
  const lease: ExpiredLeaseEvent = {
    version: 1,
    event: 'expired',
    actor: 'server',
    at: expiredAt,
    generation: window.generation,
    claimedUntil: window.claimedUntil,
    expiredAt,
  };
  const from = current.from;
  const to = current.to;
  const text = 'Lease expired.';
  await deliverJournalledLeaseMail({
    task: current, event: lease, from, to, text, state: current.state,
  });
  invalidateTaskListCache();
  const eventMessage = leaseEventMessage({
    task: current, from, to, state: current.state, at: expiredAt, body: text,
  });
  queueEventUntilIndexed(current.id, eventMessage, lease);
  return {
    ...current,
    updatedAt: expiredAt,
    messages: [...current.messages, eventMessage],
    lease: undefined,
    releasedLease: undefined,
    expiredLease: {
      leaseGeneration: lease.generation,
      claimedUntil: lease.claimedUntil,
      expiredAt: lease.expiredAt,
      ...(current.lease?.firstClaimedAt ? { firstClaimedAt: current.lease.firstClaimedAt } : {}),
    },
  };
}

/** Must run under the existing per-task lock. M3-off legacy 路径，不动语义。 */
async function materializeLeaseExpiryUnlocked(current: Task): Promise<Task> {
  const active = current.lease;
  const now = nowMs();
  if (
    !active?.claimedUntil
    || now < Date.parse(active.claimedUntil)
    || isApprovalTask(current)
    || !canAdvanceTask(current.state)
    || isClosedByAdmin(current)
  ) return current;
  return emitExpiryAuditUnlocked(current, {
    generation: active.leaseGeneration,
    claimedUntil: active.claimedUntil,
  });
}

/** One bounded pass. M3-on 对 lease expiry 无操作；到期只在 claim 路径派生。 */
export async function reapExpiredTaskLeasesOnce(): Promise<number> {
  assertTaskLeasesEnabled();
  if (taskLeaseExpiryAuditM3Enabled()) return 0;
  const candidates = await loadAllTasksCached();
  let materialized = 0;
  for (const candidate of candidates) {
    const didMaterialize = await withTaskLock(candidate.id, async () => {
      const durable = await getTaskSnapshot(candidate.id, { mergeOverlay: false });
      if (!durable) return false;
      const view = mergeQueuedEvents(durable);
      if (!view.lease?.claimedUntil || nowMs() < Date.parse(view.lease.claimedUntil)) return false;
      const next = await materializeLeaseExpiryUnlocked(view);
      return !!next.expiredLease
        && next.expiredLease.leaseGeneration === view.lease.leaseGeneration
        && next.expiredLease.claimedUntil === view.lease.claimedUntil;
    });
    if (didMaterialize) materialized += 1;
  }
  return materialized;
}

export async function renewTask(input: {
  id: string;
  from: string;
  leaseToken: string;
  leaseSec?: number;
}): Promise<Task> {
  assertTaskLeasesEnabled();
  const seconds = validLeaseSeconds(input.leaseSec);
  return withTaskLock(input.id, async () => {
    const current = await getTaskSnapshot(input.id);
    if (!current) throw new Error('not_found');
    const actor = input.from.toLowerCase();
    const now = nowMs();
    if (actor !== current.to) throw new Error('lease_recipient_required');
    if (isApprovalTask(current) || !canAdvanceTask(current.state) || isClosedByAdmin(current)) throw new Error('task_not_claimable');
    const active = current.lease;
    // Authenticate before considering the cap. A stale bearer must never be
    // able to probe whether a current authority has reached either deadline.
    if (!isTaskLeaseTokenVerified(current, input.leaseToken)) throw new Error('stale_lease');
    const generationClaimedAt = active?.generationClaimedAt;
    const firstClaimedAt = active?.firstClaimedAt;
    if (!generationClaimedAt || !firstClaimedAt) throw new Error('stale_lease');
    const deadline = Date.parse(active?.claimedUntil ?? '');
    const generationCap = Date.parse(generationClaimedAt) + TASK_LEASE_GENERATION_MAX_MS;
    const taskCap = Date.parse(firstClaimedAt) + TASK_LEASE_TASK_MAX_MS;
    if (!Number.isFinite(generationCap) || !Number.isFinite(taskCap)) throw new Error('stale_lease');
    // An ordinary expired deadline remains stale even when it is observed at
    // a later cap. Exact capped deadlines retain their public cap-specific
    // errors, with the absolute task cap winning a simultaneous boundary.
    if (!Number.isFinite(deadline) || now >= deadline) {
      if (deadline === taskCap && now >= taskCap) {
        throw new Error('lease_task_cap_exhausted');
      }
      if (deadline === generationCap && now >= generationCap) {
        throw new Error('lease_tenure_exhausted');
      }
      // The old durable deadline passed without hitting either cap. Before the
      // stale rejection, recover an exact immutable pending renewal (same task,
      // kind renew, intent/unconfirmed fate, verifier equal to the current
      // authority): resend and mark accepted, then report pending index. No new
      // renewal identity is minted, no payload or deadline is extended, and the
      // cap checks above still win. Bearer authentication already happened.
      if (now < taskCap && now < generationCap && taskLeasePendingJournalEnabled()) {
        const pendingMut = unresolvedMutationFence(current.id);
        if (
          pendingMut
          && pendingMut.kind === 'renew'
          && (pendingMut.fate === 'intent' || pendingMut.fate === 'unconfirmed')
          && pendingMut.tokenVerifier
          && leaseVerifiersEqual(pendingMut.tokenVerifier, current.lease?.tokenVerifier)
        ) {
          await persistAcceptedAfterResend(current, pendingMut);
          throw new Error('lease_overlay_pending_index');
        }
      }
      throw new Error('stale_lease');
    }
    if (now >= taskCap) throw new Error('lease_task_cap_exhausted');
    if (now >= generationCap) throw new Error('lease_tenure_exhausted');
    if (taskLeasePendingJournalEnabled()) {
      const pendingMut = unresolvedMutationFence(current.id);
      if (pendingMut) {
        if (
          pendingMut.kind === 'renew'
          && (pendingMut.fate === 'intent' || pendingMut.fate === 'unconfirmed')
          && pendingMut.tokenVerifier
          && leaseVerifiersEqual(pendingMut.tokenVerifier, current.lease?.tokenVerifier)
        ) {
          await persistAcceptedAfterResend(current, pendingMut);
        }
        throw new Error('lease_overlay_pending_index');
      }
    }
    const currentLease = active!;
    const claimedUntil = capLeaseDeadline(now, seconds, generationClaimedAt, firstClaimedAt);
    if (Date.parse(claimedUntil) <= Date.parse(currentLease.claimedUntil)) return current;
    const at = new Date(now).toISOString();
    const lease: RenewLeaseEvent = {
      version: 1, event: 'renew', actor, at,
      generation: currentLease.leaseGeneration,
      claimedUntil,
      tokenVerifier: currentLease.tokenVerifier!,
    };
    const to = current.from;
    const text = 'Lease renewed.';
    await deliverJournalledLeaseMail({
      task: current, event: lease, from: actor, to, text, state: current.state,
    });
    void notifyTrustedAgentDelivery(to);
    invalidateTaskListCache();
    const eventMessage = leaseEventMessage({ task: current, from: actor, to, state: current.state, at, body: text });
    queueEventUntilIndexed(current.id, eventMessage, lease);
    return {
      ...current,
      updatedAt: at,
      messages: [...current.messages, eventMessage],
      lease: {
        leaseGeneration: currentLease.leaseGeneration,
        claimedUntil,
        tokenVerifier: currentLease.tokenVerifier,
        generationClaimedAt,
        firstClaimedAt,
      },
      expiredLease: undefined,
    };
  });
}

export async function releaseTask(input: {
  id: string;
  from: string;
  leaseToken: string;
  reason?: string;
}): Promise<Task> {
  assertTaskLeasesEnabled();
  const reason = input.reason ?? '';
  if (reason.length > TASK_LEASE_REASON_MAX_CHARS) throw new Error('invalid_request');
  return withTaskLock(input.id, async () => {
    const current = await getTaskSnapshot(input.id);
    if (!current) throw new Error('not_found');
    const actor = input.from.toLowerCase();
    if (actor !== current.to) throw new Error('lease_recipient_required');
    const receipt = current.releasedLease;
    if (receipt) {
      if (
        typeof input.leaseToken === 'string'
        && leaseVerifiersEqual(leaseTokenVerifier(current.id, receipt.leaseGeneration, input.leaseToken), receipt.tokenVerifier)
        && reason === receipt.reason
      ) return current;
      throw new Error('stale_lease');
    }
    if (taskLeasePendingJournalEnabled()) {
      const pendingMut = unresolvedMutationFence(current.id);
      if (pendingMut) {
        if (
          pendingMut.kind === 'release'
          && (pendingMut.fate === 'intent' || pendingMut.fate === 'unconfirmed')
          && pendingMut.tokenVerifier
          && leaseVerifiersEqual(
            leaseTokenVerifier(current.id, pendingMut.generation, input.leaseToken),
            pendingMut.tokenVerifier,
          )
          && (pendingMut.reason ?? '') === reason
        ) {
          await persistAcceptedAfterResend(current, pendingMut);
        }
        throw new Error('lease_overlay_pending_index');
      }
    }
    leaseRecipientAndCurrent(current, actor, input.leaseToken);
    const active = current.lease!;
    const at = new Date(nowMs()).toISOString();
    const lease: ReleaseLeaseEvent = {
      version: 1, event: 'release', actor, at,
      generation: active.leaseGeneration,
      tokenVerifier: active.tokenVerifier!, reason,
    };
    const to = current.from;
    const text = 'Lease released.';
    await deliverJournalledLeaseMail({
      task: current, event: lease, from: actor, to, text, state: current.state,
    });
    void notifyTrustedAgentDelivery(to);
    invalidateTaskListCache();
    const eventMessage = leaseEventMessage({ task: current, from: actor, to, state: current.state, at, body: text });
    queueEventUntilIndexed(current.id, eventMessage, lease);
    return {
      ...current,
      updatedAt: at,
      messages: [...current.messages, eventMessage],
      lease: undefined,
      releasedLease: {
        leaseGeneration: active.leaseGeneration,
        tokenVerifier: active.tokenVerifier!,
        reason,
        ...(active.firstClaimedAt ? { firstClaimedAt: active.firstClaimedAt } : {}),
      },
      expiredLease: undefined,
    };
  });
}

/** admin-only：烧掉下一个未决 generation。T_lost=2h 由服务端时钟强制。 */
export async function claimLostTask(input: { id: string }): Promise<Task> {
  assertTaskLeasesEnabled();
  if (!taskLeasePendingJournalEnabled()) throw new Error('task_leases_pending_journal_disabled');
  return withTaskLock(input.id, async () => {
    try {
      await loadLeaseJournal();
    } catch (err) {
      throwIfJournalError(err);
    }
    const current = await getTaskSnapshot(input.id);
    if (!current) throw new Error('not_found');
    if (isApprovalTask(current) || !canAdvanceTask(current.state) || isClosedByAdmin(current)) {
      throw new Error('task_not_claimable');
    }
    const pending = unresolvedClaimFence(current.id);
    if (!pending || (pending.fate !== 'intent' && pending.fate !== 'unconfirmed' && pending.fate !== 'accepted')) {
      throw new Error('lease_claim_lost_not_eligible');
    }
    if (nowMs() < Date.parse(pending.at) + TASK_LEASE_CLAIM_LOST_MS) {
      throw new Error('lease_claim_lost_too_early');
    }
    const firstClaimedAt = pending.firstClaimedAt ?? taskLeaseFirstClaimedAt(current) ?? pending.at;
    if (!pending.claimedUntil) throw new Error('lease_claim_lost_not_eligible');
    const claimedUntil = pending.claimedUntil;
    const existingTombstone = journalRecordsFor(current.id).find((row) =>
      row.kind === 'tombstone'
      && row.generation === pending.generation
      && (row.fate === 'intent' || row.fate === 'unconfirmed' || row.fate === 'accepted'),
    );
    let lease: ClaimLostLeaseEvent;
    if (existingTombstone) {
      const reconstructed = leaseEventFromJournal(existingTombstone);
      if (!reconstructed || reconstructed.event !== 'claim_lost') {
        throw new Error('lease_claim_lost_not_eligible');
      }
      lease = reconstructed;
      if (existingTombstone.fate === 'intent' || existingTombstone.fate === 'unconfirmed') {
        try {
          await resendUnconfirmedLease(current, existingTombstone);
        } catch (err) {
          throwIfJournalError(err);
        }
        try {
          await upsertJournalRecord({ ...existingTombstone, fate: 'accepted' });
        } catch (err) {
          throwIfJournalError(err);
        }
      }
    } else {
      lease = {
        version: 1,
        event: 'claim_lost',
        actor: 'server',
        at: new Date(nowMs()).toISOString(),
        generation: pending.generation,
        claimedUntil,
        firstClaimedAt,
      };
      await deliverJournalledLeaseMail({
        task: current, event: lease, from: current.from, to: current.to, text: 'Lease claim lost.', state: current.state,
      });
    }
    try {
      await markJournalFate(pending, 'tombstoned');
    } catch (err) {
      throwIfJournalError(err);
    }
    invalidateTaskListCache();
    const eventMessage = leaseEventMessage({
      task: current, from: current.from, to: current.to, state: current.state, at: lease.at, body: 'Lease claim lost.',
    });
    queueEventUntilIndexed(current.id, eventMessage, lease);
    return {
      ...current,
      updatedAt: lease.at,
      messages: [...current.messages, eventMessage],
      lostLease: {
        leaseGeneration: lease.generation,
        claimedUntil: lease.claimedUntil,
        lostAt: lease.at,
        firstClaimedAt: lease.firstClaimedAt,
      },
    };
  });
}

const M2_EMITTER_BATCH = 20;

/** M2 延期审计发射器：锁外 SMTP，锁内再校验身份。失败隔离。 */
export async function emitPendingExpiryAuditsOnce(): Promise<number> {
  assertTaskLeasesEnabled();
  if (!taskLeaseEmitterEnabled()) return 0;
  if (!taskLeasePendingJournalEnabled() || !taskLeaseExpiryAuditM3Enabled()) return 0;
  try {
    await loadLeaseJournal();
  } catch (err) {
    throwIfJournalError(err);
  }
  const candidates = await loadAllTasksCached();
  type Planned = {
    taskId: string;
    generation: number;
    claimedUntil: string;
    at: string;
    firstClaimedAt?: string;
    state: TaskState;
    from: string;
    to: string;
    subject: string;
  };
  const planned: Planned[] = [];
  for (const candidate of candidates) {
    if (planned.length >= M2_EMITTER_BATCH) break;
    try {
      await withTaskLock(candidate.id, async () => {
        const fresh = await getTaskSnapshot(candidate.id);
        if (!fresh) return;
        const derived = deriveExpiredLeaseIfPastDeadline(fresh);
        const window = derived.expiredLease;
        if (!window) return;
        if (unresolvedMutationFence(fresh.id)) return;
        const existing = journalRecordsForTask(fresh.id).find((row) =>
          row.kind === 'expired' && row.generation === window.leaseGeneration && row.claimedUntil === window.claimedUntil,
        );
        if (existing?.fate === 'accepted' || existing?.fate === 'indexed') return;
        const at = existing?.at ?? window.expiredAt;
        if (!existing) {
          await upsertJournalRecord({
            taskId: fresh.id,
            kind: 'expired',
            generation: window.leaseGeneration,
            actor: 'server',
            at,
            fate: 'intent',
            claimedUntil: window.claimedUntil,
            ...(window.firstClaimedAt ? { firstClaimedAt: window.firstClaimedAt } : {}),
          });
        }
        planned.push({
          taskId: fresh.id,
          generation: window.leaseGeneration,
          claimedUntil: window.claimedUntil,
          at,
          firstClaimedAt: window.firstClaimedAt,
          state: fresh.state,
          from: fresh.from,
          to: fresh.to,
          subject: fresh.subject,
        });
      });
    } catch {
      // 单候选失败不得阻断批次。
    }
  }
  let emitted = 0;
  for (const item of planned) {
    const lease: ExpiredLeaseEvent = {
      version: 1,
      event: 'expired',
      actor: 'server',
      at: item.at,
      generation: item.generation,
      claimedUntil: item.claimedUntil,
      expiredAt: item.at,
    };
    try {
      await deliverMail({
        from: item.from,
        to: [item.to],
        subject: item.subject,
        text: 'Lease expired.',
        headers: leaseEventHeaders(item.taskId, item.state, item.from, item.to, lease),
      });
    } catch {
      await upsertJournalRecord({
        taskId: item.taskId,
        kind: 'expired',
        generation: item.generation,
        actor: 'server',
        at: item.at,
        fate: 'unconfirmed',
        claimedUntil: item.claimedUntil,
        ...(item.firstClaimedAt ? { firstClaimedAt: item.firstClaimedAt } : {}),
      }).catch(() => undefined);
      continue;
    }
    try {
      await withTaskLock(item.taskId, async () => {
        const fresh = await getTaskSnapshot(item.taskId);
        if (!fresh) return;
        if (fresh.lease && (
          fresh.lease.leaseGeneration !== item.generation
          || fresh.lease.claimedUntil !== item.claimedUntil
        )) {
          await upsertJournalRecord({
            taskId: item.taskId, kind: 'expired', generation: item.generation, actor: 'server',
            at: item.at, fate: 'rejected', claimedUntil: item.claimedUntil,
          });
          return;
        }
        if (fresh.releasedLease?.leaseGeneration === item.generation) {
          await upsertJournalRecord({
            taskId: item.taskId, kind: 'expired', generation: item.generation, actor: 'server',
            at: item.at, fate: 'rejected', claimedUntil: item.claimedUntil,
          });
          return;
        }
        await upsertJournalRecord({
          taskId: item.taskId, kind: 'expired', generation: item.generation, actor: 'server',
          at: item.at, fate: 'accepted', claimedUntil: item.claimedUntil,
          ...(item.firstClaimedAt ? { firstClaimedAt: item.firstClaimedAt } : {}),
        });
        const eventMessage = leaseEventMessage({
          task: fresh, from: item.from, to: item.to, state: item.state, at: item.at, body: 'Lease expired.',
        });
        queueEventUntilIndexed(item.taskId, eventMessage, lease);
        emitted += 1;
      });
    } catch {
      // 隔离
    }
  }
  return emitted;
}

function journalRecordsForTask(taskId: string): JournalRecord[] {
  try {
    return journalRecordsFor(taskId);
  } catch {
    return [];
  }
}

async function writeApprovalTerminal(
  current: ApprovalTask,
  input: { from: string; state: 'completed' | 'failed'; event: 'decision' | 'expired'; decision?: 'approved' | 'rejected'; result: Record<string, unknown> },
): Promise<ApprovalTask> {
  const to = input.from === current.from ? current.to : current.from;
  const payload: ApprovalEventPayload = input.event === 'decision'
    ? (() => {
      const result = readApprovalDecision(input.result);
      if (!result || !input.decision || result.digest !== current.approval.digest || result.decision !== input.decision || result.reviewer !== input.from.toLowerCase()) {
        throw new Error('invalid_approval_decision_event');
      }
      return {
        event: 'decision', digest: result.digest, decision: result.decision,
        reviewer: result.reviewer, decidedAt: result.decidedAt,
      };
    })()
    : (() => {
      const result = readApprovalExpiry(input.result);
      if (!result || result.digest !== current.approval.digest) throw new Error('invalid_approval_expiry_event');
      return { event: 'expired', digest: result.digest, expiredAt: result.expiredAt };
    })();
  const text = taskBody('', input.result);
  const { messageId } = await deliverMail({
    from: input.from,
    to: [to],
    subject: current.subject,
    text,
    headers: approvalHeaders(current.id, input.state, input.from, to, payload),
  });
  void notifyTrustedAgentDelivery(to);
  invalidateTaskListCache();
  const date = new Date(nowMs()).toISOString();
  const eventMessage: TaskMessage = {
    id: messageId,
    from: input.from,
    to,
    subject: current.subject,
    date,
    state: input.state,
    body: text,
    result: input.result,
    approval: input.event === 'decision'
      ? { type: 'decision', digest: current.approval.digest, decision: input.decision! }
      : { type: 'expired', digest: current.approval.digest },
  };
  const queued = { message: eventMessage, sentAt: Date.parse(date) || nowMs() };
  const persisted = await getTaskSnapshot(current.id);
  if (persisted && eventIsIndexed(persisted, queued) && isApprovalTask(persisted)) return persisted;
  queueEventUntilIndexed(current.id, eventMessage);
  return {
    ...current,
    state: input.state,
    updatedAt: date,
    messages: [...current.messages, eventMessage],
    result: input.result,
  };
}

/** Must run under the existing task lock. Public detail reads and decision
 * both call this path, so an expiry can produce at most one signed event. */
async function materializeApprovalExpiryUnlocked(current: ApprovalTask): Promise<ApprovalTask> {
  const expiredAt = new Date(nowMs()).toISOString();
  return writeApprovalTerminal(current, {
    from: current.from,
    state: 'failed',
    event: 'expired',
    result: { decision: 'expired', digest: current.approval.digest, expiredAt },
  });
}

/** The single approval decision gate. It runs entirely under the existing
 * per-task lock and re-reads queued overlay state after waiting for the lock. */
export async function decideApprovalTask(input: {
  id: string;
  from: string;
  decision: 'approved' | 'rejected';
}): Promise<ApprovalTask> {
  return withTaskLock(input.id, async () => {
    const current = await getTaskSnapshot(input.id);
    if (!current) throw new Error('not_found');
    if (!isApprovalTask(current)) throw new Error('not_approval_task');
    if (current.state === 'failed' && readApprovalExpiry(current.result)?.digest === current.approval.digest) {
      throw new Error('task_expired');
    }
    if (current.state === 'completed' || current.state === 'failed') throw new Error('task_already_decided');
    if (isApprovalExpired(current.approval.expiresAt)) {
      await materializeApprovalExpiryUnlocked(current);
      throw new Error('task_expired');
    }
    if (current.state !== 'input-required') throw new Error('task_already_decided');
    const actor = input.from.toLowerCase();
    if (actor !== current.approval.reviewer || actor === current.from) throw new Error('approval_reviewer_required');
    const decidedAt = new Date(nowMs()).toISOString();
    return writeApprovalTerminal(current, {
      from: actor,
      state: 'completed',
      event: 'decision',
      decision: input.decision,
      result: { decision: input.decision, digest: current.approval.digest, reviewer: actor, decidedAt },
    });
  });
}

export function taskParticipants(task: Task): Set<string> {
  return new Set([task.from, task.to]);
}

function lastStateEventAt(task: Task, state: TaskState): number | null {
  const hits = task.messages.filter((message) => message.kind !== 'reminder' && message.state === state);
  if (hits.length === 0) return null;
  return Date.parse(hits[hits.length - 1]!.date);
}

/** submitted +4h / working +24h；input-required 与 terminal 不按这两条标红。 */
export function taskOverdue(task: Task, now = nowMs()): TaskOverdue {
  if (task.state === 'submitted') {
    const origin = lastStateEventAt(task, 'submitted') ?? Date.parse(task.createdAt);
    const overdueAt = origin + TASK_SUBMITTED_OVERDUE_MS;
    if (now >= overdueAt) {
      return { overdueReason: 'submitted', overdueAt: new Date(overdueAt).toISOString() };
    }
  }
  if (task.state === 'working') {
    const origin = lastStateEventAt(task, 'working');
    if (origin != null) {
      const overdueAt = origin + TASK_WORKING_OVERDUE_MS;
      if (now >= overdueAt) {
        return { overdueReason: 'working', overdueAt: new Date(overdueAt).toISOString() };
      }
    }
  }
  return { overdueReason: null, overdueAt: null };
}

/**
 * UI 列表 / GET :id / mutation 成功体共用投影：只回 Task 公开字段 + overdue。
 * 不扩权限，只收口服务层可能带上的附加键。
 */
export function toUiTaskView(task: Task, now = nowMs()): TaskBoardItem {
  const expiryProjection = approvalExpiryProjection(task, now);
  return {
    id: task.id,
    from: task.from,
    to: task.to,
    subject: task.subject,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    messages: task.messages,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.kind === 'approval' && task.approval ? { kind: 'approval' as const, approval: task.approval } : {}),
    ...publicLeaseProjection(task, now),
    ...(expiryProjection ? { expiryProjection } : {}),
    ...taskOverdue(task, now),
  };
}

export function isClosedByAdmin(task: Task): boolean {
  const result = task.result;
  return !!result && typeof result === 'object' && (result as { closed_by_admin?: unknown }).closed_by_admin === true;
}

function matchesBoardStatus(task: Task, status: TaskBoardStatus): boolean {
  if (status === 'all') return true;
  if (status === 'active') return (TASK_BOARD_ACTIVE_STATES as readonly string[]).includes(task.state);
  return task.state === status;
}

function boardFingerprint(query: TaskBoardQuery, viewer: TaskBoardViewer): string {
  const who = viewer.kind === 'admin' ? 'admin' : viewer.address.toLowerCase();
  return `${query.status}|${query.period}|${who}`;
}

function olderThanCursor(task: Task, cursor: { t: number; id: string }): boolean {
  const t = Date.parse(task.updatedAt);
  if (t < cursor.t) return true;
  if (t > cursor.t) return false;
  return task.id < cursor.id;
}

async function loadImapTaskSnapshotWithMatching(): Promise<TaskListSnapshot> {
  if (listAllForTests) {
    const tasks = await listAllForTests();
    return { tasks, hadMatchingRowsIds: new Set(tasks.map((t) => t.id)) };
  }
  const now = nowMs();
  if (listCache && now - listCache.at < TASK_LIST_CACHE_MS) return listCache.snapshot;
  const snapshot = await scanDurableTasks();
  listCache = { at: now, snapshot };
  return snapshot;
}

async function loadImapTaskSnapshot(): Promise<Task[]> {
  const { tasks } = await loadImapTaskSnapshotWithMatching();
  return tasks;
}

async function loadAllTasksCached(): Promise<Task[]> {
  const snapshot = await loadImapTaskSnapshotWithMatching();
  return await projectTaskListSnapshot(snapshot);
}

/**
 * 工单板列表：一次 IMAP 扫描（30s 短缓存）后按 queryNow 过滤/排序/切页。
 * terminal 另加 30 天下界；周期是查询窗，不删邮件。
 */
export async function listTaskBoard(
  query: TaskBoardQuery,
  viewer: TaskBoardViewer,
): Promise<TaskBoardPage> {
  const now = nowMs();
  const queryNow = new Date(now).toISOString();
  const fp = boardFingerprint(query, viewer);
  const all = await loadAllTasksCached();
  const scoped =
    viewer.kind === 'admin'
      ? all
      : all.filter((task) => taskParticipants(task).has(viewer.address.toLowerCase()));
  const periodFrom = now - PERIOD_MS[query.period];
  const terminalFloor = now - TASK_TERMINAL_VISIBLE_MS;
  const filtered = scoped.filter((task) => {
    if (!matchesBoardStatus(task, query.status)) return false;
    const updated = Date.parse(task.updatedAt);
    if (!Number.isFinite(updated) || updated < periodFrom) return false;
    if (TERMINAL_TASK_STATES.includes(task.state) && updated < terminalFloor) return false;
    return true;
  });
  filtered.sort((a, b) => {
    const dt = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (dt !== 0) return dt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  let start = 0;
  if (query.cursor) {
    const cursor = taskBoardCursor.decodeTaskBoardCursor(query.cursor);
    if (cursor.fp !== fp) throw new taskBoardCursor.InvalidTaskCursorError();
    start = filtered.findIndex((task) => olderThanCursor(task, cursor));
    if (start < 0) start = filtered.length;
  }
  const slice = filtered.slice(start, start + query.limit);
  const last = slice[slice.length - 1];
  const hasMore = start + slice.length < filtered.length;
  return {
    tasks: slice.map((task) => toUiTaskView(task, now)),
    nextCursor:
      hasMore && last
        ? taskBoardCursor.encodeTaskBoardCursor({ fp, t: Date.parse(last.updatedAt), id: last.id })
        : null,
    totalApprox: filtered.length,
    queryNow,
  };
}

/** Direct children only; ACL filtering occurs before sorting and pagination. */
export async function listTaskChildren(query: TaskChildrenQuery, viewer: TaskBoardViewer): Promise<TaskChildrenPage> {
  // 单次 list 快照同时裁定 parent 存在性、ACL 与 children 过滤，避免与路由 snapshot 双读。
  const parentTaskId = query.parentTaskId.toLowerCase();
  const all = await loadAllTasksCached();
  const parent = all.find((task) => task.id === parentTaskId);
  if (!parent) throw new Error('not_found');
  if (viewer.kind !== 'admin' && !taskParticipants(parent).has(viewer.address.toLowerCase())) throw new Error('forbidden');
  const visible = (viewer.kind === 'admin' ? all : all.filter((task) => taskParticipants(task).has(viewer.address.toLowerCase())))
    .filter((task) => task.parentTaskId === parentTaskId);
  visible.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const who = viewer.kind === 'admin' ? 'admin' : viewer.address.toLowerCase();
  const fp = `children-v1|${parentTaskId}|${who}|${query.limit}`;
  let start = 0;
  if (query.cursor) {
    const cursor = taskChildrenCursor.decodeTaskChildrenCursor(query.cursor);
    if (cursor.fp !== fp) throw new taskChildrenCursor.InvalidTaskCursorError();
    start = visible.findIndex((task) => olderThanCursor(task, cursor));
    if (start < 0) start = visible.length;
  }
  const children = visible.slice(start, start + query.limit);
  const last = children[children.length - 1];
  return {
    children,
    nextCursor: start + children.length < visible.length && last
      ? taskChildrenCursor.encodeTaskChildrenCursor({ fp, t: Date.parse(last.updatedAt), id: last.id })
      : null,
  };
}

export async function replyTask(input: { id: string; from: string; body: string }): Promise<Task> {
  // 状态检查与 working 写入必须在同一把 per-task 锁内，否则并发双 reply
  // 都能过锁外 input-required 检，随后 updateTask 只拦 terminal，会写出第二条 working。
  return withTaskLock(input.id, async () => {
    const existing = await getTaskSnapshot(input.id);
    if (!existing) throw new Error('not_found');
    if (existing.state !== 'input-required') throw new Error('task_not_input_required');
    assertActiveRecipientLeaseCredential(existing, input.from);
    const updated = await updateTaskUnlocked({
      id: input.id,
      from: input.from,
      state: 'working',
      body: input.body,
    }, existing);
    if (!updated) throw new Error('not_found');
    return updated;
  });
}

export async function remindTask(input: {
  id: string;
  from: string;
  body?: string;
  idempotencyKey?: string;
}): Promise<Task> {
  return withTaskLock(input.id, async () => {
    const existing = await getTaskSnapshot(input.id);
    if (!existing) throw new Error('not_found');
    if (!taskParticipants(existing).has(input.from)) throw new Error('task_participant_required');
    if (existing.kind === 'approval') throw new Error('approval_decision_required');
    if (!canAdvanceTask(existing.state)) throw new Error('task_already_terminal');
    if (input.idempotencyKey) {
      const replay = existing.messages.find(
        (message) => message.kind === 'reminder' && message.idempotencyKey === input.idempotencyKey,
      );
      if (replay) return existing;
    }
    const lastReminder = [...existing.messages].reverse().find((message) => message.kind === 'reminder');
    if (lastReminder && nowMs() - Date.parse(lastReminder.date) < TASK_REMIND_COOLDOWN_MS) {
      throw new Error('task_remind_cooldown');
    }
    const to = input.from === existing.from ? existing.to : existing.from;
    const text = (input.body ?? 'Reminder: this task is still waiting.').trim() || 'Reminder: this task is still waiting.';
    const headers: Record<string, string> = {
      'X-OA-Task': existing.id,
      'X-OA-Task-State': existing.state,
      'X-OA-Task-Event': 'reminder',
      'X-OA-Task-Stamp': reminderStamp(existing.id, existing.state, input.from, to),
    };
    if (input.idempotencyKey) headers['X-OA-Task-Idempotency-Key'] = input.idempotencyKey;
    await deliverMail({
      from: input.from,
      to: [to],
      subject: existing.subject,
      text,
      headers,
    });
    void notifyTrustedAgentDelivery(to);
    invalidateTaskListCache();
    const reminderMessage: TaskMessage = {
      id: `queued-reminder-${nowMs()}`,
      from: input.from,
      to,
      subject: existing.subject,
      date: new Date(nowMs()).toISOString(),
      state: existing.state,
      body: text,
      kind: 'reminder',
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    const queued = { message: reminderMessage, sentAt: Date.parse(reminderMessage.date) || nowMs() };
    const persisted = await getTaskSnapshot(existing.id);
    // 仅当 IMAP 已能看到刚发的这条 reminder 才当真持久化；否则回 synthetic，
    // 并把它并进读路径，避免同 key 重试/15s 冷却窗口读到催办前的旧 task。
    if (persisted && eventIsIndexed(persisted, queued)) return persisted;
    queueEventUntilIndexed(existing.id, reminderMessage);
    return {
      ...existing,
      updatedAt: reminderMessage.date,
      messages: [...existing.messages, reminderMessage],
    };
  });
}

export async function closeTask(input: { id: string; from: string; reason: string }): Promise<Task> {
  // terminal 预检与 failed 写入同一把锁，避免与并发 reply 交叉各写一封。
  return withTaskLock(input.id, async () => {
    const existing = await getTaskSnapshot(input.id);
    if (!existing) throw new Error('not_found');
    if (!canAdvanceTask(existing.state)) throw new Error('task_already_terminal');
    const updated = await updateTaskUnlocked({
      id: input.id,
      from: input.from,
      state: 'failed',
      body: input.reason,
      result: { closed_by_admin: true, reason: input.reason },
    }, existing);
    if (!updated) throw new Error('not_found');
    return updated;
  });
}

export type TaskWaitDependencies = {
  getTask?: (id: string) => Promise<Task | null>;
  waitForMessage?: typeof waitForMessage;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

/**
 * A task thread is global mailbox state, while an IMAP IDLE is scoped to one
 * recipient. Check the signed global thread every short interval so a valid
 * terminal reply sent to the other participant still completes this wait.
 */
export async function waitForTaskTerminalWith(
  id: string,
  address: string,
  timeoutSec = TASK_WAIT_MAX_SEC,
  dependencies: TaskWaitDependencies = {},
): Promise<Task | null> {
  const lookup = dependencies.getTask ?? getTask;
  const wait = dependencies.waitForMessage ?? waitForMessage;
  const pause = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now;
  const deadline = now() + Math.min(timeoutSec, TASK_WAIT_MAX_SEC) * 1_000;
  while (now() < deadline) {
    const current = await lookup(id);
    // SMTP acceptance and Dovecot indexing are separate steps. A freshly
    // queued create may not be searchable on the first IMAP round trip.
    if (!current) {
      await pause(Math.min(500, Math.max(1, deadline - now())));
      continue;
    }
    if (!taskParticipants(current).has(address.toLowerCase())) return null;
    if (TERMINAL_TASK_STATES.includes(current.state)) return current;
    // The raw header is an IMAP wake-up hint. Cap each IDLE slice at three
    // seconds, then rebuild and stamp-validate the whole thread. That avoids
    // missing a terminal response addressed to the other participant.
    await wait(address, {
      taskId: id,
      taskStates: [...TERMINAL_TASK_STATES],
    }, Math.min(3, Math.max(1, Math.ceil((deadline - now()) / 1_000))));
  }
  return lookup(id);
}

export async function waitForTaskTerminal(
  id: string,
  address: string,
  timeoutSec = TASK_WAIT_MAX_SEC,
): Promise<Task | null> {
  return waitForTaskTerminalWith(id, address, timeoutSec);
}

function stampedApprovalSource(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
}): string {
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    ...Object.entries(input.headers).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n');
}

/** @internal Test-only access to the production parser. No alternate parser. */
export async function parseStampedTaskMessageForTests(input: {
  id: string;
  uid: number;
  source: string;
  internalDate: string;
}): Promise<RawTaskMessage | null> {
  const parsed = await simpleParser(input.source);
  const addresses = (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((row) => {
      const entries = (row as { value?: Array<{ address?: string }> } | undefined)?.value ?? [];
      return entries.map((entry) => ({ address: entry.address ?? undefined }));
    });
  };
  return parseTaskMessage({
    uid: input.uid,
    source: Buffer.from(input.source),
    envelope: {
      from: addresses(parsed.from),
      to: addresses(parsed.to),
      subject: parsed.subject ?? undefined,
    },
    internalDate: new Date(input.internalDate),
  } as FetchMessageObject, input.id);
}

/** @internal Test-only access to the production relationship-integrity path. */
export async function parseTaskMessageWithIntegrityForTests(input: {
  id: string;
  uid: number;
  source: string;
  internalDate: string;
}): Promise<ParsedTaskMessage> {
  const parsed = await simpleParser(input.source);
  const addresses = (value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((row) => {
      const entries = (row as { value?: Array<{ address?: string }> } | undefined)?.value ?? [];
      return entries.map((entry) => ({ address: entry.address ?? undefined }));
    });
  };
  return parseTaskMessageWithIntegrity({
    uid: input.uid,
    source: Buffer.from(input.source),
    envelope: {
      from: addresses(parsed.from),
      to: addresses(parsed.to),
      subject: parsed.subject ?? undefined,
    },
    internalDate: new Date(input.internalDate),
  } as FetchMessageObject, input.id, parsed);
}

/** @internal Test-only access to durable scan path with custom parser injection. */
export async function scanDurableTasksForTests(
  parser?: (source: Buffer | string) => Promise<ParsedMail>,
): Promise<TaskListSnapshot> {
  return scanDurableTasks(parser);
}

/** @internal Test-only reconstruction entry used by both IMAP read pipelines. */
export function taskFromParsedMessagesForTests(id: string, messages: ParsedTaskMessage[]): Task | null {
  return taskFromParsedMessages(id, messages);
}

/** Narrow watcher bridge: it deliberately returns only parser-authenticated
 * approval event kind, never an action/body snapshot. */
let approvalWatcherParseCallsForTests = 0;

/** 测试计数：完整认证解析器被调用次数（#75 预筛不得跳过带该头的邮件）。 */
export function takeApprovalWatcherParseCallsForTests(): number {
  const n = approvalWatcherParseCallsForTests;
  approvalWatcherParseCallsForTests = 0;
  return n;
}

export async function approvalEventForWatcher(message: FetchMessageObject): Promise<ApprovalEvent | null> {
  approvalWatcherParseCallsForTests += 1;
  if (!message.source || !message.envelope) return null;
  try {
    const parsed = await simpleParser(message.source);
    const id = parsed.headers.get('x-oa-task');
    if (typeof id !== 'string' || !isTaskId(id)) return null;
    return (await parseTaskMessage(message, id))?.approval ?? null;
  } catch {
    return null;
  }
}

/** @internal Test-only encoder which delegates to the production request body
 * and approval HMAC header construction. */
export function encodeStampedApprovalRequestForTests(input: {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  action: ApprovalAction;
  expiresAt: string;
}): string {
  const action = normalizedApprovalAction(input.action);
  const digest = approvalActionDigest(action);
  const snapshot: ApprovalSnapshot = { action, reviewer: input.to.toLowerCase(), expiresAt: input.expiresAt, digest };
  return stampedApprovalSource({
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: approvalRequestBody(input.body, snapshot),
    headers: approvalHeaders(input.id, 'input-required', input.from, input.to, {
      event: 'request', digest, reviewer: input.to.toLowerCase(), expiresAt: input.expiresAt,
    }),
  });
}

/** @internal Test-only encoder which delegates to the production decision
 * result and approval HMAC header construction. */
export function encodeStampedApprovalDecisionForTests(input: {
  id: string;
  from: string;
  to: string;
  subject: string;
  digest: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}): string {
  if (!APPROVAL_DIGEST_RE.test(input.digest)) throw new Error('invalid_approval_digest');
  const result = { decision: input.decision, digest: input.digest, reviewer: input.from.toLowerCase(), decidedAt: input.decidedAt };
  return stampedApprovalSource({
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: taskBody('', result),
    headers: approvalHeaders(input.id, 'completed', input.from, input.to, {
      event: 'decision', digest: input.digest, decision: input.decision,
      reviewer: input.from.toLowerCase(), decidedAt: input.decidedAt,
    }),
  });
}

export const taskService: TaskService = {
  create: createTask,
  createApproval: createApprovalTask,
  list: listTasks,
  listBoard: listTaskBoard,
  listChildren: listTaskChildren,
  getForAuthorization: getTaskSnapshot,
  get: getTask,
  update: updateTask,
  claim: claimTask,
  renew: renewTask,
  release: releaseTask,
  claimLost: claimLostTask,
  reply: replyTask,
  remind: remindTask,
  close: closeTask,
  decideApproval: decideApprovalTask,
  waitForTerminal: waitForTaskTerminal,
};

function collectDurableLeaseHistory(messages: ParsedTaskMessage[]): {
  leaseGeneration: number;
  releasedGeneration: number;
  expiredGeneration: number;
  lostGeneration: number;
  tombstones: Array<{ generation: number; at: string }>;
  firstClaimedAt?: string;
} {
  let leaseGeneration = 0;
  let releasedGeneration = 0;
  let expiredGeneration = 0;
  let lostGeneration = 0;
  let firstClaimedAt: string | undefined;
  const tombstones: Array<{ generation: number; at: string }> = [];
  for (const message of messages) {
    if (!message || message.kind === 'relationship-integrity-failure') continue;
    const lease = 'lease' in message ? message.lease : undefined;
    if (!lease) continue;
    if (lease.event === 'claim') {
      leaseGeneration = Math.max(leaseGeneration, lease.generation);
      // Conservative IMAP anchor: gen-1 claim.at only. Journal may store per-claim
      // firstClaimedAt; canExit compares that field only when the journal has one.
      // Missing gen-1 does not invent evidence.firstClaimedAt (no derivation change).
      if (lease.generation === 1) firstClaimedAt = firstClaimedAt ?? lease.at;
    } else if (lease.event === 'renew') {
      leaseGeneration = Math.max(leaseGeneration, lease.generation);
    } else if (lease.event === 'release') {
      releasedGeneration = Math.max(releasedGeneration, lease.generation);
    } else if (lease.event === 'expired') {
      expiredGeneration = Math.max(expiredGeneration, lease.generation);
    } else if (lease.event === 'claim_lost') {
      lostGeneration = Math.max(lostGeneration, lease.generation);
      tombstones.push({ generation: lease.generation, at: lease.at });
      firstClaimedAt = firstClaimedAt ?? lease.firstClaimedAt;
    }
  }
  return { leaseGeneration, releasedGeneration, expiredGeneration, lostGeneration, tombstones, firstClaimedAt };
}

function durableExitEvidenceFromLookup(
  task: Task | null,
  hadMatchingRows: boolean,
  messages: ParsedTaskMessage[] = [],
): JournalExitEvidence {
  if (!hadMatchingRows) {
    return {
      hadMatchingRows: false,
      reconstructed: false,
      leaseGeneration: 0,
      releasedGeneration: 0,
      expiredGeneration: 0,
      lostGeneration: 0,
      tombstones: [],
    };
  }
  if (!task) {
    return {
      hadMatchingRows: true,
      reconstructed: false,
      leaseGeneration: 0,
      releasedGeneration: 0,
      expiredGeneration: 0,
      lostGeneration: 0,
      tombstones: [],
    };
  }
  const history = collectDurableLeaseHistory(messages);
  return {
    hadMatchingRows: true,
    reconstructed: true,
    state: task.state,
    ...history,
  };
}

/** Durable-only IMAP reconstruction for journal whole-task exit. No hydrate/mark/upsert. */
productionJournalExitLookup = async (taskId, { signal }) => {
  if (signal.aborted) throw new JournalError('lease_journal_exit_evidence_timeout');
  if (findTaskMessagesForTests) {
    const lookup = await findTaskMessagesForTests(taskId);
    if (signal.aborted) throw new JournalError('lease_journal_exit_evidence_timeout');
    const task = lookup.messages.length > 0 ? taskFromParsedMessages(taskId, lookup.messages) : null;
    return durableExitEvidenceFromLookup(task, lookup.hadMatchingRows, lookup.messages);
  }
  const lookup = await findTaskMessages(taskId);
  if (signal.aborted) throw new JournalError('lease_journal_exit_evidence_timeout');
  const task = lookup.messages.length > 0 ? taskFromParsedMessages(taskId, lookup.messages) : null;
  return durableExitEvidenceFromLookup(task, lookup.hadMatchingRows, lookup.messages);
};
if (process.env.NODE_ENV !== 'test') {
  setJournalExitEvidenceLookup(productionJournalExitLookup);
}
