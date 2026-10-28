// 入站详情上的 messageId / references。不连真实 IMAP、SMTP 或 webhook 端点。
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';

import { describe, expect, test } from 'bun:test';
import { simpleParser } from 'mailparser';
import type { WebhookSubscription } from '../src/lib/webhook-store.ts';

const { toDetail } = await import('../src/lib/imap.ts');
const { REFERENCES_MAX_COUNT, detailThreadFields } = await import('../src/lib/reply-thread.ts');
const { formatMailPayload, mailEventInputFromDetail } = await import('../src/lib/webhook-delivery.ts');

/** 拼一封最小 MIME。extra 是已经带 CRLF 的头行。 */
function mime(extra = '', body = 'hello'): string {
  return (
    'From: alice@test.example\r\n' +
    'To: bob@test.example\r\n' +
    'Subject: s\r\n' +
    'Date: Thu, 01 Oct 2026 00:00:00 +0000\r\n' +
    extra +
    '\r\n' +
    body
  );
}

async function detailFrom(extra = '', body = 'hello') {
  const parsed = await simpleParser(mime(extra, body));
  return toDetail(7, parsed);
}

/** 第 i 个合法 msg-id。 */
function idAt(i: number): string {
  return `<n${i}@example.com>`;
}

/** 长度恰好为 n 的尖括号 msg-id。 */
function msgIdOfLength(n: number): string {
  const local = 'a'.repeat(n - '<@example.com>'.length);
  return `<${local}@example.com>`;
}

