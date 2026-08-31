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
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('OpenAgentEmail participant tokens require HTTPS or loopback HTTP');
  if (url.username || url.password || url.hash) throw new Error('OpenAgentEmail URL must not contain credentials or a fragment');
  return url.toString().replace(/\/$/, '');
}

export class OaeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: OaeClientOptions) {
    if (!options.token) throw new Error('A participant-scoped token is required');
    this.baseUrl = options.fetch ? options.baseUrl.replace(/\/+$/, '') : safeOaeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(operation: string, path: string, init?: RequestInit): Promise<{ value: T; response: Response }> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...init?.headers },
    });
    if (!response.ok) throw new OaeHttpError(response.status, operation);
    try { return { value: await response.json() as T, response }; }
    catch { throw new OaeHttpError(response.status, `${operation} returned invalid JSON`); }
  }

  async create(input: { to: string; subject: string; body: string }): Promise<OaeTask> {
    return (await this.request<OaeTask>('create task', '/v1/tasks', { method: 'POST', body: JSON.stringify(input) })).value;
  }

  async list(): Promise<OaeTask[]> {
    return (await this.request<{ tasks: OaeTask[] }>('list tasks', '/v1/tasks')).value.tasks;
  }

  async get(id: string): Promise<OaeTask> {
    return (await this.request<OaeTask>('get task', `/v1/tasks/${encodeURIComponent(id)}`)).value;
  }

  /** A single server-capped terminal wait. Non-terminal timeout returns are valid. */
  async waitForTerminal(id: string): Promise<WaitResult> {
    const { value, response } = await this.request<OaeTask>('wait for terminal task', `/v1/tasks/${encodeURIComponent(id)}?wait=true`);
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
    return (await this.request<OaeTask>('update task', `/v1/tasks/${encodeURIComponent(id)}/state`, { method: 'POST', body: JSON.stringify(payload) })).value;
  }
}
