import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntent, requestFingerprint } from '../src/correlation-store.js';
import { CorrelationStore } from '../src/correlation-store.js';
import { sanitizedTimeline } from '../src/sanitize.js';
import { createOrAdopt, withMarker } from '../src/retry.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('allowlist-built timeline drops adversarial runtime secrets and raw bodies', () => {
  const record = createIntent({ framework: 'neutral', correlationId: '77777777-7777-4777-8777-777777777777', operationKey: 'safe-operation', requestFingerprint: requestFingerprint({ subject: 'safe' }), expectedParticipants: { requester: 'a@example.test', responder: 'b@example.test' }, frameworkStateRef: 'sensitive-owner-only-state', approvalItemKey: null });
  const hostile = { at: '2026-01-01T00:00:00.000Z', phase: 'intent-created', code: 'create-failed', authorization: 'Bearer credential-canary', rawBody: 'raw-sensitive-email-canary', token: 'credential-canary' } as unknown as { at: string; phase: 'intent-created'; code: string };
  const output = JSON.stringify(sanitizedTimeline(record, [hostile]));
  assert.ok(!output.includes('credential-canary'));
  assert.ok(!output.includes('raw-sensitive-email-canary'));
  assert.ok(!output.includes('authorization'));
  assert.ok(output.includes(record.correlationId));
});

test('sensitive request and response material adjacent to a failed create never reaches correlation JSON or timeline', async () => {
  const token = 'credential-canary-actual-flow';
  const rawBody = 'raw-body-canary-actual-flow';
  const record = createIntent({ framework: 'neutral', correlationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', operationKey: 'safe-flow', requestFingerprint: requestFingerprint({ requester: 'a@example.test', responder: 'b@example.test', subject: 'Approve', body: rawBody }), expectedParticipants: { requester: 'a@example.test', responder: 'b@example.test' }, frameworkStateRef: 'checkpoint.sqlite', approvalItemKey: null });
  const directory = await mkdtemp(join(tmpdir(), 'oae-secret-flow-'));
  const store = new CorrelationStore(directory);
  await store.save(record);
  await assert.rejects(() => createOrAdopt(store, { create: async () => { throw new Error(`response carried ${token}`); }, list: async () => [] }, record, { to: 'b@example.test', subject: withMarker(record, 'Approve'), body: rawBody }), /credential-canary-actual-flow/);
  const disk = await readFile(join(directory, `${record.correlationId}.json`), 'utf8');
  const timeline = JSON.stringify(sanitizedTimeline(await store.load(record.correlationId), [{ at: '2026-01-01T00:00:00.000Z', phase: 'create-attempted', code: 'create-failed', authorization: `Bearer ${token}`, rawBody } as never]));
  assert.ok(!disk.includes(token) && !disk.includes(rawBody));
  assert.ok(!timeline.includes(token) && !timeline.includes(rawBody));
});
