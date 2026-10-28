import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  SEND_LOG_EMAIL_MAX_LEN,
  SEND_LOG_RETENTION_MS,
  appendSendLog,
  compactSendLog,
  querySendLog,
  resetSendLogForTests,
  sendLogInspectCountForTests,
  sendLogPathForTests,
  setSendLogCapsForTests,
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

  test('#390 只落显式 autoReply true，旧行和 false 没有该字段', async () => {
    setSendLogNowForTests(() => Date.parse('2026-08-14T12:00:00.000Z'));
    const yes = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'yes',
      result: 'queued',
      source: 'api',
      autoReply: true,
    });
    const no = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'no',
      result: 'failed',
      error: 'smtp_error',
      source: 'api',
      autoReply: false,
    });
    const omit = await seed({ subject: 'omit' });
    expect(yes.autoReply).toBe(true);
    expect(no).not.toHaveProperty('autoReply');
    expect(omit).not.toHaveProperty('autoReply');
    const text = readFileSync(sendLogPathForTests(), 'utf8');
    expect(text).not.toContain('"text"');
    expect(text).not.toContain('"html"');
    expect(text).not.toContain('"token"');
    expect(text).not.toContain('"headers"');
    const page = await querySendLog({ limit: 20 });
    expect(page.items.find((row) => row.subject === 'yes')?.autoReply).toBe(true);
    expect(page.items.find((row) => row.subject === 'no')).not.toHaveProperty('autoReply');
    const base = {
      schemaVersion: 1,
      sentAt: '2026-08-14T00:00:00.000Z',
      from: 'fox@test.example',
      to: ['owl@example.net'],
      messageId: null,
      result: 'queued',
      source: 'api',
    };
    writeFileSync(
      sendLogPathForTests(),
      `${JSON.stringify({ ...base, id: 'snd_histfalse00000000000000', subject: 'old-false', autoReply: false })}\n${JSON.stringify({ ...base, id: 'snd_histomit000000000000000', subject: 'old-omit' })}\n`,
      { mode: 0o600 },
    );
    const old = await querySendLog({ limit: 20 });
    expect(old.items.find((row) => row.subject === 'old-false')).not.toHaveProperty('autoReply');
    expect(old.items.find((row) => row.subject === 'old-omit')).not.toHaveProperty('autoReply');
  });
  test('failed row stores stable error code only', async () => {
    const row = await seed({ result: 'failed', error: 'smtp_error', messageId: null });
    expect(row.result).toBe('failed');
    expect(row.error).toBe('smtp_error');
    expect(row.messageId).toBeNull();
    expect(row).not.toHaveProperty('failureKind');
  });

  test('failureKind 往返并在压缩后保留，非法值丢掉且不拒行', async () => {
    const smtp = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'smtp',
      result: 'failed',
      error: 'smtp_error',
      source: 'api',
      failureKind: 'smtp_response',
    });
    const local = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'local',
      result: 'failed',
      error: 'smtp_error',
      source: 'api',
      failureKind: 'local',
    });
    const queued = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'queued',
      result: 'queued',
      source: 'api',
      failureKind: 'smtp_response',
    });
    const limited = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'limited',
      result: 'failed',
      error: 'rate_limited',
      source: 'api',
    });
    expect(smtp.failureKind).toBe('smtp_response');
    expect(local.failureKind).toBe('local');
    expect(queued).not.toHaveProperty('failureKind');
    expect(limited).not.toHaveProperty('failureKind');
    await compactSendLog();
    const kept = await querySendLog({ limit: 20 });
    expect(kept.items.find((row) => row.subject === 'smtp')?.failureKind).toBe('smtp_response');
    expect(kept.items.find((row) => row.subject === 'local')?.failureKind).toBe('local');
    expect(kept.items.find((row) => row.subject === 'queued')).not.toHaveProperty('failureKind');
    expect(kept.items.find((row) => row.subject === 'limited')).not.toHaveProperty('failureKind');

    const sentAt = new Date().toISOString();
    const oldSentAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const base = {
      schemaVersion: 1,
      sentAt,
      from: 'fox@test.example',
      to: ['owl@example.net'],
      messageId: null,
      source: 'api',
    };
    writeFileSync(
      sendLogPathForTests(),
      [
        {
          ...base,
          id: 'snd_fk_old000000000000000001',
          subject: 'old',
          sentAt: oldSentAt,
          result: 'queued',
        },
        {
          ...base,
          id: 'snd_fk_bogus0000000000000001',
          subject: 'bogus',
          result: 'failed',
          error: 'smtp_error',
          failureKind: 'nope',
        },
        {
          ...base,
          id: 'snd_fk_kept00000000000000002',
          subject: 'kept',
          result: 'failed',
          error: 'smtp_error',
          failureKind: 'smtp_response',
        },
        {
          ...base,
          id: 'snd_fk_queued000000000000003',
          subject: 'queued-kind',
          result: 'queued',
          failureKind: 'local',
        },
        {
          ...base,
          id: 'snd_fk_num000000000000000004',
          subject: 'numeric-kind',
          result: 'failed',
          error: 'smtp_error',
          failureKind: 1,
        },
      ].map((row) => `${JSON.stringify(row)}\n`).join(''),
      { mode: 0o600 },
    );
    const parsed = await querySendLog({ limit: 20 });
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items.find((row) => row.subject === 'bogus')).not.toHaveProperty('failureKind');
    expect(parsed.items.find((row) => row.subject === 'kept')?.failureKind).toBe('smtp_response');
    expect(parsed.items.find((row) => row.subject === 'queued-kind')).not.toHaveProperty('failureKind');
    expect(parsed.items.find((row) => row.subject === 'numeric-kind')).not.toHaveProperty('failureKind');
    // 没东西可丢时压缩不重写。放一行过期记录，迫使按解析结果落盘。
    const compacted = await compactSendLog();
    expect(compacted.dropped).toBe(1);
    const text = readFileSync(sendLogPathForTests(), 'utf8');
    expect(text).toContain('"failureKind":"smtp_response"');
    expect(text).not.toContain('nope');
    expect(text).not.toContain('"failureKind":"local"');
    expect(text).not.toContain('"failureKind":1');
    const again = await querySendLog({ limit: 20 });
    expect(again.items.find((row) => row.subject === 'kept')?.failureKind).toBe('smtp_response');
    expect(again.items.find((row) => row.subject === 'bogus')?.result).toBe('failed');
  });

  test('rateLimitAt 往返，非法值丢掉且不拒行', async () => {
    const admitted = '2026-10-26T05:00:00.000Z';
    const queued = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'slot',
      result: 'queued',
      source: 'api',
      rateLimitAt: admitted,
    });
    const smtp = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'smtp-slot',
      result: 'failed',
      error: 'smtp_error',
      source: 'api',
      failureKind: 'smtp_response',
      rateLimitAt: admitted,
    });
    const local = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'local-slot',
      result: 'failed',
      error: 'smtp_error',
      source: 'api',
      failureKind: 'local',
      rateLimitAt: admitted,
    });
    const limited = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'limited-slot',
      result: 'failed',
      error: 'rate_limited',
      source: 'api',
      rateLimitAt: admitted,
    });
    expect(queued.rateLimitAt).toBe(admitted);
    expect(queued.sentAt).not.toBe(admitted);
    expect(smtp.rateLimitAt).toBe(admitted);
    expect(local).not.toHaveProperty('rateLimitAt');
    expect(limited).not.toHaveProperty('rateLimitAt');
    const written = await querySendLog({ limit: 20 });
    expect(written.items.find((row) => row.subject === 'slot')?.rateLimitAt).toBe(admitted);
    expect(written.items.find((row) => row.subject === 'slot')?.sentAt).toBe(queued.sentAt);

    const sentAt = new Date().toISOString();
    const base = {
      schemaVersion: 1,
      sentAt,
      from: 'fox@test.example',
      to: ['owl@example.net'],
      messageId: null,
      source: 'api',
    };
    writeFileSync(
      sendLogPathForTests(),
      [
        {
          ...base,
          id: 'snd_rl_ok000000000000000001',
          subject: 'ok',
          result: 'queued',
          rateLimitAt: admitted,
        },
        {
          ...base,
          id: 'snd_rl_bad00000000000000002',
          subject: 'bad',
          result: 'queued',
          rateLimitAt: 'not-a-time',
        },
        {
          ...base,
          id: 'snd_rl_long0000000000000003',
          subject: 'long',
          result: 'queued',
          rateLimitAt: `${admitted}${'x'.repeat(64)}`,
        },
        {
          ...base,
          id: 'snd_rl_num00000000000000004',
          subject: 'num',
          result: 'queued',
          rateLimitAt: 1,
        },
      ].map((row) => `${JSON.stringify(row)}\n`).join(''),
      { mode: 0o600 },
    );
    const parsed = await querySendLog({ limit: 20 });
    expect(parsed.items).toHaveLength(4);
    expect(parsed.items.find((row) => row.subject === 'ok')?.rateLimitAt).toBe(admitted);
    expect(parsed.items.find((row) => row.subject === 'ok')?.sentAt).toBe(sentAt);
    expect(parsed.items.find((row) => row.subject === 'bad')).not.toHaveProperty('rateLimitAt');
    expect(parsed.items.find((row) => row.subject === 'bad')?.sentAt).toBe(sentAt);
    expect(parsed.items.find((row) => row.subject === 'long')).not.toHaveProperty('rateLimitAt');
    expect(parsed.items.find((row) => row.subject === 'num')).not.toHaveProperty('rateLimitAt');
  });

  test('幂等哈希往返，非法值丢掉，原始键不落盘', async () => {
    const keyHash = 'a'.repeat(64);
    const requestHash = 'b'.repeat(64);
    const rawKey = 'Idem-Key/Not-Hex!';
    const queued = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'idem-ok',
      result: 'queued',
      source: 'api',
      messageId: '<idem@test.example>',
      idempotencyKeyHash: keyHash,
      requestHash,
    });
    expect(queued.idempotencyKeyHash).toBe(keyHash);
    expect(queued.requestHash).toBe(requestHash);
    const bogus = await appendSendLog({
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'idem-bad',
      result: 'queued',
      source: 'api',
      idempotencyKeyHash: rawKey,
      requestHash: 'B'.repeat(64),
    });
    expect(bogus).not.toHaveProperty('idempotencyKeyHash');
    expect(bogus).not.toHaveProperty('requestHash');
    const text = readFileSync(sendLogPathForTests(), 'utf8');
    expect(text).toContain(`"idempotencyKeyHash":"${keyHash}"`);
    expect(text).toContain(`"requestHash":"${requestHash}"`);
    expect(text).not.toContain(rawKey);
    expect(text).not.toContain('"idempotencyKey"');
    const page = await querySendLog({ limit: 20 });
    expect(page.items.find((row) => row.subject === 'idem-ok')).toMatchObject({
      idempotencyKeyHash: keyHash,
      requestHash,
    });
    expect(page.items.find((row) => row.subject === 'idem-bad')).not.toHaveProperty('idempotencyKeyHash');
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

  test('oversized address is clipped and never writes a giant line', async () => {
    const huge = `${'a'.repeat(400)}@example.net`;
    const row = await seed({ from: huge, to: [huge] });
    expect(row.from.length).toBeLessThanOrEqual(SEND_LOG_EMAIL_MAX_LEN);
    expect(row.to[0]?.length).toBeLessThanOrEqual(SEND_LOG_EMAIL_MAX_LEN);
    const disk = readFileSync(sendLogPathForTests(), 'utf8');
    expect(disk.length).toBeLessThan(2000);
    expect(disk).not.toContain('a'.repeat(400));
  });

  test('parseRecord rejects a giant from on disk as corrupt', async () => {
    const giant = `${'b'.repeat(400)}@x.example`;
    writeFileSync(
      sendLogPathForTests(),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'snd_deadbeefdeadbeefdeadbeef',
        sentAt: '2026-08-14T00:00:00.000Z',
        from: giant,
        to: ['owl@example.net'],
        subject: 'x',
        messageId: null,
        result: 'queued',
        source: 'api',
      })}\n`,
      { mode: 0o600 },
    );
    await expect(querySendLog({ limit: 20 })).rejects.toMatchObject({ code: 'send_log_corrupt' });
  });

  test('hard cap drop-oldest on append and compact by size', async () => {
    setSendLogCapsForTests({ rows: 3, bytes: 8 * 1024 * 1024 });
    let t = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => t);
    await seed({ subject: 'one' });
    t += 1000;
    await seed({ subject: 'two' });
    t += 1000;
    await seed({ subject: 'three' });
    t += 1000;
    await seed({ subject: 'four' });
    const page = await querySendLog({ limit: 20 });
    expect(page.items.map((row) => row.subject)).toEqual(['four', 'three', 'two']);
    setSendLogCapsForTests({ rows: 10_000, bytes: 80 });
    const compact = await compactSendLog();
    expect(compact.kept).toBeLessThan(3);
    expect(compact.dropped).toBeGreaterThan(0);
  });

  test('torn trailing line is isolated without fail-closing the log', async () => {
    // 夹具行 sentAt 固定 2026-08-14T00:00:00Z；钉测试时钟，使该行落在 30 天保留窗内后再 seed/query。
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now);
    const good = JSON.stringify({
      schemaVersion: 1,
      id: 'snd_aaaaaaaaaaaaaaaaaaaaaaaa',
      sentAt: '2026-08-14T00:00:00.000Z',
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'complete',
      messageId: null,
      result: 'queued',
      source: 'api',
    });
    writeFileSync(sendLogPathForTests(), `${good}\n{"schemaVersion":1,"id":"snd_torn`, { mode: 0o600 });
    const before = sendLogInspectCountForTests();
    await seed({ subject: 'after-torn' });
    expect(sendLogInspectCountForTests()).toBe(before);
    const page = await querySendLog({ limit: 20 });
    expect(page.items.map((row) => row.subject).sort()).toEqual(['after-torn', 'complete']);
    expect(readFileSync(`${sendLogPathForTests()}.partial`, 'utf8')).toContain('snd_torn');
  });

  test('complete last line missing newline is kept then appended', async () => {
    // 夹具行 sentAt 固定 2026-08-14T00:00:00Z；钉测试时钟，使该行落在 30 天保留窗内后再 seed/query。
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now);
    const good = JSON.stringify({
      schemaVersion: 1,
      id: 'snd_bbbbbbbbbbbbbbbbbbbbbbbb',
      sentAt: '2026-08-14T00:00:00.000Z',
      from: 'fox@test.example',
      to: ['owl@example.net'],
      subject: 'no-nl',
      messageId: null,
      result: 'queued',
      source: 'api',
    });
    writeFileSync(sendLogPathForTests(), good, { mode: 0o600 });
    await seed({ subject: 'next' });
    const page = await querySendLog({ limit: 20 });
    expect(page.items.map((row) => row.subject).sort()).toEqual(['next', 'no-nl']);
  });

  test('append hot path does not full-reparse as the file grows', async () => {
    // 夹具行 sentAt 固定 2026-08-14T00:00:00Z；钉测试时钟，避免 30 天保留窗滤掉预置行。
    const now = Date.parse('2026-08-14T12:00:00.000Z');
    setSendLogNowForTests(() => now);
    const lines = Array.from({ length: 80 }, (_, i) =>
      JSON.stringify({
        schemaVersion: 1,
        id: `snd_${i.toString(16).padStart(24, '0')}`,
        sentAt: '2026-08-14T00:00:00.000Z',
        from: 'fox@test.example',
        to: ['owl@example.net'],
        subject: `pre-${i}`,
        messageId: null,
        result: 'queued',
        source: 'api',
      }),
    ).join('\n') + '\n';
    writeFileSync(sendLogPathForTests(), lines, { mode: 0o600 });
    const before = sendLogInspectCountForTests();
    await seed({ subject: 'hot' });
    await seed({ subject: 'hot-2' });
    expect(sendLogInspectCountForTests()).toBe(before);
    const page = await querySendLog({ limit: 20 });
    expect(page.items.some((row) => row.subject === 'hot-2')).toBe(true);
    expect(sendLogInspectCountForTests()).toBeGreaterThan(before);
  });

  test('first-create dir fsync failure fails persist and leaves no file', async () => {
    setSendLogDirFsyncHookForTests(() => {
      throw Object.assign(new Error('EIO: dir fsync'), { code: 'EIO' });
    });
    await expect(seed({ subject: 'new-file' })).rejects.toMatchObject({
      code: 'send_log_persist_failed',
    });
    setSendLogDirFsyncHookForTests(null);
    expect(existsSync(sendLogPathForTests())).toBe(false);
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
