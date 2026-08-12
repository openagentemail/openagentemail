// 收件人匹配的安全边界测试。
//
// 全部身份共用一个 catch-all 信箱，"这封信属于谁"完全由 messageMatchesAddress
// 决定 —— 它就是身份之间唯一的读权限边界。匹配一旦放宽（子串、把显示名里的
// 邮箱也当收件人、把注释里的地址也当收件人），持有 A 身份令牌的人就能读到 B
// 的邮件（含验证码）。
//
// config.ts 在 import 时解析环境变量，所以必须先设好再动态 import。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-1';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-imap-'));

const { describe, expect, mock, test } = await import('bun:test');

// 授权路径的回归需要跑真的 listMessages，所以在导入 imap.ts 之前先替掉 imapflow。
let fakeMessages: any[] = [];

class FakeImapFlow {
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
      source: message.source ?? Buffer.from('From: sender@example.net\r\nSubject: hi\r\n\r\nbody'),
    };
  }
  async messageFlagsAdd() {}
  async messageFlagsRemove() {}
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const {
  listMessages,
  listMessagesPage,
  getMessage,
  getMessageSource,
  setMessageSeen,
  messageMatchesAddress,
  messageRecipients,
  messageSenders,
  messageBelongsToFolder,
  messageAccessibleToAddress,
  messageIsTrustedSent,
  receivedAtMs,
  MAX_EMAIL_SOURCE_LENGTH,
} = await import('../src/lib/imap.ts');
const { recordSentMessageId, resetSentRegistryForTests } = await import('../src/lib/sent-registry.ts');
const { InvalidMailCursorError, encodeMailCursor } = await import('../src/lib/mail-cursor.ts');
const { config } = await import('../src/lib/config.ts');

/** 造一个只带必要字段的 IMAP 抓取结果（envelope + 收件头）。 */
function fakeMessage(opts: {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  headers?: string;
}): any {
  return {
    uid: 1,
    envelope: {
      to: (opts.to ?? []).map((address) => ({ address })),
      cc: (opts.cc ?? []).map((address) => ({ address })),
      bcc: (opts.bcc ?? []).map((address) => ({ address })),
    },
    headers: opts.headers === undefined ? undefined : Buffer.from(opts.headers, 'utf8'),
  };
}

const matches = (headers: string, address: string) =>
  messageMatchesAddress(fakeMessage({ headers }), address);

describe('messageMatchesAddress — 正常投递仍要能匹配', () => {
  test('信封 To 命中', () => {
    expect(messageMatchesAddress(fakeMessage({ to: ['fox-k7d2@test.example'] }), 'fox-k7d2@test.example')).toBe(true);
  });

  test('大小写不敏感', () => {
    expect(messageMatchesAddress(fakeMessage({ to: ['Fox-K7D2@Test.Example'] }), 'fox-k7d2@test.example')).toBe(true);
  });

  test('信封 Cc / Bcc 命中', () => {
    expect(messageMatchesAddress(fakeMessage({ cc: ['owl-9x1a@test.example'] }), 'owl-9x1a@test.example')).toBe(true);
    expect(messageMatchesAddress(fakeMessage({ bcc: ['owl-9x1a@test.example'] }), 'owl-9x1a@test.example')).toBe(true);
  });

  test('密送场景：信封里没有，但 Delivered-To 头里有', () => {
    const msg = fakeMessage({
      to: ['someone-else@other.example'],
      headers: 'Delivered-To: owl-9x1a@test.example\r\n',
    });
    expect(messageMatchesAddress(msg, 'owl-9x1a@test.example')).toBe(true);
  });

  test('Delivered-To 带显示名的 <addr> 形式，尖括号里的地址命中', () => {
    expect(matches('Delivered-To: Owl Agent <owl-9x1a@test.example>\r\n', 'owl-9x1a@test.example')).toBe(true);
  });

  test('折行（RFC 5322 folding）的头也能匹配', () => {
    expect(matches('Delivered-To:\r\n owl-9x1a@test.example\r\n', 'owl-9x1a@test.example')).toBe(true);
  });

  test('字段名大小写、地址大小写都不敏感', () => {
    expect(matches('DELIVERED-TO: OWL-9X1A@TEST.EXAMPLE\r\n', 'owl-9x1a@test.example')).toBe(true);
  });

  test('一个字段里列多个地址，每个都算数', () => {
    const headers = 'Delivered-To: owl-9x1a@test.example, fox-k7d2@test.example\r\n';
    expect(matches(headers, 'owl-9x1a@test.example')).toBe(true);
    expect(matches(headers, 'fox-k7d2@test.example')).toBe(true);
  });

  test('带 RFC 5322 注释和尾部标点的投递头', () => {
    expect(matches('Delivered-To: owl-9x1a@test.example (Postfix)\r\n', 'owl-9x1a@test.example')).toBe(true);
    expect(matches('Delivered-To: owl-9x1a@test.example;\r\n', 'owl-9x1a@test.example')).toBe(true);
  });
});

