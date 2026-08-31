import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrelationSafetyError, CorrelationStore, createIntent, requestFingerprint, transition, type CorrelationRecord } from '../src/correlation-store.js';
import type { OaeTask } from '../src/openagentemail.js';
import { createOrAdopt, inputBodyFor, markerFor, pollNonTerminal, receiveDecision, requestInputOrReconcile, resumeDecision, validateDecision, withMarker } from '../src/retry.js';

function record(): CorrelationRecord {
  const base = { requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'non-secret approval request' };
  return createIntent({ framework: 'neutral', correlationId: '66666666-6666-4666-8666-666666666666', operationKey: 'thread/node', requestFingerprint: requestFingerprint(base), expectedParticipants: { requester: base.requester, responder: base.responder }, frameworkStateRef: 'checkpoint.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
}
function taskFor(row: CorrelationRecord, state: OaeTask['state'] = 'submitted', body = 'non-secret approval request', base = 'Approve transfer'): OaeTask {
  const subject = withMarker(row, base);
  return { id: 'task-1', from: row.expectedParticipants.requester, to: row.expectedParticipants.responder, subject, state, createdAt: 'x', updatedAt: 'x', messages: [{ id: 'root-1', from: row.expectedParticipants.requester, to: row.expectedParticipants.responder, subject, date: 'x', state: 'submitted', body }] };
}
async function awaiting(store: CorrelationStore, row = record()): Promise<CorrelationRecord> {
  const attempted = transition(row, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z'); await store.save(row); await store.save(attempted);
  const adopted = transition(attempted, 'task-adopted', { taskId: 'task-1' }); await store.save(adopted);
  const inputAttempt = transition(adopted, 'input-request-attempted', { inputEvidence: requestFingerprint({ taskId: 'task-1', body: inputBodyFor(adopted) }) }); await store.save(inputAttempt);
  const result = transition(inputAttempt, 'awaiting-input'); await store.save(result); return result;
}
function completed(row: CorrelationRecord, result: unknown = { decision: 'approved' }): OaeTask {
  const task = taskFor(row, 'completed');
  const message = { id: 'terminal-1', from: row.expectedParticipants.responder, to: row.expectedParticipants.requester, subject: task.subject, date: 'x', state: 'completed' as const, body: 'approved', result };
  return { ...task, messages: [...task.messages, message], result };
}

test('canonical request validation rejects copied marker, bad suffix, roots and decision impostors', async () => {
  const row = transition(record(), 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
  const copied = taskFor(row, 'submitted', 'ALTERED BODY');
  await assert.rejects(() => createOrAdopt({ save: async () => undefined }, { create: async () => copied, list: async () => [copied] }, row, { to: row.expectedParticipants.responder, subject: copied.subject, body: 'non-secret approval request' }, 1), /contradictory task/);
  const adopted = transition(row, 'task-adopted', { taskId: 'task-1' });
  const valid = completed(adopted);
  assert.deepEqual(validateDecision(valid, adopted).value, { decision: 'approved' });
  await assert.rejects(async () => validateDecision({ ...valid, state: 'failed' }, adopted), CorrelationSafetyError);
  await assert.rejects(async () => validateDecision(completed(adopted, { decision: 'approved', extra: 'no' }), adopted), CorrelationSafetyError);
  await assert.rejects(async () => createOrAdopt({ save: async () => undefined }, { create: async () => valid, list: async () => [valid] }, row, { to: row.expectedParticipants.responder, subject: `${valid.subject} extra`, body: 'non-secret approval request' }), /marker/);
});

test('complete history rejects a contradictory second root and every mixed terminal impostor', async () => {
  const row = transition(record(), 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
  const rootConflict = { ...taskFor(row), messages: [...taskFor(row).messages, { ...taskFor(row).messages[0]!, id: 'root-2', body: 'contradictory root' }] };
  await assert.rejects(() => createOrAdopt({ save: async () => undefined }, { create: async () => rootConflict, list: async () => [rootConflict] }, row, { to: row.expectedParticipants.responder, subject: rootConflict.subject, body: 'non-secret approval request' }), /contradictory task/);
  const adopted = transition(row, 'task-adopted', { taskId: 'task-1' });
  const valid = completed(adopted);
  const failed = { ...valid.messages[1]!, id: 'failed-1', state: 'failed' as const, result: { decision: 'approved' } };
  await assert.rejects(async () => validateDecision({ ...valid, messages: [...valid.messages, failed] }, adopted), CorrelationSafetyError);
  await assert.rejects(async () => validateDecision({ ...valid, messages: [...valid.messages, { ...valid.messages[1]!, id: 'completed-2' }] }, adopted), CorrelationSafetyError);
});

test('input-required uses one helper-built exact body and adopts only its one authoritative crash-recovery event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-input-r1b-'));
  const store = new CorrelationStore(directory);
  const created = record(); await store.save(created);
  const attempted = transition(created, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z'); await store.save(attempted);
  const adopted = transition(attempted, 'task-adopted', { taskId: 'task-1' }); await store.save(adopted);
  let sends = 0;
  const base = taskFor(adopted, 'input-required');
  const client = { inputRequired: async (_id: string, body: string) => { sends += 1; assert.equal(body, inputBodyFor(adopted)); throw new Error('crash after acceptance'); }, get: async () => ({ ...base, messages: [...base.messages, { id: 'input-1', from: adopted.expectedParticipants.requester, to: adopted.expectedParticipants.responder, subject: base.subject, date: 'x', state: 'input-required' as const, body: inputBodyFor(adopted) }] }) };
  await assert.rejects(() => requestInputOrReconcile(store, client, adopted), /crash after acceptance/);
  const restarted = await store.load(adopted.correlationId);
  const awaiting = await requestInputOrReconcile(store, client, restarted);
  assert.equal(awaiting.phase, 'awaiting-input');
  assert.equal(sends, 1);
  const contradiction = await store.load(adopted.correlationId);
  await assert.rejects(() => requestInputOrReconcile(store, { ...client, get: async () => ({ ...base, messages: [...base.messages, { id: 'wrong', from: 'attacker@example.test', to: adopted.expectedParticipants.responder, subject: base.subject, date: 'x', state: 'input-required' as const, body: inputBodyFor(adopted) }] }) }, contradiction), /cannot start/);
});

test('decision receipt and resume boundaries are durable, duplicate-safe, and never blindly resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-resume-'));
  const store = new CorrelationStore(directory);
  const row = await awaiting(store);
  const task = completed(row);
  const received = await receiveDecision(store, row, task);
  assert.equal(received.phase, 'decision-received');
  assert.equal((await receiveDecision(store, received, task)).phase, 'decision-received');
  let commits = 0;
  const resumed = await resumeDecision(store, received, task, { commit: async () => { commits += 1; return 'commit-1'; }, committedEvidence: async () => null });
  assert.equal(resumed.phase, 'resumed');
  assert.equal(commits, 1);
  assert.equal((await resumeDecision(store, resumed, task, { commit: async () => { commits += 1; return 'wrong'; }, committedEvidence: async () => 'commit-1' })).phase, 'resumed');
  assert.equal(commits, 1);
  const started = transition(received, 'resume-started');
  await assert.rejects(() => resumeDecision({ save: async () => undefined }, started, task, { commit: async () => { commits += 1; return 'wrong'; }, committedEvidence: async () => null }), /refusing blind second resume/);
  assert.equal(commits, 1);
  const recovered = await resumeDecision({ save: async () => undefined }, started, task, { commit: async () => { commits += 1; return 'wrong'; }, committedEvidence: async () => 'commit-after-crash' });
  assert.equal(recovered.phase, 'resumed');
  assert.equal(commits, 1);
});

