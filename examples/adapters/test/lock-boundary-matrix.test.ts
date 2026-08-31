import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrelationStore, createIntent, requestFingerprint, transition, type CorrelationRecord, type Phase } from '../src/correlation-store.js';

const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const base = (correlationId = id): CorrelationRecord => createIntent({ framework: 'neutral', correlationId, operationKey: 'lock/matrix', requestFingerprint: requestFingerprint({ x: 'y' }), expectedParticipants: { requester: 'a@example.test', responder: 'b@example.test' }, frameworkStateRef: 'state.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
const stamp = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

function through(correlationId: string, phase: Phase): CorrelationRecord {
  let row = base(correlationId);
  if (phase === 'intent-created') return row;
  row = transition(row, 'create-attempted', { createAttemptedAt: stamp(1) }, stamp(1));
  if (phase === 'create-attempted') return row;
  row = transition(row, 'task-adopted', { taskId: 'task-prior' }, stamp(2));
  if (phase === 'task-adopted') return row;
  row = transition(row, 'input-request-attempted', { inputEvidence: '1'.repeat(64) }, stamp(3));
  if (phase === 'input-request-attempted') return row;
  row = transition(row, 'awaiting-input', {}, stamp(4));
  if (phase === 'awaiting-input') return row;
  row = transition(row, 'decision-received', { decisionEvidence: { decision: 'approved', messageId: 'decision-prior', evidenceFingerprint: '2'.repeat(64) } }, stamp(5));
  if (phase === 'decision-received') return row;
  row = transition(row, 'resume-started', {}, stamp(6));
  if (phase === 'resume-started') return row;
  return transition(row, 'resumed', { resumeEvidence: 'resume-prior' }, stamp(7));
}

type Boundary = { name: string; prior: Phase; candidates: (row: CorrelationRecord) => [CorrelationRecord, CorrelationRecord] };
const boundaries: Boundary[] = [
  { name: 'intent-created → create-attempted', prior: 'intent-created', candidates: (row) => [transition(row, 'create-attempted', { createAttemptedAt: stamp(10) }, stamp(10)), transition(row, 'create-attempted', { createAttemptedAt: stamp(11) }, stamp(11))] },
  { name: 'create-attempted → task-adopted', prior: 'create-attempted', candidates: (row) => [transition(row, 'task-adopted', { taskId: 'task-A' }, stamp(10)), transition(row, 'task-adopted', { taskId: 'task-B' }, stamp(11))] },
  { name: 'task-adopted → input-request-attempted', prior: 'task-adopted', candidates: (row) => [transition(row, 'input-request-attempted', { inputEvidence: 'a'.repeat(64) }, stamp(10)), transition(row, 'input-request-attempted', { inputEvidence: 'b'.repeat(64) }, stamp(11))] },
  { name: 'awaiting-input → decision-received', prior: 'awaiting-input', candidates: (row) => [transition(row, 'decision-received', { decisionEvidence: { decision: 'approved', messageId: 'decision-A', evidenceFingerprint: 'a'.repeat(64) } }, stamp(10)), transition(row, 'decision-received', { decisionEvidence: { decision: 'rejected', messageId: 'decision-B', evidenceFingerprint: 'b'.repeat(64) } }, stamp(11))] },
  { name: 'resume-started → resumed', prior: 'resume-started', candidates: (row) => [transition(row, 'resumed', { resumeEvidence: 'resume-A' }, stamp(10)), transition(row, 'resumed', { resumeEvidence: 'resume-B' }, stamp(11))] },
];

async function persistPrior(store: CorrelationStore, row: CorrelationRecord): Promise<void> {
  const phases: Phase[] = ['intent-created', 'create-attempted', 'task-adopted', 'input-request-attempted', 'awaiting-input', 'decision-received', 'resume-started', 'resumed'];
  for (const phase of phases) {
    await store.save(through(row.correlationId, phase));
    if (phase === row.phase) return;
  }
}

function rejectedReason(outcome: PromiseSettledResult<void>): string {
  return outcome.status === 'rejected' ? String(outcome.reason) : '';
}

test('R1g exact lock replacement preserves replacement owner and permits only B commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-r1g-lock-replace-'));
  const row = base();
  await new CorrelationStore(directory).save(row);
  let enteredA!: () => void; let releaseA!: () => void;
  let enteredB!: () => void; let releaseB!: () => void;
  const aPaused = new Promise<void>((resolve) => { enteredA = resolve; });
  const bPaused = new Promise<void>((resolve) => { enteredB = resolve; });
  const aGate = new Promise<void>((resolve) => { releaseA = resolve; });
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  const candidateA = transition(row, 'create-attempted', { createAttemptedAt: stamp(10) }, stamp(10));
  const candidateB = transition(row, 'create-attempted', { createAttemptedAt: stamp(11) }, stamp(11));
  const writerA = new CorrelationStore(directory, { beforeRename: async () => { enteredA(); await aGate; } });
  const writerB = new CorrelationStore(directory, { beforeRename: async () => { enteredB(); await bGate; } });
  const a = writerA.save(candidateA);
  await aPaused;
  const lock = join(directory, `${row.correlationId}.json.lock`);
  await unlink(join(lock, 'owner'));
  await rmdir(lock);
  const b = writerB.save(candidateB);
  await bPaused;
  await access(join(lock, 'owner'));
  const replacementOwner = await readFile(join(lock, 'owner'), 'utf8');
  assert.match(replacementOwner, /^[0-9a-f-]{36}$/i);
  releaseA();
  await assert.rejects(() => a, /lock (ownership|token) was replaced/);
  await access(join(lock, 'owner'));
  assert.equal(await readFile(join(lock, 'owner'), 'utf8'), replacementOwner);
  releaseB();
  await b;
  assert.deepEqual(await new CorrelationStore(directory).load(row.correlationId), candidateB);
});

