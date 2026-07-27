// 端到端（假 IMAP 服务器）的身份隔离测试：验证 listMessages 这条真实路径上
// 别人的邮件不会被返回，而不只是内部匹配函数的单测。
import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

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
  source?: Buffer;
};

let fakeMessages: FakeMessage[] = [];
let failMailboxLock = false;
const createdClients: FakeImapFlow[] = [];

class FakeImapFlow {
  closed = false;
  loggedOut = false;

  constructor() {
    createdClients.push(this);
  }

  /** 连接是否已经被收掉（正常登出或强制关闭都算）。 */
  get released() {
    return this.closed || this.loggedOut;
  }

  async connect() {}

  async getMailboxLock() {
    if (failMailboxLock) throw new Error('mailbox lock failed');
    return { release() {} };
  }

  async idle() {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async search() {
    return fakeMessages.map((message) => message.uid);
  }

  async *fetch() {
    yield* fakeMessages;
  }

  async fetchOne(uid: number) {
    const message = fakeMessages.find((candidate) => candidate.uid === uid);
    if (!message) return false;
    return {
      ...message,
      source:
        message.source ??
        Buffer.from(
          `From: sender@example.net\r\nTo: ${message.envelope.to[0]?.address}\r\n` +
            `Subject: ${message.envelope.subject}\r\n\r\nsecret body`,
        ),
    };
  }

  async logout() {
    this.loggedOut = true;
  }

  close() {
    this.closed = true;
  }
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { getMessage, listMessages, waitForMessage } = await import('../src/lib/imap.ts');

function inboxMessage(uid: number, to: string, deliveredTo: string): FakeMessage {
  return {
    uid,
    envelope: {
      from: [{ address: 'sender@example.net' }],
      to: [{ address: to }],
      subject: 'private for another identity',
      date: new Date('2026-07-27T00:00:00Z'),
    },
    internalDate: new Date('2026-07-27T00:00:00Z'),
    flags: new Set<string>(),
    headers: Buffer.from(`Delivered-To: ${deliveredTo}\r\n`),
  };
}

describe('IMAP identity isolation (end to end)', () => {
  beforeEach(() => {
    fakeMessages = [];
    failMailboxLock = false;
    createdClients.length = 0;
  });

  test('别的身份的邮件不会出现在 listMessages 结果里', async () => {
    fakeMessages = [inboxMessage(7, 'xvictim@test.example', 'xvictim@test.example')];
    expect(await listMessages('victim@test.example')).toEqual([]);
  });

  test('catch-all 的 Delivered-To 不会把全信箱开放给后缀身份', async () => {
    fakeMessages = [inboxMessage(8, 'victim@test.example', 'agent@test.example')];
    expect(await listMessages('ent@test.example')).toEqual([]);
    // 真正的收件人仍然读得到（信封 To 命中）。
    expect((await listMessages('victim@test.example')).map((m) => m.id)).toEqual(['8']);
  });
});

describe('IMAP 列表排序（端到端）', () => {
  beforeEach(() => {
    fakeMessages = [];
  });

  test('按服务器收信时间排序，伪造的未来 Date 顶不上去', async () => {
    const spoofed = inboxMessage(11, 'victim@test.example', 'victim@test.example');
    spoofed.envelope.date = new Date('2999-01-01T00:00:00Z');
    spoofed.internalDate = new Date('2026-07-27T09:00:00Z');
    const real = inboxMessage(12, 'victim@test.example', 'victim@test.example');
    real.envelope.date = new Date('2026-07-27T09:05:00Z');
    real.internalDate = new Date('2026-07-27T09:05:00Z');
    fakeMessages = [spoofed, real];

    const ids = (await listMessages('victim@test.example')).map((m) => m.id);
    expect(ids).toEqual(['12', '11']);
  });

  test('HTML-only OTP appears in the summary without another IMAP fetch', async () => {
    const message = inboxMessage(13, 'victim@test.example', 'victim@test.example');
    message.source = Buffer.from(
      'From: sender@example.net\r\n' +
        'To: victim@test.example\r\n' +
        'Subject: HTML OTP\r\n' +
        'Content-Type: text/html; charset=utf-8\r\n\r\n' +
        '<p>Your verification code is <strong>482731</strong>.</p>',
    );
    fakeMessages = [message];

    const summaries = await listMessages('victim@test.example');
    expect(summaries[0]?.hasOtp).toBe(true);
  });
});

describe('IMAP 超大 HTML 详情', () => {
  test('链接与 OTP 提取跳过超限 HTML 部分', async () => {
    const message = inboxMessage(14, 'victim@test.example', 'victim@test.example');
    message.source = Buffer.from(
      'From: sender@example.net\r\n' +
        'To: victim@test.example\r\n' +
        'Subject: Oversized HTML\r\n' +
        'Content-Type: multipart/alternative; boundary=oae\r\n\r\n' +
        '--oae\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        'Plain link https://plain.example/path\r\n' +
        '--oae\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
        `<a href="https://html.example/should-not-scan">Verify</a>${'x'.repeat(512 * 1024)}\r\n` +
        '--oae--\r\n',
    );
    fakeMessages = [message];

    const detail = await getMessage('victim@test.example', '14');
    expect(detail?.links).toEqual(['https://plain.example/path']);
    expect(detail?.otp.links).toEqual([]);
  });
});

// 路由层的并发闸门：wait 会占住 IMAP 长连接，超过上限必须直接 429，
// 而不是再开一条连接。这里跑的是真的 waitForMessage（对着假 IMAP 服务器）。
describe('POST /v1/messages/wait 并发上限（端到端）', () => {
  test('同一地址第 4 个并发 wait 拿到 429，而不是第 4 条 IMAP 连接', async () => {
    const { Hono } = await import('hono');
    const { messagesRoute } = await import('../src/routes/messages.ts');
    const { resetWaitSlots, MAX_WAITS_PER_ADDRESS } = await import('../src/lib/ratelimit.ts');
    resetWaitSlots();

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'admin' });
      await next();
    });
    app.route('/v1/messages', messagesRoute);

    const wait = () =>
      app.request('/v1/messages/wait', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: 'busy@test.example', timeoutSec: 1 }),
      });

    const responses = await Promise.all(
      Array.from({ length: MAX_WAITS_PER_ADDRESS + 1 }, () => wait()),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(statuses.filter((s) => s === 408)).toHaveLength(MAX_WAITS_PER_ADDRESS);
  });
});

// 打开信箱这一步是可能失败的（INBOX 不存在、连接中途断）。失败时如果不收
// 连接，反复失败就会把 catch-all 账号的连接名额漏光——和 wait 并发上限是
// 同一类资源耗尽，而且能绕过槽位（槽位已归还，连接却还挂着）。
describe('IMAP 连接清理', () => {
  beforeEach(() => {
    fakeMessages = [];
    failMailboxLock = true;
    createdClients.length = 0;
  });

  test('一次性操作：加锁失败时关掉已连接的 client', async () => {
    await expect(listMessages('victim@test.example')).rejects.toThrow('mailbox lock failed');
    expect(createdClients).toHaveLength(1);
    expect(createdClients[0]!.released).toBe(true);
  });

  test('wait 路径：加锁失败也不留下悬挂连接', async () => {
    expect(await waitForMessage('victim@test.example', {}, 1)).toBeNull();
    expect(createdClients.length).toBeGreaterThan(0);
    expect(createdClients.every((client) => client.released)).toBe(true);
  });
});
