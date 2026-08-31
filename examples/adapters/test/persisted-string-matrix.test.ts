import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrelationStore, createIntent, requestFingerprint, transition, validateCorrelationRecord, type CorrelationRecord, type Phase } from '../src/correlation-store.js';
import { sanitizedTimeline } from '../src/sanitize.js';

const phases: Phase[] = ['intent-created', 'create-attempted', 'task-adopted', 'input-request-attempted', 'awaiting-input', 'decision-received', 'resume-started', 'resumed'];
const stamp = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

function atPhase(phase: Phase, id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'): CorrelationRecord {
  let row = createIntent({ framework: 'neutral', correlationId: id, operationKey: 'workflow/node', requestFingerprint: requestFingerprint({ requester: 'a@example.test', responder: 'b@example.test', subject: 'Approve', body: 'ordinary body' }), expectedParticipants: { requester: 'a@example.test', responder: 'b@example.test' }, frameworkStateRef: 'state.sqlite', approvalItemKey: 'approval-1', now: stamp(0) });
  if (phase === 'intent-created') return row;
  row = transition(row, 'create-attempted', { createAttemptedAt: stamp(1) }, stamp(1));
  if (phase === 'create-attempted') return row;
  row = transition(row, 'task-adopted', { taskId: 'task-1' }, stamp(2));
  if (phase === 'task-adopted') return row;
  row = transition(row, 'input-request-attempted', { inputEvidence: '1'.repeat(64) }, stamp(3));
  if (phase === 'input-request-attempted') return row;
  row = transition(row, 'awaiting-input', {}, stamp(4));
  if (phase === 'awaiting-input') return row;
  row = transition(row, 'decision-received', { decisionEvidence: { decision: 'approved', messageId: 'decision-1', evidenceFingerprint: '2'.repeat(64) } }, stamp(5));
  if (phase === 'decision-received') return row;
  row = transition(row, 'resume-started', {}, stamp(6));
  if (phase === 'resume-started') return row;
  return transition(row, 'resumed', { resumeEvidence: 'resume-1' }, stamp(7));
}

async function persistThrough(store: CorrelationStore, phase: Phase, id: string): Promise<CorrelationRecord> {
  for (const current of phases) {
    const row = atPhase(current, id); await store.save(row);
    if (current === phase) return row;
  }
  throw new Error(`unknown phase ${phase}`);
}

