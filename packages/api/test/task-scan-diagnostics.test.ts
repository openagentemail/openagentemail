import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser, type ParsedMail } from 'mailparser';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-scan-diagnostics-'));

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

const { scanDurableTasksForTests, setTaskNowForTests, clearQueuedEventsForTests } = await import('./support/task-test-seams.ts');
const { config } = await import('../src/lib/config.ts');

const NOW = Date.parse('2026-08-12T12:00:00.000Z');

beforeEach(() => {
  setTaskNowForTests(() => NOW);
  clearQueuedEventsForTests();
  fakeInboxMessages = [];
});

afterEach(() => {
  setTaskNowForTests(null);
  clearQueuedEventsForTests();
  fakeInboxMessages = [];
});

describe('#94: durable scan single-pass MIME parsing and integrity regressions', () => {
  test('valid x-oa-task message is parsed exactly once and reconstructed normally', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const from = 'fox@test.example';
    const to = 'owl@test.example';
    const stamp = createHmac('sha256', config.taskSigningSecret)
      .update(`${id}\nsubmitted\n${from}\n${to}`)
      .digest('base64url');

    const source = Buffer.from([
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Single parse valid task',
      `X-OA-Task: ${id}`,
      'X-OA-Task-State: submitted',
      `X-OA-Task-Stamp: ${stamp}`,
      '',
      'task payload body',
    ].join('\r\n'));

    fakeInboxMessages = [{
      uid: 101,
      envelope: {
        from: [{ address: from }],
        to: [{ address: to }],
        subject: 'Single parse valid task',
        date: new Date(NOW),
      },
      internalDate: new Date(NOW),
      source,
    }];

    let parseCalls = 0;
    const countingParser = async (src: Buffer | string): Promise<ParsedMail> => {
      parseCalls += 1;
      return simpleParser(src);
    };

    const snapshot = await scanDurableTasksForTests(countingParser);

    // Proves the fetched source passed through MIME parsing exactly once
    expect(parseCalls).toBe(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]?.id).toBe(id);
    expect(snapshot.tasks[0]?.state).toBe('submitted');
    expect(snapshot.tasks[0]?.subject).toBe('Single parse valid task');
    expect(snapshot.hadMatchingRowsIds.has(id)).toBe(true);
  });

  test('authenticated relationship-integrity failure is parsed exactly once and fails closed', async () => {
    const id = '20000000-0000-4000-8000-000000000002';
    const from = 'fox@test.example';
    const to = 'owl@test.example';

    const witness = createHmac('sha256', config.taskSigningSecret)
      .update(`openagentemail-task-root-v2-witness\n${id}\nsubmitted\n${from}\n${to}`)
      .digest('base64url');
    // Tampered root mac triggers parseTaskMessage failure, falling back to relationshipIntegrityFailureFor
    const poisonedStamp = `v2.${witness}.tampered-root-mac`;
    const poisonedRootHeader = Buffer.from(
      JSON.stringify({ version: 2, parentTaskId: '00000000-0000-4000-8000-000000000001' }),
      'utf8',
    ).toString('base64url');

    const source = Buffer.from([
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Poison root task',
      `X-OA-Task: ${id}`,
      'X-OA-Task-State: submitted',
      `X-OA-Task-Root: ${poisonedRootHeader}`,
      `X-OA-Task-Stamp: ${poisonedStamp}`,
      '',
      'corrupted body',
    ].join('\r\n'));

    fakeInboxMessages = [{
      uid: 102,
      envelope: {
        from: [{ address: from }],
        to: [{ address: to }],
        subject: 'Poison root task',
        date: new Date(NOW),
      },
      internalDate: new Date(NOW),
      source,
    }];

    let parseCalls = 0;
    const countingParser = async (src: Buffer | string): Promise<ParsedMail> => {
      parseCalls += 1;
      return simpleParser(src);
    };

    const snapshot = await scanDurableTasksForTests(countingParser);

    // Prior to #94, this would be parsed 3 times (scanDurableTasks -> parseTaskMessage -> relationshipIntegrityFailureFor).
    // With #94, it is parsed exactly once.
    expect(parseCalls).toBe(1);
    // Authenticated relationship integrity failure poisons task reconstruction (fails closed)
    expect(snapshot.tasks).toHaveLength(0);
    // But hadMatchingRowsIds records that a matching row existed
    expect(snapshot.hadMatchingRowsIds.has(id)).toBe(true);
  });

  test('multiple messages across distinct tasks are each parsed exactly once', async () => {
    const id1 = '30000000-0000-4000-8000-000000000001';
    const id2 = '30000000-0000-4000-8000-000000000002';
    const from = 'fox@test.example';
    const to = 'owl@test.example';

    const stamp1 = createHmac('sha256', config.taskSigningSecret)
      .update(`${id1}\nsubmitted\n${from}\n${to}`)
      .digest('base64url');
    const stamp2 = createHmac('sha256', config.taskSigningSecret)
      .update(`${id2}\nsubmitted\n${from}\n${to}`)
      .digest('base64url');

    const source1 = Buffer.from([
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Task 1',
      `X-OA-Task: ${id1}`,
      'X-OA-Task-State: submitted',
      `X-OA-Task-Stamp: ${stamp1}`,
      '',
      'task 1 body',
    ].join('\r\n'));

    const source2 = Buffer.from([
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Task 2',
      `X-OA-Task: ${id2}`,
      'X-OA-Task-State: submitted',
      `X-OA-Task-Stamp: ${stamp2}`,
      '',
      'task 2 body',
    ].join('\r\n'));

    // Non-task message in the same fetch result
    const sourceNoise = Buffer.from([
      `From: ${from}`,
      `To: ${to}`,
      'Subject: Random email',
      '',
      'not a task email',
    ].join('\r\n'));

    fakeInboxMessages = [
      {
        uid: 201,
        envelope: { from: [{ address: from }], to: [{ address: to }], subject: 'Task 1', date: new Date(NOW) },
        internalDate: new Date(NOW),
        source: source1,
      },
      {
        uid: 202,
        envelope: { from: [{ address: from }], to: [{ address: to }], subject: 'Task 2', date: new Date(NOW + 1000) },
        internalDate: new Date(NOW + 1000),
        source: source2,
      },
      {
        uid: 203,
        envelope: { from: [{ address: from }], to: [{ address: to }], subject: 'Random email', date: new Date(NOW + 2000) },
        internalDate: new Date(NOW + 2000),
        source: sourceNoise,
      },
    ];

    let parseCalls = 0;
    const countingParser = async (src: Buffer | string): Promise<ParsedMail> => {
      parseCalls += 1;
      return simpleParser(src);
    };

    const snapshot = await scanDurableTasksForTests(countingParser);

    // Exactly 3 messages fetched -> exactly 3 parses
    expect(parseCalls).toBe(3);
    // Task 1 and Task 2 reconstructed; noise message ignored
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.hadMatchingRowsIds.has(id1)).toBe(true);
    expect(snapshot.hadMatchingRowsIds.has(id2)).toBe(true);
    expect(snapshot.hadMatchingRowsIds.size).toBe(2);
  });
});
