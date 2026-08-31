import assert from 'node:assert/strict';
import test from 'node:test';
import { CorrelationSafetyError, createIntent, requestFingerprint, transition, type CorrelationRecord } from '../src/correlation-store.js';
import { createOrAdopt, validateCorrelatedTask, validateDecision, withMarker } from '../src/retry.js';
import type { OaeTask, TaskMessage } from '../src/openagentemail.js';

const request = { requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'ordinary request body' };
function attempted(): CorrelationRecord {
  const created = createIntent({ framework: 'neutral', correlationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', operationKey: 'history/matrix', requestFingerprint: requestFingerprint(request), expectedParticipants: { requester: request.requester, responder: request.responder }, frameworkStateRef: 'state.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
  return transition(created, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
}
function adopted(): CorrelationRecord { return transition(attempted(), 'task-adopted', { taskId: 'task-1' }, '2026-01-01T00:00:02.000Z'); }
function validTask(row: CorrelationRecord): OaeTask {
  const subject = withMarker(row, request.subject);
  return { id: 'task-1', from: request.requester, to: request.responder, subject, state: 'submitted', createdAt: 'x', updatedAt: 'x', messages: [{ id: 'root-1', from: request.requester, to: request.responder, subject, date: 'x', state: 'submitted', body: request.body }] };
}
function completed(row: CorrelationRecord): OaeTask {
  const task = validTask(row); const terminal: TaskMessage = { id: 'completed-1', from: request.responder, to: request.requester, subject: task.subject, date: 'x', state: 'completed', body: 'approved', result: { decision: 'approved' } };
  return { ...task, state: 'completed', messages: [...task.messages, terminal], result: { decision: 'approved' } };
}

test('R1g root history variants execute validateCorrelatedTask and createOrAdopt without adoption', async () => {
  type Row = { name: string; mutate: (task: OaeTask) => OaeTask };
  const rows: Row[] = [
    { name: 'second root wrong sender', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-sender', from: 'attacker@example.test' }] }) },
    { name: 'second root wrong recipient', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-recipient', to: 'attacker@example.test' }] }) },
    { name: 'second root wrong subject', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-subject', subject: 'other thread' }] }) },
    { name: 'second root wrong body', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-body', body: 'other body' }] }) },
    { name: 'second root wrong marker', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-marker', subject: `${task.subject} [oae-correlation:wrong]` }] }) },
    { name: 'second root task thread identity', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[0]!, id: 'root-thread', subject: task.subject.replace('Approve transfer', 'Different transfer') }] }) },
  ];
  for (const row of rows) {
    const record = attempted(); const corrupt = row.mutate(validTask(record)); let saves = 0;
    assert.throws(() => validateCorrelatedTask(corrupt, record), CorrelationSafetyError, row.name);
    await assert.rejects(() => createOrAdopt({ save: async () => { saves += 1; } }, { create: async () => { throw new Error('create must not run from create-attempted'); }, list: async () => [corrupt] }, record, { to: request.responder, subject: validTask(record).subject, body: request.body }), CorrelationSafetyError, row.name);
    assert.equal(saves, 0, row.name);
  }
});

test('R1g terminal history variants execute validateDecision and preserve non-adoption', () => {
  type Row = { name: string; mutate: (task: OaeTask) => OaeTask };
  const rows: Row[] = [
    { name: 'wrong terminal sender', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, from: 'attacker@example.test' }] }) },
    { name: 'wrong terminal recipient', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, to: 'attacker@example.test' }] }) },
    { name: 'wrong terminal subject thread', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, subject: 'other thread' }] }) },
    { name: 'missing result', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, result: undefined }], result: undefined }) },
    { name: 'extra result property', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, result: { decision: 'approved', extra: true } }], result: { decision: 'approved', extra: true } }) },
    { name: 'invalid result value', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, result: { decision: 'maybe' } }], result: { decision: 'maybe' } }) },
    { name: 'duplicate completed', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'completed-2' }] }) },
    { name: 'completed plus failed', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'failed-1', state: 'failed' }] }) },
    { name: 'duplicate failed', mutate: (task) => ({ ...task, messages: [task.messages[0]!, { ...task.messages[1]!, state: 'failed', id: 'failed-1' }, { ...task.messages[1]!, state: 'failed', id: 'failed-2' }] }) },
    { name: 'contradictory terminal mixture', mutate: (task) => ({ ...task, messages: [...task.messages, { ...task.messages[1]!, id: 'failed-1', state: 'failed', result: { decision: 'rejected' } }] }) },
  ];
  for (const row of rows) {
    const record = adopted(); const terminal = row.mutate(completed(record)); const before = structuredClone(record);
    assert.throws(() => validateDecision(terminal, record), CorrelationSafetyError, row.name);
    assert.deepEqual(record, before, row.name);
  }
});
