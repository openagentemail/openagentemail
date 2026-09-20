/**
 * #198：任务 wait（task_create / task_get wait=true）代际语义钉。
 *
 * 钉行为（总指挥 #3879 / R0 #3894）：
 * ① 权威终态始终取签名任务快照（tasks-internal waitForTaskTerminalWith lookup）；
 *    IMAP 命中是丢弃式唤醒提示，不得污染返回。
 * ② wait 进行中 uidValidity 变化：taskId 分支 IMAP 错误非 InvalidMailCursorError
 *    → waitForMessage 回落轮询 → 新一次性连接 SELECT 新代际继续按头搜索。
 * ③ 代际翻转全程不向调用方外抛 invalid_cursor。
 *
 * 零运行时变更：仅本测试文件 + docs；src/ 零触碰。
 */
import { EventEmitter } from 'node:events';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-task-gen';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { afterEach, beforeEach, describe, expect, mock, spyOn, test } = await import('bun:test');
const {
  createConfigurableFakeMailbox,
  DEFAULT_FAKE_UID_VALIDITY,
} = await import('./helpers/imap-fake-mailbox.ts');

type FakeMessage = {
  uid: number;
  envelope: {
    from: { address: string }[];
    to: { address: string }[];
    subject: string;
    date: Date;
  };
  internalDate: Date;
  flags: Set<string>;
  headers: Buffer;
  source: Buffer;
};

const TASK_ID = '0fdc3207-056e-47c1-a65c-b29d39f66b83';
const ADDR = 'alpha@test.example';
const PEER = 'bravo@test.example';

let fakeMessages: FakeMessage[] = [];
const createdClients: FakeImapFlow[] = [];
const fakeMailbox = createConfigurableFakeMailbox();
/**
 * 首条 IDLE 会话在 search 时抛普通 IMAP 错误（模拟持有连接遭遇信箱重建）。
 * idle() 内错误会被 waitWithIdle 吞掉不外抛；必须让 findMatchWith/search 抛出
 * 才能冒泡到 waitForMessage → 回落轮询（imap.ts:1477-1479）。
 */
let genFlipOnFirstSearch = false;
let genFlipThrown = false;
/** 轮询路径（第二+ 连接）上的 taskId 头搜索次数。 */
let pollSearchCount = 0;

class FakeImapFlow extends EventEmitter {
  closed = false;
  loggedOut = false;
  /** 本连接建立时快照的代际（用于断言回落后读到新代际）。 */
  readonly seenUidValidity: bigint;
  /** 连接序号：1=IDLE 会话，2+=回落轮询 withInbox 一次性连接。 */
  readonly connectionOrdinal: number;

  constructor() {
    super();
    this.seenUidValidity = fakeMailbox.getUidValidity();
    createdClients.push(this);
    this.connectionOrdinal = createdClients.length;
  }

  get mailbox() {
    return fakeMailbox.mailbox;
  }

  get released() {
    return this.closed || this.loggedOut;
  }

  async connect() {}

  async getMailboxLock() {
    return { release() {} };
  }

  async idle() {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  async search(query?: { header?: { 'x-oa-task'?: string }; all?: boolean }) {
    const taskHeader = query?.header?.['x-oa-task'];
    // 首连接 taskId 搜索：代际翻转 + 普通 IMAP 错误（非 InvalidMailCursorError）
    if (
      genFlipOnFirstSearch
      && !genFlipThrown
      && this.connectionOrdinal === 1
      && taskHeader
    ) {
      genFlipThrown = true;
      fakeMailbox.setUidValidity(99n);
      throw new Error('UIDVALIDITY changed / mailbox recreated');
    }
    if (taskHeader) {
      if (this.connectionOrdinal >= 2) pollSearchCount += 1;
      return fakeMessages
        .filter((m) =>
          m.headers.toString('utf8').toLowerCase().includes(`x-oa-task: ${taskHeader}`.toLowerCase()))
        .map((m) => m.uid)
        .sort((a, b) => a - b);
    }
    return fakeMessages.map((m) => m.uid).sort((a, b) => a - b);
  }

  async *fetch(uids?: number[]) {
    if (Array.isArray(uids)) {
      const set = new Set(uids);
      yield* fakeMessages.filter((m) => set.has(m.uid));
    } else {
      yield* fakeMessages;
    }
  }

  async fetchOne(uid: number) {
    const message = fakeMessages.find((candidate) => candidate.uid === uid);
    if (!message) return false;
    return { ...message };
  }

  async logout() {
    this.loggedOut = true;
  }

  close() {
    this.closed = true;
  }
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { waitForMessage, InvalidMailCursorError } = await import('../src/lib/imap.ts');
// InvalidMailCursorError 从 mail-cursor 再导出核对；imap 抛的是同一类
const { InvalidMailCursorError: CursorErr } = await import('../src/lib/mail-cursor.ts');
const { waitForTaskTerminalWith } = await import('../src/lib/tasks.ts');
import type { MessageDetail } from '../src/lib/imap.ts';
import type { Task } from '../src/lib/tasks.ts';

function submittedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    from: ADDR,
    to: PEER,
    subject: 'Gen wait',
    state: 'submitted',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    messages: [{
      id: '1',
      from: ADDR,
      to: PEER,
      subject: 'Gen wait',
      date: '2026-08-24T00:00:00.000Z',
      state: 'submitted',
      body: 'please',
    }],
    ...overrides,
  };
}

