/**
 * errorCode / errorDetail 单测。
 * - errorCode：非 Error rejection 归一化哨兵语义（路由映射用）
 * - errorDetail：日志/告警载荷诊断文本（永不空类型标记 / 永不抛）
 */
import { describe, expect, test } from 'bun:test';
import { boundDetail, errorCode, errorDetail, ERROR_DETAIL_MAX } from '../src/lib/errors.ts';

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
  // —— 既有断言（#338；不得削弱）——
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

  // —— #340 C2 新增 ——
  test('duck {message:\'x\'} ⇒ 输出含 x 且来源可辨为 object message', () => {
    expect(() => errorDetail({ message: 'smtp down' })).not.toThrow();
    const out = errorDetail({ message: 'smtp down' });
    expect(out).toContain('smtp down');
    // 形态须能看出取自 duck 对象的 message（非裸 smtp down、非纯 [non-error:object]）
    expect(out).toContain('non-error:object');
    expect(out).toBe('[non-error:object:smtp down]');
  });

  test('含 \\n/\\r/\\t/C0 的输入 ⇒ 转义形态且单行', () => {
    const raw = 'a\nb\rc\td\u0001e';
    const out = errorDetail(new Error(raw));
    expect(out).toBe('a\\nb\\rc\\td\\u0001e');
    // 输出不得含真实换行/回车/制表（单行）
    expect(out.includes('\n')).toBe(false);
    expect(out.includes('\r')).toBe(false);
    expect(out.includes('\t')).toBe(false);
    expect(out.includes('\u0001')).toBe(false);
  });

  test('含 emoji 的超长输入 ⇒ 按码点截断且无孤立代理对', () => {
    // 😀 = U+1F600，UTF-16 两码元；按码元 slice 会切裂
    const unit = '😀';
    const long = unit.repeat(250); // 250 码点 = 500 UTF-16 码元，须截到 200 码点
    const out = errorDetail(new Error(long));
    expect(Array.from(out).length).toBe(200);
    // 无替换字符、无奇数长度代理残留：每个码点应是完整 emoji
    expect(out.includes('\uFFFD')).toBe(false);
    expect(Array.from(out).every((ch) => ch === unit)).toBe(true);
  });

  // duck 会抛 getter 仍不抛，回退类型文本
  test('duck 会抛 message getter ⇒ [non-error:object] 且不抛', () => {
    const x = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => errorDetail(x)).not.toThrow();
    expect(errorDetail(x)).toBe('[non-error:object]');
  });

  // —— #340 R5 P1-2 / P1-3 ——
  test('含 U+2028/U+2029/U+0085 ⇒ 转义且无行分隔字符', () => {
    const raw = `a\u2028b\u2029c\u0085d`;
    const out = errorDetail(new Error(raw));
    expect(out).toBe('a\\u2028b\\u2029c\\u0085d');
    expect(/\p{Zl}|\p{Zp}|\u0085/u.test(out)).toBe(false);
    expect(out.includes('\u2028')).toBe(false);
    expect(out.includes('\u2029')).toBe(false);
    expect(out.includes('\u0085')).toBe(false);
  });

  test('多兆字节 message ⇒ 有界、不抛、耗时合理', () => {
    // 约 4 MiB ASCII；单趟须在读满 N 码点后停，不得物化全串转义副本
    const mega = 'a'.repeat(4 * 1024 * 1024);
    const t0 = performance.now();
    expect(() => errorDetail(new Error(mega))).not.toThrow();
    const out = errorDetail(new Error(mega));
    const ms = performance.now() - t0;
    expect(Array.from(out).length).toBe(ERROR_DETAIL_MAX);
    expect(out).toBe('a'.repeat(ERROR_DETAIL_MAX));
    // 有界路径应远快于整串扫描；给宽松上限防 CI 抖动，并落原始耗时到 stdout 留证
    console.log(`[errorDetail mega] bytes=${mega.length} ms=${ms.toFixed(3)}`);
    expect(ms).toBeLessThan(500);
  });

  test('boundDetail 对超长输入单趟有界', () => {
    const mega = 'x'.repeat(2 * 1024 * 1024);
    expect(() => boundDetail(mega)).not.toThrow();
    expect(Array.from(boundDetail(mega)).length).toBe(ERROR_DETAIL_MAX);
  });
});
