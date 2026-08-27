import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-legacy-approval-history-'));
process.env.NODE_ENV = 'test';

const { afterEach, expect, test } = await import('bun:test');
const tasks = await import('../src/lib/tasks.ts');
const { parseStampedTaskMessageForTests } = await import('./support/task-lease-seams.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');

const ID = '6d4f3267-056e-47c1-a65c-b29d39f66b83';
const REQUESTER = 'legacy-requester@test.example';
const REVIEWER = 'legacy-reviewer@test.example';
const EXPIRES = '2030-08-25T00:00:00.000Z';

for (const localpart of ['legacy-requester', 'legacy-reviewer']) {
  if (!findIdentity(`${localpart}@test.example`)) createIdentity({ localpart, issueToken: false });
}

afterEach(() => {
  tasks.setTaskNowForTests(null);
  tasks.setTaskGetForTests(null);
  tasks.setTaskSendMailForTests(null);
  tasks.clearQueuedEventsForTests();
});

function actionAtCanonicalBytes(bytes: number) {
  const action = { type: 'tool', name: 'legacy-sized', arguments: { value: '' } };
  action.arguments.value = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(action), 'utf8'));
  expect(Buffer.byteLength(JSON.stringify(action), 'utf8')).toBe(bytes);
  return action;
}

/** Root-inclusive JSON depth: action itself is depth 1. */
function actionAtDepth(depth: number) {
  let argumentsValue: unknown = 'leaf';
  for (let current = 2; current < depth; current += 1) argumentsValue = { nested: argumentsValue };
  return { type: 'tool', name: `legacy-depth-${depth}`, arguments: argumentsValue };
}

async function reconstructLegacy(action: ReturnType<typeof actionAtCanonicalBytes> | ReturnType<typeof actionAtDepth>) {
  const digest = tasks.approvalActionDigest(action);
  const source = tasks.encodeStampedApprovalRequestForTests({
    id: ID,
    from: REQUESTER,
    to: REVIEWER,
    subject: 'Legacy approval history',
    body: 'Historic authenticated request.',
    action,
    expiresAt: EXPIRES,
  });
  const request = await parseStampedTaskMessageForTests({ id: ID, uid: 1, source, internalDate: '2026-08-24T00:00:00.000Z' });
  return { digest, request, rebuilt: request ? tasks.taskFromMessages(ID, [request]) : null };
}

test('R12 legacy >64KiB signed approval digest/read/rebuild remains readable while new creation is bounded', async () => {
  const action = actionAtCanonicalBytes(64 * 1024 + 1);
  const legacy = await reconstructLegacy(action);
  expect(legacy.request).not.toBeNull();
  expect(legacy.rebuilt).toMatchObject({
    kind: 'approval',
    state: 'input-required',
    approval: { digest: legacy.digest, reviewer: REVIEWER, action },
  });

  const sent: unknown[] = [];
  tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:00:00.000Z'));
  tasks.setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<unexpected-legacy-large>' }; });
  await expect(tasks.createApprovalTask({
    from: REQUESTER, to: REVIEWER, subject: 'new large', action, expiresAt: '2026-08-25T00:00:00.000Z',
  })).rejects.toThrow('approval_action_too_large');
  expect(sent).toHaveLength(0);
});

test('R12 legacy depth-11 signed approval digest/read/rebuild remains readable while new creation is bounded', async () => {
  const action = actionAtDepth(11);
  const legacy = await reconstructLegacy(action);
  expect(legacy.request).not.toBeNull();
  expect(legacy.rebuilt).toMatchObject({
    kind: 'approval',
    state: 'input-required',
    approval: { digest: legacy.digest, reviewer: REVIEWER, action },
  });

  const sent: unknown[] = [];
  tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:00:00.000Z'));
  tasks.setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<unexpected-legacy-deep>' }; });
  await expect(tasks.createApprovalTask({
    from: REQUESTER, to: REVIEWER, subject: 'new deep', action, expiresAt: '2026-08-25T00:00:00.000Z',
  })).rejects.toThrow('approval_action_too_deep');
  expect(sent).toHaveLength(0);
});

test('R12 malformed extra-field input remains invalid before bounds or delivery', async () => {
  const sent: unknown[] = [];
  tasks.setTaskNowForTests(() => Date.parse('2026-08-24T00:00:00.000Z'));
  tasks.setTaskSendMailForTests(async (input) => { sent.push(input); return { messageId: '<unexpected-malformed>' }; });
  await expect(tasks.createApprovalTask({
    from: REQUESTER,
    to: REVIEWER,
    subject: 'malformed precedence',
    action: { type: 'tool', name: 'malformed', arguments: {}, extra: 'x'.repeat(64 * 1024 + 1) } as never,
    expiresAt: '2026-08-25T00:00:00.000Z',
  })).rejects.toThrow('invalid_approval_action');
  expect(sent).toHaveLength(0);
});
