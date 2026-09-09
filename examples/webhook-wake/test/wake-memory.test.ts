import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('bounded in-memory wake history', () => {
  test('high event count does not retain unbounded wake objects', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary', wakeHistoryLimit: 8, dedup: { maxRecords: 80 } }), {
      wake: recordingWake(bucket),
    });
    receivers.push(receiver);
    for (let i = 0; i < 40; i += 1) {
      const id = `evt_${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`;
      const posted = await postHook(receiver, { body: mailBody({ id }) });
      expect(posted.status).toBe(200);
    }
    expect(bucket).toHaveLength(40);
    expect(receiver.wakes.length).toBe(8);
    expect(receiver.metrics.submitted).toBe(40);
  });

  test('default history limit is empty even after a successful send', async () => {
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake([]) });
    receivers.push(receiver);
    await postHook(receiver, { body: mailBody() });
    expect(receiver.wakes).toHaveLength(0);
  });
});
