import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntent, isSafeTaskId, requestFingerprint } from '../src/correlation-store.js';
import { sanitizedTimeline } from '../src/sanitize.js';

const record = createIntent({ framework: 'neutral', correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationKey: 'matrix/op', requestFingerprint: requestFingerprint({ x: 'y' }), expectedParticipants: { requester: 'a@example.test', responder: 'b@example.test' }, frameworkStateRef: 'state.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
const safe = () => sanitizedTimeline(record, [{ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', taskId: 'task-1', state: 'submitted' }]);
const bad = (row: object) => () => sanitizedTimeline(record, [row as never]);

test('R1d timeline at-field canary matrix rejects unsafe timestamps', () => {
  assert.equal(JSON.stringify(safe()).includes('task-1'), true);
  assert.throws(bad({ at: 'Bearer credential-canary', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00Z', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: 'raw-body-canary', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Zx', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-13-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000\nZ', phase: 'intent-created', code: 'create-failed' }));
  assert.throws(bad({ at: 'sk-livecredentialcanary', phase: 'intent-created', code: 'create-failed' }));
});

test('R1d timeline phase and code matrix is closed', () => {
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'Bearer token', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'resumed-secret', code: 'create-failed' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'raw-body-canary' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'Bearer credential' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'unknown' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'resume-started' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'working', code: 'create-failed' }));
  assert.equal(Array.isArray((safe() as { events: unknown[] }).events), true);
});

test('R1d timeline task-id matrix shares persisted credential validator', () => {
  assert.equal(isSafeTaskId('task-1'), true);
  assert.equal(isSafeTaskId('sk-livecredentialcanary'), false);
  assert.equal(isSafeTaskId('oa_livecredentialcanary'), false);
  assert.equal(isSafeTaskId('Bearer credential'), false);
  assert.equal(isSafeTaskId('api_key=value'), false);
  assert.equal(isSafeTaskId('raw-body-canary\nnext'), false);
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', taskId: 'sk-livecredentialcanary' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', taskId: 'Bearer credential' }));
});

test('R1d timeline state matrix rejects all unsafe allowed-channel states', () => {
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', state: 'Bearer token' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', state: 'input-required-secret' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', state: 'unknown' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', state: 'completed\nraw' }));
  assert.throws(bad({ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', state: 'failed-token' }));
  assert.equal(JSON.stringify(safe()).includes('create-failed'), true);
  assert.equal(JSON.stringify(safe()).includes('submitted'), true);
  assert.equal(JSON.stringify(safe()).includes('raw-body-canary'), false);
});

test('R1d persisted-string canary semantic probes reject credential-shaped task ids', () => {
  assert.equal(isSafeTaskId('task-123'), true);
  assert.equal(isSafeTaskId('token=value'), false);
  assert.equal(isSafeTaskId('secret=value'), false);
  assert.equal(isSafeTaskId('password=value'), false);
  assert.equal(isSafeTaskId('basic abcdefgh'), false);
  assert.equal(isSafeTaskId('-----BEGIN PRIVATE KEY-----'), false);
  assert.equal(isSafeTaskId('task\r\nbody'), false);
  assert.equal(isSafeTaskId('oa_bad'), false);
});

test('R1d unknown timeline properties remain stripped after allowed-value validation', () => {
  const output = JSON.stringify(sanitizedTimeline(record, [{ at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', authorization: 'Bearer credential-canary', rawBody: 'raw-body-canary' } as never]));
  assert.equal(output.includes('authorization'), false);
  assert.equal(output.includes('credential-canary'), false);
  assert.equal(output.includes('raw-body-canary'), false);
  assert.equal(output.includes('intent-created'), true);
  assert.equal(output.includes('create-failed'), true);
  assert.equal(output.includes(record.correlationId), true);
  assert.equal(output.includes(record.operationKey), true);
  assert.equal(output.includes('undefined'), false);
});
