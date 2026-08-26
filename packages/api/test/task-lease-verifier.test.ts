import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-verifier-'));
process.env.TASK_LEASES_ENABLED = 'true';

const { expect, test } = await import('bun:test');
const {
  claimTask,
  clearQueuedEventsForTests,
  isTaskLeaseTokenCurrent,
  releaseTask,
  renewTask,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('../src/lib/tasks.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';

function activeTask(tokenVerifier: unknown): Task {
  return {
    id: ID,
    from: 'alpha@test.example',
    to: 'bravo@test.example',
    subject: 'Lease this task',
    state: 'working',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [],
    lease: {
      leaseGeneration: 1,
      claimedUntil: '2026-08-24T00:05:00.000Z',
      tokenVerifier: tokenVerifier as string,
    },
  };
}

test('#87 RED: verifier comparison is centralized, constant-time, and malformed values are ordinary false', () => {
  const source = readFileSync(new URL('../src/lib/tasks-internal.ts', import.meta.url), 'utf8');
  expect(source).toContain('timingSafeEqual');
  expect(isTaskLeaseTokenCurrent(activeTask('short'), 42 as unknown as string, Date.parse('2026-08-24T00:01:00.000Z'))).toBe(false);
  expect(isTaskLeaseTokenCurrent(activeTask(42), 'opaque-token', Date.parse('2026-08-24T00:01:00.000Z'))).toBe(false);
});

test('#87 GREEN: current, renew, replay, stale, and malformed persisted verifier paths retain their errors and side effects', async () => {
  let durable: Task = {
    ...activeTask('unused'),
    state: 'submitted',
    lease: undefined,
    messages: [{ id: '1', from: 'alpha@test.example', to: 'bravo@test.example', subject: 'Lease this task', date: '2026-08-24T00:00:00.000Z', state: 'submitted', body: 'claim' }],
  };
  const sent: unknown[] = [];
  setTaskNowForTests(() => Date.parse('2026-08-24T00:01:00.000Z'));
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: `<lease-${sent.length}>` }; });
  try {
    const grant = await claimTask({ id: ID, from: 'bravo@test.example' });
    expect(isTaskLeaseTokenCurrent(grant.task, grant.leaseToken)).toBe(true);
    durable = grant.task;
    clearQueuedEventsForTests();
    const renewed = await renewTask({ id: ID, from: 'bravo@test.example', leaseToken: grant.leaseToken, leaseSec: 301 });
    durable = renewed;
    clearQueuedEventsForTests();
    await expect(renewTask({ id: ID, from: 'bravo@test.example', leaseToken: 'stale-token' })).rejects.toThrow('stale_lease');
    const beforeMalformed = sent.length;
    durable = { ...renewed, lease: { ...renewed.lease!, tokenVerifier: 'short' } };
    await expect(renewTask({ id: ID, from: 'bravo@test.example', leaseToken: grant.leaseToken })).rejects.toThrow('stale_lease');
    expect(sent).toHaveLength(beforeMalformed);
    durable = renewed;
    const released = await releaseTask({ id: ID, from: 'bravo@test.example', leaseToken: grant.leaseToken, reason: 'done' });
    durable = released;
    clearQueuedEventsForTests();
    await expect(releaseTask({ id: ID, from: 'bravo@test.example', leaseToken: grant.leaseToken, reason: 'done' })).resolves.toEqual(released);
    await expect(releaseTask({ id: ID, from: 'bravo@test.example', leaseToken: 'stale-token', reason: 'done' })).rejects.toThrow('stale_lease');
  } finally {
    clearQueuedEventsForTests();
    setTaskGetForTests(null);
    setTaskNowForTests(null);
    setTaskSendMailForTests(null);
  }
});
