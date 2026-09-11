/**
 * #144 后向游标代际矩阵（子进程专用，勿被父进程与 imap-match 共载）。
 * 不带 .test.ts，避免 bun test 自动发现重复跑。
 */
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';

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
    messageId?: string;
  };
  internalDate: Date;
  flags: Set<string>;
  headers: Buffer;
  source?: Buffer;
};

let fakeMessages: FakeMessage[] = [];
/** null = 选中会话拿不到当前代际（勿传 undefined，会被默认参数吃掉） */
let fakeUidValidity: bigint | number | string | null = 17n;
let searchCalls = 0;
let fetchCalls = 0;
let fetchOneCalls = 0;

class FakeImapFlow extends EventEmitter {
  get mailbox() {
    if (fakeUidValidity === null) return undefined;
    return { uidValidity: fakeUidValidity };
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search() {
    searchCalls += 1;
    return fakeMessages.map((message) => message.uid);
  }
  async *fetch() {
    fetchCalls += 1;
    yield* fakeMessages;
  }
  async fetchOne(uid: number) {
    fetchOneCalls += 1;
    const message = fakeMessages.find((candidate) => candidate.uid === uid);
    if (!message) return false;
    return {
      ...message,
      source:
        message.source ??
        Buffer.from(
          `From: sender@example.net\r\nTo: ${message.envelope.to[0]?.address}\r\n` +
            `Subject: ${message.envelope.subject}\r\n\r\nbody`,
        ),
    };
  }
  async logout() {}
  close() {}
}

const { mock, describe, expect, test, beforeEach } = await import('bun:test');
mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { listMessagesPage } = await import('../../src/lib/imap.ts');
const { config } = await import('../../src/lib/config.ts');
const {
  InvalidMailCursorError,
  decodeMailCursor,
  encodeMailCursor,
} = await import('../../src/lib/mail-cursor.ts');
const { UiSessionStore } = await import('../../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../../src/routes/ui.ts');

/** 手工复刻已退役的 v1 编码，供硬拒回归。 */
function encodeLegacyV1(
  payload: { folder: 'inbox' | 'sent' | 'all'; address: string; t: number; uid: number },
  key: string,
): string {
  const body = Buffer.from(
    JSON.stringify({
      f: payload.folder,
      a: payload.address,
      t: payload.t,
      u: payload.uid,
    }),
  ).toString('base64url');
  const mac = createHmac('sha256', key)
    .update(`mail-cursor-v1\n${payload.folder}\n${payload.address}\n${payload.t}\n${payload.uid}`)
    .digest('base64url');
  return `mail-cursor-v1.${body}.${mac}`;
}

function folderMessage(opts: { uid: number; from: string; to: string; at: string }): FakeMessage {
  return {
    uid: opts.uid,
    envelope: {
      from: [{ address: opts.from }],
      to: [{ address: opts.to }],
      subject: `m${opts.uid}`,
      date: new Date(opts.at),
      messageId: `<m${opts.uid}@test.example>`,
    },
    internalDate: new Date(opts.at),
    flags: new Set<string>(),
    headers: Buffer.from(`Delivered-To: ${opts.to}\r\n`, 'utf8'),
  };
}

function resetImap(messages: FakeMessage[] = [], uidValidity: bigint | number | string | null = 17n) {
  fakeMessages = messages;
  fakeUidValidity = uidValidity;
  searchCalls = 0;
  fetchCalls = 0;
  fetchOneCalls = 0;
}

function inboxFive(): FakeMessage[] {
  const msgs: FakeMessage[] = [];
  for (let i = 1; i <= 5; i += 1) {
    msgs.push(
      folderMessage({
        uid: i,
        from: 'ext@example.net',
        to: 'fox@test.example',
        at: `2026-08-01T10:0${i}:00Z`,
      }),
    );
  }
  return msgs;
}

describe('listMessagesPage 代际校验（search/fetch 之前）', () => {
  beforeEach(() => {
    resetImap(inboxFive(), 17n);
  });

  test('同代际成功：分页无重复，nextCursor 绑定已验证代际', async () => {
    const page1 = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(['5', '4']);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.nextCursor!.startsWith('mail-cursor-v2.')).toBe(true);
    const decoded = decodeMailCursor(page1.nextCursor!, config.taskSigningSecret);
    expect(decoded.uidValidity).toBe('17');
    expect(decoded.folder).toBe('inbox');
    expect(decoded.address).toBe('fox@test.example');
    expect(searchCalls).toBeGreaterThan(0);

    const page2 = await listMessagesPage('fox@test.example', {
      folder: 'inbox',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual(['3', '2']);
    const overlap = page1.messages.filter((a) => page2.messages.some((b) => b.id === a.id));
    expect(overlap).toEqual([]);
  });

  test('v1 游标在 search/fetch 之前抛 InvalidMailCursorError', async () => {
    const v1 = encodeLegacyV1(
      { folder: 'inbox', address: 'fox@test.example', t: Date.now(), uid: 5 },
      config.taskSigningSecret,
    );
    searchCalls = 0;
    fetchCalls = 0;
    fetchOneCalls = 0;
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: v1 }),
    ).rejects.toMatchObject({ name: 'InvalidMailCursorError', code: 'invalid_cursor' });
    expect(searchCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(fetchOneCalls).toBe(0);
  });

  test('信箱重建后代际不匹配：search/fetch 之前拒', async () => {
    const stale = encodeMailCursor(
      { folder: 'inbox', address: 'fox@test.example', t: Date.now(), uid: 5, uidValidity: 16 },
      config.taskSigningSecret,
    );
    fakeUidValidity = 17n;
    searchCalls = 0;
    fetchCalls = 0;
    fetchOneCalls = 0;
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: stale }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(fetchOneCalls).toBe(0);
  });

