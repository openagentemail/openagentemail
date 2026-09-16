/**
 * #152：\Seen 写路径审计 + 读路径纯度金测 + MCP 文案断言。
 *
 * 手法：先设 DATA_DIR 再动态 import（照 audit-tiering）；
 * FakeImapFlow 记录 flags 写（照 imap-match）；ui 审计用 DI mock（照 ui-messages）。
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-seen-audit-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-seen-audit-'));
process.env.UI_ENABLED = 'true';
process.env.MCP_PUBLIC_URL = 'http://localhost';

const { beforeEach, describe, expect, mock, test } = await import('bun:test');
const { Hono } = await import('hono');

/** FakeImapFlow 上 flags 写调用记录（金测零写 + 写路径对照）。 */
type FlagsCall = {
  op: 'add' | 'remove';
  uid: number;
  flags: string[];
};

let fakeMessages: any[] = [];
let flagsCalls: FlagsCall[] = [];

class FakeImapFlow extends EventEmitter {
  // 选中会话必须暴露当前代际，供 since / 后向列表校验
  get mailbox() {
    return { uidValidity: 17n };
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search(query?: { since?: Date }) {
    if (query?.since instanceof Date) {
      const sinceMs = query.since.getTime();
      return fakeMessages
        .filter((m) => {
          const t =
            m.internalDate instanceof Date
              ? m.internalDate.getTime()
              : m.envelope?.date instanceof Date
                ? m.envelope.date.getTime()
                : 0;
          return t >= sinceMs;
        })
        .map((m) => m.uid);
    }
    return fakeMessages.map((m) => m.uid);
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
          `From: sender@example.net\r\nTo: owner@test.example\r\nSubject: hi\r\n\r\n<body>hi</body>`,
        ),
    };
  }
  async messageFlagsAdd(uid: number, flags: string[]) {
    flagsCalls.push({ op: 'add', uid, flags: [...flags] });
  }
  async messageFlagsRemove(uid: number, flags: string[]) {
    flagsCalls.push({ op: 'remove', uid, flags: [...flags] });
  }
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { createApp } = await import('../src/app.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const { config } = await import('../src/lib/config.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { setMessageSeen } = await import('../src/lib/imap.ts');
const { encodeMailForwardCursor } = await import('../src/lib/mail-cursor.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: true });

/** 造一封属于 address 的收件，供读/写路径共用。 */
function makeInboxMsg(uid: number, address: string, at = '2026-09-01T12:00:00.000Z') {
  return {
    uid,
    flags: new Set<string>(),
    envelope: {
      date: new Date(at),
      subject: `Msg ${uid}`,
      from: [{ address: 'sender@example.net', name: 'Sender' }],
      to: [{ address, name: 'Owner' }],
    },
    internalDate: new Date(at),
    headers: Buffer.from(`Delivered-To: ${address}\r\n`),
    source: Buffer.from(
      `From: sender@example.net\r\nTo: ${address}\r\nSubject: Msg ${uid}\r\nContent-Type: text/html\r\n\r\n<p>hello ${uid}</p>`,
    ),
  };
}

function auditFileText(): string {
  const path = join(config.dataDir, 'audit.jsonl');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/** UI 会话登录，返回 cookie 头。 */
async function loginCookie(token: string): Promise<string> {
  const res = await app.request('http://localhost/ui/api/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /oae_ui=([^;]+)/.exec(setCookie);
  expect(m).toBeTruthy();
  return `oae_ui=${m![1]}`;
}

beforeEach(() => {
  resetAuditForTests();
  flagsCalls = [];
  fakeMessages = [];
});

describe('#152 message.mark_seen audit（写路径）', () => {
  test('v1 路由 200 → audit 含 message.mark_seen + address/messageId/seen/actor', async () => {
    const created = createIdentity({ localpart: 'seen-v1-ok' })!;
    const address = created.identity.address;
    fakeMessages = [makeInboxMsg(101, address)];

    const res = await app.request('/v1/messages/101/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address, seen: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '101', seen: true });

    const text = auditFileText();
    expect(text).toContain('"event":"message.mark_seen"');
    const rows = readAuditEvents({ event: 'message.mark_seen', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'message.mark_seen',
      outcome: 'ok',
      address,
      actor: address,
      messageId: '101',
      seen: 'true',
    });
    expect(rows[0]!.ip).toBeUndefined();
  });

  test('v1 大小写变体地址 → audit 行 address 为小写（对齐 ui）', async () => {
    const created = createIdentity({ localpart: 'seen-v1-case' })!;
    const address = created.identity.address; // 规范小写
    // 请求体故意混大小写；forbidUnlessAddress 可放行，audit 必须归一
    const mixedCase = address
      .split('@')
      .map((part, i) => (i === 0 ? part.toUpperCase() : part.toUpperCase()))
      .join('@');
    expect(mixedCase).not.toBe(address);
    fakeMessages = [makeInboxMsg(102, address)];

    const res = await app.request('/v1/messages/102/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: mixedCase, seen: false }),
    });
    expect(res.status).toBe(200);

    const rows = readAuditEvents({ event: 'message.mark_seen', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(address);
    expect(rows[0]!.address).toBe(address.toLowerCase());
    expect(rows[0]!.seen).toBe('false');
  });

  test('ui 路由 200 → audit 同上且带 ip（DI mock setMessageSeen）', async () => {
    const address = 'fox@test.example';
    const setSeen = mock(async () => true);
    const store = new UiSessionStore({
      resolveToken: (token) =>
        token === 'ok' ? { kind: 'identity', address } : null,
    });
    const created = store.create('ok', '203.0.113.9');
    if (!created.ok) throw new Error('test session was not created');
    const uiApp = new Hono();
    uiApp.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: mock(async () => []),
        setMessageSeen: setSeen,
        getMailboxScan: mock(async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        })),
        getMessage: mock(async () => null),
        setPushContentTier: mock(() => null),
      }),
    );

    const before = auditFileText().length;
    const res = await uiApp.request('/ui/api/messages/7/seen', {
      method: 'POST',
      headers: {
        cookie: `oae_ui=${created.sid}`,
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.42',
      },
      body: JSON.stringify({ address, seen: false }),
    });
    expect(res.status).toBe(200);
    expect(setSeen).toHaveBeenCalledWith(address, '7', false);
    expect(auditFileText().length).toBeGreaterThan(before);

    const rows = readAuditEvents({ event: 'message.mark_seen', limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'message.mark_seen',
      outcome: 'ok',
      address,
      actor: address,
      messageId: '7',
      seen: 'false',
    });
    // ui 路由必须带 ip（clientIp；无 TRUST_PROXY 时多为 unknown）
    expect(typeof rows[0]!.ip).toBe('string');
    expect(rows[0]!.ip!.length).toBeGreaterThan(0);
  });

  test('404（setMessageSeen false）→ audit 零新增', async () => {
    const created = createIdentity({ localpart: 'seen-v1-404' })!;
    const address = created.identity.address;
    fakeMessages = [makeInboxMsg(101, address)];
    const before = auditFileText().length;

    const res = await app.request('/v1/messages/999/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address, seen: true }),
    });
    expect(res.status).toBe(404);
    expect(auditFileText().length).toBe(before);
    expect(flagsCalls).toHaveLength(0);
  });

  test('403（异址 identity）→ audit 零新增', async () => {
    const owner = createIdentity({ localpart: 'seen-owner' })!;
    const other = createIdentity({ localpart: 'seen-other' })!;
    fakeMessages = [makeInboxMsg(101, owner.identity.address)];
    const before = auditFileText().length;

    const res = await app.request('/v1/messages/101/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${other.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: owner.identity.address, seen: true }),
    });
    expect(res.status).toBe(403);
    expect(auditFileText().length).toBe(before);
    expect(flagsCalls).toHaveLength(0);
  });

  test('ui 404 → audit 零新增', async () => {
    const setSeen = mock(async () => false);
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'ok' ? { kind: 'admin' } : null),
    });
    const created = store.create('ok', '127.0.0.1');
    if (!created.ok) throw new Error('test session was not created');
    const uiApp = new Hono();
    uiApp.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: mock(async () => []),
        setMessageSeen: setSeen,
        getMailboxScan: mock(async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        })),
        getMessage: mock(async () => null),
        setPushContentTier: mock(() => null),
      }),
    );
    const before = auditFileText().length;
    const res = await uiApp.request('/ui/api/messages/7/seen', {
      method: 'POST',
      headers: {
        cookie: `oae_ui=${created.sid}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: 'fox@test.example', seen: true }),
    });
    expect(res.status).toBe(404);
    expect(auditFileText().length).toBe(before);
  });
});

describe('#152 读路径纯度金测（FakeImapFlow flags 写零调用）', () => {
  test('对照组：setMessageSeen 确实调用 flagsAdd/Remove（防假绿）', async () => {
    const address = 'ctrl@test.example';
    fakeMessages = [makeInboxMsg(55, address)];

    expect(await setMessageSeen(address, '55', true)).toBe(true);
    expect(flagsCalls.some((c) => c.op === 'add' && c.flags.includes('\\Seen'))).toBe(true);

    flagsCalls = [];
    expect(await setMessageSeen(address, '55', false)).toBe(true);
    expect(flagsCalls.some((c) => c.op === 'remove' && c.flags.includes('\\Seen'))).toBe(true);
  });

  test('六条读路径：flags 写零调用', async () => {
    const created = createIdentity({ localpart: 'seen-read-pure' })!;
    const address = created.identity.address;
    fakeMessages = [
      makeInboxMsg(201, address, '2026-09-01T10:00:00.000Z'),
      makeInboxMsg(202, address, '2026-09-01T11:00:00.000Z'),
    ];
    const auth = { authorization: `Bearer ${created.token}` };
    const cookie = await loginCookie(created.token);

    // 1) GET /v1/messages（list）
    flagsCalls = [];
    const listRes = await app.request(
      `/v1/messages?address=${encodeURIComponent(address)}&limit=10`,
      { headers: auth },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { messages: unknown[] };
    expect(listBody.messages.length).toBeGreaterThan(0);
    expect(flagsCalls).toHaveLength(0);

    // 2) GET /v1/messages?since=
    flagsCalls = [];
    const sinceCursor = encodeMailForwardCursor(
      {
        folder: 'inbox',
        address,
        t: new Date('2026-09-01T09:00:00.000Z').getTime(),
        uid: 1,
        uidValidity: 17,
      },
      config.taskSigningSecret,
    );
    const sinceRes = await app.request(
      `/v1/messages?address=${encodeURIComponent(address)}&since=${encodeURIComponent(sinceCursor)}&limit=10`,
      { headers: auth },
    );
    expect(sinceRes.status).toBe(200);
    expect(flagsCalls).toHaveLength(0);

    // 3) GET /v1/messages/:id
    flagsCalls = [];
    const detailRes = await app.request(
      `/v1/messages/201?address=${encodeURIComponent(address)}`,
      { headers: auth },
    );
    expect(detailRes.status).toBe(200);
    expect(flagsCalls).toHaveLength(0);

    // 4) GET /ui/api/messages
    flagsCalls = [];
    const uiList = await app.request(
      `/ui/api/messages?address=${encodeURIComponent(address)}`,
      { headers: { cookie } },
    );
    expect(uiList.status).toBe(200);
    expect(flagsCalls).toHaveLength(0);

    // 5) GET /ui/api/messages/:id/source
    flagsCalls = [];
    const uiSource = await app.request(
      `/ui/api/messages/201/source?address=${encodeURIComponent(address)}`,
      { headers: { cookie } },
    );
    expect(uiSource.status).toBe(200);
    expect(flagsCalls).toHaveLength(0);

    // 6) GET /ui/frame/:id
    flagsCalls = [];
    const frame = await app.request(
      `/ui/frame/201?address=${encodeURIComponent(address)}`,
      { headers: { cookie } },
    );
    expect(frame.status).toBe(200);
    expect(flagsCalls).toHaveLength(0);
  });
});

describe('#152 MCP 文案软化', () => {
  test('tools.ts 描述含全消费者影响 + since/wait 替代建议', async () => {
    const toolsSrc = readFileSync(
      join(import.meta.dir, '../src/mcp/tools.ts'),
      'utf8',
    );
    // 锚定 mail_mark_seen 工具块，避免误匹配其它工具描述
    const markSeenBlock = toolsSrc.slice(
      toolsSrc.indexOf('tier("mail_mark_seen"'),
      toolsSrc.indexOf('tier("mail_wait_for"'),
    );
    expect(markSeenBlock).toMatch(/all consumers/i);
    expect(markSeenBlock).toMatch(/since=/i);
    expect(markSeenBlock).toMatch(/mail_wait_for/);
    expect(markSeenBlock).not.toMatch(/Call this after processing/i);
  });

  test('packages/mcp/README.md 同步软化', () => {
    const readme = readFileSync(
      join(import.meta.dir, '../../mcp/README.md'),
      'utf8',
    );
    const line = readme
      .split('\n')
      .find((l) => l.includes('`mail_mark_seen'));
    expect(line).toBeTruthy();
    expect(line!).toMatch(/all mailbox consumers|all consumers/i);
    expect(line!).toMatch(/since=|mail_wait_for/);
  });
});
