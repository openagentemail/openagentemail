import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-m2-journal-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test } = await import('bun:test');
const {
  JournalError,
  bootstrapTaskLeaseJournal,
  deleteJournalFilesForTests,
  journalPathsForTests,
  loadLeaseJournal,
  resetJournalMemoryForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
  upsertJournalRecord,
} = await import('../src/lib/task-lease-journal.ts');

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oae-m2-j-'));
  setJournalDataDirForTests(dir);
  return dir;
}

afterEach(() => {
  setJournalCrashHookForTests(null);
  resetJournalMemoryForTests();
});

describe('M2 journal 首次启用、原子落盘与丢失检测', () => {
  test('未 bootstrap 启动 → fail-closed not_bootstrapped，不自动创建任何文件', async () => {
    freshDir();
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_not_bootstrapped' });
    expect(existsSync(journalPathsForTests().dir)).toBe(false);
  });

  test('首次 bootstrap → 专属目录排他性创建，写出 marker + 空表 + seal', async () => {
    freshDir();
    const file = bootstrapTaskLeaseJournal();
    expect(file.source).toBe('bootstrap');
    expect(file.records).toEqual([]);
    const paths = journalPathsForTests();
    expect(readFileSync(paths.journal, 'utf8')).toContain('"source":"bootstrap"');
    expect(readFileSync(paths.seal, 'utf8').trim().length).toBeGreaterThan(20);
    const marker = JSON.parse(readFileSync(paths.marker, 'utf8')) as {
      version: number;
      activatedAt: string;
      journalInitializedAt: string;
      nonce: string;
      mac: string;
    };
    expect(marker.version).toBe(1);
    expect(marker.journalInitializedAt).toBe(file.initializedAt);
    expect(marker.nonce.length).toBe(64);
    expect(marker.mac.length).toBeGreaterThan(20);
  });

  test('二次 bootstrap → EEXIST 排他失败，fail-closed already_initialized', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    expect(() => bootstrapTaskLeaseJournal()).toThrow(/lease_journal_already_initialized/);
  });

  test('seal 在、journal 丢 → fail-closed lost，不装成 init', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    deleteJournalFilesForTests({ journal: true, seal: false, marker: false });
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_lost' });
  });

  test('marker 丢失或 MAC 伪造 → fail-closed corrupt', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    writeFileSync(journalPathsForTests().marker, '{"version":1,"activatedAt":"2026-08-24T00:00:00.000Z","journalInitializedAt":"2026-08-24T00:00:00.000Z","nonce":"0000000000000000000000000000000000000000000000000000000000000000","mac":"bad"}', { mode: 0o600 });
    resetJournalMemoryForTests();
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('截断 journal → corrupt', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    writeFileSync(journalPathsForTests().journal, '{"version":1', { mode: 0o600 });
    resetJournalMemoryForTests();
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('短写注入后内存重置，磁盘不得留下半套成功记录', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    setJournalCrashHookForTests('short-write');
    await expect(upsertJournalRecord({
      taskId: '0fdc3207-056e-47c1-a65c-b29d39f66b83',
      kind: 'claim', generation: 1, actor: 'bravo@test.example',
      at: '2026-08-24T00:00:00.000Z', fate: 'intent',
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'a'.repeat(43),
    })).rejects.toBeInstanceOf(JournalError);
    resetJournalMemoryForTests();
    const file = await loadLeaseJournal();
    expect(file.records).toEqual([]);
  });

  test('rename 后、seal 前崩溃：重启 fail-closed，不装成空 init', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    setJournalCrashHookForTests('after-rename');
    await expect(upsertJournalRecord({
      taskId: '0fdc3207-056e-47c1-a65c-b29d39f66b83',
      kind: 'claim', generation: 1, actor: 'bravo@test.example',
      at: '2026-08-24T00:00:00.000Z', fate: 'intent',
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'b'.repeat(43),
    })).rejects.toBeInstanceOf(JournalError);
    resetJournalMemoryForTests();
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });
});