describe('messageMatchesAddress — 越权读取必须被挡住', () => {
  test('自己的地址是别人地址的后缀时，不得读到别人的邮件', () => {
    // 攻击者注册 localpart "k7d2"，受害者是 fox-k7d2@test.example。
    // "fox-k7d2@test.example" 包含子串 "k7d2@test.example"。
    const victimMail = fakeMessage({
      to: ['fox-k7d2@test.example'],
      headers: 'Delivered-To: fox-k7d2@test.example\r\n',
    });
    expect(messageMatchesAddress(victimMail, 'k7d2@test.example')).toBe(false);
  });

  test('catch-all 账号的 Delivered-To 不得把整个信箱开放给后缀身份', () => {
    // Postfix 通配别名投递后，每封信都带 "Delivered-To: agent@test.example"。
    // 攻击者注册 localpart "ent" 即可匹配全部邮件。
    const anyMail = fakeMessage({
      to: ['victim@test.example'],
      headers: 'Delivered-To: agent@test.example\r\nX-Original-To: victim@test.example\r\n',
    });
    expect(messageMatchesAddress(anyMail, 'ent@test.example')).toBe(false);
    expect(messageMatchesAddress(anyMail, 'victim@test.example')).toBe(true);
  });

  test('显示名里的邮箱不是收件人（带引号）', () => {
    const headers = 'Delivered-To: "victim@test.example" <other@test.example>\r\n';
    expect(matches(headers, 'victim@test.example')).toBe(false);
    expect(matches(headers, 'other@test.example')).toBe(true);
  });

  test('显示名里的邮箱不是收件人（不带引号）', () => {
    const headers = 'Delivered-To: victim@test.example <other@test.example>\r\n';
    expect(matches(headers, 'victim@test.example')).toBe(false);
    expect(matches(headers, 'other@test.example')).toBe(true);
  });

  test('注释里出现的第三方地址不是收件人', () => {
    const headers = 'Delivered-To: victim@test.example (forwarded for attacker@test.example)\r\n';
    expect(matches(headers, 'attacker@test.example')).toBe(false);
    expect(matches(headers, 'victim@test.example')).toBe(true);
  });

  test('地址出现在头部的其它位置（不是收件字段）不算命中', () => {
    const headers =
      'Delivered-To: victim@test.example\r\nX-Note: reply-to bear-22aa@test.example please\r\nSubject: bear-22aa@test.example\r\n';
    expect(matches(headers, 'bear-22aa@test.example')).toBe(false);
  });

  test('没有任何头且信封不含自己时不匹配', () => {
    expect(messageMatchesAddress(fakeMessage({ to: ['a@test.example'] }), 'b@test.example')).toBe(false);
  });
});

