import { CorrelationSafetyError, canonicalJson, requestFingerprint, transition, type CorrelationRecord, type CorrelationStore, type DecisionEvidence } from './correlation-store.js';
import { type OaeClient, type OaeTask, type TaskMessage, type TaskState } from './openagentemail.js';

type CorrelationWriter = Pick<CorrelationStore, 'save'>;
export interface CanonicalRequest { requester: string; responder: string; subject: string; body: string; }
export interface Decision { decision: 'approved' | 'rejected'; }
export const MAX_RECONCILIATION_ATTEMPTS = 10;

/** Marker must occur once as the final, space-delimited suffix of the task subject. */
export const markerFor = (record: CorrelationRecord): string => `[oae-correlation:${record.correlationId};fp:${record.requestFingerprint}]`;

export function withMarker(record: CorrelationRecord, baseSubject: string): string {
  if (!baseSubject || /\[oae-correlation:/.test(baseSubject)) throw new CorrelationSafetyError('base subject must be non-empty and marker-free');
  return `${baseSubject} ${markerFor(record)}`;
}

function baseSubject(subject: string, record: CorrelationRecord): string {
  const marker = markerFor(record);
  const positions = subject.split(marker).length - 1;
  if (positions !== 1 || !subject.endsWith(` ${marker}`)) throw new CorrelationSafetyError('correlation marker must occur once as the exact trailing subject suffix');
  const base = subject.slice(0, -marker.length - 1);
  if (!base || base.includes('[oae-correlation:')) throw new CorrelationSafetyError('subject contains an ambiguous correlation marker');
  return base;
}

export function canonicalRequest(input: CanonicalRequest): Record<string, string> {
  return { requester: input.requester, responder: input.responder, subject: input.subject, body: input.body };
}

function initialSubmittedMessage(task: OaeTask): TaskMessage {
  const roots = task.messages.filter((message) => message.state === 'submitted');
  if (roots.length !== 1) throw new CorrelationSafetyError(`task history has ${roots.length} submitted roots`);
  const root = roots[0]!;
  if (root.from !== task.from || root.to !== task.to || root.subject !== task.subject) throw new CorrelationSafetyError('submitted root contradicts task thread');
  return root;
}

export function canonicalRequestFromTask(task: OaeTask, record: CorrelationRecord): Record<string, string> {
  const subject = baseSubject(task.subject, record);
  const initial = initialSubmittedMessage(task);
  return canonicalRequest({ requester: task.from, responder: task.to, subject, body: initial.body });
}

export function validateOutboundRequest(record: CorrelationRecord, request: { to: string; subject: string; body: string }): void {
  if (request.to !== record.expectedParticipants.responder) throw new CorrelationSafetyError('outbound recipient contradicts configured responder');
  const subject = baseSubject(request.subject, record);
  const fingerprint = requestFingerprint(canonicalRequest({ requester: record.expectedParticipants.requester, responder: record.expectedParticipants.responder, subject, body: request.body }));
  if (fingerprint !== record.requestFingerprint) throw new CorrelationSafetyError('outbound request does not match the stored canonical fingerprint');
}

/** Validates root identity, exact marker placement, reconstructed canonical fields and known task ID. */
export function validateCorrelatedTask(task: OaeTask, record: CorrelationRecord): void {
  if (record.taskId !== null && task.id !== record.taskId) throw new CorrelationSafetyError('visible task ID contradicts adopted task ID');
  if (task.from !== record.expectedParticipants.requester || task.to !== record.expectedParticipants.responder) throw new CorrelationSafetyError('task participant pair contradicts correlation');
  const fingerprint = requestFingerprint(canonicalRequestFromTask(task, record));
  if (fingerprint !== record.requestFingerprint) throw new CorrelationSafetyError('task canonical request does not match the stored fingerprint');
}

export function matchesCorrelation(task: OaeTask, record: CorrelationRecord): boolean {
  try { validateCorrelatedTask(task, record); return true; } catch { return false; }
}

export async function reconcileTask(client: Pick<OaeClient, 'list'>, record: CorrelationRecord, attempts = 2): Promise<OaeTask> {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > MAX_RECONCILIATION_ATTEMPTS) throw new CorrelationSafetyError(`reconciliation attempts must be an integer from 1 to ${MAX_RECONCILIATION_ATTEMPTS}`);
  const candidates = new Map<string, OaeTask>();
  for (let turn = 0; turn < attempts; turn += 1) {
    const listed = await client.list();
    const marked = listed.filter((task) => task.subject.includes(markerFor(record)));
    if (marked.some((task) => !matchesCorrelation(task, record))) throw new CorrelationSafetyError('contradictory task with this correlation marker is visible');
    for (const task of marked) candidates.set(task.id, task);
  }
  if (candidates.size === 1) return candidates.values().next().value!;
  if (candidates.size === 0) throw new CorrelationSafetyError(`ambiguous create: no visible task after ${attempts} bounded reconciliation pass(es)`);
  throw new CorrelationSafetyError(`ambiguous create: ${candidates.size} correlated tasks are visible`);
}

