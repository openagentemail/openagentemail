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

const { config, parseConfig } = await import('../src/lib/config.ts');
const { resolveToken } = await import('../src/lib/auth.ts');
const { createIdentity } = await import('../src/lib/identities.ts');

// 全量套件里其他文件可能先把 process.env.UI_ENABLED 设成 false，再导入
// 进程级 config 单例。这里用一份不含 UI_ENABLED 的独立 env 调 parseConfig，
// 断言的是 schema 默认值，不依赖文件顺序或缓存单例。
test('UI is enabled by default', () => {
  const isolated = parseConfig({
    DOMAIN: 'test.example',
    API_KEYS: 'ui-admin-key',
    IMAP_USER: 'agent@test.example',
    IMAP_PASS: 'imap-secret',
    SMTP_USER: 'agent@test.example',
    SMTP_PASS: 'smtp-secret',
  });
  expect(isolated.uiEnabled).toBe(true);
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
