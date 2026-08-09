// mail-stamp：HMAC 自签 / 校验 / fail-closed 规约单测。
import { describe, expect, test } from 'bun:test';
import {
  MAIL_STAMP_PREFIX,
  classifyMailSource,
  createMailStamp,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  stampDate,
  verifyMailStamp,
} from '../src/lib/mail-stamp.ts';

const KEY = 'test-mail-stamp-secret';

const base = {
  from: 'alice@test.example',
  to: 'bob@test.example,carol@test.example',
  subject: 'Hello',
  dateIso: '2026-08-09T12:00:00.000Z',
  bodyHash: hashMailBody('hello body', '<p>hello</p>'),
};

describe('mail-stamp 字段规约', () => {
  test('normalizeMailbox：显示名与大小写', () => {
    expect(normalizeMailbox('Alice <Alice@Test.Example>')).toBe('alice@test.example');
    expect(normalizeMailbox('BOB@TEST.EXAMPLE')).toBe('bob@test.example');
    expect(normalizeMailbox('not-an-address')).toBe('');
  });

  test('normalizeToList：逐地址小写逗号拼接无空格', () => {
    expect(normalizeToList(['Bob@Test.Example', 'Carol <Carol@Test.Example>'])).toBe(
      'bob@test.example,carol@test.example',
    );
  });

  test('stampDate 毫秒归零', () => {
    const d = stampDate(new Date('2026-08-09T12:00:00.123Z'));
    expect(d.toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  test('hashMailBody：CRLF→LF、trimEnd（text/html 对称），缺 html 当空串', () => {
    expect(hashMailBody('hi\n')).toBe(hashMailBody('hi'));
    expect(hashMailBody('a\r\nb')).toBe(hashMailBody('a\nb'));
    // html 同样 trimEnd：mailparser 常在 html 末尾加 \\n。
    expect(hashMailBody('hi', '<p>x</p>\n')).toBe(hashMailBody('hi', '<p>x</p>'));
    expect(hashMailBody('hi')).not.toBe(hashMailBody('hi', '<p>x</p>'));
  });
});

describe('mail-stamp create / verify', () => {
  test('同字段可验证通过 → internal', () => {
    const stamp = createMailStamp(base, KEY);
    expect(stamp.length).toBeGreaterThan(10);
    expect(verifyMailStamp(stamp, base, KEY)).toBe(true);
    expect(classifyMailSource(stamp, base, KEY)).toBe('internal');
  });

  test('改任一字段 HMAC 即碎', () => {
    const stamp = createMailStamp(base, KEY);
    expect(verifyMailStamp(stamp, { ...base, from: 'eve@test.example' }, KEY)).toBe(false);
    expect(verifyMailStamp(stamp, { ...base, to: 'bob@test.example' }, KEY)).toBe(false);
    expect(verifyMailStamp(stamp, { ...base, subject: 'Hell0' }, KEY)).toBe(false);
    expect(verifyMailStamp(stamp, { ...base, dateIso: '2026-08-09T12:00:01.000Z' }, KEY)).toBe(
      false,
    );
    expect(
      verifyMailStamp(stamp, { ...base, bodyHash: hashMailBody('tampered') }, KEY),
    ).toBe(false);
    expect(classifyMailSource(stamp, { ...base, subject: 'x' }, KEY)).toBe('external');
  });

  test('缺头 / 空 stamp / 字段缺失 → fail-closed external', () => {
    expect(classifyMailSource(undefined, base, KEY)).toBe('external');
    expect(classifyMailSource('', base, KEY)).toBe('external');
    expect(classifyMailSource('not-a-valid-stamp', base, KEY)).toBe('external');
    expect(classifyMailSource(createMailStamp(base, KEY), { ...base, from: '' }, KEY)).toBe(
      'external',
    );
    expect(classifyMailSource(createMailStamp(base, KEY), { ...base, to: '' }, KEY)).toBe(
      'external',
    );
    expect(classifyMailSource(createMailStamp(base, KEY), { ...base, bodyHash: '' }, KEY)).toBe(
      'external',
    );
  });

  test('载荷含域分离前缀', () => {
    const stamp = createMailStamp(base, KEY);
    expect(verifyMailStamp(stamp, base, KEY + '-other')).toBe(false);
    expect(MAIL_STAMP_PREFIX).toBe('mail-stamp-v1');
  });
});
