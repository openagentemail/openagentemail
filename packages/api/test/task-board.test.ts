import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawTaskMessage, Task, TaskState, SendInput } from '../src/lib/tasks.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-task-board-'));

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
  TASK_BOARD_LIMITS,
  TASK_BOARD_PERIODS,
  TASK_REMIND_COOLDOWN_MS,
  clearQueuedEventsForTests,
  createApprovalTask,
  createTask,
  currentTaskMessage,
  getTask,
  invalidateTaskListCache,
  isClosedByAdmin,
  listTaskBoard,
  closeTask,
  remindTask,
  replyTask,
  setTaskGetForTests,
  setTaskListAllForTests,
  setTaskNowForTests,
  setTaskSendMailForTests,
  taskFromMessages,
  taskOverdue,
  taskService,
} = await import('../src/lib/tasks.ts');
const { encodeTaskBoardCursor, InvalidTaskCursorError } = await import('../src/lib/task-cursor.ts');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { config } = await import('../src/lib/config.ts');

const SYNTHETIC_TASK_TTL_MS = 60 * 1000;

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function padId(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `11111111-1111-4111-8111-${hex}`;
}

function makeTask(overrides: Partial<Task> & { state: TaskState; updatedAt: string }): Task {
  const id = overrides.id ?? padId(1);
  const createdAt = overrides.createdAt ?? overrides.updatedAt;
  const from = overrides.from ?? 'fox@test.example';
  const to = overrides.to ?? 'owl@test.example';
  const subject = overrides.subject ?? 'Ticket';
  const messages = overrides.messages ?? [
    {
      id: '1',
      from,
      to,
      subject,
      date: createdAt,
      state: 'submitted' as const,
      body: 'please start',
    },
    ...(overrides.state === 'submitted'
      ? []
      : [
          {
            id: '2',
            from: to,
            to: from,
            subject,
            date: overrides.updatedAt,
            state: overrides.state,
            body: 'update',
            ...(overrides.result !== undefined ? { result: overrides.result } : {}),
          },
        ]),
  ];
  return {
    id,
    from,
    to,
    subject,
    state: overrides.state,
    createdAt,
    updatedAt: overrides.updatedAt,
    messages,
    ...(overrides.result !== undefined ? { result: overrides.result } : {}),
  };
}

beforeEach(() => {
  setTaskNowForTests(() => NOW);
});

afterEach(() => {
  setTaskNowForTests(null);
  setTaskListAllForTests(null);
  setTaskGetForTests(null);
  setTaskSendMailForTests(null);
  clearQueuedEventsForTests();
  fakeInboxMessages = [];
});

describe('task overdue clock', () => {
  test('submitted is overdue at createdAt/last submitted + 4h inclusive', () => {
    const fresh = makeTask({
      state: 'submitted',
      createdAt: iso(NOW - 4 * HOUR + 1),
      updatedAt: iso(NOW - 4 * HOUR + 1),
    });
    expect(taskOverdue(fresh, NOW)).toEqual({ overdueReason: null, overdueAt: null });

    const due = makeTask({
      state: 'submitted',
      createdAt: iso(NOW - 4 * HOUR),
      updatedAt: iso(NOW - 4 * HOUR),
    });
    expect(taskOverdue(due, NOW)).toEqual({
      overdueReason: 'submitted',
      overdueAt: iso(NOW),
    });
  });

  test('working is overdue at last working event + 24h; submitted clock does not apply', () => {
    const workingAt = NOW - 24 * HOUR;
    const due = makeTask({
      state: 'working',
      createdAt: iso(NOW - 48 * HOUR),
      updatedAt: iso(workingAt),
      messages: [
        {
          id: '1',
          from: 'fox@test.example',
          to: 'owl@test.example',
          subject: 'Ticket',
          date: iso(NOW - 48 * HOUR),
          state: 'submitted',
          body: 'go',
        },
        {
          id: '2',
          from: 'owl@test.example',
          to: 'fox@test.example',
          subject: 'Ticket',
          date: iso(workingAt),
          state: 'working',
          body: 'on it',
        },
      ],
    });
    expect(taskOverdue(due, NOW)).toEqual({
      overdueReason: 'working',
      overdueAt: iso(NOW),
    });
    expect(taskOverdue(due, NOW - 1)).toEqual({ overdueReason: null, overdueAt: null });
  });

  test('input-required is never flagged by the 4h/24h rules', () => {
    const stuck = makeTask({
      state: 'input-required',
      createdAt: iso(NOW - 10 * DAY),
      updatedAt: iso(NOW - 9 * DAY),
    });
    expect(taskOverdue(stuck, NOW)).toEqual({ overdueReason: null, overdueAt: null });
  });

  test('terminal tasks are not overdue', () => {
    const done = makeTask({
      state: 'completed',
      createdAt: iso(NOW - 10 * DAY),
      updatedAt: iso(NOW - 9 * DAY),
    });
    expect(taskOverdue(done, NOW)).toEqual({ overdueReason: null, overdueAt: null });
  });
});

