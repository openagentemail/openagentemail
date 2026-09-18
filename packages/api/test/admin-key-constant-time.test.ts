/**
 * #227：resolveAccessToken admin key 恒定时间路径——accept/reject 双路径钉测。
 * 既有钉测零改动；本文件只新增覆盖。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-ct-227,admin-key-ct-227-b';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-admin-ct-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, test } = await import('bun:test');
const { resolveAccessToken } = await import('../src/lib/auth.ts');
const { config } = await import('../src/lib/config.ts');

const adminKeys = [...config.apiKeys];

describe('#227 resolveAccessToken admin key constant-time', () => {
  test('accept：集合内每个 admin key 均 ok+admin', () => {
    expect(adminKeys.length).toBeGreaterThanOrEqual(1);
    for (const key of adminKeys) {
      const r = resolveAccessToken(key);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.auth).toEqual({ kind: 'admin' });
        expect(r.attribution).toEqual({ kind: 'admin' });
      }
    }
  });

  test('reject：近邻/空串/垃圾均 unauthorized（非 admin）', () => {
    const samples = [
      `${adminKeys[0]}x`,
      `x${adminKeys[0]}`,
      adminKeys[0]!.slice(0, -1),
      '',
      'totally-not-an-admin-key',
    ];
    for (const token of samples) {
      const r = resolveAccessToken(token);
      // 非 admin：不得落到 ok+admin；空/垃圾通常 unauthorized
      if (r.status === 'ok') {
        expect(r.auth.kind).not.toBe('admin');
      } else {
        expect(r.status).toBe('unauthorized');
      }
    }
  });
});
