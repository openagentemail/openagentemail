import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  markJournalFate,
  resetJournalMemoryForTests,
  setJournalCrashHookForTests,
  setJournalDataDirForTests,
  unresolvedClaimFence,
  upsertJournalRecord,
  journalSuppressesExpiry,
  setJournalWriteChunkForTests,
} = await import('../src/lib/task-lease-journal.ts');

const TASK_A = '0fdc3207-056e-47c1-a65c-b29d39f66b82';
const TASK_B = '1fdc3207-056e-47c1-a65c-b29d39f66b83';

function claimIntent(taskId: string, at = '2026-08-24T00:00:00.000Z', verifier = 'a'.repeat(43)) {
  return {
    taskId,
    kind: 'claim' as const,
    generation: 1,
    actor: 'bravo@test.example',
    at,
    fate: 'intent' as const,
    claimedUntil: '2026-08-24T00:05:00.000Z',
    tokenVerifier: verifier,
  };
}

function diskRecords(): Array<{ taskId: string; fate: string; generation: number }> {
  const parsed = JSON.parse(readFileSync(journalPathsForTests().journal, 'utf8')) as {
    records: Array<{ taskId: string; fate: string; generation: number }>;
  };
  return parsed.records;
}

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

  test('热进程下 journal+seal 丢失：upsert 必 fail-closed lost，不得落盘重建，且永久 latch', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    // 关键：热进程不调 resetJournalMemoryForTests()
    const paths = journalPathsForTests();
    unlinkSync(paths.journal);
    unlinkSync(paths.seal);

    const rec = {
      taskId: '0fdc3207-056e-47c1-a65c-b29d39f66b83',
      kind: 'claim' as const,
      generation: 1,
      actor: 'bravo@test.example',
      at: '2026-08-24T00:00:00.000Z',
      fate: 'intent' as const,
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'a'.repeat(43),
    };

    // 必须拒绝，绝不能基于旧内存成功
    await expect(upsertJournalRecord(rec)).rejects.toMatchObject({ message: 'lease_journal_lost' });

    // 磁盘文件绝不能被内存重建
    expect(existsSync(paths.journal)).toBe(false);
    expect(existsSync(paths.seal)).toBe(false);

    // 状态永久 latch fail-closed
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_lost' });
    await expect(upsertJournalRecord(rec)).rejects.toMatchObject({ message: 'lease_journal_lost' });
  });

  test('热进程下 journal 被篡改/截断：写操作拦截并 latch corrupt，不覆写修复', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const paths = journalPathsForTests();
    writeFileSync(paths.journal, '{"version":1', { mode: 0o600 });

    const rec = {
      taskId: '0fdc3207-056e-47c1-a65c-b29d39f66b83',
      kind: 'claim' as const,
      generation: 1,
      actor: 'bravo@test.example',
      at: '2026-08-24T00:00:00.000Z',
      fate: 'intent' as const,
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: 'a'.repeat(43),
    };

    await expect(upsertJournalRecord(rec)).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    expect(readFileSync(paths.journal, 'utf8')).toBe('{"version":1');
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('热进程下 seal 丢失：拦截并 latch corrupt', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const paths = journalPathsForTests();
    unlinkSync(paths.seal);

    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('热进程下 marker 丢失：拦截并 latch corrupt', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const paths = journalPathsForTests();
    unlinkSync(paths.marker);

    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
    await expect(loadLeaseJournal()).rejects.toMatchObject({ message: 'lease_journal_corrupt' });
  });

  test('显式运维命令 task-lease-provision：首次排他成功，二次执行 fail-closed 退出码 1', async () => {
    const customDir = join(tmpdir(), `oae-test-prov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(customDir, { recursive: true });
    try {
      const scriptPath = join(import.meta.dir, '../src/task-lease-provision.ts');
      const env = { ...process.env, DATA_DIR: customDir, TASK_SIGNING_SECRET: '01234567890123456789012345678901' };

      const run1 = Bun.spawnSync([process.execPath, 'run', scriptPath], { env });
      expect(run1.exitCode).toBe(0);
      const out1 = JSON.parse(run1.stdout.toString());
      expect(out1.status).toBe('provisioned');

      // 验证落盘三文件
      const jDir = join(customDir, 'task-lease-journal');
      expect(existsSync(join(jDir, 'activated'))).toBe(true);
      expect(existsSync(join(jDir, 'journal.json'))).toBe(true);
      expect(existsSync(join(jDir, 'journal.seal'))).toBe(true);

      // 二次执行排他失败
      const run2 = Bun.spawnSync([process.execPath, 'run', scriptPath], { env });
      expect(run2.exitCode).toBe(1);
      const out2 = JSON.parse(run2.stderr.toString());
      expect(out2.code).toBe('lease_journal_already_initialized');
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  test('并发不同 task upsert：两次均成功，磁盘与 fresh-load 均保留两条 intent', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const recA = claimIntent(TASK_A, '2026-08-24T00:00:00.000Z', 'a'.repeat(43));
    const recB = claimIntent(TASK_B, '2026-08-24T00:00:01.000Z', 'b'.repeat(43));

    const settled = await Promise.all([
      upsertJournalRecord(recA),
      upsertJournalRecord(recB),
    ]);
    expect(settled).toHaveLength(2);

    const onDisk = diskRecords();
    expect(onDisk.map((row) => row.taskId).sort()).toEqual([TASK_A, TASK_B].sort());
    expect(onDisk.every((row) => row.fate === 'intent' && row.generation === 1)).toBe(true);

    resetJournalMemoryForTests();
    const fresh = await loadLeaseJournal();
    expect(fresh.records.map((row) => row.taskId).sort()).toEqual([TASK_A, TASK_B].sort());
    expect(unresolvedClaimFence(TASK_A, fresh)?.fate).toBe('intent');
    expect(unresolvedClaimFence(TASK_B, fresh)?.fate).toBe('intent');
  });

  test('并发 upsert 与 markFate：两条变更均持久化且 fresh-load 保留', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const recA = claimIntent(TASK_A, '2026-08-24T00:00:00.000Z', 'a'.repeat(43));
    const recB = claimIntent(TASK_B, '2026-08-24T00:00:01.000Z', 'b'.repeat(43));
    await upsertJournalRecord(recA);

    const [fated, inserted] = await Promise.all([
      markJournalFate(recA, 'accepted'),
      upsertJournalRecord(recB),
    ]);
    expect(fated.fate).toBe('accepted');
    expect(inserted.taskId).toBe(TASK_B);

    const onDisk = diskRecords();
    expect(onDisk).toHaveLength(2);
    expect(onDisk.find((row) => row.taskId === TASK_A)?.fate).toBe('accepted');
    expect(onDisk.find((row) => row.taskId === TASK_B)?.fate).toBe('intent');

    resetJournalMemoryForTests();
    const fresh = await loadLeaseJournal();
    expect(fresh.records).toHaveLength(2);
    expect(fresh.records.find((row) => row.taskId === TASK_A)?.fate).toBe('accepted');
    expect(fresh.records.find((row) => row.taskId === TASK_B)?.fate).toBe('intent');
  });

  test('before-write 失败后不重置内存：fence 不得看见未提交 intent，重试成功才落盘', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    const rec = claimIntent(TASK_A);
    setJournalCrashHookForTests('before-write');
    await expect(upsertJournalRecord(rec)).rejects.toMatchObject({
      message: 'lease_journal_crash_before_write',
    });

    expect(unresolvedClaimFence(TASK_A)).toBeUndefined();
    expect(diskRecords()).toEqual([]);

    await upsertJournalRecord(rec);
    expect(unresolvedClaimFence(TASK_A)?.fate).toBe('intent');
    expect(diskRecords().map((row) => row.taskId)).toEqual([TASK_A]);

    resetJournalMemoryForTests();
    const fresh = await loadLeaseJournal();
    expect(fresh.records).toHaveLength(1);
    expect(fresh.records[0]?.taskId).toBe(TASK_A);
    expect(fresh.records[0]?.fate).toBe('intent');
  });
});

describe('PR181 R2 A expiry predicate + E writeAll', () => {
  const UNTIL = '2026-08-24T00:05:00.000Z';
  const OTHER = '2026-08-24T00:10:00.000Z';

  function fileWith(row: {
    kind: 'claim' | 'renew' | 'release' | 'expired' | 'tombstone';
    fate: 'intent' | 'unconfirmed' | 'accepted' | 'indexed' | 'tombstoned' | 'superseded' | 'rejected';
    claimedUntil?: string;
  }) {
    return {
      version: 1 as const,
      initializedAt: '2026-08-24T00:00:00.000Z',
      source: 'bootstrap' as const,
      records: [{
        taskId: TASK_A,
        generation: 1,
        actor: 'bravo@test.example',
        at: '2026-08-24T00:00:00.000Z',
        claimedUntil: UNTIL,
        ...row,
      }],
    };
  }

  test('A: leftover indexed claim/same-window renew do not suppress; OPEN fences and closing receipts do', () => {
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'claim', fate: 'indexed' }))).toBe(false);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'claim', fate: 'superseded' }))).toBe(false);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'renew', fate: 'indexed' }))).toBe(false);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'claim', fate: 'intent' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'claim', fate: 'accepted' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'renew', fate: 'intent' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'renew', fate: 'indexed', claimedUntil: OTHER }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'release', fate: 'indexed' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'release', fate: 'intent' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'tombstone', fate: 'tombstoned' }))).toBe(true);
    expect(journalSuppressesExpiry(TASK_A, 1, UNTIL, fileWith({ kind: 'expired', fate: 'intent' }))).toBe(true);
  });

  test('E: short writeSync counts loop to completion; n<=0 fails before rename', async () => {
    freshDir();
    setJournalWriteChunkForTests(1);
    bootstrapTaskLeaseJournal();
    await upsertJournalRecord(claimIntent(TASK_A));
    expect(diskRecords()).toMatchObject([{ taskId: TASK_A, fate: 'intent', generation: 1 }]);
    resetJournalMemoryForTests();
    const fresh = await loadLeaseJournal();
    expect(fresh.records).toHaveLength(1);

    setJournalWriteChunkForTests(0);
    await expect(upsertJournalRecord(claimIntent(TASK_B, '2026-08-24T00:00:01.000Z', 'b'.repeat(43)))).rejects.toMatchObject({
      message: 'lease_journal_short_write',
    });
    expect(diskRecords()).toMatchObject([{ taskId: TASK_A, fate: 'intent', generation: 1 }]);
    expect(existsSync(`${journalPathsForTests().journal}.tmp`)).toBe(true);
  });

  test('E: crash short-write hook still fails closed without publishing', async () => {
    freshDir();
    bootstrapTaskLeaseJournal();
    setJournalCrashHookForTests('short-write');
    await expect(upsertJournalRecord(claimIntent(TASK_A))).rejects.toMatchObject({
      message: 'lease_journal_crash_short_write',
    });
    expect(diskRecords()).toEqual([]);
  });
});