// messageRecipients 是授权与统计共用的唯一原语。它一旦跟 messageMatchesAddress
// 的结论分叉，"这封信属于谁"就有了两个答案；一旦在它里面加上限，读权限边界会
// 跟着统计的内存上界一起变窄。
describe('messageRecipients — 与匹配原语同源，且没有任何上限', () => {
  // A23：无 envelope 一律 fail-closed
  test('没有 envelope 时收件人集合为空，Delivered-To 也不算', () => {
    const msg = {
      uid: 1,
      headers: Buffer.from('Delivered-To: fox-k7d2@test.example\r\n', 'utf8'),
    } as any;
    expect(messageRecipients(msg).size).toBe(0);
    expect(messageMatchesAddress(msg, 'fox-k7d2@test.example')).toBe(false);
  });

  // A25：既有投毒语料逐条对齐
  test('投毒语料下两个函数的结论逐条一致', () => {
    const corpus: Array<{ msg: any; address: string; expected: boolean }> = [
      {
        msg: fakeMessage({ headers: 'Subject: fox-k7d2@test.example\r\n' }),
        address: 'fox-k7d2@test.example',
        expected: false,
      },
      {
        msg: fakeMessage({ headers: 'Delivered-To: "victim@test.example" <other@test.example>\r\n' }),
        address: 'victim@test.example',
        expected: false,
      },
      {
        msg: fakeMessage({ headers: 'Delivered-To: "victim@test.example" <other@test.example>\r\n' }),
        address: 'other@test.example',
        expected: true,
      },
      {
        msg: fakeMessage({ headers: 'Delivered-To: victim@test.example (fox-k7d2@test.example)\r\n' }),
        address: 'fox-k7d2@test.example',
        expected: false,
      },
      {
        msg: fakeMessage({ headers: 'Delivered-To: fox-k7d2@test.example\r\n' }),
        address: 'k7d2@test.example',
        expected: false,
      },
      {
        msg: fakeMessage({ headers: 'Delivered-To:\r\n owl-9x1a@test.example\r\n' }),
        address: 'owl-9x1a@test.example',
        expected: true,
      },
    ];
    for (const entry of corpus) {
      expect(messageRecipients(entry.msg).has(entry.address)).toBe(entry.expected);
      expect(messageMatchesAddress(entry.msg, entry.address)).toBe(entry.expected);
    }
  });

  // A26：私有的 RECIPIENT_HEADERS / stripComments / parseRecipient / ADDRESS_RE
  // 行为快照 —— 通过唯一原语观察，改动它们这条断言就会红。
  test('收件字段集合、注释剥离、角括号取址、地址正则的行为快照不变', () => {
    const msg = fakeMessage({
      to: ['To-Env@Test.Example'],
      cc: ['cc@test.example'],
      bcc: ['bcc@test.example'],
      headers:
        'Delivered-To: delivered@test.example\r\n' +
        'X-Original-To: original@test.example\r\n' +
        'Envelope-To: envelope@test.example\r\n' +
        'X-Forwarded-To: forwarded@test.example\r\n' +
        'To: header-to@test.example\r\n' +
        'Cc: header-cc@test.example\r\n' +
        'Bcc: header-bcc@test.example\r\n' +
        'X-Note: ignored@test.example\r\n' +
        'Subject: subject@test.example\r\n' +
        'Reply-To: reply@test.example\r\n' +
        'Delivered-To: spaced@test.example ;\r\n' +
        'Delivered-To: not an address\r\n' +
        'Delivered-To: two@at@signs\r\n',
    });
    expect([...messageRecipients(msg)].sort()).toEqual([
      'bcc@test.example',
      'cc@test.example',
      'delivered@test.example',
      'envelope@test.example',
      'forwarded@test.example',
      'header-bcc@test.example',
      'header-cc@test.example',
      'header-to@test.example',
      'original@test.example',
      'spaced@test.example',
      'to-env@test.example',
    ]);
  });

  // A24：201 个域内收件人、第 201 个是身份 —— 授权路径不受统计层截断影响
  test('一封 201 个收件人的信，第 201 个身份仍读得到它', async () => {
    const recipients: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      recipients.push(`bystander-${index}@test.example`);
    }
    recipients.push('fox-k7d2@test.example');
    const crowded = {
      uid: 21,
      envelope: {
        from: [{ address: 'sender@example.net' }],
        to: recipients.map((address) => ({ address })),
        subject: 'crowded',
        date: new Date('2026-07-27T00:00:00Z'),
      },
      internalDate: new Date('2026-07-27T00:00:00Z'),
      flags: new Set<string>(),
      headers: Buffer.from('Delivered-To: agent@test.example\r\n', 'utf8'),
    } as any;

    expect(messageRecipients(crowded).size).toBe(202);
    expect(messageMatchesAddress(crowded, 'fox-k7d2@test.example')).toBe(true);

    fakeMessages = [crowded];
    const summaries = await listMessages('fox-k7d2@test.example');
    expect(summaries.map((summary) => summary.id)).toEqual(['21']);
    fakeMessages = [];
  });
});

