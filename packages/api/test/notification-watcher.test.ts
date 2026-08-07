process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { describe, expect, test } = await import('bun:test');
const {
  boundPreviewChars,
  boundPushLinkEntries,
  boundPushMessage,
  buildAlnumMaskRe,
  buildMailArrivalMessage,
  extractMetaAlnumCodes,
  maskSensitiveFragments,
  maskTier2Metadata,
  packPushLinkLines,
  processWatchedMessage,
  unseenWatcherUids,
  PUSH_BODY_PREVIEW_CHARS,
  PUSH_MESSAGE_MAX_BYTES,
  PUSH_META_FIELD_MAX_BYTES,
  PUSH_OTP_ENTRY_CHARS,
  PUSH_OTP_ITEM_MAX,
} = await import('../src/lib/notification-watcher.ts');
const { NotifyError, jsonEscapedByteLength } = await import('../src/lib/notify.ts');

/** Mock publish that honors beforeSend like NtfyNotificationService. */
function publishWithBeforeSend(calls: any[]) {
  return async (payload: any) => {
    if (payload.beforeSend && !payload.beforeSend()) {
      throw new NotifyError('notify_cancelled');
    }
    calls.push(payload);
    return { target: payload.target, title: payload.title, level: payload.level };
  };
}

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
    // Watcher must truncate on ntfy budget overflow, never throw (F76 UID safety).
    expect(calls[0].overflow).toBe('truncate');
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

  test('tier 2 masks subject URLs with uppercase HTTPS scheme', async () => {
    // BARE_URL_RE must be case-insensitive or HTTPS:// never enters extract/mask.
    const subject = 'Verify HTTPS://EXAMPLE.com:443/verify?token=secret';
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
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('EXAMPLE.com');
    expect(body).not.toContain('example.com');
    expect(body.toLowerCase()).not.toContain('https://');
  });

  test('tier 2 masks subject URLs when LINK_INTENT is only adjacent text', async () => {
    // extractOtp requires intent in the URL itself; "Verify here:" is outside the URL.
    const subject = 'Verify here: https://x.example/t/secret';
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
    expect(body).not.toContain('x.example');
    expect(body).not.toContain('/t/secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks bracketed IPv6 host URLs in the subject', async () => {
    const subject = 'Verify https://[2001:db8::1]/confirm?token=secret';
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
    expect(body).not.toContain('2001:db8::1');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks a URL inside free brackets without swallowing the trailing ]', async () => {
    // Outer [ ... ] is prose; only the bare URL is redacted.
    const subject = 'Note [see https://example.com/verify?token=a]';
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
    expect(body).toContain('[');
    expect(body).toContain(']');
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('token=a');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks URLs that contain balanced parentheses before the query', async () => {
    // Without paired-() support the match stops at confirm(foo and leaves )?token=secret.
    const subject = 'Reset https://example.com/confirm(foo)?token=secret';
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
    expect(body).not.toContain('confirm(foo');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks a URL inside free parentheses without swallowing outer parens', async () => {
    const subject = 'Note (see https://example.com/verify?token=a)';
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
    expect(body).toContain('(');
    expect(body).toContain(')');
    expect(body).not.toContain('example.com');
    expect(body).not.toContain('token=a');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks nested-parenthesis URLs whole (no truncated tail leak)', async () => {
    const subject = 'Reset https://example.com/confirm(foo(bar))?token=secret';
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
    expect(body).not.toContain('confirm');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks Wikipedia-style paths with balanced underscores parens', async () => {
    const subject = 'See https://en.wikipedia.org/wiki/Foo_(bar)';
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
    expect(body).toContain('•••');
    expect(body).not.toContain('wikipedia.org');
    expect(body).not.toContain('Foo_');
    expect(body).not.toContain('https://');
  });

  test('tier 2 peels free trailing ). and .) without leaving the URL half-masked', async () => {
    for (const subject of [
      'See https://example.com/verify?token=a).',
      'See https://example.com/verify?token=a.)',
    ]) {
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
      expect(body).toContain('•••');
      expect(body).toContain(')');
      expect(body).not.toContain('example.com');
      expect(body).not.toContain('token=a');
      expect(body).not.toContain('https://');
    }
  });

  test('tier 2 masks a year-shaped PIN next to verification keywords (F62)', async () => {
    const subject = 'Your verification PIN is 2026';
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
    expect(body).not.toContain('2026');
  });

  test('tier 2 masks URLs that contain a legal apostrophe before the token', async () => {
    // BARE_URL_RE used to exclude '; match stopped at confirm? and leaked 'token=secret.
    const subject = "Reset https://example.com/confirm?'token=secret";
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
    expect(body).not.toContain('confirm');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks every link in an adjacent Markdown chain in the subject', async () => {
    const subject =
      '[Verify](https://a.example/verify)[Confirm](https://b.example/confirm)';
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
    expect(body).not.toContain('a.example');
    expect(body).not.toContain('b.example');
    expect(body).not.toContain('https://');
    // F54: chain glue (including label) is redacted with the URLs.
    expect(body).toContain('[Verify](•••••••••)');
    expect(body).not.toContain('Confirm');
  });

  test('tier 2 masks a full URL that contains an unbalanced ) mid-path', async () => {
    // WHATWG accepts confirm)foo; must not hard-cut and leak ?token=.
    const subject = 'Reset https://example.com/confirm)foo?token=secret';
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
    expect(body).toContain('•••');
    expect(body).not.toContain('confirm)foo');
    expect(body).not.toContain('token=secret');
    expect(body).not.toContain('https://');
  });

  test('tier 2 masks a subject code even when the body has many unrelated codes', () => {
    const bodyCodes = Array.from({ length: 100 }, (_, i) => String(100000 + i));
    const bodyText = bodyCodes.map((code) => `Your verification code is ${code}.`).join(' ');
    // Direct builder: extras.codes is huge, subject holds only 654321.
    const body = buildMailArrivalMessage('a@test.example', 2, true, {
      subject: 'Your login code is 654321',
      from: 'auth@example.com',
      preview: bodyText.slice(0, 280),
      codes: [...bodyCodes, '654321'],
      links: [],
    });
    expect(body).toContain('Subject:');
    expect(body).toContain('•••');
    expect(body).not.toContain('654321');
    // Unrelated body codes must not appear either (they are not in subject).
    expect(body).not.toContain('100000');
  });

  test('maskSensitiveFragments masks digit runs present in the code set only', () => {
    expect(maskSensitiveFragments('plain subject', [], [])).toBe('plain subject');
    expect(maskSensitiveFragments('code 112233 and 445566', ['112233', '445566'], [])).toBe(
      'code ••• and •••',
    );
    // Whole \b\d{4,8}\b run must be in the set — partial needles do not mask.
    expect(maskSensitiveFragments('code 11223399', ['1122', '112233'], [])).toBe('code 11223399');
    expect(maskSensitiveFragments('code 11223399', ['11223399'], [])).toBe('code •••');
    expect(maskSensitiveFragments('dup 1111 and 1111', ['1111', '1111'], [])).toBe(
      'dup ••• and •••',
    );
    // Full run's digit sequence must match the set — half-codes do not mask.
    expect(maskSensitiveFragments('Your verification code is 123-456', ['123-456'], [])).toBe(
      'Your verification code is •••',
    );
    expect(maskSensitiveFragments('code 123-456', ['123', '456'], [])).toBe('code 123-456');
    // F69: same OTP across continuous vs delimited spelling (digit-only match).
    expect(maskSensitiveFragments('code 123-456', ['123456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code 123 456', ['123456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code 123-789', ['123456'], [])).toBe('code 123-789');
    // Reverse cross-form + 8-digit continuous ↔ 4+4 delimited.
    expect(maskSensitiveFragments('code 123456', ['123-456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code 1234-5678', ['12345678'], [])).toBe('code •••');
  });

  test('maskTier2Metadata redacts delimited OTP in subject (F68)', () => {
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is 123-456',
      codes: ['123-456'],
      links: [],
      preview: '',
    });
    expect(masked.subject).toBe('Your verification code is •••');
    expect(masked.subject).not.toContain('123-456');
  });

  test('maskTier2Metadata masks subject delimited form from body continuous (F69)', () => {
    // Body extractCodes yields continuous; subject has separator and no keyword.
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: '123-456',
      codes: ['123456'],
      links: [],
      preview: '',
    });
    expect(masked.subject).toBe('•••');
    expect(masked.subject).not.toContain('123-456');
    expect(masked.subject).not.toContain('123456');
  });

  test('maskTier2Metadata masks subject continuous form from body delimited (F69)', () => {
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: '123456',
      codes: ['123-456'],
      links: [],
      preview: '',
    });
    expect(masked.subject).toBe('•••');
  });

  test('tier 2 masks delimited OTP in subject under policy=all (F68)', async () => {
    // Body also carries the delimited form so hasOtpOrLink is true (urgent path).
    const subject = 'Your verification code is 123-456';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 123-456`,
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
    expect(calls[0].level).toBe('urgent');
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).toContain('•••');
    expect(body).not.toContain('123-456');
    expect(body).toContain('(contains OTP or verification link)');
  });

  test('tier 2 masks subject delimited OTP from continuous body under otp policy (F69)', async () => {
    // Body continuous with keyword → extractCodes ['123456']; subject is bare
    // delimited with no cue (meta extractOtp empty). Canonical intersect must mask.
    const subject = '123-456';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 123456`,
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
    expect(calls[0].level).toBe('urgent');
    const body = calls[0].message as string;
    expect(body).toContain('Subject:');
    expect(body).toContain('•••');
    expect(body).not.toContain('123-456');
    expect(body).not.toContain('123456');
  });

  test('tier 2 masks subject delimited OTP from continuous body under policy=all (F69)', async () => {
    const subject = '123-456';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: ${subject}\r\n\r\nYour verification code is 123456`,
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
    expect(body).not.toContain('123-456');
    expect(body).not.toContain('123456');
  });

  test('maskSensitiveFragments masks NBSP-delimited OTP (F70)', () => {
    const nbsp = '\u00A0';
    const form = `123${nbsp}456`;
    // Same spelling in the code set.
    expect(maskSensitiveFragments(`code ${form}`, [form], [])).toBe('code •••');
    // F69 canonical cross-form: continuous needle masks Unicode-space run.
    expect(maskSensitiveFragments(`code ${form}`, ['123456'], [])).toBe('code •••');
  });

  test('maskTier2Metadata does not glue digits across from\\nsubject (F70)', () => {
    // metaText is from + '\\n' + subject; newlines must not act as OTP separators.
    // 4+4 across \\n would become one delimited form if \\n were a sep.
    const masked = maskTier2Metadata({
      from: 'user 1234',
      subject: '5678 提醒',
      codes: ['12345678'],
      links: [],
      preview: '',
    });
    expect(masked.subject).toBe('5678 提醒');
    expect(masked.from).toBe('user 1234');
  });

  test('maskTier2Metadata masks subject NBSP form from body continuous (F70×F69)', () => {
    const nbsp = '\u00A0';
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: `123${nbsp}456`,
      codes: ['123456'],
      links: [],
      preview: '',
    });
    expect(masked.subject).toBe('•••');
  });

  test('tier 2 masks NBSP-delimited OTP in subject under policy=all (F70)', async () => {
    const nbsp = '\u00A0';
    const subject = `Your verification code is 123${nbsp}456`;
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
    expect(body).not.toContain('123');
    expect(body).not.toContain(`${nbsp}456`);
  });

  test('maskSensitiveFragments masks multi-char sep form via canonical digits (F72)', () => {
    expect(maskSensitiveFragments('code 123 - 456', ['123456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code 123  456', ['123456'], [])).toBe('code •••');
  });

  test('tier 2 masks multi-char sep OTP in subject under policy=all (F72)', async () => {
    const subject = 'Your code is 123 - 456';
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
    expect(body).not.toContain('123 - 456');
    expect(body).not.toContain('123');
  });

  test('maskSensitiveFragments masks three-group OTP via canonical digits (F73)', () => {
    expect(maskSensitiveFragments('code 12 34 56', ['123456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code 12 34 99', ['123456'], [])).toBe('code 12 34 99');
  });

  test('tier 2 masks three-group OTP in subject under policy=all (F73)', async () => {
    const subject = 'Your code is 12 34 56';
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
    expect(body).not.toContain('12 34 56');
  });

  test('maskSensitiveFragments masks full four-group form only (F74)', () => {
    expect(maskSensitiveFragments('code 12 34 56 78', ['12345678'], [])).toBe('code •••');
    // Shorter canonical must not partial-mask a four-group run.
    expect(maskSensitiveFragments('code 12 34 56 78', ['123456'], [])).toBe('code 12 34 56 78');
    expect(maskSensitiveFragments('code 12 34 56 78', ['123456'], [])).not.toContain('•••');
    // Five+ groups are not a code run at all (including prefix-canon needles).
    expect(maskSensitiveFragments('code 12 34 56 78 90', ['1234567890'], [])).toBe(
      'code 12 34 56 78 90',
    );
    expect(maskSensitiveFragments('code 12 34 56 78 90', ['12345678'], [])).toBe(
      'code 12 34 56 78 90',
    );
    expect(maskSensitiveFragments('code 12 34 56 78 90', ['12345678'], [])).not.toContain('•••');
  });

  test('tier 2 masks four-group OTP in subject under policy=all (F74)', async () => {
    const subject = 'Your verification code is 12 34 56 78';
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
    expect(body).not.toContain('12 34 56 78');
    expect(body).not.toContain('12 34 56');
    expect(body).not.toContain('78');
  });

  test('maskSensitiveFragments masks Unicode digits via canonicalDigits (F75)', () => {
    expect(maskSensitiveFragments('验证码 １２３４５６', ['123456'], [])).toBe('验证码 •••');
    expect(maskSensitiveFragments('code ١٢٣٤٥٦', ['123456'], [])).toBe('code •••');
    expect(maskSensitiveFragments('code ۱۲۳۴۵۶', ['123456'], [])).toBe('code •••');
  });

  test('tier 2 masks fullwidth OTP in subject under policy=all (F75)', async () => {
    const subject = '您的验证码是 １２３４５６';
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
    expect(body).not.toContain('１２３４５６');
    expect(body).not.toContain('123456');
  });

  test('tier 2 masks alnum OTP in subject with strong cue only (F77/F81)', async () => {
    expect(extractMetaAlnumCodes('Your verification code is A1B2C3')).toEqual(['A1B2C3']);
    expect(extractMetaAlnumCodes('Order ABC12345 shipped')).toEqual([]);
    // F81: 4–5 char mixed alnum under strong cue; 3-char stays out.
    expect(extractMetaAlnumCodes('Your verification code is A1B2')).toEqual(['A1B2']);
    expect(extractMetaAlnumCodes('Your verification code is AB12')).toEqual(['AB12']);
    expect(extractMetaAlnumCodes('Your verification code is A1B')).toEqual([]);
    expect(extractMetaAlnumCodes('Order AB12 shipped')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1B2C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1B2',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is AB12',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    expect(maskTier2Metadata({
      from: 'shop@example.net',
      subject: 'Order ABC12345 shipped',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Order ABC12345 shipped');
    expect(maskTier2Metadata({
      from: 'shop@example.net',
      subject: 'Order AB12 shipped',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Order AB12 shipped');
    // CJK strong cue glued to alnum (bounds exclude CJK; fullwidth Latin is in-class).
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的校验码是A1B2C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('您的校验码是•••');

    const subject = 'Your verification code is A1B2C3';
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
    expect(body).toContain('•••');
    expect(body).not.toContain('A1B2C3');
  });

  test('tier 2 masks delimited alnum OTP with strong cue (F84)', () => {
    expect(extractMetaAlnumCodes('Your verification code is ABC-123')).toEqual(['ABC-123']);
    expect(extractMetaAlnumCodes('您的校验码是A1B-2C3')).toEqual(['A1B-2C3']);
    expect(extractMetaAlnumCodes('Your code is A1-B2-C3')).toEqual(['A1-B2-C3']);
    expect(extractMetaAlnumCodes('Ref ABC-123 attached')).toEqual([]);
    // 5+ groups rejected whole (no prefix half).
    expect(extractMetaAlnumCodes('Your code is AB-12-CD-34-EF')).toEqual([]);
    // Short English glue / year-ish space forms must not extract.
    expect(extractMetaAlnumCodes('Your code is to A1B2')).toEqual(['A1B2']); // continuous only
    expect(extractMetaAlnumCodes('Your code is to A1B2')).not.toContain('to A1B2');
    expect(extractMetaAlnumCodes('Your verification code expires Mar 2026')).toEqual([]);
    // Separator variants.
    expect(extractMetaAlnumCodes('Your code is ABC.123')).toEqual(['ABC.123']);
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toEqual(['ABC 123']);
    expect(extractMetaAlnumCodes('Your code is ABC\uFF0D123')).toEqual(['ABC\uFF0D123']);

    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is ABC-123',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的校验码是A1B-2C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('您的校验码是•••');
    expect(maskTier2Metadata({
      from: 'shop@example.net',
      subject: 'Ref ABC-123 attached',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Ref ABC-123 attached');
    // Pure digit delimited still masks via digit path (not alnum channel).
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is 123-456',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    expect(extractMetaAlnumCodes('Your verification code is 123-456')).toEqual([]);
  });

  test('mixed space+punctuation alnum seps mask under strong cue (F87)', () => {
    expect(extractMetaAlnumCodes('Your verification code is ABC - 123')).toEqual(['ABC - 123']);
    expect(extractMetaAlnumCodes('Your code is A1 - B2 - C3')).toEqual(['A1 - B2 - C3']);
    expect(extractMetaAlnumCodes('Your code is ABC--123')).toEqual(['ABC--123']);
    expect(extractMetaAlnumCodes('Your code is ABC－ 123')).toEqual(['ABC－ 123']);
    expect(extractMetaAlnumCodes('Ref ABC - 123 attached')).toEqual([]);
    expect(extractMetaAlnumCodes('Your code is word - another')).toEqual([]);
    expect(extractMetaAlnumCodes('Your verification code is Mar - 2026')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is ABC - 123',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    // Prior tight/space paths still work.
    expect(extractMetaAlnumCodes('Your code is ABC-123')).toEqual(['ABC-123']);
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toEqual(['ABC 123']);
  });

  test('tier 2 masks fullwidth alnum OTP under strong cue (F86)', () => {
    // Fullwidth mixed continuous.
    expect(extractMetaAlnumCodes('您的验证码是 Ａ１Ｂ２Ｃ３')).toEqual(['Ａ１Ｂ２Ｃ３']);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的验证码是 Ａ１Ｂ２Ｃ３',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('您的验证码是 •••');
    // Half/fullwidth mixed run (same char class).
    expect(extractMetaAlnumCodes('您的验证码是 A1Ｂ2Ｃ3')).toEqual(['A1Ｂ2Ｃ3']);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的验证码是 A1Ｂ2Ｃ3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('您的验证码是 •••');
    // English cue + fullwidth.
    expect(extractMetaAlnumCodes('Your verification code is ＡＢＣ１２３')).toEqual(['ＡＢＣ１２３']);
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your verification code is ＡＢＣ１２３',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    // No strong cue.
    expect(extractMetaAlnumCodes('编号 Ａ１Ｂ２Ｃ３ 见附')).toEqual([]);
    // Pure fullwidth digits stay on digit path (not alnum extract).
    expect(extractMetaAlnumCodes('您的验证码是 １２３４５６')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: '您的验证码是 １２３４５６',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('您的验证码是 •••');
    // CJK red line: no alnum extract from pure Chinese.
    expect(extractMetaAlnumCodes('验证码是您发的')).toEqual([]);
    // Exact original spelling: fullwidth extract does not mask halfwidth form.
    expect(maskSensitiveFragments('code A1B2C3', ['Ａ１Ｂ２Ｃ３'], [])).toBe('code A1B2C3');
    expect(maskSensitiveFragments('code Ａ１Ｂ２Ｃ３', ['Ａ１Ｂ２Ｃ３'], [])).toBe('code •••');
  });

  test('space-separated alnum runs mask whole chain not halves (F85)', () => {
    // Bug repro: 3-group must not leave leading A1 unmasked as B2 C3 only.
    expect(extractMetaAlnumCodes('Your verification code is A1 B2 C3')).toEqual(['A1 B2 C3']);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1 B2 C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your verification code is •••');
    const three = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1 B2 C3',
      codes: [],
      links: [],
      preview: '',
    }).subject;
    expect(three).not.toContain('A1');
    expect(three).not.toContain('B2');
    expect(three).not.toContain('C3');

    // 4 groups, every group has a digit.
    expect(extractMetaAlnumCodes('Your code is A1 B2 C3 D4')).toEqual(['A1 B2 C3 D4']);
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is A1 B2 C3 D4',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your code is •••');

    // No digits → reject whole run (no mid-chain letter-only halves).
    expect(extractMetaAlnumCodes('Your code is AB CD EF GH')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is AB CD EF GH',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your code is AB CD EF GH');

    // 5+ groups rejected whole.
    expect(extractMetaAlnumCodes('Your code is A1 B2 C3 D4 E5')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is A1 B2 C3 D4 E5',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Your code is A1 B2 C3 D4 E5');

    // 2-group regressions.
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toEqual(['ABC 123']);
    expect(extractMetaAlnumCodes('Your code is to A1B2')).not.toContain('to A1B2');
    expect(extractMetaAlnumCodes('Your verification code expires Mar 2026')).toEqual([]);
  });

  test('alnum mask uses one alternation regex (F83)', () => {
    const forms = ['A1B2C3', 'XY99ZZ', 'Ab12'];
    const re = buildAlnumMaskRe(forms);
    expect(re).not.toBeNull();
    // Single pattern with all three forms (longest-first).
    expect(re!.source).toContain('A1B2C3');
    expect(re!.source).toContain('XY99ZZ');
    expect(re!.source).toContain('Ab12');
    expect(re!.source.indexOf('A1B2C3')).toBeLessThan(re!.source.indexOf('Ab12'));
    // Exactly one alnum alternation replace (not one pass per token).
    const text = 'code A1B2C3 and XY99ZZ and Ab12 again A1B2C3';
    let alnumReplaceCalls = 0;
    const originalReplace = String.prototype.replace;
    String.prototype.replace = function (
      this: string,
      searchValue: string | RegExp,
      ...rest: unknown[]
    ) {
      if (
        searchValue instanceof RegExp &&
        searchValue.source.includes('(?:') &&
        searchValue.source.includes('A1B2C3') &&
        searchValue.source.includes('XY99ZZ')
      ) {
        alnumReplaceCalls += 1;
      }
      return (originalReplace as (s: string | RegExp, ...r: unknown[]) => string).apply(
        this,
        [searchValue, ...rest],
      );
    };
    let masked: string;
    try {
      masked = maskSensitiveFragments(text, forms, []);
    } finally {
      String.prototype.replace = originalReplace;
    }
    expect(alnumReplaceCalls).toBe(1);
    expect(masked).toBe('code ••• and ••• and ••• again •••');
    // Case-sensitive exact spelling (AB12 ≠ Ab12).
    expect(maskSensitiveFragments('code AB12', ['Ab12'], [])).toBe('code AB12');
    expect(maskSensitiveFragments('code Ab12', ['Ab12'], [])).toBe('code •••');
    expect(buildAlnumMaskRe([])).toBeNull();
  });

  test('preview truncates on code-point boundaries (F82)', () => {
    const emoji = '😀'; // one code point, two UTF-16 units
    expect(emoji.length).toBe(2);
    // 279 ASCII + emoji → maxChars=280 keeps the full emoji (no lone surrogate).
    const text = `${'a'.repeat(279)}${emoji}${'b'.repeat(10)}`;
    const preview = boundPreviewChars(text, PUSH_BODY_PREVIEW_CHARS);
    expect([...preview].length).toBe(PUSH_BODY_PREVIEW_CHARS);
    expect(preview.endsWith(emoji)).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // Short text unchanged.
    expect(boundPreviewChars('hi', PUSH_BODY_PREVIEW_CHARS)).toBe('hi');
    // Cap mid-string still code-point safe when cut falls before emoji.
    const cutBefore = boundPreviewChars(`${'a'.repeat(280)}${emoji}`, PUSH_BODY_PREVIEW_CHARS);
    expect(cutBefore).toBe('a'.repeat(280));
    expect(cutBefore).not.toContain(emoji);
  });

  test('tier-2 build stays linear when body codes vastly outnumber meta digits', () => {
    const bodyCodes = Array.from({ length: 50_000 }, (_, i) => {
      // 6-digit distinct codes that do not appear in the short subject.
      return String(200000 + (i % 800_000)).padStart(6, '0');
    });
    // Folded-looking subject with many digit runs that are not the body codes.
    const subjectDigits = Array.from({ length: 2_000 }, (_, i) => String(900000 + (i % 1000)).padStart(6, '0'));
    const subject = `codes ${subjectDigits.join(' ')} and secret 654321`;
    const started = performance.now();
    const body = buildMailArrivalMessage('a@test.example', 2, true, {
      subject,
      from: 'auth@example.com',
      preview: 'x'.repeat(280),
      codes: bodyCodes,
      links: [],
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(body).toContain('•••');
    expect(body).not.toContain('654321');
  });

  test('tier-2 build stays linear on a large subject full of keyword-adjacent codes', () => {
    // 8000 distinct meta codes (~96KB folded subject) must not build a huge alternation.
    const metaCodes = Array.from({ length: 8_000 }, (_, i) => String(100000 + i));
    const subject = metaCodes.map((code) => `code ${code}`).join(' ');
    expect(subject.length).toBeGreaterThan(80_000);
    const started = performance.now();
    const body = buildMailArrivalMessage('a@test.example', 2, true, {
      subject,
      from: 'auth@example.com',
      preview: 'x'.repeat(280),
      codes: ['654321'],
      links: [],
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(body).toContain('•••');
    // Every 6-digit meta code should be masked; non-code digits would stay.
    expect(body).not.toContain('100000');
    expect(body).not.toContain('107999');
  });

  test('refreshIdentity is consulted after parsing so a tier downgrade is applied', async () => {
    let reads = 0;
    const snapshot = {
      address: 'target@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 3 as const,
    };
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\nVisit https://example.com/verify?token=abc\r\n',
        'Verify',
      ),
      [snapshot],
      'otp',
      {
        publish: async (payload) => {
          calls.push(payload);
          return { target: payload.target, title: payload.title, level: payload.level };
        },
      },
      {
        refreshIdentity: () => {
          reads += 1;
          // First read after parse: still elevated; second path unused for one identity.
          // Simulate admin downgrade completed during simpleParser await.
          return {
            address: 'target@test.example',
            createdAt: '2026-08-02T00:00:00.000Z',
            pushContentTier: 2 as const,
          };
        },
      },
    );
    expect(reads).toBe(1);
    expect(calls).toHaveLength(1);
    const body = calls[0].message as string;
    // Tier 2: subject/from only, no preview/codes/links content.
    expect(body).toContain('Subject:');
    expect(body).not.toContain('Preview:');
    expect(body).not.toContain('Codes:');
    expect(body).not.toContain('Links:');
    expect(body).not.toContain('482731');
    expect(body).not.toContain('https://example.com/verify');
  });

  test('without refreshIdentity the snapshot tier is used unchanged', async () => {
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
      'otp',
      {
        publish: async (payload) => {
          calls.push(payload);
          return { target: payload.target, title: payload.title, level: payload.level };
        },
      },
    );
    expect(calls[0].message).toContain('Codes: 482731');
  });

  test('refreshIdentity undefined skips deleted recipient (F46)', async () => {
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
      'otp',
      {
        publish: async (payload) => {
          calls.push(payload);
          return { target: payload.target, title: payload.title, level: payload.level };
        },
      },
      {
        refreshIdentity: () => undefined,
      },
    );
    expect(calls).toHaveLength(0);
  });

  test('refreshIdentity skip is per-recipient; live sibling still publishes', async () => {
    const alive = {
      address: 'alive@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 2 as const,
    };
    const deleted = {
      address: 'deleted@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 3 as const,
    };
    const calls: any[] = [];
    await processWatchedMessage(
      {
        envelope: {
          from: [{ name: 'auth', address: 'auth@example.net' }],
          to: [{ address: alive.address }, { address: deleted.address }],
          subject: 'Verify',
        },
        headers: Buffer.from(
          `Delivered-To: ${alive.address}\r\nDelivered-To: ${deleted.address}\r\n`,
        ),
        source: Buffer.from(
          'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        ),
      } as any,
      [alive, deleted],
      'otp',
      { publish: publishWithBeforeSend(calls) },
      {
        // First recipient still live; second deleted mid-flight (after prior publish).
        refreshIdentity: (address) => (address === alive.address ? alive : undefined),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('Subject:');
    expect(calls[0].message).not.toContain('Codes:');
  });

  test('beforeSend downgrade rebuilds at lower tier and sends (F49)', async () => {
    const address = 'target@test.example';
    let reads = 0;
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{ address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 }],
      'otp',
      { publish: publishWithBeforeSend(calls) },
      {
        // build: tier3 → beforeSend: tier1 (cancel) → retry build/beforeSend: tier1 (send)
        refreshIdentity: () => {
          reads += 1;
          if (reads === 1) {
            return { address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 as const };
          }
          return { address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 1 as const };
        },
      },
    );
    // 1 build + 1 beforeSend + 1 rebuild + 1 beforeSend = 4 reads
    expect(reads).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).not.toContain('Codes:');
    expect(calls[0].message).not.toContain('Subject:');
  });

  test('beforeSend gives up after three cancelled attempts when tier keeps dropping', async () => {
    const address = 'target@test.example';
    let publishAttempts = 0;
    let reads = 0;
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{ address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 }],
      'otp',
      {
        publish: async () => {
          publishAttempts += 1;
          // Always cancel (skip beforeSend) so retry path is exercised by re-read tier drops.
          throw new NotifyError('notify_cancelled');
        },
      },
      {
        refreshIdentity: () => {
          reads += 1;
          // init build3 → cancel → re-read2 → build2 → cancel → re-read1 → build1 → cancel → re-read1 stop
          const tier = reads === 1 ? 3 : reads === 2 ? 2 : 1;
          return {
            address,
            createdAt: '2026-08-02T00:00:00.000Z',
            pushContentTier: tier as 1 | 2 | 3,
          };
        },
      },
    );
    expect(publishAttempts).toBe(3);
    expect(calls).toHaveLength(0);
  });

  test('tier-2 metadata mask is shared across recipients (F50)', async () => {
    const a = {
      address: 'a@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 2 as const,
    };
    const b = {
      address: 'b@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 2 as const,
    };
    const calls: any[] = [];
    await processWatchedMessage(
      {
        envelope: {
          from: [{ name: 'auth', address: 'auth@example.net' }],
          to: [{ address: a.address }, { address: b.address }],
          subject: 'Code 482731',
        },
        headers: Buffer.from(
          `Delivered-To: ${a.address}\r\nDelivered-To: ${b.address}\r\n`,
        ),
        source: Buffer.from(
          'From: auth@example.net\r\nSubject: Code 482731\r\n\r\nYour verification code is 482731\r\n',
        ),
      } as any,
      [a, b],
      'otp',
      { publish: publishWithBeforeSend(calls) },
    );
    expect(calls).toHaveLength(2);
    const stripAddr = (body: string) => body.replace(/^.*received new email[^\n]*/m, 'ADDR');
    expect(stripAddr(calls[0].message)).toBe(stripAddr(calls[1].message));
    expect(calls[0].message).toContain('•••');
  });

  test('many tier-2 recipients with large subject stay under 1s (F50)', async () => {
    const subject = `code 482731 ${'x'.repeat(500_000)}`;
    const recipients = Array.from({ length: 50 }, (_, i) => ({
      address: `r${i}@test.example`,
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 2 as const,
    }));
    const calls: any[] = [];
    const started = performance.now();
    await processWatchedMessage(
      {
        envelope: {
          from: [{ name: 'auth', address: 'auth@example.net' }],
          to: recipients.map((r) => ({ address: r.address })),
          subject,
        },
        headers: Buffer.from(
          recipients.map((r) => `Delivered-To: ${r.address}`).join('\r\n') + '\r\n',
        ),
        source: Buffer.from(
          `From: auth@example.net\r\nSubject: ${subject.slice(0, 200)}\r\n\r\nYour verification code is 482731\r\n`,
        ),
      } as any,
      recipients,
      'otp',
      { publish: publishWithBeforeSend(calls) },
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(50);
  });

  test('beforeSend keeps lower-tier body when tier is upgraded mid-flight', async () => {
    const address = 'target@test.example';
    let reads = 0;
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{ address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 1 }],
      'otp',
      { publish: publishWithBeforeSend(calls) },
      {
        refreshIdentity: () => {
          reads += 1;
          if (reads === 1) {
            return { address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 1 as const };
          }
          return { address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 as const };
        },
      },
    );
    expect(reads).toBe(2);
    expect(calls).toHaveLength(1);
    // Already-built tier-1 body is still safe under a higher floor.
    expect(calls[0].message).not.toContain('Codes:');
    expect(calls[0].message).not.toContain('Subject:');
  });

  test('beforeSend aborts when identity is deleted after build', async () => {
    const address = 'target@test.example';
    let reads = 0;
    const calls: any[] = [];
    await processWatchedMessage(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Verify\r\n\r\nYour verification code is 482731\r\n',
        'Verify',
      ),
      [{ address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 }],
      'otp',
      { publish: publishWithBeforeSend(calls) },
      {
        refreshIdentity: () => {
          reads += 1;
          if (reads === 1) {
            return { address, createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 3 as const };
          }
          return undefined;
        },
      },
    );
    // build read + beforeSend delete + catch re-read delete
    expect(reads).toBe(3);
    expect(calls).toHaveLength(0);
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
        // Truncated code entries end with …; raw length never exceeds cap+ellipsis.
        expect(entry.replace(/…$/, '').length).toBeLessThanOrEqual(PUSH_OTP_ENTRY_CHARS);
      }
    }
    const linkSection = body.includes('Links:\n') ? body.split('Links:\n')[1]! : '';
    const linkEntries = linkSection
      .split('\n')
      .filter((line) => line && !line.startsWith('(+'));
    expect(linkEntries.length).toBeLessThanOrEqual(PUSH_OTP_ITEM_MAX);
    // Links are never mid-truncated with … (F79); long verify links stay whole.
    for (const entry of linkEntries) {
      expect(entry.endsWith('…')).toBe(false);
    }
    if (body.includes(longLink.slice(0, 40))) {
      expect(body).toContain(longLink);
    }

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
      huge.endsWith('…') || Buffer.byteLength(huge, 'utf8') < PUSH_MESSAGE_MAX_BYTES || huge.includes('more links'),
    ).toBe(true);
  });

  test('tier 3 keeps full verification links over 200 chars (F79)', () => {
    const longLink = `https://example.com/verify?token=${'a'.repeat(PUSH_OTP_ENTRY_CHARS + 80)}&sig=${'b'.repeat(40)}`;
    expect(longLink.length).toBeGreaterThan(PUSH_OTP_ENTRY_CHARS);
    expect(boundPushLinkEntries([longLink])).toEqual([longLink]);

    const body = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: 'Verify',
      from: 'auth@example.com',
      preview: 'hi',
      codes: [],
      links: [longLink],
    });
    expect(body).toContain(longLink);
    expect(body).not.toContain(`${longLink.slice(0, PUSH_OTP_ENTRY_CHARS)}…`);
  });

  test('JSON-escape packing keeps long signed links whole (F88)', async () => {
    // Backslash-heavy subject expands under JSON.stringify; link must stay complete.
    const longLink = `https://example.com/verify?token=${'a'.repeat(2800)}&sig=${'b'.repeat(80)}`;
    const slashSubject = `${'\\'.repeat(400)}verify`;
    const body = buildMailArrivalMessage(
      'a@test.example',
      3,
      true,
      {
        subject: slashSubject,
        from: 'auth@example.com',
        preview: 'x'.repeat(500),
        codes: [],
        links: [longLink],
      },
      undefined,
      { clickUrl: 'https://dash.example/ui' },
    );
    // Full link present or honest omit — never mid-truncated with ….
    if (body.includes('https://example.com/verify')) {
      expect(body).toContain(longLink);
      expect(body).not.toMatch(/https:\/\/example\.com\/verify[^\n]*…/);
    } else {
      expect(body).toMatch(/\(\+\d+ more links, open the dashboard to view\)/);
      expect(body).not.toContain('https://example.com/verify?token=');
    }

    // Through publish(overflow=truncate): link still complete in ntfy JSON.
    const { NtfyNotificationService, NTFY_REQUEST_MAX_BYTES } = await import('../src/lib/notify.ts');
    const { config } = await import('../src/lib/config.ts');
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    const captured: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      captured.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await new NtfyNotificationService().publish({
        target: 'user',
        title: 'openagent.email new mail',
        message: body,
        level: 'urgent',
        tags: ['email'],
        click: 'https://dash.example/ui',
        overflow: 'truncate',
      });
      expect(captured).toHaveLength(1);
      expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
      const parsed = JSON.parse(captured[0]!) as { message: string };
      if (parsed.message.includes('https://example.com/verify')) {
        expect(parsed.message).toContain(longLink);
        expect(parsed.message).not.toMatch(/https:\/\/example\.com\/verify[^\n]*…/);
      } else {
        expect(parsed.message).toMatch(/more links/);
      }
      // Packed body already under escaped budget for typical framing.
      expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('tier 3 packs full link before preview remainder (F88 order)', () => {
    // Coordinator repro: 2500-char verify link + 200 backslash subject + 500 preview
    // under the 3500 escaped-byte local cap. Link must stay whole; preview shrinks.
    const prefix = 'https://example.com/verify?token=';
    const longLink = `${prefix}${'a'.repeat(2500 - prefix.length)}`;
    expect(longLink.length).toBe(2500);
    const slashSubject = '\\'.repeat(200);
    const fullPreview = 'p'.repeat(500);

    const body = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: slashSubject,
      from: 'auth@example.com',
      preview: fullPreview,
      codes: [],
      links: [longLink],
    });

    expect(body).toContain(longLink);
    expect(body).not.toMatch(/https:\/\/example\.com\/verify[^\n]*…/);
    expect(body).not.toMatch(/\(\+\d+ more links/);
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);

    const previewLine = body.split('\n').find((line) => line.startsWith('Preview: '));
    expect(previewLine).toBeDefined();
    const previewText = previewLine!.slice('Preview: '.length);
    expect(previewText.length).toBeGreaterThan(0);
    expect(previewText.length).toBeLessThan(500);
    // Assembly order: meta → Preview → Links
    const previewIdx = body.indexOf('\nPreview: ');
    const linksIdx = body.indexOf('\nLinks:\n');
    expect(previewIdx).toBeGreaterThan(0);
    expect(linksIdx).toBeGreaterThan(previewIdx);
  });

  test('tier 3 omits whole link with note when base alone leaves no room (F88)', () => {
    // 2900-char link + 400-backslash subject: escaped subject (~800) + framing + link
    // exceed the 3500 cap even without preview → honest +N note, no half URL.
    const prefix = 'https://example.com/verify?token=';
    const longLink = `${prefix}${'a'.repeat(2900 - prefix.length)}`;
    expect(longLink.length).toBe(2900);
    const slashSubject = '\\'.repeat(400);
    const fullPreview = 'p'.repeat(200);

    const body = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: slashSubject,
      from: 'auth@example.com',
      preview: fullPreview,
      codes: [],
      links: [longLink],
    });

    expect(body).not.toContain(longLink);
    expect(body).not.toContain('https://example.com/verify?token=');
    expect(body).not.toMatch(/https:\/\/example\.com\/verify[^\n]*…/);
    expect(body).toMatch(/\(\+1 more links, open the dashboard to view\)/);
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    // Preview still fills remainder after the note-only Links block.
    const previewLine = body.split('\n').find((line) => line.startsWith('Preview: '));
    expect(previewLine).toBeDefined();
    expect(previewLine!.slice('Preview: '.length).length).toBeGreaterThan(0);
    expect(previewLine!.slice('Preview: '.length).length).toBeLessThanOrEqual(fullPreview.length);
  });

  test('tier 3 keeps small link preview and codes under budget (F88 regression)', () => {
    const body = buildMailArrivalMessage('a@test.example', 3, true, {
      subject: 'Your login code',
      from: 'auth@example.com',
      preview: 'Use the code below to finish signing in.',
      codes: ['123456'],
      links: ['https://example.com/verify?token=abc'],
    });
    expect(body).toContain('Codes: 123456');
    expect(body).toContain('https://example.com/verify?token=abc');
    expect(body).toContain('Preview: Use the code below to finish signing in.');
    expect(body).toContain('Subject: Your login code');
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(PUSH_MESSAGE_MAX_BYTES);
    const previewIdx = body.indexOf('\nPreview: ');
    const codesIdx = body.indexOf('\nCodes: ');
    const linksIdx = body.indexOf('\nLinks:\n');
    expect(previewIdx).toBeGreaterThan(0);
    expect(codesIdx).toBeGreaterThan(previewIdx);
    expect(linksIdx).toBeGreaterThan(codesIdx);
  });

  test('tier 3 drops tail links with +N note under budget (F79)', () => {
    const links = Array.from(
      { length: 12 },
      (_, i) => `https://example.com/verify?token=${'z'.repeat(180)}&i=${i}`,
    );
    const packed = packPushLinkLines(
      'a@test.example received new email\nFrom: x\nSubject: y\nPreview: p',
      links,
    );
    const linksBlock = packed.find((line) => line.startsWith('Links:\n'));
    expect(linksBlock).toBeDefined();
    const keptUrls = linksBlock!.slice('Links:\n'.length).split('\n').filter(Boolean);
    expect(keptUrls.length).toBeGreaterThan(0);
    expect(keptUrls.length).toBeLessThanOrEqual(PUSH_OTP_ITEM_MAX);
    for (const url of keptUrls) {
      expect(links).toContain(url);
      expect(url.endsWith('…')).toBe(false);
      expect(url.startsWith('https://example.com/verify?token=')).toBe(true);
    }
    const note = packed.find((line) => line.startsWith('(+'));
    expect(note).toMatch(/\(\+\d+ more links, open the dashboard to view\)/);
    const n = Number(note!.match(/\+(\d+)/)?.[1]);
    expect(n).toBe(links.length - keptUrls.length);
    expect(n).toBeGreaterThan(0);
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
