// Configuration validation is isolated here so the TLS safety switches do not
// depend on the process-wide config singleton used by the rest of the tests.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
const { normalizeUrl, parseConfig } = await import('../src/lib/config.ts');

const requiredEnv: NodeJS.ProcessEnv = {
  DOMAIN: 'example.com',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.com',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.com',
  SMTP_PASS: 'smtp-secret',
};

describe('TLS certificate verification configuration', () => {
  test('keeps certificate verification off by default for the bundled mailserver', () => {
    const config = parseConfig(requiredEnv);

    expect(config.imap.tlsRejectUnauthorized).toBe(false);
    expect(config.smtp.tlsRejectUnauthorized).toBe(false);
  });

  test('allows an external mail server to require trusted certificates', () => {
    const config = parseConfig({
      ...requiredEnv,
      IMAP_TLS_REJECT_UNAUTHORIZED: 'true',
      SMTP_TLS_REJECT_UNAUTHORIZED: 'true',
    });

    expect(config.imap.tlsRejectUnauthorized).toBe(true);
    expect(config.smtp.tlsRejectUnauthorized).toBe(true);
  });

  test('rejects invalid TLS certificate verification values', () => {
    expect(() =>
      parseConfig({ ...requiredEnv, IMAP_TLS_REJECT_UNAUTHORIZED: 'yes' }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...requiredEnv, SMTP_TLS_REJECT_UNAUTHORIZED: 'no' }),
    ).toThrow();
  });
});

describe('ALWAYS_BCC configuration', () => {
  test('is disabled when unset or blank and exposes the configured mailbox', () => {
    expect(parseConfig(requiredEnv).alwaysBcc).toBeUndefined();
    expect(parseConfig(requiredEnv).taskSigningSecret).toBe('smtp-secret');
    const blankArchive = parseConfig({ ...requiredEnv, ALWAYS_BCC: '   ' });
    expect(blankArchive.alwaysBcc).toBeUndefined();
    expect(blankArchive.taskSigningSecret).toBe('smtp-secret');
    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: 'archive@external.example',
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).alwaysBcc,
    ).toBe(
      'archive@external.example',
    );
  });

  test('limits a nonblank archive mailbox to SMTP local-part and total maximums without disclosing secrets', () => {
    const maximumMailbox = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    const overlongMailbox = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
    const maximumLocalPartMailbox = `${'a'.repeat(64)}@example.net`;
    const overlongLocalPartMailbox = `${'a'.repeat(65)}@example.net`;
    const maximumDomainLabelMailbox = `archive@${'a'.repeat(63)}.com`;
    const overlongDomainLabelMailbox = `archive@${'a'.repeat(64)}.com`;
    const punycodeDomainLabelMailbox = 'archive@xn--bcher-kva.example';
    const smtpPassword = 'smtp-password-not-for-validation-errors';
    const taskSigningSecret = 'task-signing-secret-not-for-validation-errors';

    expect(maximumMailbox).toHaveLength(254);
    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: maximumMailbox,
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).alwaysBcc,
    ).toBe(maximumMailbox);
    expect(overlongMailbox).toHaveLength(255);
    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: maximumLocalPartMailbox,
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).alwaysBcc,
    ).toBe(maximumLocalPartMailbox);
    expect(() =>
      parseConfig({ ...requiredEnv, ALWAYS_BCC: overlongLocalPartMailbox }),
    ).toThrow('SMTP local part must be at most 64 octets');
    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: maximumDomainLabelMailbox,
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).alwaysBcc,
    ).toBe(maximumDomainLabelMailbox);
    expect(() =>
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: overlongDomainLabelMailbox,
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }),
    ).toThrow('SMTP domain labels must be valid ASCII labels of at most 63 octets');
    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: punycodeDomainLabelMailbox,
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).alwaysBcc,
    ).toBe(punycodeDomainLabelMailbox);
    for (const malformedDomainLabelMailbox of [
      'archive@example-.com',
      'archive@a.example-.com',
    ]) {
      expect(() =>
        parseConfig({ ...requiredEnv, ALWAYS_BCC: malformedDomainLabelMailbox }),
      ).toThrow('SMTP domain labels must be valid ASCII labels of at most 63 octets');
    }

    const parseOverlongArchive = () =>
      parseConfig({
        ...requiredEnv,
        SMTP_PASS: smtpPassword,
        TASK_SIGNING_SECRET: taskSigningSecret,
        ALWAYS_BCC: overlongMailbox,
      });
    expect(parseOverlongArchive).toThrow();
    try {
      parseOverlongArchive();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(smtpPassword);
      expect(message).not.toContain(taskSigningSecret);
    }
  });

  test('rejects a malformed address, display name, or address list at startup', () => {
    for (const value of ['not-an-address', 'Archive <archive@example.net>', 'a@example.net,b@example.net']) {
      expect(() => parseConfig({ ...requiredEnv, ALWAYS_BCC: value })).toThrow();
    }
  });

  test('requires a 32-character explicit signing secret for an external archive', () => {
    expect(() =>
      parseConfig({ ...requiredEnv, ALWAYS_BCC: 'archive@external.example' }),
    ).toThrow('TASK_SIGNING_SECRET is required for an external compliance archive');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: 'archive@external.example',
        TASK_SIGNING_SECRET: 'a'.repeat(15),
      }),
    ).toThrow();

    expect(() =>
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: 'archive@external.example',
        TASK_SIGNING_SECRET: 'a'.repeat(16),
      }),
    ).toThrow('TASK_SIGNING_SECRET must be at least 32 characters for an external compliance archive');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: 'archive@external.example',
        TASK_SIGNING_SECRET: 'a'.repeat(31),
      }),
    ).toThrow('TASK_SIGNING_SECRET must be at least 32 characters for an external compliance archive');

    expect(
      parseConfig({
        ...requiredEnv,
        ALWAYS_BCC: 'archive@external.example',
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }).taskSigningSecret,
    ).toBe('a'.repeat(32));
  });

  test('rejects same-domain archives case-insensitively, including DNS root dots', () => {
    for (const domain of ['EXAMPLE.COM', 'EXAMPLE.COM.', 'EXAMPLE.COM..']) {
      expect(() =>
        parseConfig({
          ...requiredEnv,
          DOMAIN: domain,
          ALWAYS_BCC: 'archive@example.com',
          TASK_SIGNING_SECRET: 'a'.repeat(32),
        }),
      ).toThrow('ALWAYS_BCC must be an external compliance archive');
    }
  });
});