test('R1g same-process races execute every durable evidence boundary', async () => {
  for (const [index, boundary] of boundaries.entries()) {
    const directory = await mkdtemp(join(tmpdir(), 'oae-r1g-same-race-'));
    const correlationId = `cccccccc-cccc-4ccc-8ccc-${String(index + 1).padStart(12, '0')}`;
    const prior = through(correlationId, boundary.prior);
    await persistPrior(new CorrelationStore(directory), prior);
    const [firstCandidate, secondCandidate] = boundary.candidates(prior);
    const outcomes = await Promise.allSettled([new CorrelationStore(directory).save(firstCandidate), new CorrelationStore(directory).save(secondCandidate)]);
    const fulfilled = outcomes.flatMap((outcome, candidate) => outcome.status === 'fulfilled' ? [candidate] : []);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1, boundary.name);
    assert.equal(rejected.length, 1, boundary.name);
    assert.match(rejectedReason(rejected[0]!), /busy|adjacent|ownership|transition/i, boundary.name);
    assert.deepEqual(await new CorrelationStore(directory).load(correlationId), [firstCandidate, secondCandidate][fulfilled[0]!]!, boundary.name);
  }
});

async function waitFor(paths: string[]): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    try { await Promise.all(paths.map((path) => access(path))); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`child ready barrier timed out: ${paths.join(', ')}`);
}

function runChild(args: string[]): Promise<number> {
  const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const fixture = join(process.cwd(), 'test/fixtures/race-child.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, fixture, ...args], { stdio: 'pipe' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

test('R1g child-process races execute every durable evidence boundary', async () => {
  for (const [index, boundary] of boundaries.entries()) {
    const root = await mkdtemp(join(tmpdir(), 'oae-r1g-child-race-'));
    const directory = join(root, 'state');
    const correlationId = `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, '0')}`;
    const prior = through(correlationId, boundary.prior);
    await persistPrior(new CorrelationStore(directory), prior);
    const candidates = boundary.candidates(prior);
    const go = join(root, 'go');
    const ready = candidates.map((_, candidate) => join(root, `ready-${candidate}`));
    const results = candidates.map((_, candidate) => join(root, `result-${candidate}.json`));
    const payloads = candidates.map((_, candidate) => join(root, `candidate-${candidate}.json`));
    await Promise.all(payloads.map((path, item) => writeFile(path, JSON.stringify(candidates[item]), 'utf8')));
    const exits = candidates.map((_, item) => runChild([directory, payloads[item]!, ready[item]!, go, results[item]!]));
    await waitFor(ready);
    await writeFile(go, 'go\n', 'utf8');
    const codes = await Promise.all(exits);
    const childResults = await Promise.all(results.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as { ok: boolean; error?: string }));
    assert.equal(codes.filter((code) => code === 0).length, 1, boundary.name);
    assert.equal(codes.filter((code) => code !== 0).length, 1, boundary.name);
    assert.equal(childResults.filter((result) => result.ok).length, 1, boundary.name);
    const failure = childResults.find((result) => !result.ok);
    assert.match(failure?.error ?? '', /busy|adjacent|ownership|transition/i, boundary.name);
    const winner = childResults.findIndex((result) => result.ok);
    assert.deepEqual(await new CorrelationStore(directory).load(correlationId), candidates[winner]!, boundary.name);
  }
});
