/**
 * Task threads live entirely in the catch-all mailbox. Every state transition
 * is a new server-stamped mail message, so IMAP remains the only durable
 * store and the task view can always be rebuilt after an API restart.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { FetchMessageObject } from 'imapflow';
import { config } from './config.ts';
import { findIdentity } from './identities.ts';
import { withInbox, waitForMessage } from './imap.ts';
import { notifyTrustedAgentDelivery } from './notify.ts';
import { sendMail, type SendInput } from './smtp.ts';
import { taskLeasesEnabled } from './task-lease-gate.ts';
import * as taskBoardCursor from './task-cursor.ts';

export {
  decodeTaskBoardCursor,
  encodeTaskBoardCursor,
  InvalidTaskCursorError,
} from './task-cursor.ts';

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

type ApprovalEventPayload =
  | { event: 'request'; digest: string; reviewer: string; expiresAt: string }
  | { event: 'decision'; digest: string; decision: 'approved' | 'rejected'; reviewer: string; decidedAt: string }
  | { event: 'expired'; digest: string; expiredAt: string };

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

type LeaseEvent = ClaimLeaseEvent | RenewLeaseEvent | ReleaseLeaseEvent | ExpiredLeaseEvent;

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
};

export type TaskView = Omit<Task, 'lease' | 'releasedLease' | 'expiredLease'> & {
  claimedUntil?: string;
  leaseGeneration?: number;
  leaseStatus?: 'disabled';
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
};

export type CreateTaskInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type CreateApprovalTaskInput = {
  from: string;
  to: string;
  subject: string;
  body?: string;
  action: ApprovalAction;
  expiresAt: string;
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

export type TaskService = {
  create(input: CreateTaskInput): Promise<Task>;
  list(state?: TaskState): Promise<Task[]>;
  listBoard(query: TaskBoardQuery, viewer: TaskBoardViewer): Promise<TaskBoardPage>;
  /** Raw durable/queued view for route authorization; never materializes expiry. */
  getForAuthorization?(id: string): Promise<Task | null>;
  get(id: string): Promise<Task | null>;
  update(input: UpdateTaskInput): Promise<Task | null>;
  claim?(input: { id: string; from: string; leaseSec?: number }): Promise<TaskLeaseGrant>;
  renew?(input: { id: string; from: string; leaseToken: string; leaseSec?: number }): Promise<Task>;
  release?(input: { id: string; from: string; leaseToken: string; reason?: string }): Promise<Task>;
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

export function isTaskId(value: string): boolean {
  return TASK_ID_RE.test(value);
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

function normalizedApprovalAction(value: unknown): ApprovalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_approval_action');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3
    || typeof input.type !== 'string' || !input.type
    || typeof input.name !== 'string' || !input.name
    || !Object.prototype.hasOwnProperty.call(input, 'arguments')
  ) throw new Error('invalid_approval_action');
  assertApprovalActionBounds({ type: input.type, name: input.name, arguments: input.arguments });
  // Parse the canonical form back so callers cannot mutate the persisted
  // snapshot after creation and so only JSON values cross the event boundary.
  return JSON.parse(canonicalJson({ type: input.type, name: input.name, arguments: input.arguments })) as ApprovalAction;
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

/** A private signature makes a copied client-side task header non-authoritative. */
function taskStamp(id: string, state: TaskState, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
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
      parsed.version !== 1 || (parsed.event !== 'claim' && parsed.event !== 'renew' && parsed.event !== 'release' && parsed.event !== 'expired')
      || typeof parsed.actor !== 'string' || !parsed.actor
      || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))
      || typeof parsed.generation !== 'number' || !Number.isInteger(parsed.generation) || parsed.generation < 1
    ) return null;
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