test('crash points around decision and final resume persistence never permit a second framework commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-resume-crash-'));
  const store = new CorrelationStore(directory);
  const row = await awaiting(store, createIntent({ framework: 'neutral', correlationId: '99999999-9999-4999-8999-999999999999', operationKey: 'thread/crash', requestFingerprint: requestFingerprint({ requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'non-secret approval request' }), expectedParticipants: { requester: 'asker@example.test', responder: 'reviewer@example.test' }, frameworkStateRef: 'checkpoint.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' }));
  const task = completed(row);
  await assert.rejects(() => receiveDecision({ save: async () => { throw new Error('crash before decision persistence'); } }, row, task), /crash before decision persistence/);
  const received = await receiveDecision(store, row, task); // recovery after decision persistence
  let commits = 0;
  const crashBeforeFinalWrite = { save: async (next: CorrelationRecord) => { if (next.phase === 'resumed') throw new Error('crash after framework commit'); await store.save(next); } };
  await assert.rejects(() => resumeDecision(crashBeforeFinalWrite, received, task, { commit: async () => { commits += 1; return 'committed-once'; }, committedEvidence: async () => null }), /crash after framework commit/);
  assert.equal(commits, 1);
  const restarted = await store.load(row.correlationId);
  assert.equal(restarted.phase, 'resume-started');
  const recovered = await resumeDecision(store, restarted, task, { commit: async () => { commits += 1; return 'must-not-run'; }, committedEvidence: async () => 'committed-once' });
  assert.equal(recovered.phase, 'resumed');
  assert.equal(commits, 1);
});

test('ordinary polling observes non-terminal state without terminal wait', async () => {
  let gets = 0;
  const current = taskFor(record(), 'submitted');
  const polled = await pollNonTerminal({ get: async () => (++gets === 2 ? { ...current, state: 'input-required' as const } : current) }, 'task-1', 'input-required', 2);
  assert.equal(polled.state, 'input-required');
  assert.equal(gets, 2);
  assert.equal(markerFor(record()).includes(record().requestFingerprint), true);
});
