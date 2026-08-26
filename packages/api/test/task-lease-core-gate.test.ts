import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-core-gate-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, expect, test } = await import('bun:test');
const {
  claimTask,
  renewTask,
  releaseTask,
  setTaskGetForTests,
  setTaskSendMailForTests,
} = await import('../src/lib/tasks.ts');
const { setTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const RECIPIENT = 'bravo@test.example';

afterEach(() => {
  setTaskLeasesEnabledForTests(undefined);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
});

test('#88 RED: disabled core lease operations reject before storage, locking, or SMTP', async () => {
  setTaskLeasesEnabledForTests(false);
  setTaskGetForTests(async () => { throw new Error('storage_read'); });
  setTaskSendMailForTests(async () => { throw new Error('smtp_send'); });

  await expect(claimTask({ id: ID, from: RECIPIENT })).rejects.toThrow('task_leases_disabled');
  await expect(renewTask({ id: ID, from: RECIPIENT, leaseToken: 'opaque-token' })).rejects.toThrow('task_leases_disabled');
  await expect(releaseTask({ id: ID, from: RECIPIENT, leaseToken: 'opaque-token' })).rejects.toThrow('task_leases_disabled');
});