// 排序决定 wait_for 认哪封是"最新的一封"。信封里的 Date 是发件人自己写的，
// 可以随便伪造；必须以 IMAP 服务器记录的收信时间（INTERNALDATE）为准。
describe('receivedAtMs — 按服务器收信时间排序', () => {
  const dated = (internal?: string, claimed?: string): any => ({
    uid: 1,
    ...(internal ? { internalDate: new Date(internal) } : {}),
    envelope: claimed ? { date: new Date(claimed) } : {},
  });

  test('优先用 internalDate，而不是发件人声明的 Date', () => {
    expect(receivedAtMs(dated('2026-07-01T00:00:00Z', '2999-01-01T00:00:00Z'))).toBe(
      Date.parse('2026-07-01T00:00:00Z'),
    );
  });

  test('没有 internalDate 时回落到信封 Date', () => {
    expect(receivedAtMs(dated(undefined, '2026-07-01T00:00:00Z'))).toBe(
      Date.parse('2026-07-01T00:00:00Z'),
    );
  });

  test('两者都没有时给 0，不会产生 NaN 把排序打乱', () => {
    expect(receivedAtMs(dated())).toBe(0);
    expect(receivedAtMs({ uid: 1, envelope: { date: new Date('not a date') } } as any)).toBe(0);
  });

  test('伪造未来 Date 的邮件不能顶到最前面', () => {
    // 攻击者把 Date 写成 2999 年，想让自己的假验证码永远排在真验证码前面。
    const spoofed = dated('2026-07-01T10:00:00Z', '2999-01-01T00:00:00Z');
    const real = dated('2026-07-01T10:05:00Z', '2026-07-01T10:05:00Z');
    expect([spoofed, real].sort((a, b) => receivedAtMs(b) - receivedAtMs(a))[0]).toBe(real);
  });
});

function folderMessage(opts: {
  uid: number;
  from: string;
  to: string;
  at: string;
  source?: Buffer;
  messageId?: string;
}): any {
  return {
    uid: opts.uid,
    envelope: {
      from: [{ address: opts.from }],
      to: [{ address: opts.to }],
      subject: `m${opts.uid}`,
      date: new Date(opts.at),
      messageId: opts.messageId ?? `<m${opts.uid}@test.example>`,
    },
    internalDate: new Date(opts.at),
    flags: new Set<string>(),
    headers: Buffer.from(`Delivered-To: ${opts.to}\r\n`, 'utf8'),
    ...(opts.source ? { source: opts.source } : {}),
  };
}

describe('folder matching — Inbox / Sent / All Mail', () => {
  const inboxOnly = folderMessage({
    uid: 1,
    from: 'ext@example.net',
    to: 'fox@test.example',
    at: '2026-08-01T10:00:00Z',
  });
  const sentOnly = folderMessage({
    uid: 2,
    from: 'fox@test.example',
    to: 'ext@example.net',
    at: '2026-08-01T11:00:00Z',
  });
  const both = folderMessage({
    uid: 3,
    from: 'fox@test.example',
    to: 'fox@test.example',
    at: '2026-08-01T12:00:00Z',
  });
  const other = folderMessage({
    uid: 4,
    from: 'owl@test.example',
    to: 'owl@test.example',
    at: '2026-08-01T13:00:00Z',
  });

  test('messageSenders 只认信封 From 精确邮箱', () => {
    expect([...messageSenders(sentOnly)]).toEqual(['fox@test.example']);
    expect(messageSenders(inboxOnly).has('fox@test.example')).toBe(false);
    expect(messageSenders({ uid: 9 } as any).size).toBe(0);
  });

  test('三 folder 集合正确且 Sent 不含纯收件', () => {
    resetSentRegistryForTests();
    recordSentMessageId('<m2@test.example>', 'fox@test.example');
    recordSentMessageId('<m3@test.example>', 'fox@test.example');
    expect(messageBelongsToFolder(inboxOnly, 'fox@test.example', 'inbox')).toBe(true);
    expect(messageBelongsToFolder(inboxOnly, 'fox@test.example', 'sent')).toBe(false);
    expect(messageBelongsToFolder(sentOnly, 'fox@test.example', 'inbox')).toBe(false);
    expect(messageBelongsToFolder(sentOnly, 'fox@test.example', 'sent')).toBe(true);
    expect(messageBelongsToFolder(both, 'fox@test.example', 'all')).toBe(true);
    expect(messageBelongsToFolder(other, 'fox@test.example', 'all')).toBe(false);
  });

  test('详情 ACL：可信 Sent 的 FROM 匹配可读，外人不可读', () => {
    resetSentRegistryForTests();
    recordSentMessageId('<m2@test.example>', 'fox@test.example');
    expect(messageAccessibleToAddress(sentOnly, 'fox@test.example')).toBe(true);
    expect(messageAccessibleToAddress(sentOnly, 'owl@test.example')).toBe(false);
    expect(messageAccessibleToAddress(inboxOnly, 'fox@test.example')).toBe(true);
  });

  test('listMessagesPage 三 folder 去重且 Sent 不含纯收件', async () => {
    resetSentRegistryForTests();
    recordSentMessageId('<m2@test.example>', 'fox@test.example');
    recordSentMessageId('<m3@test.example>', 'fox@test.example');
    fakeMessages = [inboxOnly, sentOnly, both, other];
    const inbox = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 50 });
    const sent = await listMessagesPage('fox@test.example', { folder: 'sent', limit: 50 });
    const all = await listMessagesPage('fox@test.example', { folder: 'all', limit: 50 });
    expect(inbox.messages.map((m) => m.id).sort()).toEqual(['1', '3']);
    expect(sent.messages.map((m) => m.id).sort()).toEqual(['2', '3']);
    expect(all.messages.map((m) => m.id).sort()).toEqual(['1', '2', '3']);
    expect(all.messages.map((m) => m.id)).toEqual([...new Set(all.messages.map((m) => m.id))]);
    fakeMessages = [];
  });

  test('getMessage 对可信 Sent（FROM∧registry）可读', async () => {
    resetSentRegistryForTests();
    recordSentMessageId('<m2@test.example>', 'fox@test.example');
    fakeMessages = [sentOnly];
    const detail = await getMessage('fox@test.example', '2');
    expect(detail?.id).toBe('2');
    expect(await getMessage('owl@test.example', '2')).toBeNull();
    fakeMessages = [];
  });
});

