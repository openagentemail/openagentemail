/**
 * Task threads live entirely in the catch-all mailbox. Every state transition
 * is a new server-stamped mail message, so IMAP remains the only durable
 * store and the task view can always be rebuilt after an API restart.
 */

import { createHmac, randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { FetchMessageObject } from 'imapflow';
import { config } from './config.ts';
import { withInbox, waitForMessage } from './imap.ts';
import { notifyTrustedAgentDelivery } from './notify.ts';
import { sendMail } from './smtp.ts';

export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed'] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TERMINAL_TASK_STATES: readonly TaskState[] = ['completed', 'failed'];
export const TASK_WAIT_MAX_SEC = 600;

const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_MARKER = '<!-- openagent.email task result -->';
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
};

export type RawTaskMessage = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  state: TaskState;
  body: string;
  result?: unknown;
};

export type CreateTaskInput = {
  from: string;
  to: string;
  subject: string;
  body: string;
};

export type UpdateTaskInput = {
  id: string;
  from: string;
  state: TaskState;
  body?: string;
  result?: unknown;
};

export type TaskService = {
  create(input: CreateTaskInput): Promise<Task>;
  list(state?: TaskState): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  update(input: UpdateTaskInput): Promise<Task | null>;
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

/** A private signature makes a copied client-side task header non-authoritative. */
function taskStamp(id: string, state: TaskState, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}

function taskHeaders(id: string, state: TaskState, from: string, to: string): Record<string, string> {
  return {
    'X-OA-Task': id,
    'X-OA-Task-State': state,
    'X-OA-Task-Stamp': taskStamp(id, state, from, to),
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
  if (headerId !== id || typeof headerState !== 'string' || !isTaskState(headerState)) return null;
  if (!isStampedTaskMessage(id, headerState, from, to, typeof stamp === 'string' ? stamp : undefined)) return null;

  const body = (parsed.text ?? '').trim();
  return {
    uid: message.uid,
    from,
    to,
    subject: parsed.subject ?? message.envelope.subject ?? '',
    date: new Date(message.internalDate ?? message.envelope.date ?? new Date(0)).toISOString(),
    state: headerState,
    body,
    ...(readResult(body) !== undefined ? { result: readResult(body) } : {}),
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
  // Once an API-stamped terminal event exists it is immutable. A copied old
  // (but validly signed) submitted/working mail can appear again in IMAP, but
  // it cannot reopen the completed/failed task. Before that point normal
  // concurrent writes retain mailbox-order last-writer-wins semantics.
  const current = currentTaskMessage(ordered);
  const messages = ordered.map(({ uid, ...message }) => ({ id: String(uid), ...message }));
  return {
    id,
    from: first.from,
    to: first.to,
    subject: first.subject,
    state: current.state,
    createdAt: first.date,
    updatedAt: current.date,
    messages,
    ...(current.result !== undefined ? { result: current.result } : {}),
  };
}

/** Select the authoritative event from mailbox-ordered task messages. */
export function currentTaskMessage<T extends { uid: number; state: TaskState }>(messages: T[]): T {
  const ordered = [...messages].sort((a, b) => a.uid - b.uid);
  const firstTerminal = ordered.find((message) => TERMINAL_TASK_STATES.includes(message.state));
  return firstTerminal ?? ordered[ordered.length - 1]!;
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

export async function getTask(id: string): Promise<Task | null> {
  if (!isTaskId(id)) return null;
  return taskFromMessages(id, await findTaskMessages(id));
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
  return syntheticTask(input, id, messageId);
}

const taskLocks = new Map<string, Promise<void>>();

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

export async function updateTask(input: UpdateTaskInput): Promise<Task | null> {
  return withTaskLock(input.id, async () => {
    const existing = await getTask(input.id);
    if (!existing) return null;
    if (!taskParticipants(existing).has(input.from)) throw new Error('task_participant_required');
    if (!canAdvanceTask(existing.state)) throw new Error('task_already_terminal');

    const to = input.from === existing.from ? existing.to : existing.from;
    const text = taskBody(input.body ?? '', input.result);
    const { messageId } = await sendMail({
      from: input.from,
      to: [to],
      subject: existing.subject,
      text,
      headers: taskHeaders(existing.id, input.state, input.from, to),
    });
    void notifyTrustedAgentDelivery(to);

    // Local delivery is normally immediate. If Dovecot has not indexed it
    // yet, return the accepted transition rather than pretending it vanished;
    // the next GET rebuilds the authoritative IMAP view.
    const persisted = await getTask(existing.id);
    if (persisted?.state === input.state) return persisted;
    const now = new Date().toISOString();
    return {
      ...existing,
      state: input.state,
      updatedAt: now,
      messages: [...existing.messages, {
        id: messageId,
        from: input.from,
        to,
        subject: existing.subject,
        date: now,
        state: input.state,
        body: text,
        ...(input.result !== undefined ? { result: input.result } : {}),
      }],
      ...(input.result !== undefined ? { result: input.result } : {}),
    };
  });
}

export function taskParticipants(task: Task): Set<string> {
  return new Set([task.from, task.to]);
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

export const taskService: TaskService = {
  create: createTask,
  list: listTasks,
  get: getTask,
  update: updateTask,
  waitForTerminal: waitForTaskTerminal,
};
