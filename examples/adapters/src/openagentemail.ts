/** Framework-neutral, scoped-token REST client for OpenAgentEmail tasks. */
export type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed';
export const TERMINAL_STATES = new Set<TaskState>(['completed', 'failed']);

export interface TaskMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  state: TaskState;
  body: string;
  result?: unknown;
  kind?: 'state' | 'reminder';
  idempotencyKey?: string;
  approval?: ApprovalEvent;
}

export interface ApprovalSnapshot { action: { type: string; name: string; arguments: unknown }; reviewer: string; expiresAt: string; digest: string; }
export type ApprovalEvent = { type: 'request'; snapshot: ApprovalSnapshot } | { type: 'decision'; digest: string; decision: 'approved' | 'rejected' } | { type: 'expired'; digest: string };

export interface OaeTask {
  id: string;
  from: string;
  to: string;
  subject: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
  result?: unknown;
  /** Additive production projections; they are never used as local authority. */
  parentTaskId?: string;
  kind?: 'approval';
  approval?: ApprovalSnapshot;
  claimedUntil?: string;
  leaseGeneration?: number;
  leaseStatus?: 'disabled';
}

export interface WaitResult {
  task: OaeTask;
  timeoutSec?: number;
}

export class OaeHttpError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`OpenAgentEmail ${operation} failed with HTTP ${status}`);
  }
}

/** Transport failures intentionally carry no URL, headers, request body, or response body. */
export class OaeRequestError extends Error {
  constructor(readonly kind: 'timeout' | 'aborted' | 'transport', readonly operation: string) {
    super(`OpenAgentEmail ${operation} ${kind}`);
  }
}

export interface OaeClientOptions {
  baseUrl: string;
  /** The calling participant's scoped token. Never persist this value. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Finite client-side deadline covering both fetch and response body parsing. */
  timeoutMs?: number;
  /** Finite deadline for one server-capped terminal wait, including response margin. */
  terminalWaitTimeoutMs?: number;
  /** Optional caller cancellation composed with each individual request. */
  signal?: AbortSignal;
}

/** A real client may use HTTPS, or explicit loopback HTTP for local development only. */
export function safeOaeBaseUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error('OpenAgentEmail URL must be an absolute HTTPS or loopback HTTP URL'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('OpenAgentEmail participant tokens require HTTPS or loopback HTTP');
  if (url.username || url.password || url.hash || url.search) throw new Error('OpenAgentEmail URL must not contain credentials, query, or fragment');
  return url.toString().replace(/\/$/, '');
}

