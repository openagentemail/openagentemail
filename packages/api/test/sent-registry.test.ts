import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-sent-reg-'));

const { describe, expect, test } = await import('bun:test');
const {
  hasSentMessageId,
  normalizeMessageId,
  recordSentMessageId,
  recordSentMessageIdAfterSend,
  resetSentRegistryForTests,
  reloadSentRegistryFromDiskForTests,
  setSentRegistryPersistHookForTests,
  sentRegistrySizeForTests,
} = await import('../src/lib/sent-registry.ts');
const { config } = await import('../src/lib/config.ts');

function registryPath(): string {
  return join(config.dataDir, 'sent-registry.json');
}

describe('normalizeMessageId', () => {
  test('剥尖括号并小写', () => {
    expect(normalizeMessageId('<ABC@Host.Example>')).toBe('abc@host.example');
    expect(normalizeMessageId(' abc@host.example ')).toBe('abc@host.example');
  });

  test('空串缺失 fail-closed', () => {
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('   ')).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

describe('sent registry 持久化', () => {
  test('登记后可查，重启再 load 仍在', () => {
    resetSentRegistryForTests();
    recordSentMessageId('<first@test.example>', 'fox@test.example');
    expect(hasSentMessageId('first@test.example', 'fox@test.example')).toBe(true);
    expect(hasSentMessageId('<FIRST@test.example>', 'FOX@test.example')).toBe(true);
    const raw = JSON.parse(readFileSync(registryPath(), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.entries[0].id).toBe('first@test.example');
    expect(raw.entries[0].from).toBe('fox@test.example');
    const mode = statSync(registryPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    reloadSentRegistryFromDiskForTests();
    expect(hasSentMessageId('first@test.example', 'fox@test.example')).toBe(true);
  });

  test('同一 Message-ID 不能被另一个 From 冒用', () => {
    resetSentRegistryForTests();
    recordSentMessageId('<shared@test.example>', 'owl@test.example');
    expect(hasSentMessageId('shared@test.example', 'owl@test.example')).toBe(true);
    expect(hasSentMessageId('shared@test.example', 'fox@test.example')).toBe(false);
  });

  test('重复登记不刷新、不增条', () => {
    resetSentRegistryForTests();
    const t = Date.now();
    recordSentMessageId('<dup@test.example>', 'fox@test.example', t);
    recordSentMessageId('<dup@test.example>', 'fox@test.example', t + 9_000);
    expect(sentRegistrySizeForTests()).toBe(1);
  });

  test('FIFO 淘汰最旧', () => {
    resetSentRegistryForTests({ maxEntries: 2 });
    const t = Date.now();
    recordSentMessageId('<a@test.example>', 'fox@test.example', t);
    recordSentMessageId('<b@test.example>', 'fox@test.example', t + 1);
    recordSentMessageId('<c@test.example>', 'fox@test.example', t + 2);
    expect(hasSentMessageId('a@test.example', 'fox@test.example')).toBe(false);
    expect(hasSentMessageId('b@test.example', 'fox@test.example')).toBe(true);
    expect(hasSentMessageId('c@test.example', 'fox@test.example')).toBe(true);
    expect(sentRegistrySizeForTests()).toBe(2);
  });

  test('过期按 TTL 淘汰', () => {
    resetSentRegistryForTests({ ttlMs: 2000 });
    recordSentMessageId('<old@test.example>', 'fox@test.example', Date.now() - 10_000);
    expect(hasSentMessageId('old@test.example', 'fox@test.example')).toBe(false);
    // 读路径不 prune：条数仍在，等下次写入再淘汰
    expect(sentRegistrySizeForTests()).toBe(1);
    recordSentMessageId('<new@test.example>', 'fox@test.example');
    expect(sentRegistrySizeForTests()).toBe(1);
    expect(hasSentMessageId('old@test.example', 'fox@test.example')).toBe(false);
    expect(hasSentMessageId('new@test.example', 'fox@test.example')).toBe(true);
  });

  test('读路径不写盘（过期查询也不 persist）', () => {
    resetSentRegistryForTests({ ttlMs: 2000 });
    recordSentMessageId('<old@test.example>', 'fox@test.example', Date.now() - 10_000);
    let persistCalls = 0;
    setSentRegistryPersistHookForTests(() => {
      persistCalls += 1;
    });
    expect(hasSentMessageId('old@test.example', 'fox@test.example')).toBe(false);
    expect(hasSentMessageId('missing@test.example', 'fox@test.example')).toBe(false);
    expect(persistCalls).toBe(0);
    setSentRegistryPersistHookForTests(null);
  });

  test('persist 抛错时 record 不向外抛', () => {
    resetSentRegistryForTests();
    setSentRegistryPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    expect(() =>
      recordSentMessageIdAfterSend('<diskfull@test.example>', 'fox@test.example'),
    ).not.toThrow();
    setSentRegistryPersistHookForTests(null);
  });

  test('损坏文件回退为空表，读路径不抛', () => {
    resetSentRegistryForTests();
    writeFileSync(registryPath(), '{not-json', { mode: 0o600 });
    reloadSentRegistryFromDiskForTests();
    expect(() => hasSentMessageId('x@test.example', 'fox@test.example')).not.toThrow();
    expect(hasSentMessageId('x@test.example', 'fox@test.example')).toBe(false);
    expect(sentRegistrySizeForTests()).toBe(0);
  });
});
