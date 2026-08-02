process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { describe, expect, test } = await import('bun:test');
const { processWatchedMessage, unseenWatcherUids } = await import('../src/lib/notification-watcher.ts');

const identities = [
  { address: 'target@test.example', createdAt: '2026-08-02T00:00:00.000Z' },
  { address: 'sender@test.example', createdAt: '2026-08-02T00:00:00.000Z' },
];

function message(from: string, source: string) {
  return {
    envelope: {
      from: [{ address: from }],
      to: [{ address: 'target@test.example' }],
    },
    headers: Buffer.from('Delivered-To: target@test.example\r\n'),
    source: Buffer.from(source),
  } as any;
}

async function dispatches(input: any, policy: 'otp' | 'all' | 'none') {
  const calls: any[] = [];
  await processWatchedMessage(input, identities, policy, {
    publish: async (payload) => {
      calls.push(payload);
      return { target: payload.target, title: payload.title, level: payload.level };
    },
  });
  return calls;
}

describe('mail-arrival notification watcher', () => {
  test('keeps its watermark across reconnects and catches the downtime window', () => {
    const watermark: { uid?: number } = {};
    expect(unseenWatcherUids([10, 11], watermark)).toEqual([]);
    expect(watermark.uid).toBe(11);

    // Connection one drops; uid 12 arrives before connection two completes.
    expect(unseenWatcherUids([10, 11, 12], watermark)).toEqual([12]);
  });

  test('external OTP mail alerts the user but can never wake an agent', async () => {
    const subject = 'private subject from outside';
    const calls = await dispatches(
      message('stranger@example.net', `From: stranger@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 482731`),
      'otp',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('user');
    expect(calls[0].message).toBe('target@test.example received new email (contains OTP or verification link)');
    expect(JSON.stringify(calls[0])).not.toContain(subject);
    expect(JSON.stringify(calls[0])).not.toContain('stranger@example.net');
  });

  test('a forged local From header still cannot wake the target agent', async () => {
    const calls = await dispatches(
      message('sender@test.example', 'From: sender@test.example\r\n\r\nYour verification code is 482731'),
      'otp',
    );

    // The envelope From is attacker-controlled input. Agent wake-ups come
    // only from the authenticated API send path, never from this watcher.
    expect(calls.map((call) => call.target)).toEqual(['user']);
  });

  test('otp policy is quiet for ordinary mail, all is not, and none is always quiet', async () => {
    const ordinary = message('stranger@example.net', 'From: stranger@example.net\r\n\r\nHello there');
    expect(await dispatches(ordinary, 'otp')).toEqual([]);
    expect((await dispatches(ordinary, 'all')).map((call) => call.target)).toEqual(['user']);
    expect(await dispatches(ordinary, 'none')).toEqual([]);
  });
});
