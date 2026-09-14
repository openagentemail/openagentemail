/**
 * wait 截止与剩余时间的单一单调钟（与客户端 performance.now() 同族）。
 * 墙钟跳变不得改 wait 决策；Date.now 只留给外部契约绝对时间戳。
 */

/** 单调截止/时刻品牌：裸 number（含 Date.now()）不得当 deadline 传入。 */
export type WaitMonotonicMs = number & { readonly __brand: 'WaitMonotonicMs' };

/** 运行时无操作；仅把 number 收窄为品牌类型。 */
function asWaitMonotonicMs(n: number): WaitMonotonicMs {
  return n as WaitMonotonicMs;
}

/** 回退墙钟时只警告一次，避免刷屏；不得 throw（#214）。 */
let warnedPerformanceFallback = false;

/** 生产读 performance.now；缺省回退 Date.now 并 warn-once。 */
function defaultWaitMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  if (!warnedPerformanceFallback) {
    warnedPerformanceFallback = true;
    console.warn(
      '[wait-clock] performance.now unavailable; wait deadlines fall back to Date.now() (monotonicity invariant lost)',
    );
  }
  return Date.now();
}

/** 当前 wait 单调时刻（毫秒，品牌类型）。 */
export function waitMonotonicNow(): WaitMonotonicMs {
  return asWaitMonotonicMs(defaultWaitMonotonicNow());
}

/**
 * 自当前单调时刻起 timeoutMs 后的截止（品牌类型）。
 * deadline 构造必须在钟模块内完成，避免调用方用墙钟数字拼截止。
 */
export function waitMonotonicDeadlineAfter(timeoutMs: number): WaitMonotonicMs {
  return asWaitMonotonicMs(defaultWaitMonotonicNow() + timeoutMs);
}
