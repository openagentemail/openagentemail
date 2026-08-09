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
});