export class OaeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly terminalWaitTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: OaeClientOptions) {
    if (!options.token || /[\r\n]/.test(options.token)) throw new Error('A participant-scoped token is required');
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error('OpenAgentEmail timeout must be a finite positive millisecond value');
    const terminalWaitTimeoutMs = options.terminalWaitTimeoutMs ?? 610_000;
    if (!Number.isFinite(terminalWaitTimeoutMs) || terminalWaitTimeoutMs <= 0 || terminalWaitTimeoutMs > 900_000) throw new Error('OpenAgentEmail terminal wait timeout must be a finite positive millisecond value up to 900000');
    this.baseUrl = safeOaeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.terminalWaitTimeoutMs = terminalWaitTimeoutMs;
    this.signal = options.signal;
  }

  private async request<T>(operation: string, path: string, validate: (value: unknown) => value is T, init?: RequestInit, deadlineMs = this.timeoutMs): Promise<{ value: T; response: Response }> {
    const controller = new AbortController(); let timedOut = false;
    const signals = [this.signal, init?.signal].filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
    const abort = () => controller.abort();
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    try {
      if (signals.some((signal) => signal.aborted)) throw new OaeRequestError('aborted', operation);
      let response: Response;
      try { response = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...init?.headers } }); }
      catch { throw new OaeRequestError(timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'transport', operation); }
      if (!response.ok) throw new OaeHttpError(response.status, operation);
      let value: unknown; try { value = await response.json(); }
      catch { if (timedOut) throw new OaeRequestError('timeout', operation); if (controller.signal.aborted) throw new OaeRequestError('aborted', operation); throw new OaeHttpError(response.status, `${operation} returned invalid JSON`); }
      if (!validate(value)) throw new OaeHttpError(response.status, `${operation} returned invalid response schema`);
      return { value, response };
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
    }
  }

  async create(input: { to: string; subject: string; body: string }): Promise<OaeTask> {
    return (await this.request<OaeTask>('create task', '/v1/tasks', validTask, { method: 'POST', body: JSON.stringify(input) })).value;
  }

  async list(): Promise<OaeTask[]> {
    return (await this.request<{ tasks: OaeTask[] }>('list tasks', '/v1/tasks', validTaskList)).value.tasks;
  }

  async get(id: string): Promise<OaeTask> {
    return (await this.request<OaeTask>('get task', `/v1/tasks/${encodeURIComponent(id)}`, validTask)).value;
  }

  /** A single server-capped terminal wait. Non-terminal timeout returns are valid. */
  async waitForTerminal(id: string): Promise<WaitResult> {
    const { value, response } = await this.request<OaeTask>('wait for terminal task', `/v1/tasks/${encodeURIComponent(id)}?wait=true`, validTask, undefined, this.terminalWaitTimeoutMs);
    const timeoutSec = parseWaitTimeoutSec(response.headers.get('X-OAE-Wait-Timeout-Sec'));
    return timeoutSec === undefined ? { task: value } : { task: value, timeoutSec };
  }

  async inputRequired(id: string, body: string): Promise<OaeTask> {
    return this.setState(id, 'input-required', body);
  }

  /** The only non-terminal working transition exposed to adapter callers. */
  async working(id: string): Promise<OaeTask> { return this.setState(id, 'working'); }

  async complete(id: string, result: unknown): Promise<OaeTask> {
    return this.setState(id, 'completed', undefined, result);
  }

  async fail(id: string, result: unknown): Promise<OaeTask> {
    return this.setState(id, 'failed', undefined, result);
  }

  private async setState(id: string, state: TaskState, body?: string, result?: unknown): Promise<OaeTask> {
    const payload = { state, ...(body === undefined ? {} : { body }), ...(result === undefined ? {} : { result }) };
    return (await this.request<OaeTask>('update task', `/v1/tasks/${encodeURIComponent(id)}/state`, validTask, { method: 'POST', body: JSON.stringify(payload) })).value;
  }
}

