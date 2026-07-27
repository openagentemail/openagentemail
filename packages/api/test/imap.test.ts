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
};

let fakeMessages: FakeMessage[] = [];

class FakeImapFlow {
  closed = false;

  async connect() {}

  async getMailboxLock() {
    return { release() {} };
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
      source: Buffer.from(
        `From: sender@example.net\r\nTo: ${message.envelope.to[0]?.address}\r\n` +
          `Subject: ${message.envelope.subject}\r\n\r\nsecret body`,
      ),
    };
  }

  async logout() {}
  close() {
    this.closed = true;
  }
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { listMessages } = await import('../src/lib/imap.ts');

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
});
