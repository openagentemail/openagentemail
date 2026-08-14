import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-sendlog-'));
process.env.TASK_SIGNING_SECRET = 'send-log-test-secret';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const {
  SEND_LOG_RETENTION_MS,
  appendSendLog,
  compactSendLog,
  querySendLog,
  resetSendLogForTests,
  sendLogPathForTests,
  setSendLogDirFsyncHookForTests,
  setSendLogNowForTests,
  setSendLogPersistHookForTests,
} = await import('../src/lib/send-log.ts');

function seed(partial: {
  from?: string;
  to?: string[];
  subject?: string;
  result?: 'queued' | 'failed';
  error?: string;
  source?: 'api' | 'mcp';
  messageId?: string | null;
} = {}) {
  return appendSendLog({
    from: partial.from ?? 'fox@test.example',
    to: partial.to ?? ['owl@example.net'],
    subject: partial.subject ?? 'hello',
    result: partial.result ?? 'queued',
    error: partial.error,
    source: partial.source ?? 'api',
    messageId: partial.messageId === undefined ? '<m@test.example>' : partial.messageId,
  });
}

beforeEach(() => {
  resetSendLogForTests();
});

afterEach(() => {
  resetSendLogForTests();
});

describe('send-log store', () => {
  test('append writes one schema row without body or token', async () => {
    const row = await seed({
      subject: 'Ship it',
      messageId: '<out@test.example>',
      source: 'mcp',
    });
    expect(row.id).toMatch(/^snd_/);
    expect(row.result).toBe('queued');
    expect(row.source).toBe('mcp');
    const text = readFileSync(sendLogPathForTests(), 'utf8');
    expect(text).not.toContain('body-secret');
    expect(text).not.toContain('oa_');
    expect(text).not.toContain('"text"');
    expect(text).not.toContain('"html"');
    expect(text).not.toContain('"token"');
    expect(JSON.parse(text.trim()).subject).toBe('Ship it');
    expect(statSync(sendLogPathForTests()).mode & 0o777).toBe(0o600);
  });

  test('failed row stores stable error code only', async () => {
    const row = await seed({ result: 'failed', error: 'smtp_error', messageId: null });
    expect(row.result).toBe('failed');
    expect(row.error).toBe('smtp_error');
    expect(row.messageId).toBeNull();
  });

  test('query hard-clamps to 30 days', async () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now - SEND_LOG_RETENTION_MS - 60_000);
    await seed({ subject: 'old' });
    setSendLogNowForTests(() => now);
    await seed({ subject: 'fresh' });
    const page = await querySendLog({ limit: 20 });
    expect(page.items.map((row) => row.subject)).toEqual(['fresh']);
  });

  test('compact drops rows older than 30 days', async () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now - SEND_LOG_RETENTION_MS - 1);
    await seed({ subject: 'gone' });
    setSendLogNowForTests(() => now);
    await seed({ subject: 'kept' });
    const result = await compactSendLog();
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(1);
    const page = await querySendLog({ limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.subject).toBe('kept');
  });

  test('pagination cursor is bound to address filter', async () => {
    await seed({ from: 'fox@test.example', subject: 'a' });
    await seed({ from: 'fox@test.example', subject: 'b' });
    await seed({ from: 'owl@test.example', subject: 'c' });
    const first = await querySendLog({ address: 'fox@test.example', limit: 20 });
    expect(first.items).toHaveLength(2);
    const page = await querySendLog({ address: 'fox@test.example', limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await querySendLog({
      address: 'fox@test.example',
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    await expect(
      querySendLog({ address: 'owl@test.example', limit: 1, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  test('disk-full persist hook surfaces persist error and leaves no secret', async () => {
    setSendLogPersistHookForTests(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    await expect(seed({ subject: 'no-space' })).rejects.toMatchObject({
      code: 'send_log_persist_failed',
    });
    setSendLogPersistHookForTests(null);
  });

  test('readonly data dir append fails closed without writing a body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oae-sendlog-ro-'));
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = dir;
    // config.dataDir 已在 import 时钉死；这里改目录 mode 模拟只读失败路径用 persist hook。
    process.env.DATA_DIR = prev;
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    setSendLogPersistHookForTests(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });
    await expect(seed()).rejects.toMatchObject({ code: 'send_log_persist_failed' });
    chmodSync(dir, 0o700);
    setSendLogPersistHookForTests(null);
  });

  test('middle corrupt fail-closes query', async () => {
    await seed({ subject: 'ok' });
    writeFileSync(sendLogPathForTests(), '{"schemaVersion":1}\nnot-json\n', { mode: 0o600 });
    await expect(querySendLog({ limit: 20 })).rejects.toMatchObject({ code: 'send_log_corrupt' });
  });

  test('dir fsync failure on compact rolls back dropped rows', async () => {
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now - SEND_LOG_RETENTION_MS - 1);
    await seed({ subject: 'old-keep-on-fail' });
    setSendLogNowForTests(() => now);
    await seed({ subject: 'new' });
    let blows = 0;
    setSendLogDirFsyncHookForTests(() => {
      blows += 1;
      // 只打第一次目录 fsync，让 bak 换回后的第二次 fsync 成功，才能断言磁盘回到旧态。
      if (blows === 1) {
        throw Object.assign(new Error('EIO: dir fsync'), { code: 'EIO' });
      }
    });
    await expect(compactSendLog()).rejects.toBeTruthy();
    setSendLogDirFsyncHookForTests(null);
    // bak+rename 回滚：活文件不得被 truncate；旧行必须还在盘上。
    const disk = readFileSync(sendLogPathForTests(), 'utf8');
    expect(disk).toContain('old-keep-on-fail');
    expect(disk).toContain('new');
    const page = await querySendLog({ limit: 20 });
    expect(page.items.map((row) => row.subject)).toEqual(['new']);
  });

  test('dest missing with leftover bak is restored instead of empty log', async () => {
    await seed({ subject: 'keep-me' });
    const dest = sendLogPathForTests();
    const bak = `${dest}.bak`;
    const { renameSync } = await import('node:fs');
    renameSync(dest, bak);
    const page = await querySendLog({ limit: 20 });
    expect(page.items[0]?.subject).toBe('keep-me');
    expect(readFileSync(dest, 'utf8')).toContain('keep-me');
  });
});
