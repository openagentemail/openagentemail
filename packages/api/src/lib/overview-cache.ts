/**
 * Overview 快照的进程内缓存状态机。
 *
 * 一条链路上只允许一个时钟来源：注入的 `clock()`。`scannedAt`（快照盖章）、
 * `lastError.at`、`nextRetryAt`、以及 await 之后的"当前时刻"重读全部走它，
 * 并把用到的读数经 `outcome.now` 回传给路由 —— 这样 TTL / 冷却 / 错误时间戳
 * 的测试不会跨两个时钟域比较。本文件里 `Date.now()` 只允许出现在 `clock`
 * 的默认值处。
 *
 * 其余三条硬约束：
 *  - 单飞：任意时刻至多一个在途扫描，因此至多一个 IMAP 会话；
 *  - 真取消：扫描截止时间覆盖 connect/SEARCH/FETCH 全阶段（见 imap.ts 的
 *    `withInboxAbortable`），迟到结果不写回；
 *  - 失败冷却：一次失败后 `FAILURE_COOLDOWN_MS` 内不再发起扫描，连
 *    `?refresh=1` 也不例外，客户端由 `retryAfterMs` 得知何时可再来。
 */

import type { MailboxScanResult } from './imap.ts';

export const FRESH_MS = 15_000;
export const STALE_MAX_MS = 600_000;
export const REFRESH_FLOOR_MS = 5_000;
export const FAILURE_COOLDOWN_MS = 5_000;
export const SCAN_DEADLINE_MS = 9_000;
export const RESPONSE_WAIT_MS = 750;

/** 缓存层安装的快照：扫描结果 + 由缓存层盖章的时刻。 */
export interface MailboxSnapshot extends MailboxScanResult {
  scannedAt: number;
}

export type ScanFailureCode = 'imap_unavailable' | 'scan_timeout';

/**
 * 缓存层的判定结果。`now` / `snapshot` / `floored` 都是内部字段，
 * 路由只用它们算响应，不直接放进 HTTP 载荷。
 */
export type ScanOutcome =
  | {
      kind: 'ready' | 'stale';
      now: number;
      /** null 表示"跳过了扫描"（0 身份短路），窗口派生量未被观测 */
      snapshot: MailboxSnapshot | null;
      cached: boolean;
      revalidating: boolean;
      refreshError: boolean;
      retryAfterMs?: number;
      floored?: boolean;
    }
  | { kind: 'loading'; now: number; retryAfterMs: number }
  | {
      kind: 'unavailable';
      now: number;
      reason: ScanFailureCode;
      retryAfterSeconds: number;
    };

export interface OverviewCacheDependencies {
  scan: (opts: {
    signal: AbortSignal;
    identityAddresses: string[];
  }) => Promise<MailboxScanResult>;
  /** 唯一时钟 seam。默认取真实时钟，测试注入假时钟。 */
  clock?: () => number;
  freshMs?: number;
  staleMaxMs?: number;
  refreshFloorMs?: number;
  failureCooldownMs?: number;
  scanDeadlineMs?: number;
  responseBudgetMs?: number;
}

export interface OverviewCache {
  /** 公开签名**无** now 尾参：一切时刻读数只走注入的 clock()。 */
  getOverview(opts: {
    refresh: boolean;
    identityAddresses: string[];
  }): Promise<ScanOutcome>;
}

interface Flight {
  generation: number;
  startedAt: number;
  deadlineExceeded: boolean;
  promise: Promise<void>;
}

/** 等共享 Promise 落地，或等到响应预算用完 —— 两种情况都不 reject。 */
function raceSettled(
  promise: Promise<void>,
  budgetMs: number,
): Promise<'settled' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), budgetMs);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
    );
  });
}

