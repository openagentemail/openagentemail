/**
 * errorCode 单测：非 Error rejection 归一化哨兵语义。
 * 哨兵值 = ''（与 tasks.journalUnavailable 历史守卫同口径）。
 */
import { describe, expect, test } from 'bun:test';
import { errorCode } from '../src/lib/errors.ts';

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
});