  test('空信箱 + 代际不匹配：search/fetch 之前拒，不返回空页', async () => {
    resetImap([], 18n);
    const stale = encodeMailCursor(
      { folder: 'inbox', address: 'fox@test.example', t: 1, uid: 1, uidValidity: 17 },
      config.taskSigningSecret,
    );
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: stale }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('空信箱 + 同代际：校验后代允许 search，返回空页', async () => {
    resetImap([], 17n);
    const page = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 2 });
    expect(page).toEqual({ messages: [], nextCursor: null });
    expect(searchCalls).toBe(1);
  });

  test('首页缺代际：无 cursor 也在 search/fetch 之前拒', async () => {
    resetImap(inboxFive(), null);
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', limit: 2 }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(fetchOneCalls).toBe(0);
  });

  test('空信箱首页缺代际同样 fail-closed', async () => {
    resetImap([], null);
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox' }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
  });

  test('跨身份 / 跨 folder 的合法 v2 游标在 search 之前拒', async () => {
    const otherAddr = encodeMailCursor(
      { folder: 'inbox', address: 'owl@test.example', t: 1, uid: 1, uidValidity: 17 },
      config.taskSigningSecret,
    );
    const otherFolder = encodeMailCursor(
      { folder: 'sent', address: 'fox@test.example', t: 1, uid: 1, uidValidity: 17 },
      config.taskSigningSecret,
    );
    searchCalls = 0;
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: otherAddr }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
    searchCalls = 0;
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: otherFolder }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    expect(searchCalls).toBe(0);
  });
});

/**
 * Commander2262：保留 UI HTTP 400 `{error:'invalid_request'}`；
 * codec 仍是 invalid_cursor。注入 throw 只证明映射，默认路径才是端到端。
 */
function makeUiSessionApp(deps?: Parameters<typeof createUiApiRoutes>[1]) {
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'ok' ? { kind: 'admin' as const } : null),
  });
  const created = store.create('ok', '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', deps ? createUiApiRoutes(store, deps) : createUiApiRoutes(store));
  return { app, cookie: `oae_ui=${created.sid}` };
}

describe('UI 2262 映射（保留 invalid_request）', () => {
  test('注入 throw：仅 mapper，UI 400 invalid_request（不是端到端）', async () => {
    const { app, cookie } = makeUiSessionApp({
      listIdentities: () => [],
      listMessages: async () => {
        throw new InvalidMailCursorError();
      },
      setMessageSeen: async () => true,
      getMailboxScan: async () => ({
        kind: 'ready' as const,
        now: Date.now(),
        snapshot: null,
        cached: false,
        revalidating: false,
        refreshError: false,
      }),
      getMessage: async () => null,
      setPushContentTier: () => null,
    });
    const res = await app.request(
      '/ui/api/messages?address=fox%40test.example&cursor=mail-cursor-v1.dead.beef',
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  test('默认服务路径 + v1：真 listMessagesPage，HTTP 400 invalid_request 且未 search', async () => {
    resetImap(inboxFive(), 17n);
    const v1 = encodeLegacyV1(
      { folder: 'inbox', address: 'fox@test.example', t: Date.now(), uid: 5 },
      config.taskSigningSecret,
    );
    const { app, cookie } = makeUiSessionApp();
    searchCalls = 0;
    fetchCalls = 0;
    fetchOneCalls = 0;
    const res = await app.request(
      `/ui/api/messages?address=fox%40test.example&cursor=${encodeURIComponent(v1)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(searchCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(fetchOneCalls).toBe(0);
  });
});
