/**
 * dedup.share 同 key 多 waiter 的 AbortSignal 聚合。
 *
 * 不变量：共享 seats.run 只在「该 key 的所有等待者都已超时/放弃」时
 * 才收到 aggregate abort；任一 waiter 仍存活则排队段不弃队（避免首请求
 * deadline 连坐后来者）。
 */

export type ShareWaiterHandle = {
  /** 交给 seats.run 的聚合 signal（非任一单个 hookSignal） */
  signal: AbortSignal;
  /** 请求结束（settled）时调用；abort 路径也会自动 leave */
  leave: () => void;
};

type KeyEntry = {
  waiters: Set<AbortSignal>;
  ac: AbortController;
  listeners: Map<AbortSignal, () => void>;
};

export class ShareWaiterAggregate {
  private keys = new Map<string, KeyEntry>();

  /**
   * 将本请求的 hookSignal 注册进 key 的 waiter 集合，返回聚合 signal。
   * 若 hookSignal 已 abort 且集合因此为空，聚合 signal 立即 abort。
   */
  join(key: string, hookSignal: AbortSignal): ShareWaiterHandle {
    let entry = this.keys.get(key);
    // 上一轮已 abort 的聚合不可复用；开新控制器
    if (!entry || entry.ac.signal.aborted) {
      entry = {
        waiters: new Set(),
        ac: new AbortController(),
        listeners: new Map(),
      };
      this.keys.set(key, entry);
    }

    const leave = () => {
      this.leave(key, hookSignal);
    };

    if (hookSignal.aborted) {
      // 已放弃的请求不占 waiter；若无人存活则立即弃队
      if (entry.waiters.size === 0 && !entry.ac.signal.aborted) {
        entry.ac.abort();
        this.keys.delete(key);
      }
      return { signal: entry.ac.signal, leave };
    }

    entry.waiters.add(hookSignal);
    const onAbort = () => {
      leave();
    };
    hookSignal.addEventListener('abort', onAbort, { once: true });
    entry.listeners.set(hookSignal, onAbort);

    return { signal: entry.ac.signal, leave };
  }

  private leave(key: string, hookSignal: AbortSignal): void {
    const entry = this.keys.get(key);
    if (!entry) return;

    const onAbort = entry.listeners.get(hookSignal);
    if (onAbort) {
      hookSignal.removeEventListener('abort', onAbort);
      entry.listeners.delete(hookSignal);
    }
    if (!entry.waiters.delete(hookSignal)) {
      // 重复 leave（abort 监听 + finally）幂等
      return;
    }

    if (entry.waiters.size === 0) {
      // 全部 waiter 已放弃 → 聚合 abort → 排队段 seats.run 弃队
      if (!entry.ac.signal.aborted) {
        entry.ac.abort();
      }
      this.keys.delete(key);
    }
  }
}