test('R1g positive realistic durable records validate and reload through resumed', async () => {
  for (const [index, phase] of phases.entries()) {
    const store = new CorrelationStore(await mkdtemp(join(tmpdir(), 'oae-r1g-string-positive-')));
    const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 1).padStart(12, '0')}`;
    const row = await persistThrough(store, phase, id);
    validateCorrelationRecord(row);
    assert.deepEqual(await store.load(id), row, phase);
  }
});

type Row = { name: string; phase: Phase; canary: string; mutate: (record: CorrelationRecord) => CorrelationRecord };
const rows: Row[] = [
  { name: 'framework', phase: 'intent-created', canary: 'Bearer credential-canary', mutate: (r) => ({ ...r, framework: 'Bearer credential-canary' }) },
  { name: 'correlationId', phase: 'intent-created', canary: 'bad\r\nuuid', mutate: (r) => ({ ...r, correlationId: 'bad\r\nuuid' }) },
  { name: 'operationKey', phase: 'intent-created', canary: 'raw-body-canary', mutate: (r) => ({ ...r, operationKey: 'raw-body-canary' }) },
  { name: 'requestFingerprint', phase: 'intent-created', canary: 'Bearer credential-canary', mutate: (r) => ({ ...r, requestFingerprint: 'Bearer credential-canary' }) },
  { name: 'requester', phase: 'intent-created', canary: 'token@example.test', mutate: (r) => ({ ...r, expectedParticipants: { ...r.expectedParticipants, requester: 'token@example.test' } }) },
  { name: 'responder', phase: 'intent-created', canary: 'raw-body@example.test', mutate: (r) => ({ ...r, expectedParticipants: { ...r.expectedParticipants, responder: 'raw-body@example.test' } }) },
  { name: 'taskId', phase: 'task-adopted', canary: 'sk-livecredentialcanary', mutate: (r) => ({ ...r, taskId: 'sk-livecredentialcanary' }) },
  { name: 'frameworkStateRef', phase: 'intent-created', canary: '-----BEGIN PRIVATE KEY-----', mutate: (r) => ({ ...r, frameworkStateRef: '-----BEGIN PRIVATE KEY-----' }) },
  { name: 'approvalItemKey', phase: 'intent-created', canary: 'password=value', mutate: (r) => ({ ...r, approvalItemKey: 'password=value' }) },
  { name: 'phase', phase: 'awaiting-input', canary: 'resumed\r\n', mutate: (r) => ({ ...r, phase: 'resumed\r\n' as Phase }) },
  { name: 'createAttemptedAt', phase: 'create-attempted', canary: '2026-01-01T00:00:01.000Z\r\n', mutate: (r) => ({ ...r, createAttemptedAt: '2026-01-01T00:00:01.000Z\r\n' }) },
  { name: 'inputEvidence', phase: 'input-request-attempted', canary: 'Bearer credential-canary', mutate: (r) => ({ ...r, inputEvidence: 'Bearer credential-canary' }) },
  { name: 'decision value', phase: 'decision-received', canary: 'raw-body-canary', mutate: (r) => ({ ...r, decisionEvidence: { ...r.decisionEvidence!, decision: 'raw-body-canary' as 'approved' } }) },
  { name: 'decision message ID', phase: 'decision-received', canary: 'authorization=value', mutate: (r) => ({ ...r, decisionEvidence: { ...r.decisionEvidence!, messageId: 'authorization=value' } }) },
  { name: 'decision fingerprint', phase: 'decision-received', canary: 'Bearer credential-canary', mutate: (r) => ({ ...r, decisionEvidence: { ...r.decisionEvidence!, evidenceFingerprint: 'Bearer credential-canary' } }) },
  { name: 'resumeEvidence', phase: 'resumed', canary: 'secret=value', mutate: (r) => ({ ...r, resumeEvidence: 'secret=value' }) },
  { name: 'updatedAt', phase: 'intent-created', canary: '2026-01-01T00:00:00.000Z\r\n', mutate: (r) => ({ ...r, updatedAt: '2026-01-01T00:00:00.000Z\r\n' }) },
];

test('R1g every schema-approved string slot rejects credential/raw/CRLF canaries before disk replacement', async () => {
  for (const [index, row] of rows.entries()) {
    const directory = await mkdtemp(join(tmpdir(), 'oae-r1g-string-canary-'));
    const store = new CorrelationStore(directory);
    const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 100).padStart(12, '0')}`;
    const prior = await persistThrough(store, row.phase, id);
    const unsafe = row.mutate(prior);
    assert.throws(() => validateCorrelationRecord(unsafe), row.name);
    await assert.rejects(() => store.save(unsafe));
    assert.deepEqual(await store.load(id), prior, row.name);
    const disk = await readFile(join(directory, `${id}.json`), 'utf8');
    assert.equal(disk.includes(row.canary), false, row.name);
  }
});

test('R1g timeline retains record-level unsafe projection regression and allowed fields', () => {
  const safe = atPhase('awaiting-input');
  assert.throws(() => sanitizedTimeline({ ...safe, operationKey: 'Bearer credential-canary' }, []));
  const timeline = sanitizedTimeline(safe, [{ at: stamp(4), phase: 'awaiting-input', code: 'input-failed', taskId: 'task-1', state: 'input-required' }]) as { events: Array<{ taskId?: string; state?: string }> };
  assert.equal(timeline.events.length, 1);
  assert.equal(timeline.events[0]?.taskId, 'task-1');
  assert.equal(timeline.events[0]?.state, 'input-required');
});
