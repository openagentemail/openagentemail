import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdtemp, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CorrelationSafetyError, CorrelationStore, createIntent, isCorrelationId, requestFingerprint, transition } from '../src/correlation-store.js';

function intent(id = '11111111-1111-4111-8111-111111111111') {
  return createIntent({ framework: 'neutral', correlationId: id, operationKey: 'workflow/node/approval', requestFingerprint: requestFingerprint({ safe: 'request' }), expectedParticipants: { requester: 'asker@example.test', responder: 'reviewer@example.test' }, frameworkStateRef: 'sensitive-state.bin', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
}
const execFileAsync = promisify(execFile);

test('store accepts only an adjacent durable phase machine with immutable fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-correlation-'));
  const store = new CorrelationStore(directory);
  const created = intent();
  await store.save(created);
  const attempted = transition(created, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z');
  await store.save(attempted);
  const adopted = transition(attempted, 'task-adopted', { taskId: 'task-1' });
  await store.save(adopted);
  assert.equal((await store.load(created.correlationId)).taskId, 'task-1');
  await assert.rejects(() => store.save({ ...adopted, phase: 'resumed' }), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...adopted, operationKey: 'MUTATED' }), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...adopted, taskId: 'task-2' }), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...adopted, createAttemptedAt: '2026-02-02T00:00:00.000Z' }), CorrelationSafetyError);
  assert.throws(() => transition(adopted, 'task-adopted'), CorrelationSafetyError);
  assert.equal(requestFingerprint({ b: 2, a: 1 }), requestFingerprint({ a: 1, b: 2 }));
});

test('correlation IDs are canonical lowercase RFC UUIDs before any filesystem access', async () => {
  const generated = createIntent({ framework: 'neutral', operationKey: 'generated/id', requestFingerprint: requestFingerprint({ safe: 'request' }), expectedParticipants: { requester: 'asker@example.test', responder: 'reviewer@example.test' }, frameworkStateRef: 'state.bin', approvalItemKey: null });
  assert.equal(isCorrelationId(generated.correlationId), true);
  assert.equal(isCorrelationId('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isCorrelationId('11111111-1111-1111-8111-111111111111'), true);
  assert.equal(isCorrelationId('11111111-1111-5111-8111-111111111111'), true);
  const invalid = [
    '-'.repeat(36), '0'.repeat(36), '00000000-0000-0000-0000-000000000000',
    '11111111111141118111111111111111', '1111111-1111-4111-8111-111111111111',
    'gggggggg-gggg-4ggg-8ggg-gggggggggggg', '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111', 'prefix-11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111-suffix', '11111111-1111-4111-8111-111111111111 ',
    '11111111-1111-4111-8111-111111111111\n', '11111111-1111-4111-8111-111111111111\r\n', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'.toUpperCase(),
  ];
  const root = await mkdtemp(join(tmpdir(), 'oae-invalid-uuid-')); const directory = join(root, 'state'); const store = new CorrelationStore(directory);
  for (const id of invalid) {
    assert.equal(isCorrelationId(id), false, id);
    assert.throws(() => createIntent({ framework: 'neutral', correlationId: id, operationKey: 'invalid/id', requestFingerprint: requestFingerprint({ safe: 'request' }), expectedParticipants: { requester: 'asker@example.test', responder: 'reviewer@example.test' }, frameworkStateRef: 'state.bin', approvalItemKey: null }), CorrelationSafetyError);
    await assert.rejects(() => store.load(id), CorrelationSafetyError);
  }
  await assert.rejects(() => access(directory));
  await assert.rejects(() => store.save({ ...intent(), correlationId: invalid[0]! }), CorrelationSafetyError);
  await assert.rejects(() => access(directory));
});

test('store rejects unknown secret/raw fields, impossible initial phases and nested additions before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-correlation-'));
  const store = new CorrelationStore(directory);
  const record = intent('22222222-2222-4222-8222-222222222222');
  const leaked = { ...record, authorization: 'Bearer credential-canary', rawBody: 'raw-body-canary' } as unknown as typeof record;
  await assert.rejects(() => store.save(leaked), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...record, phase: 'resumed' }), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...record, expectedParticipants: { ...record.expectedParticipants, token: 'credential-canary' } } as unknown as typeof record), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...record, updatedAt: 'Bearer credential-canary-in-timestamp' }), CorrelationSafetyError);
  await assert.rejects(() => store.save({ ...record, updatedAt: '2026-01-01T00:00:00Z' }), CorrelationSafetyError);
  assert.deepEqual(await readdir(directory), []);
  await store.save(record);
  const disk = await (await import('node:fs/promises')).readFile(join(directory, `${record.correlationId}.json`), 'utf8');
  assert.ok(!disk.includes('credential-canary') && !disk.includes('raw-body-canary'));
});