describe('task signing configuration', () => {
  test('uses a dedicated stable secret when configured', () => {
    const config = parseConfig({
      ...requiredEnv,
      SMTP_PASS: 'rotated-smtp-password',
      TASK_SIGNING_SECRET: 'stable-task-signing-secret-2026',
    });
    expect(config.taskSigningSecret).toBe('stable-task-signing-secret-2026');
  });

  test('keeps a fallback only for pre-v0.4 bare-process upgrades', () => {
    expect(parseConfig(requiredEnv).taskSigningSecret).toBe('smtp-secret');
  });

  test('derives a domain-separated notify cursor secret without a new env', () => {
    const parsed = parseConfig({
      ...requiredEnv,
      TASK_SIGNING_SECRET: 'stable-task-signing-secret-2026',
    });
    const expected = createHmac('sha256', 'stable-task-signing-secret-2026')
      .update('notify-cursor-v1')
      .digest();
    expect(Buffer.from(parsed.notifyCursorSecret).equals(expected)).toBe(true);
    expect(Buffer.from(parsed.notifyCursorSecret).equals(Buffer.from(parsed.taskSigningSecret))).toBe(
      false,
    );
  });
});

describe('notification URL configuration', () => {
  test('normalizes the configured public URL before device pairing compares it', () => {
    const config = parseConfig({
      ...requiredEnv,
      NOTIFY_PUBLIC_URL: 'https://NTFY.EXAMPLE.COM/',
    });
    expect(config.ntfy.publicUrl).toBe('https://ntfy.example.com');
  });

  test('DASHBOARD_PUBLIC_URL is optional and normalized when present', () => {
    expect(parseConfig(requiredEnv).dashboardPublicUrl).toBeUndefined();
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://MAIL.EXAMPLE.COM/ui/',
      }).dashboardPublicUrl,
    ).toBe('https://mail.example.com/ui');
  });

  test('MCP_PUBLIC_URL is optional, http(s) only, and normalized', () => {
    expect(parseConfig(requiredEnv).mcpPublicUrl).toBeUndefined();
    expect(
      parseConfig({
        ...requiredEnv,
        MCP_PUBLIC_URL: 'https://API.EXAMPLE.COM/',
      }).mcpPublicUrl,
    ).toBe('https://api.example.com');
    expect(() =>
      parseConfig({ ...requiredEnv, MCP_PUBLIC_URL: 'ftp://example.com' }),
    ).toThrow(/http or https/i);
  });

  test('MCP_RATE_* 默认 60/20，可覆盖，0 合法', () => {
    const defaults = parseConfig(requiredEnv);
    expect(defaults.mcpRateReadPerMin).toBe(60);
    expect(defaults.mcpRateWritePerMin).toBe(20);
    expect(
      parseConfig({
        ...requiredEnv,
        MCP_RATE_READ_PER_MIN: '10',
        MCP_RATE_WRITE_PER_MIN: '0',
      }).mcpRateWritePerMin,
    ).toBe(0);
  });

  test('P4-code 新 env 默认与边界', () => {
    const defaults = parseConfig(requiredEnv);
    expect(defaults.mcpMaxWaitSeconds).toBe(60);
    expect(defaults.trustProxyHeaders).toBe(false);
    expect(defaults.oaePublicEdge).toBe(false);
    expect(defaults.oauthRatePerMin).toBe(30);
    expect(defaults.mcpPreauthRatePerMin).toBe(120);
    expect(
      parseConfig({
        ...requiredEnv,
        MCP_MAX_WAIT_SECONDS: '45',
        TRUST_PROXY_HEADERS: 'true',
        OAE_PUBLIC_EDGE: 'true',
        OAUTH_RATE_PER_MIN: '0',
        MCP_PREAUTH_RATE_PER_MIN: '10',
      }),
    ).toMatchObject({
      mcpMaxWaitSeconds: 45,
      trustProxyHeaders: true,
      oaePublicEdge: true,
      oauthRatePerMin: 0,
      mcpPreauthRatePerMin: 10,
    });
  });

  test('empty or whitespace optional URL env values are treated as unset', () => {
    // Compose ${DASHBOARD_PUBLIC_URL:-} injects "" when the var is absent.
    expect(() =>
      parseConfig({ ...requiredEnv, DASHBOARD_PUBLIC_URL: '' }),
    ).not.toThrow();
    expect(
      parseConfig({ ...requiredEnv, DASHBOARD_PUBLIC_URL: '' }).dashboardPublicUrl,
    ).toBeUndefined();
    expect(
      parseConfig({ ...requiredEnv, DASHBOARD_PUBLIC_URL: '   ' }).dashboardPublicUrl,
    ).toBeUndefined();
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://dash.example.com/ui',
      }).dashboardPublicUrl,
    ).toBe('https://dash.example.com/ui');
    // Same empty-string safety for defaulted URL fields (fall through to default).
    expect(
      parseConfig({ ...requiredEnv, NOTIFY_PUBLIC_URL: '' }).ntfy.publicUrl,
    ).toBe('http://127.0.0.1:2586');
  });

  test('envUrl rejects non-http(s) schemes', () => {
    for (const bad of [
      'ftp://example.com',
      'file:///tmp/x',
      'mailto:user@example.com',
    ]) {
      expect(() =>
        parseConfig({ ...requiredEnv, DASHBOARD_PUBLIC_URL: bad }),
      ).toThrow(/http or https/i);
      expect(() =>
        parseConfig({ ...requiredEnv, NOTIFY_PUBLIC_URL: bad }),
      ).toThrow(/http or https/i);
    }
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'http://dash.example.com/ui',
      }).dashboardPublicUrl,
    ).toBe('http://dash.example.com/ui');
    expect(
      parseConfig({
        ...requiredEnv,
        NOTIFY_PUBLIC_URL: 'https://notify.example.com',
      }).ntfy.publicUrl,
    ).toBe('https://notify.example.com');
  });

  test('DASHBOARD_PUBLIC_URL rejects userinfo credentials (F80)', () => {
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://admin:secret@mail.example/ui',
      }),
    ).toThrow(/credentials|userinfo/i);
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://admin@mail.example/ui',
      }),
    ).toThrow(/credentials|userinfo/i);
    // Plain public origin still accepted.
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui',
      }).dashboardPublicUrl,
    ).toBe('https://mail.example.com/ui');
    // Internal ntfy URL may still carry credentials (private network auth).
    expect(
      parseConfig({
        ...requiredEnv,
        NTFY_INTERNAL_URL: 'http://publisher:secret@ntfy.internal',
      }).ntfy.internalUrl,
    ).toMatch(/publisher:secret@ntfy\.internal/);
  });

  test('DASHBOARD_PUBLIC_URL rejects query and fragment secrets (F114)', () => {
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui?token=secret',
      }),
    ).toThrow(/credentials|userinfo|query|fragment/i);
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui#session=abc',
      }),
    ).toThrow(/credentials|userinfo|query|fragment/i);
    // Plain path (with or without trailing slash) still accepted.
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui/',
      }).dashboardPublicUrl,
    ).toBe('https://mail.example.com/ui');
  });

  test('normalizeUrl root path keeps userinfo credentials (F60)', () => {
    expect(normalizeUrl('https://publisher:secret@ntfy.example/')).toBe(
      'https://publisher:secret@ntfy.example',
    );
    expect(normalizeUrl('https://ntfy.example/')).toBe('https://ntfy.example');
    expect(normalizeUrl('https://ntfy.example:8443/')).toBe('https://ntfy.example:8443');
    // Non-root still keeps credentials (href branch).
    expect(normalizeUrl('https://publisher:secret@ntfy.example/v1/path/')).toBe(
      'https://publisher:secret@ntfy.example/v1/path',
    );
  });

  test('normalizeUrl only strips pathname trailing slashes, not query or fragment', () => {
    // Vehicle: NOTIFY_PUBLIC_URL — DASHBOARD_PUBLIC_URL rejects query/fragment
    // outright (F114), so it can no longer carry this normalizeUrl contract.
    expect(
      parseConfig({
        ...requiredEnv,
        NOTIFY_PUBLIC_URL: 'https://ntfy.example.com/ui?next=/',
      }).ntfy.publicUrl,
    ).toBe('https://ntfy.example.com/ui?next=/');
    expect(
      parseConfig({
        ...requiredEnv,
        NOTIFY_PUBLIC_URL: 'https://ntfy.example.com/ui#/',
      }).ntfy.publicUrl,
    ).toBe('https://ntfy.example.com/ui#/');
    expect(
      parseConfig({
        ...requiredEnv,
        NOTIFY_PUBLIC_URL: 'https://NTFY.EXAMPLE.COM/',
      }).ntfy.publicUrl,
    ).toBe('https://ntfy.example.com');
  });
});

