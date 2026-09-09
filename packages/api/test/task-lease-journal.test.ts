import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  deleteJournalFilesForTests,
  journalPathsForTests,
  loadLeaseJournal,
  resetJournalMemoryForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
  setJournalDurableEvidenceForTests,
  upsertJournalRecord,
} = await import('../src/lib/task-lease-journal.ts');

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oae-m2-j-'));
  setJournalDataDirForTests(dir);
  setJournalDurableEvidenceForTests(() => false);
  return dir;
}

afterEach(() => {
  setJournalCrashHookForTests(null);
  setJournalDurableEvidenceForTests(null);
  resetJournalMemoryForTests();
});

describe('M2 journal 原子落盘与丢失检测', () => {
  test('空目录无权威证据 → init，不是 recovery', async () => {
    freshDir();
    const file = await loadLeaseJournal();
    expect(file.source).toBe('init');
    expect(file.records).toEqual([]);
    const paths = journalPathsForTests();
    expect(readFileSync(paths.journal, 'utf8')).toContain('"source":"init"');
    expect(readFileSync(paths.seal, 'utf8').trim().length).toBeGreaterThan(20);
  });

  test('seal 在、journal 丢 → fail-closed lost，不装成 init', async () => {
    freshDir();
    await loadLeaseJournal();
    deleteJournalFilesForTests({ journal: true, seal: false });
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_lost' });
  });

  test('两边都丢但 IMAP 已有 lease 证据 → recovery_required，不装成 init', async () => {
    freshDir();
    await loadLeaseJournal();
    deleteJournalFilesForTests({ journal: true, seal: true });
    setJournalDurableEvidenceForTests(() => true);
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_recovery_required' });
  });

  test('截断 journal → corrupt', async () => {
    freshDir();
    await loadLeaseJournal();
    writeFileSync(journalPathsForTests().journal, '{"version":1', { mode: 0o600 });
    resetJournalMemoryForTests();
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('短写注入后内存重置，磁盘不得留下半套成功记录', async () => {
    freshDir();
    await loadLeaseJournal();
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
    await loadLeaseJournal();
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
