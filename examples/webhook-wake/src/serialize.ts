/** Per-seat wake serialization. Distinct seats do not share a lock. */

/** 排队段弃队错误码；已开跑的 send 不会抛此码。 */
export const SEAT_QUEUE_ABORTED = 'seat_queue_aborted';

function seatQueueAbortedError(): Error & { code: string } {
  return Object.assign(new Error(SEAT_QUEUE_ABORTED), { code: SEAT_QUEUE_ABORTED });
}

/**
 * 等 prev 完成或 signal abort（先到先得）。
 * 返回后由调用方检查 signal.aborted；已开跑路径不经过此处 race。
 */
function waitPrevOrAbort(prevDone: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    prevDone.then(onDone, onDone);
  });
}

export class SeatSerializer {
  private locks = new Map<string, Promise<void>>();

  /**
   * 同 seat 串行执行 work。
   * 可选 signal：仅在**排队等待** prev 期间 race abort；命中即弃队（work 不执行）。
   * 一旦 work 已开跑，不再因 signal 打断（sendTimeoutMs 自治）。
   */
  run<T>(seat: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prev = this.locks.get(seat) ?? Promise.resolve();
    const prevDone = prev.catch(() => undefined);

    // 槽位释放：弃队或 work 结束后放行下一位；锁链始终经由 prevDone，不跳过在跑 send
    let releaseSlot!: () => void;
    const slotHeld = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    this.locks.set(
      seat,
      prevDone.then(() => slotHeld),
    );

    const execute = async (): Promise<T> => {
      try {
        if (signal) {
          await waitPrevOrAbort(prevDone, signal);
          // 排队段 abort：弃队，work 不执行（dedup 键未动）
          if (signal.aborted) {
            throw seatQueueAbortedError();
          }
        } else {
          await prevDone;
        }
        // 自此 work 已开跑：signal 再 abort 也不打断
        return await work();
      } finally {
        releaseSlot();
      }
    };

    return execute();
  }
}
