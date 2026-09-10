// Test-only provisioning helper: run the journal bootstrap in a child process
// whose environment matches the SIGKILL crash/restart children exactly, so the
// provisioned marker/seal key is always the explicit fixture key regardless of
// what the shared parent-process config may have cached from earlier files.
import { join } from 'node:path';

const PROVISION_CHILD = join(import.meta.dir, 'sigkey-provision-child.ts');
const PKG_DIR = join(import.meta.dir, '..');

const PROVISION_TIMEOUT_MS = 3_000;

export async function provisionJournalInChild(dataDir: string, signingSecret: string): Promise<void> {
  const child = Bun.spawn([process.execPath, PROVISION_CHILD, dataDir], {
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
      TASK_SIGNING_SECRET: signingSecret,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  try {
    for (;;) {
      const outcome = await Promise.race([
        child.exited.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 100)),
      ]);
      if (outcome.done) {
        if (outcome.code !== 0) throw new Error(`provision child failed (code=${outcome.code})`);
        return;
      }
      if (Date.now() > deadline) {
        // Reap BEFORE raising: the error proves the child is already dead.
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        const reaped = await child.exited.catch(() => -1);
        throw new Error(`provision child timed out after ${PROVISION_TIMEOUT_MS}ms; child reaped exit=${reaped}`);
      }
    }
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      await child.exited.catch(() => undefined);
    }
  }
}