test('file safety requires exact 0600, rejects symlink/corruption, and clears failed temporaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-correlation-'));
  const store = new CorrelationStore(directory);
  const record = intent('33333333-3333-4333-8333-333333333333');
  await store.save(record);
  const path = join(directory, `${record.correlationId}.json`);
  for (const mode of [0o400, 0o200, 0o000, 0o644]) {
    await chmod(path, mode);
    await assert.rejects(() => store.load(record.correlationId), CorrelationSafetyError);
  }
  await chmod(path, 0o600);
  await writeFile(path, '{', { mode: 0o600 });
  await assert.rejects(() => store.load(record.correlationId), CorrelationSafetyError);
  const linkId = '44444444-4444-4444-8444-444444444444';
  await symlink(path, join(directory, `${linkId}.json`));
  await assert.rejects(() => store.load(linkId), CorrelationSafetyError);
  const failedDirectory = await mkdtemp(join(tmpdir(), 'oae-failed-write-'));
  const failing = new CorrelationStore(failedDirectory, { beforeRename: async () => { throw new Error('injected rename failure'); } });
  await assert.rejects(() => failing.save(intent('55555555-5555-4555-8555-555555555555')), /injected rename failure/);
  assert.deepEqual(await readdir(failedDirectory), []);
});

test('R5l correlation loads read one validated descriptor and refuse unsafe non-regular targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-descriptor-load-'));
  const id = '77777777-7777-4777-8777-777777777777'; const original = intent(id); const path = join(directory, `${id}.json`);
  await new CorrelationStore(directory).save(original);
  const replacement = { ...original, operationKey: 'workflow/node/replacement' };
  const replacementPath = join(directory, 'replacement.json'); await writeFile(replacementPath, JSON.stringify(replacement), { mode: 0o600 });
  const raced = new CorrelationStore(directory, { afterLoadValidation: async () => { await rename(replacementPath, path); } });
  assert.equal((await raced.load(id)).operationKey, original.operationKey, 'the read must remain bound to the opened inode');
  assert.equal((await new CorrelationStore(directory).load(id)).operationKey, replacement.operationKey, 'the replacement is visible only to a later open');

  const fifoId = '88888888-8888-4888-8888-888888888888'; const fifo = join(directory, `${fifoId}.json`);
  if (process.platform === 'linux') { await execFileAsync('mkfifo', [fifo]); const started = performance.now(); await assert.rejects(() => new CorrelationStore(directory).load(fifoId), CorrelationSafetyError); assert.ok(performance.now() - started < 1_000, 'non-regular FIFO load must not block'); }
  const modeId = '99999999-9999-4999-8999-999999999999'; const modePath = join(directory, `${modeId}.json`); await writeFile(modePath, JSON.stringify(intent(modeId)), { mode: 0o600 }); await chmod(modePath, 0o640); await assert.rejects(() => new CorrelationStore(directory).load(modeId), CorrelationSafetyError);
  const linkId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; await symlink(path, join(directory, `${linkId}.json`)); await assert.rejects(() => new CorrelationStore(directory).load(linkId), CorrelationSafetyError);
  const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const ownerPath = join(directory, `${ownerId}.json`); await writeFile(ownerPath, JSON.stringify(intent(ownerId)), { mode: 0o600 }); const getuid = process.getuid; Object.defineProperty(process, 'getuid', { configurable: true, value: () => (getuid?.() ?? 0) + 1 }); try { await assert.rejects(() => new CorrelationStore(directory).load(ownerId), CorrelationSafetyError); } finally { Object.defineProperty(process, 'getuid', { configurable: true, value: getuid }); }
});

test('per-record lock makes a concurrent durable transition fail busy instead of overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oae-lock-race-'));
  const initial = intent('66666666-6666-4666-8666-666666666666');
  await new CorrelationStore(directory).save(initial);
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const firstStore = new CorrelationStore(directory, { beforeRename: async () => { entered(); await releasePromise; } });
  const first = firstStore.save(transition(initial, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z'));
  await enteredPromise;
  await assert.rejects(() => new CorrelationStore(directory).save(transition(initial, 'create-attempted', { createAttemptedAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:02.000Z')), /busy/);
  release();
  await first;
  assert.equal((await new CorrelationStore(directory).load(initial.correlationId)).createAttemptedAt, '2026-01-01T00:00:01.000Z');
});
