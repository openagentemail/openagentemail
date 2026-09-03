import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendInput } from '../src/lib/smtp.ts';
import type { RawTaskMessage, Task } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-parent-root-'));
process.env.NODE_ENV = 'test';

const { afterEach, beforeEach, expect, test } = await import('bun:test');
const tasks = await import('../src/lib/tasks.ts');
const taskSeams = await import('./support/task-test-seams.ts');
const { config } = await import('../src/lib/config.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { parseStampedTaskMessageForTests } = await import('./support/task-lease-seams.ts');
const { ConcurrentWaitHelper } = await import('./support/concurrent-wait.ts');
type IntegritySeams = {
  parseTaskMessageWithIntegrityForTests?: (input: {
    id: string; uid: number; source: string; internalDate: string;
  }) => Promise<unknown>;
  taskFromParsedMessagesForTests?: (id: string, messages: unknown[]) => unknown;
  setTaskIdForTests?: (fn: (() => string) | null) => void;
  observeTaskSideEffectsForTests?: () => {
    notifications: string[]; cacheInvalidations: number; queuedTaskIds: string[];
  };
  clearTaskSideEffectObserverForTests?: () => void;
};
const integrity = await import('../src/lib/tasks-internal.ts') as IntegritySeams;

const ID = '4a9d58b5-7c2e-4ca0-819a-4c36243695a1';
const PARENT = 'f0c4a8e6-1e22-4c66-8c2f-0955a20d81bf';
const OTHER_PARENT = 'b2e4c88a-9f41-4fa7-8d32-c4e7e98b45aa';
const FROM = 'root-from@test.example';
const TO = 'root-to@test.example';
const EXPIRES = '2026-09-01T00:00:00.000Z';
const ROOT_DOMAIN = 'openagentemail-task-root-v2';
const ROOT_WITNESS_DOMAIN = 'openagentemail-task-root-v2-witness';

for (const localpart of ['root-from', 'root-to']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

beforeEach(() => {
  taskSeams.setTaskGetForTests(async (id) => id === PARENT ? authenticatedTask(PARENT) : null);
  taskSeams.setTaskListAllForTests(async () => [await authenticatedTask(PARENT)]);
});

afterEach(() => {
  taskSeams.setTaskGetForTests(null);
  taskSeams.setTaskListAllForTests(null);
  taskSeams.setTaskSendMailForTests(null);
  taskSeams.clearQueuedEventsForTests();
  taskSeams.setTaskNowForTests(null);
  integrity.setTaskIdForTests?.(null);
  integrity.clearTaskSideEffectObserverForTests?.();
});

function capture(): SendInput[] {
  const sent: SendInput[] = [];
  taskSeams.setTaskSendMailForTests(async (input) => {
    sent.push(input);
    return { messageId: `<parent-root-${sent.length}@test.example>` };
  });
  return sent;
}

function rfc822(input: SendInput): string {
  return [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${input.subject}`,
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    '',
    input.text,
  ].join('\r\n');
}

function changeHeader(source: string, name: string, value: string): string {
  return source.replace(new RegExp(`^${name}:.*$`, 'm'), `${name}: ${value}`);
}

function removeHeader(source: string, name: string): string {
  return source.replace(new RegExp(`^${name}:.*\r?\n`, 'mi'), '');
}

function appendHeader(source: string, name: string, value: string): string {
  return source.replace('\r\n\r\n', `\r\n${name}: ${value}\r\n\r\n`);
}

function v1Stamp(id: string, state: string, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}

function v2RootStamp(id: string, state: string, from: string, to: string, root: string, approvalPayload = ''): string {
  const witness = createHmac('sha256', config.taskSigningSecret)
    .update(`${ROOT_WITNESS_DOMAIN}\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
  const rootMac = createHmac('sha256', config.taskSigningSecret)
    .update(`${ROOT_DOMAIN}\n${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${root}\n${approvalPayload}`)
    .digest('base64url');
  return `v2.${witness}.${rootMac}`;
}

function rootSource(id: string, parentTaskId: string, subject = 'Signed root', from = FROM, to = TO): string {
  const root = `{"version":2,"parentTaskId":"${parentTaskId}"}`;
  const rootHeader = Buffer.from(root, 'utf8').toString('base64url');
  const stamp = v2RootStamp(id, 'submitted', from, to, root);
  return rfc822({
    from, to: [to], subject, text: 'body',
    headers: {
      'X-OA-Task': id,
      'X-OA-Task-State': 'submitted',
      'X-OA-Task-Root': rootHeader,
      'X-OA-Task-Stamp': stamp,
    },
  });
}

async function parse(id: string, source: string, uid = 1) {
  return parseStampedTaskMessageForTests({ id, uid, source, internalDate: '2026-08-30T00:00:00.000Z' });
}

test('R1 RED: parented approval root uses the frozen v2 domain and deterministic signed envelope', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const created = await tasks.createApprovalTask({
    from: FROM,
    to: TO,
    subject: 'Parented approval',
    action: { type: 'change', name: 'review', arguments: {} },
    expiresAt: EXPIRES,
    parentTaskId: PARENT,
  } as Parameters<typeof tasks.createApprovalTask>[0]);

  const root = `{"version":2,"parentTaskId":"${PARENT}"}`;
  const headers = sent[0]?.headers ?? {};
  expect(created).toMatchObject({ parentTaskId: PARENT });
  expect(headers['X-OA-Task-Root']).toBe(Buffer.from(root, 'utf8').toString('base64url'));
  const approvalPayload = Buffer.from(headers['X-OA-Task-Approval-Payload']!, 'base64url').toString('utf8');
  expect(headers['X-OA-Task-Stamp']).toBe(
    v2RootStamp(created.id, 'input-required', FROM, TO, root, approvalPayload),
  );
});

test('parentless ordinary and approval creates retain their exact v1 header shapes', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  await tasks.createTask({ from: FROM, to: TO, subject: 'Legacy ordinary', body: 'body' });
  await tasks.createApprovalTask({
    from: FROM, to: TO, subject: 'Legacy approval', action: { type: 'change', name: 'review', arguments: {} }, expiresAt: EXPIRES,
  });
  expect(Object.keys(sent[0]!.headers ?? {}).sort()).toEqual(['X-OA-Task', 'X-OA-Task-Stamp', 'X-OA-Task-State']);
  expect((sent[0]!.headers ?? {})['X-OA-Task-Stamp']).toBe(v1Stamp((sent[0]!.headers ?? {})['X-OA-Task']!, 'submitted', FROM, TO));
  expect(Object.keys(sent[1]!.headers ?? {}).sort()).toEqual([
    'X-OA-Task', 'X-OA-Task-Approval-Digest', 'X-OA-Task-Approval-Event', 'X-OA-Task-Approval-Payload', 'X-OA-Task-Stamp', 'X-OA-Task-State',
  ]);
  const legacyRaw = await parse((sent[0]!.headers ?? {})['X-OA-Task']!, rfc822(sent[0]!));
  expect(tasks.taskFromMessages((sent[0]!.headers ?? {})['X-OA-Task']!, [legacyRaw!])).toMatchObject({
    from: FROM, to: TO, subject: 'Legacy ordinary', state: 'submitted',
  });
  expect(tasks.taskFromMessages((sent[0]!.headers ?? {})['X-OA-Task']!, [legacyRaw!])).not.toHaveProperty('parentTaskId');
});

test('ordinary and approval parented roots rebuild through production parser, including folded raw mail', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const ordinary = await tasks.createTask({ from: FROM, to: TO, subject: 'Parented ordinary', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]);
  const approval = await tasks.createApprovalTask({
    from: FROM, to: TO, subject: 'Parented approval', action: { type: 'change', name: 'review', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT,
  } as Parameters<typeof tasks.createApprovalTask>[0]);
  const ordinaryRaw = await parse(ordinary.id, rfc822(sent[0]!));
  const approvalRaw = await parse(approval.id, rfc822(sent[1]!));
  const folded = rfc822(sent[1]!).replace(/^X-OA-Task-Root: (.*)$/m, 'X-OA-Task-Root:\r\n $1');
  const foldedRaw = await parse(approval.id, folded);
  expect(tasks.taskFromMessages(ordinary.id, [ordinaryRaw!])).toMatchObject({ parentTaskId: PARENT });
  expect(tasks.taskFromMessages(approval.id, [approvalRaw!])).toMatchObject({ parentTaskId: PARENT, kind: 'approval' });
  expect(tasks.taskFromMessages(approval.id, [foldedRaw!])).toMatchObject({ parentTaskId: PARENT, kind: 'approval' });
});

test('parser rejects tampered, noncanonical, naked, and later relationship-bearing records', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const created = await tasks.createTask({ from: FROM, to: TO, subject: 'Tamper root', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]);
  const source = rfc822(sent[0]!);
  const rootHeader = (sent[0]!.headers ?? {})['X-OA-Task-Root']!;
  const cases = [
    changeHeader(source, 'X-OA-Task-Root', Buffer.from(`{"version":2,"parentTaskId":"${OTHER_PARENT}"}`).toString('base64url')),
    changeHeader(source, 'X-OA-Task-Root', Buffer.from(`{"parentTaskId":"${PARENT}","version":2}`).toString('base64url')),
    changeHeader(source, 'X-OA-Task-Root', Buffer.from(`{"version":3,"parentTaskId":"${PARENT}"}`).toString('base64url')),
    changeHeader(source, 'X-OA-Task-Root', Buffer.from(`{"version":2,"parentTaskId":"${PARENT}","extra":true}`).toString('base64url')),
    changeHeader(source, 'X-OA-Task-Root', '%%%'),
    changeHeader(source, 'X-OA-Task-Stamp', 'bad-stamp'),
  ];
  for (const candidate of cases) expect(await parse(created.id, candidate)).toBeNull();

  const legacy = rfc822({
    from: FROM, to: [TO], subject: 'Legacy', text: 'body',
    headers: { 'X-OA-Task': ID, 'X-OA-Task-State': 'submitted', 'X-OA-Task-Stamp': v1Stamp(ID, 'submitted', FROM, TO) },
  });
  expect(await parse(ID, appendHeader(legacy, 'X-OA-Task-Parent', PARENT))).toBeNull();

  const laterRoot = changeHeader(
    changeHeader(source, 'X-OA-Task-State', 'completed'),
    'X-OA-Task-Stamp',
    v2RootStamp(created.id, 'completed', FROM, TO, Buffer.from(rootHeader, 'base64url').toString('utf8')),
  );
  expect(await parse(created.id, laterRoot, 2)).toBeNull();
});

