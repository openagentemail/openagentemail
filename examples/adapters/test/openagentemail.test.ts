import assert from 'node:assert/strict';
import test from 'node:test';
import { OaeClient, OaeHttpError } from '../src/openagentemail.js';

const task = (state = 'submitted') => ({ id: 'task-1', from: 'asker@example.test', to: 'reviewer@example.test', subject: 's', state, createdAt: 'x', updatedAt: 'x', messages: [] });

test('typed REST client covers create, get, terminal wait, input, complete and fail', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const wait = String(input).includes('wait=true');
    return new Response(JSON.stringify(task(wait ? 'working' : 'submitted')), { status: 200, headers: wait ? { 'X-OAE-Wait-Timeout-Sec': '60' } : {} });
  };
  const client = new OaeClient({ baseUrl: 'http://oae.test/', token: 'scoped-canary-token', fetch: fetch as typeof globalThis.fetch });
  await client.create({ to: 'reviewer@example.test', subject: 's', body: 'b' });
  await client.get('task-1');
  const waited = await client.waitForTerminal('task-1');
  await client.inputRequired('task-1', 'need input');
  await client.complete('task-1', { decision: 'approved' });
  await client.fail('task-1', { reason: 'stop' });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET', 'POST', 'POST', 'POST']);
  assert.equal(calls[2]!.path, 'http://oae.test/v1/tasks/task-1?wait=true');
  assert.equal(waited.task.state, 'working');
  assert.equal(waited.timeoutSec, 60);
  assert.deepEqual(calls[3]!.body, { state: 'input-required', body: 'need input' });
  assert.deepEqual(calls[4]!.body, { state: 'completed', result: { decision: 'approved' } });
  assert.deepEqual(calls[5]!.body, { state: 'failed', result: { reason: 'stop' } });
});

test('HTTP errors expose status and operation but never response body', async () => {
  const client = new OaeClient({ baseUrl: 'http://oae.test', token: 'token', fetch: (async () => new Response('raw-secret-body', { status: 403 })) as typeof globalThis.fetch });
  await assert.rejects(() => client.get('nope'), (error: unknown) => error instanceof OaeHttpError && error.status === 403 && !error.message.includes('raw-secret-body'));
});