describe('toDetail 线程字段', () => {
  test('合法的 messageId 与 references 保序去重，不把本信 id 或单独的 In-Reply-To 补进去', async () => {
    const detail = await detailFrom(
      'Message-ID: <self@example.com>\r\n' +
        'In-Reply-To: <parent@example.com>\r\n' +
        'References: <grand@example.com> <not-an-id> <a@b@example.com> <grand@example.com> <also@example.com>\r\n',
    );
    expect(detail.messageId).toBe('<self@example.com>');
    expect(detail.references).toEqual(['<grand@example.com>', '<also@example.com>']);
    expect(detail.references).not.toContain('<self@example.com>');
    expect(detail.references).not.toContain('<parent@example.com>');
  });

  test('In-Reply-To 不单独成为 references；一条 References 仍是数组', async () => {
    const detail = await detailFrom(
      'Message-ID: <self@example.com>\r\n' +
        'In-Reply-To: <parent@example.com>\r\n' +
        'References: <only@example.com>\r\n',
    );
    expect(detail.messageId).toBe('<self@example.com>');
    expect(detail.references).toEqual(['<only@example.com>']);
  });

  test('多条 References 头按出现顺序拼接', async () => {
    const detail = await detailFrom(
      'References: <first@example.com>\r\n' + 'References: <second@example.com>\r\n',
    );
    expect(detail.references).toEqual(['<first@example.com>', '<second@example.com>']);
    expect(detail).not.toHaveProperty('messageId');
  });

  test('折叠的 References 展开后仍保序', async () => {
    const detail = await detailFrom(
      'References: <fold-a@example.com>\r\n\t<fold-b@example.com>\r\n',
    );
    expect(detail.references).toEqual(['<fold-a@example.com>', '<fold-b@example.com>']);
  });

  test('没有尖括号的 Message-ID 解析成尖括号形式后收下', async () => {
    const detail = await detailFrom('Message-ID: bare@example.com\r\n');
    expect(detail.messageId).toBe('<bare@example.com>');
    expect(detail).not.toHaveProperty('references');
  });

  test('大小写保持原样', async () => {
    const detail = await detailFrom('Message-ID: <AbC@Example.com>\r\n');
    expect(detail.messageId).toBe('<AbC@Example.com>');
  });

  test('缺头时两个字段都省略', async () => {
    const detail = await detailFrom();
    expect(detail).not.toHaveProperty('messageId');
    expect(detail).not.toHaveProperty('references');
    expect(detail.id).toBe('7');
  });

  test('非法 Message-ID 省略，合法 references 仍保留', async () => {
    const cases = ['<no-at>', '<a@b@example.com>', '<bad id@example.com>'];
    for (const messageId of cases) {
      const detail = await detailFrom(
        `Message-ID: ${messageId}\r\nReferences: <ok@example.com>\r\n`,
      );
      expect(detail, messageId).not.toHaveProperty('messageId');
      expect(detail.references).toEqual(['<ok@example.com>']);
    }
  });

  test('references 全非法时省略该字段', async () => {
    const detail = await detailFrom(
      'Message-ID: <ok@example.com>\r\nReferences: <nope> <a@b@example.com>\r\n',
    );
    expect(detail.messageId).toBe('<ok@example.com>');
    expect(detail).not.toHaveProperty('references');
  });

  test('250 字符的 Message-ID 保留，251 省略', async () => {
    const ok = msgIdOfLength(250);
    const tooLong = msgIdOfLength(251);
    expect(ok).toHaveLength(250);
    expect(tooLong).toHaveLength(251);
    expect((await detailFrom(`Message-ID: ${ok}\r\n`)).messageId).toBe(ok);
    expect(await detailFrom(`Message-ID: ${tooLong}\r\n`)).not.toHaveProperty('messageId');
  });

  test('收下典型 id 和字面量右侧，丢掉逗号引号反斜杠空格点号和超长', () => {
    expect(detailThreadFields({ messageId: '<typical@example.com>' }).messageId).toBe(
      '<typical@example.com>',
    );
    expect(detailThreadFields({ messageId: '<a.b+tag@ex-ample.com>' }).messageId).toBe(
      '<a.b+tag@ex-ample.com>',
    );
    expect(detailThreadFields({ messageId: '<left@[127.0.0.1]>' }).messageId).toBe(
      '<left@[127.0.0.1]>',
    );
    const bad = [
      '<a,b@example.com>',
      '<"ab"@example.com>',
      '<a\\b@example.com>',
      '<a b@example.com>',
      '<a..b@example.com>',
      '<.a@example.com>',
      '<a.@example.com>',
      '<a@.example.com>',
      '<a@example.com.>',
      msgIdOfLength(251),
    ];
    for (const messageId of bad) {
      expect(
        detailThreadFields({ messageId, references: [messageId, '<ok@example.com>'] }),
        messageId,
      ).toEqual({ references: ['<ok@example.com>'] });
    }
  });

  test('恰好 50 条全保留，51 条合法 id 丢掉最旧的一条', async () => {
    const fifty = Array.from({ length: REFERENCES_MAX_COUNT }, (_, i) => idAt(i));
    const fiftyOne = Array.from({ length: REFERENCES_MAX_COUNT + 1 }, (_, i) => idAt(i));
    const kept = await detailFrom(`References: ${fifty.join(' ')}\r\n`);
    expect(kept.references).toEqual(fifty);
    const capped = await detailFrom(`References: ${fiftyOne.join(' ')}\r\n`);
    expect(capped.references).toEqual(fiftyOne.slice(1));
    expect(capped.references).toHaveLength(REFERENCES_MAX_COUNT);
    expect(capped.references).not.toContain(fiftyOne[0]);
  });

  test('去重后再截断：末尾重复的最旧 id 不会被补回', async () => {
    const unique = Array.from({ length: REFERENCES_MAX_COUNT + 1 }, (_, i) => idAt(i));
    const header = [...unique, unique[0]].join(' ');
    const detail = await detailFrom(`References: ${header}\r\n`);
    expect(detail.references).toEqual(unique.slice(1));
    expect(detail.references).not.toContain(unique[0]);
  });

  test('非法项不占 50 条名额', async () => {
    const head = Array.from({ length: REFERENCES_MAX_COUNT - 1 }, (_, i) => idAt(i));
    // 不含空格：解析器会按空白切开，切开后的碎片不能拿来当“非法项”。
    const junk = Array.from({ length: 20 }, (_, i) => `<nope${i}>`);
    const tail = [idAt(100), idAt(101)];
    const detail = await detailFrom(
      `References: ${[...head, ...junk, ...tail].join(' ')}\r\n`,
    );
    const valid = [...head, ...tail];
    expect(valid).toHaveLength(REFERENCES_MAX_COUNT + 1);
    expect(detail.references).toEqual(valid.slice(1));
    expect(detail.references).not.toContain(head[0]);
    expect(detail.references).toContain(idAt(100));
    expect(detail.references).toContain(idAt(101));
    expect(detail.references!.some((id) => id.includes('nope'))).toBe(false);
  });

  test('控制字符和未编码的非 ASCII 不过校验', () => {
    expect(detailThreadFields({ messageId: '<a@b\u0001c.com>' })).toEqual({});
    expect(detailThreadFields({ messageId: '<a@例子.com>', references: ['<ok@例子.com>'] })).toEqual(
      {},
    );
    expect(detailThreadFields({ messageId: 1, references: null })).toEqual({});
  });

  test('webhook 载荷仍用 IMAP UID，不带这两项', async () => {
    const rfcId = '<rfc-thread@example.com>';
    const refId = '<rfc-ref@example.com>';
    const detail = await detailFrom(`Message-ID: ${rfcId}\r\nReferences: ${refId}\r\n`);
    expect(detail.messageId).toBe(rfcId);
    expect(detail.references).toEqual([refId]);
    const input = mailEventInputFromDetail(detail, {
      address: 'bob@test.example',
      messageId: detail.id,
      uidValidity: 17,
      sizeBytes: 40,
      hasAttachments: false,
      unread: true,
    });
    expect(input.messageId).toBe('7');
    expect(input).not.toHaveProperty('references');
    const envelope = {
      id: 'evt_thread',
      type: 'mail.received' as const,
      payloadVersion: 'v1' as const,
      createdAt: '2026-10-01T00:00:00.000Z',
      domain: 'test.example',
    };
    for (const contentScope of ['metadata', 'preview'] as const) {
      const body = formatMailPayload(
        { contentScope, id: 'whk_thread' } as WebhookSubscription,
        envelope,
        input,
      ).body;
      const payload = JSON.parse(body) as { data: { messageId?: string } };
      expect(payload.data.messageId).toBe('7');
      expect(body).not.toContain('rfc-thread');
      expect(body).not.toContain('rfc-ref');
    }
  });
});
