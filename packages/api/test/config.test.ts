// Configuration validation is isolated here so the TLS safety switches do not
// depend on the process-wide config singleton used by the rest of the tests.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { describe, expect, test } from 'bun:test';
import { normalizeUrl, parseConfig } from '../src/lib/config.ts';

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
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui?next=/',
      }).dashboardPublicUrl,
    ).toBe('https://mail.example.com/ui?next=/');
    expect(
      parseConfig({
        ...requiredEnv,
        DASHBOARD_PUBLIC_URL: 'https://mail.example.com/ui#/',
      }).dashboardPublicUrl,
    ).toBe('https://mail.example.com/ui#/');
    expect(
      parseConfig({
        ...requiredEnv,
        NOTIFY_PUBLIC_URL: 'https://NTFY.EXAMPLE.COM/',
      }).ntfy.publicUrl,
    ).toBe('https://ntfy.example.com');
  });
});
