import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-nlog-'));
process.env.TASK_SIGNING_SECRET = 'notify-log-test-secret';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const {
  NOTIFICATION_LOG_RETENTION_MS,
  appendNotificationLog,
  compactNotificationLog,
  queryNotificationLog,
  resetNotificationLogForTests,
  setNotificationLogNowForTests,
  setNotificationLogPersistHookForTests,
  summarizeNotificationLog,
  zonedDayBounds,
} = await import('../src/lib/notification-log.ts');
const { config } = await import('../src/lib/config.ts');

function logPath(): string {
  return join(config.dataDir, 'notification-log.jsonl');
}

async function seed(partial: {
  source?: 'watcher' | 'manual' | 'task' | 'verify';
  logicalTarget?: 'user' | `agent:${string}`;
  logicalChannel?: 'user-alerts' | 'user-low' | `agent:${string}`;
  level?: 'urgent' | 'normal' | 'low';
  title?: string;
  message?: string;
  sensitive?: boolean;
  identityAddress?: string;
}) {
  return appendNotificationLog({
    source: partial.source ?? 'manual',
    logicalTarget: partial.logicalTarget ?? 'user',
    logicalChannel: partial.logicalChannel ?? 'user-alerts',
    level: partial.level ?? 'normal',
    title: partial.title ?? 'title',
    message: partial.message ?? 'message',
    tags: ['email'],
    sensitive: partial.sensitive,
    identityAddress: partial.identityAddress,
  });
}

afterEach(() => {
  resetNotificationLogForTests();
});

beforeEach(() => {
  resetNotificationLogForTests();
});