test('root pointer survives later v1 state events, conflicting second roots fail closed, and creation adds no root overlay', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const created = await tasks.createTask({ from: FROM, to: TO, subject: 'Independent state', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]);
  const root = await parse(created.id, rfc822(sent[0]!));
  const later = await parse(created.id, rfc822({
    from: TO, to: [FROM], subject: 'Independent state', text: 'done',
    headers: { 'X-OA-Task': created.id, 'X-OA-Task-State': 'completed', 'X-OA-Task-Stamp': v1Stamp(created.id, 'completed', TO, FROM) },
  }), 2);
  expect(tasks.taskFromMessages(created.id, [root!, later!])).toMatchObject({ parentTaskId: PARENT, state: 'completed' });

  const conflicting = { ...root!, uid: 3, parentTaskId: OTHER_PARENT } as RawTaskMessage;
  expect(tasks.taskFromMessages(created.id, [root!, conflicting])).toBeNull();

  const approval = await tasks.createApprovalTask({
    from: FROM, to: TO, subject: 'Parented approval decision', action: { type: 'change', name: 'review', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT,
  } as Parameters<typeof tasks.createApprovalTask>[0]);
  const approvalRoot = await parse(approval.id, rfc822(sent[1]!));
  const decision = tasks.encodeStampedApprovalDecisionForTests({
    id: approval.id, from: TO, to: FROM, subject: approval.subject, digest: approval.approval.digest,
    decision: 'approved', decidedAt: '2026-08-30T00:01:00.000Z',
  });
  const addedRootDecision = appendHeader(decision, 'X-OA-Task-Root', (sent[1]!.headers ?? {})['X-OA-Task-Root']!);
  expect(await parse(approval.id, addedRootDecision, 2)).toBeNull();
  const decisionRaw = await parse(approval.id, decision, 2);
  expect(tasks.taskFromMessages(approval.id, [approvalRoot!, decisionRaw!])).toMatchObject({ parentTaskId: PARENT, state: 'completed' });

  taskSeams.setTaskGetForTests(async () => null);
  expect(await tasks.getTask(created.id)).toMatchObject({ id: created.id, state: 'submitted' });
  taskSeams.clearQueuedEventsForTests();
  expect(await tasks.getTask(created.id)).toBeNull();
});

