process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { describe, expect, test } = await import('bun:test');
const {
  buildMailArrivalMessage,
  processWatchedMessage,
  unseenWatcherUids,
  PUSH_BODY_PREVIEW_CHARS,
} = await import('../src/lib/notification-watcher.ts');

const baseIdentities = [
  { address: 'target@test.example', createdAt: '2026-08-02T00:00:00.000Z' },
  { address: 'sender@test.example', createdAt: '2026-08-02T00:00:00.000Z' },
];

function message(from: string, source: string, subject = '') {
  return {
    envelope: {
      from: [{ name: from.includes('@') ? from.split('@')[0] : from, address: from }],
      to: [{ address: 'target@test.example' }],
      subject,
    },
    headers: Buffer.from('Delivered-To: target@test.example\r\n'),
    source: Buffer.from(source),
  } as any;
}

async function dispatches(
  input: any,
  policy: 'otp' | 'all' | 'none',
  identities = baseIdentities,
  options: { clickUrl?: string } = {},
) {
  const calls: any[] = [];
  await processWatchedMessage(
    input,
    identities,
    policy,
    {
      publish: async (payload) => {
        calls.push(payload);
        return { target: payload.target, title: payload.title, level: payload.level };
      },
    },
    options,
  );
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
      message(
        'stranger@example.net',
        `From: stranger@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 482731`,
        subject,
      ),
      'otp',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('user');
    expect(calls[0].message).toBe('target@test.example received new email (contains OTP or verification link)');
    expect(calls[0].level).toBe('urgent');
    // Tier 1 (default): no subject, sender, or code content in the payload.
    expect(JSON.stringify(calls[0])).not.toContain(subject);
    expect(JSON.stringify(calls[0])).not.toContain('stranger@example.net');
    expect(JSON.stringify(calls[0])).not.toContain('482731');
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

  test('default push content tier is interrupt-only when unset', async () => {
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Secret\r\n\r\nYour verification code is 111222',
        'Secret',
      ),
      'otp',
      [{ address: 'target@test.example', createdAt: '2026-08-02T00:00:00.000Z' }],
    );
    expect(calls[0].message).toBe(
      'target@test.example received new email (contains OTP or verification link)',
    );
    expect(calls[0].message).not.toContain('Subject:');
    expect(calls[0].message).not.toContain('111222');
  });

  test('tier 2 adds subject and sender, still omits body and OTP', async () => {
    const subject = 'Login code';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: Auth <auth@example.net>\r\nSubject: ${subject}\r\n\r\nYour verification code is 654321`,
        subject,
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 2,
      }],
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('target@test.example received new email (contains OTP or verification link)');
    expect(calls[0].message).toContain('From:');
    expect(calls[0].message).toContain('auth@example.net');
    expect(calls[0].message).toContain(`Subject: ${subject}`);
    expect(calls[0].message).not.toContain('654321');
    expect(calls[0].message).not.toContain('Preview:');
    expect(calls[0].level).toBe('urgent');
  });

  test('tier 3 adds bounded preview plus OTP codes and links', async () => {
    const longBody = `Your verification code is 998877. Visit https://example.com/verify?token=abc to continue. ${'x'.repeat(400)}`;
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: Verify\r\n\r\n${longBody}`,
        'Verify',
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
    );

    expect(calls).toHaveLength(1);
    const body = calls[0].message as string;
    expect(body).toContain('Subject: Verify');
    expect(body).toContain('From:');
    expect(body).toContain('Preview:');
    expect(body).toContain('Codes: 998877');
    expect(body).toContain('https://example.com/verify?token=abc');
    const previewLine = body.split('\n').find((line) => line.startsWith('Preview: '))!;
    expect(previewLine.slice('Preview: '.length).length).toBeLessThanOrEqual(PUSH_BODY_PREVIEW_CHARS);
    expect(calls[0].level).toBe('urgent');
  });

  test('click field is present only when clickUrl is provided', async () => {
    const mail = message(
      'stranger@example.net',
      'From: stranger@example.net\r\n\r\nYour verification code is 482731',
    );
    const without = await dispatches(mail, 'otp');
    expect(without[0].click).toBeUndefined();

    const withClick = await dispatches(mail, 'otp', baseIdentities, {
      clickUrl: 'https://mail.example.com/ui',
    });
    expect(withClick[0].click).toBe('https://mail.example.com/ui');
  });

  test('buildMailArrivalMessage stays interrupt-only at tier 1', () => {
    expect(
      buildMailArrivalMessage('a@test.example', 1, false, {
        subject: 'Hi',
        from: 'b@example.com',
        preview: 'hello',
        codes: ['1234'],
        links: ['https://example.com'],
      }),
    ).toBe('a@test.example received new email');
  });
});