describe('notification-log store', () => {
  test('successful append writes one schema row and never stores physical topic or secret', async () => {
    const row = await seed({ source: 'watcher', sensitive: true, identityAddress: 'fox@test.example' });
    expect(row.schemaVersion).toBe(1);
    expect(row.delivery).toBe('sent');
    expect(row.source).toBe('watcher');
    expect(row.sensitive).toBe(true);
    const text = readFileSync(logPath(), 'utf8');
    expect(text).not.toContain('user-alerts-');
    expect(text).not.toContain('reader-');
    expect(text).not.toContain('ntfy-admin');
    const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
    expect(JSON.parse(firstLine).logicalChannel).toBe('user-alerts');
  });

  test('query hard-clamps to 30 days even if an older row is still on disk', async () => {
    const now = Date.parse('2026-08-12T12:00:00.000Z');
    setNotificationLogNowForTests(() => now - NOTIFICATION_LOG_RETENTION_MS - 86_400_000);
    await seed({ title: 'old' });
    setNotificationLogNowForTests(() => now);
    await seed({ title: 'fresh' });
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items.map((row) => row.title)).toEqual(['fresh']);
    expect(Date.parse(page.window.from)).toBe(now - NOTIFICATION_LOG_RETENTION_MS);
  });

  test('compact drops 31-day-old rows via tmp+rename and keeps recent ones', async () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z');
    setNotificationLogNowForTests(() => now - NOTIFICATION_LOG_RETENTION_MS - 86_400_000);
    await seed({ title: 'expired' });
    setNotificationLogNowForTests(() => now);
    await seed({ title: 'kept' });
    const result = await compactNotificationLog();
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(1);
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items.map((row) => row.title)).toEqual(['kept']);
  });

  test('trailing half-line is isolated and remaining rows stay queryable', async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      logPath(),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'aaaaaaaaaaaa',
        publishedAt: new Date().toISOString(),
        source: 'manual',
        logicalTarget: 'user',
        logicalChannel: 'user-alerts',
        level: 'normal',
        title: 'ok',
        message: 'ok',
        tags: [],
        sensitive: false,
        delivery: 'sent',
      })}\n{"schemaVersion":1,"id":"partial`,
      { mode: 0o600 },
    );
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('ok');
    const partial = readFileSync(join(config.dataDir, 'notification-log.jsonl.partial'), 'utf8');
    expect(partial).toContain('"id":"partial');
  });

  test('sidecar isolate failure leaves the main log byte-for-byte unchanged', async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const torn = `${JSON.stringify({
      schemaVersion: 1,
      id: 'ffffffffffff',
      publishedAt: new Date().toISOString(),
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'normal',
      title: 'ok',
      message: 'ok',
      tags: [],
      sensitive: false,
      delivery: 'sent',
    })}\n{"schemaVersion":1,"id":"keep-me`;
    writeFileSync(logPath(), torn, { mode: 0o600 });
    // sidecar 不可写（路径是目录）：隔离失败时不得截断主日志丢掉尾行。
    mkdirSync(join(config.dataDir, 'notification-log.jsonl.partial'), { mode: 0o700 });
    await expect(queryNotificationLog({ limit: 20 })).rejects.toThrow();
    expect(readFileSync(logPath(), 'utf8')).toBe(torn);
    await expect(seed({ title: 'must-not-glue' })).rejects.toThrow();
    expect(readFileSync(logPath(), 'utf8')).toBe(torn);
  });

  test('middle corrupt line fail-closes queries instead of skipping', async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const good = {
      schemaVersion: 1,
      id: 'bbbbbbbbbbbb',
      publishedAt: new Date().toISOString(),
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'normal',
      title: 'ok',
      message: 'ok',
      tags: [],
      sensitive: false,
      delivery: 'sent',
    };
    writeFileSync(
      logPath(),
      `${JSON.stringify(good)}\n{not-json}\n${JSON.stringify({ ...good, id: 'cccccccccccc' })}\n`,
      { mode: 0o600 },
    );
    await expect(queryNotificationLog({ limit: 20 })).rejects.toMatchObject({
      code: 'notification_log_corrupt',
    });
  });

  test('opaque cursor pages newest-first and rejects a cross-filter cursor', async () => {
    const base = Date.parse('2026-08-12T15:00:00.000Z');
    for (let i = 0; i < 21; i++) {
      setNotificationLogNowForTests(() => base + i * 1000);
      await seed({ title: `n${i}`, level: 'normal' });
    }
    const pageA = await queryNotificationLog({ limit: 20, level: 'normal' });
    expect(pageA.items).toHaveLength(20);
    expect(pageA.items[0]?.title).toBe('n20');
    expect(pageA.nextCursor).toBeTruthy();
    const pageB = await queryNotificationLog({ limit: 20, level: 'normal', cursor: pageA.nextCursor! });
    expect(pageB.items).toHaveLength(1);
    expect(pageB.items[0]?.title).toBe('n0');
    await expect(
      queryNotificationLog({ limit: 20, level: 'urgent', cursor: pageA.nextCursor! }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  test('notify cursor HMAC is not the task signing secret; old task-keyed cursors fail closed', async () => {
    const base = Date.parse('2026-08-12T16:00:00.000Z');
    for (let i = 0; i < 21; i++) {
      setNotificationLogNowForTests(() => base + i * 1000);
      await seed({ title: `c${i}`, level: 'normal' });
    }
    const pageA = await queryNotificationLog({ limit: 20, level: 'normal' });
    expect(pageA.nextCursor).toBeTruthy();
    const parts = pageA.nextCursor!.split('.');
    const parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as {
      ch: string;
      lv: string;
      from: string;
      to: string;
      t: number;
      id: string;
    };
    const taskMac = createHmac('sha256', config.taskSigningSecret)
      .update(`notify-cursor-v1\n${parsed.ch}\n${parsed.lv}\n${parsed.from}\n${parsed.to}\n${parsed.t}\n${parsed.id}`)
      .digest('base64url');
    expect(taskMac).not.toBe(parts[2]);
    const oldCursor = `${parts[0]}.${parts[1]}.${taskMac}`;
    await expect(
      queryNotificationLog({ limit: 20, level: 'normal', cursor: oldCursor }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
    const pageB = await queryNotificationLog({ limit: 20, level: 'normal', cursor: pageA.nextCursor! });
    expect(pageB.items).toHaveLength(1);
  });

  test('append failure surfaces to the caller so publish can alarm without forging success rows', async () => {
    setNotificationLogPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    await expect(seed({ title: 'nope' })).rejects.toThrow('ENOSPC');
  });

  test('zonedDayBounds echoes the local calendar day as an exclusive UTC window', () => {
    const bounds = zonedDayBounds('today', 'UTC', Date.parse('2026-08-12T15:04:00.000Z'));
    expect(bounds.date).toBe('2026-08-12');
    expect(bounds.from).toBe('2026-08-12T00:00:00.000Z');
    expect(bounds.to).toBe('2026-08-13T00:00:00.000Z');
  });

  test('zonedDayBounds iterates DST offsets so Lord_Howe and Santiago midnights stay on the target day', () => {
    const wall = (iso: string, tz: string) => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(new Date(iso));
      const get = (type: string) => parts.find((part) => part.type === type)?.value;
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
    };

    const lhEnd = zonedDayBounds('2026-04-05', 'Australia/Lord_Howe');
    expect(lhEnd.from).toBe('2026-04-04T13:00:00.000Z');
    expect(lhEnd.to).toBe('2026-04-05T13:30:00.000Z');
    expect(wall(lhEnd.from, 'Australia/Lord_Howe')).toBe('2026-04-05 00:00:00');
    expect(wall(lhEnd.to, 'Australia/Lord_Howe')).toBe('2026-04-06 00:00:00');

    const lhStart = zonedDayBounds('2026-10-04', 'Australia/Lord_Howe');
    expect(lhStart.from).toBe('2026-10-03T13:30:00.000Z');
    expect(lhStart.to).toBe('2026-10-04T13:00:00.000Z');
    expect(wall(lhStart.from, 'Australia/Lord_Howe')).toBe('2026-10-04 00:00:00');
    expect(wall(lhStart.to, 'Australia/Lord_Howe')).toBe('2026-10-05 00:00:00');

    const sclBack = zonedDayBounds('2026-04-05', 'America/Santiago');
    expect(sclBack.from).toBe('2026-04-05T04:00:00.000Z');
    expect(sclBack.to).toBe('2026-04-06T04:00:00.000Z');
    expect(wall(sclBack.from, 'America/Santiago')).toBe('2026-04-05 00:00:00');
    expect(wall(sclBack.to, 'America/Santiago')).toBe('2026-04-06 00:00:00');

    // 弹簧向前：当地 00:00 不存在，区间从该日第一个可表示瞬间起。
    const sclFwd = zonedDayBounds('2026-09-06', 'America/Santiago');
    expect(sclFwd.from).toBe('2026-09-06T04:00:00.000Z');
    expect(sclFwd.to).toBe('2026-09-07T03:00:00.000Z');
    expect(wall(sclFwd.from, 'America/Santiago')).toBe('2026-09-06 01:00:00');
    expect(wall(sclFwd.to, 'America/Santiago')).toBe('2026-09-07 00:00:00');

    const shanghai = zonedDayBounds('2026-08-12', 'Asia/Shanghai');
    expect(shanghai.from).toBe('2026-08-11T16:00:00.000Z');
    expect(shanghai.to).toBe('2026-08-12T16:00:00.000Z');
    expect(wall(shanghai.from, 'Asia/Shanghai')).toBe('2026-08-12 00:00:00');
  });

  test('summary counts urgent as ringCount for the echoed day/tz window', async () => {
    const now = Date.parse('2026-08-12T08:00:00.000Z');
    setNotificationLogNowForTests(() => now);
    await seed({ level: 'urgent', title: 'ring' });
    await seed({ level: 'normal', title: 'ok' });
    const summary = await summarizeNotificationLog({ date: 'today', tz: 'UTC' });
    expect(summary.date).toBe('2026-08-12');
    expect(summary.tz).toBe('UTC');
    expect(summary.total).toBe(2);
    expect(summary.ringCount).toBe(1);
    expect(summary.byLevel).toEqual({ urgent: 1, normal: 1, low: 0 });
  });

  test('summary keeps failed urgent delivery separate from successful push totals', async () => {
    const now = Date.parse('2026-08-12T08:00:00.000Z');
    setNotificationLogNowForTests(() => now);
    await appendNotificationLog({
      source: 'watcher',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'urgent',
      title: 'not delivered',
      message: '',
      delivery: 'failed',
    });
    const summary = await summarizeNotificationLog({ date: 'today', tz: 'UTC' });
    expect(summary.total).toBe(0);
    expect(summary.ringCount).toBe(0);
    expect(summary.failedUrgentCount).toBe(1);
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items[0]).toMatchObject({ delivery: 'failed', level: 'urgent' });
  });

  test('append after a complete last record missing final newline stays readable', async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const good = {
      schemaVersion: 1,
      id: 'eeeeeeeeeeee',
      publishedAt: new Date().toISOString(),
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'normal',
      title: 'ok',
      message: 'ok',
      tags: [],
      sensitive: false,
      delivery: 'sent',
    };
    // 完好 JSON 行但故意不写末尾换行——这是可恢复态，不得和下一次 append 粘成中间损坏。
    writeFileSync(logPath(), JSON.stringify(good), { mode: 0o600 });
    await seed({ title: 'after-missing-nl' });
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items.map((row) => row.title).sort()).toEqual(['after-missing-nl', 'ok']);
    const text = readFileSync(logPath(), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.replace(/\n$/, '').split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('zonedDayBounds rejects non-existent calendar days instead of rolling them', () => {
    expect(() => zonedDayBounds('2026-02-30', 'UTC')).toThrow(RangeError);
    expect(() => zonedDayBounds('2026-04-31', 'UTC')).toThrow(RangeError);
    expect(() => zonedDayBounds('2026-02-29', 'UTC')).toThrow(RangeError);
    const leap = zonedDayBounds('2024-02-29', 'UTC');
    expect(leap.date).toBe('2024-02-29');
    expect(leap.from).toBe('2024-02-29T00:00:00.000Z');
    expect(leap.to).toBe('2024-03-01T00:00:00.000Z');
  });

  test('append after a trailing half-line isolates the fragment then writes a clean new row', async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      logPath(),
      `${JSON.stringify({
        schemaVersion: 1,
        id: 'dddddddddddd',
        publishedAt: new Date().toISOString(),
        source: 'manual',
        logicalTarget: 'user',
        logicalChannel: 'user-alerts',
        level: 'normal',
        title: 'ok',
        message: 'ok',
        tags: [],
        sensitive: false,
        delivery: 'sent',
      })}\n{"schemaVersion":1,"id":"torn`,
      { mode: 0o600 },
    );
    await seed({ title: 'after-tear' });
    const page = await queryNotificationLog({ limit: 20 });
    expect(page.items.map((row) => row.title).sort()).toEqual(['after-tear', 'ok']);
    const text = readFileSync(logPath(), 'utf8');
    expect(text).not.toContain('"id":"torn');
    expect(readFileSync(join(config.dataDir, 'notification-log.jsonl.partial'), 'utf8')).toContain('"id":"torn');
  });

  test('log file is created 0600 and DATA_DIR is 0700', async () => {
    await seed({});
    expect(statSync(logPath()).mode & 0o777).toBe(0o600);
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
  });
});
