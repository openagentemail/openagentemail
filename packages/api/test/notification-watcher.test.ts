process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { describe, expect, test } = await import('bun:test');
const {
  boundPushMessage,
  buildMailArrivalMessage,
  processWatchedMessage,
  unseenWatcherUids,
  PUSH_BODY_PREVIEW_CHARS,
  PUSH_MESSAGE_MAX_BYTES,
  PUSH_META_FIELD_MAX_BYTES,
  PUSH_OTP_ENTRY_CHARS,
  PUSH_OTP_ITEM_MAX,
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

  test('tier 2 masks OTP codes that appear in the subject line', async () => {
    const subject = 'Your login code is 654321';
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
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).not.toContain('654321');
    expect(body).toContain('•••');
    expect(body).not.toContain('Preview:');
    expect(body).not.toContain('Codes:');
  });

  test('tier 3 still exposes Codes when the subject also contains the OTP', async () => {
    const subject = 'Your login code is 654321';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 654321`,
        subject,
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
    expect(body).toContain('Subject: Your login code is 654321');
    expect(body).toContain('Codes: 654321');
  });

  test('tier 2 masks a code that appears only in the subject (policy=all, plain body)', async () => {
    // Body has no OTP — extras.codes is empty; needles must come from meta extractOtp.
    const subject = 'Your login code is 654321';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nHello there, nothing sensitive.`,
        subject,
      ),
      'all',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 2,
      }],
    );

    expect(calls).toHaveLength(1);
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).not.toContain('654321');
    expect(body).toContain('•••');
    expect(body).not.toContain('Codes:');
  });

  test('tier 2 masks a subject-only code when body only has a verification link', async () => {
    // otp policy fires because of the link; the code lives only in the subject.
    const subject = 'Your login code is 654321';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nVisit https://example.com/verify?token=abc to continue.`,
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
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).not.toContain('654321');
    expect(body).toContain('•••');
    // Link may also appear in subject only if it was there; body link is not in Subject.
    expect(body).not.toContain('Codes:');
  });

  test('tier 2 masks subject URLs whose original spelling differs from validatedHttpUrl form', async () => {
    // extractOtp returns https://example.com/verify?token=secret (lower host, no :443);
    // the subject keeps EXAMPLE.com:443 — exact string replace would miss it.
    const subject = 'Confirm at https://EXAMPLE.com:443/verify?token=secret';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nHello there, nothing sensitive.`,
        subject,
      ),
      'all',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 2,
      }],
    );

    expect(calls).toHaveLength(1);
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).toContain('•••');
    expect(body).not.toContain('EXAMPLE.com');
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
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

  test('tier 3 caps codes/links count, entry length, and total body size', async () => {
    const longCode = '9'.repeat(PUSH_OTP_ENTRY_CHARS + 80);
    const longLink = `https://example.com/verify?token=${'a'.repeat(PUSH_OTP_ENTRY_CHARS + 80)}`;
    // Many keyword-adjacent codes so extractOtp returns a long list.
    const codeLines = Array.from({ length: 20 }, (_, i) => {
      const digits = String(100000 + i);
      return `Your verification code is ${digits}`;
    }).join('\n');
    const linkLines = Array.from({ length: 20 }, (_, i) =>
      `https://example.com/verify-login-${i}?token=${'z'.repeat(50)}`,
    ).join('\n');
    const calls = await dispatches(
      message(
        'flood@example.net',
        `From: flood@example.net\r\nSubject: Flood\r\n\r\n${codeLines}\n${linkLines}\ncode ${longCode}\n${longLink}`,
        'Flood',
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
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    // At most PUSH_OTP_ITEM_MAX codes appear after "Codes: ".
    const codesLine = body.split('\n').find((line) => line.startsWith('Codes: '));
    if (codesLine) {
      const listed = codesLine.slice('Codes: '.length).split(', ');
      expect(listed.length).toBeLessThanOrEqual(PUSH_OTP_ITEM_MAX);
      for (const entry of listed) {
        // Truncated entries end with …; raw length never exceeds cap+ellipsis.
        expect(entry.replace(/…$/, '').length).toBeLessThanOrEqual(PUSH_OTP_ENTRY_CHARS);
      }
    }
    const linkSection = body.includes('Links:\n') ? body.split('Links:\n')[1]! : '';
    const linkEntries = linkSection.split('\n').filter(Boolean);
    expect(linkEntries.length).toBeLessThanOrEqual(PUSH_OTP_ITEM_MAX);

    // Direct builder path with deliberately huge inputs.
    const huge = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: 'S'.repeat(500),
      from: 'f'.repeat(500),
      preview: 'p'.repeat(PUSH_BODY_PREVIEW_CHARS),
      codes: Array.from({ length: 40 }, (_, i) => `${'1'.repeat(300)}${i}`),
      links: Array.from({ length: 40 }, (_, i) => `https://example.com/${'x'.repeat(300)}/${i}`),
    });
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    expect(
      huge.endsWith('…') || Buffer.byteLength(huge, 'utf8') < PUSH_MESSAGE_MAX_BYTES,
    ).toBe(true);
  });

  test('boundPushMessage caps UTF-8 bytes and truncates on a code-point boundary', () => {
    // ~2000 CJK (3 bytes each) + emoji (4 bytes) far exceed 3500 bytes while
    // looking "short" under String.length.
    const multiByte = `${'验证码通知'.repeat(400)}${'😀'.repeat(50)}`;
    expect(multiByte.length).toBeLessThan(PUSH_MESSAGE_MAX_BYTES);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(PUSH_MESSAGE_MAX_BYTES);

    const capped = boundPushMessage(multiByte);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped).not.toContain('\uFFFD');
    // No dangling high/low surrogates after truncation.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(capped)).toBe(
      false,
    );

    // Walked body must re-encode cleanly (round-trip through UTF-8).
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
  });

  test('tier 3 keeps Codes/Links when subject would otherwise exhaust the byte budget', () => {
    // ~4000 UTF-8 bytes of CJK subject (each char 3 bytes) without field caps
    // would starve Preview/Codes/Links under the shared body limit.
    const hugeSubject = '验'.repeat(1400);
    expect(Buffer.byteLength(hugeSubject, 'utf8')).toBeGreaterThan(4000);

    const body = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: hugeSubject,
      from: 'sender@example.com',
      preview: 'Your verification code is 112233',
      codes: ['112233'],
      links: ['https://example.com/verify?token=abc'],
    });

    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    expect(body).toContain('Codes: 112233');
    expect(body).toContain('https://example.com/verify?token=abc');
    expect(body).toContain('Subject:');
    const subjectLine = body.split('\n').find((line) => line.startsWith('Subject: '))!;
    expect(subjectLine.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(subjectLine.slice('Subject: '.length), 'utf8')).toBeLessThanOrEqual(
      PUSH_META_FIELD_MAX_BYTES,
    );
  });
});
