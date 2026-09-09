import { afterEach, describe, expect, test } from 'bun:test';
import { approvalBody, mailBody, postHook, startReceiver, testConfig, testRoute } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('mapping and injection boundaries', () => {
  test('unknown route does not wake', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const posted = await postHook(receiver, { routeKey: 'nope', body: mailBody() });
    expect(posted.status).toBe(404);
    expect(bucket).toHaveLength(0);
  });

  test('wrong mailbox and domain produce no send', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);

    const wrongMailbox = await postHook(receiver, {
      body: mailBody({ data: { address: 'eve@openagent.email', messageId: '123' } }),
    });
    expect(wrongMailbox.status).toBe(503);
    expect(wrongMailbox.json.disposition).toBe('rejected');
    expect(wrongMailbox.json.reason).toBe('mailbox_mismatch');

    const wrongDomain = await postHook(receiver, {
      body: mailBody({ domain: 'evil.example', id: 'evt_aaaaaaaabbbbccccddddeeeeffff0001' }),
    });
    expect(wrongDomain.status).toBe(503);
    expect(wrongDomain.json.disposition).toBe('rejected');
    expect(wrongDomain.json.reason).toBe('domain_mismatch');
    expect(bucket).toHaveLength(0);
  });

  test('malicious subject and identifiers never reach argv', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const posted = await postHook(receiver, {
      body: mailBody({
        data: {
          address: 'alice@openagent.email',
          messageId: '123; rm -rf /; $(reboot) `id` https://evil.example',
          subject: 'Click https://evil.example now',
          from: { address: 'root@evil.example' },
        },
      }),
    });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
    const joined = bucket[0]!.argv.join('\0');
    expect(joined).not.toContain('evil.example');
    expect(joined).not.toContain('rm -rf');
    expect(joined).not.toContain('$(reboot)');
    expect(bucket[0]!.text).toContain('Event evt_11111111-2222-3333-4444-555555555555');
    expect(bucket[0]!.text).not.toContain('Message 123;');
  });

  test('unsupported events are ignored without terminal effects', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: approvalBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('ignored');
    expect(bucket).toHaveLength(0);
  });

  test('stale mapping stays visible on /ready and does not wake', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(
      testConfig({
        mode: 'canary',
        routes: [testRoute({ stale: true })],
      }),
      { wake: recordingWake(bucket) },
    );
    receivers.push(receiver);
    const ready = await fetch(`${receiver.url()}/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { mappings: Array<{ stale: boolean }>; warnings: string[] };
    expect(body.mappings[0]?.stale).toBe(true);
    expect(body.warnings.some((w) => w.includes('stale'))).toBe(true);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(bucket).toHaveLength(0);
  });
});
