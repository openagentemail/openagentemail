const FIXTURE_SIGNING_SECRET = '01234567890123456789012345678901';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_LEASES_ENABLED = 'true';
process.env.TASK_LEASES_PENDING_JOURNAL = 'true';
process.env.TASK_SIGNING_SECRET = FIXTURE_SIGNING_SECRET;
process.env.NODE_ENV = 'test';

const { execSync } = await import('node:child_process');
const { createHash } = await import('node:crypto');
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { describe, expect, test } = await import('bun:test');
const {
  resetJournalMemoryForTests,
  setJournalDataDirForTests,
} = await import('../src/lib/task-lease-journal.ts');
const { provisionJournalInChild } = await import('./support/sigkey-provision.ts');

const WORKER_SCRIPT = join(import.meta.dir, 'support', 'task-lease-sigkill-worker.ts');
const PKG_DIR = join(import.meta.dir, '..');

async function waitForBarrierOrChildExit(
  child: { exited: Promise<number> },
  barrierPath: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(barrierPath)) return;
    const outcome = await Promise.race([
      child.exited.then((code) => ({ exited: true as const, code })),
      new Promise<{ exited: false }>((resolve) => {
        setTimeout(() => resolve({ exited: false }), 25);
      }),
    ]);
    if (outcome.exited) {
      throw new Error(`sigkill child exited before barrier (code=${outcome.code})`);
    }
  }
  throw new Error('timed out waiting for sigkill barrier');
}

