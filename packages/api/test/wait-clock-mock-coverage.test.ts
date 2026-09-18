/**
 * #225：wait-clock mock 导出面断言（动态比对，禁硬编码清单）。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  assertWaitClockMockCoversReal,
  createWaitClockMockExports,
} from './support/wait-clock-mock.ts';

const REAL_WAIT_CLOCK = join(import.meta.dir, '../src/lib/wait-clock.ts');

describe('#225 wait-clock mock export coverage', () => {
  test('完整 mock 导出面覆盖真实模块', () => {
    const mockExports = createWaitClockMockExports(() => undefined);
    expect(() => assertWaitClockMockCoversReal(mockExports, REAL_WAIT_CLOCK)).not.toThrow();
  });

  test('缺导出时报 does not cover', () => {
    // 故意只留一个导出，模拟生产新增导出后 mock 漂移
    const incomplete = {
      waitMonotonicNow: () => 0,
    };
    expect(() => assertWaitClockMockCoversReal(incomplete, REAL_WAIT_CLOCK)).toThrow(
      /does not cover/,
    );
  });
});
