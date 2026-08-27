import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-legacy-lease-history-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, expect, test: bunTest } = await import('bun:test');
const {
  claimTask,
  clearQueuedEventsForTests,
  renewTask,
  setTaskGetForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskFromMessages,
} = await import('../src/lib/tasks.ts');
const { claimLeaseHeadersForTests, parseTaskMessageForTests, withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');

const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));
const ID = '7e4d3267-056e-47c1-a65c-b29d39f66b83';
const A = 'alpha@test.example';
const B = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

function submittedRaw(): RawTaskMessage {
  return { uid: 1, from: A, to: B, subject: 'Legacy lease history', date: new Date(START).toISOString(), state: 'submitted', body: 'Please claim.' };
}

function source(from: string, to: string, headers: Record<string, string>): Buffer {
  return Buffer.from([
    `From: ${from}`,
    `To: ${to}`,
    'Subject: Legacy lease history',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    'Lease audit event.',
  ].join('\r\n'), 'utf8');
}

async function signedLease(
  uid: number,
  event: Parameters<typeof claimLeaseHeadersForTests>[0]['event'],
  state: 'working' | 'submitted' = 'working',
): Promise<RawTaskMessage> {
  const from = event.event === 'expired' ? A : B;
  const to = event.event === 'expired' ? B : A;
  const headers = claimLeaseHeadersForTests({ id: ID, state, from, to, event });
  const parsed = await parseTaskMessageForTests({
    uid,
    source: source(from, to, headers),
    envelope: { from: [{ address: from }], to: [{ address: to }], subject: 'Legacy lease history' },
    internalDate: new Date(event.at),
  } as unknown as FetchMessageObject, ID);
  if (!parsed) throw new Error('failed to construct signed legacy lease history');
  return parsed;
}

async function legacyCredential(): Promise<{ token: string; verifier: string }> {
  let durable = taskFromMessages(ID, [submittedRaw()])!;
  const sent: Array<{ headers?: Record<string, string> }> = [];
  setTaskNowForTests(() => START);
  setTaskGetForTests(async () => durable);
  setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<legacy-verifier>' }; });
  const grant = await claimTask({ id: ID, from: B, leaseSec: 300 });
  durable = grant.task;
  const payload = JSON.parse(Buffer.from(sent[0]!.headers!['X-OA-Task-Lease-Payload']!, 'base64url').toString('utf8')) as { tokenVerifier: string };
  clearQueuedEventsForTests();
  return { token: grant.leaseToken, verifier: payload.tokenVerifier };
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

test('R11 legacy authenticated renewal beyond 24h rebuilds but remains fail-closed for future renewal', async () => {
  const { token, verifier } = await legacyCredential();
  const claimAt = new Date(START).toISOString();
  const initialDeadline = new Date(START + HOUR).toISOString();
  const renewAt = new Date(START + HOUR - 1).toISOString();
  const legacyDeadline = new Date(START + DAY + HOUR).toISOString();
  const history = [
    submittedRaw(),
    await signedLease(2, { version: 1, event: 'claim', actor: B, at: claimAt, generation: 1, claimedUntil: initialDeadline, tokenVerifier: verifier }),
    await signedLease(3, { version: 1, event: 'renew', actor: B, at: renewAt, generation: 1, claimedUntil: legacyDeadline, tokenVerifier: verifier }),
  ];

  const rebuilt = taskFromMessages(ID, history);
  expect(rebuilt).not.toBeNull();
  expect(rebuilt?.lease).toMatchObject({ claimedUntil: legacyDeadline, generationClaimedAt: claimAt, firstClaimedAt: claimAt });

  setTaskNowForTests(() => START + DAY + 1);
  setTaskGetForTests(async () => rebuilt as Task);
  await expect(renewTask({ id: ID, from: B, leaseToken: 'not-the-authenticated-token' })).rejects.toThrow('stale_lease');
  await expect(renewTask({ id: ID, from: B, leaseToken: token })).rejects.toThrow('lease_tenure_exhausted');
});

test('R11 legacy later generation at seven days rebuilds but cannot claim again', async () => {
  const { verifier } = await legacyCredential();
  const firstClaimAt = new Date(START).toISOString();
  const firstDeadline = new Date(START + 300_000).toISOString();
  const expiredAt = firstDeadline;
  const laterClaimAt = new Date(START + 7 * DAY).toISOString();
  const laterDeadline = new Date(START + 7 * DAY + 300_000).toISOString();
  const history = [
    submittedRaw(),
    await signedLease(2, { version: 1, event: 'claim', actor: B, at: firstClaimAt, generation: 1, claimedUntil: firstDeadline, tokenVerifier: verifier }),
    await signedLease(3, { version: 1, event: 'expired', actor: 'server', at: expiredAt, generation: 1, claimedUntil: firstDeadline, expiredAt }),
    await signedLease(4, { version: 1, event: 'claim', actor: B, at: laterClaimAt, generation: 2, claimedUntil: laterDeadline, tokenVerifier: 'x'.repeat(43) }),
    await signedLease(5, { version: 1, event: 'expired', actor: 'server', at: laterDeadline, generation: 2, claimedUntil: laterDeadline, expiredAt: laterDeadline }),
  ];

  const rebuilt = taskFromMessages(ID, history);
  expect(rebuilt).not.toBeNull();
  expect(rebuilt?.expiredLease).toMatchObject({ leaseGeneration: 2, firstClaimedAt: firstClaimAt });

  setTaskNowForTests(() => START + 7 * DAY + 300_000);
  setTaskGetForTests(async () => rebuilt as Task);
  await expect(claimTask({ id: ID, from: B })).rejects.toThrow('lease_task_cap_exhausted');
});
