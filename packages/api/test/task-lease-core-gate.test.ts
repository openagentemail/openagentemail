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

const { afterEach, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  reapExpiredTaskLeasesOnce,
  renewTask,
  releaseTask,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskSendMailForTests,
} = await import('../src/lib/tasks.ts');
const { withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const RECIPIENT = 'bravo@test.example';

afterEach(() => {
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
});

test('#88 RED: disabled core lease operations reject before storage, locking, or SMTP', async () => {
  await withTaskLeasesEnabledForTests(false, async () => {
    setTaskGetForTests(async () => { throw new Error('storage_read'); });
    setTaskSendMailForTests(async () => { throw new Error('smtp_send'); });

    await expect(claimTask({ id: ID, from: RECIPIENT })).rejects.toThrow('task_leases_disabled');
    await expect(renewTask({ id: ID, from: RECIPIENT, leaseToken: 'opaque-token' })).rejects.toThrow('task_leases_disabled');
    await expect(releaseTask({ id: ID, from: RECIPIENT, leaseToken: 'opaque-token' })).rejects.toThrow('task_leases_disabled');
  });
});

test('#91 R1 RED: disabled direct reaper rejects before candidate list/get/lock/SMTP work', async () => {
  let listReads = 0;
  let getReads = 0;
  let sends = 0;
  await withTaskLeasesEnabledForTests(false, async () => {
    setTaskListAllForTests(async () => {
      listReads += 1;
      throw new Error('list_read');
    });
    setTaskGetForTests(async () => {
      getReads += 1;
      throw new Error('get_read');
    });
    setTaskSendMailForTests(async () => {
      sends += 1;
      throw new Error('smtp_send');
    });

    await expect(reapExpiredTaskLeasesOnce()).rejects.toThrow('task_leases_disabled');
  });
  expect({ listReads, getReads, sends }).toEqual({ listReads: 0, getReads: 0, sends: 0 });
});
