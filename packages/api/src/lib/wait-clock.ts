/**
 * wait 截止与剩余时间的单一单调钟（与客户端 performance.now() 同族）。
 * 墙钟跳变不得改 wait 决策；Date.now 只留给外部契约绝对时间戳。
 */

/** 生产读 performance.now；缺省回退 Date.now。测试可注入。 */
function defaultWaitMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

let waitMonotonicNowFn: () => number = defaultWaitMonotonicNow;

/** 测试注入 wait 单调钟；restore 时不传。API 与 MCP 客户端共用此缝，禁止再开平行钟。 */
export function setWaitMonotonicNowForTests(fn?: () => number): void {
  waitMonotonicNowFn = fn ?? defaultWaitMonotonicNow;
}

/** 当前 wait 单调时刻（毫秒）。 */
export function waitMonotonicNow(): number {
  return waitMonotonicNowFn();
}