/** 构造带 x-oa-task 头的假信（taskId 分支按头搜索）。 */
function taskMail(opts: {
  uid: number;
  taskId?: string;
  taskState?: string;
  subject?: string;
  body?: string;
}): FakeMessage {
  const taskId = opts.taskId ?? TASK_ID;
  const taskState = opts.taskState ?? 'completed';
  const subject = opts.subject ?? 'done';
  const body = opts.body ?? 'IMAP says failed — must not pollute snapshot';
  const source = Buffer.from(
    [
      `From: ${PEER}`,
      `To: ${ADDR}`,
      `Subject: ${subject}`,
      `X-OA-Task: ${taskId}`,
      `X-OA-Task-State: ${taskState}`,
      '',
      body,
    ].join('\r\n'),
    'utf8',
  );
  return {
    uid: opts.uid,
    envelope: {
      from: [{ address: PEER }],
      to: [{ address: ADDR }],
      subject,
      date: new Date('2026-08-24T00:01:00Z'),
    },
    internalDate: new Date('2026-08-24T00:01:00Z'),
    flags: new Set(),
    headers: Buffer.from(`X-OA-Task: ${taskId}\r\nX-OA-Task-State: ${taskState}\r\n`, 'utf8'),
    source,
  };
}

beforeEach(() => {
  fakeMessages = [];
  createdClients.length = 0;
  fakeMailbox.resetUidValidity();
  genFlipOnFirstSearch = false;
  genFlipThrown = false;
  pollSearchCount = 0;
});

afterEach(() => {
  fakeMailbox.resetUidValidity();
});

