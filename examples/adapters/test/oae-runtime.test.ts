import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeParticipants } from '../src/oae-runtime.js';
import { OaeClient, OaeHttpError, safeOaeBaseUrl } from '../src/openagentemail.js';

test('R5c real OAE boundary accepts HTTPS or loopback HTTP only and construction makes no network call', () => {
  assert.equal(safeOaeBaseUrl('https://oae.example.test/'), 'https://oae.example.test'); assert.equal(safeOaeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  for (const url of ['http://oae.example.test', 'ftp://oae.example.test', 'https://user:pass@oae.example.test', 'https://oae.example.test/#fragment']) assert.throws(() => safeOaeBaseUrl(url));
  let calls = 0; const runtime = createRuntimeParticipants({ OPENAGENTEMAIL_API_URL: 'https://oae.example.test', OAE_REQUESTER_EMAIL: 'requester@example.test', OAE_RESPONDER_EMAIL: 'responder@example.test', OAE_REQUESTER_TOKEN: 'opaque-requester-value', OAE_RESPONDER_TOKEN: 'opaque-responder-value' }, (async () => { calls += 1; return new Response('{}'); }) as typeof fetch);
  assert.equal(calls, 0); assert.ok(runtime.requester.client instanceof OaeClient); assert.ok(runtime.responder.client instanceof OaeClient);
});

test('R5c real OAE client invalid successful bodies are body-free typed errors', async () => {
  const client = new OaeClient({ baseUrl: 'https://oae.example.test', token: 'opaque-token', fetch: (async () => new Response('credential-canary', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assert.rejects(() => client.get('task-1'), (error: unknown) => error instanceof OaeHttpError && error.status === 200 && !error.message.includes('credential-canary'));
  assert.throws(() => createRuntimeParticipants({ OPENAGENTEMAIL_API_URL: 'https://oae.example.test', OAE_REQUESTER_EMAIL: 'Requester@example.test', OAE_RESPONDER_EMAIL: 'responder@example.test', OAE_REQUESTER_TOKEN: 'opaque-a', OAE_RESPONDER_TOKEN: 'opaque-b' }));
});
