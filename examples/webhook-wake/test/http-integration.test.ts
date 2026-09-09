import { afterEach, describe, expect, test } from 'bun:test';
import { CANARY_TERMINAL, FIXTURE_SECRET, mailBody, pingBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import { buildSignatureHeader } from '../src/verify.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];

afterEach(async () => {
  while (receivers.length) {
    await receivers.pop()!.close();
  }
});

describe('local HTTP integration', () => {
  test('observe mode validates and records would-wake without sending, under 10s', async () => {
    const started = Date.now();
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'observe' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);

    const health = await fetch(`${receiver.url()}/health`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${receiver.url()}/ready`);
    expect(ready.status).toBe(200);
    const readyJson = (await ready.json()) as { liveness: string; mappings: unknown[] };
    expect(readyJson.liveness).toBe('ok');
    expect(readyJson.mappings.length).toBe(1);

    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('would_wake');
    expect(bucket).toHaveLength(0);
    expect(receiver.metrics.wouldWake).toBe(1);
    expect(receiver.metrics.submitted).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('canary mode sends only to the designated seat', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary', canaryTerminal: CANARY_TERMINAL }), {
      wake: recordingWake(bucket),
    });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
    expect(bucket[0]?.terminal).toBe(CANARY_TERMINAL);
    expect(bucket[0]?.text).toContain('alice@openagent.email');
    expect(bucket[0]?.text).not.toContain('should-never-reach-argv');
    expect(bucket[0]?.argv.includes('--interrupt')).toBe(false);
  });

  test('ping is authenticated and never wakes', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: pingBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('ping_ok');
    expect(bucket).toHaveLength(0);
    expect(receiver.metrics.ping).toBe(1);
    expect(receiver.metrics.submitted).toBe(0);
  });

  test('HTTP rejects a 0xFF substitution of a U+FFFD-signed body', async () => {
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake([]) });
    receivers.push(receiver);
    const nowSec = Math.floor(Date.now() / 1000);
    const withFffd = Buffer.from(
      '{"id":"evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","type":"webhook.ping","payloadVersion":"v1","createdAt":"2026-09-03T12:20:00.000Z","domain":"openagent.email","note":"\uFFFD"}',
      'utf8',
    );
    const idx = withFffd.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    const mutated = Buffer.concat([
      withFffd.subarray(0, idx),
      Buffer.from([0xff]),
      withFffd.subarray(idx + 3),
    ]);
    const header = buildSignatureHeader(FIXTURE_SECRET, withFffd, nowSec);
    const res = await fetch(`${receiver.url()}/hooks/canary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oae-signature': header },
      body: mutated,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { reason?: string };
    expect(json.reason).toBe('signature_mismatch');
  });
});