describe('#198 wait 进行中 uidValidity 变化', () => {
  test('① 权威终态不受污染：返回始终取签名任务快照，IMAP 命中被丢弃', async () => {
    // IMAP 返回会暗示 failed 的命中；快照则给出 completed + 独特 result
    // otp 必填（imap.ts MessageDetail）；句式对照 ui-frame/ui-messages fixture
    const imapHint: MessageDetail = {
      id: '999',
      from: PEER,
      to: ADDR,
      subject: 'IMAP pollution',
      date: '2026-08-24T00:01:00.000Z',
      text: 'would-be-failed',
      otp: { codes: [], links: [] },
      links: [],
      source: 'external', // MailSource = internal|external（对照 ui-frame fixture）
      taskId: TASK_ID,
      taskState: 'failed',
    };
    let lookups = 0;
    let waitCalls = 0;
    const snapshotResult = { ok: true, authority: 'signed-snapshot' };

    const waited = await waitForTaskTerminalWith(TASK_ID, ADDR, 5, {
      getTask: async () => {
        lookups += 1;
        // 第一轮非终态 → 进入 wait 唤醒片；其后返回权威终态
        if (lookups === 1) return submittedTask();
        return submittedTask({
          state: 'completed',
          result: snapshotResult,
          updatedAt: '2026-08-24T00:02:00.000Z',
        });
      },
      waitForMessage: async () => {
        waitCalls += 1;
        return imapHint; // 被丢弃：waitForTaskTerminalWith 不消费返回值
      },
      sleep: async () => {},
    });

    expect(waitCalls).toBeGreaterThanOrEqual(1);
    expect(lookups).toBeGreaterThanOrEqual(2);
    // 负控咬合：若误把 IMAP 命中当权威，会拿到 failed / 无 snapshotResult
    expect(waited).toMatchObject({
      state: 'completed',
      result: snapshotResult,
    });
    expect(waited?.state).not.toBe('failed');
  });

  test('②③ 代际翻转：静默回落新代际继续按头搜索，且全程无 invalid_cursor 外抛', async () => {
    expect(CursorErr).toBe(InvalidMailCursorError); // 同一错误类

    // 代际翻转后出现的终态信（新代际 UID 空间；首连接 search 抛错后由轮询命中）
    fakeMessages = [taskMail({ uid: 1, taskState: 'completed', subject: 'new-gen done' })];
    genFlipOnFirstSearch = true;

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 真实 waitForMessage（taskId 分支）：首连接 search 抛普通错误 → 回落轮询 → 新连接读新代际
      const found = await waitForMessage(
        ADDR,
        { taskId: TASK_ID, taskStates: ['completed', 'failed'] },
        3,
      );

      // ② 回落路径被触发（warn 文案咬合 imap.ts:1477-1479）
      const fallbackWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? '').includes('IDLE wait failed, falling back to polling'));
      expect(fallbackWarns.length).toBeGreaterThanOrEqual(1);

      // ② 新代际连接已建立，且轮询路径继续按 x-oa-task 头搜索
      expect(genFlipThrown).toBe(true);
      expect(fakeMailbox.getUidValidity()).toBe(99n);
      expect(createdClients.some((c) => c.seenUidValidity === 99n)).toBe(true);
      expect(pollSearchCount).toBeGreaterThanOrEqual(1);

      // 命中新代际上的任务信（证明 SELECT 新代际后搜索仍通）
      expect(found).not.toBeNull();
      expect(found?.taskId).toBe(TASK_ID);
      expect(found?.taskState).toBe('completed');
    } finally {
      warnSpy.mockRestore();
    }

    // ③ 同路径下缺代际也不抛 invalid_cursor（对照：通用 wait 缺代际 → 400）
    fakeMailbox.setUidValidity(undefined as unknown as bigint);
    fakeMessages = [taskMail({ uid: 2, taskState: 'completed' })];
    genFlipOnFirstSearch = false;
    genFlipThrown = false;
    createdClients.length = 0;
    pollSearchCount = 0;

    await expect(
      waitForMessage(ADDR, { taskId: TASK_ID, taskStates: ['completed', 'failed'] }, 2),
    ).resolves.toMatchObject({ taskId: TASK_ID, taskState: 'completed' });
  });

  test('整链：waitForTaskTerminalWith 代际翻转回落后仍返回快照终态、无 invalid_cursor', async () => {
    // 真实 wait + DI getTask：首连接代际翻转回落时，权威仍来自快照（IMAP 命中可有可无）
    fakeMessages = [taskMail({ uid: 7, taskState: 'failed', body: 'imap noise' })];
    genFlipOnFirstSearch = true;
    let lookups = 0;
    const snapshotResult = { ok: true, via: 'terminal-after-gen-flip' };

    let thrown: unknown;
    let waited: Task | null = null;
    try {
      waited = await waitForTaskTerminalWith(TASK_ID, ADDR, 8, {
        getTask: async () => {
          lookups += 1;
          if (lookups <= 1) return submittedTask();
          return submittedTask({
            state: 'completed',
            result: snapshotResult,
            updatedAt: '2026-08-24T00:03:00.000Z',
          });
        },
        // 真实 IMAP wait：经历代际翻转 + 回落轮询（命中会被丢弃）
        waitForMessage,
        sleep: async () => {},
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(thrown instanceof InvalidMailCursorError).toBe(false);
    expect(genFlipThrown).toBe(true);
    expect(waited).toMatchObject({ state: 'completed', result: snapshotResult });
    // 若误把 IMAP failed 当权威 → 必红；若误走通用代际闸 → invalid_cursor
    expect(waited?.state).not.toBe('failed');
    expect(fakeMailbox.getUidValidity()).toBe(99n);
    expect(DEFAULT_FAKE_UID_VALIDITY).toBe(17n);
  });
});
