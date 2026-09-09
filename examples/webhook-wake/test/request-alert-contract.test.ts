import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig, testRoute } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { AlertEvent, WakeRequest } from '../src/types.ts';
import type { Receiver } from '../src/server.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('request and alert contract', () => {
  test('oversized body returns HTTP 413 on the wire and health still answers', async () => {
    const receiver = await startReceiver(testConfig({ bodyLimitBytes: 64 }), { wake: recordingWake([]) });
    receivers.push(receiver);
    const huge = `${mailBody()}${'x'.repeat(200)}`;
    const res = await fetch(`${receiver.url()}/hooks/canary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { reason?: string };
    expect(json.reason).toBe('body_too_large');
    const health = await fetch(`${receiver.url()}/health`);
    expect(health.status).toBe(200);
  });

  test('unauthenticated unknown routes do not call a slow alert; valid mail still proceeds', async () => {
    const alerts: AlertEvent[] = [];
    let alertCalls = 0;
    const receiver = await startReceiver(testConfig({ mode: 'canary', maxConcurrent: 2, alertHook: { timeoutMs: 2000 } }), {
      wake: recordingWake([]),
      alert: async (event) => {
        alertCalls += 1;
        alerts.push(event);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { ok: true };
      },
    });
    receivers.push(receiver);

    const started = Date.now();
    const flood = await Promise.all(
      ['nope', 'also-missing', 'still-missing'].map((routeKey) => postHook(receiver, { routeKey, body: mailBody() })),
    );
    expect(flood.every((row) => row.status === 404)).toBe(true);
    expect(Date.now() - started).toBeLessThan(800);
    expect(alertCalls).toBe(0);

    const valid = await postHook(receiver, { body: mailBody() });
    expect(valid.status).toBe(200);
    expect(valid.json.disposition).toBe('submitted');
    expect(alerts).toHaveLength(0);
  });

  test('stale known routes authenticate before any alert side effect', async () => {
    const alerts: AlertEvent[] = [];
    const receiver = await startReceiver(
      testConfig({
        mode: 'canary',
        routes: [testRoute({ stale: true })],
      }),
      {
        wake: recordingWake([]),
        alert: async (event) => {
          alerts.push(event);
          return { ok: true };
        },
      },
    );
    receivers.push(receiver);

    const unsigned = await fetch(`${receiver.url()}/hooks/canary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mailBody(),
    });
    expect(unsigned.status).toBe(401);
    expect(alerts).toHaveLength(0);

    const signed = await postHook(receiver, { body: mailBody() });
    expect(signed.status).toBe(503);
    expect(signed.json.reason).toBe('stale_mapping');
    expect(alerts.map((a) => a.code)).toEqual(['stale_mapping']);
  });

  test('signed mailbox mismatch is 503, writes no dedup, and stays retryable', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const first = await postHook(receiver, {
      body: mailBody({ data: { address: 'eve@openagent.email', messageId: '123' } }),
    });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('mailbox_mismatch');
    expect(bucket).toHaveLength(0);
    expect(await receiver.dedup.count(Date.now())).toBe(0);

    const retry = await postHook(receiver, { body: mailBody() });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
  });
});
