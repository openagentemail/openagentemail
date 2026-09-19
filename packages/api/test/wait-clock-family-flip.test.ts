/**
 * #226②：钟族首次钉死；运行期 flip 必 throw 且消息含 family 名。
 */
import { afterEach, describe, expect, test } from 'bun:test';

const realPerformance = globalThis.performance;

afterEach(() => {
  Object.defineProperty(globalThis, 'performance', {
    value: realPerformance,
    configurable: true,
    writable: true,
  });
});

describe('#226② wait-clock family pin fail-fast', () => {
  test('performance→Date flip：throw 且消息含两族名', async () => {
    // 缓存破坏：拿到独立 pinnedClockFamily 的模块实例
    const mod = await import(`../src/lib/wait-clock.ts?family_flip=${Date.now()}`);
    // 首次调用钉死 performance
    expect(typeof mod.waitMonotonicNow()).toBe('number');

    Object.defineProperty(globalThis, 'performance', {
      value: {},
      configurable: true,
      writable: true,
    });

    let err: unknown;
    try {
      mod.waitMonotonicNow();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = String((err as Error).message);
    expect(msg).toMatch(/family/i);
    expect(msg).toMatch(/performance/);
    expect(msg).toMatch(/Date/);
  });
});
