import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import { createReceiver, listenReceiver, type Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('replay and restart dedup', () => {
  test('replayed event sends once while healthy', async () => {
    const bucket: WakeRequest[] = [];
    const config = testConfig({ mode: 'canary' });
    const receiver = await startReceiver(config, { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const body = mailBody();
    const first = await postHook(receiver, { body });
    const second = await postHook(receiver, { body });
    expect(first.status).toBe(200);
    expect(first.json.disposition).toBe('submitted');
    expect(second.status).toBe(200);
    expect(second.json.disposition).toBe('duplicate');
    expect(bucket).toHaveLength(1);
  });

  test('restart retains durable dedup', async () => {
    const bucket: WakeRequest[] = [];
    const config = testConfig({ mode: 'canary' });
    const first = await startReceiver(config, { wake: recordingWake(bucket) });
    receivers.push(first);
    const body = mailBody();
    expect((await postHook(first, { body })).json.disposition).toBe('submitted');
    await first.close();
    receivers.pop();

    const second = createReceiver(config, { wake: recordingWake(bucket) });
    await listenReceiver(second);
    receivers.push(second);
    const replay = await postHook(second, { body });
    expect(replay.status).toBe(200);
    expect(replay.json.disposition).toBe('duplicate');
    expect(bucket).toHaveLength(1);
  });

  test('observed records suppress the same event id after a canary switch', async () => {
    const bucket: WakeRequest[] = [];
    const config = testConfig({ mode: 'observe' });
    const observer = await startReceiver(config, { wake: recordingWake(bucket) });
    receivers.push(observer);
    const body = mailBody();
    expect((await postHook(observer, { body })).json.disposition).toBe('would_wake');
    await observer.close();
    receivers.pop();

    const canary = createReceiver({ ...config, mode: 'canary' }, { wake: recordingWake(bucket) });
    await listenReceiver(canary);
    receivers.push(canary);
    const replay = await postHook(canary, { body });
    expect(replay.status).toBe(200);
    expect(replay.json.disposition).toBe('duplicate');
    expect(bucket).toHaveLength(0);

    const fresh = await postHook(canary, {
      body: mailBody({ id: 'evt_22222222-3333-4444-5555-666666666666' }),
    });
    expect(fresh.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
  });
});

