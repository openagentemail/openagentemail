import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('storage fail-closed', () => {
  test('read failure returns 503 and stays retryable', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('read');
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(posted.json.disposition).toBe('storage_failed');
    expect(bucket).toHaveLength(0);

    const retry = await postHook(receiver, { body: mailBody() });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
  });

  test('capacity failure does not evict live records', async () => {
    const bucket: WakeRequest[] = [];
    const base = testConfig({ mode: 'canary' });
    const receiver = await startReceiver(
      { ...base, dedup: { ...base.dedup, maxRecords: 1 } },
      { wake: recordingWake(bucket) },
    );
    receivers.push(receiver);

    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(200);

    const secondBody = mailBody({ id: 'evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const second = await postHook(receiver, { body: secondBody });
    expect(second.status).toBe(503);
    expect(second.json.reason).toBe('storage_capacity');

    const replayFirst = await postHook(receiver, { body: mailBody() });
    expect(replayFirst.json.disposition).toBe('duplicate');
    expect(bucket).toHaveLength(1);
  });

  test('failed send stays retryable because no success record is written', async () => {
    let failNext = true;
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), {
      wake: async (req) => {
        if (failNext) {
          failNext = false;
          return { ok: false, reason: 'nonzero_exit', exitCode: 2, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
        }
        return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    receivers.push(receiver);
    const body = mailBody();
    const first = await postHook(receiver, { body });
    expect(first.status).toBe(503);
    expect(first.json.disposition).toBe('send_failed');
    const second = await postHook(receiver, { body });
    expect(second.status).toBe(200);
    expect(second.json.disposition).toBe('submitted');
    expect(receiver.metrics.submitted).toBe(1);
  });
});
