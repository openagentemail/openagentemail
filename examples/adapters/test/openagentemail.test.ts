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
  const client = new OaeClient({ baseUrl: 'http://127.0.0.1/', token: 'scoped-canary-token', fetch: fetch as typeof globalThis.fetch });
  await client.create({ to: 'reviewer@example.test', subject: 's', body: 'b' });
  await client.get('task-1');
  const waited = await client.waitForTerminal('task-1');
  await client.inputRequired('task-1', 'need input');
  await client.complete('task-1', { decision: 'approved' });
  await client.fail('task-1', { reason: 'stop' });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET', 'GET', 'POST', 'POST', 'POST']);
  assert.equal(calls[2]!.path, 'http://127.0.0.1/v1/tasks/task-1?wait=true');
  assert.equal(waited.task.state, 'working');
  assert.equal(waited.timeoutSec, 60);
  assert.deepEqual(calls[3]!.body, { state: 'input-required', body: 'need input' });
  assert.deepEqual(calls[4]!.body, { state: 'completed', result: { decision: 'approved' } });
  assert.deepEqual(calls[5]!.body, { state: 'failed', result: { reason: 'stop' } });
});

test('R5e accepted base path prefixes every operation without query ambiguity', async () => {
  let url = ''; const client = new OaeClient({ baseUrl: 'https://oae.example.test/tenant-a/', token: 'opaque-token', fetch: (async (input) => { url = String(input); return new Response(JSON.stringify(task()), { status: 200, headers: { 'content-type': 'application/json' } }); }) as typeof fetch }); await client.get('task-1'); assert.equal(url, 'https://oae.example.test/tenant-a/v1/tasks/task-1');
});

test('HTTP errors expose status and operation but never response body', async () => {
  const client = new OaeClient({ baseUrl: 'http://127.0.0.1', token: 'token', fetch: (async () => new Response('raw-secret-body', { status: 403 })) as typeof globalThis.fetch });
  await assert.rejects(() => client.get('nope'), (error: unknown) => error instanceof OaeHttpError && error.status === 403 && !error.message.includes('raw-secret-body'));
});

test('R5d every successful OAE task/list response family rejects malformed JSON objects without leaking canaries', async () => {
  const malformed = { id: 'credential-canary', nested: { rawBody: 'body-canary' } }; const routes: Array<{ name: string; invoke(client: OaeClient): Promise<unknown> }> = [
    { name: 'create', invoke: (client) => client.create({ to: 'reviewer@example.test', subject: 's', body: 'b' }) }, { name: 'get', invoke: (client) => client.get('task-1') }, { name: 'list', invoke: (client) => client.list() }, { name: 'wait', invoke: (client) => client.waitForTerminal('task-1') }, { name: 'state-update', invoke: (client) => client.inputRequired('task-1', 'need input') },
  ];
  for (const route of routes) { const client = new OaeClient({ baseUrl: 'https://oae.example.test', token: 'opaque-token', fetch: (async () => new Response(JSON.stringify(route.name === 'list' ? { tasks: [malformed] } : malformed), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch }); await assert.rejects(() => route.invoke(client), (error: unknown) => error instanceof OaeHttpError && error.status === 200 && !error.message.includes('credential-canary') && !error.message.includes('body-canary'), route.name); }
});
