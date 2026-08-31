import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeParticipants } from '../src/oae-runtime.js';
import { OaeClient, OaeHttpError, safeOaeBaseUrl } from '../src/openagentemail.js';
import { createIntent, requestFingerprint } from '../src/correlation-store.js';
import { canonicalRequest } from '../src/retry.js';

test('R5c real OAE boundary accepts HTTPS or loopback HTTP only and construction makes no network call', () => {
  assert.equal(safeOaeBaseUrl('https://oae.example.test/'), 'https://oae.example.test'); assert.equal(safeOaeBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  for (const url of ['http://oae.example.test', 'ftp://oae.example.test', 'https://user:pass@oae.example.test', 'https://oae.example.test/#fragment']) assert.throws(() => safeOaeBaseUrl(url));
  let calls = 0; const runtime = createRuntimeParticipants({ OPENAGENTEMAIL_API_URL: 'https://oae.example.test', OAE_REQUESTER_EMAIL: 'requester@example.test', OAE_RESPONDER_EMAIL: 'responder@example.test', OAE_REQUESTER_TOKEN: 'opaque-requester-value', OAE_RESPONDER_TOKEN: 'opaque-responder-value' }, (async () => { calls += 1; return new Response('{}'); }) as typeof fetch);
  assert.equal(calls, 0); assert.ok(runtime.requester.client instanceof OaeClient); assert.ok(runtime.responder.client instanceof OaeClient);
});

test('R5d canonical requester and responder validation rejects each mixed-case value before fetch and preserves lower-case fingerprint identity', async () => {
  const environment = { OPENAGENTEMAIL_API_URL: 'https://oae.example.test', OAE_REQUESTER_EMAIL: 'requester@example.test', OAE_RESPONDER_EMAIL: 'responder@example.test', OAE_REQUESTER_TOKEN: 'opaque-a', OAE_RESPONDER_TOKEN: 'opaque-b' }; for (const field of ['OAE_REQUESTER_EMAIL', 'OAE_RESPONDER_EMAIL'] as const) { let calls = 0; const invalid = { ...environment, [field]: field === 'OAE_REQUESTER_EMAIL' ? 'Requester@example.test' : 'Responder@example.test' }; assert.throws(() => createRuntimeParticipants(invalid, (async () => { calls += 1; return new Response('{}'); }) as typeof fetch)); assert.equal(calls, 0, field); }
  const runtime = createRuntimeParticipants(environment, (async () => new Response('{}')) as typeof fetch); const canonical = canonicalRequest({ requester: runtime.requester.address, responder: runtime.responder.address, subject: 'R5d approval', body: 'safe request' }); const fingerprint = requestFingerprint(canonical); assert.equal(fingerprint, 'db0965b1800a0edab662fb72b172bd8ba7f946380f2786d4c2121841a3ef34ca'); const intent = createIntent({ framework: 'runtime', correlationId: '55555555-5555-4555-8555-555555555555', operationKey: 'r5d/runtime', requestFingerprint: fingerprint, expectedParticipants: { requester: runtime.requester.address, responder: runtime.responder.address }, frameworkStateRef: 'none', approvalItemKey: null, now: '2026-03-01T00:00:00.000Z' }); assert.equal(intent.requestFingerprint, fingerprint); assert.deepEqual(intent.expectedParticipants, { requester: 'requester@example.test', responder: 'responder@example.test' });
});

test('R5c real OAE client invalid successful bodies are body-free typed errors', async () => {
  const client = new OaeClient({ baseUrl: 'https://oae.example.test', token: 'opaque-token', fetch: (async () => new Response('credential-canary', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assert.rejects(() => client.get('task-1'), (error: unknown) => error instanceof OaeHttpError && error.status === 200 && !error.message.includes('credential-canary'));
  assert.throws(() => createRuntimeParticipants({ OPENAGENTEMAIL_API_URL: 'https://oae.example.test', OAE_REQUESTER_EMAIL: 'Requester@example.test', OAE_RESPONDER_EMAIL: 'responder@example.test', OAE_REQUESTER_TOKEN: 'opaque-a', OAE_RESPONDER_TOKEN: 'opaque-b' }));
});
