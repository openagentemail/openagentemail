import { afterEach, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig, testRoute } from './helpers.ts';
import { mailDedupKey, type Receiver } from '../src/server.ts';
import { parseVerifiedEnvelope } from '../src/parse.ts';
import { recordingWake } from '../src/wake.ts';
import type { WakeRequest } from '../src/types.ts';
const receivers: Receiver[] = [];
afterEach(async () => { while (receivers.length) await receivers.pop()!.close(); });
const secondId = 'evt_bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
function mail(id: string, uid: unknown = '123', generation?: unknown) {
  return mailBody({ id, data: { messageId: uid, ...(generation === undefined ? {} : { uidValidity: generation }) } });
}
async function receiver(byMessage = true, config = testConfig({ mode: 'canary', dedup: { byMessage } })) {
  const bucket: WakeRequest[] = [];
  const r = await startReceiver(config, { wake: recordingWake(bucket) });
  receivers.push(r);
  return { r, bucket, config };
}

test('opt-in suppresses redelivery with new event ID, including after restart', async () => {
  const { r, bucket, config } = await receiver();
  expect((await postHook(r, { body: mailBody() })).json.disposition).toBe('submitted');
  await r.close(); receivers.pop();
  const next = await startReceiver(config, { wake: recordingWake(bucket) }); receivers.push(next);
  expect((await postHook(next, { body: mail(secondId, '123', 1) })).json.disposition).toBe('duplicate');
  expect(bucket).toHaveLength(1);
});

test('opt-in preserves rollover and distinct messages', async () => {
  const { r, bucket } = await receiver();
  await postHook(r, { body: mailBody() });
  await postHook(r, { body: mail(secondId, '123', 2) });
  await postHook(r, { body: mail(secondId, '124', 2) });
  expect(bucket).toHaveLength(3);
});

test('default preserves new-event replay semantics', async () => {
  const { r, bucket } = await receiver(false);
  await postHook(r, { body: mailBody() });
  await postHook(r, { body: mail(secondId, '123', 1) });
  expect(bucket).toHaveLength(2);
});

test('incomplete or unsafe identity falls back to event ID', async () => {
  for (const generation of [null, undefined, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, {}, '1e3', '0']) {
    const { r, bucket } = await receiver();
    await postHook(r, { body: mail('evt_11111111-2222-3333-4444-555555555555', '123', generation) });
    await postHook(r, { body: mail(secondId, '123', generation) });
    expect(bucket).toHaveLength(2);
  }
});

test('canonical decimal identity is lossless and route-scoped', () => {
  const parsed = parseVerifiedEnvelope(mailBody()); if (!parsed.ok) throw new Error(parsed.reason);
  const e = parsed.envelope; const route = testRoute();
  const base = mailDedupKey(route, e, true);
  expect(mailDedupKey(route, { ...e, data: { ...e.data, messageId: '00123', uidValidity: '0001' } }, true)).toBe(base);
  expect(mailDedupKey(route, { ...e, data: { ...e.data, uidValidity: '9007199254740993' } }, true)).not.toBe(mailDedupKey(route, { ...e, data: { ...e.data, uidValidity: '9007199254740992' } }, true));
  expect(mailDedupKey({ ...route, mailbox: 'bob@openagent.email' }, e, true)).not.toBe(base);
  expect(mailDedupKey({ ...route, subscriptionId: 'other' }, e, true)).not.toBe(base);
});

test('concurrent new-ID redeliveries share one wake', async () => {
  const { r, bucket } = await receiver();
  const results = await Promise.all([
    postHook(r, { body: mailBody() }),
    postHook(r, { body: mail(secondId, '123', 1) }),
  ]);
  expect(results.map(x => x.status)).toEqual([200, 200]);
  expect(bucket).toHaveLength(1);
});

test('failed send does not poison the message key', async () => {
  let attempts = 0;
  const r = await startReceiver(testConfig({ mode: 'canary', dedup: { byMessage: true } }), {
    wake: async (req) => (++attempts === 1
      ? { ok: false, exitCode: 1, reason: 'nonzero_exit', argv: req.argv, stdoutBytes: 0, stderrBytes: 0 }
      : { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 }),
  }); receivers.push(r);
  expect((await postHook(r, { body: mailBody() })).status).toBe(503);
  expect((await postHook(r, { body: mail(secondId, '123', 1) })).json.disposition).toBe('submitted');
  expect(attempts).toBe(2);
});

test('opt-in observe record suppresses new-ID canary replay', async () => {
  const config = testConfig({ dedup: { byMessage: true } });
  const first = await startReceiver(config); receivers.push(first);
  expect((await postHook(first, { body: mailBody() })).json.disposition).toBe('would_wake');
  await first.close(); receivers.pop();
  const { r, bucket } = await receiver(true, { ...config, mode: 'canary' });
  expect((await postHook(r, { body: mail(secondId, '123', 1) })).json.disposition).toBe('duplicate');
  expect(bucket).toHaveLength(0);
});

test('invalid UID identity falls back without coalescing distinct events', () => {
  const parsed = parseVerifiedEnvelope(mailBody()); if (!parsed.ok) throw new Error(parsed.reason);
  const e = parsed.envelope; const route = testRoute();
  for (const uid of [null, undefined, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, {}, 'rfc@example.com', '', '0']) {
    const data = { ...e.data, messageId: uid };
    expect(mailDedupKey(route, { ...e, data }, true)).not.toBe(mailDedupKey(route, { ...e, id: secondId, data }, true));
  }
});

test('opt-in exact replay is duplicate and capacity still fails closed', async () => {
  const { r, bucket } = await receiver(true, testConfig({ mode: 'canary', dedup: { byMessage: true, maxRecords: 1 } }));
  expect((await postHook(r, { body: mailBody() })).json.disposition).toBe('submitted');
  expect((await postHook(r, { body: mailBody() })).json.disposition).toBe('duplicate');
  const full = await postHook(r, { body: mail(secondId, '124', 1) });
  expect(full.status).toBe(503);
  expect(bucket).toHaveLength(1);
});