describe('M2 Real Subprocess SIGKILL Tests', () => {
  test('provision helper times out inside the parent budget and reaps the child before raising', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oae-sigkey-stall-'));
    try {
      process.env.OAE_PROVISION_STALL_MS = '10000';
      const started = Date.now();
      let message = '';
      try {
        await provisionJournalInChild(dataDir, FIXTURE_SIGNING_SECRET);
      } catch (err) {
        message = (err as Error).message;
      }
      const elapsed = Date.now() - started;
      expect(message).toContain('timed out');
      expect(message).toMatch(/child reaped exit=\S+/);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      delete process.env.OAE_PROVISION_STALL_MS;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('Case A: SMTP ACCEPT 后、fate 落盘前被 SIGKILL，重启识别 unconfirmed 并重发同 identity，不新开代', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oae-sigkill-a-'));
    const syncFifo = join(dataDir, 'sync.fifo');
    const pauseFifo = join(dataDir, 'pause.fifo');
    const barrierFile = join(dataDir, 'barrier.json');
    const sentFile = join(dataDir, 'sent.json');
    const resultFile = join(dataDir, 'result.json');
    const taskId = '0fdc3207-056e-47c1-a65c-b29d39f66b83';

    try {
      execSync(`mkfifo ${syncFifo} ${pauseFifo}`);
      // Harness bootstrap in a child with the identical explicit fixture env,
      // so a shared parent-process config poisoned by earlier files cannot
      // poison the provisioned marker/seal key.
      await provisionJournalInChild(dataDir, FIXTURE_SIGNING_SECRET);

      // Spawn Child 1
      const child1 = Bun.spawn([
        process.execPath,
        WORKER_SCRIPT,
        '--mode=case-a-child-1',
        `--task-id=${taskId}`,
        `--data-dir=${dataDir}`,
        `--sync-fifo=${syncFifo}`,
        `--pause-fifo=${pauseFifo}`,
        `--barrier-file=${barrierFile}`,
        `--sent-file=${sentFile}`,
      ], {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          TASK_LEASES_ENABLED: 'true',
          TASK_LEASES_PENDING_JOURNAL: 'true',
          NODE_ENV: 'test',
          DOMAIN: 'test.example',
          API_KEYS: 'admin-key',
          IMAP_USER: 'agent@test.example',
          IMAP_PASS: 'imap-secret',
          SMTP_USER: 'agent@test.example',
          SMTP_PASS: 'smtp-secret',
          TASK_SIGNING_SECRET: FIXTURE_SIGNING_SECRET,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      // Parent waits for the post-ACCEPT barrier without a blocking FIFO open.
      await waitForBarrierOrChildExit(child1, barrierFile);

      // Read barrier record written by Child 1
      expect(existsSync(barrierFile)).toBe(true);
      const barrier = JSON.parse(readFileSync(barrierFile, 'utf8')) as {
        stage: string;
        payloadHash: string;
        generation: number;
      };
      expect(barrier.stage).toBe('at-smtp-accept-pre-fate');
      expect(barrier.generation).toBe(1);

      // Step 3 (cont): Parent reads on-disk journal, verifies payloadHash matches persisted intent
      const journalPath = join(dataDir, 'task-lease-journal', 'journal.json');
      expect(existsSync(journalPath)).toBe(true);
      const journalBeforeKill = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        records: Array<{
          taskId: string;
          generation: number;
          fate: string;
          signedPayload?: string;
        }>;
      };
      const persistedIntent = journalBeforeKill.records.find(
        (r) => r.taskId === taskId && r.generation === 1,
      );
      expect(persistedIntent).toBeDefined();
      expect(persistedIntent!.fate).toBe('intent');
      expect(persistedIntent!.signedPayload).toBeDefined();
      const diskPayloadHash = createHash('sha256')
        .update(persistedIntent!.signedPayload!)
        .digest('hex');
      expect(barrier.payloadHash).toBe(diskPayloadHash);

      // Step 3 (cont): kill(SIGKILL), waitpid, confirm PID is gone
      const childPid = child1.pid;
      process.kill(childPid, 'SIGKILL');
      await child1.exited;

      let pidDead = false;
      try {
        process.kill(childPid, 0);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'ESRCH') {
          pidDead = true;
        }
      }
      expect(pidDead).toBe(true);

      // Step 4: Parent asserts on-disk journal still shows intent — no fate committed after ACCEPT
      const journalAfterKill = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        records: Array<{
          taskId: string;
          generation: number;
          fate: string;
        }>;
      };
      const intentAfterKill = journalAfterKill.records.find(
        (r) => r.taskId === taskId && r.generation === 1,
      );
      expect(intentAfterKill).toBeDefined();
      expect(intentAfterKill!.fate).toBe('intent');

      // Step 5: Start fresh child process on the same DATA_DIR
      const child2 = Bun.spawn([
        process.execPath,
        WORKER_SCRIPT,
        '--mode=case-a-child-2',
        `--task-id=${taskId}`,
        `--data-dir=${dataDir}`,
        `--sent-file=${sentFile}`,
        `--result-file=${resultFile}`,
      ], {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          TASK_LEASES_ENABLED: 'true',
          TASK_LEASES_PENDING_JOURNAL: 'true',
          NODE_ENV: 'test',
          DOMAIN: 'test.example',
          API_KEYS: 'admin-key',
          IMAP_USER: 'agent@test.example',
          IMAP_PASS: 'imap-secret',
          SMTP_USER: 'agent@test.example',
          SMTP_PASS: 'smtp-secret',
          TASK_SIGNING_SECRET: FIXTURE_SIGNING_SECRET,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      const child2Exit = await child2.exited;
      expect(child2Exit).toBe(0);

      // Child 2 asserts: fate treated as unknown/unconfirmed, resend of same immutable identity
      // with byte-identical signed payload, no N+1, fence held (409)
      expect(existsSync(resultFile)).toBe(true);
      const result = JSON.parse(readFileSync(resultFile, 'utf8')) as {
        success: boolean;
        byteIdentical: boolean;
        noNPlusOne: boolean;
        fenceHeld: boolean;
        generation: number;
      };
      expect(result.success).toBe(true);
      expect(result.byteIdentical).toBe(true);
      expect(result.noNPlusOne).toBe(true);
      expect(result.fenceHeld).toBe(true);
      expect(result.generation).toBe(1);
    } finally {
      setJournalDataDirForTests(undefined);
      resetJournalMemoryForTests();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('Case B: intent 落盘后、SMTP 发送前被 SIGKILL，重启保持 pending fence，不新开代', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oae-sigkill-b-'));
    const syncFifo = join(dataDir, 'sync.fifo');
    const pauseFifo = join(dataDir, 'pause.fifo');
    const barrierFile = join(dataDir, 'barrier.json');
    const sentFile = join(dataDir, 'sent.json');
    const resultFile = join(dataDir, 'result.json');
    const taskId = '0fdc3207-056e-47c1-a65c-b29d39f66b83';

    try {
      execSync(`mkfifo ${syncFifo} ${pauseFifo}`);
      await provisionJournalInChild(dataDir, FIXTURE_SIGNING_SECRET);

      const child1 = Bun.spawn([
        process.execPath,
        WORKER_SCRIPT,
        '--mode=case-b-child-1',
        `--task-id=${taskId}`,
        `--data-dir=${dataDir}`,
        `--sync-fifo=${syncFifo}`,
        `--pause-fifo=${pauseFifo}`,
        `--barrier-file=${barrierFile}`,
        `--sent-file=${sentFile}`,
      ], {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          TASK_LEASES_ENABLED: 'true',
          TASK_LEASES_PENDING_JOURNAL: 'true',
          NODE_ENV: 'test',
          DOMAIN: 'test.example',
          API_KEYS: 'admin-key',
          IMAP_USER: 'agent@test.example',
          IMAP_PASS: 'imap-secret',
          SMTP_USER: 'agent@test.example',
          SMTP_PASS: 'smtp-secret',
          TASK_SIGNING_SECRET: FIXTURE_SIGNING_SECRET,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      await waitForBarrierOrChildExit(child1, barrierFile);

      expect(existsSync(barrierFile)).toBe(true);
      const barrier = JSON.parse(readFileSync(barrierFile, 'utf8')) as {
        stage: string;
        payloadHash: string;
        generation: number;
      };
      expect(barrier.stage).toBe('intent');
      expect(barrier.generation).toBe(1);

      const journalPath = join(dataDir, 'task-lease-journal', 'journal.json');
      expect(existsSync(journalPath)).toBe(true);
      const journalBeforeKill = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        records: Array<{
          taskId: string;
          generation: number;
          fate: string;
          signedPayload?: string;
        }>;
      };
      const persistedIntent = journalBeforeKill.records.find(
        (r) => r.taskId === taskId && r.generation === 1,
      );
      expect(persistedIntent).toBeDefined();
      expect(persistedIntent!.fate).toBe('intent');
      const diskPayloadHash = createHash('sha256')
        .update(persistedIntent!.signedPayload!)
        .digest('hex');
      expect(barrier.payloadHash).toBe(diskPayloadHash);

      const childPid = child1.pid;
      process.kill(childPid, 'SIGKILL');
      await child1.exited;

      let pidDead = false;
      try {
        process.kill(childPid, 0);
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'ESRCH') {
          pidDead = true;
        }
      }
      expect(pidDead).toBe(true);

      const journalAfterKill = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        records: Array<{
          taskId: string;
          generation: number;
          fate: string;
        }>;
      };
      const intentAfterKill = journalAfterKill.records.find(
        (r) => r.taskId === taskId && r.generation === 1,
      );
      expect(intentAfterKill).toBeDefined();
      expect(intentAfterKill!.fate).toBe('intent');

      const child2 = Bun.spawn([
        process.execPath,
        WORKER_SCRIPT,
        '--mode=case-b-child-2',
        `--task-id=${taskId}`,
        `--data-dir=${dataDir}`,
        `--sent-file=${sentFile}`,
        `--result-file=${resultFile}`,
      ], {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          TASK_LEASES_ENABLED: 'true',
          TASK_LEASES_PENDING_JOURNAL: 'true',
          NODE_ENV: 'test',
          DOMAIN: 'test.example',
          API_KEYS: 'admin-key',
          IMAP_USER: 'agent@test.example',
          IMAP_PASS: 'imap-secret',
          SMTP_USER: 'agent@test.example',
          SMTP_PASS: 'smtp-secret',
          TASK_SIGNING_SECRET: FIXTURE_SIGNING_SECRET,
        },
        stdout: 'inherit',
        stderr: 'inherit',
      });

      const child2Exit = await child2.exited;
      expect(child2Exit).toBe(0);

      expect(existsSync(resultFile)).toBe(true);
      const result = JSON.parse(readFileSync(resultFile, 'utf8')) as {
        success: boolean;
        fenceHeld: boolean;
        noNPlusOne: boolean;
        generation: number;
      };
      expect(result.success).toBe(true);
      expect(result.fenceHeld).toBe(true);
      expect(result.noNPlusOne).toBe(true);
      expect(result.generation).toBe(1);
    } finally {
      setJournalDataDirForTests(undefined);
      resetJournalMemoryForTests();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('parent rendezvous: child early-exit fails fast instead of hanging on FIFO', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oae-sigkill-early-'));
    const barrierFile = join(dataDir, 'barrier.json');
    try {
      const child = Bun.spawn([process.execPath, '-e', 'process.exit(7)'], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      await expect(waitForBarrierOrChildExit(child, barrierFile, 3000)).rejects.toThrow(/exited before barrier/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
