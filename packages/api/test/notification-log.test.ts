import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
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

const { afterEach, describe, expect, test } = await import('bun:test');
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
    expect(JSON.parse(text.trim()).logicalChannel).toBe('user-alerts');
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

  test('log file is created 0600', async () => {
    await seed({});
    const mode = (await import('node:fs')).statSync(logPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    chmodSync(logPath(), 0o600);
  });
});
