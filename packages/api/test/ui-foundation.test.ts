import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'ui-admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-foundation-'));

const { config } = await import('../src/lib/config.ts');
const { resolveToken } = await import('../src/lib/auth.ts');
const { createIdentity } = await import('../src/lib/identities.ts');

test('UI is enabled by default', () => {
  expect(config.uiEnabled).toBe(true);
});

test('resolveToken is the single parser for admin and identity credentials', () => {
  const configuredAdminKey = [...config.apiKeys][0]!;
  expect(resolveToken(configuredAdminKey)).toEqual({ kind: 'admin' });

  const created = createIdentity({ localpart: 'ui-foundation' })!;
  expect(resolveToken(created.token)).toEqual({
    kind: 'identity',
    address: 'ui-foundation@test.example',
  });
  expect(resolveToken('not-a-token')).toBeNull();
});