describe('task board list filters and cursor', () => {
  test('active is submitted+working; input-required is its own tab', async () => {
    const submitted = makeTask({ id: padId(1), state: 'submitted', updatedAt: iso(NOW - HOUR) });
    const working = makeTask({ id: padId(2), state: 'working', updatedAt: iso(NOW - 2 * HOUR) });
    const waiting = makeTask({
      id: padId(3),
      state: 'input-required',
      updatedAt: iso(NOW - 3 * HOUR),
    });
    const done = makeTask({ id: padId(4), state: 'completed', updatedAt: iso(NOW - 4 * HOUR) });
    setTaskListAllForTests(async () => [submitted, working, waiting, done]);

    const active = await listTaskBoard(
      { status: 'active', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(active.tasks.map((task) => task.id)).toEqual([submitted.id, working.id]);
    expect(active.queryNow).toBe(iso(NOW));

    const waitingPage = await listTaskBoard(
      { status: 'input-required', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(waitingPage.tasks.map((task) => task.id)).toEqual([waiting.id]);
  });

  test('terminal tasks older than 30 days are hidden; period is a query window', async () => {
    const recentFail = makeTask({
      id: padId(1),
      state: 'failed',
      updatedAt: iso(NOW - 30 * DAY),
    });
    const oldFail = makeTask({
      id: padId(2),
      state: 'failed',
      updatedAt: iso(NOW - 30 * DAY - 1),
    });
    const oldWorking = makeTask({
      id: padId(3),
      state: 'working',
      updatedAt: iso(NOW - 40 * DAY),
    });
    setTaskListAllForTests(async () => [recentFail, oldFail, oldWorking]);

    const failed = await listTaskBoard(
      { status: 'failed', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(failed.tasks.map((task) => task.id)).toEqual([recentFail.id]);

    const day = await listTaskBoard(
      { status: 'failed', period: '24h', limit: 20 },
      { kind: 'admin' },
    );
    expect(day.tasks).toEqual([]);

    const allActive = await listTaskBoard(
      { status: 'active', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(allActive.tasks).toEqual([]);
  });

  test('identity ACL hides peer tickets before paging', async () => {
    const mine = makeTask({
      id: padId(1),
      state: 'working',
      updatedAt: iso(NOW),
      from: 'fox@test.example',
      to: 'owl@test.example',
    });
    const peer = makeTask({
      id: padId(2),
      state: 'working',
      updatedAt: iso(NOW - 1),
      from: 'cat@test.example',
      to: 'dog@test.example',
    });
    setTaskListAllForTests(async () => [mine, peer]);
    const page = await listTaskBoard(
      { status: 'active', period: '30d', limit: 20 },
      { kind: 'identity', address: 'Fox@test.example' },
    );
    expect(page.tasks.map((task) => task.id)).toEqual([mine.id]);
    expect(page.totalApprox).toBe(1);
  });

  test('every period × limit combination pages without crossing filters', async () => {
    const tasks = Array.from({ length: 120 }, (_, index) =>
      makeTask({
        id: padId(index + 1),
        state: index % 2 === 0 ? 'working' : 'completed',
        updatedAt: iso(NOW - index * 60_000),
      }),
    );
    setTaskListAllForTests(async () => tasks);

    for (const period of TASK_BOARD_PERIODS) {
      for (const limit of TASK_BOARD_LIMITS) {
        const first = await listTaskBoard(
          { status: 'all', period, limit },
          { kind: 'admin' },
        );
        expect(first.tasks.length).toBeGreaterThan(0);
        expect(first.tasks.length).toBeLessThanOrEqual(limit);
        if (!first.nextCursor) continue;
        const second = await listTaskBoard(
          { status: 'all', period, limit, cursor: first.nextCursor },
          { kind: 'admin' },
        );
        const overlap = first.tasks.filter((task) =>
          second.tasks.some((other) => other.id === task.id),
        );
        expect(overlap).toEqual([]);

        await expect(
          listTaskBoard(
            { status: 'active', period, limit, cursor: first.nextCursor },
            { kind: 'admin' },
          ),
        ).rejects.toBeInstanceOf(InvalidTaskCursorError);

        const otherPeriod = period === '24h' ? '7d' : '24h';
        await expect(
          listTaskBoard(
            { status: 'all', period: otherPeriod, limit, cursor: first.nextCursor },
            { kind: 'admin' },
          ),
        ).rejects.toBeInstanceOf(InvalidTaskCursorError);
      }
    }
  });

  test('cursor with a foreign fingerprint is rejected', async () => {
    setTaskListAllForTests(async () => [
      makeTask({ id: padId(1), state: 'working', updatedAt: iso(NOW) }),
    ]);
    const forged = encodeTaskBoardCursor({
      fp: 'completed|30d|admin',
      t: NOW,
      id: padId(1),
    });
    await expect(
      listTaskBoard(
        { status: 'active', period: '30d', limit: 20, cursor: forged },
        { kind: 'admin' },
      ),
    ).rejects.toBeInstanceOf(InvalidTaskCursorError);
  });
});

describe('task event reconstruction', () => {
  test('reminder events do not change task.state', () => {
    const raw: RawTaskMessage[] = [
      {
        uid: 1,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: iso(NOW - HOUR),
        state: 'submitted',
        body: 'please start',
      },
      {
        uid: 2,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: iso(NOW),
        state: 'working',
        body: 'please hurry',
        kind: 'reminder',
        idempotencyKey: 'click-1',
      },
    ];
    const current = currentTaskMessage(raw);
    expect(current.state).toBe('submitted');
    expect(current.kind).toBeUndefined();
    const task = taskFromMessages(padId(1), raw);
    expect(task?.state).toBe('submitted');
    expect(task?.messages[1]?.kind).toBe('reminder');
    expect(task?.updatedAt).toBe(iso(NOW));
  });

  test('a post-terminal submitted replay does not refresh updatedAt or reopen the ticket', () => {
    const terminalAt = iso(NOW - HOUR);
    const replayAt = iso(NOW);
    const raw: RawTaskMessage[] = [
      {
        uid: 1,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: iso(NOW - 2 * HOUR),
        state: 'submitted',
        body: 'please start',
      },
      {
        uid: 2,
        from: 'owl@test.example',
        to: 'fox@test.example',
        subject: 'Ticket',
        date: terminalAt,
        state: 'completed',
        body: 'done',
        result: { ok: true },
      },
      {
        uid: 3,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: replayAt,
        state: 'submitted',
        body: 'please start',
      },
    ];
    const task = taskFromMessages(padId(1), raw);
    expect(task?.state).toBe('completed');
    expect(task?.updatedAt).toBe(terminalAt);
  });

  test('a post-terminal reminder replay does not refresh updatedAt or the 30d window', async () => {
    const terminalAt = iso(NOW - 31 * DAY);
    const reminderAt = iso(NOW);
    const raw: RawTaskMessage[] = [
      {
        uid: 1,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: iso(NOW - 32 * DAY),
        state: 'submitted',
        body: 'please start',
      },
      {
        uid: 2,
        from: 'owl@test.example',
        to: 'fox@test.example',
        subject: 'Ticket',
        date: terminalAt,
        state: 'failed',
        body: 'closed',
        result: { closed_by_admin: true, reason: 'done' },
      },
      {
        uid: 3,
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: 'Ticket',
        date: reminderAt,
        state: 'failed',
        body: 'old ping',
        kind: 'reminder',
      },
    ];
    const task = taskFromMessages(padId(1), raw);
    expect(task?.state).toBe('failed');
    expect(task?.updatedAt).toBe(terminalAt);
    setTaskListAllForTests(async () => [task!]);
    const page = await listTaskBoard(
      { status: 'failed', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(page.tasks.map((row) => row.id)).toEqual([]);
  });

  test('closed_by_admin is a structured failed result, not a new state', () => {
    const closed = makeTask({
      state: 'failed',
      updatedAt: iso(NOW),
      result: { closed_by_admin: true, reason: 'duplicate' },
    });
    expect(isClosedByAdmin(closed)).toBe(true);
    expect(isClosedByAdmin(makeTask({ state: 'failed', updatedAt: iso(NOW), result: { ok: false } }))).toBe(
      false,
    );
  });
});

describe('task board in-memory baseline', () => {
  test('filter+sort+page 1k and 10k task messages', async () => {
    const sizes = [1_000, 10_000] as const;
    const results: Record<string, { ms: number; pages: number; totalApprox: number }> = {};
    for (const size of sizes) {
      const catalog = Array.from({ length: size }, (_, index) =>
        makeTask({
          id: padId(index + 1),
          state: index % 5 === 0 ? 'completed' : index % 3 === 0 ? 'submitted' : 'working',
          updatedAt: iso(NOW - (index % 400) * 60_000),
        }),
      );
      setTaskListAllForTests(async () => catalog);
      const started = performance.now();
      let pages = 0;
      let cursor: string | undefined;
      let totalApprox = 0;
      const seenIds: string[] = [];
      do {
        const page = await listTaskBoard(
          { status: 'all', period: '30d', limit: 100, cursor },
          { kind: 'admin' },
        );
        expect(page.totalApprox).toBe(size);
        totalApprox = page.totalApprox;
        pages += 1;
        seenIds.push(...page.tasks.map((task) => task.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      results[String(size)] = {
        ms: Math.round(performance.now() - started),
        pages,
        totalApprox,
      };
      const expectedIds = [...catalog]
        .sort((a, b) => {
          const dt = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
          if (dt !== 0) return dt;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        })
        .map((task) => task.id);
      expect(totalApprox).toBe(size);
      expect(pages).toBe(size / 100);
      expect(seenIds).toHaveLength(size);
      expect(new Set(seenIds).size).toBe(size);
      expect(seenIds).toEqual(expectedIds);
    }
    console.log('[task-board baseline]', JSON.stringify(results));
    expect(results['10000']!.pages).toBe(results['1000']!.pages * 10);
    // 不再断言墙钟：并发负载会制造假红；显式 timeout 只隔离 Bun 默认 5s 掐断。
  }, 30_000);
});

describe('concurrent reply under per-task lock', () => {
  test('two concurrent replies write one working event; the other is 409', async () => {
    const task = makeTask({
      id: padId(9),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    const store = new Map<string, Task>([[task.id, structuredClone(task)]]);
    const sent: Array<{ state?: string }> = [];

    setTaskGetForTests(async (id) => {
      const current = store.get(id);
      return current ? structuredClone(current) : null;
    });
    setTaskSendMailForTests(async (input) => {
      const state = input.headers?.['X-OA-Task-State'] as TaskState | undefined;
      sent.push({ state });
      const current = store.get(task.id);
      if (!current || !state) throw new Error('missing in-memory task');
      const now = iso(NOW);
      store.set(task.id, {
        ...current,
        state,
        updatedAt: now,
        messages: [
          ...current.messages,
          {
            id: String(current.messages.length + 1),
            from: input.from,
            to: input.to[0]!,
            subject: current.subject,
            date: now,
            state,
            body: input.text,
          },
        ],
      });
      return { messageId: `<reply-${sent.length}@test.example>` };
    });

    const [first, second] = await Promise.allSettled([
      replyTask({ id: task.id, from: 'fox@test.example', body: 'first' }),
      replyTask({ id: task.id, from: 'fox@test.example', body: 'second' }),
    ]);
    const outcomes = [first, second];
    const ok = outcomes.filter((row) => row.status === 'fulfilled');
    const failed = outcomes.filter((row) => row.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      message: 'task_not_input_required',
    });
    expect(sent.filter((row) => row.state === 'working')).toHaveLength(1);
    expect(store.get(task.id)?.messages.filter((message) => message.state === 'working')).toHaveLength(1);
  });
});

describe('reminder IMAP lag idempotency and cooldown', () => {
  function installLaggingMailbox(task: Task) {
    const store = new Map<string, Task>([[task.id, structuredClone(task)]]);
    const sent: Array<{ event?: string; key?: string; body: string }> = [];
    setTaskGetForTests(async (id) => {
      const current = store.get(id);
      return current ? structuredClone(current) : null;
    });
    // SMTP 接受但不写入 store：模拟 Dovecot 尚未索引。
    setTaskSendMailForTests(async (input) => {
      sent.push({
        event: input.headers?.['X-OA-Task-Event'],
        key: input.headers?.['X-OA-Task-Idempotency-Key'],
        body: input.text,
      });
      return { messageId: `<remind-${sent.length}@test.example>` };
    });
    return { store, sent };
  }

  test('IMAP lag: same idempotency key retry does not send twice; cooldown still holds', async () => {
    const task = makeTask({
      id: padId(10),
      state: 'working',
      updatedAt: iso(NOW - HOUR),
    });
    const { store, sent } = installLaggingMailbox(task);

    const first = await remindTask({
      id: task.id,
      from: 'fox@test.example',
      body: 'ping',
      idempotencyKey: 'click-1',
    });
    expect(sent).toHaveLength(1);
    expect(first.messages.some((message) => message.kind === 'reminder' && message.idempotencyKey === 'click-1')).toBe(true);
    expect(store.get(task.id)?.messages.some((message) => message.kind === 'reminder')).toBe(false);

    const replay = await remindTask({
      id: task.id,
      from: 'fox@test.example',
      body: 'ping',
      idempotencyKey: 'click-1',
    });
    expect(sent).toHaveLength(1);
    expect(replay.messages.filter((message) => message.kind === 'reminder')).toHaveLength(1);

    await expect(
      remindTask({
        id: task.id,
        from: 'fox@test.example',
        body: 'again',
        idempotencyKey: 'click-2',
      }),
    ).rejects.toMatchObject({ message: 'task_remind_cooldown' });
    expect(sent).toHaveLength(1);
    expect(TASK_REMIND_COOLDOWN_MS).toBe(15_000);
  });
});

describe('IMAP lag overlay for state transitions and list', () => {
  function installLaggingMailbox(task: Task) {
    const store = new Map<string, Task>([[task.id, structuredClone(task)]]);
    const sent: Array<{ state?: string; event?: string }> = [];
    setTaskGetForTests(async (id) => {
      const current = store.get(id);
      return current ? structuredClone(current) : null;
    });
    setTaskListAllForTests(async () => [...store.values()].map((row) => structuredClone(row)));
    setTaskSendMailForTests(async (input) => {
      sent.push({
        state: input.headers?.['X-OA-Task-State'],
        event: input.headers?.['X-OA-Task-Event'],
      });
      return { messageId: `<lag-${sent.length}@test.example>` };
    });
    return { store, sent };
  }

  test('lag window: second reply and reply-after-close are rejected without a second send', async () => {
    const waiting = makeTask({
      id: padId(11),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    const { store, sent } = installLaggingMailbox(waiting);

    const [first, second] = await Promise.allSettled([
      replyTask({ id: waiting.id, from: 'fox@test.example', body: 'first' }),
      replyTask({ id: waiting.id, from: 'fox@test.example', body: 'second' }),
    ]);
    const ok = [first, second].filter((row) => row.status === 'fulfilled');
    const failed = [first, second].filter((row) => row.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      message: 'task_not_input_required',
    });
    expect(sent.filter((row) => row.state === 'working' && row.event !== 'reminder')).toHaveLength(1);
    expect(store.get(waiting.id)?.state).toBe('input-required');

    const closed = makeTask({
      id: padId(12),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    const closeBox = installLaggingMailbox(closed);
    await closeTask({ id: closed.id, from: 'fox@test.example', reason: 'duplicate' });
    await expect(
      replyTask({ id: closed.id, from: 'fox@test.example', body: 'too late' }),
    ).rejects.toMatchObject({ message: 'task_not_input_required' });
    expect(closeBox.sent.filter((row) => row.state === 'failed')).toHaveLength(1);
    expect(closeBox.sent.filter((row) => row.state === 'working')).toHaveLength(0);
  });

  test('lag window: concurrent reply vs close never sends working after failed', async () => {
    const waiting = makeTask({
      id: padId(14),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    const { sent } = installLaggingMailbox(waiting);
    await Promise.allSettled([
      replyTask({ id: waiting.id, from: 'fox@test.example', body: 'reply' }),
      closeTask({ id: waiting.id, from: 'fox@test.example', reason: 'stop' }),
    ]);
    const workingIdx = sent.findIndex((row) => row.state === 'working' && row.event !== 'reminder');
    const failedIdx = sent.findIndex((row) => row.state === 'failed');
    expect(sent.filter((row) => row.state === 'working' && row.event !== 'reminder').length).toBeLessThanOrEqual(1);
    expect(sent.filter((row) => row.state === 'failed').length).toBeLessThanOrEqual(1);
    expect(workingIdx >= 0 || failedIdx >= 0).toBe(true);
    if (workingIdx >= 0 && failedIdx >= 0) {
      expect(workingIdx).toBeLessThan(failedIdx);
    }
  });

  test('lag window: listBoard matches getTask after a reply the mailbox has not indexed', async () => {
    const waiting = makeTask({
      id: padId(13),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    installLaggingMailbox(waiting);
    await replyTask({ id: waiting.id, from: 'fox@test.example', body: 'here' });
    const detail = await getTask(waiting.id);
    expect(detail?.state).toBe('working');
    const page = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]?.state).toBe(detail?.state);
    expect(page.tasks[0]?.updatedAt).toBe(detail?.updatedAt);
  });

  test('overlay retires once IMAP has moved past the queued working event', async () => {
    const waiting = makeTask({
      id: padId(15),
      state: 'input-required',
      updatedAt: iso(NOW - HOUR),
    });
    const { store } = installLaggingMailbox(waiting);
    await replyTask({ id: waiting.id, from: 'fox@test.example', body: 'here' });
    expect((await getTask(waiting.id))?.state).toBe('working');

    const advanced: Task = {
      ...waiting,
      state: 'input-required',
      updatedAt: iso(NOW),
      messages: [
        ...waiting.messages,
        {
          id: 'w',
          from: 'fox@test.example',
          to: 'owl@test.example',
          subject: waiting.subject,
          date: iso(NOW),
          state: 'working',
          body: 'here',
        },
        {
          id: 'i',
          from: 'owl@test.example',
          to: 'fox@test.example',
          subject: waiting.subject,
          date: iso(NOW),
          state: 'input-required',
          body: 'need more',
        },
      ],
    };
    store.set(waiting.id, advanced);
    const detail = await getTask(waiting.id);
    expect(detail?.state).toBe('input-required');
    expect(detail?.messages.filter((message) => message.state === 'working')).toHaveLength(1);
    const page = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(page.tasks[0]?.state).toBe('input-required');
  });
});

describe('issue #95: newly created tasks readable during IMAP indexing lag', () => {
  function installEmptyMailbox() {
    const store = new Map<string, Task>();
    const sent: SendInput[] = [];
    setTaskGetForTests(async (id) => {
      const current = store.get(id);
      return current ? structuredClone(current) : null;
    });
    setTaskListAllForTests(async () => [...store.values()].map((row) => structuredClone(row)));
    setTaskSendMailForTests(async (input) => {
      sent.push(input);
      return { messageId: `<test-msg-${sent.length}@test.example>` };
    });
    return { store, sent };
  }

  test('1. ordinary create followed immediately by detail read while IMAP returns no rows returns the created task', async () => {
    installEmptyMailbox();
    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Ordinary unindexed task',
      body: 'initial body',
    });

    const detail = await getTask(created.id);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(created.id);
    expect(detail?.from).toBe('fox@test.example');
    expect(detail?.to).toBe('owl@test.example');
    expect(detail?.subject).toBe('Ordinary unindexed task');
    expect(detail?.state).toBe('submitted');
    expect(detail?.createdAt).toBe(iso(NOW));
    expect(detail?.updatedAt).toBe(iso(NOW));
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.body).toBe('initial body');
  });

  test('2. approval create followed immediately by detail read while IMAP returns no rows returns the created approval task with its approval snapshot intact', async () => {
    installEmptyMailbox();
    for (const localpart of ['fox', 'owl']) {
      if (!findIdentity(`${localpart}@test.example`)) {
        createIdentity({ localpart, issueToken: false });
      }
    }
    const expiresAt = iso(NOW + 2 * DAY);
    const action = { type: 'deploy', name: 'publish', arguments: { version: '1.0.0' } };
    const created = await createApprovalTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Approval unindexed task',
      body: 'please review',
      action,
      expiresAt,
    });

    const detail = await getTask(created.id);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(created.id);
    expect(detail?.kind).toBe('approval');
    expect(detail?.state).toBe('input-required');
    expect(detail?.approval).toBeDefined();
    expect(detail?.approval?.action).toEqual(action);
    expect(detail?.approval?.reviewer).toBe('owl@test.example');
    expect(detail?.approval?.expiresAt).toBe(expiresAt);
    expect(detail?.approval?.digest).toBe(created.approval.digest);
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.messages[0]?.approval?.type).toBe('request');
    expect(detail?.messages[0]?.approval?.snapshot).toEqual(created.approval);
  });

  test('3. create followed immediately by board read while IMAP returns no rows includes the task exactly once', async () => {
    installEmptyMailbox();
    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Board unindexed task',
      body: 'immediate board read',
    });

    // Admin view
    const adminPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    const adminMatches = adminPage.tasks.filter((t) => t.id === created.id);
    expect(adminMatches).toHaveLength(1);
    expect(adminMatches[0]?.state).toBe('submitted');
    expect(adminMatches[0]?.subject).toBe('Board unindexed task');

    // Participant user view
    const userPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'user', address: 'fox@test.example' },
    );
    const userMatches = userPage.tasks.filter((t) => t.id === created.id);
    expect(userMatches).toHaveLength(1);

    // Outsider user view (should not see it)
    const outsiderPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'user', address: 'outsider@test.example' },
    );
    expect(outsiderPage.tasks.filter((t) => t.id === created.id)).toHaveLength(0);
  });

  test('4. when IMAP later returns the durable initial message/task, detail and board converge without duplicate messages or rows', async () => {
    const { store } = installEmptyMailbox();
    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Convergence task',
      body: 'will be indexed',
    });

    // Lag window: detail and board see synthetic task once
    expect(await getTask(created.id)).not.toBeNull();
    const lagPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(lagPage.tasks.filter((t) => t.id === created.id)).toHaveLength(1);

    // IMAP indexes the task as a durable record
    const durableTask: Task = {
      ...created,
      messages: [
        {
          id: '<durable-msg-1@test.example>',
          from: 'fox@test.example',
          to: 'owl@test.example',
          subject: 'Convergence task',
          date: created.createdAt,
          state: 'submitted',
          body: 'will be indexed',
        },
      ],
    };
    store.set(created.id, durableTask);

    // Detail read converges to durable task without duplicating messages
    const durableDetail = await getTask(created.id);
    expect(durableDetail).not.toBeNull();
    expect(durableDetail?.messages).toHaveLength(1);
    expect(durableDetail?.messages[0]?.id).toBe('<durable-msg-1@test.example>');

    // Board read converges without duplicating board row
    const postIndexPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    const matches = postIndexPage.tasks.filter((t) => t.id === created.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.messages).toHaveLength(1);
    expect(matches[0]?.messages[0]?.id).toBe('<durable-msg-1@test.example>');
  });

  test('5. prove bounded lifetime with an injected clock (approval expiry derived from injected clock)', async () => {
    let currentClock = NOW;
    setTaskNowForTests(() => currentClock);
    installEmptyMailbox();

    for (const localpart of ['fox', 'owl']) {
      if (!findIdentity(`${localpart}@test.example`)) {
        createIdentity({ localpart, issueToken: false });
      }
    }

    // Follow #115: approval expiry derived safely from current injected clock
    const expiresAt = iso(currentClock + 2 * DAY);
    const action = { type: 'deploy', name: 'publish', arguments: { version: '1.0.0' } };

    const ordinary = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Expiring ordinary task',
      body: 'bounded test',
    });
    const approval = await createApprovalTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Expiring approval task',
      body: 'bounded approval test',
      action,
      expiresAt,
    });

    // Initially within lag window: both are readable and present on board
    expect(await getTask(ordinary.id)).not.toBeNull();
    expect(await getTask(approval.id)).not.toBeNull();
    const initialPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(initialPage.tasks.filter((t) => t.id === ordinary.id)).toHaveLength(1);
    expect(initialPage.tasks.filter((t) => t.id === approval.id)).toHaveLength(1);

    // Advance clock past SYNTHETIC_TASK_TTL_MS (60s), while approval expiry (2 days) is safely in bounds
    currentClock = NOW + SYNTHETIC_TASK_TTL_MS + 1000;

    // Detail reads expire and return null
    expect(await getTask(ordinary.id)).toBeNull();
    expect(await getTask(approval.id)).toBeNull();

    // Board read excludes expired synthetic tasks
    const expiredPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(expiredPage.tasks.filter((t) => t.id === ordinary.id)).toHaveLength(0);
    expect(expiredPage.tasks.filter((t) => t.id === approval.id)).toHaveLength(0);
  });

  test('6. synthetic task base adheres to explicit capacity limit with deterministic FIFO eviction', async () => {
    installEmptyMailbox();
    const first = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'First burst task',
      body: 'first',
    });
    expect(await getTask(first.id)).not.toBeNull();

    // Create 100 burst tasks to exceed capacity (100)
    let lastId = '';
    for (let i = 0; i < 100; i++) {
      const burst = await createTask({
        from: 'fox@test.example',
        to: 'owl@test.example',
        subject: `Burst task ${i}`,
        body: `burst ${i}`,
      });
      lastId = burst.id;
    }

    // First task should have been evicted deterministically by capacity overflow
    expect(await getTask(first.id)).toBeNull();
    // Latest task should still be present
    expect(await getTask(lastId)).not.toBeNull();
  });

  test('7. detail and authorization reads fail closed when IMAP search yields matching rows that fail parser integrity', async () => {
    setTaskGetForTests(null);
    setTaskSendMailForTests(async () => ({ messageId: '<sent-msg-1@test.example>' }));
    fakeInboxMessages = [];

    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Tampered durable task',
      body: 'initial body',
    });

    // Zero matching rows in IMAP: synthetic fallback works
    const lagDetail = await getTask(created.id);
    expect(lagDetail).not.toBeNull();
    expect(lagDetail?.id).toBe(created.id);
    expect(await taskService.getForAuthorization?.(created.id)).not.toBeNull();

    // Matching row appears in IMAP search, but fails parser integrity
    const tamperedSource = Buffer.from(
      [
        'From: fox@test.example',
        'To: owl@test.example',
        'Subject: Tampered durable task',
        `X-OA-Task: ${created.id}`,
        'X-OA-Task-State: submitted',
        'X-OA-Task-Stamp: invalid-tampered-stamp',
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
          subject: 'Tampered durable task',
          date: new Date('2026-08-12T12:00:00Z'),
        },
        internalDate: new Date('2026-08-12T12:00:00Z'),
        source: tamperedSource,
      },
    ];

    // Detail read and authorization read must fail closed and return null rather than the synthetic task
    const tamperedDetail = await getTask(created.id);
    expect(tamperedDetail).toBeNull();
    expect(await taskService.getForAuthorization?.(created.id)).toBeNull();

    // Repeated read also returns null (synthetic base was suppressed/retired)
    expect(await getTask(created.id)).toBeNull();
  });

  test('8. concurrent detail read during suspended empty board scan does not evict synthetic base or lose board row', async () => {
    let detailDurable: Task | null = null;
    setTaskGetForTests(async (id) => detailDurable ? structuredClone(detailDurable) : null);
    setTaskSendMailForTests(async () => ({ messageId: '<sent-concurrency@test.example>' }));

    // 1. Create task and retain synthetic base
    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Race resistance task',
      body: 'concurrency test',
    });

    // 2. Start board read whose list snapshot captures empty then pauses
    let scanStartedResolve: () => void;
    const scanStartedPromise = new Promise<void>((resolve) => {
      scanStartedResolve = resolve;
    });

    let scanResumeResolve: () => void;
    const scanResumePromise = new Promise<void>((resolve) => {
      scanResumeResolve = resolve;
    });

    let scanCount = 0;
    setTaskListAllForTests(async () => {
      scanCount++;
      if (scanCount === 1) {
        scanStartedResolve();
        await scanResumePromise;
        return [];
      }
      return detailDurable ? [structuredClone(detailDurable)] : [];
    });

    const pendingBoardRead = listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );

    await scanStartedPromise;

    // 3. Make detail source expose durable task and perform detail read
    const durableTask: Task = {
      ...created,
      messages: [
        {
          id: '<durable-msg-1@test.example>',
          from: 'fox@test.example',
          to: 'owl@test.example',
          subject: 'Race resistance task',
          date: created.createdAt,
          state: 'submitted',
          body: 'concurrency test',
        },
      ],
    };
    detailDurable = durableTask;

    const detail = await getTask(created.id);
    expect(detail).not.toBeNull();
    expect(detail?.messages[0]?.id).toBe('<durable-msg-1@test.example>');

    // 4. Resume earlier empty board snapshot
    scanResumeResolve!();

    // 5. Verify board still includes exactly one synthetic row rather than caching empty result
    const boardPage = await pendingBoardRead;
    const matchingTasks = boardPage.tasks.filter((t) => t.id === created.id);
    expect(matchingTasks).toHaveLength(1);

    // Later board snapshot contains durable task; verify convergence without duplication
    const nextBoardPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    const convergedTasks = nextBoardPage.tasks.filter((t) => t.id === created.id);
    expect(convergedTasks).toHaveLength(1);
    expect(convergedTasks[0]?.messages[0]?.id).toBe('<durable-msg-1@test.example>');
  });

  test('9. board read fails closed when IMAP search yields matching rows that fail parser integrity (without prior detail read)', async () => {
    setTaskGetForTests(null);
    setTaskListAllForTests(null);
    setTaskSendMailForTests(async () => ({ messageId: '<sent-msg-board-fail-closed@test.example>' }));
    fakeInboxMessages = [];

    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Board tampered task',
      body: 'initial body',
    });

    // Zero matching rows in IMAP: board includes synthetic task
    const lagPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(lagPage.tasks.filter((t) => t.id === created.id)).toHaveLength(1);

    // Invalidate list cache so subsequent board read scans IMAP
    invalidateTaskListCache();

    // Matching row appears in IMAP search, but fails parser integrity
    const tamperedSource = Buffer.from(
      [
        'From: fox@test.example',
        'To: owl@test.example',
        'Subject: Board tampered task',
        `X-OA-Task: ${created.id}`,
        'X-OA-Task-State: submitted',
        'X-OA-Task-Stamp: invalid-tampered-stamp',
        '',
        'corrupted body',
      ].join('\r\n'),
    );

    fakeInboxMessages = [
      {
        uid: 202,
        envelope: {
          from: [{ address: 'fox@test.example' }],
          to: [{ address: 'owl@test.example' }],
          subject: 'Board tampered task',
          date: new Date('2026-08-12T12:00:00Z'),
        },
        internalDate: new Date('2026-08-12T12:00:00Z'),
        source: tamperedSource,
      },
    ];

    // Board read WITHOUT prior detail read must fail closed: do NOT display the synthetic task
    const postTamperPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(postTamperPage.tasks.filter((t) => t.id === created.id)).toHaveLength(0);

    // Synthetic base has been suppressed/retired
    expect(await getTask(created.id)).toBeNull();
  });

  test('10. board and detail reads fail closed when matching durable row contains poisoned relationship-integrity root', async () => {
    setTaskGetForTests(null);
    setTaskListAllForTests(null);
    setTaskSendMailForTests(async () => ({ messageId: '<sent-msg-poison-fail-closed@test.example>' }));
    fakeInboxMessages = [];

    const created = await createTask({
      from: 'fox@test.example',
      to: 'owl@test.example',
      subject: 'Poison root task',
      body: 'initial body',
    });

    // Zero matching rows in IMAP: board includes synthetic task
    const lagPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(lagPage.tasks.filter((t) => t.id === created.id)).toHaveLength(1);

    // Invalidate list cache so subsequent board read scans IMAP
    invalidateTaskListCache();

    // Matching row appears with valid v2 witness but invalid root signature (relationship integrity poison)
    const witness = createHmac('sha256', config.taskSigningSecret)
      .update(`openagentemail-task-root-v2-witness\n${created.id}\nsubmitted\nfox@test.example\nowl@test.example`)
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
        `X-OA-Task: ${created.id}`,
        'X-OA-Task-State: submitted',
        `X-OA-Task-Root: ${poisonedRootHeader}`,
        `X-OA-Task-Stamp: ${poisonedStamp}`,
        '',
        'corrupted body',
      ].join('\r\n'),
    );

    fakeInboxMessages = [
      {
        uid: 303,
        envelope: {
          from: [{ address: 'fox@test.example' }],
          to: [{ address: 'owl@test.example' }],
          subject: 'Poison root task',
          date: new Date('2026-08-12T12:00:00Z'),
        },
        internalDate: new Date('2026-08-12T12:00:00Z'),
        source: poisonedSource,
      },
    ];

    // Board read WITHOUT prior detail read must fail closed and suppress synthetic base
    const postPoisonPage = await listTaskBoard(
      { status: 'all', period: '30d', limit: 20 },
      { kind: 'admin' },
    );
    expect(postPoisonPage.tasks.filter((t) => t.id === created.id)).toHaveLength(0);

    // Detail and authorization reads also fail closed
    expect(await getTask(created.id)).toBeNull();
    expect(await taskService.getForAuthorization?.(created.id)).toBeNull();
  });
});
