/**
 * #214：performance.now 缺失时 warn-once 回退墙钟；不得 throw。
 */
import { afterEach, describe, expect, test } from 'bun:test';

const realPerformance = globalThis.performance;

afterEach(() => {
  // 恢复 performance，避免污染同进程其它用例。
  Object.defineProperty(globalThis, 'performance', {
    value: realPerformance,
    configurable: true,
    writable: true,
  });
});

describe('#214 wait-clock performance.now fallback warn-once', () => {
  test('缺 performance.now：首次 warn，回退 Date.now，后续静默', async () => {
    // 无 now 的假 performance，逼走墙钟回退。
    Object.defineProperty(globalThis, 'performance', {
      value: {},
      configurable: true,
      writable: true,
    });

    const warns: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };

    try {
      // 缓存破坏：同进程多次跑时拿到会走 defaultWaitMonotonicNow 的新模块实例。
      const mod = await import(`../src/lib/wait-clock.ts?warn_once=${Date.now()}`);
      const wall = Date.now();
      const a = mod.waitMonotonicNow();
      const b = mod.waitMonotonicNow();
      expect(typeof a).toBe('number');
      expect(typeof b).toBe('number');
      // 回退墙钟：应贴近 Date.now（允许少量调度漂移）。
      expect(Math.abs(Number(a) - wall)).toBeLessThan(50);
      expect(warns.length).toBe(1);
      expect(String(warns[0]?.[0])).toMatch(/performance\.now unavailable/);
      expect(String(warns[0]?.[0])).toMatch(/Date\.now/);
    } finally {
      console.warn = realWarn;
    }
  });
});