test('R1a RED: production public projections exclude the internal root pointer at every level', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const created = await tasks.createTask({
    from: FROM, to: TO, subject: 'Projection fence', body: 'body', parentTaskId: PARENT,
  } as Parameters<typeof tasks.createTask>[0]);
  const root = await parse(created.id, rfc822(sent[0]!));
  const rebuilt = tasks.taskFromMessages(created.id, [root!])!;
  const view = tasks.toTaskView(rebuilt);
  expect(view).not.toHaveProperty('parentTaskId');
  expect(view.messages[0]).not.toHaveProperty('parentTaskId');
});

test('R1a RED: parser integrity signal poisons get/list reconstruction instead of downgrading a tampered root', async () => {
  const tampered = changeHeader(
    rootSource(ID, PARENT),
    'X-OA-Task-Root',
    Buffer.from(`{"version":2,"parentTaskId":"${OTHER_PARENT}"}`, 'utf8').toString('base64url'),
  );
  const later = rfc822({
    from: TO, to: [FROM], subject: 'Signed root', text: 'working',
    headers: { 'X-OA-Task': ID, 'X-OA-Task-State': 'working', 'X-OA-Task-Stamp': v1Stamp(ID, 'working', TO, FROM) },
  });
  expect(integrity.parseTaskMessageWithIntegrityForTests).toBeFunction();
  expect(integrity.taskFromParsedMessagesForTests).toBeFunction();
  const poisoned = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID, uid: 1, source: tampered, internalDate: '2026-08-30T00:00:00.000Z',
  });
  const validLater = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID, uid: 2, source: later, internalDate: '2026-08-30T00:01:00.000Z',
  });
  expect(poisoned).toMatchObject({ kind: 'relationship-integrity-failure', taskId: ID });
  expect(integrity.taskFromParsedMessagesForTests!(ID, [poisoned, validLater])).toBeNull();
});

