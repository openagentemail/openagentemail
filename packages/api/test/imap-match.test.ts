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

const { describe, expect, test } = await import('bun:test');
const { messageMatchesAddress } = await import('../src/lib/imap.ts');

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
