// Identity-store tests. config.ts parses env at import time, so set the
// required variables BEFORE importing anything that pulls it in.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-1,admin-key-2';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-identities-'));

const { describe, expect, test } = await import('bun:test');
const {
  createIdentity,
  deleteIdentity,
  findIdentity,
  findIdentityByToken,
  listIdentities,
  rotateIdentityToken,
} = await import('../src/lib/identities.ts');

describe('identity tokens', () => {
  test('create returns a plaintext token once; store keeps only the hash', () => {
    const created = createIdentity({ localpart: 'tok-one' });
    expect(created).not.toBeNull();
    const { identity, token } = created!;
    expect(identity.address).toBe('tok-one@test.example');
    expect(token.startsWith('oa_')).toBe(true);
    // The stored identity must not contain the plaintext token.
    const stored = findIdentity('tok-one@test.example')!;
    expect(stored.tokenHash).toBeDefined();
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test('findIdentityByToken resolves the right identity', () => {
    const { token } = createIdentity({ localpart: 'tok-two' })!;
    const found = findIdentityByToken(token);
    expect(found?.address).toBe('tok-two@test.example');
    expect(findIdentityByToken('oa_wrong-token')).toBeUndefined();
  });

  test('rotation kills the old token and issues a working new one', () => {
    const { token: oldToken } = createIdentity({ localpart: 'tok-three' })!;
    const newToken = rotateIdentityToken('tok-three@test.example');
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);
    expect(findIdentityByToken(oldToken!)).toBeUndefined();
    expect(findIdentityByToken(newToken!)?.address).toBe('tok-three@test.example');
    expect(rotateIdentityToken('ghost@test.example')).toBeNull();
  });

  test('delete removes identity and its token', () => {
    const { token } = createIdentity({ localpart: 'tok-four' })!;
    expect(deleteIdentity('tok-four@test.example')).toBe(true);
    expect(deleteIdentity('tok-four@test.example')).toBe(false);
    expect(findIdentityByToken(token)).toBeUndefined();
    expect(findIdentity('tok-four@test.example')).toBeUndefined();
  });

  test('listIdentities never leaks token hashes', () => {
    for (const i of listIdentities()) {
      expect(i).not.toHaveProperty('tokenHash');
    }
  });

  test('duplicate address returns null', () => {
    expect(createIdentity({ localpart: 'tok-one' })).toBeNull();
  });
});