test('R5g an intact authenticated root survives injected tampered and stripped replays', async () => {
  const intact = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID, uid: 1, source: rootSource(ID, PARENT), internalDate: '2026-08-30T00:00:00.000Z',
  });
  const tampered = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 2,
    source: changeHeader(
      rootSource(ID, PARENT),
      'X-OA-Task-Root',
      Buffer.from(`{"version":2,"parentTaskId":"${OTHER_PARENT}"}`, 'utf8').toString('base64url'),
    ),
    internalDate: '2026-08-30T00:01:00.000Z',
  });
  const stripped = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 3,
    source: removeHeader(rootSource(ID, PARENT), 'X-OA-Task-Root'),
    internalDate: '2026-08-30T00:02:00.000Z',
  });
  const unsignedFieldReplay = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 4,
    source: changeHeader(rootSource(ID, PARENT), 'Subject', 'forged unsigned subject')
      .replace(/\r\n\r\n[\s\S]*$/, '\r\n\r\nforged unsigned body'),
    internalDate: '2026-08-30T00:03:00.000Z',
  });
  const later = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 5,
    source: rfc822({
      from: TO, to: [FROM], subject: 'Signed root', text: 'working',
      headers: { 'X-OA-Task': ID, 'X-OA-Task-State': 'working', 'X-OA-Task-Stamp': v1Stamp(ID, 'working', TO, FROM) },
    }),
    internalDate: '2026-08-30T00:04:00.000Z',
  });
  expect(tampered).toMatchObject({ kind: 'relationship-integrity-failure', taskId: ID });
  expect(stripped).toMatchObject({ kind: 'relationship-integrity-failure', taskId: ID });
  expect(unsignedFieldReplay).toMatchObject({ parentTaskId: PARENT, subject: 'forged unsigned subject', body: 'forged unsigned body' });
  const rebuilt = integrity.taskFromParsedMessagesForTests!(ID, [intact, tampered, stripped, unsignedFieldReplay, later]) as Task;
  expect(rebuilt).toMatchObject({
    parentTaskId: PARENT,
    subject: 'Signed root',
    state: 'working',
  });
  expect(rebuilt.messages).toHaveLength(2);
  expect(JSON.stringify(rebuilt)).not.toContain('forged unsigned');
});

