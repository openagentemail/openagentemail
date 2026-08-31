import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrelationStore, createIntent, requestFingerprint, transition, type CorrelationRecord } from '../src/correlation-store.js';
import { inputBodyFor, requestInputOrReconcile, withMarker } from '../src/retry.js';
import type { OaeTask, TaskState } from '../src/openagentemail.js';

const base = { requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'non-secret approval request' };
const record = (id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd') => createIntent({ framework: 'neutral', correlationId: id, operationKey: 'input/matrix', requestFingerprint: requestFingerprint(base), expectedParticipants: { requester: base.requester, responder: base.responder }, frameworkStateRef: 'state.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });

async function adopted(store: CorrelationStore, id?: string): Promise<CorrelationRecord> {
  const created = record(id); await store.save(created);
  const attempted = transition(created, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z'); await store.save(attempted);
  const next = transition(attempted, 'task-adopted', { taskId: 'task-1' }, '2026-01-01T00:00:02.000Z'); await store.save(next);
  return next;
}

async function inputAttempted(store: CorrelationStore, id?: string, evidence?: string): Promise<CorrelationRecord> {
  const prior = await adopted(store, id);
  const next = transition(prior, 'input-request-attempted', { inputEvidence: evidence ?? requestFingerprint({ taskId: 'task-1', body: inputBodyFor(prior) }) }, '2026-01-01T00:00:03.000Z');
  await store.save(next); return next;
}

function taskFor(row: CorrelationRecord, state: TaskState = 'input-required'): OaeTask {
  const subject = withMarker(row, base.subject); const body = inputBodyFor(row);
  return { id: 'task-1', from: base.requester, to: base.responder, subject, state, createdAt: 'x', updatedAt: 'x', messages: [
    { id: 'root-1', from: base.requester, to: base.responder, subject, date: 'x', state: 'submitted', body: base.body },
    { id: 'input-1', from: base.requester, to: base.responder, subject, date: 'x', state: 'input-required', body },
  ] };
}

function rootOnlyTaskFor(row: CorrelationRecord): OaeTask {
  const subject = withMarker(row, base.subject);
  return { id: 'task-1', from: base.requester, to: base.responder, subject, state: 'input-required', createdAt: 'x', updatedAt: 'x', messages: [
    { id: 'root-1', from: base.requester, to: base.responder, subject, date: 'x', state: 'submitted', body: base.body },
  ] };
}

function recoveryClient(task: OaeTask, sends: { count: number }) {
  return { inputRequired: async () => { sends.count += 1; return task; }, get: async () => task };
}

test('R1g valid first response persists awaiting-input after exactly one send', async () => {
  const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1g-input-first-')));
  const prior = await adopted(store); const task = taskFor(prior); const sends = { count: 0 };
  const result = await requestInputOrReconcile(store, recoveryClient(task, sends), prior);
  assert.equal(result.phase, 'awaiting-input');
  assert.equal(sends.count, 1);
  assert.deepEqual(await store.load(prior.correlationId), result);
});

test('R1h before-acceptance crash has zero durable input evidence and fails closed without resend', async () => {
  const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1h-input-before-acceptance-')));
  const prior = await adopted(store); let sends = 0;
  await assert.rejects(() => requestInputOrReconcile(store, { inputRequired: async () => { sends += 1; throw new Error('before-acceptance crash'); }, get: async () => rootOnlyTaskFor(prior) }, prior), /before-acceptance crash/);
  const restarted = await store.load(prior.correlationId);
  assert.equal(restarted.phase, 'input-request-attempted');
  assert.equal(sends, 1);
  await assert.rejects(() => requestInputOrReconcile(store, { inputRequired: async () => { sends += 1; throw new Error('must not resend'); }, get: async () => rootOnlyTaskFor(prior) }, restarted), /expected one exact stamped event, got 0/);
  assert.equal(sends, 1);
  assert.deepEqual(await store.load(prior.correlationId), restarted);
});

test('R1h after-acceptance pre-final-write recovery adopts one event and repeat never resends', async () => {
  const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1h-input-after-acceptance-')));
  const prior = await adopted(store, 'dddddddd-dddd-4ddd-8ddd-000000000002'); const accepted = taskFor(prior); let sends = 0;
  await assert.rejects(() => requestInputOrReconcile(store, { inputRequired: async () => { sends += 1; throw new Error('after-acceptance before-final-write crash'); }, get: async () => accepted }, prior), /after-acceptance/);
  const restarted = await store.load(prior.correlationId);
  assert.equal(restarted.phase, 'input-request-attempted');
  const awaiting = await requestInputOrReconcile(store, { inputRequired: async () => { sends += 1; throw new Error('must not resend'); }, get: async () => accepted }, restarted);
  assert.equal(awaiting.phase, 'awaiting-input');
  await assert.rejects(() => requestInputOrReconcile(store, { inputRequired: async () => { sends += 1; return accepted; }, get: async () => accepted }, awaiting), /cannot start in awaiting-input/);
  assert.equal(sends, 1);
});

test('R1g durable mismatched stored input fingerprint rejects with zero sends and retains attempted disk state', async () => {
  const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1g-input-fingerprint-')));
  const attempted = await inputAttempted(store, undefined, '0'.repeat(64)); const sends = { count: 0 };
  await assert.rejects(() => requestInputOrReconcile(store, recoveryClient(taskFor(attempted), sends), attempted), /persisted input evidence contradicts canonical input body/);
  assert.equal(sends.count, 0);
  const disk = await store.load(attempted.correlationId);
  assert.equal(disk.phase, 'input-request-attempted');
  assert.equal(disk.inputEvidence, '0'.repeat(64));
});

test('R1g hostile input histories call production recovery from durable attempted state', async () => {
  type Row = { name: string; mutate: (task: OaeTask) => OaeTask };
  const rows: Row[] = [
    ...(['submitted', 'working', 'completed', 'failed'] as TaskState[]).map((state) => ({ name: `top-level ${state}`, mutate: (task: OaeTask) => ({ ...task, state }) })),
    { name: 'exact input plus completed terminal', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'completed', from: base.responder, to: base.requester, state: 'completed', result: { decision: 'approved' } }] }) },
    { name: 'exact input plus failed terminal', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'failed', from: base.responder, to: base.requester, state: 'failed' }] }) },
    { name: 'both terminals', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'completed', from: base.responder, to: base.requester, state: 'completed' }, { ...task.messages[1]!, id: 'failed', from: base.responder, to: base.requester, state: 'failed' }] }) },
    { name: 'duplicate input events', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'input-2' }] }) },
    { name: 'wrong input sender', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, from: 'attacker@example.test' }] }) },
    { name: 'wrong input recipient', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, to: 'attacker@example.test' }] }) },
    { name: 'wrong input subject', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, subject: 'different thread' }] }) },
    { name: 'wrong input body', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, body: 'different body' }] }) },
    { name: 'wrong task ID', mutate: (task) => ({ ...task, id: 'task-other' }) },
    { name: 'contradictory root', mutate: (task) => ({ ...task, messages: [{ ...task.messages[0]!, from: 'attacker@example.test' }, task.messages[1]!] }) },
    { name: 'multiple roots', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-2' }] }) },
  ];
  for (const [index, row] of rows.entries()) {
    const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1g-input-hostile-')));
    const attempted = await inputAttempted(store, `dddddddd-dddd-4ddd-8ddd-${String(index + 100).padStart(12, '0')}`);
    const sends = { count: 0 };
    await assert.rejects(() => requestInputOrReconcile(store, recoveryClient(row.mutate(taskFor(attempted)), sends), attempted));
    assert.equal(sends.count, 0, row.name);
    assert.deepEqual(await store.load(attempted.correlationId), attempted, row.name);
  }
});
