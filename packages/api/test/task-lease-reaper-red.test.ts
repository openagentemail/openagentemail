// #56 R8b RED: equality reclaim must durably materialize observable recovery.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchMessageObject } from 'imapflow';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-lease-reaper-red-'));
process.env.TASK_LEASES_ENABLED = 'true';
process.env.NODE_ENV = 'test';

const { afterEach, describe, expect, test } = await import('bun:test');
const {
  clearQueuedEventsForTests,
  isTaskLeaseTokenCurrent,
  reapExpiredTaskLeasesOnce,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskFromMessages,
  taskService,
  toTaskView,
} = await import('../src/lib/tasks.ts');
const { claimLeaseHeadersForTests, parseTaskMessageForTests } = await import('./support/task-lease-seams.ts');
const { startTaskLeaseReaper, TASK_LEASE_REAPER_INTERVAL_MS } = await import('../src/lib/task-lease-reaper.ts');

const ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'alpha@test.example';
const RECIPIENT = 'bravo@test.example';
const START = Date.parse('2026-08-24T00:00:00.000Z');

function submittedRaw(): RawTaskMessage {
  return {
    uid: 1,
    from: REQUESTER,
    to: RECIPIENT,
    subject: 'Lease this task',
    date: '2026-08-24T00:00:00.000Z',
    state: 'submitted',
    body: 'Please claim.',
  };
}

function submittedTask(): Task {
  return taskFromMessages(ID, [submittedRaw()])!;
}

function source(input: SendInput): Buffer {
  return Buffer.from([
    `From: ${input.from}`,
    `To: ${input.to[0]}`,
    `Subject: ${input.subject}`,
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n'), 'utf8');
}

async function parseCaptured(input: SendInput, uid: number): Promise<RawTaskMessage | null> {
  return parseTaskMessageForTests({
    uid,
    source: source(input),
    envelope: {
      from: [{ address: input.from }],
      to: [{ address: input.to[0] }],
      subject: input.subject,
    },
    internalDate: new Date(START),
  } as unknown as FetchMessageObject, ID);
}

function leaseAudit(message: RawTaskMessage): { event?: unknown; generation?: unknown; at?: unknown } | undefined {
  return message.lease as { event?: unknown; generation?: unknown; at?: unknown } | undefined;
}

function expiryEvent(input: { claimedUntil: string; at?: string; actor?: string }) {
  const at = input.at ?? input.claimedUntil;
  return {
    version: 1 as const,
    event: 'expired' as const,
    actor: (input.actor ?? 'server') as 'server',
    at,
    generation: 1,
    claimedUntil: input.claimedUntil,
    expiredAt: at,
  };
}

function expiryDelivery(input: { claimedUntil: string; actor?: string }): SendInput {
  const event = expiryEvent(input);
  return {
    from: REQUESTER,
    to: [RECIPIENT],
    subject: 'Lease this task',
    text: 'Lease expired.',
    headers: claimLeaseHeadersForTests({
      id: ID,
      state: 'working',
      from: REQUESTER,
      to: RECIPIENT,
      event: event as Parameters<typeof claimLeaseHeadersForTests>[0]['event'],
    }),
  };
}

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
});