test('R5a: deleting a v2 root header cannot downgrade ordinary or approval history to parentless', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();

  const ordinary = await tasks.createTask({
    from: FROM, to: TO, subject: 'No ordinary downgrade', body: 'body', parentTaskId: PARENT,
  } as Parameters<typeof tasks.createTask>[0]);
  const strippedOrdinary = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ordinary.id, uid: 1, source: removeHeader(rfc822(sent[0]!), 'X-OA-Task-Root'), internalDate: '2026-08-30T00:00:00.000Z',
  });
  const ordinaryLater = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ordinary.id,
    uid: 2,
    source: rfc822({
      from: TO, to: [FROM], subject: ordinary.subject, text: 'working',
      headers: { 'X-OA-Task': ordinary.id, 'X-OA-Task-State': 'working', 'X-OA-Task-Stamp': v1Stamp(ordinary.id, 'working', TO, FROM) },
    }),
    internalDate: '2026-08-30T00:01:00.000Z',
  });
  expect(strippedOrdinary).toMatchObject({ kind: 'relationship-integrity-failure', taskId: ordinary.id });
  expect(integrity.taskFromParsedMessagesForTests!(ordinary.id, [strippedOrdinary, ordinaryLater])).toBeNull();
  const ordinarySubmittedLater = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ordinary.id,
    uid: 3,
    source: rfc822({
      from: TO, to: [FROM], subject: ordinary.subject, text: 'submitted again',
      headers: { 'X-OA-Task': ordinary.id, 'X-OA-Task-State': 'submitted', 'X-OA-Task-Stamp': v1Stamp(ordinary.id, 'submitted', TO, FROM) },
    }),
    internalDate: '2026-08-30T00:02:00.000Z',
  });
  expect(ordinarySubmittedLater).toMatchObject({ state: 'submitted' });
  expect(integrity.taskFromParsedMessagesForTests!(ordinary.id, [strippedOrdinary, ordinarySubmittedLater])).toBeNull();

  const approval = await tasks.createApprovalTask({
    from: FROM,
    to: TO,
    subject: 'No approval downgrade',
    action: { type: 'change', name: 'review', arguments: {} },
    expiresAt: EXPIRES,
    parentTaskId: PARENT,
  } as Parameters<typeof tasks.createApprovalTask>[0]);
  const strippedApproval = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: approval.id, uid: 1, source: removeHeader(rfc822(sent[1]!), 'X-OA-Task-Root'), internalDate: '2026-08-30T00:00:00.000Z',
  });
  const approvalLater = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: approval.id,
    uid: 2,
    source: tasks.encodeStampedApprovalDecisionForTests({
      id: approval.id,
      from: TO,
      to: FROM,
      subject: approval.subject,
      digest: approval.approval.digest,
      decision: 'approved',
      decidedAt: '2026-08-30T00:01:00.000Z',
    }),
    internalDate: '2026-08-30T00:01:00.000Z',
  });
  expect(strippedApproval).toMatchObject({ kind: 'relationship-integrity-failure', taskId: approval.id });
  expect(integrity.taskFromParsedMessagesForTests!(approval.id, [strippedApproval, approvalLater])).toBeNull();

  const legacyRoot = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 10,
    source: rfc822({
      from: FROM, to: [TO], subject: 'Legacy survives noise', text: 'body',
      headers: { 'X-OA-Task': ID, 'X-OA-Task-State': 'submitted', 'X-OA-Task-Stamp': v1Stamp(ID, 'submitted', FROM, TO) },
    }),
    internalDate: '2026-08-30T00:00:00.000Z',
  });
  const attackerNoise = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: ID,
    uid: 11,
    source: rfc822({
      from: 'attacker@external.example', to: [TO], subject: 'forged same id', text: 'noise',
      headers: {
        'X-OA-Task': ID,
        'X-OA-Task-State': 'working',
        'X-OA-Task-Root': Buffer.from(`{"version":2,"parentTaskId":"${OTHER_PARENT}"}`, 'utf8').toString('base64url'),
        'X-OA-Task-Parent': OTHER_PARENT,
      },
    }),
    internalDate: '2026-08-30T00:03:00.000Z',
  });
  expect(attackerNoise).toBeNull();
  expect(integrity.taskFromParsedMessagesForTests!(ID, [legacyRoot, attackerNoise])).toMatchObject({ state: 'submitted' });
});

test('real independently signed roots reject changed parents, accept exact duplicate replay, and cover missing/invalid envelopes', async () => {
  const first = await parse(ID, rootSource(ID, PARENT), 1);
  const duplicate = await parse(ID, rootSource(ID, PARENT), 2);
  const conflicting = await parse(ID, rootSource(ID, OTHER_PARENT), 3);
  expect(tasks.taskFromMessages(ID, [first!, duplicate!])).toMatchObject({ parentTaskId: PARENT, state: 'submitted' });
  expect(tasks.taskFromMessages(ID, [first!, conflicting!])).toBeNull();

  const missing = changeHeader(rootSource(ID, PARENT), 'X-OA-Task-Root', Buffer.from('{"version":2}', 'utf8').toString('base64url'));
  const invalidUuid = changeHeader(rootSource(ID, PARENT), 'X-OA-Task-Root', Buffer.from('{"version":2,"parentTaskId":"not-a-uuid"}', 'utf8').toString('base64url'));
  expect(await parse(ID, missing)).toBeNull();
  expect(await parse(ID, invalidUuid)).toBeNull();
});