describe('伪造 From 不得进 Sent，非收件人四入口不可见', () => {
  const forged = folderMessage({
    uid: 99,
    from: 'fox@test.example',
    to: 'owl@test.example',
    at: '2026-08-01T14:00:00Z',
    messageId: '<forged-not-outbound@evil.example>',
  });

  test('伪造信落收件人 Inbox，但不进任何人的 Sent', () => {
    resetSentRegistryForTests();
    expect(messageBelongsToFolder(forged, 'owl@test.example', 'inbox')).toBe(true);
    expect(messageBelongsToFolder(forged, 'owl@test.example', 'sent')).toBe(false);
    expect(messageBelongsToFolder(forged, 'fox@test.example', 'inbox')).toBe(false);
    expect(messageBelongsToFolder(forged, 'fox@test.example', 'sent')).toBe(false);
    expect(messageIsTrustedSent(forged, 'fox@test.example')).toBe(false);
  });

  test('列表/详情/Source/Seen 对非收件人全不可见', async () => {
    resetSentRegistryForTests();
    fakeMessages = [forged];
    const sentList = await listMessagesPage('fox@test.example', { folder: 'sent', limit: 50 });
    const allList = await listMessagesPage('fox@test.example', { folder: 'all', limit: 50 });
    const inboxList = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 50 });
    expect(sentList.messages).toEqual([]);
    expect(allList.messages).toEqual([]);
    expect(inboxList.messages).toEqual([]);
    expect(await getMessage('fox@test.example', '99')).toBeNull();
    expect(await getMessageSource('fox@test.example', '99')).toBeNull();
    expect(await setMessageSeen('fox@test.example', '99', true)).toBe(false);
    const owlInbox = await listMessagesPage('owl@test.example', { folder: 'inbox', limit: 50 });
    expect(owlInbox.messages.map((m) => m.id)).toEqual(['99']);
    fakeMessages = [];
  });

  test('抄真实出站 Message-ID 也不能让另一个 From 进 Sent', async () => {
    resetSentRegistryForTests();
    recordSentMessageId('<real-outbound@test.example>', 'owl@test.example');
    const spoof = folderMessage({
      uid: 100,
      from: 'fox@test.example',
      to: 'owl@test.example',
      at: '2026-08-01T15:00:00Z',
      messageId: '<real-outbound@test.example>',
    });
    fakeMessages = [spoof];
    expect(messageIsTrustedSent(spoof, 'fox@test.example')).toBe(false);
    expect(await getMessage('fox@test.example', '100')).toBeNull();
    expect(await getMessageSource('fox@test.example', '100')).toBeNull();
    expect(await setMessageSeen('fox@test.example', '100', true)).toBe(false);
    const sent = await listMessagesPage('fox@test.example', { folder: 'sent', limit: 50 });
    expect(sent.messages).toEqual([]);
    fakeMessages = [];
  });
});

