import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CorrelationStore, createIntent, requestFingerprint } from '../src/correlation-store.js';

test('two child processes racing the same durable phase yield exactly one advancing writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oae-child-race-'));
  const state = join(root, 'state');
  const record = createIntent({ framework: 'neutral', correlationId: '88888888-8888-4888-8888-888888888888', operationKey: 'process/reconciliation', requestFingerprint: requestFingerprint({ requester: 'asker@example.test', responder: 'reviewer@example.test', subject: 'Approve transfer', body: 'non-secret approval request' }), expectedParticipants: { requester: 'asker@example.test', responder: 'reviewer@example.test' }, frameworkStateRef: 'checkpoint.sqlite', approvalItemKey: null, now: '2026-01-01T00:00:00.000Z' });
  await new CorrelationStore(state).save(record);
  const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const fixture = join(process.cwd(), 'test/fixtures/reconcile-child.ts');
  const run = (stamp: string) => new Promise<number>((resolve) => spawn(process.execPath, [runner, fixture, 'advance', state, join(root, 'unused.json'), stamp]).on('close', (code) => resolve(code ?? 1)));
  const codes = await Promise.all([run('2026-01-01T00:00:01.000Z'), run('2026-01-01T00:00:02.000Z')]);
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(codes.filter((code) => code !== 0).length, 1);
});