test('parentless approval keeps its full v1 stamp and reconstructed approval history', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  const created = await tasks.createApprovalTask({
    from: FROM, to: TO, subject: 'Legacy approval history', action: { type: 'change', name: 'review', arguments: {} }, expiresAt: EXPIRES,
  });
  const headers = sent[0]!.headers!;
  const payload = Buffer.from(headers['X-OA-Task-Approval-Payload']!, 'base64url').toString('utf8');
  expect(headers['X-OA-Task-Stamp']).toBe(
    createHmac('sha256', config.taskSigningSecret)
      .update(`approval-event-v1\n${created.id}\ninput-required\n${FROM}\n${TO}\n${payload}`)
      .digest('base64url'),
  );
  const raw = await parse(created.id, rfc822(sent[0]!));
  expect(tasks.taskFromMessages(created.id, [raw!])).toMatchObject({
    kind: 'approval', state: 'input-required', approval: { digest: created.approval.digest, reviewer: TO },
  });
  expect(tasks.taskFromMessages(created.id, [raw!])).not.toHaveProperty('parentTaskId');
});

async function authenticatedTask(id: string, from = FROM, to = TO, parentTaskId?: string): Promise<Task> {
  const source = parentTaskId
    ? rootSource(id, parentTaskId, 'durable parent', from, to)
    : rfc822({
      from, to: [to], subject: 'durable parent', text: 'body',
      headers: { 'X-OA-Task': id, 'X-OA-Task-State': 'submitted', 'X-OA-Task-Stamp': v1Stamp(id, 'submitted', from, to) },
    });
  const raw = await integrity.parseTaskMessageWithIntegrityForTests!({
    id, uid: 1, source, internalDate: '2026-08-30T00:00:00.000Z',
  });
  const rebuilt = integrity.taskFromParsedMessagesForTests!(id, [raw]) as Task | null;
  if (!rebuilt) throw new Error('fixture_reconstruction_failed');
  return rebuilt;
}

function chainId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

test('R2 parent validation rejects unavailable/nonparticipant chains before delivery and shares accepted ordinary/approval behavior', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent = capture();
  expect(integrity.observeTaskSideEffectsForTests).toBeFunction();
  const effects = integrity.observeTaskSideEffectsForTests!();
  const parents = new Map<string, Task>();
  const useParents = () => taskSeams.setTaskListAllForTests(async () => [...parents.values()].filter((task): task is Task => !!task));
  useParents();
  let unknownChild: Task | undefined;
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'no parent', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]).then((task) => { unknownChild = task; }))
    .rejects.toThrow('parent_task_not_found');
  expect(sent).toHaveLength(0);
  expect(unknownChild).toBeUndefined();
  expect(effects).toEqual({ notifications: [], cacheInvalidations: 0, queuedTaskIds: [] });
  parents.set(PARENT, await authenticatedTask(PARENT, 'other@test.example', TO));
  useParents();
  let nonparticipantApproval: Task | undefined;
  await expect(tasks.createApprovalTask({ from: FROM, to: TO, subject: 'not participant', action: { type: 'x', name: 'y', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT } as Parameters<typeof tasks.createApprovalTask>[0]).then((task) => { nonparticipantApproval = task; }))
    .rejects.toThrow('parent_task_sender_not_participant');
  expect(sent).toHaveLength(0);
  expect(nonparticipantApproval).toBeUndefined();
  expect(effects).toEqual({ notifications: [], cacheInvalidations: 0, queuedTaskIds: [] });
  parents.set(PARENT, await authenticatedTask(PARENT));
  useParents();
  const ordinary = await tasks.createTask({ from: FROM, to: TO, subject: 'accepted', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]);
  const approval = await tasks.createApprovalTask({ from: FROM, to: TO, subject: 'accepted approval', action: { type: 'x', name: 'y', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT } as Parameters<typeof tasks.createApprovalTask>[0]);
  expect(ordinary.parentTaskId).toBe(PARENT);
  expect(approval.parentTaskId).toBe(PARENT);
  expect(sent).toHaveLength(2);
  expect(effects.notifications).toEqual([TO, TO]);
  expect(effects.cacheInvalidations).toBe(2);
  expect(effects.queuedTaskIds).toEqual([]);
});

test('R2 rejects a just-created synthetic parent until its authenticated root is durably reconstructed', async () => {
  const sent = capture();
  const effects = integrity.observeTaskSideEffectsForTests!();
  taskSeams.setTaskListAllForTests(async () => []);
  const syntheticParent = await tasks.createTask({ from: FROM, to: TO, subject: 'not indexed', body: 'body' });
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'child', body: 'body', parentTaskId: syntheticParent.id } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_not_found');
  expect(sent).toHaveLength(1);
  expect(effects.notifications).toEqual([TO]);
  expect(effects.cacheInvalidations).toBe(1);
  expect(effects.queuedTaskIds).toEqual([]);
});

