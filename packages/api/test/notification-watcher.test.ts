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
const {
  NotifyError,
  jsonEscapedByteLength,
  notifyAvailableMessageBytes,
} = await import('../src/lib/notify.ts');
const { hasStrongOtpCue } = await import('../src/lib/otp.ts');

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

  test('uidvalidity change re-anchors the watermark instead of starving mail (F111)', () => {
    const watermark: { uid?: number; uidValidity?: bigint } = {};
    // First sight of the mailbox: anchor at high-water, no replay.
    expect(unseenWatcherUids([10, 11], watermark, 1000n)).toEqual([]);
    expect(watermark.uid).toBe(11);
    expect(watermark.uidValidity).toBe(1000n);
    // Same generation: only strictly newer UIDs are unseen.
    expect(unseenWatcherUids([10, 11, 12], watermark, 1000n)).toEqual([12]);
    // INBOX recreated (new UIDVALIDITY) on an already-observed mailbox: mail
    // may have landed during the disconnect, so every current UID is pending
    // (F115); the new generation starts BELOW the pending UIDs and the watcher
    // loop advances the watermark only after each message is processed (F118),
    // so a transient failure retries the remainder instead of losing it.
    expect(unseenWatcherUids([1, 2, 3], watermark, 2000n)).toEqual([1, 2, 3]);
    expect(watermark.uid).toBe(0);
    expect(watermark.uidValidity).toBe(2000n);
    // Simulate the watcher loop's per-message advancement, then new mail flows.
    watermark.uid = 3;
    expect(unseenWatcherUids([1, 2, 3, 4], watermark, 2000n)).toEqual([4]);
    // Legacy callers without uidValidity keep numeric-only behavior.
    const legacy: { uid?: number } = {};
    expect(unseenWatcherUids([5], legacy)).toEqual([]);
    expect(unseenWatcherUids([5, 6], legacy)).toEqual([6]);
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
    expect(calls[0].source).toBe('watcher');
    expect(calls[0].sensitive).toBe(false);
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

  test('otp policy classifies subject-only codes and links (F110)', async () => {
    // Subject carries the code while the body is plain: must still alert.
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Your verification code is 123456\r\n\r\nHello there, no code in this body.',
      ),
      'otp',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('target@test.example received new email (contains OTP or verification link)');
    expect(calls[0].level).toBe('urgent');
    // Tier 1 (default): the subject code still does not enter the payload.
    expect(JSON.stringify(calls[0])).not.toContain('123456');

    // Envelope-subject fallback (no parseable source) classifies too.
    const envelopeOnly = await dispatches(
      {
        envelope: {
          from: [{ address: 'stranger@example.net' }],
          to: [{ address: 'target@test.example' }],
          subject: 'Your verification code is 654321',
        },
        headers: Buffer.from('Delivered-To: target@test.example\r\n'),
      } as any,
      'otp',
    );
    expect(envelopeOnly).toHaveLength(1);

    // Subject verify-link without a body link alerts as well.
    const linkCalls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: verify https://example.com/verify?token=abc123\r\n\r\nplain body',
      ),
      'otp',
    );
    expect(linkCalls).toHaveLength(1);

    // No OTP in subject or body: still gated out.
    const none = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: lunch tomorrow?\r\n\r\nsee you at noon',
      ),
      'otp',
    );
    expect(none).toEqual([]);
  });

  test('tier 3 carries subject-only codes and links into the payload (F116)', async () => {
    // The only credential is a long signed URL in the subject with a plain
    // body: tier 3 must publish the full link, not a subject line truncated
    // at the metadata cap.
    const longUrl = `https://example.com/verify?token=${'a'.repeat(600)}`;
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: verify ${longUrl}\r\n\r\nplain body, no credentials`,
        `verify ${longUrl}`,
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
    expect(body).toContain('Links:');
    expect(body).toContain(longUrl);

    // Subject-only code lands on the Codes line too.
    const codeCalls = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Your verification code is 123456\r\n\r\nplain body',
        'Your verification code is 123456',
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
    );
    expect(codeCalls).toHaveLength(1);
    expect(codeCalls[0].message).toContain('Codes: 123456');
  });

  test('otp policy classifies strongly cued alphanumeric subject codes (F134)', async () => {
    // The only credential is an alnum code in the subject: numeric-only
    // extraction missed it, and the default otp policy dropped the push.
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Your verification code is A1B2C3\r\n\r\nplain body, no credentials',
      ),
      'otp',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('urgent');
    // Tier 1 (default): the code still does not enter the payload.
    expect(JSON.stringify(calls[0])).not.toContain('A1B2C3');

    // Tier 3 lists the code, but not over-extracted cue words (Your/code).
    const tier3 = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Your verification code is A1B2C3\r\n\r\nplain body',
        'Your verification code is A1B2C3',
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
    );
    expect(tier3).toHaveLength(1);
    expect(tier3[0].message).toContain('Codes: A1B2C3');
    expect(tier3[0].message).not.toContain('Codes: Your');
  });

  test('otp policy classifies and tier 2 masks spaced single-digit subject chains (F132)', async () => {
    // The only credential is a spaced-display code in the subject.
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Your verification code is 1 2 3 4 5 6\r\n\r\nplain body, no credentials',
      ),
      'otp',
    );
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('1 2 3 4 5 6');

    // Under `all` with tier 2, the spaced chain is masked, never published.
    const tier2 = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Your verification code is 1 2 3 4 5 6\r\n\r\nplain body',
        'Your verification code is 1 2 3 4 5 6',
      ),
      'all',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 2,
      }],
    );
    expect(tier2).toHaveLength(1);
    expect(tier2[0].message).toContain('•••');
    expect(JSON.stringify(tier2[0])).not.toContain('1 2 3 4 5 6');
  });

  test('tier 2 masks and otp policy classifies letter-only single-char chains (F135)', async () => {
    // All-caps letter chain is the only credential (subject-only).
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A B C D',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('A B C D');
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Your verification code is A-B-C-D\r\n\r\nplain body, no credentials',
      ),
      'otp',
    );
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('A-B-C-D');
  });

  test('otp policy ignores cue-word-only subjects (F136)', async () => {
    // `Error`/`code`/`expired` over-extract for masking, but none is a
    // code-shaped token: no classification, no misleading OTP alert.
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Error code has expired\r\n\r\nordinary body, nothing sensitive',
      ),
      'otp',
    );
    expect(calls).toEqual([]);
  });

  test('otp policy classifies strongly cued alphanumeric body codes (F137)', async () => {
    // The only credential is an alnum code in the BODY (plain subject).
    const calls = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: Hello there\r\n\r\nYour verification code is A1B2C3, use it soon.',
      ),
      'otp',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('urgent');
    // Tier 1 (default): the code does not enter the payload.
    expect(JSON.stringify(calls[0])).not.toContain('A1B2C3');

    // Tier 3 lists the body code on the Codes line.
    const tier3 = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Hello\r\n\r\nYour verification code is A1B2C3, use it soon.',
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
    );
    expect(tier3).toHaveLength(1);
    expect(tier3[0].message).toContain('Codes: A1B2C3');

    // Shouted words without any strong cue do not classify.
    const prose = await dispatches(
      message(
        'stranger@example.net',
        'From: stranger@example.net\r\nSubject: NOTES\r\n\r\nMEETING at noon, bring NOTES.',
      ),
      'otp',
    );
    expect(prose).toEqual([]);
  });

  test('tier 2 masks metadata repeats of body-derived alnum codes (F138)', async () => {
    // The body-derived code repeats in a cue-less subject: no cue, no digit
    // run, so the digit-canon filter alone published the subject unchanged.
    const calls = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Reference A1B2\r\n\r\nYour verification code is A1B2.',
        'Reference A1B2',
      ),
      'otp',
      [{ address: 'target@test.example', createdAt: '2026-08-02T00:00:00.000Z', pushContentTier: 2 }],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('•••');
    expect(calls[0].message).not.toContain('A1B2');
  });

  test('body codes beyond the cue window do not classify (F139)', async () => {
    // One cue near the start of a huge body: extraction is bounded to cue
    // windows, so a code-shaped token far past the window is not a signal.
    const far = await dispatches(
      message(
        'stranger@example.net',
        `From: stranger@example.net\r\nSubject: hi\r\n\r\nYour verification code expires soon. ${'x'.repeat(2000)} A1B2C3`,
      ),
      'otp',
    );
    expect(far).toEqual([]);
  });

  test('otp policy scans the HTML alternative for alnum codes (F140)', async () => {
    // Stub plain-text part, credential only in the HTML part: extractCodes
    // (digits only) finds nothing, so only the alnum pass can classify.
    const raw = [
      'From: auth@example.net',
      'Subject: Sign in',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Open this message in an HTML-capable mail client.',
      '',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Your verification code is A1B2C3, use it soon.</p>',
      '',
      '--alt--',
      '',
    ].join('\r\n');
    const calls = await dispatches(message('auth@example.net', raw), 'otp', [{
      address: 'target@test.example',
      createdAt: '2026-08-02T00:00:00.000Z',
      pushContentTier: 3,
    }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('Codes: A1B2C3');
  });

  test('tier 3 merges subject credentials even when the body also matches (F119)', async () => {
    // Body has its own code while the subject carries a long signed URL: both
    // must reach the payload — the subject is truncated at the metadata cap,
    // so a Links entry is the only usable form.
    const subjectUrl = `https://example.com/verify?token=${'b'.repeat(500)}`;
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: also verify ${subjectUrl}\r\n\r\nYour verification code is 654321`,
        `also verify ${subjectUrl}`,
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
    expect(body).toContain('Codes: 654321');
    expect(body).toContain('Links:');
    expect(body).toContain(subjectUrl);

    // Duplicate subject/body credentials are not repeated in the payload.
    const dupe = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Your verification code is 654321\r\n\r\nYour verification code is 654321',
        'Your verification code is 654321',
      ),
      'otp',
      [{
        address: 'target@test.example',
        createdAt: '2026-08-02T00:00:00.000Z',
        pushContentTier: 3,
      }],
    );
    expect(dupe).toHaveLength(1);
    // Subject + Preview + Codes: the merged credential is not repeated on the
    // Codes line even though subject and body extracted the same code.
    expect(dupe[0].message.match(/654321/g)).toHaveLength(3);
    expect(dupe[0].message.match(/Codes:/g)).toHaveLength(1);
  });

  test('tier 2 masking bounds metadata before compiling the alternation (F120)', () => {
    // Strong cue + thousands of distinct tokens: extraction/masking runs on
    // the publish-window prefix only, so output stays bounded (and fast —
    // unfixed this compiled a ~5000-branch alternation per message).
    const tokens = Array.from({ length: 5000 }, (_, i) => `tk${i.toString(36)}x`).join(' ');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: `Your verification code is 123456 ${tokens}`,
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('123456');
    expect(masked.subject.length).toBeLessThanOrEqual(464);
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
    // Avoid 4–8 letter continuous tokens under strong cue (F101 masks those).
    const subject = '2FA tip';
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

  test('tier 1/2 prefers dropping the click over truncating the alert (F123)', () => {
    // A ~3800-char DASHBOARD_PUBLIC_URL shrinks the with-click budget below
    // the interrupt text; the click must go, not the alert.
    const hugeClick = `https://dashboard.example.com/${'p'.repeat(3800)}`;
    const tier1 = buildMailArrivalMessage(
      'fox@example.com',
      1,
      false,
      { subject: '', from: '', preview: '', codes: [], links: [] },
      undefined,
      { clickUrl: hugeClick },
    );
    expect(tier1).toBe('fox@example.com received new email');

    const tier2 = buildMailArrivalMessage(
      'fox@example.com',
      2,
      true,
      { subject: 'hi', from: 'auth@example.com', preview: '', codes: [], links: [] },
      undefined,
      { clickUrl: hugeClick },
    );
    expect(tier2).toContain('fox@example.com received new email (contains OTP or verification link)');
    expect(tier2).toContain('From: auth@example.com');
    expect(tier2).not.toContain('…');

    // Short click still fits alongside the body — no behavior change.
    const withClick = buildMailArrivalMessage(
      'fox@example.com',
      1,
      false,
      { subject: '', from: '', preview: '', codes: [], links: [] },
      undefined,
      { clickUrl: 'https://dash.example.com' },
    );
    expect(withClick).toBe('fox@example.com received new email');
  });

  test('tier 3 repacks the preview when the click cannot survive the payload (F125)', () => {
    // Head (address + capped From/Subject) alone exceeds the with-click
    // budget, so publish() will drop the click regardless — the preview must
    // be packed under the roomier no-click budget instead of being omitted.
    const hugeClick = `https://dashboard.example.com/${'p'.repeat(3800)}`;
    const body = buildMailArrivalMessage(
      'fox@example.com',
      3,
      true,
      {
        subject: 'Your login code is 654321',
        from: 'auth@example.com',
        preview: 'Your verification code is 654321 — it expires in 10 minutes.',
        codes: ['654321'],
        links: [],
      },
      undefined,
      { clickUrl: hugeClick },
    );
    expect(body).toContain('From: auth@example.com');
    expect(body).toContain('Preview:');
    expect(body).toContain('Codes: 654321');
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

  test('maskSensitiveFragments masks full alnum before digit sub-runs (F91)', () => {
    // Both forms in the code set: alnum first so `ABC-` is not left after digit pass.
    expect(
      maskSensitiveFragments('Your verification code is ABC-1234', ['1234', 'ABC-1234'], []),
    ).toBe('Your verification code is •••');
    expect(
      maskSensitiveFragments('Your verification code is ABC-1234', ['1234', 'ABC-1234'], []),
    ).not.toContain('ABC');
    // Numeric-only / alnum-only / mixed+separate digit still work.
    expect(maskSensitiveFragments('Your code is 1234', ['1234'], [])).toBe('Your code is •••');
    expect(maskSensitiveFragments('Your code is ABC-1234', ['ABC-1234'], [])).toBe(
      'Your code is •••',
    );
    expect(maskSensitiveFragments('codes ABC-1234 and 5678', ['ABC-1234', '5678'], [])).toBe(
      'codes ••• and •••',
    );
    // Digit-only in codes against mixed text still half-masks (by design).
    expect(maskSensitiveFragments('Your code is ABC-1234', ['1234'], [])).toBe(
      'Your code is ABC-•••',
    );
  });

  test('maskTier2Metadata redacts delimited OTP in subject (F68)', () => {
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is 123-456',
      codes: ['123-456'],
      links: [],
      preview: '',
    });
    // F101 may also mask 4–8 letter cue words (Your/code) in the same subject.
    expect(masked.subject).toContain('•••');
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
    expect(extractMetaAlnumCodes('Your verification code is A1B2C3')).toContain('A1B2C3');
    expect(extractMetaAlnumCodes('Order ABC12345 shipped')).toEqual([]);
    // F81: 4–5 char mixed alnum under strong cue; 3-char stays out.
    expect(extractMetaAlnumCodes('Your verification code is A1B2')).toContain('A1B2');
    expect(extractMetaAlnumCodes('Your verification code is AB12')).toContain('AB12');
    // 3-char secret not extracted (Your/code may still appear under F101).
    expect(extractMetaAlnumCodes('Your verification code is A1B')).not.toContain('A1B');
    expect(extractMetaAlnumCodes('Order AB12 shipped')).toEqual([]);
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1B2C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1B2',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is AB12',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
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
    }).subject).toContain('•••');

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

  test('tier 2 masks letter-only all-caps OTP under strong cue (F95)', async () => {
    // Continuous uppercase 4–8 under strong cue (shouted letter-only codes).
    expect(extractMetaAlnumCodes('Your verification code is WXYZ')).toContain('WXYZ');
    expect(extractMetaAlnumCodes('Your verification code is WXYZJK')).toContain('WXYZJK');
    expect(extractMetaAlnumCodes('您的验证码是 ＷＸＹＺ')).toContain('ＷＸＹＺ');
    // Length bounds on continuous META_ALNUM_OTP_RE (4–8) for the secret token.
    expect(extractMetaAlnumCodes('Your verification code is ABC')).not.toContain('ABC');
    expect(extractMetaAlnumCodes('Your verification code is ABCDEFGHI')).not.toContain('ABCDEFGHI');
    // F101: continuous letter-only is case-insensitive.
    expect(extractMetaAlnumCodes('Your verification code is wxyz')).toContain('wxyz');
    expect(extractMetaAlnumCodes('Your verification code is Pending')).toContain('Pending');
    // Mixed regression anchor.
    expect(extractMetaAlnumCodes('Your verification code is ABC-123')).toContain('ABC-123');

    expect(maskSensitiveFragments('Your verification code is WXYZ', ['WXYZ'], [])).toBe(
      'Your verification code is •••',
    );
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is WXYZ',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is WXYZJK',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的验证码是 ＷＸＹＺ',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    // F101: lowercase / title case continuous mask under strong cue.
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is wxyz',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is Pending',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');

    const subject = 'Your verification code is WXYZ';
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
    expect(body).not.toContain('WXYZ');
  });

  test('tier 2 masks lowercase continuous letter-only OTP (F101)', () => {
    // Case-insensitive continuous may also pick 4–8 letter cue words (Your/code);
    // assert secrets are present/masked rather than exact form lists.
    expect(extractMetaAlnumCodes('Your verification code is abcd')).toContain('abcd');
    expect(extractMetaAlnumCodes('Your verification code is Abcd')).toContain('Abcd');
    expect(extractMetaAlnumCodes('Your verification code is ABCD')).toContain('ABCD');
    // 3-letter still out (and "now" alone is not enough without a 4–8 secret).
    expect(extractMetaAlnumCodes('OTP now')).toEqual([]);
    // Mixed alnum continuous still works.
    expect(extractMetaAlnumCodes('Your verification code is abc123')).toContain('abc123');
    // F97 delimited stays uppercase-only.
    expect(extractMetaAlnumCodes('Your verification code is wx-yz')).not.toContain('wx-yz');
    const abcd = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is abcd',
      codes: [],
      links: [],
      preview: '',
    });
    expect(abcd.subject).toContain('•••');
    expect(abcd.subject).not.toContain('abcd');
    // From must not treat localpart as letter-only OTP from subject-only cue.
    expect(abcd.from).toContain('auth@example.net');
    const title = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is Abcd',
      codes: [],
      links: [],
      preview: '',
    });
    expect(title.subject).not.toContain('Abcd');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'OTP now',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('OTP now');
  });

  test('tier 2 masks meta digit runs under strong cue beyond keyword window (F102)', () => {
    const gap = 'x'.repeat(90);
    const farSubject = `Your verification code is ${gap} 123456`;
    const far = maskTier2Metadata({
      from: 'auth@example.net',
      subject: farSubject,
      codes: [],
      links: [],
      preview: '',
    });
    expect(far.subject).toContain('•••');
    expect(far.subject).not.toContain('123456');
    // From field with distant digits; cue on subject (conservative cross-field).
    const cross = maskTier2Metadata({
      from: `agent ${gap} 123456`,
      subject: 'Your verification code is ready',
      codes: [],
      links: [],
      preview: '',
    });
    expect(cross.from).toContain('•••');
    expect(cross.from).not.toContain('123456');
    // In-window baseline still masks.
    const near = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is 123456',
      codes: [],
      links: [],
      preview: '',
    });
    expect(near.subject).toContain('•••');
    expect(near.subject).not.toContain('123456');
    // No strong cue → do not mask bare order numbers.
    expect(maskTier2Metadata({
      from: 'shop@example.net',
      subject: 'Order 123456 shipped',
      codes: [],
      links: [],
      preview: '',
    }).subject).toBe('Order 123456 shipped');
  });

  test('tier 2 masks delimited letter-only OTP under strong cue (F97)', async () => {
    expect(extractMetaAlnumCodes('Your verification code is WX-YZ')).toContain('WX-YZ');
    expect(extractMetaAlnumCodes('Your verification code is WX YZ')).toContain('WX YZ');
    expect(extractMetaAlnumCodes('Your verification code is AB-CD-EF')).toContain('AB-CD-EF');
    // Fullwidth letter-only delimited (NFKC uppercase groups).
    expect(extractMetaAlnumCodes('您的验证码是 ＷＸ ＹＺ')).toContain('ＷＸ ＹＺ');
    expect(extractMetaAlnumCodes('您的验证码是 ＷＸ－ＹＺ')).toContain('ＷＸ－ＹＺ');
    // Continuous F95 anchor still works.
    expect(extractMetaAlnumCodes('Your verification code is WXYZ')).toContain('WXYZ');
    // Prose / shape locks.
    expect(extractMetaAlnumCodes('Your verification code is Wx-Yz')).not.toContain('Wx-Yz');
    expect(extractMetaAlnumCodes('Your verification code is W-XYZ')).not.toContain('W-XYZ'); // group <2
    expect(extractMetaAlnumCodes('Your verification code is ABCDEFGHI-JK')).not.toContain('ABCDEFGHI-JK'); // group >4
    // 5-group space/tight runs rejected whole (F85 doctrine).
    expect(extractMetaAlnumCodes('Your verification code is AB CD EF GH IJ')).not.toContain('AB CD EF GH IJ');
    expect(extractMetaAlnumCodes('Your verification code is AB-CD-EF-GH-IJ')).not.toContain('AB-CD-EF-GH-IJ');
    expect(maskSensitiveFragments('Your verification code is WX-YZ', ['WX-YZ'], [])).toBe(
      'Your verification code is •••',
    );
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is WX-YZ',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is WX YZ',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');

    const subject = 'Your verification code is WX-YZ';
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
    expect(body).not.toContain('WX-YZ');
    expect(body).not.toContain('WX');
  });

  test('tier 2 masks tight single-char chain OTP under strong cue (F105)', () => {
    // Mixed single-char chain: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is A-1-B-2')).toContain('A-1-B-2');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A-1-B-2',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('A-1-B-2');
    // Fullwidth chain (NFKC single chars).
    expect(extractMetaAlnumCodes('您的验证码是 Ａ-１-Ｂ-２')).toContain('Ａ-１-Ｂ-２');
    // Lowercase mixed chain (mixed is case-insensitive).
    expect(extractMetaAlnumCodes('Your verification code is a-1-b-2')).toContain('a-1-b-2');
    // Longer chain within 4–8 total.
    expect(extractMetaAlnumCodes('Your verification code is A-1-B-2-C-3')).toContain('A-1-B-2-C-3');
    // Shape locks: 3-group chain too short; 9-group chain rejected whole.
    expect(extractMetaAlnumCodes('Your verification code is A-1-B')).not.toContain('A-1-B');
    expect(extractMetaAlnumCodes('Your verification code is A-1-B-2-C-3-D-4-E')).not.toContain('A-1-B-2-C-3-D-4-E');
    // F135: all-caps letter-only single chains extract (shouted letter codes).
    expect(extractMetaAlnumCodes('Your verification code is A-B-C-D')).toContain('A-B-C-D');
    // Lowercase letter-only chains stay rejected (prose protection, mirrors F97).
    expect(extractMetaAlnumCodes('Your verification code is a-b-c-d')).not.toContain('a-b-c-d');
    // Pure-digit chain stays on the digit path (not alnum extract).
    expect(extractMetaAlnumCodes('Your verification code is 1-2-3-4')).not.toContain('1-2-3-4');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference A-1-B-2 attached')).toEqual([]);
    // 2-4-char group regression (F84/F97 paths unaffected).
    expect(extractMetaAlnumCodes('Your verification code is ABC-123')).toContain('ABC-123');
    expect(extractMetaAlnumCodes('Your verification code is WX-YZ')).toContain('WX-YZ');
  });

  test('tier 2 masks space single-char chain OTP under strong cue (F106)', () => {
    // Mixed space single-char chain: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is A 1 B 2')).toContain('A 1 B 2');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A 1 B 2',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('A 1 B 2');
    // Fullwidth chain (NFKC single chars).
    expect(extractMetaAlnumCodes('您的验证码是 Ａ １ Ｂ ２')).toContain('Ａ １ Ｂ ２');
    // Lowercase mixed chain.
    expect(extractMetaAlnumCodes('Your verification code is a 1 b 2')).toContain('a 1 b 2');
    // Longer chain within 4–8 total.
    expect(extractMetaAlnumCodes('Your verification code is A 1 B 2 C 3')).toContain('A 1 B 2 C 3');
    // Run stops before a following word: only the chain masks; a 9+-letter
    // word (outside the F101 continuous length) stays fully intact — proves
    // the run did not eat its first char (F106 boundary guard).
    const prose = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your verification code is A 1 B 2 yesterday',
      codes: [],
      links: [],
      preview: '',
    });
    expect(prose.subject).toContain('yesterday');
    expect(prose.subject).not.toContain('A 1 B 2');
    // Shape locks: 3-group too short; 9-group rejected whole.
    expect(extractMetaAlnumCodes('Your verification code is A 1 B')).not.toContain('A 1 B');
    expect(extractMetaAlnumCodes('Your verification code is A 1 B 2 C 3 D 4 E')).not.toContain('A 1 B 2 C 3 D 4 E');
    // F135: all-caps letter-only space chains extract; lowercase stays rejected.
    expect(extractMetaAlnumCodes('Your verification code is A B C D')).toContain('A B C D');
    expect(extractMetaAlnumCodes('Your verification code is a b c d')).not.toContain('a b c d');
    // Pure-digit chain stays on the digit path.
    expect(extractMetaAlnumCodes('Your verification code is 1 2 3 4')).not.toContain('1 2 3 4');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference A 1 B 2 attached')).toEqual([]);
    // F85/F84 space path regressions.
    expect(extractMetaAlnumCodes('Your verification code is A1 B2 C3')).toContain('A1 B2 C3');
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toContain('ABC 123');
  });

  test('tier 2 masks mixed-separator single-char chain OTP under strong cue (F109)', () => {
    // Alternating space/tight chain bypasses both F105 and F106: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is A 1-B 2')).toContain('A 1-B 2');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A 1-B 2',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('A 1-B 2');
    // Alternating styles across the whole chain.
    expect(extractMetaAlnumCodes('Your verification code is A-1 B-2 C-3')).toContain('A-1 B-2 C-3');
    // Lowercase + fullwidth mixtures.
    expect(extractMetaAlnumCodes('Your verification code is a 1-b 2')).toContain('a 1-b 2');
    expect(extractMetaAlnumCodes('您的验证码是 Ａ １-Ｂ ２')).toContain('Ａ １-Ｂ ２');
    // Run stops before a following word: chain masks, word stays intact.
    const prose = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your verification code is A 1-B 2 yesterday',
      codes: [],
      links: [],
      preview: '',
    });
    expect(prose.subject).toContain('yesterday');
    expect(prose.subject).not.toContain('A 1-B 2');
    // Shape locks: 3-group too short; 9+-group chain rejected whole (embedded
    // pure-space 4-group runs may still extract via F106 — pre-existing).
    expect(extractMetaAlnumCodes('Your verification code is A 1-B')).not.toContain('A 1-B');
    expect(extractMetaAlnumCodes('Your verification code is A 1-B 2 C-3 D 4 E-5')).not.toContain(
      'A 1-B 2 C-3 D 4 E-5',
    );
    // F135: all-caps letter-only mixed-sep chains extract; pure-digit stays rejected.
    expect(extractMetaAlnumCodes('Your verification code is A B-C D')).toContain('A B-C D');
    expect(extractMetaAlnumCodes('Your verification code is 1 2-3 4')).not.toContain('1 2-3 4');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference A 1-B 2 attached')).toEqual([]);
    // F105/F106 regressions: pure tight and pure space chains still extract.
    expect(extractMetaAlnumCodes('Your verification code is A-1-B-2')).toContain('A-1-B-2');
    expect(extractMetaAlnumCodes('Your verification code is A 1 B 2')).toContain('A 1 B 2');
  });

  test('tier 2 masks slash-delimited alnum OTP under strong cue (F112)', () => {
    // Slash-joined mixed groups: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is A1/B2')).toContain('A1/B2');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1/B2',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('A1/B2');
    // Three groups; fullwidth slash.
    expect(extractMetaAlnumCodes('Your verification code is A1/B2/C3')).toContain('A1/B2/C3');
    expect(extractMetaAlnumCodes('您的验证码是 Ａ１／Ｂ２')).toContain('Ａ１／Ｂ２');
    // Slash single-char chain (4–8 groups) via the tight/mixed chain paths.
    expect(extractMetaAlnumCodes('Your verification code is A/1/B/2')).toContain('A/1/B/2');
    // Pure-digit slash forms (dates, fractions) stay unextracted — no letter.
    expect(extractMetaAlnumCodes('Your verification code is 08/07')).not.toContain('08/07');
    // Letter-only lowercase slash words stay rejected.
    expect(extractMetaAlnumCodes('Your verification code is and/or')).not.toContain('and/or');
    // F128: pure-digit slash forms mask via the numeric extractor path.
    const digitMasked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is 123/456',
      codes: [],
      links: [],
      preview: '',
    });
    expect(digitMasked.subject).toContain('•••');
    expect(digitMasked.subject).not.toContain('123/456');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference A1/B2 attached')).toEqual([]);
    // Regression: hyphen/dot tight forms still extract.
    expect(extractMetaAlnumCodes('Your verification code is ABC-123')).toContain('ABC-123');
    expect(extractMetaAlnumCodes('Your verification code is ABC.123')).toContain('ABC.123');
  });

  test('tier 2 masks colon-delimited alnum OTP under strong cue (F117)', () => {
    // Colon-joined mixed groups: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is AB:12:CD')).toContain('AB:12:CD');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is AB:12:CD',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('AB:12:CD');
    // Fullwidth colon; colon single-char chain (4–8 groups).
    expect(extractMetaAlnumCodes('您的验证码是 ＡＢ：１２')).toContain('ＡＢ：１２');
    expect(extractMetaAlnumCodes('Your verification code is A:1:B:2')).toContain('A:1:B:2');
    // F121: nonbreaking hyphen (U+2011) and its NFKC form (U+2010) mask too.
    expect(extractMetaAlnumCodes('Your verification code is AB\u201112')).toContain('AB\u201112');
    expect(extractMetaAlnumCodes('Your verification code is AB\u201012')).toContain('AB\u201012');
    const nbMasked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is AB\u201112',
      codes: [],
      links: [],
      preview: '',
    });
    expect(nbMasked.subject).not.toContain('AB\u201112');
    expect(nbMasked.subject).toContain('•••');
    // Pure-digit colon forms (times) stay unextracted — no letter.
    expect(extractMetaAlnumCodes('Your verification code is 12:30')).not.toContain('12:30');
    // Letter-only lowercase colon words stay rejected.
    expect(extractMetaAlnumCodes('Your verification code is ab:cd')).not.toContain('ab:cd');
    // Regression: a tight form after a single `label:` still extracts
    // (colon must not join the tight-class mid-chain guard).
    expect(extractMetaAlnumCodes('code: ABC-123')).toContain('ABC-123');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference AB:12:CD attached')).toEqual([]);
  });

  test('tier 2 masks underscore-delimited alnum OTP under strong cue (F124)', () => {
    // Underscore-joined mixed groups: extract + mask.
    expect(extractMetaAlnumCodes('Your verification code is AB_12')).toContain('AB_12');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is AB_12',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('AB_12');
    // Three groups; single-char chain; fullwidth underscore.
    expect(extractMetaAlnumCodes('Your verification code is AB_12_CD')).toContain('AB_12_CD');
    expect(extractMetaAlnumCodes('Your verification code is A_1_B_2')).toContain('A_1_B_2');
    expect(extractMetaAlnumCodes('您的验证码是 ＡＢ＿１２')).toContain('ＡＢ＿１２');
    // snake_case words stay unextracted — letter-only joins drop.
    expect(extractMetaAlnumCodes('Your verification code is otp_code')).not.toContain('otp_code');
    // Pure-digit underscore forms (ids) stay unextracted — no letter.
    expect(extractMetaAlnumCodes('Your verification code is 12_30')).not.toContain('12_30');
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference AB_12 attached')).toEqual([]);
  });

  test('tier 2 masks compatibility-form alnum OTP beyond fullwidth (F113)', () => {
    // Circled letters/digits NFKC-normalize to A1B2: extract original spelling + mask.
    expect(extractMetaAlnumCodes('Your verification code is Ⓐ①Ⓑ②')).toContain('Ⓐ①Ⓑ②');
    const masked = maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is Ⓐ①Ⓑ②',
      codes: [],
      links: [],
      preview: '',
    });
    expect(masked.subject).toContain('•••');
    expect(masked.subject).not.toContain('Ⓐ①Ⓑ②');
    // Lowercase circled + superscript digits (¹² NFKC → 12).
    expect(extractMetaAlnumCodes('Your verification code is ⓐ¹ⓑ²')).toContain('ⓐ¹ⓑ²');
    // Mathematical bold (surrogate-pair source) maps back to the right span.
    expect(extractMetaAlnumCodes('Your verification code is 𝐀𝟏𝐁𝟐')).toContain('𝐀𝟏𝐁𝟐');
    // Delimited compatibility form via the tight path.
    expect(extractMetaAlnumCodes('Your verification code is Ⓐ①-Ⓑ②')).toContain('Ⓐ①-Ⓑ②');
    // Multi-unit NFKC expansion (⑳ → 20) recovers the original span.
    expect(extractMetaAlnumCodes('Your verification code is Ⓐ⑳Ⓑ')).toContain('Ⓐ⑳Ⓑ');
    // Fullwidth fast path regression (same spelling, deduped across passes).
    expect(extractMetaAlnumCodes('您的验证码是 Ａ１Ｂ２')).toEqual(['Ａ１Ｂ２']);
    // No cue: rejected.
    expect(extractMetaAlnumCodes('Reference Ⓐ①Ⓑ② attached')).toEqual([]);
  });

  test('tier 2 masks delimited alnum OTP with strong cue (F84)', () => {
    expect(extractMetaAlnumCodes('Your verification code is ABC-123')).toContain('ABC-123');
    expect(extractMetaAlnumCodes('您的校验码是A1B-2C3')).toContain('A1B-2C3');
    expect(extractMetaAlnumCodes('Your code is A1-B2-C3')).toContain('A1-B2-C3');
    expect(extractMetaAlnumCodes('Ref ABC-123 attached')).toEqual([]);
    // 5+ groups rejected whole (no prefix half).
    expect(extractMetaAlnumCodes('Your code is AB-12-CD-34-EF')).not.toContain('AB-12-CD-34-EF');
    // Short English glue / year-ish space forms must not extract.
    expect(extractMetaAlnumCodes('Your code is to A1B2')).toContain('A1B2'); // continuous only
    expect(extractMetaAlnumCodes('Your code is to A1B2')).not.toContain('to A1B2');
    expect(extractMetaAlnumCodes('Your verification code expires Mar 2026')).not.toContain('2026');
    // Separator variants.
    expect(extractMetaAlnumCodes('Your code is ABC.123')).toContain('ABC.123');
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toContain('ABC 123');
    expect(extractMetaAlnumCodes('Your code is ABC\uFF0D123')).toContain('ABC\uFF0D123');

    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is ABC-123',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的校验码是A1B-2C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
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
    }).subject).toContain('•••');
    expect(extractMetaAlnumCodes('Your verification code is 123-456')).not.toContain('123-456');
  });

  test('mixed space+punctuation alnum seps mask under strong cue (F87)', () => {
    expect(extractMetaAlnumCodes('Your verification code is ABC - 123')).toContain('ABC - 123');
    expect(extractMetaAlnumCodes('Your code is A1 - B2 - C3')).toContain('A1 - B2 - C3');
    expect(extractMetaAlnumCodes('Your code is ABC--123')).toContain('ABC--123');
    expect(extractMetaAlnumCodes('Your code is ABC－ 123')).toContain('ABC－ 123');
    expect(extractMetaAlnumCodes('Ref ABC - 123 attached')).toEqual([]);
    expect(extractMetaAlnumCodes('Your code is word - another')).not.toContain('word - another');
    expect(extractMetaAlnumCodes('Your verification code is Mar - 2026')).not.toContain('Mar - 2026');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is ABC - 123',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    // Prior tight/space paths still work.
    expect(extractMetaAlnumCodes('Your code is ABC-123')).toContain('ABC-123');
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toContain('ABC 123');
  });

  test('tier 2 push redacts full ABC-1234 when body also has 1234 (F91)', async () => {
    // Body continuous digits + subject mixed alnum: both enter mask list; alnum
    // must win so the subject does not publish an `ABC-` prefix leak.
    const calls = await dispatches(
      message(
        'auth@example.net',
        'From: auth@example.net\r\nSubject: Your verification code is ABC-1234\r\n\r\nYour code is 1234. Thanks.',
        'Your verification code is ABC-1234',
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
    expect(body).not.toContain('ABC');
    expect(body).not.toContain('1234');
  });

  test('tier 2 masks fullwidth alnum OTP under strong cue (F86)', () => {
    // Fullwidth mixed continuous.
    expect(extractMetaAlnumCodes('您的验证码是 Ａ１Ｂ２Ｃ３')).toContain('Ａ１Ｂ２Ｃ３');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的验证码是 Ａ１Ｂ２Ｃ３',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    // Half/fullwidth mixed run (same char class).
    expect(extractMetaAlnumCodes('您的验证码是 A1Ｂ2Ｃ3')).toContain('A1Ｂ2Ｃ3');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: '您的验证码是 A1Ｂ2Ｃ3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    // English cue + fullwidth.
    expect(extractMetaAlnumCodes('Your verification code is ＡＢＣ１２３')).toContain('ＡＢＣ１２３');
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your verification code is ＡＢＣ１２３',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
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
    }).subject).toContain('•••');
    // CJK red line: no alnum extract from pure Chinese.
    expect(extractMetaAlnumCodes('验证码是您发的')).toEqual([]);
    // Exact original spelling: fullwidth extract does not mask halfwidth form.
    expect(maskSensitiveFragments('code A1B2C3', ['Ａ１Ｂ２Ｃ３'], [])).toBe('code A1B2C3');
    expect(maskSensitiveFragments('code Ａ１Ｂ２Ｃ３', ['Ａ１Ｂ２Ｃ３'], [])).toBe('code •••');
  });

  test('tier 2 masks OTP under fullwidth Latin cue (F103)', () => {
    // Fullwidth cue words: lowercasing alone never reaches ASCII `code`.
    expect(hasStrongOtpCue('Ｙｏｕｒ ｖｅｒｉｆｉｃａｔｉｏｎ ｃｏｄｅ ｉｓ Ａ１Ｂ２')).toBe(true);
    // Fullwidth cue + fullwidth alnum code masks.
    expect(extractMetaAlnumCodes('Ｙｏｕｒ ｖｅｒｉｆｉｃａｔｉｏｎ ｃｏｄｅ ｉｓ Ａ１Ｂ２')).toContain('Ａ１Ｂ２');
    const alnum = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Ｙｏｕｒ ｖｅｒｉｆｉｃａｔｉｏｎ ｃｏｄｅ ｉｓ Ａ１Ｂ２',
      codes: [],
      links: [],
      preview: '',
    });
    expect(alnum.subject).toContain('•••');
    expect(alnum.subject).not.toContain('Ａ１Ｂ２');
    // Fullwidth cue + fullwidth numeric code masks (F102 digit-run path).
    const numeric = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Ｙｏｕｒ ｖｅｒｉｆｉｃａｔｉｏｎ ｃｏｄｅ ｉｓ １２３４５６',
      codes: [],
      links: [],
      preview: '',
    });
    expect(numeric.subject).toContain('•••');
    expect(numeric.subject).not.toContain('１２３４５６');
    // Halfwidth cue-only mix: cue fullwidth, code ASCII.
    const half = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'ｃｏｄｅ A1B2',
      codes: [],
      links: [],
      preview: '',
    });
    expect(half.subject).toContain('•••');
    expect(half.subject).not.toContain('A1B2');
    // ASCII and CJK cue regressions.
    expect(hasStrongOtpCue('Your verification code is A1B2')).toBe(true);
    expect(hasStrongOtpCue('您的验证码是 123456')).toBe(true);
    expect(hasStrongOtpCue('Ｙｏｕｒ ｏｒｄｅｒ ｓｈｉｐｐｅｄ')).toBe(false);
  });

  test('space-separated alnum runs mask whole chain not halves (F85)', () => {
    // Bug repro: 3-group must not leave leading A1 unmasked as B2 C3 only.
    expect(extractMetaAlnumCodes('Your verification code is A1 B2 C3')).toContain('A1 B2 C3');
    expect(maskTier2Metadata({
      from: 'auth@example.net',
      subject: 'Your verification code is A1 B2 C3',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
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
    expect(extractMetaAlnumCodes('Your code is A1 B2 C3 D4')).toContain('A1 B2 C3 D4');
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is A1 B2 C3 D4',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');

    // F97: pure letter space runs (2–4 all-caps groups) are now accepted under cue.
    expect(extractMetaAlnumCodes('Your code is AB CD EF GH')).toContain('AB CD EF GH');
    expect(maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is AB CD EF GH',
      codes: [],
      links: [],
      preview: '',
    }).subject).toContain('•••');
    // 5+ letter groups still rejected whole (same F85 consume-full-run doctrine).
    expect(extractMetaAlnumCodes('Your code is AB CD EF GH IJ')).not.toContain('AB CD EF GH IJ');

    // 5+ digit-bearing groups rejected whole.
    expect(extractMetaAlnumCodes('Your code is A1 B2 C3 D4 E5')).not.toContain('A1 B2 C3 D4 E5');
    const five = maskTier2Metadata({
      from: 'a@b.c',
      subject: 'Your code is A1 B2 C3 D4 E5',
      codes: [],
      links: [],
      preview: '',
    }).subject;
    // 5+ digit-bearing groups not masked as OTP; F101 may still mask Your/code words.
    expect(five).toContain('A1 B2 C3 D4 E5');
    expect(five).not.toContain('••• A1');

    // 2-group regressions.
    expect(extractMetaAlnumCodes('Your code is ABC 123')).toContain('ABC 123');
    expect(extractMetaAlnumCodes('Your code is to A1B2')).not.toContain('to A1B2');
    expect(extractMetaAlnumCodes('Your verification code expires Mar 2026')).not.toContain('2026');
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
    expect(calls[0].source).toBe('watcher');
    expect(calls[0].sensitive).toBe(true);
  });

  test('tier 3 push keeps clean URL from non-adjacent prose wrapper (F90)', async () => {
    const mailBody =
      'See this link (secure: https://example.com/verify?token=abc)! Finish setup.';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: Verify\r\n\r\n${mailBody}`,
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
    const linksBlock = body.split('\nLinks:\n')[1] ?? '';
    expect(linksBlock).toContain('https://example.com/verify?token=abc');
    // Links entry is clean; prose `)!` may still appear only in Preview (raw body).
    expect(linksBlock.split('\n')[0]).toBe('https://example.com/verify?token=abc');
    expect(linksBlock).not.toMatch(/verify\?token=abc\)!/);
  });

  test('tier 3 push keeps clean URL from closer-colon wrapper (F96)', async () => {
    const mailBody =
      'See this link (secure: https://example.com/verify?token=abc): Finish setup.';
    const calls = await dispatches(
      message(
        'auth@example.net',
        `From: auth@example.net\r\nSubject: Verify\r\n\r\n${mailBody}`,
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
    const linksBlock = body.split('\nLinks:\n')[1] ?? '';
    expect(linksBlock.split('\n')[0]).toBe('https://example.com/verify?token=abc');
    expect(linksBlock).not.toMatch(/verify\?token=abc\):/);
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
    const tier3Budget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(tier3Budget);
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
    expect(jsonEscapedByteLength(huge)).toBeLessThanOrEqual(tier3Budget);
    expect(
      huge.endsWith('…') ||
        jsonEscapedByteLength(huge) < tier3Budget ||
        huge.includes('more links'),
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
    // Long verify link + backslash-heavy subject + large preview under the ntfy
    // residual: link must stay whole; preview shrinks to the remainder.
    const prefix = 'https://example.com/verify?token=';
    const longLink = `${prefix}${'a'.repeat(2500 - prefix.length)}`;
    expect(longLink.length).toBe(2500);
    const slashSubject = '\\'.repeat(200);
    const fullPreview = 'p'.repeat(2000);

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
    const noClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(noClickBudget);

    const previewLine = body.split('\n').find((line) => line.startsWith('Preview: '));
    expect(previewLine).toBeDefined();
    const previewText = previewLine!.slice('Preview: '.length);
    expect(previewText.length).toBeGreaterThan(0);
    expect(previewText.length).toBeLessThan(2000);
    // Assembly order: meta → Preview → Links
    const previewIdx = body.indexOf('\nPreview: ');
    const linksIdx = body.indexOf('\nLinks:\n');
    expect(previewIdx).toBeGreaterThan(0);
    expect(linksIdx).toBeGreaterThan(previewIdx);
  });

  test('tier 3 omits whole link with note when base alone leaves no room (F88)', () => {
    // Oversized link + backslash-heavy subject: even no-click residual cannot keep
    // the full URL → honest +N note, no half URL. Preview may still fill remainder.
    const prefix = 'https://example.com/verify?token=';
    const longLink = `${prefix}${'a'.repeat(3700 - prefix.length)}`;
    expect(longLink.length).toBe(3700);
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
    const noClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(noClickBudget);
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

  test('tier 3 prefers no-click budget over link eviction (F93)', () => {
    // Coordinator repro: long dashboard click + ~3483-byte verify link. With-click
    // residual (~3400) evicts the link; no-click residual (~3846) keeps it whole.
    const clickUrl = `https://dash.example/ui/${'c'.repeat(400)}`;
    const prefix = 'https://example.com/verify?token=';
    const longLink = `${prefix}${'a'.repeat(3483 - prefix.length)}`;
    expect(longLink.length).toBe(3483);

    const withClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
      click: clickUrl,
    });
    const noClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(withClickBudget).toBeLessThan(noClickBudget);
    expect(withClickBudget).toBeLessThan(3483);

    const body = buildMailArrivalMessage(
      'a@test.example',
      3,
      true,
      {
        subject: '',
        from: '',
        preview: '',
        codes: [],
        links: [longLink],
      },
      undefined,
      { clickUrl },
    );
    expect(body).toContain(longLink);
    expect(body).not.toMatch(/\(\+\d+ more links/);
    const escaped = jsonEscapedByteLength(body);
    expect(escaped).toBeGreaterThan(withClickBudget);
    expect(escaped).toBeLessThanOrEqual(noClickBudget);
  });

  test('tier 3 keeps with-click packing when short link fits (F93 regression)', () => {
    const clickUrl = 'https://dash.example/ui';
    const shortLink = 'https://example.com/verify?token=abc';
    const body = buildMailArrivalMessage(
      'a@test.example',
      3,
      true,
      {
        subject: 'Verify',
        from: 'auth@example.com',
        preview: 'hi',
        codes: [],
        links: [shortLink],
      },
      undefined,
      { clickUrl },
    );
    expect(body).toContain(shortLink);
    expect(body).not.toMatch(/\(\+\d+ more links/);
    // Fits under with-click residual → no need for no-click packing.
    const withClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
      click: clickUrl,
    });
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(withClickBudget);
  });

  test('tier 3 keeps with-click packing when eviction is equal under both budgets (F93)', () => {
    // Two enormous links: neither budget can keep either full URL → equal drops
    // → prefer with-click packing path (honest note, no half URL).
    const clickUrl = `https://dash.example/ui/${'c'.repeat(400)}`;
    const huge = (i: number) =>
      `https://example.com/verify?token=${'z'.repeat(3900)}&i=${i}`;
    const body = buildMailArrivalMessage(
      'a@test.example',
      3,
      true,
      {
        subject: '',
        from: '',
        preview: '',
        codes: [],
        links: [huge(0), huge(1)],
      },
      undefined,
      { clickUrl },
    );
    expect(body).not.toContain('https://example.com/verify?token=');
    expect(body).toMatch(/\(\+\d+ more links, open the dashboard to view\)/);
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

    const tier3Budget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(jsonEscapedByteLength(body)).toBeLessThanOrEqual(tier3Budget);
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
