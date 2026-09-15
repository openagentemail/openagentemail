/**
 * #230 负控：邮件族 mail_wait_for / waitForMessage 跳过已读匹配。
 * 假 IMAP：newest-20 路径上 seen=true 不即返；未读命中立即返；已读最新则返次新未读。
 * taskId 分支不在本面覆盖（批准 #3250：刻意不跳过 seen）。
 */
import { EventEmitter } from 'node:events';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-skip-seen';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { beforeEach, describe, expect, mock, test } = await import('bun:test');

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
const createdClients: FakeImapFlow[] = [];

class FakeImapFlow extends EventEmitter {
  closed = false;
  loggedOut = false;

  constructor() {
    super();
    createdClients.push(this);
  }

  get mailbox() {
    return { uidValidity: 17n };
  }

  get released() {
    return this.closed || this.loggedOut;
  }

  async connect() {}

  async getMailboxLock() {
    return { release() {} };
  }

  async idle() {
    // 短 IDLE，便于轮询到中途注入的未读信
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  async search() {
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
    return {
      ...message,
      source:
        message.source ??
        Buffer.from(
          `From: ${message.envelope.from[0]?.address}\r\nTo: ${message.envelope.to[0]?.address}\r\n` +
            `Subject: ${message.envelope.subject}\r\n\r\nbody`,
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

const { waitForMessage } = await import('../src/lib/imap.ts');

/** 构造一封可过滤命中的假信；seen=true 时带 \\Seen。 */
function mail(
  to: string,
  opts: {
    uid: number;
    subject?: string;
    from?: string;
    seen?: boolean;
    at?: string;
  },
): FakeMessage {
  const from = opts.from ?? 'sender@example.net';
  const subject = opts.subject ?? 'otp code';
  const at = opts.at ?? '2026-09-15T12:00:00Z';
  return {
    uid: opts.uid,
    envelope: {
      from: [{ address: from }],
      to: [{ address: to }],
      subject,
      date: new Date(at),
    },
    internalDate: new Date(at),
    flags: new Set(opts.seen ? ['\\Seen'] : []),
    headers: Buffer.from(`Delivered-To: ${to}\r\n`),
    source: Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\nbody`),
  };
}

beforeEach(() => {
  fakeMessages = [];
  createdClients.length = 0;
});

describe('#230 wait 跳过已读（邮件族负控）', () => {
  test('a. newest-20 全 seen（过滤可命中）→ 不即返，等到真超时返回 null', async () => {
    const addr = 'all-seen@test.example';
    fakeMessages = [
      mail(addr, { uid: 11, subject: 'otp code', seen: true, at: '2026-09-15T12:00:01Z' }),
      mail(addr, { uid: 10, subject: 'otp code', seen: true, at: '2026-09-15T12:00:00Z' }),
    ];
    const started = Date.now();
    const found = await waitForMessage(addr, { subjectContains: 'otp' }, 1);
    const elapsed = Date.now() - started;
    expect(found).toBeNull();
    // 真超时：接近 1s，绝非即返
    expect(elapsed).toBeGreaterThanOrEqual(750);
  });

  test('b. 等待中新到未读匹配 → 立即返回该未读', async () => {
    const addr = 'arrive-unread@test.example';
    // 开局只有已读匹配；wait 必须挂起，随后注入未读
    fakeMessages = [
      mail(addr, { uid: 5, subject: 'otp code', seen: true, at: '2026-09-15T11:00:00Z' }),
    ];
    const pending = waitForMessage(addr, { subjectContains: 'otp' }, 3);
    await Bun.sleep(80);
    fakeMessages = [
      ...fakeMessages,
      mail(addr, { uid: 6, subject: 'otp code', seen: false, at: '2026-09-15T12:30:00Z' }),
    ];
    const found = await pending;
    expect(found).not.toBeNull();
    expect(found!.id).toBe('6');
    expect(found!.subject).toBe('otp code');
  });

  test('c. newest 已读 + 次新未读（同过滤）→ 跳过已读，返回次新未读', async () => {
    const addr = 'skip-newest-seen@test.example';
    fakeMessages = [
      mail(addr, {
        uid: 20,
        subject: 'otp code',
        seen: true,
        at: '2026-09-15T13:00:00Z',
      }),
      mail(addr, {
        uid: 19,
        subject: 'otp code',
        seen: false,
        at: '2026-09-15T12:00:00Z',
      }),
    ];
    const found = await waitForMessage(addr, { subjectContains: 'otp' }, 2);
    expect(found).not.toBeNull();
    expect(found!.id).toBe('19');
  });
});