test('R2 parent validation fails closed on self, repeated, malformed, missing, and over-depth chains', async () => {
  const sent = capture();
  const effects = integrity.observeTaskSideEffectsForTests!();
  const parents = new Map<string, Task>();
  parents.set(PARENT, await authenticatedTask(PARENT, FROM, TO, OTHER_PARENT));
  parents.set(OTHER_PARENT, await authenticatedTask(OTHER_PARENT, FROM, TO, PARENT));
  let snapshotReads = 0;
  const useParents = () => taskSeams.setTaskListAllForTests(async () => {
    snapshotReads += 1;
    return [...parents.values()].filter((task): task is Task => !!task);
  });
  useParents();
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'cycle', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_invalid_chain');
  expect(sent).toHaveLength(0);
  expect(effects).toEqual({ notifications: [], cacheInvalidations: 0, queuedTaskIds: [] });

  const malformedRaw = await integrity.parseTaskMessageWithIntegrityForTests!({
    id: OTHER_PARENT, uid: 1, source: changeHeader(rootSource(OTHER_PARENT, PARENT), 'X-OA-Task-Root', '%%%'), internalDate: '2026-08-30T00:00:00.000Z',
  });
  expect(integrity.taskFromParsedMessagesForTests!(OTHER_PARENT, [malformedRaw])).toBeNull();
  parents.set(PARENT, await authenticatedTask(PARENT, FROM, TO, OTHER_PARENT));
  parents.set(OTHER_PARENT, null as unknown as Task);
  useParents();
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'malformed', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_invalid_chain');
  parents.set(PARENT, await authenticatedTask(PARENT, FROM, TO, OTHER_PARENT));
  parents.delete(OTHER_PARENT);
  useParents();
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'missing ancestor', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_invalid_chain');

  parents.clear();
  parents.set(PARENT, await authenticatedTask(PARENT));
  useParents();
  expect(integrity.setTaskIdForTests).toBeFunction();
  integrity.setTaskIdForTests!(() => PARENT);
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'self', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_invalid_chain');
  integrity.setTaskIdForTests!(null);
  expect(sent).toHaveLength(0);
  expect(effects).toEqual({ notifications: [], cacheInvalidations: 0, queuedTaskIds: [] });

  const valid = Array.from({ length: 64 }, (_, index) => chainId(index));
  parents.clear();
  for (const [index, id] of valid.entries()) parents.set(id, await authenticatedTask(id, FROM, TO, valid[index + 1]));
  useParents();
  snapshotReads = 0;
  await tasks.createTask({ from: FROM, to: TO, subject: 'depth 64', body: 'body', parentTaskId: valid[0]! } as Parameters<typeof tasks.createTask>[0]);
  expect(snapshotReads).toBe(1);
  const overflow = Array.from({ length: 65 }, (_, index) => chainId(index + 100));
  parents.clear();
  for (const [index, id] of overflow.entries()) parents.set(id, await authenticatedTask(id, FROM, TO, overflow[index + 1]));
  useParents();
  snapshotReads = 0;
  await expect(tasks.createTask({ from: FROM, to: TO, subject: 'depth 65', body: 'body', parentTaskId: overflow[0]! } as Parameters<typeof tasks.createTask>[0]))
    .rejects.toThrow('parent_task_invalid_chain');
  expect(snapshotReads).toBe(1);
  expect(sent).toHaveLength(1);
  expect(effects.notifications).toEqual([TO]);
  expect(effects.cacheInvalidations).toBe(1);
  expect(effects.queuedTaskIds).toEqual([]);
});

test('R5f parent validation uses one snapshot under the immediate-parent lock and delivers outside it', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  const sent: SendInput[] = [];
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
  let lookups = 0;
  taskSeams.setTaskListAllForTests(async () => {
    lookups += 1;
    await lookupGate;
    return [await authenticatedTask(PARENT)];
  });
  let releaseFirstDelivery!: () => void;
  const firstDeliveryGate = new Promise<void>((resolve) => { releaseFirstDelivery = resolve; });
  let deliveries = 0;
  taskSeams.setTaskSendMailForTests(async (input) => {
    sent.push(input);
    deliveries += 1;
    if (deliveries === 1) await firstDeliveryGate;
    return { messageId: `<parent-root-${deliveries}@test.example>` };
  });
  const waitHelper = new ConcurrentWaitHelper();
  const first = waitHelper.observe(
    tasks.createTask({ from: FROM, to: TO, subject: 'first', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]),
  );
  await waitHelper.waitUntil(() => lookups > 0, 5000, 'Timed out waiting for first lookup');
  const second = waitHelper.observe(
    tasks.createApprovalTask({ from: FROM, to: TO, subject: 'second', action: { type: 'x', name: 'y', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT } as Parameters<typeof tasks.createApprovalTask>[0]),
  );
  await Promise.resolve();
  expect(lookups).toBe(1);
  releaseLookup();
  await waitHelper.waitUntil(() => deliveries >= 2, 5000, 'Timed out waiting for concurrent deliveries');
  expect(lookups).toBe(2);
  expect(deliveries).toBe(2);
  releaseFirstDelivery();
  await Promise.all([first, second]);
  expect(sent).toHaveLength(2);

  taskSeams.setTaskListAllForTests(async () => [await authenticatedTask(PARENT, 'other@test.example', TO)]);
  const rejected = await Promise.allSettled([
    tasks.createTask({ from: FROM, to: TO, subject: 'reject ordinary', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]),
    tasks.createApprovalTask({ from: FROM, to: TO, subject: 'reject approval', action: { type: 'x', name: 'y', arguments: {} }, expiresAt: EXPIRES, parentTaskId: PARENT } as Parameters<typeof tasks.createApprovalTask>[0]),
  ]);
  expect(rejected.every((result) => result.status === 'rejected' && String(result.reason).includes('parent_task_sender_not_participant'))).toBeTrue();
  expect(sent).toHaveLength(2);
});