/** An untrusted server hint: accept only canonical decimal whole seconds within the documented cap. */
function parseWaitTimeoutSec(raw: string | null): number | undefined {
  if (raw === null || !/^[1-9]\d{0,2}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value <= 900 ? value : undefined;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean { const keys = Object.keys(value); return keys.every((key) => allowed.includes(key)) && required.every((key) => key in value); }
function validState(value: unknown): value is TaskState { return value === 'submitted' || value === 'working' || value === 'input-required' || value === 'completed' || value === 'failed'; }
function safeText(value: unknown): value is string { return typeof value === 'string' && value.length <= 16_384; }
function validBody(value: unknown): value is string { return typeof value === 'string' && value.length <= 1_000_000; }
const APPROVAL_DIGEST = /^[a-f0-9]{64}$/;
function validApprovalDigest(value: unknown): value is string { return typeof value === 'string' && APPROVAL_DIGEST.test(value); }
/** Response snapshots can contain signed legacy actions; creation-only policy bounds belong to the server. */
function jsonValue(value: unknown): boolean { const pending: unknown[] = [value]; const seen = new WeakSet<object>(); while (pending.length > 0) { const current = pending.pop(); if (current === null || typeof current === 'boolean' || typeof current === 'string') continue; if (typeof current === 'number') { if (Number.isFinite(current)) continue; return false; } if (Array.isArray(current)) { if (seen.has(current)) return false; seen.add(current); pending.push(...current); continue; } if (!object(current) || Object.getPrototypeOf(current) !== Object.prototype || seen.has(current)) return false; seen.add(current); pending.push(...Object.values(current)); } return true; }
function validApprovalSnapshot(value: unknown): value is ApprovalSnapshot { if (!object(value) || !exactKeys(value, ['action', 'reviewer', 'expiresAt', 'digest'], ['action', 'reviewer', 'expiresAt', 'digest']) || !object(value.action) || !exactKeys(value.action, ['type', 'name', 'arguments'], ['type', 'name', 'arguments'])) return false; return safeText(value.action.type) && safeText(value.action.name) && jsonValue(value.action.arguments) && safeText(value.reviewer) && safeText(value.expiresAt) && validApprovalDigest(value.digest); }
function validApprovalEvent(value: unknown): value is ApprovalEvent { if (!object(value) || typeof value.type !== 'string') return false; if (value.type === 'request') return exactKeys(value, ['type', 'snapshot'], ['type', 'snapshot']) && validApprovalSnapshot(value.snapshot); if (value.type === 'decision') return exactKeys(value, ['type', 'digest', 'decision'], ['type', 'digest', 'decision']) && validApprovalDigest(value.digest) && (value.decision === 'approved' || value.decision === 'rejected'); return value.type === 'expired' && exactKeys(value, ['type', 'digest'], ['type', 'digest']) && validApprovalDigest(value.digest); }
function validMessage(value: unknown): value is TaskMessage { if (!object(value) || !exactKeys(value, ['id', 'from', 'to', 'subject', 'date', 'state', 'body', 'result', 'kind', 'idempotencyKey', 'approval'], ['id', 'from', 'to', 'subject', 'date', 'state', 'body'])) return false; return safeText(value.id) && safeText(value.from) && safeText(value.to) && safeText(value.subject) && safeText(value.date) && validBody(value.body) && validState(value.state) && (value.kind === undefined || value.kind === 'state' || value.kind === 'reminder') && (value.idempotencyKey === undefined || safeText(value.idempotencyKey)) && (value.approval === undefined || validApprovalEvent(value.approval)); }
export function isValidTaskView(value: unknown): value is OaeTask { if (!object(value) || !exactKeys(value, ['id', 'from', 'to', 'subject', 'state', 'createdAt', 'updatedAt', 'messages', 'result', 'parentTaskId', 'kind', 'approval', 'claimedUntil', 'leaseGeneration', 'leaseStatus'], ['id', 'from', 'to', 'subject', 'state', 'createdAt', 'updatedAt', 'messages'])) return false; const leasePair = (value.claimedUntil === undefined && value.leaseGeneration === undefined && value.leaseStatus === undefined) || (safeText(value.claimedUntil) && Number.isInteger(value.leaseGeneration) && (value.leaseGeneration as number) >= 1 && ((value.leaseStatus === undefined) || value.leaseStatus === 'disabled')); return safeText(value.id) && safeText(value.from) && safeText(value.to) && safeText(value.subject) && safeText(value.createdAt) && safeText(value.updatedAt) && validState(value.state) && Array.isArray(value.messages) && value.messages.length <= 1_000 && value.messages.every(validMessage) && (value.parentTaskId === undefined || safeText(value.parentTaskId)) && (value.kind === undefined || value.kind === 'approval') && ((value.kind === 'approval') === (value.approval !== undefined)) && (value.approval === undefined || validApprovalSnapshot(value.approval)) && leasePair; }
const validTask = isValidTaskView;
function validTaskList(value: unknown): value is { tasks: OaeTask[] } { return object(value) && exactKeys(value, ['tasks'], ['tasks']) && Array.isArray(value.tasks) && value.tasks.every(validTask); }
