import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('at-least-once crash window', () => {
  test('send-then-crash before commit leaves the event retryable and may duplicate', async () => {
    const bucket: WakeRequest[] = [];
    const config = testConfig({ mode: 'canary' });
    const crashing = await startReceiver(config, {
      wake: recordingWake(bucket),
      crashAfterSendBeforeCommit: true,
    });
    receivers.push(crashing);
    const body = mailBody();
    const first = await postHook(crashing, { body });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('crash_after_send');
    expect(bucket).toHaveLength(1);
    await crashing.close();
    receivers.pop();

    const healthy = await startReceiver(config, { wake: recordingWake(bucket) });
    receivers.push(healthy);
    const second = await postHook(healthy, { body });
    expect(second.status).toBe(200);
    expect(second.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(2);
  });
});