test('R5f wait helper immediately rejects without hanging when concurrent operation rejects during parent lookup', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  taskSeams.setTaskListAllForTests(async () => {
    throw new Error('simulated_lookup_failure');
  });
  taskSeams.setTaskSendMailForTests(async () => ({ messageId: '<never-reached@test.example>' }));

  const waitHelper = new ConcurrentWaitHelper();
  const failingOp = waitHelper.observe(
    tasks.createTask({ from: FROM, to: TO, subject: 'failing lookup', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]),
  );

  let lookups = 0;
  await expect(
    waitHelper.waitUntil(() => lookups > 0, 5000, 'Timed out waiting for lookups'),
  ).rejects.toThrow('simulated_lookup_failure');

  await expect(failingOp).rejects.toThrow('simulated_lookup_failure');
});

test('R5f wait helper immediately rejects without hanging when concurrent operation rejects during delivery', async () => {
  taskSeams.setTaskNowForTests(() => Date.parse('2026-08-30T00:00:00.000Z'));
  taskSeams.setTaskListAllForTests(async () => [await authenticatedTask(PARENT)]);
  taskSeams.setTaskSendMailForTests(async () => {
    throw new Error('simulated_delivery_failure');
  });

  const waitHelper = new ConcurrentWaitHelper();
  const failingOp = waitHelper.observe(
    tasks.createTask({ from: FROM, to: TO, subject: 'failing delivery', body: 'body', parentTaskId: PARENT } as Parameters<typeof tasks.createTask>[0]),
  );

  let deliveries = 0;
  await expect(
    waitHelper.waitUntil(() => deliveries >= 2, 5000, 'Timed out waiting for deliveries'),
  ).rejects.toThrow('simulated_delivery_failure');

  await expect(failingOp).rejects.toThrow('simulated_delivery_failure');
});

test('R5f wait helper times out with descriptive error when condition is never met', async () => {
  const waitHelper = new ConcurrentWaitHelper();
  let satisfied = false;
  await expect(
    waitHelper.waitUntil(() => satisfied, 30, 'Timed out waiting for mock condition'),
  ).rejects.toThrow(/Timed out waiting for mock condition \(waited 30ms\)/);
});

test('R5f isolated subprocess regression: rejected concurrent operation cleanly settles wait helper and exits promptly', async () => {
  const childScript = `
    import { ConcurrentWaitHelper } from './test/support/concurrent-wait.ts';
    const helper = new ConcurrentWaitHelper();
    helper.observe(new Promise((_, reject) => {
      setTimeout(() => reject(new Error('child_concurrent_failure')), 10);
    }));
    let condition = false;
    let caughtError: unknown = null;
    try {
      await helper.waitUntil(() => condition, 10000, 'Should not time out');
    } catch (err) {
      caughtError = err;
    }
    if (!(caughtError instanceof Error) || caughtError.message !== 'child_concurrent_failure') {
      throw new Error('Expected child_concurrent_failure but got: ' + String(caughtError));
    }
  `;
  const pkgDir = join(import.meta.dir, '..');
  const proc = Bun.spawn(['bun', '-e', childScript], { cwd: pkgDir, stdout: 'pipe', stderr: 'pipe' });
  let exited = false;
  proc.exited.then(() => {
    exited = true;
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Child process timed out waiting to settle'));
    }, 5000);
    timer?.unref?.();
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    expect(exitCode).toBe(0);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!exited || proc.exitCode === null) {
      proc.kill();
      await proc.exited;
    }
  }
});
