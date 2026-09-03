// mail-stamp：HMAC 自签 / 校验 / fail-closed 规约单测。
import { describe, expect, test } from 'bun:test';
import {
  MAIL_BODY_HASH_PREFIX,
  MAIL_STAMP_HEADER,
  MAIL_STAMP_PREFIX,
  allRecipientsInDomains,
  allRecipientsOnDomain,
  buildOutboundStampHeaders,
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

  test('hashMailBody v2：长度前缀消除边界歧义；trimEnd 对称', () => {
    expect(MAIL_BODY_HASH_PREFIX).toBe('mail-body-v2');
    expect(hashMailBody('hi\n')).toBe(hashMailBody('hi'));
    expect(hashMailBody('a\r\nb')).toBe(hashMailBody('a\nb'));
    expect(hashMailBody('hi', '<p>x</p>\n')).toBe(hashMailBody('hi', '<p>x</p>'));
    // 裸 \\n 拼接时这两对会撞；长度前缀后必须不同。
    expect(hashMailBody('safe\n<b>x</b>', 'tail')).not.toBe(
      hashMailBody('safe', '<b>x</b>\ntail'),
    );
  });

  test('allRecipientsOnDomain：全本域 / 混合 / 空', () => {
    expect(allRecipientsOnDomain(['a@test.example', 'b@test.example'], 'test.example')).toBe(
      true,
    );
    expect(allRecipientsOnDomain(['a@test.example', 'b@evil.com'], 'test.example')).toBe(false);
    expect(allRecipientsOnDomain([], 'test.example')).toBe(false);
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

  test('allRecipientsInDomains：跨配置域 / 混合外部 / 空', () => {
    const domains = new Set(['dom1.example', 'dom2.example']);
    expect(
      allRecipientsInDomains(['a@DOM1.example', 'b@dom2.EXAMPLE'], domains),
    ).toBe(true);
    expect(
      allRecipientsInDomains(['a@dom1.example', 'c@external.example'], domains),
    ).toBe(false);
    expect(allRecipientsInDomains([], domains)).toBe(false);
    expect(allRecipientsInDomains(['invalid-email'], domains)).toBe(false);
  });

  test('buildOutboundStampHeaders：跨配置域收件人盖 stamp，含外部收件人不盖', () => {
    const domains = new Set(['dom1.example', 'dom2.example']);
    const date = new Date('2026-08-09T12:00:00.000Z');
    const headersCross = buildOutboundStampHeaders(
      {
        from: 'alice@dom1.example',
        to: ['bob@dom2.example'],
        subject: 'Multi-domain test',
        text: 'hello',
      },
      date,
      KEY,
      domains,
    );
    expect(headersCross[MAIL_STAMP_HEADER]).toBeDefined();

    const headersExternal = buildOutboundStampHeaders(
      {
        from: 'alice@dom1.example',
        to: ['bob@dom2.example', 'eve@external.example'],
        subject: 'External leak test',
        text: 'hello',
      },
      date,
      KEY,
      domains,
    );
    expect(headersExternal[MAIL_STAMP_HEADER]).toBeUndefined();
  });
});