describe('listMessagesPage cursor — 无重复无跳页', () => {
  test('limit=2 两页拼接等于全量且无交集', async () => {
    const msgs = [];
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
    fakeMessages = msgs;
    const page1 = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(['5', '4']);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listMessagesPage('fox@test.example', {
      folder: 'inbox',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual(['3', '2']);
    const overlap = page1.messages.filter((a) => page2.messages.some((b) => b.id === a.id));
    expect(overlap).toEqual([]);
    const page3 = await listMessagesPage('fox@test.example', {
      folder: 'inbox',
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.messages.map((m) => m.id)).toEqual(['1']);
    expect(page3.nextCursor).toBeNull();
    fakeMessages = [];
  });

  test('同毫秒用 uid 打破平局，不跳页', async () => {
    const at = '2026-08-01T10:00:00Z';
    fakeMessages = [
      folderMessage({ uid: 10, from: 'ext@example.net', to: 'fox@test.example', at }),
      folderMessage({ uid: 11, from: 'ext@example.net', to: 'fox@test.example', at }),
      folderMessage({ uid: 12, from: 'ext@example.net', to: 'fox@test.example', at }),
    ];
    const page1 = await listMessagesPage('fox@test.example', { folder: 'inbox', limit: 2 });
    expect(page1.messages.map((m) => m.id)).toEqual(['12', '11']);
    const page2 = await listMessagesPage('fox@test.example', {
      folder: 'inbox',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages.map((m) => m.id)).toEqual(['10']);
    fakeMessages = [];
  });

  test('坏游标 / 跨 folder 游标抛 InvalidMailCursorError', async () => {
    fakeMessages = [
      folderMessage({
        uid: 1,
        from: 'ext@example.net',
        to: 'fox@test.example',
        at: '2026-08-01T10:00:00Z',
      }),
    ];
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    const foreign = encodeMailCursor(
      { folder: 'sent', address: 'fox@test.example', t: Date.now(), uid: 1 },
      config.taskSigningSecret,
    );
    await expect(
      listMessagesPage('fox@test.example', { folder: 'inbox', cursor: foreign }),
    ).rejects.toBeInstanceOf(InvalidMailCursorError);
    fakeMessages = [];
  });
});

describe('getMessageSource — ACL 与截断', () => {
  test('外人读不到 Source', async () => {
    fakeMessages = [
      folderMessage({
        uid: 7,
        from: 'ext@example.net',
        to: 'fox@test.example',
        at: '2026-08-01T10:00:00Z',
      }),
    ];
    expect(await getMessageSource('owl@test.example', '7')).toBeNull();
    const own = await getMessageSource('fox@test.example', '7');
    expect(own?.id).toBe('7');
    expect(own?.truncated).toBe(false);
    fakeMessages = [];
  });

  test('超过上限截断并标记 truncated，byteLength 为原文长度', async () => {
    const raw = Buffer.alloc(MAX_EMAIL_SOURCE_LENGTH + 40, 0x41);
    fakeMessages = [
      folderMessage({
        uid: 8,
        from: 'ext@example.net',
        to: 'fox@test.example',
        at: '2026-08-01T10:00:00Z',
        source: raw,
      }),
    ];
    const payload = await getMessageSource('fox@test.example', '8');
    expect(payload?.truncated).toBe(true);
    expect(payload?.byteLength).toBe(raw.length);
    expect(Buffer.byteLength(payload!.source, 'utf8')).toBe(MAX_EMAIL_SOURCE_LENGTH);
    fakeMessages = [];
  });

  test('截断落在多字节序列中间时回退到字符边界，不产生替换字符', async () => {
    const euro = Buffer.from('€', 'utf8'); // e2 82 ac
    const prefix = Buffer.alloc(MAX_EMAIL_SOURCE_LENGTH - 1, 0x41);
    const raw = Buffer.concat([prefix, euro, Buffer.from('TAIL')]);
    fakeMessages = [
      folderMessage({
        uid: 9,
        from: 'ext@example.net',
        to: 'fox@test.example',
        at: '2026-08-01T10:00:00Z',
        source: raw,
      }),
    ];
    const payload = await getMessageSource('fox@test.example', '9');
    expect(payload?.truncated).toBe(true);
    expect(payload?.byteLength).toBe(raw.length);
    expect(payload!.source.includes('\uFFFD')).toBe(false);
    expect(Buffer.byteLength(payload!.source, 'utf8')).toBe(MAX_EMAIL_SOURCE_LENGTH - 1);
    fakeMessages = [];
  });
});