export async function createOrAdopt(store: CorrelationWriter, client: Pick<OaeClient, 'create' | 'list'>, record: CorrelationRecord, request: { to: string; subject: string; body: string }, attempts = 2): Promise<CorrelationRecord> {
  validateOutboundRequest(record, request); // validate before durable attempt/network I/O
  if (record.phase === 'intent-created') {
    const stamp = new Date().toISOString();
    const attempted = transition(record, 'create-attempted', { createAttemptedAt: stamp }, stamp);
    await store.save(attempted);
    const task = await client.create(request);
    validateCorrelatedTask(task, attempted);
    const adopted = transition(attempted, 'task-adopted', { taskId: task.id });
    await store.save(adopted);
    return adopted;
  }
  if (record.phase !== 'create-attempted') throw new CorrelationSafetyError(`create/adopt cannot start in ${record.phase}`);
  const task = await reconcileTask(client, record, attempts);
  const adopted = transition(record, 'task-adopted', { taskId: task.id });
  await store.save(adopted);
  return adopted;
}

export function inputBodyFor(record: CorrelationRecord): string { return `OpenAgentEmail input required ${markerFor(record)}`; }

export async function requestInputOrReconcile(store: CorrelationWriter, client: Pick<OaeClient, 'inputRequired' | 'get'>, record: CorrelationRecord): Promise<CorrelationRecord> {
  if (!record.taskId) throw new CorrelationSafetyError('input request lacks an adopted task ID');
  const body = inputBodyFor(record);
  const evidence = requestFingerprint({ taskId: record.taskId, body });
  if (record.phase === 'task-adopted') {
    const attempted = transition(record, 'input-request-attempted', { inputEvidence: evidence });
    await store.save(attempted);
    const response = await client.inputRequired(record.taskId, body);
    validateInputResponse(response, attempted, body, evidence);
    const awaited = transition(attempted, 'awaiting-input');
    await store.save(awaited);
    return awaited;
  }
  if (record.phase !== 'input-request-attempted') throw new CorrelationSafetyError(`input request cannot start in ${record.phase}`);
  const task = await client.get(record.taskId);
  validateInputResponse(task, record, body, evidence);
  const awaited = transition(record, 'awaiting-input');
  await store.save(awaited);
  return awaited;
}

function validateInputResponse(task: OaeTask, record: CorrelationRecord, body: string, evidence: string): void {
  if (record.inputEvidence !== evidence) throw new CorrelationSafetyError('persisted input evidence contradicts canonical input body');
  if (task.state !== 'input-required') throw new CorrelationSafetyError('input response task state must be input-required');
  validateCorrelatedTask(task, record);
  if (task.messages.some((message) => message.state === 'completed' || message.state === 'failed')) throw new CorrelationSafetyError('input response history contains terminal contradiction');
  const inputEvents = task.messages.filter((message) => message.state === 'input-required');
  const stamped = inputEvents.filter((message) => message.from === record.expectedParticipants.requester && message.to === record.expectedParticipants.responder && message.subject === task.subject && message.body === body && requestFingerprint({ taskId: record.taskId, body: message.body }) === evidence);
  if (inputEvents.length !== 1 || stamped.length !== 1) throw new CorrelationSafetyError(`ambiguous input-required history: expected one exact stamped event, got ${inputEvents.length}`);
}

