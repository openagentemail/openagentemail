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
}

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

export interface OaeClientOptions {
  baseUrl: string;
  /** The calling participant's scoped token. Never persist this value. */
  token: string;
  fetch?: typeof globalThis.fetch;
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

  constructor(options: OaeClientOptions) {
    if (!options.token) throw new Error('A participant-scoped token is required');
    this.baseUrl = safeOaeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(operation: string, path: string, validate: (value: unknown) => value is T, init?: RequestInit): Promise<{ value: T; response: Response }> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...init?.headers },
    });
    if (!response.ok) throw new OaeHttpError(response.status, operation);
    let value: unknown; try { value = await response.json(); }
    catch { throw new OaeHttpError(response.status, `${operation} returned invalid JSON`); }
    if (!validate(value)) throw new OaeHttpError(response.status, `${operation} returned invalid response schema`);
    return { value, response };
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
    const { value, response } = await this.request<OaeTask>('wait for terminal task', `/v1/tasks/${encodeURIComponent(id)}?wait=true`, validTask);
    const rawCap = response.headers.get('X-OAE-Wait-Timeout-Sec');
    const timeoutSec = rawCap === null ? undefined : Number(rawCap);
    return Number.isFinite(timeoutSec) ? { task: value, timeoutSec: timeoutSec! } : { task: value };
  }

  async inputRequired(id: string, body: string): Promise<OaeTask> {
    return this.setState(id, 'input-required', body);
  }

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

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean { const keys = Object.keys(value); return keys.every((key) => allowed.includes(key)) && required.every((key) => key in value); }
function validState(value: unknown): value is TaskState { return value === 'submitted' || value === 'working' || value === 'input-required' || value === 'completed' || value === 'failed'; }
function safeText(value: unknown): value is string { return typeof value === 'string' && value.length <= 16_384; }
function validMessage(value: unknown): value is TaskMessage { if (!object(value) || !exactKeys(value, ['id', 'from', 'to', 'subject', 'date', 'state', 'body', 'result'], ['id', 'from', 'to', 'subject', 'date', 'state', 'body'])) return false; return safeText(value.id) && safeText(value.from) && safeText(value.to) && safeText(value.subject) && safeText(value.date) && safeText(value.body) && validState(value.state); }
function validTask(value: unknown): value is OaeTask { if (!object(value) || !exactKeys(value, ['id', 'from', 'to', 'subject', 'state', 'createdAt', 'updatedAt', 'messages', 'result'], ['id', 'from', 'to', 'subject', 'state', 'createdAt', 'updatedAt', 'messages'])) return false; return safeText(value.id) && safeText(value.from) && safeText(value.to) && safeText(value.subject) && safeText(value.createdAt) && safeText(value.updatedAt) && validState(value.state) && Array.isArray(value.messages) && value.messages.length <= 1_000 && value.messages.every(validMessage); }
function validTaskList(value: unknown): value is { tasks: OaeTask[] } { return object(value) && exactKeys(value, ['tasks'], ['tasks']) && Array.isArray(value.tasks) && value.tasks.length <= 1_000 && value.tasks.every(validTask); }
