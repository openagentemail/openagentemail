// Configuration validation is isolated here so the TLS safety switches do not
// depend on the process-wide config singleton used by the rest of the tests.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { describe, expect, test } from 'bun:test';
import { parseConfig } from '../src/lib/config.ts';

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
