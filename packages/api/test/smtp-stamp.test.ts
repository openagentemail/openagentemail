// sendMail 自动带 stamp：测 buildOutboundStampHeaders（smtp 模块在 send.test 里常被整模 mock）。
import { describe, expect, test } from 'bun:test';
import {
  MAIL_STAMP_HEADER,
  buildOutboundStampHeaders,
  classifyMailSource,
  createMailStamp,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  stampDate,
} from '../src/lib/mail-stamp.ts';

const KEY = 'smtp-stamp-test-key';
const DOMAIN = 'test.example';

function parsedToList(parsed: {
  to?: { value?: { address?: string }[] } | { value?: { address?: string }[] }[];
}): string[] {
  const to = parsed.to;
  if (!to) return [];
  const objects = Array.isArray(to) ? to : [to];
  const out: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value ?? []) {
      if (entry.address) out.push(entry.address);
    }
  }
  return out;
}

describe('sendMail 自动 stamp（buildOutboundStampHeaders）', () => {
  test('全本域收件人：写出 X-OA-Mail-Stamp，且与同字段规约重算一致', () => {
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
      DOMAIN,
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

  test('混合收件人：不写 stamp 头（防 HMAC 预言机）', () => {
    const date = stampDate(new Date('2026-08-09T14:30:00Z'));
    const headers = buildOutboundStampHeaders(
      {
        from: 'a@test.example',
        to: ['local@test.example', 'outside@evil.example'],
        subject: 'mixed',
        text: 'body',
        headers: { 'X-OA-Task': 'task-id', [MAIL_STAMP_HEADER]: 'forged' },
      },
      date,
      KEY,
      DOMAIN,
    );
    expect(headers['X-OA-Task']).toBe('task-id');
    // 调用方伪造的 stamp 也被滤掉，且不写新 stamp。
    expect(headers[MAIL_STAMP_HEADER]).toBeUndefined();
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'x-oa-mail-stamp')).toEqual([]);
  });

  test('保留调用方自定义头，并覆盖写入 stamp（全本域）', () => {
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
      DOMAIN,
    );
    expect(headers['X-OA-Task']).toBe('task-id');
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
      DOMAIN,
    );

    const stampKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'x-oa-mail-stamp');
    expect(stampKeys).toEqual([MAIL_STAMP_HEADER]);
    expect(headers['x-oa-mail-stamp']).toBeUndefined();
    expect(headers['X-Oa-Mail-Stamp']).toBeUndefined();
    expect(headers['X-OA-Task']).toBe('keep-me');
    expect(headers[MAIL_STAMP_HEADER]).not.toBe('forged-lowercase');

    const nodemailer = (await import('nodemailer')).default;
    const { simpleParser } = await import('mailparser');
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
        from: normalizeMailbox(parsed.from?.value?.[0]?.address ?? ''),
        to: normalizeToList(parsedToList(parsed)),
        subject: parsed.subject ?? '',
        dateIso: (parsed.date ?? new Date(0)).toISOString(),
        bodyHash: hashMailBody(parsed.text ?? '', html),
      },
      KEY,
    );
    expect(source).toBe('internal');
  });

  test('HTML-only：coerce htmlToText 后 nodemailer→mailparser 分类 internal', async () => {
    const { htmlToText } = await import('../src/lib/otp.ts');
    const coerceOutboundText = (text: string, html?: string) =>
      text.trim() || !html ? text : htmlToText(html);

    const html = '<p>Your code is <strong>482731</strong>.</p>';
    const text = coerceOutboundText('', html);
    expect(text).toBe(htmlToText(html));

    const date = stampDate(new Date('2026-08-09T17:00:00Z'));
    const headers = buildOutboundStampHeaders(
      { from: 'a@test.example', to: ['b@test.example'], subject: 'HTML OTP', text, html },
      date,
      KEY,
      DOMAIN,
    );

    const nodemailer = (await import('nodemailer')).default;
    const { simpleParser } = await import('mailparser');
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const info = await transport.sendMail({
      from: 'a@test.example',
      to: ['b@test.example'],
      subject: 'HTML OTP',
      text,
      html,
      date,
      headers,
    });
    const parsed = await simpleParser(info.message as Buffer);
    const stampRaw = parsed.headers.get('x-oa-mail-stamp');
    const parsedHtml = typeof parsed.html === 'string' ? parsed.html : undefined;
    const source = classifyMailSource(
      typeof stampRaw === 'string' ? stampRaw : undefined,
      {
        from: normalizeMailbox(parsed.from?.value?.[0]?.address ?? ''),
        to: normalizeToList(parsedToList(parsed)),
        subject: parsed.subject ?? '',
        dateIso: (parsed.date ?? new Date(0)).toISOString(),
        bodyHash: hashMailBody(parsed.text ?? '', parsedHtml),
      },
      KEY,
    );
    expect(source).toBe('internal');
  });

  test('多收件人：To 顺序经 nodemailer→mailparser 保持，classify=internal', async () => {
    const date = stampDate(new Date('2026-08-09T18:00:00Z'));
    // 故意非字母序，钉死发信顺序契约。
    const to = ['carol@test.example', 'bob@test.example', 'alice@test.example'];
    const headers = buildOutboundStampHeaders(
      {
        from: 'sender@test.example',
        to,
        subject: 'multi-to',
        text: 'hello multi',
      },
      date,
      KEY,
      DOMAIN,
    );
    expect(headers[MAIL_STAMP_HEADER]).toBeDefined();

    const nodemailer = (await import('nodemailer')).default;
    const { simpleParser } = await import('mailparser');
    const transport = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const info = await transport.sendMail({
      from: 'sender@test.example',
      to,
      subject: 'multi-to',
      text: 'hello multi',
      date,
      headers,
    });
    const parsed = await simpleParser(info.message as Buffer);
    const parsedTo = parsedToList(parsed).map((a) => a.toLowerCase());
    expect(parsedTo).toEqual(to);

    const stampRaw = parsed.headers.get('x-oa-mail-stamp');
    const source = classifyMailSource(
      typeof stampRaw === 'string' ? stampRaw : undefined,
      {
        from: normalizeMailbox(parsed.from?.value?.[0]?.address ?? ''),
        to: normalizeToList(parsedToList(parsed)),
        subject: parsed.subject ?? '',
        dateIso: (parsed.date ?? new Date(0)).toISOString(),
        bodyHash: hashMailBody(parsed.text ?? '', undefined),
      },
      KEY,
    );
    expect(source).toBe('internal');
  });
});