describe('#56 R8b explicit server lease expiry reaper RED', () => {
  test('equality reclaim durably orders one authenticated server expiry audit before generation 2', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    const warnings: unknown[][] = [];
    const priorWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r8b-${sent.length}>` };
      });

      if (!taskService.claim) throw new Error('shipped claim service is unavailable');
      const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
      const firstCaptured = await parseCaptured(sent[0]!, 2);
      expect(firstCaptured).not.toBeNull();
      durable = taskFromMessages(ID, [submittedRaw(), firstCaptured!])!;
      expect(isTaskLeaseTokenCurrent(durable, first.leaseToken)).toBe(true);

      // Simulate a fresh process at the half-open equality boundary: only
      // parser-authenticated durable mail is available before the reclaim.
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      expect(isTaskLeaseTokenCurrent(durable, first.leaseToken)).toBe(false);
      const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
      const captured = await Promise.all(sent.map((message, index) => parseCaptured(message, index + 2)));
      const authenticated = captured.filter((message): message is RawTaskMessage => message !== null);
      const rebuilt = taskFromMessages(ID, [submittedRaw(), ...authenticated]);
      const publicView = rebuilt ? toTaskView(rebuilt) : null;
      const audit = authenticated
        .map((message, index) => ({ index, lease: leaseAudit(message) }))
        .find(({ lease }) => lease?.event === 'expired' && lease.generation === 1);

      // This is deliberately one composite desired observation. Current
      // production proves every non-reaper seam, then solely lacks the
      // parser-authenticated, durable recovery delivery between the claims.
      expect({
        generation2: second.leaseGeneration,
        orderedAuthenticatedEvents: authenticated.map((message) => {
          const lease = leaseAudit(message);
          return `${String(lease?.event)}:${String(lease?.generation)}`;
        }),
        expiryAudit: audit && {
          generation: audit.lease!.generation,
          at: audit.lease!.at,
          orderedBeforeGeneration2: audit.index < authenticated.length - 1,
        },
        rebuilt: rebuilt && {
          generation: rebuilt.lease?.leaseGeneration,
          generation2BearerCurrent: isTaskLeaseTokenCurrent(rebuilt, second.leaseToken),
          generation1BearerCurrent: isTaskLeaseTokenCurrent(rebuilt, first.leaseToken),
        },
        deliveries: sent.length,
        bearerAbsentFromMailPublicAndWarnings: !JSON.stringify({ sent, publicView, warnings }).includes(first.leaseToken),
      }).toEqual({
        generation2: 2,
        orderedAuthenticatedEvents: ['claim:1', 'expired:1', 'claim:2'],
        expiryAudit: {
          generation: 1,
          at: first.claimedUntil,
          orderedBeforeGeneration2: true,
        },
        rebuilt: {
          generation: 2,
          generation2BearerCurrent: true,
          generation1BearerCurrent: false,
        },
        deliveries: 3,
        bearerAbsentFromMailPublicAndWarnings: true,
      });
    } finally {
      console.warn = priorWarn;
    }
  });

  test('before equality no second claim or expiry-shaped delivery occurs', async () => {
    let now = START;
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8b-pre-expiry-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    now = Date.parse(first.claimedUntil) - 1;
    await expect(taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 })).rejects.toThrow('lease_already_claimed');
    expect(sent).toHaveLength(1);
  });

  test('terminal and admin-closed tasks cannot produce a reaper-shaped audit', async () => {
    const sent: SendInput[] = [];
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: '<unexpected-r8b-terminal-delivery>' };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    for (const current of [
      { ...submittedTask(), state: 'completed' as const },
      { ...submittedTask(), state: 'failed' as const, result: { closed_by_admin: true } },
    ]) {
      setTaskGetForTests(async () => current);
      await expect(taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 })).rejects.toThrow('task_not_claimable');
    }
    expect(sent).toHaveLength(0);
  });

  test('generation-1 bearer remains fenced after equality reclaim', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8b-fence-${sent.length}>` };
    });
    if (!taskService.claim || !taskService.renew) throw new Error('shipped lease service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    await expect(taskService.renew({ id: ID, from: RECIPIENT, leaseToken: first.leaseToken, leaseSec: 300 })).rejects.toThrow('stale_lease');
    expect({
      generation2: second.leaseGeneration,
      oldBearerCurrent: isTaskLeaseTokenCurrent(second.task, first.leaseToken),
      deliveries: sent.length,
    }).toEqual({ generation2: 2, oldBearerCurrent: false, deliveries: 3 });
  });

  test('parser accepts only the signed server actor, treats the envelope as transport, and redacts token plus verifier', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8c-parser-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const claim = await parseCaptured(sent[0]!, 2);
    durable = taskFromMessages(ID, [submittedRaw(), claim!])!;
    now = Date.parse(first.claimedUntil);
    const delivery = expiryDelivery({ claimedUntil: first.claimedUntil });
    const expiry = await parseCaptured(delivery, 3);
    const rebuilt = expiry ? taskFromMessages(ID, [submittedRaw(), claim!, expiry]) : null;
    const forged = await parseCaptured(expiryDelivery({ claimedUntil: first.claimedUntil, actor: RECIPIENT }), 4);
    const verifier = first.task.lease!.tokenVerifier;
    expect({
      serverEnvelopeParses: expiry !== null,
      expiredAuthorityIsInactive: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      envelopeActorForgeryRejected: forged === null,
      tokenAndVerifierAbsentFromReadableExpiryPath: !JSON.stringify({ delivery, expiry, public: rebuilt && toTaskView(rebuilt) }).includes(first.leaseToken)
        && !JSON.stringify({ delivery, expiry, public: rebuilt && toTaskView(rebuilt) }).includes(verifier),
    }).toEqual({
      serverEnvelopeParses: true,
      expiredAuthorityIsInactive: false,
      envelopeActorForgeryRejected: true,
      tokenAndVerifierAbsentFromReadableExpiryPath: true,
    });
  });

  test('one-shot reaper retries SMTP failure, survives index lag, and durably rebuilds its expiry audit', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    let failExpiry = false;
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      if (failExpiry) throw new Error('temporary smtp failure');
      sent.push(input);
      return { messageId: `<r8c-reap-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    now = Date.parse(first.claimedUntil);
    failExpiry = true;
    await expect(reapExpiredTaskLeasesOnce()).rejects.toThrow('temporary smtp failure');
    expect(sent).toHaveLength(1);
    failExpiry = false;
    expect(await reapExpiredTaskLeasesOnce()).toBe(1);
    const expiry = await parseCaptured(sent[1]!, 3);
    const rebuilt = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!, expiry!]);
    // IMAP still returns the old durable claim; the accepted queued expiry
    // nevertheless dominates it so reclaim is immediate and becomes gen 2.
    const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    expect({
      rebuiltOldBearerCurrent: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      generation2: second.leaseGeneration,
      deliveries: sent.length,
    }).toEqual({ rebuiltOldBearerCurrent: false, generation2: 2, deliveries: 3 });
  });

  test('reaper races are lock-linearized with reclaim, renew, release, and admin close', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    const install = () => {
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r8c-race-${sent.length}>` };
      });
    };
    const restartFromFirstClaim = async () => {
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      clearQueuedEventsForTests();
      install();
    };
    if (!taskService.claim || !taskService.renew || !taskService.release) throw new Error('shipped lease service is unavailable');

    install();
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    await restartFromFirstClaim();
    now = Date.parse(first.claimedUntil);
    const [, second] = await Promise.all([
      reapExpiredTaskLeasesOnce(),
      taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 }),
    ]);
    expect({ generation2: second.leaseGeneration, expiryDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length }).toEqual({
      generation2: 2, expiryDeliveries: 1,
    });

    // Each following operation wins while still unexpired; a later reaper
    // round must re-read under the lock and leave that newer/closed authority.
    sent.length = 0;
    clearQueuedEventsForTests();
    now = START;
    durable = submittedTask();
    install();
    const renewable = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    await restartFromFirstClaim();
    now = Date.parse(renewable.claimedUntil) - 1;
    await Promise.all([reapExpiredTaskLeasesOnce(), taskService.renew({ id: ID, from: RECIPIENT, leaseToken: renewable.leaseToken, leaseSec: 301 })]);
    now = Date.parse(renewable.claimedUntil);
    expect({ afterRenew: await reapExpiredTaskLeasesOnce(), expiryDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length }).toEqual({ afterRenew: 0, expiryDeliveries: 0 });

    sent.length = 0;
    clearQueuedEventsForTests();
    now = START;
    durable = submittedTask();
    install();
    const releasable = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    await restartFromFirstClaim();
    now = Date.parse(releasable.claimedUntil) - 1;
    await Promise.all([reapExpiredTaskLeasesOnce(), taskService.release({ id: ID, from: RECIPIENT, leaseToken: releasable.leaseToken, reason: 'done' })]);
    now = Date.parse(releasable.claimedUntil);
    expect({ afterRelease: await reapExpiredTaskLeasesOnce(), expiryDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length }).toEqual({ afterRelease: 0, expiryDeliveries: 0 });

    sent.length = 0;
    clearQueuedEventsForTests();
    now = START;
    durable = submittedTask();
    install();
    const closable = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    await restartFromFirstClaim();
    now = Date.parse(closable.claimedUntil) - 1;
    await Promise.all([reapExpiredTaskLeasesOnce(), taskService.close({ id: ID, from: REQUESTER, reason: 'cancelled' })]);
    now = Date.parse(closable.claimedUntil);
    expect({ afterClose: await reapExpiredTaskLeasesOnce(), expiryDeliveries: sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length }).toEqual({ afterClose: 0, expiryDeliveries: 0 });
  });

  test('a signed same-generation expiry with different timing is fail-closed rather than an exact duplicate', async () => {
    const sent: SendInput[] = [];
    setTaskNowForTests(() => START);
    setTaskGetForTests(async () => submittedTask());
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8d-timing-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const claim = await parseCaptured(sent[0]!, 2);
    const changedUntil = new Date(Date.parse(first.claimedUntil) + 1_000).toISOString();
    const changedExpiry = await parseCaptured(expiryDelivery({ claimedUntil: changedUntil }), 3);
    expect({
      parserAcceptedSignedShape: changedExpiry !== null,
      rebuildRejectedMismatchedAuthority: changedExpiry
        ? taskFromMessages(ID, [submittedRaw(), claim!, changedExpiry]) === null
        : false,
    }).toEqual({ parserAcceptedSignedShape: true, rebuildRejectedMismatchedAuthority: true });
  });

  test('exact duplicate durable expiry retains the inactive generation-1 receipt', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8d-duplicate-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const claim1 = await parseCaptured(sent[0]!, 2);
    const expiry1 = await parseCaptured(sent[1]!, 3);
    const duplicateExpiry1 = await parseCaptured(sent[1]!, 4);
    const rebuilt = taskFromMessages(ID, [submittedRaw(), claim1!, expiry1!, duplicateExpiry1!]);
    let reclaimGeneration: number | null = null;
    if (rebuilt) {
      durable = rebuilt;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      reclaimGeneration = (await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 })).leaseGeneration;
    }
    expect({
      validInactiveRebuild: rebuilt !== null,
      sameExpiredReceiptReclaimsGeneration: reclaimGeneration,
      oldBearerCurrent: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
    }).toEqual({ validInactiveRebuild: true, sameExpiredReceiptReclaimsGeneration: 2, oldBearerCurrent: false });
  });

  test('late duplicate generation-1 expiry cannot destroy authenticated generation 2', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8d-late-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const rebuilt = taskFromMessages(ID, [
      submittedRaw(),
      (await parseCaptured(sent[0]!, 2))!,
      (await parseCaptured(sent[1]!, 3))!,
      (await parseCaptured(sent[2]!, 4))!,
      (await parseCaptured(sent[1]!, 5))!,
    ]);
    expect({
      validRebuild: rebuilt !== null,
      generation2Current: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, second.leaseToken) : null,
      generation1Fenced: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
    }).toEqual({ validRebuild: true, generation2Current: true, generation1Fenced: false });
  });

  test('an adjacent exact durable expiry duplicate is publicly invisible', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8f-adjacent-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const claim1 = await parseCaptured(sent[0]!, 2);
    const expiry1 = await parseCaptured(sent[1]!, 3);
    const duplicateExpiry1 = await parseCaptured(sent[1]!, 4);
    const baseline = claim1 && expiry1
      ? taskFromMessages(ID, [submittedRaw(), claim1, expiry1])
      : null;
    const duplicated = claim1 && expiry1 && duplicateExpiry1
      ? taskFromMessages(ID, [submittedRaw(), claim1, expiry1, duplicateExpiry1])
      : null;
    const baselineView = baseline ? toTaskView(baseline) : null;
    const duplicateView = duplicated ? toTaskView(duplicated) : null;
    expect({
      baselineRebuild: baseline !== null,
      duplicateRebuild: duplicated !== null,
      completePublicViewsIdentical: baselineView !== null && duplicateView !== null
        && JSON.stringify(baselineView) === JSON.stringify(duplicateView),
      observed: {
        baseline: baselineView && {
          messageCount: baselineView.messages.length,
          state: baselineView.state,
          updatedAt: baselineView.updatedAt,
        },
        duplicate: duplicateView && {
          messageCount: duplicateView.messages.length,
          state: duplicateView.state,
          updatedAt: duplicateView.updatedAt,
        },
        generation1BearerCurrent: duplicated ? isTaskLeaseTokenCurrent(duplicated, first.leaseToken) : null,
      },
    }).toEqual({
      baselineRebuild: true,
      duplicateRebuild: true,
      completePublicViewsIdentical: true,
      observed: {
        baseline: { messageCount: 3, state: 'working', updatedAt: first.claimedUntil },
        duplicate: { messageCount: 3, state: 'working', updatedAt: first.claimedUntil },
        generation1BearerCurrent: false,
      },
    });
  });

  test('a late generation-1 exact expiry duplicate is publicly invisible after generation 2', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8f-late-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const claim1 = await parseCaptured(sent[0]!, 2);
    const expiry1 = await parseCaptured(sent[1]!, 3);
    const claim2 = await parseCaptured(sent[2]!, 4);
    const duplicateExpiry1 = await parseCaptured(sent[1]!, 5);
    const baseline = claim1 && expiry1 && claim2
      ? taskFromMessages(ID, [submittedRaw(), claim1, expiry1, claim2])
      : null;
    const duplicated = claim1 && expiry1 && claim2 && duplicateExpiry1
      ? taskFromMessages(ID, [submittedRaw(), claim1, expiry1, claim2, duplicateExpiry1])
      : null;
    const baselineView = baseline ? toTaskView(baseline) : null;
    const duplicateView = duplicated ? toTaskView(duplicated) : null;
    expect({
      baselineRebuild: baseline !== null,
      duplicateRebuild: duplicated !== null,
      completePublicViewsIdentical: baselineView !== null && duplicateView !== null
        && JSON.stringify(baselineView) === JSON.stringify(duplicateView),
      observed: {
        baseline: baselineView && {
          messageCount: baselineView.messages.length,
          state: baselineView.state,
          updatedAt: baselineView.updatedAt,
        },
        duplicate: duplicateView && {
          messageCount: duplicateView.messages.length,
          state: duplicateView.state,
          updatedAt: duplicateView.updatedAt,
        },
        generation2BearerCurrent: duplicated ? isTaskLeaseTokenCurrent(duplicated, second.leaseToken) : null,
        generation1BearerCurrent: duplicated ? isTaskLeaseTokenCurrent(duplicated, first.leaseToken) : null,
      },
    }).toEqual({
      baselineRebuild: true,
      duplicateRebuild: true,
      completePublicViewsIdentical: true,
      observed: {
        baseline: { messageCount: 4, state: 'working', updatedAt: first.claimedUntil },
        duplicate: { messageCount: 4, state: 'working', updatedAt: first.claimedUntil },
        generation2BearerCurrent: true,
        generation1BearerCurrent: false,
      },
    });
  });

  test('R14 RED: durable expiry receipt dominates same-generation queued authority without swallowing generation 2', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r14-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');

    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    now = Date.parse(first.claimedUntil);
    const firstReap = await reapExpiredTaskLeasesOnce();
    const claim = await parseCaptured(sent[0]!, 2);
    const expiry = await parseCaptured(sent[1]!, 3);
    const expiredDurable = claim && expiry ? taskFromMessages(ID, [submittedRaw(), claim, expiry]) : null;
    if (!expiredDurable) throw new Error('R14 fixture must rebuild the authenticated expiry receipt');
    durable = expiredDurable;
    // Deliberately keep the accepted claim and expiry synthetic rows: IMAP has
    // indexed the durable history, but per-row queue retirement is delayed.
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const beforeSecondReap = sent.length;
    const dominated = await taskService.get(ID);
    const dominatedView = dominated ? toTaskView(dominated) : null;
    const secondReap = await reapExpiredTaskLeasesOnce();
    const duplicateDeliveries = sent.length - beforeSecondReap;

    // A later generation is an independent authority and must not be retired
    // by the durable generation-1 expiry receipt.
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const second = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    const later = await taskService.get(ID);
    const laterView = later ? toTaskView(later) : null;

    expect({
      authenticatedHistory: claim !== null && expiry !== null && expiredDurable.expiredLease?.leaseGeneration === 1,
      sameGeneration: {
        privateLeaseGeneration: dominated?.lease?.leaseGeneration ?? null,
        expiredReceiptGeneration: dominated?.expiredLease?.leaseGeneration ?? null,
        messageCount: dominated?.messages.length ?? null,
        publicTiming: [dominatedView?.claimedUntil ?? null, dominatedView?.leaseGeneration ?? null],
        reaper: { first: firstReap, second: secondReap, duplicateDeliveries },
      },
      laterGenerationQueuedAuthority: {
        generation: second.leaseGeneration,
        privateLeaseGeneration: later?.lease?.leaseGeneration ?? null,
        publicTiming: [laterView?.claimedUntil ?? null, laterView?.leaseGeneration ?? null],
      },
    }).toEqual({
      authenticatedHistory: true,
      sameGeneration: {
        privateLeaseGeneration: null,
        expiredReceiptGeneration: 1,
        messageCount: 3,
        publicTiming: [null, null],
        reaper: { first: 1, second: 0, duplicateDeliveries: 0 },
      },
      laterGenerationQueuedAuthority: {
        generation: 2,
        privateLeaseGeneration: 2,
        publicTiming: [second.claimedUntil, 2],
      },
    });
  });

  test('at exact expiry reaper races stale renew and release, materializing exactly one audit', async () => {
    for (const operation of ['renew', 'release'] as const) {
      let now = START;
      let durable = submittedTask();
      const sent: SendInput[] = [];
      setTaskNowForTests(() => now);
      setTaskGetForTests(async () => durable);
      setTaskListAllForTests(async () => [durable]);
      setTaskSendMailForTests(async (input) => {
        sent.push(input);
        return { messageId: `<r8d-${operation}-${sent.length}>` };
      });
      if (!taskService.claim || !taskService.renew || !taskService.release) throw new Error('shipped lease service is unavailable');
      const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
      durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
      clearQueuedEventsForTests();
      setTaskGetForTests(async () => durable);
      now = Date.parse(first.claimedUntil);
      const result = await Promise.allSettled([
        reapExpiredTaskLeasesOnce(),
        operation === 'renew'
          ? taskService.renew({ id: ID, from: RECIPIENT, leaseToken: first.leaseToken, leaseSec: 300 })
          : taskService.release({ id: ID, from: RECIPIENT, leaseToken: first.leaseToken, reason: 'late' }),
      ]);
      const expiry = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired');
      const rebuilt = expiry[0]
        ? taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!, (await parseCaptured(expiry[0], 3))!])
        : null;
      expect({
        staleOperation: result[1]?.status === 'rejected' && String((result[1] as PromiseRejectedResult).reason).includes('stale_lease'),
        expiryDeliveries: expiry.length,
        authorityInactive: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      }).toEqual({ staleOperation: true, expiryDeliveries: 1, authorityInactive: false });
      clearQueuedEventsForTests();
    }
  });

  test('at exact expiry reaper and admin close leave terminal state and no later reap work', async () => {
    let now = START;
    let durable = submittedTask();
    const sent: SendInput[] = [];
    setTaskNowForTests(() => now);
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<r8d-admin-${sent.length}>` };
    });
    if (!taskService.claim) throw new Error('shipped claim service is unavailable');
    const first = await taskService.claim({ id: ID, from: RECIPIENT, leaseSec: 300 });
    durable = taskFromMessages(ID, [submittedRaw(), (await parseCaptured(sent[0]!, 2))!])!;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    now = Date.parse(first.claimedUntil);
    await Promise.all([reapExpiredTaskLeasesOnce(), taskService.close({ id: ID, from: REQUESTER, reason: 'cancelled at boundary' })]);
    const parsed = await Promise.all(sent.map((mail, index) => parseCaptured(mail, index + 2)));
    const rebuilt = taskFromMessages(ID, [submittedRaw(), ...parsed.filter((message): message is RawTaskMessage => !!message)]);
    durable = rebuilt ?? durable;
    clearQueuedEventsForTests();
    setTaskGetForTests(async () => durable);
    setTaskListAllForTests(async () => [durable]);
    const expiryDeliveries = sent.filter((mail) => mail.headers?.['X-OA-Task-Lease-Event'] === 'expired').length;
    expect({
      terminal: rebuilt?.state === 'failed',
      oldBearerInactive: rebuilt ? isTaskLeaseTokenCurrent(rebuilt, first.leaseToken) : null,
      oneWinnerExpiryCount: expiryDeliveries === 0 || expiryDeliveries === 1,
      followingReap: await reapExpiredTaskLeasesOnce(),
    }).toEqual({ terminal: true, oldBearerInactive: false, oneWinnerExpiryCount: true, followingReap: 0 });
  });

  test('fixed scheduler is 60s, single-flight, failure-isolated, and unrefd', async () => {
    let callback: (() => void) | undefined;
    let observedInterval = 0;
    let unrefd = false;
    let calls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    startTaskLeaseReaper({
      reapOnce: async () => {
        calls += 1;
        if (calls === 1) await pending;
        if (calls === 2) throw new Error('first completed round failed');
        return 0;
      },
      setInterval: (next, milliseconds) => {
        callback = next;
        observedInterval = milliseconds;
        return { unref: () => { unrefd = true; } };
      },
      warn: () => {},
    });
    callback!();
    callback!();
    expect({ calls, observedInterval, unrefd }).toEqual({ calls: 1, observedInterval: TASK_LEASE_REAPER_INTERVAL_MS, unrefd: true });
    release!();
    await Bun.sleep(1);
    callback!();
    await Bun.sleep(1);
    callback!();
    await Bun.sleep(1);
    expect(calls).toBe(3);
  });

  test('real reaper timer does not keep a child process alive', async () => {
    const startedAt = performance.now();
    const child = Bun.spawn([
      process.execPath,
      '-e',
      "import { startTaskLeaseReaper } from './src/lib/task-lease-reaper.ts'; startTaskLeaseReaper();",
    ], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        DOMAIN: 'test.example',
        API_KEYS: 'admin-key',
        IMAP_USER: 'agent@test.example',
        IMAP_PASS: 'imap-secret',
        SMTP_USER: 'agent@test.example',
        SMTP_PASS: 'smtp-secret',
        DATA_DIR: mkdtempSync(join(tmpdir(), 'oae-r8c-unref-')),
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const result = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
    ]);
    if (result === -1) child.kill();
    expect({ exitCode: result, elapsedUnderFiveSeconds: performance.now() - startedAt < 5000 }).toEqual({
      exitCode: 0,
      elapsedUnderFiveSeconds: true,
    });
  });
});