export async function pollNonTerminal(client: Pick<OaeClient, 'get'>, id: string, expected: TaskState, maxGets: number): Promise<OaeTask> {
  let observed: TaskState | undefined;
  for (let attempt = 0; attempt < maxGets; attempt += 1) {
    const task = await client.get(id);
    observed = task.state;
    if (task.state === expected) return task;
    if (task.state === 'completed' || task.state === 'failed') break;
  }
  throw new Error(`bounded poll exhausted: expected ${expected}, observed ${observed ?? 'none'}, task=${id}`);
}

export function validateDecision(task: OaeTask, record: CorrelationRecord): { value: Decision; evidence: DecisionEvidence } {
  if (!record.taskId || task.state !== 'completed') throw new CorrelationSafetyError('decision task must be the adopted completed task');
  validateCorrelatedTask(task, record);
  const terminal = task.messages.filter((message) => message.state === 'completed' || message.state === 'failed');
  if (terminal.length !== 1 || terminal[0]!.state !== 'completed') throw new CorrelationSafetyError(`expected exactly one completed terminal message, got ${terminal.length}`);
  const message = terminal[0]!;
  if (message.from !== record.expectedParticipants.responder || message.to !== record.expectedParticipants.requester || message.subject !== task.subject) throw new CorrelationSafetyError('completed message author or thread contradicts configured responder');
  const result = exactDecision(message.result);
  if (canonicalJson(task.result) !== canonicalJson(result)) throw new CorrelationSafetyError('task and terminal message result contradict each other');
  return { value: result, evidence: { decision: result.decision, messageId: message.id, evidenceFingerprint: requestFingerprint({ taskId: task.id, messageId: message.id, result }) } };
}

function exactDecision(value: unknown): Decision {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'decision' || ((value as { decision?: unknown }).decision !== 'approved' && (value as { decision?: unknown }).decision !== 'rejected')) throw new CorrelationSafetyError('terminal result must be exactly {decision:"approved"|"rejected"}');
  return value as Decision;
}

/** Stores authoritative non-secret decision evidence, accepting only its exact duplicate after restart. */
export async function receiveDecision(store: CorrelationWriter, record: CorrelationRecord, task: OaeTask): Promise<CorrelationRecord> {
  const { evidence } = validateDecision(task, record);
  if (record.phase === 'awaiting-input') {
    const received = transition(record, 'decision-received', { decisionEvidence: evidence });
    await store.save(received);
    return received;
  }
  if (record.phase === 'decision-received' || record.phase === 'resume-started' || record.phase === 'resumed') {
    if (canonicalJson(record.decisionEvidence) !== canonicalJson(evidence)) throw new CorrelationSafetyError('duplicate terminal delivery contradicts consumed decision evidence');
    return record;
  }
  throw new CorrelationSafetyError(`decision cannot be received in ${record.phase}`);
}

export interface ResumeSeam {
  /** Performs the framework-specific resume exactly once after resume-started is durable. */
  commit(): Promise<string>;
  /** Returns non-secret durable framework commit evidence, or null when no commit can be proven. */
  committedEvidence(): Promise<string | null>;
}

/** Neutral crash boundary: never calls commit again after a durable resume-started record. */
export async function resumeDecision(store: CorrelationWriter, record: CorrelationRecord, task: OaeTask, seam: ResumeSeam): Promise<CorrelationRecord> {
  const received = await receiveDecision(store, record, task);
  if (received.phase === 'resumed') return received;
  if (received.phase === 'resume-started') {
    const evidence = await seam.committedEvidence();
    if (!evidence) throw new CorrelationSafetyError('resume-started has no authoritative framework commit evidence; refusing blind second resume');
    const resumed = transition(received, 'resumed', { resumeEvidence: evidence });
    await store.save(resumed);
    return resumed;
  }
  const started = transition(received, 'resume-started');
  await store.save(started);
  const evidence = await seam.commit();
  if (!evidence) throw new CorrelationSafetyError('framework resume committed without non-secret durable evidence');
  const resumed = transition(started, 'resumed', { resumeEvidence: evidence });
  await store.save(resumed);
  return resumed;
}
