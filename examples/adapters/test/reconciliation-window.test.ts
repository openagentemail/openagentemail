import assert from 'node:assert/strict';
import test from 'node:test';
import { CorrelationSafetyError, createIntent, requestFingerprint, transition, type CorrelationRecord } from '../src/correlation-store.js';
import type { OaeTask } from '../src/openagentemail.js';
import { reconcileTask, withMarker } from '../src/retry.js';

const request = { requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'ordinary request body' };
function attempted(): CorrelationRecord {
  const created = createIntent({ framework: 'neutral', correlationId: 'abababab-abab-4bab-8bab-abababababab', operationKey: 'reconcile/window', requestFingerprint: requestFingerprint(request), expectedParticipants: { requester: request.requester, responder: request.responder }, frameworkStateRef: 'state.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
  return transition(created, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
}
function matching(record: CorrelationRecord, id: string, updatedAt = 'first'): OaeTask {
  const subject = withMarker(record, request.subject);
  return { id, from: request.requester, to: request.responder, subject, state: 'submitted', createdAt: 'x', updatedAt, messages: [{ id: `root-${id}`, from: request.requester, to: request.responder, subject, date: 'x', state: 'submitted', body: request.body }] };
}
function timing(sleeps: number[] = []) { return { intervalMs: 30_001, sleep: async (milliseconds: number) => { sleeps.push(milliseconds); } }; }

test('R1h delayed-duplicate repro rejects after the whole two-pass reconciliation window', async () => {
  const record = attempted(); const first = matching(record, 'task-1'); const second = matching(record, 'task-2'); let lists = 0;
  await assert.rejects(() => reconcileTask({ list: async () => (++lists === 1 ? [first] : [first, second]) }, record, 2, timing()), /2 correlated tasks/);
  assert.deepEqual({ outcome: 'rejected', lists }, { outcome: 'rejected', lists: 2 });
});

test('R1h reconciliation adopts a later singleton only after all passes', async () => {
  const record = attempted(); const task = matching(record, 'task-1'); let lists = 0;
  const sleeps: number[] = []; const adopted = await reconcileTask({ list: async () => (++lists === 1 ? [] : [task]) }, record, 2, timing(sleeps));
  assert.equal(lists, 2);
  assert.deepEqual(sleeps, [30_001]);
  assert.equal(adopted.id, 'task-1');
});

test('R1h reconciliation deduplicates stable task IDs and keeps the latest representation', async () => {
  const record = attempted(); const first = matching(record, 'task-1', 'first'); const latest = matching(record, 'task-1', 'latest'); let lists = 0;
  const adopted = await reconcileTask({ list: async () => (++lists === 1 ? [first] : [latest]) }, record, 2, timing());
  assert.equal(lists, 2);
  assert.equal(adopted.updatedAt, 'latest');
});

test('R1h reconciliation rejects a contradictory marker on a later pass', async () => {
  const record = attempted(); const first = matching(record, 'task-1'); const contradictory = { ...matching(record, 'task-2'), messages: [{ ...matching(record, 'task-2').messages[0]!, body: 'altered body' }] }; let lists = 0;
  await assert.rejects(() => reconcileTask({ list: async () => (++lists === 1 ? [first] : [first, contradictory]) }, record, 2, timing()), /contradictory task/);
  assert.equal(lists, 2);
});

test('R1h reconciliation rejects invalid attempt bounds before list I/O', async () => {
  const record = attempted(); let lists = 0; const client = { list: async () => { lists += 1; return []; } };
  for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 11]) await assert.rejects(() => reconcileTask(client, record, attempts, timing()), CorrelationSafetyError);
  assert.equal(lists, 0);
});

test('R5m reconciliation has no initial delay, waits only between cache-spanning passes, and validates timing before list I/O', async () => {
  const record = attempted(); const task = matching(record, 'task-cache-visible'); let lists = 0; const sleeps: number[] = [];
  const adopted = await reconcileTask({ list: async () => (++lists === 1 ? [] : [task]) }, record, 2, timing(sleeps)); assert.equal(adopted.id, task.id); assert.equal(lists, 2); assert.deepEqual(sleeps, [30_001]);
  for (const invalid of [0, 30_000, 60_001, 1.5, Number.NaN]) await assert.rejects(() => reconcileTask({ list: async () => { throw new Error('must not list'); } }, record, 2, { intervalMs: invalid, sleep: async () => undefined }), CorrelationSafetyError);
});
