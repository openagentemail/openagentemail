import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-list-overlays-'));

const { afterEach, beforeEach, describe, expect, mock, test } = await import('bun:test');

type FakeMailMessage = {
  uid: number;
  envelope: {
    from: { address: string }[];
    to: { address: string }[];
    subject?: string;
    date: Date;
  };
  internalDate: Date;
  source: Buffer;
};

let fakeInboxMessages: FakeMailMessage[] = [];

class FakeImapFlow extends EventEmitter {
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search(query: { header?: Record<string, string | boolean> }) {
    const taskHeader = query?.header?.['x-oa-task'];
    if (typeof taskHeader === 'string') {
      const match = taskHeader.toLowerCase();
      return fakeInboxMessages
        .filter((msg) => msg.source.toString('utf8').toLowerCase().includes(`x-oa-task: ${match}`))
        .map((msg) => msg.uid);
    }
    return fakeInboxMessages.map((msg) => msg.uid);
  }
  async *fetch(uids: number[]) {
    for (const msg of fakeInboxMessages) {
      if (uids.includes(msg.uid)) {
        yield msg;
      }
    }
  }
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const {
  createTask,
  listTasks,
  replyTask,
  invalidateTaskListCache,
} = await import('../src/lib/tasks.ts');
const {
  clearQueuedEventsForTests,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
} = await import('./support/task-test-seams.ts');
const { config } = await import('../src/lib/config.ts');

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function v1Stamp(id: string, state: string, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}

function makeSignedMail(
  id: string,
  state: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  date: string,
  uid: number,
): FakeMailMessage {
  const stamp = v1Stamp(id, state, from, to);
  const source = Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date(date).toUTCString()}`,
      `X-OA-Task: ${id}`,
      `X-OA-Task-State: ${state}`,
      `X-OA-Task-Stamp: ${stamp}`,
      '',
      body,
    ].join('\r\n'),
  );
  return {
    uid,
    envelope: {
      from: [{ address: from }],
      to: [{ address: to }],
      subject,
      date: new Date(date),
    },
    internalDate: new Date(date),
    source,
  };
}

beforeEach(() => {
  setTaskNowForTests(() => NOW);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
  fakeInboxMessages = [];
});

afterEach(() => {
  setTaskNowForTests(null);
  setTaskGetForTests(null);
  setTaskListAllForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
  fakeInboxMessages = [];
  invalidateTaskListCache();
});

describe('issue #96: queued overlays and collection fallback in listTasks', () => {
  test('1. indexed input-required base with queued working reply returns as working with queued updatedAt', async () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    const t0 = iso(NOW - HOUR);
    fakeInboxMessages = [
      makeSignedMail(taskId, 'submitted', 'fox@test.example', 'owl@test.example', 'Task 1', 'initial', t0, 1),
      makeSignedMail(taskId, 'input-required', 'owl@test.example', 'fox@test.example', 'Task 1', 'waiting', t0, 2),
    ];

    setTaskSendMailForTests(async () => ({ messageId: '<sent-working-1@test.example>' }));

    const t1 = iso(NOW);
    await replyTask({ id: taskId, from: 'fox@test.example', body: 'working on it' });

    // IMAP still exposes only the base
    const list = await listTasks();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(taskId);
    expect(list[0]?.state).toBe('working');
    expect(list[0]?.updatedAt).toBe(t1);
  });

  test('2. listTasks(state) filters after applying queued overlays', async () => {
    const taskId = '00000000-0000-4000-8000-000000000002';
    const t0 = iso(NOW - HOUR);
    fakeInboxMessages = [
      makeSignedMail(taskId, 'submitted', 'fox@test.example', 'owl@test.example', 'Task 2', 'initial', t0, 1),
      makeSignedMail(taskId, 'input-required', 'owl@test.example', 'fox@test.example', 'Task 2', 'waiting', t0, 2),
    ];

    setTaskSendMailForTests(async () => ({ messageId: '<sent-working-2@test.example>' }));
    await replyTask({ id: taskId, from: 'fox@test.example', body: 'working on it' });

    const workingTasks = await listTasks('working');
    expect(workingTasks.filter((t) => t.id === taskId)).toHaveLength(1);
    expect(workingTasks.find((t) => t.id === taskId)?.state).toBe('working');

    const inputReqTasks = await listTasks('input-required');
    expect(inputReqTasks.filter((t) => t.id === taskId)).toHaveLength(0);
  });

  test('3. listTasks sorts descending by overlaid updatedAt', async () => {
    const taskOld = '00000000-0000-4000-8000-000000000003';
    const taskRecent = '00000000-0000-4000-8000-000000000004';
    const tOld = iso(NOW - 2 * HOUR);
    const tRecent = iso(NOW - HOUR);

    fakeInboxMessages = [
      makeSignedMail(taskOld, 'submitted', 'fox@test.example', 'owl@test.example', 'Old task', 'initial', tOld, 1),
      makeSignedMail(taskOld, 'input-required', 'owl@test.example', 'fox@test.example', 'Old task', 'old', tOld, 2),
      makeSignedMail(taskRecent, 'submitted', 'fox@test.example', 'owl@test.example', 'Recent task', 'recent', tRecent, 3),
    ];

    // Initially: taskRecent (tRecent) comes before taskOld (tOld)
    const initialList = await listTasks();
    expect(initialList.map((t) => t.id)).toEqual([taskRecent, taskOld]);

    // Mutate taskOld with a reply at NOW (which is later than tRecent)
    setTaskSendMailForTests(async () => ({ messageId: '<sent-mutation@test.example>' }));
    await replyTask({ id: taskOld, from: 'fox@test.example', body: 'reply advances timestamp' });

    // After mutation: taskOld has overlaid updatedAt = NOW, so it must sort before taskRecent
    const sortedList = await listTasks();
    expect(sortedList.map((t) => t.id)).toEqual([taskOld, taskRecent]);
  });

  test('4. once IMAP contains the queued event, list converges without duplicates and overlay retires', async () => {
    const taskId = '00000000-0000-4000-8000-000000000005';
    const t0 = iso(NOW - HOUR);
    fakeInboxMessages = [
      makeSignedMail(taskId, 'submitted', 'fox@test.example', 'owl@test.example', 'Task 5', 'initial', t0, 1),
      makeSignedMail(taskId, 'input-required', 'owl@test.example', 'fox@test.example', 'Task 5', 'waiting', t0, 2),
    ];

    setTaskSendMailForTests(async () => ({ messageId: '<sent-working-5@test.example>' }));
    const t1 = iso(NOW);
    await replyTask({ id: taskId, from: 'fox@test.example', body: 'working now' });

    const lagList = await listTasks();
    expect(lagList).toHaveLength(1);
    expect(lagList[0]?.state).toBe('working');
    expect(lagList[0]?.messages).toHaveLength(3);

    // IMAP indexes the queued working event
    fakeInboxMessages.push(
      makeSignedMail(taskId, 'working', 'fox@test.example', 'owl@test.example', 'Task 5', 'working now', t1, 3),
    );

    const convergedList = await listTasks();
    expect(convergedList).toHaveLength(1);
    expect(convergedList[0]?.id).toBe(taskId);
    expect(convergedList[0]?.state).toBe('working');
    expect(convergedList[0]?.messages).toHaveLength(3);

    // Repeated list read also retains clean converged state (overlay retired)
    const repeatedList = await listTasks();
    expect(repeatedList).toHaveLength(1);
    expect(repeatedList[0]?.messages).toHaveLength(3);
  });

  test('5. just-created ordinary task appears once during zero-row lag and converges when durable root appears', async () => {
    fakeInboxMessages = [];
    setTaskSendMailForTests(async () => ({ messageId: '<sent-root@test.example>' }));

    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Synthetic list task',
      body: 'initial create',
    });

    // Zero rows in IMAP: task appears in listTasks via synthetic base
    const lagList = await listTasks();
    const matches = lagList.filter((t) => t.id === created.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.state).toBe('submitted');
    expect(matches[0]?.messages).toHaveLength(1);

    // Durable root appears in IMAP
    fakeInboxMessages = [
      makeSignedMail(created.id, 'submitted', 'fox@test.example', 'owl@test.example', 'Synthetic list task', 'initial create', created.createdAt, 1),
    ];

    // Converges exactly once to durable root
    const convergedList = await listTasks();
    const convergedMatches = convergedList.filter((t) => t.id === created.id);
    expect(convergedMatches).toHaveLength(1);
    expect(convergedMatches[0]?.messages).toHaveLength(1);
  });

  test('6. matching invalid row (bad stamp or poisoned relationship root) suppresses synthetic fallback in listTasks', async () => {
    setTaskSendMailForTests(async () => ({ messageId: '<sent-tampered@test.example>' }));

    // Part A: Bad stamp
    const taskBadStamp = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Bad stamp task',
      body: 'will fail stamp',
    });

    const tamperedSource = Buffer.from(
      [
        'From: fox@test.example',
        'To: owl@test.example',
        'Subject: Bad stamp task',
        `X-OA-Task: ${taskBadStamp.id}`,
        'X-OA-Task-State: submitted',
        'X-OA-Task-Stamp: invalid-stamp',
        '',
        'corrupted body',
      ].join('\r\n'),
    );

    fakeInboxMessages = [
      {
        uid: 101,
        envelope: {
          from: [{ address: 'fox@test.example' }],
          to: [{ address: 'owl@test.example' }],
          subject: 'Bad stamp task',
          date: new Date(NOW),
        },
        internalDate: new Date(NOW),
        source: tamperedSource,
      },
    ];

    // Must fail closed in listTasks: synthetic base suppressed/deleted
    const listA = await listTasks();
    expect(listA.filter((t) => t.id === taskBadStamp.id)).toHaveLength(0);

    // Part B: Poisoned relationship root
    const taskPoison = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Poison root task',
      body: 'will fail root integrity',
    });

    const witness = createHmac('sha256', config.taskSigningSecret)
      .update(`openagentemail-task-root-v2-witness\n${taskPoison.id}\nsubmitted\nfox@test.example\nowl@test.example`)
      .digest('base64url');
    const poisonedStamp = `v2.${witness}.tampered-root-mac`;
    const poisonedRootHeader = Buffer.from(
      JSON.stringify({ version: 2, parentTaskId: '00000000-0000-4000-8000-000000000001' }),
      'utf8',
    ).toString('base64url');

    const poisonedSource = Buffer.from(
      [
        'From: fox@test.example',
        'To: owl@test.example',
        'Subject: Poison root task',
        `X-OA-Task: ${taskPoison.id}`,
        'X-OA-Task-State: submitted',
        `X-OA-Task-Root: ${poisonedRootHeader}`,
        `X-OA-Task-Stamp: ${poisonedStamp}`,
        '',
        'corrupted root body',
      ].join('\r\n'),
    );

    fakeInboxMessages.push({
      uid: 102,
      envelope: {
        from: [{ address: 'fox@test.example' }],
        to: [{ address: 'owl@test.example' }],
        subject: 'Poison root task',
        date: new Date(NOW),
      },
      internalDate: new Date(NOW),
      source: poisonedSource,
    });

    const listB = await listTasks();
    expect(listB.filter((t) => t.id === taskPoison.id)).toHaveLength(0);
  });
});
