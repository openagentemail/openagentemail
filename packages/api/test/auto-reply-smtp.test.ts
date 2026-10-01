// #363-A：经 sendMail 的序列化 MIME。假 stream transport，不连真实 SMTP。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { describe, expect, mock, test } from 'bun:test';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.TASK_SIGNING_SECRET = 'auto-reply-stamp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-autoreply-'));

let lastMime = '';
const realCreate = nodemailer.createTransport.bind(nodemailer);
mock.module('nodemailer', () => ({
  default: {
    createTransport() {
      const transport = realCreate({ streamTransport: true, buffer: true, newline: 'unix' });
      const send = transport.sendMail.bind(transport);
      transport.sendMail = (async (opts: object) => {
        const info = await send(opts);
        const message = (info as { message?: Uint8Array }).message;
        lastMime = Buffer.from(message ?? []).toString('utf8');
        return info;
      }) as typeof transport.sendMail;
      return transport;
    },
  },
}));

// 全套件里其他文件会先 mock.module(smtp)。查询串绕过该 mock，仍用上方流式替身序列化真实 sendMail。
const { sendMail } = await import('../src/lib/smtp.ts?363a-real-send' as unknown as '../src/lib/smtp.ts');

function headerLines(mime: string, name: string): string[] {
  const needle = `${name.toLowerCase()}:`;
  return mime
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(needle));
}

describe('sendMail Auto-Submitted 序列化（#363-A）', () => {
  test('true 恰好一条 auto-replied；false、省略与外部收件人按契约带或不带 stamp', async () => {
    const cases: Array<{
      to: string[];
      autoReply?: boolean;
      expectHeader: boolean;
      expectStamp: boolean;
      headers?: Record<string, string>;
    }> = [
      { to: ['b@test.example'], expectHeader: false, expectStamp: true },
      { to: ['b@test.example'], autoReply: false, expectHeader: false, expectStamp: true },
      { to: ['b@test.example'], autoReply: true, expectHeader: true, expectStamp: true },
      {
        to: ['b@test.example'],
        autoReply: true,
        expectHeader: true,
        expectStamp: true,
        headers: { 'Auto-Submitted': 'no', 'X-OA-Task': 'keep-me' },
      },
      { to: ['outside@example.net'], autoReply: true, expectHeader: true, expectStamp: false },
    ];
    for (const item of cases) {
      lastMime = '';
      await sendMail({
        from: 'a@test.example',
        to: item.to,
        subject: 'reply',
        text: 'thanks',
        ...(item.autoReply === undefined ? {} : { autoReply: item.autoReply }),
        ...(item.headers ? { headers: item.headers } : {}),
      });
      const parsed = await simpleParser(Buffer.from(lastMime));
      const lines = headerLines(lastMime, 'auto-submitted');
      const stampLines = headerLines(lastMime, 'x-oa-mail-stamp');
      if (item.expectHeader) {
        expect(lines).toEqual(['Auto-Submitted: auto-replied']);
        expect(parsed.headers.get('auto-submitted')).toBe('auto-replied');
        expect(Array.isArray(parsed.headers.get('auto-submitted'))).toBe(false);
      } else {
        expect(lines).toEqual([]);
        expect(parsed.headers.get('auto-submitted')).toBeUndefined();
      }
      if (item.expectStamp) {
        expect(typeof parsed.headers.get('x-oa-mail-stamp')).toBe('string');
        expect(stampLines.length).toBe(1);
      } else {
        expect(parsed.headers.get('x-oa-mail-stamp')).toBeUndefined();
        expect(stampLines).toEqual([]);
      }
      if (item.headers?.['X-OA-Task']) {
        expect(parsed.headers.get('x-oa-task')).toBe('keep-me');
      }
    }
  });
});