describe('EXTRA_DOMAINS multi-domain configuration', () => {
  test('parses EXTRA_DOMAINS into extraDomains and allDomains, lowercased and trimmed', () => {
    const config = parseConfig({
      ...requiredEnv,
      DOMAIN: 'Primary.Example',
      EXTRA_DOMAINS: ' Sec1.Example , sec2.example ',
    });

    expect(config.domain).toBe('primary.example');
    expect(config.extraDomains).toEqual(['sec1.example', 'sec2.example']);
    expect(config.allDomains).toEqual(
      new Set(['primary.example', 'sec1.example', 'sec2.example']),
    );
    expect(config.allowedSendDomains).toEqual([
      'primary.example',
      'sec1.example',
      'sec2.example',
    ]);
  });

  test('validates primary DOMAIN format allowing single-label and preserving dotted-legacy while rejecting malformed domains', () => {
    const localhost = parseConfig({
      ...requiredEnv,
      DOMAIN: 'localhost',
    });
    expect(localhost.domain).toBe('localhost');

    const extraIntranet = parseConfig({
      ...requiredEnv,
      DOMAIN: 'example.com',
      EXTRA_DOMAINS: 'intranet',
    });
    expect(extraIntranet.extraDomains).toEqual(['intranet']);
    expect(extraIntranet.allDomains).toContain('intranet');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: '.',
      }),
    ).toThrow('DOMAIN contains invalid domain: "."');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'not a domain',
      }),
    ).toThrow('DOMAIN contains invalid domain: "not a domain"');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: '-invalid',
      }),
    ).toThrow('DOMAIN contains invalid domain: "-invalid"');

    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'example.com',
        EXTRA_DOMAINS: 'not a domain',
      }),
    ).toThrow('EXTRA_DOMAINS contains invalid domain entry: "not a domain"');

    const dotted = parseConfig({
      ...requiredEnv,
      DOMAIN: 'example.com.',
    });
    expect(dotted.domain).toBe('example.com.');
  });

  test('rejects EXTRA_DOMAINS containing the primary DOMAIN (case-insensitive)', () => {
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example.',
        EXTRA_DOMAINS: 'other.example, PRIMARY.EXAMPLE',
      }),
    ).toThrow('EXTRA_DOMAINS must not contain the primary DOMAIN');
  });

  test('rejects duplicate entries within EXTRA_DOMAINS', () => {
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: 'dup.example, other.example, DUP.EXAMPLE',
      }),
    ).toThrow('EXTRA_DOMAINS contains duplicate entries');
  });

  test('ALLOWED_SEND_DOMAINS overrides the default allDomains when specified', () => {
    const config = parseConfig({
      ...requiredEnv,
      DOMAIN: 'primary.example',
      EXTRA_DOMAINS: 'sec.example',
      ALLOWED_SEND_DOMAINS: 'primary.example',
    });
    expect(config.allowedSendDomains).toEqual(['primary.example']);
  });

  test('ALWAYS_BCC rejects secondary domains in allDomains case-insensitively', () => {
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: 'SECONDARY.EXAMPLE.',
        ALWAYS_BCC: 'archive@secondary.example',
        TASK_SIGNING_SECRET: 'a'.repeat(32),
      }),
    ).toThrow('ALWAYS_BCC must be an external compliance archive');
  });

  test('canonicalizes trailing dots off EXTRA_DOMAINS while retaining primary DOMAIN raw-lowercase', () => {
    const config = parseConfig({
      ...requiredEnv,
      DOMAIN: 'Primary.Example.',
      EXTRA_DOMAINS: 'secondary.example., other.org.',
    });
    expect(config.domain).toBe('primary.example.');
    expect(config.extraDomains).toEqual(['secondary.example', 'other.org']);
    expect(config.allDomains).toEqual(
      new Set(['primary.example.', 'secondary.example', 'other.org']),
    );
  });

  test('tolerates trailing commas and empty entries in EXTRA_DOMAINS', () => {
    const config = parseConfig({
      ...requiredEnv,
      DOMAIN: 'primary.example',
      EXTRA_DOMAINS: 'sec1.example, , sec2.example,',
    });
    expect(config.extraDomains).toEqual(['sec1.example', 'sec2.example']);
    expect(config.allDomains).toEqual(
      new Set(['primary.example', 'sec1.example', 'sec2.example']),
    );
  });

  test('rejects invalid domain format entries in EXTRA_DOMAINS at startup', () => {
    // Invalid characters (underscore in DNS hostname)
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: 'invalid_domain.example',
      }),
    ).toThrow('EXTRA_DOMAINS contains invalid domain entry: "invalid_domain.example"');

    // Invalid characters (leading hyphen)
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: '-bad.example',
      }),
    ).toThrow('EXTRA_DOMAINS contains invalid domain entry: "-bad.example"');

    // Label length > 63 chars
    const longLabel = 'a'.repeat(64);
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: `${longLabel}.example`,
      }),
    ).toThrow(`EXTRA_DOMAINS contains invalid domain entry: "${longLabel}.example"`);

    // Total length > 253 chars
    const longDomain = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.com`;
    expect(longDomain.length).toBeGreaterThan(253);
    expect(() =>
      parseConfig({
        ...requiredEnv,
        DOMAIN: 'primary.example',
        EXTRA_DOMAINS: longDomain,
      }),
    ).toThrow(`EXTRA_DOMAINS contains invalid domain entry: "${longDomain}"`);
  });
});
