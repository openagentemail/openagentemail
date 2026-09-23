/**
 * errorCode / describeFailure（原 errorDetail 契约迁入 redact.ts）单测。
 * - errorCode：非 Error rejection 归一化哨兵语义（路由映射用）——一字不动
 * - describeFailure：日志/告警载荷（类型化标记 / 有界 / 脱敏 / 单行 / 永不抛）
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-errors-'));

const { errorCode } = await import('../src/lib/errors.ts');
const { describeFailure } = await import('../src/lib/redact.ts');

describe('errorCode', () => {
  test('Error(\'x\') ⇒ \'x\'', () => {
    expect(errorCode(new Error('x'))).toBe('x');
  });

  test('new Error(\'\') ⇒ \'\'', () => {
    expect(errorCode(new Error(''))).toBe('');
  });

  test('带字符串 message 的 duck 对象 ⇒ 取其 message', () => {
    expect(errorCode({ message: 'duck' })).toBe('duck');
    expect(errorCode({ message: 1 })).toBe('');
  });

  // 非 Error / 无字符串 message → 哨兵 ''；且不得抛任何异常
  test('非 Error rejection 一律返回哨兵 \'\'，永不抛', () => {
    const cases: unknown[] = [
      undefined,
      null,
      'str',
      { message: 1 },
      42,
      { code: 'x' },
    ];
    for (const value of cases) {
      expect(() => errorCode(value)).not.toThrow();
      expect(errorCode(value)).toBe('');
    }
  });

  // Codex P1 / R1：?. 不挡会抛的 getter；取值失败必须哨兵且不逸出
  test('会抛的 message getter ⇒ \'\' 且不抛', () => {
    const x = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => errorCode(x)).not.toThrow();
    expect(errorCode(x)).toBe('');
  });

  test('revoked Proxy ⇒ \'\' 且不抛', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => errorCode(proxy)).not.toThrow();
    expect(errorCode(proxy)).toBe('');
  });
});

describe('describeFailure（承接原 errorDetail 契约）', () => {
  // 传 [] 避免配置密码误伤断言
  test('Error(\'x\') ⇒ \'x\'', () => {
    expect(describeFailure(new Error('x'), [])).toBe('x');
  });

  test('undefined / null / 42 / {} / \'str\' ⇒ 各自类型化文本且非空', () => {
    const cases: Array<{ input: unknown; includes: string }> = [
      { input: undefined, includes: 'non-error:undefined' },
      { input: null, includes: 'non-error:null' },
      { input: 42, includes: 'non-error:number' },
      { input: {}, includes: 'non-error:object' },
      { input: 'str', includes: 'non-error:string' },
    ];
    for (const { input, includes } of cases) {
      expect(() => describeFailure(input, [])).not.toThrow();
      const out = describeFailure(input, []);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(includes);
    }
  });

  test('会抛的 message getter（Error 实例）⇒ [unreadable] 且不抛', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => describeFailure(err, [])).not.toThrow();
    expect(describeFailure(err, [])).toBe('[unreadable]');
  });

  test('revoked Proxy ⇒ [unreadable] 且不抛', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => describeFailure(proxy, [])).not.toThrow();
    expect(describeFailure(proxy, [])).toBe('[unreadable]');
  });

  test('超长 Error.message 截断到 200', () => {
    const long = 'a'.repeat(500);
    const out = describeFailure(new Error(long), []);
    expect(out.length).toBe(200);
    expect(out).toBe('a'.repeat(200));
  });

  test('超长非 Error 字符串截断到 200', () => {
    const long = 'b'.repeat(500);
    const out = describeFailure(long, []);
    expect(out.length).toBe(200);
    expect(out.startsWith('[non-error:string:')).toBe(true);
  });
});
