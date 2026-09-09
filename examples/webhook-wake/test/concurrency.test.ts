import { afterEach, describe, expect, test } from 'bun:test';
import { mailBody, postHook, startReceiver, testConfig, testRoute } from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeFn, WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('concurrency', () => {
  test('concurrent duplicates share one in-flight send', async () => {
    let releases = 0;
    let started = 0;
    const gate = Promise.withResolvers<void>();
    const bucket: WakeRequest[] = [];
    const wake: WakeFn = async (req) => {
      started += 1;
      await gate.promise;
      bucket.push(req);
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake });
    receivers.push(receiver);
    const body = mailBody();
    const a = postHook(receiver, { body });
    const b = postHook(receiver, { body });
    try {
      for (let i = 0; i < 50 && started === 0; i += 1) {
        await Bun.sleep(10);
      }
      expect(started).toBe(1);
    } finally {
      gate.resolve();
    }
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect([ra.json.disposition, rb.json.disposition].sort().join(',')).toContain('submitted');
    expect(bucket).toHaveLength(1);
    releases += 1;
    expect(releases).toBe(1);
  });

  test('distinct seats are not forced through one lock for observe records', async () => {
    const order: string[] = [];
    const wake: WakeFn = async (req) => {
      order.push(req.terminal);
      return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
    };
    const receiver = await startReceiver(
      testConfig({
        mode: 'observe',
        routes: [
          testRoute(),
          testRoute({
            routeKey: 'other',
            mailbox: 'bob@openagent.email',
            terminal: 'term_examplestale00002',
            subscriptionId: 'whk_bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          }),
        ],
      }),
      { wake },
    );
    receivers.push(receiver);
    const [a, b] = await Promise.all([
      postHook(receiver, { body: mailBody() }),
      postHook(receiver, {
        routeKey: 'other',
        body: mailBody({
          id: 'evt_bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          data: { address: 'bob@openagent.email', messageId: '9' },
        }),
      }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(order).toHaveLength(0);
  });
});
