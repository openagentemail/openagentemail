// sendMail 自动带 stamp：测 buildOutboundStampHeaders（smtp 模块在 send.test 里常被整模 mock）。
import { describe, expect, test } from 'bun:test';
import {
  MAIL_STAMP_HEADER,
  buildOutboundStampHeaders,
  createMailStamp,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  stampDate,
} from '../src/lib/mail-stamp.ts';

const KEY = 'smtp-stamp-test-key';

describe('sendMail 自动 stamp（buildOutboundStampHeaders）', () => {
  test('写出 X-OA-Mail-Stamp，且与同字段规约重算一致', () => {
    const date = stampDate(new Date('2026-08-09T14:00:00.123Z'));
    const headers = buildOutboundStampHeaders(
      {
        from: 'Alice@test.example',
        to: ['Bob@test.example', 'carol@test.example'],
        subject: 'Stamp me',
        text: 'hi body',
        html: '<p>hi</p>',
      },
      date,
      KEY,
    );

    const stamp = headers[MAIL_STAMP_HEADER];
    expect(typeof stamp).toBe('string');
    expect(stamp!.length).toBeGreaterThan(10);

    const expected = createMailStamp(
      {
        from: normalizeMailbox('Alice@test.example'),
        to: normalizeToList(['Bob@test.example', 'carol@test.example']),
        subject: 'Stamp me',
        dateIso: date.toISOString(),
        bodyHash: hashMailBody('hi body', '<p>hi</p>'),
      },
      KEY,
    );
    expect(stamp).toBe(expected);
  });

  test('保留调用方自定义头，并覆盖写入 stamp', () => {
    const date = stampDate(new Date('2026-08-09T15:00:00Z'));
    const headers = buildOutboundStampHeaders(
      {
        from: 'a@test.example',
        to: ['b@test.example'],
        subject: 'x',
        text: 'y',
        headers: { 'X-OA-Task': 'task-id', [MAIL_STAMP_HEADER]: 'forged' },
      },
      date,
      KEY,
    );
    expect(headers['X-OA-Task']).toBe('task-id');
    // 服务端 stamp 必须覆盖调用方伪造值。
    expect(headers[MAIL_STAMP_HEADER]).not.toBe('forged');
    expect(headers[MAIL_STAMP_HEADER]).toBe(
      createMailStamp(
        {
          from: 'a@test.example',
          to: 'b@test.example',
          subject: 'x',
          dateIso: date.toISOString(),
          bodyHash: hashMailBody('y'),
        },
        KEY,
      ),
    );
  });

  test('调用方小写同名 stamp 头被滤掉，出站只留一个规范头且可验签', async () => {
    const date = stampDate(new Date('2026-08-09T16:00:00Z'));
    const headers = buildOutboundStampHeaders(
      {
        from: 'a@test.example',
        to: ['b@test.example'],
        subject: 'dedupe',
        text: 'trusted body',
        headers: {
          'x-oa-mail-stamp': 'forged-lowercase',
          'X-Oa-Mail-Stamp': 'forged-mixed',
          'X-OA-Task': 'keep-me',
        },
      },
      date,
      KEY,
    );

    // 对象里只能有一个 stamp 键（规范名），异形同名不得残留。
    const stampKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-oa-mail-stamp');
    expect(stampKeys).toEqual([MAIL_STAMP_HEADER]);
    expect(headers['x-oa-mail-stamp']).toBeUndefined();
    expect(headers['X-Oa-Mail-Stamp']).toBeUndefined();
    expect(headers['X-OA-Task']).toBe('keep-me');
    expect(headers[MAIL_STAMP_HEADER]).not.toBe('forged-lowercase');

    // 经 nodemailer 真出站 → mailparser：只能看到一个 stamp 头（字符串），分类 internal。
    const nodemailer = (await import('nodemailer')).default;
    const { simpleParser } = await import('mailparser');
    const { classifyMailSource, hashMailBody: hashBody, normalizeMailbox: normFrom, normalizeToList: normTo } =
      await import('../src/lib/mail-stamp.ts');
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const info = await transport.sendMail({
      from: 'a@test.example',
      to: ['b@test.example'],
      subject: 'dedupe',
      text: 'trusted body',
      date,
      headers,
    });
    const parsed = await simpleParser(info.message as Buffer);
    const stampRaw = parsed.headers.get('x-oa-mail-stamp');
    expect(typeof stampRaw).toBe('string');
    expect(Array.isArray(stampRaw)).toBe(false);

    const html = typeof parsed.html === 'string' ? parsed.html : undefined;
    const source = classifyMailSource(
      typeof stampRaw === 'string' ? stampRaw : undefined,
      {
        from: normFrom(parsed.from?.value?.[0]?.address ?? ''),
        to: normTo((parsed.to as { value?: { address?: string }[] })?.value?.map((v) => v.address ?? '') ?? []),
        subject: parsed.subject ?? '',
        dateIso: (parsed.date ?? new Date(0)).toISOString(),
        bodyHash: hashBody(parsed.text ?? '', html),
      },
      KEY,
    );
    expect(source).toBe('internal');
  });
});