function taskHeaders(id: string, state: TaskState, from: string, to: string): Record<string, string> {
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
): Record<string, string> {
  const canonical = canonicalApprovalEventPayload(payload);
  return {
    'X-OA-Task': id,
    'X-OA-Task-State': state,
    'X-OA-Task-Approval-Event': payload.event,
    'X-OA-Task-Approval-Digest': payload.digest,
    ...(payload.event === 'decision' ? { 'X-OA-Task-Approval-Decision': payload.decision } : {}),
    'X-OA-Task-Approval-Payload': approvalPayloadHeader(canonical),
    'X-OA-Task-Stamp': approvalStamp(id, state, from, to, canonical),
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

async function parseTaskMessage(message: FetchMessageObject, id: string): Promise<RawTaskMessage | null> {
  if (!message.source || !message.envelope) return null;
  const from = firstAddress(message.envelope.from);
  // A task response has a single peer recipient. Reject ambiguous external
  // mail rather than letting a copied header invent a participant set.
  const to = firstAddress(message.envelope.to);
  if (!from || !to) return null;
  const parsed = await simpleParser(message.source);
  const headerId = parsed.headers.get('x-oa-task');
  const headerState = parsed.headers.get('x-oa-task-state');
  const stamp = parsed.headers.get('x-oa-task-stamp');
  const eventRaw = parsed.headers.get('x-oa-task-event');
  const idempotencyRaw = parsed.headers.get('x-oa-task-idempotency-key');
  const approvalEventRaw = parsed.headers.get('x-oa-task-approval-event');
  const approvalDigestRaw = parsed.headers.get('x-oa-task-approval-digest');
  const approvalDecisionRaw = parsed.headers.get('x-oa-task-approval-decision');
  const approvalPayloadRaw = parsed.headers.get('x-oa-task-approval-payload');
  const leaseEventRaw = parsed.headers.get('x-oa-task-lease-event');
  const leasePayloadRaw = parsed.headers.get('x-oa-task-lease-payload');
  if (headerId !== id || typeof headerState !== 'string' || !isTaskState(headerState)) return null;
  const body = (parsed.text ?? '').trim();
  const result = readResult(body);
  if (leaseEventRaw !== undefined || leasePayloadRaw !== undefined) {
    if ((leaseEventRaw !== 'claim' && leaseEventRaw !== 'renew' && leaseEventRaw !== 'release' && leaseEventRaw !== 'expired') || typeof stamp !== 'string') return null;
    const lease = readLeaseEventPayload(leasePayloadRaw);
    if (
      !lease
      || lease.event.event !== leaseEventRaw
      || (lease.event.event === 'expired'
        ? lease.event.actor !== 'server'
        : lease.event.actor !== from)
      || (lease.event.event !== 'release' && lease.event.event !== 'expired' && Date.parse(lease.event.claimedUntil) <= Date.parse(lease.event.at))
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
      || stamp !== approvalStamp(id, headerState, from, to, payloadHeader.canonical)
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
    };
  }
  const isReminder = eventRaw === 'reminder';
  if (isReminder) {
    if (typeof stamp !== 'string' || stamp !== reminderStamp(id, headerState, from, to)) return null;
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
  };
}

export function taskFromMessages(id: string, raw: RawTaskMessage[]): Task | null {
  if (raw.length === 0) return null;
  // IMAP UID order is the durable order for a single mailbox. This gives
  // concurrent non-terminal writes ordinary last-writer-wins semantics.
  const ordered = [...raw].sort((a, b) => a.uid - b.uid);
  const first = ordered[0]!;
  const participants = new Set([first.from, first.to]);
  if (participants.size !== 2) return null;
  if (ordered.some((message) => !participants.has(message.from) || !participants.has(message.to))) return null;
  const leaseEvents = ordered.filter((message): message is RawTaskMessage & { lease: LeaseEvent } => !!message.lease);
  let previousGeneration = 0;
  let leaseAuthority: TaskLeaseAuthority | undefined;
  let releasedLease: ReleasedLeaseReceipt | undefined;
  let expiredLease: ExpiredLeaseReceipt | undefined;
  let firstClaimedAt: string | undefined;
  const appliedExpiryReceipts = new Map<number, ExpiredLeaseReceipt>();
  const exactDuplicateExpiryMessages = new Set<RawTaskMessage>();
  for (const message of leaseEvents) {
    const lease = message.lease;
    if (lease.event === 'expired') {
      const priorReceipt = appliedExpiryReceipts.get(lease.generation);
      if (
        priorReceipt?.leaseGeneration === lease.generation
        && priorReceipt.claimedUntil === lease.claimedUntil
        && priorReceipt.expiredAt === lease.expiredAt
      ) {
        exactDuplicateExpiryMessages.add(message);
        continue;
      }
      if (
        lease.actor !== 'server'
        || !leaseAuthority?.claimedUntil
        || lease.generation !== leaseAuthority.leaseGeneration
        || lease.claimedUntil !== leaseAuthority.claimedUntil
        || lease.at !== lease.expiredAt
        || Date.parse(lease.expiredAt) < Date.parse(lease.claimedUntil)
      ) return null;
      leaseAuthority = undefined;
      releasedLease = undefined;
      expiredLease = {
        leaseGeneration: lease.generation,
        claimedUntil: lease.claimedUntil,
        expiredAt: lease.expiredAt,
        ...(firstClaimedAt ? { firstClaimedAt } : {}),
      };
      appliedExpiryReceipts.set(lease.generation, expiredLease);
      continue;
    }
    if (
      message.from !== first.to || message.to !== first.from
      || lease.actor !== first.to
      || !Number.isFinite(Date.parse(lease.at))
      || !/^[A-Za-z0-9_-]{32,}$/.test(lease.tokenVerifier)
    ) return null;
    if (lease.event === 'claim') {
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
      continue;
    }
    if (lease.event === 'renew') {
      const renewedAt = Date.parse(lease.at);
      const claimedUntil = Date.parse(lease.claimedUntil);
      const generationClaimedAt = Date.parse(leaseAuthority?.generationClaimedAt ?? '');
      const taskClaimedAt = Date.parse(leaseAuthority?.firstClaimedAt ?? firstClaimedAt ?? '');
      if (
        !leaseAuthority?.claimedUntil || !leaseAuthority.tokenVerifier
        || lease.generation !== leaseAuthority.leaseGeneration
        || !leaseVerifiersEqual(lease.tokenVerifier, leaseAuthority.tokenVerifier)
        || !Number.isFinite(renewedAt)
        || !Number.isFinite(claimedUntil)
        || !Number.isFinite(generationClaimedAt)
        || !Number.isFinite(taskClaimedAt)
        || renewedAt >= Date.parse(leaseAuthority.claimedUntil)
        || claimedUntil <= Date.parse(leaseAuthority.claimedUntil)
      ) return null;
      leaseAuthority = { ...leaseAuthority, claimedUntil: lease.claimedUntil };
      continue;
    }
    if (
      !leaseAuthority?.claimedUntil || !leaseAuthority.tokenVerifier
      || lease.generation !== leaseAuthority.leaseGeneration
      || !leaseVerifiersEqual(lease.tokenVerifier, leaseAuthority.tokenVerifier)
      || Date.parse(lease.at) >= Date.parse(leaseAuthority.claimedUntil)
    ) return null;
    leaseAuthority = undefined;
    expiredLease = undefined;
    releasedLease = {
      leaseGeneration: lease.generation,
      tokenVerifier: lease.tokenVerifier,
      reason: lease.reason,
      ...(firstClaimedAt ? { firstClaimedAt } : {}),
    };
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
    const messages = ordered.map(({ uid, lease: _lease, ...message }) => ({ id: String(uid), ...message }));
    return {
      id,
      from: first.from,
      to: first.to,
      subject: first.subject,
      state: terminal.state,
      createdAt: first.date,
      updatedAt: boardUpdatedAt(ordered, terminal),
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
  const durableOrdered = ordered.filter((message) => !exactDuplicateExpiryMessages.has(message)).map((message) => message.lease
    ? { ...message, date: message.lease.at }
    : message);
  const current = currentTaskMessage(durableOrdered);
  const messages = durableOrdered.map(({ uid, lease, ...message }) => ({
    id: String(uid),
    ...message,
    ...(lease ? { date: lease.at } : {}),
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
  return task;
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

async function findTaskMessages(id: string): Promise<RawTaskMessage[]> {
  return withInbox(async (client) => {
    const uids = await client.search({ header: { 'x-oa-task': id } }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const messages: RawTaskMessage[] = [];
    for await (const message of client.fetch(
      uids,
      { envelope: true, internalDate: true, source: true },
      { uid: true },
    )) {
      const parsed = await parseTaskMessage(message, id);
      if (parsed) messages.push(parsed);
    }
    return messages;
  });
}

/** Raw durable/queued snapshot. Lock-holding writers must use this rather
 * than public getTask(), whose approval read path may itself materialize. */
async function getTaskSnapshot(id: string): Promise<Task | null> {
  if (!isTaskId(id)) return null;
  // 单测注入内存目录，避免并发 reply / IMAP 滞后 reminder 回归打真 IMAP。
  const raw = getTaskForTests
    ? await getTaskForTests(id)
    : taskFromMessages(id, await findTaskMessages(id));
  // SMTP 已接受但 Dovecot 尚未索引时，把刚发出的 synthetic 事件并进读路径。
  return raw ? mergeQueuedEvents(raw) : null;
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
  return materializeApprovalExpiry(await getTaskSnapshot(id));
}

export async function listTasks(state?: TaskState): Promise<Task[]> {
  return withInbox(async (client) => {
    const uids = await client.search({ header: { 'x-oa-task': true } }, { uid: true });
    if (!uids || uids.length === 0) return [];
    const grouped = new Map<string, RawTaskMessage[]>();
    for await (const message of client.fetch(
      uids,
      { envelope: true, internalDate: true, source: true },
      { uid: true },
    )) {
      if (!message.source) continue;
      const parsed = await simpleParser(message.source);
      const id = parsed.headers.get('x-oa-task');
      if (typeof id !== 'string' || !isTaskId(id)) continue;
      const taskMessage = await parseTaskMessage(message, id);
      if (!taskMessage) continue;
      const entries = grouped.get(id) ?? [];
      entries.push(taskMessage);
      grouped.set(id, entries);
    }
    return [...grouped.entries()]
      .map(([id, messages]) => taskFromMessages(id, messages))
      .filter((task): task is Task => !!task && (!state || task.state === state))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  });
}

function syntheticTask(input: CreateTaskInput, id: string, messageId: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    from: input.from,
    to: input.to,
    subject: input.subject,
    state: 'submitted',
    createdAt: now,
    updatedAt: now,
    messages: [{ id: messageId, from: input.from, to: input.to, subject: input.subject, date: now, state: 'submitted', body: input.body }],
  };
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const id = randomUUID();
  const { messageId } = await sendMail({
    from: input.from,
    to: [input.to],
    subject: input.subject,
    text: input.body,
    headers: taskHeaders(id, 'submitted', input.from, input.to),
  });
  // This is a server-authenticated assignment, so it may wake the target's
  // agent route. The generic IMAP watcher never has that authority.
  void notifyTrustedAgentDelivery(input.to);
  invalidateTaskListCache();
  return syntheticTask(input, id, messageId);
}

function knownManagedIdentity(address: string): boolean {
  return address.split('@')[1]?.toLowerCase() === config.domain && !!findIdentity(address);
}

/** Creates the only mutable approval request event. The action is recorded,
 * never executed; its canonical snapshot is immutable after this point. */
export async function createApprovalTask(input: CreateApprovalTaskInput): Promise<ApprovalTask> {
  const from = input.from.toLowerCase();
  const to = input.to.toLowerCase();
  if (from === to) throw new Error('approval_participants_must_differ');
  if (!knownManagedIdentity(from) || !knownManagedIdentity(to)) throw new Error('approval_identity_required');
  assertApprovalExpiryBound(input.expiresAt);
  const action = normalizedApprovalAction(input.action);
  const digest = approvalActionDigest(action);
  const snapshot: ApprovalSnapshot = { action, reviewer: to, expiresAt: input.expiresAt, digest };
  const id = randomUUID();
  const text = approvalRequestBody(input.body, snapshot);
  const { messageId } = await deliverMail({
    from,
    to: [to],
    subject: input.subject,
    text,
    headers: approvalHeaders(id, 'input-required', from, to, {
      event: 'request', digest, reviewer: to, expiresAt: input.expiresAt,
    }),
  });
  void notifyTrustedAgentDelivery(to);
  invalidateTaskListCache();
  const now = new Date(nowMs()).toISOString();
  return {
    id,
    from,
    to,
    subject: input.subject,
    state: 'input-required',
    createdAt: now,
    updatedAt: now,
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
}

const taskLocks = new Map<string, Promise<void>>();
let nowFn: () => number = () => Date.now();
let listCache: { at: number; tasks: Task[] } | null = null;
let listAllForTests: (() => Promise<Task[]>) | null = null;
let getTaskForTests: ((id: string) => Promise<Task | null>) | null = null;
let sendMailForTests: ((input: SendInput) => Promise<{ messageId: string }>) | null = null;
/** IMAP 索引滞后窗口内的已发事件（状态转移 + reminder + lease），供后续读合并。 */
const queuedEvents = new Map<string, QueuedEvent[]>();
const QUEUED_EVENT_TTL_MS = 60 * 1000;

type QueuedEvent = {
  message: TaskMessage;
  sentAt: number;
  lease?: LeaseEvent;
};

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

export function setTaskSendMailForTests(
  fn: ((input: SendInput) => Promise<{ messageId: string }>) | null,
): void {
  sendMailForTests = fn;
}

export function clearQueuedEventsForTests(): void {
  queuedEvents.clear();
}

function indexedLeaseGenerationDominates(
  task: Task,
  queuedGeneration: number,
  expiredReceipt: 'exclude' | 'strict' | 'equal-or-newer',
): boolean {
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
    if (queued.lease.event === 'expired') {
      const receipt = task.expiredLease;
      if (
        receipt?.leaseGeneration === queued.lease.generation
        && receipt.claimedUntil === queued.lease.claimedUntil
        && receipt.expiredAt === queued.lease.expiredAt
      ) return true;
      return indexedLeaseGenerationDominates(task, queued.lease.generation, 'strict');
    }
    if (queued.lease.event === 'release') {
      return indexedLeaseGenerationDominates(task, queued.lease.generation, 'exclude')
        || (task.releasedLease?.leaseGeneration === queued.lease.generation
        && leaseVerifiersEqual(task.releasedLease.tokenVerifier, queued.lease.tokenVerifier)
        && task.releasedLease.reason === queued.lease.reason);
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
  const messages = [...task.messages, ...extra.map((row) => row.message)];
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
  for (const event of extra.map((row) => row.lease).filter((lease): lease is LeaseEvent => !!lease)) {
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
  }
  return next;
}

function mergeQueuedEvents(task: Task): Task {
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
  queuedEvents.set(task.id, stillLagging);
  return applyOverlayMessages(task, stillLagging);
}

function queueEventUntilIndexed(taskId: string, message: TaskMessage, lease?: LeaseEvent): void {
  const list = queuedEvents.get(taskId) ?? [];
  list.push({ message, sentAt: Date.parse(message.date) || nowMs(), ...(lease ? { lease } : {}) });
  queuedEvents.set(taskId, list);
}

/** 发信走可注入缝，单测才能钉死并发 reply 只写出一封 working。 */
async function deliverMail(input: SendInput): Promise<{ messageId: string }> {
  return (sendMailForTests ?? sendMail)(input);
}

export function invalidateTaskListCache(): void {
  listCache = null;
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
  return task.lease?.firstClaimedAt ?? task.releasedLease?.firstClaimedAt ?? task.expiredLease?.firstClaimedAt;
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
    const now = nowMs();
    // This must precede expiry materialization: at the absolute boundary a
    // rejected claim is a true zero-side-effect operation.
    assertTaskLeaseCapAvailable(taskLeaseFirstClaimedAt(current), now);
    const wasWorking = current.state === 'working';
    current = await materializeLeaseExpiryUnlocked(current);
    if (current.lease?.claimedUntil && nowMs() < Date.parse(current.lease.claimedUntil)) {
      throw new Error('lease_already_claimed');
    }
    if (wasWorking && !current.expiredLease && !current.releasedLease) throw new Error('task_not_claimable');
    const generation = (current.lease?.leaseGeneration
      ?? current.releasedLease?.leaseGeneration
      ?? current.expiredLease?.leaseGeneration
      ?? 0) + 1;
    const at = new Date(now).toISOString();
    const firstClaimedAt = taskLeaseFirstClaimedAt(current) ?? at;
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
    const { messageId } = await deliverMail({
      from: actor,
      to: [to],
      subject: current.subject,
      text,
      headers: leaseEventHeaders(current.id, 'working', actor, to, lease),
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
export function toTaskView(task: Task): TaskView {
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
    ...publicLeaseProjection(task),
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

/** Must run under the existing per-task lock. It emits a server-authored,
 * durable receipt only after SMTP accepts it, so retries cannot invent an
 * in-memory success state. */
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
  const expiredAt = new Date(now).toISOString();
  const lease: ExpiredLeaseEvent = {
    version: 1,
    event: 'expired',
    actor: 'server',
    at: expiredAt,
    generation: active.leaseGeneration,
    claimedUntil: active.claimedUntil,
    expiredAt,
  };
  // The requester→recipient envelope is only mail transport. The signed
  // actor above is the sole expiry authority and is intentionally not either
  // participant.
  const from = current.from;
  const to = current.to;
  const text = 'Lease expired.';
  const { messageId: _messageId } = await deliverMail({
    from,
    to: [to],
    subject: current.subject,
    text,
    headers: leaseEventHeaders(current.id, current.state, from, to, lease),
  });
  invalidateTaskListCache();
  const eventMessage = leaseEventMessage({ task: current, from, to, state: current.state, at: expiredAt, body: text });
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
      ...(active.firstClaimedAt ? { firstClaimedAt: active.firstClaimedAt } : {}),
    },
  };
}

/** One bounded pass for the server reaper. All task authority remains in the
 * shared lock-held materializer, so a concurrent reclaim cannot overtake it. */
export async function reapExpiredTaskLeasesOnce(): Promise<number> {
  assertTaskLeasesEnabled();
  const candidates = await loadAllTasksCached();
  let materialized = 0;
  for (const candidate of candidates) {
    const didMaterialize = await withTaskLock(candidate.id, async () => {
      const current = await getTaskSnapshot(candidate.id);
      if (!current?.lease?.claimedUntil || nowMs() < Date.parse(current.lease.claimedUntil)) return false;
      const next = await materializeLeaseExpiryUnlocked(current);
      return !!next.expiredLease
        && next.expiredLease.leaseGeneration === current.lease.leaseGeneration
        && next.expiredLease.claimedUntil === current.lease.claimedUntil;
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
    const deadline = Date.parse(active?.claimedUntil ?? '');
    const generationCap = generationClaimedAt
      ? Date.parse(generationClaimedAt) + TASK_LEASE_GENERATION_MAX_MS
      : undefined;
    const taskCap = firstClaimedAt
      ? Date.parse(firstClaimedAt) + TASK_LEASE_TASK_MAX_MS
      : undefined;
    // An ordinary expired deadline remains stale even when it is observed at
    // a later cap. Exact capped deadlines retain their public cap-specific
    // errors, with the absolute task cap winning a simultaneous boundary.
    if (!Number.isFinite(deadline) || now >= deadline) {
      if (taskCap !== undefined && deadline === taskCap && now >= taskCap) {
        throw new Error('lease_task_cap_exhausted');
      }
      if (generationCap !== undefined && deadline === generationCap && now >= generationCap) {
        throw new Error('lease_tenure_exhausted');
      }
      throw new Error('stale_lease');
    }
    if (taskCap !== undefined && now >= taskCap) throw new Error('lease_task_cap_exhausted');
    if (generationCap !== undefined && now >= generationCap) throw new Error('lease_tenure_exhausted');
    const currentLease = active!;
    // All production authorities receive these anchors from claim/rebuild.
    // The fallback maintains compatibility with pre-anchor in-memory seams.
    const generationAnchor = generationClaimedAt ?? current.updatedAt;
    const taskAnchor = firstClaimedAt ?? generationAnchor;
    const claimedUntil = capLeaseDeadline(now, seconds, generationAnchor, taskAnchor);
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
    const { messageId: _messageId } = await deliverMail({
      from: actor, to: [to], subject: current.subject, text,
      headers: leaseEventHeaders(current.id, current.state, actor, to, lease),
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
        generationClaimedAt: generationAnchor,
        firstClaimedAt: taskAnchor,
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
    const { messageId: _messageId } = await deliverMail({
      from: actor, to: [to], subject: current.subject, text,
      headers: leaseEventHeaders(current.id, current.state, actor, to, lease),
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

async function loadAllTasksCached(): Promise<Task[]> {
  const snapshot = await loadImapTaskSnapshot();
  // 列表与详情同一套 overlay：IMAP 滞后窗口内扫描也要看到刚接受的转移/催办。
  return snapshot.map(mergeQueuedEvents);
}

async function loadImapTaskSnapshot(): Promise<Task[]> {
  if (listAllForTests) return listAllForTests();
  const now = nowMs();
  if (listCache && now - listCache.at < TASK_LIST_CACHE_MS) return listCache.tasks;
  const tasks = await listTasks();
  listCache = { at: now, tasks };
  return tasks;
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

/** Narrow watcher bridge: it deliberately returns only parser-authenticated
 * approval event kind, never an action/body snapshot. */
export async function approvalEventForWatcher(message: FetchMessageObject): Promise<ApprovalEvent | null> {
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
  getForAuthorization: getTaskSnapshot,
  get: getTask,
  update: updateTask,
  claim: claimTask,
  renew: renewTask,
  release: releaseTask,
  reply: replyTask,
  remind: remindTask,
  close: closeTask,
  decideApproval: decideApprovalTask,
  waitForTerminal: waitForTaskTerminal,
};