export function createOverviewCache(deps: OverviewCacheDependencies): OverviewCache {
  const clock = deps.clock ?? (() => Date.now());
  const freshMs = deps.freshMs ?? FRESH_MS;
  const staleMaxMs = deps.staleMaxMs ?? STALE_MAX_MS;
  const refreshFloorMs = deps.refreshFloorMs ?? REFRESH_FLOOR_MS;
  const failureCooldownMs = deps.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
  const scanDeadlineMs = deps.scanDeadlineMs ?? SCAN_DEADLINE_MS;
  const responseBudgetMs = deps.responseBudgetMs ?? RESPONSE_WAIT_MS;

  const state: {
    snapshot: MailboxSnapshot | null;
    inFlight: Flight | null;
    generation: number;
    lastError: { code: ScanFailureCode; at: number; message: string } | null;
    nextRetryAt: number;
  } = {
    snapshot: null,
    inFlight: null,
    generation: 0,
    lastError: null,
    nextRetryAt: 0,
  };

  /** 503 的 Retry-After 唯一算法：冷却中给剩余冷却，否则给 5 s。 */
  function retryAfterSeconds(t: number): number {
    const cool = Math.max(0, state.nextRetryAt - t);
    return cool > 0 ? Math.ceil(cool / 1000) : 5;
  }

  function settled(
    kind: 'ready' | 'stale',
    snapshot: MailboxSnapshot | null,
    extra: {
      now: number;
      cached: boolean;
      revalidating: boolean;
      retryAfterMs?: number;
      floored?: boolean;
    },
  ): ScanOutcome {
    return {
      kind,
      now: extra.now,
      snapshot,
      cached: extra.cached,
      revalidating: extra.revalidating,
      refreshError: Boolean(state.lastError),
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.floored ? { floored: true } : {}),
    };
  }

  /** 0 身份：不建 flight、不开 IMAP，时间源仍是同一个 clock()。 */
  function zeroIdentityOutcome(now: number): ScanOutcome {
    return {
      kind: 'ready',
      now,
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    };
  }

  function ensureFlight(identityAddresses: string[], now: number): Flight | null {
    // 单飞唯一入口
    if (state.inFlight) return state.inFlight;
    // 失败冷却期，连 ?refresh=1 也不例外
    if (now < state.nextRetryAt) return null;

    const generation = ++state.generation;
    const controller = new AbortController();
    const flight: Flight = {
      generation,
      startedAt: now,
      deadlineExceeded: false,
      promise: Promise.resolve(),
    };

    const timer = setTimeout(() => {
      flight.deadlineExceeded = true;
      const at = clock();
      // 超时态在截止路径当场落账：底层 promise 稍后才 settle 时，期间到达的
      // 请求也能立刻看到 scan_timeout 与冷却，而不是"看起来还在正常刷新"。
      state.lastError = {
        code: 'scan_timeout',
        at,
        message: 'scan deadline exceeded',
      };
      state.nextRetryAt = at + failureCooldownMs;
      controller.abort();
    }, scanDeadlineMs);

    flight.promise = deps
      .scan({ signal: controller.signal, identityAddresses })
      .then((result) => {
        // 迟到结果不写回
        if (flight.deadlineExceeded) return;
        if (flight.generation !== state.generation) return;
        state.snapshot = { ...result, scannedAt: clock() };
        state.lastError = null;
        state.nextRetryAt = 0;
      })
      .catch((err: unknown) => {
        if (flight.deadlineExceeded) {
          // 超时已在截止定时器里落账：不重写 lastError、不二次延长冷却。
          console.warn('[overview] scan aborted at deadline');
          return;
        }
        const at = clock();
        state.lastError = {
          code: 'imap_unavailable',
          at,
          message: String(err instanceof Error ? err.message : err).slice(0, 200),
        };
        state.nextRetryAt = at + failureCooldownMs;
        console.warn('[overview] scan failed:', state.lastError.code);
      })
      .finally(() => {
        clearTimeout(timer);
        // 只在底层真 settle 后清槽位 —— 截止定时器永远不清它
        if (state.inFlight === flight) state.inFlight = null;
      });

    state.inFlight = flight;
    return flight;
  }

  async function getOverview(opts: {
    refresh: boolean;
    identityAddresses: string[];
  }): Promise<ScanOutcome> {
    const { refresh, identityAddresses } = opts;
    const now = clock();

    // ⓪ 0 身份短路在缓存层入口，路由由此只经 outcome.now 拿时间
    if (identityAddresses.length === 0) return zeroIdentityOutcome(now);

    const age = state.snapshot
      ? now - state.snapshot.scannedAt
      : Number.POSITIVE_INFINITY;

    // ① 新鲜命中 —— `!refresh` 是本条的组成部分，去掉就等于禁用了 ?refresh=1
    if (state.snapshot && !refresh && age < freshMs) {
      return settled('ready', state.snapshot, { now, cached: true, revalidating: false });
    }

    // ② 强制刷新的地板：只有真的"刚扫过"才拒绝
    if (state.snapshot && refresh && age < refreshFloorMs) {
      return settled('ready', state.snapshot, {
        now,
        cached: true,
        revalidating: false,
        floored: true,
      });
    }

    // ③ 单飞 + 失败冷却
    const flight = ensureFlight(identityAddresses, now);
    const cooldownMs = Math.max(0, state.nextRetryAt - now);

    // ④ 有可展示的 stale（严格 ≤ 硬过期）
    if (state.snapshot && age <= staleMaxMs) {
      return settled('stale', state.snapshot, {
        now,
        cached: true,
        // 没在途 flight 就不许说 true
        revalidating: Boolean(flight),
        retryAfterMs: flight ? 1500 : Math.max(cooldownMs, 1500),
      });
    }

    // ⑤ 无可用数据，且正在冷却
    if (!flight) {
      return {
        kind: 'unavailable',
        now,
        reason: state.lastError?.code ?? 'imap_unavailable',
        retryAfterSeconds: retryAfterSeconds(now),
      };
    }

    if ((await raceSettled(flight.promise, responseBudgetMs)) === 'timeout') {
      return { kind: 'loading', now, retryAfterMs: 1000 };
    }

    // ⑥ await 之后必须重读时钟、重算年龄：否则刷新失败时会把硬过期的旧快照
    //    当成 ready 复活。
    const now2 = clock();
    const age2 = state.snapshot
      ? now2 - state.snapshot.scannedAt
      : Number.POSITIVE_INFINITY;
    if (age2 < freshMs && state.snapshot) {
      return settled('ready', state.snapshot, {
        now: now2,
        cached: false,
        revalidating: false,
      });
    }
    if (state.snapshot && age2 <= staleMaxMs) {
      return settled('stale', state.snapshot, {
        now: now2,
        cached: true,
        revalidating: Boolean(state.inFlight),
        retryAfterMs: Math.max(0, state.nextRetryAt - now2) || 1500,
      });
    }
    return {
      kind: 'unavailable',
      now: now2,
      reason: state.lastError?.code ?? 'imap_unavailable',
      retryAfterSeconds: retryAfterSeconds(now2),
    };
  }

  return { getOverview };
}
