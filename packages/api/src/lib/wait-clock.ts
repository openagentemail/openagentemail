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

/** 回退墙钟时只警告一次，避免刷屏。 */
let warnedPerformanceFallback = false;

/** 钟族：performance 或 Date；首次调用钉死，之后 flip 即 throw（#226②）。 */
type WaitClockFamily = 'performance' | 'Date';

/** 首次成功读钟时钉死的族名；undefined 表示尚未钉死。 */
let pinnedClockFamily: WaitClockFamily | undefined;

/** 探测当前运行时可提供的钟族。 */
function detectWaitClockFamily(): WaitClockFamily {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return 'performance';
  }
  return 'Date';
}

/**
 * 生产读 performance.now；缺省回退 Date.now 并 warn-once。
 * #226②：首次调用钉死 family；运行期 flip 即 throw（响亮失败优于静默全超时）。
 */
function defaultWaitMonotonicNow(): number {
  const family = detectWaitClockFamily();
  if (pinnedClockFamily === undefined) {
    pinnedClockFamily = family;
    if (family === 'Date' && !warnedPerformanceFallback) {
      warnedPerformanceFallback = true;
      console.warn(
        '[wait-clock] performance.now unavailable; wait deadlines fall back to Date.now() (monotonicity invariant lost)',
      );
    }
  } else if (pinnedClockFamily !== family) {
    throw new Error(
      `[wait-clock] clock family flipped from ${pinnedClockFamily} to ${family}; refusing silent switch`,
    );
  }

  if (pinnedClockFamily === 'performance') {
    return performance.now();
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
