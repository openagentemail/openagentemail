/**
 * errorCode / errorDetail 单测。
 * - errorCode：非 Error rejection 归一化哨兵语义（路由映射用）
 * - errorDetail：日志/告警载荷诊断文本（永不空类型标记 / 永不抛）
 */
import { describe, expect, test } from 'bun:test';
import { errorCode, errorDetail } from '../src/lib/errors.ts';

describe('errorCode', () => {
  test('Error(\'x\') ⇒ \'x\'', () => {
    expect(errorCode(new Error('x'))).toBe('x');
  });

  test('new Error(\'\') ⇒ \'\'', () => {
    expect(errorCode(new Error(''))).toBe('');
  });

  test('带字符串 message 的 duck 对象 ⇒ 取其 message', () => {
    expect(errorCode({ message: 'duck' })).toBe('duck');
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

describe('errorDetail', () => {
  test('Error(\'x\') ⇒ \'x\'', () => {
    expect(errorDetail(new Error('x'))).toBe('x');
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
      expect(() => errorDetail(input)).not.toThrow();
      const out = errorDetail(input);
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(includes);
    }
  });

  test('会抛的 message getter（Error 实例）⇒ [unreadable] 且不抛', () => {
    const err = new Error('x');
    // 覆盖实例 message 为会抛 getter（构造器写入的 data 属性会挡住原型 getter）
    Object.defineProperty(err, 'message', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => errorDetail(err)).not.toThrow();
    expect(errorDetail(err)).toBe('[unreadable]');
  });

  test('revoked Proxy ⇒ [unreadable] 且不抛', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => errorDetail(proxy)).not.toThrow();
    expect(errorDetail(proxy)).toBe('[unreadable]');
  });

  test('超长 Error.message 截断到 200', () => {
    const long = 'a'.repeat(500);
    const out = errorDetail(new Error(long));
    expect(out.length).toBe(200);
    expect(out).toBe('a'.repeat(200));
  });

  test('超长非 Error 字符串截断到 200', () => {
    const long = 'b'.repeat(500);
    const out = errorDetail(long);
    expect(out.length).toBe(200);
    expect(out.startsWith('[non-error:string:')).toBe(true);
  });
});
