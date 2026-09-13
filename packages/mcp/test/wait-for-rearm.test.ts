/**
 * #203 RED：客户端 waitFor 分块再武装、最终超时文案、中止不再发后续请求。
 * 本文件只测 OpenAgentEmailClient.waitFor；不改生产代码时应全部失败。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  OpenAgentEmailClient,
  setWaitMonotonicNowForTests,
} from "../../api/src/mcp/client.ts";

const ADDRESS = "bot@test.example";
const SAMPLE_MESSAGE = {
  id: "9",
  from: "alice@example.com",
  to: ADDRESS,
  subject: "hello",
  date: "2026-09-12T00:00:00.000Z",
  seen: false,
  snippet: "hi",
  text: "hi",
  otp: { codes: [] as string[], links: [] as string[] },
};

type FetchCall = { body: Record<string, unknown>; signal?: AbortSignal };

/** 可控时钟：advance 同时推单调钟与墙钟；jumpWall / advanceMono 用于对照。 */
function installClock(start = 1_700_000_000_000) {
  let wall = start;
  let mono = 0;
  Date.now = () => wall;
  setWaitMonotonicNowForTests(() => mono);
  return {
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    /** 只拨墙钟，证明再武装/总截止不读 Date.now。 */
    jumpWall(ms: number) {
      wall += ms;
    },
    /** 只推单调钟，墙钟不动。 */
    advanceMono(ms: number) {
      mono += ms;
    },
    restore() {
      Date.now = realDateNow;
      setWaitMonotonicNowForTests();
    },
  };
}

/** 窗口内 abort listener 收支：全体 + 指定父 signal。 */
function tapAbortListenerBalance(parent: AbortSignal) {
  const proto = EventTarget.prototype;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  let adds = 0;
  let removes = 0;
  let parentAdds = 0;
  let parentRemoves = 0;
  proto.addEventListener = function (this: EventTarget, type, listener, options) {
    if (type === "abort") {
      adds += 1;
      if (this === parent) parentAdds += 1;
    }
    return origAdd.call(this, type, listener, options);
  };
  proto.removeEventListener = function (this: EventTarget, type, listener, options) {
    if (type === "abort") {
      removes += 1;
      if (this === parent) parentRemoves += 1;
    }
    return origRemove.call(this, type, listener, options);
  };
  return {
    snapshot: () => ({
      adds,
      removes,
      leftover: adds - removes,
      parentAdds,
      parentRemoves,
      parentLeftover: parentAdds - parentRemoves,
    }),
    restore() {
      proto.addEventListener = origAdd;
      proto.removeEventListener = origRemove;
    },
  };
}

function parseCall(init?: RequestInit): FetchCall {
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : raw == null ? "{}" : String(raw);
  return { body: JSON.parse(text) as Record<string, unknown>, signal: init?.signal };
}

const realDateNow = Date.now;
const realAddEventListener = EventTarget.prototype.addEventListener;
const realRemoveEventListener = EventTarget.prototype.removeEventListener;
afterEach(() => {
  Date.now = realDateNow;
  setWaitMonotonicNowForTests();
  EventTarget.prototype.addEventListener = realAddEventListener;
  EventTarget.prototype.removeEventListener = realRemoveEventListener;
});

describe("#203 waitFor 分块再武装", () => {
  test("假 fetch 408→408→200：每段最多 50 秒、过滤条件不变、最终返回信件", async () => {
    const clock = installClock();
    const calls: FetchCall[] = [];
    try {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const call = parseCall(init);
      calls.push(call);
      if (calls.length < 3) {
        clock.advance(Number(call.body.timeoutSec) * 1000);
        return timeout408(50);
      }
      return new Response(JSON.stringify(SAMPLE_MESSAGE), { status: 200 });
    };
    const client = new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl);
    const message = await client.waitFor(ADDRESS, {
      fromContains: "alice",
      subjectContains: "hello",
      timeoutSec: 120,
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.body.address).toBe(ADDRESS);
      expect(call.body.fromContains).toBe("alice");
      expect(call.body.subjectContains).toBe("hello");
      expect(Number(call.body.timeoutSec)).toBeLessThanOrEqual(50);
    }
    expect(message.id).toBe("9");
    expect(message.subject).toBe("hello");
    } finally {
      clock.restore();
    }
  });

  test("总超时与更小的服务端钳制：文案含总时长/钳制/轮询次数，且不再建议加大 timeoutSec", async () => {
    const clock = installClock();
    const calls: FetchCall[] = [];
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const call = parseCall(init);
        calls.push(call);
        // 每次假等待消耗所请求的 chunk，逼近总截止
        const asked = Number(call.body.timeoutSec);
        clock.advance(asked * 1000);
        return timeout408(Math.min(30, asked));
      };
      const client = new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl);
      const err = await client.waitFor(ADDRESS, { timeoutSec: 120 }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(408);
      expect((err as ApiError).message).toMatch(/120/);
      expect((err as ApiError).message).toMatch(/30/);
      expect((err as ApiError).message).toMatch(String(calls.length));
      expect((err as ApiError).message).not.toMatch(/Try a longer timeoutSec/);
      // 首段按 50s 上限；读到更小的 30s 钳制后后续段不得再要 50s
      expect(Number(calls[0]?.body.timeoutSec)).toBeLessThanOrEqual(50);
      expect(calls.slice(1).every((c) => Number(c.body.timeoutSec) <= 30)).toBe(true);
    } finally {
      clock.restore();
    }
  });

  test("401/403/429/网络失败不得再武装", async () => {
    for (const status of [401, 403, 429] as const) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "nope" }), { status });
      };
      const client = new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl);
      const err = await client.waitFor(ADDRESS, { timeoutSec: 120 }).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(status);
      expect(calls).toBe(1);
    }

    let netCalls = 0;
    const netFetch: typeof fetch = async () => {
      netCalls += 1;
      throw Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    };
    const netErr = await new OpenAgentEmailClient("http://api.test", "oa_token", netFetch)
      .waitFor(ADDRESS, { timeoutSec: 120 })
      .catch((e) => e);
    expect(netErr).toBeInstanceOf(ApiError);
    expect((netErr as ApiError).status).toBe(0);
    expect(netCalls).toBe(1);
  });

  test("chunk 进行中 abort：同一父 signal 传到 fetch，且不再发后续请求", async () => {
    const ac = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      seenSignals.push(init?.signal);
      // 缺失 signal 时立刻 408，避免 RED 挂死；断言在外层检查同一父 signal
      if (!init?.signal) {
        return timeout408(50);
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
        queueMicrotask(() => ac.abort());
      });
    };
    const client = new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl);
    const err = await client.waitFor(ADDRESS, { timeoutSec: 120, signal: ac.signal }).catch((e) => e);
    expect(seenSignals[0]).toBeDefined();
    expect(seenSignals[0]?.aborted).toBe(true);
    expect(err).toBeTruthy();
    expect(calls).toBe(1);
    if (err instanceof ApiError) expect(err.status).not.toBe(408);
  });

  test("chunk 之间 abort：不得再发后续请求，也不得当成 408 再武装", async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.signal).toBeDefined();
      if (calls === 1) {
        ac.abort();
        return timeout408(50);
      }
      throw new Error(`unexpected extra wait request #${calls}`);
    };
    const client = new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl);
    const err = await client.waitFor(ADDRESS, { timeoutSec: 120, signal: ac.signal }).catch((e) => e);
    expect(ac.signal.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(err).toBeTruthy();
    if (err instanceof ApiError) expect(err.status).not.toBe(408);
    expect(String((err as Error).message)).not.toMatch(/Try a longer timeoutSec/);
    expect(String((err as Error).message)).not.toMatch(/observed per-call clamp/);
  });
});

function timeout408(timeoutSec: number, extra?: { header?: string | null; body?: unknown }): Response {
  const body = extra && "body" in extra ? extra.body : { error: "timeout", timeoutSec };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!extra || extra.header !== null) {
    headers["X-OAE-Wait-Timeout-Sec"] = extra?.header ?? String(timeoutSec);
  }
  return new Response(JSON.stringify(body), { status: 408, headers });
}

describe("#206 R8 waitFor 再武装谓词与总截止", () => {
  test("1 代理式 408 缺头或坏体：只请求一次，kind=upstream_408_malformed，非总超时", async () => {
    const cases: Array<{ header?: string | null; body: unknown }> = [
      { header: null, body: { error: "timeout", timeoutSec: 50 } },
      { header: "50", body: { error: "oops", timeoutSec: 50 } },
      { header: "50", body: { error: "timeout", timeoutSec: "50" } },
      { header: "49", body: { error: "timeout", timeoutSec: 50 } },
    ];
    for (const c of cases) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        return timeout408(50, c);
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(calls, JSON.stringify(c)).toBe(1);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe("upstream_408_malformed");
      expect((err as ApiError).message).toMatch(/upstream_408_malformed/);
      expect((err as ApiError).message).not.toMatch(/observed per-call clamp/);
    }
  });

  test("2 外观合法但过早的 408：只请求一次，kind=upstream_timeout_early", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return timeout408(50);
    };
    const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
      .waitFor(ADDRESS, { timeoutSec: 120 })
      .catch((e) => e);
    expect(calls).toBe(1);
    expect((err as ApiError).kind).toBe("upstream_timeout_early");
    expect((err as ApiError).message).toMatch(/upstream_timeout_early/);
    expect((err as ApiError).message).not.toMatch(/observed per-call clamp/);
  });

  test("3 真消耗 interval 的 timeout+等值头：再武装且过滤/钳制保留", async () => {
    const clock = installClock();
    const calls: FetchCall[] = [];
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const call = parseCall(init);
        calls.push(call);
        const asked = Number(call.body.timeoutSec);
        clock.advance(asked * 1000);
        return timeout408(Math.min(30, asked));
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { fromContains: "alice", subjectContains: "hello", timeoutSec: 120 })
        .catch((e) => e);
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        expect(call.body.fromContains).toBe("alice");
        expect(call.body.subjectContains).toBe("hello");
      }
      expect(Number(calls[0]?.body.timeoutSec)).toBeLessThanOrEqual(50);
      expect(calls.slice(1).every((c) => Number(c.body.timeoutSec) <= 30)).toBe(true);
      expect((err as ApiError).kind).toBe("total_deadline");
      expect((err as ApiError).message).toMatch(/120/);
      expect((err as ApiError).message).toMatch(/30/);
    } finally {
      clock.restore();
    }
  });

  test("4b 未到达服务器的挂起段：客户端总截止结束，不主张槽位", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      });
    };
    const started = Date.now();
    const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
      .waitFor(ADDRESS, { timeoutSec: 1 })
      .catch((e) => e);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(calls).toBe(1);
    expect((err as ApiError).kind).toBe("total_deadline");
    expect((err as ApiError).message).toMatch(/observed per-call clamp/);
  }, 3500);

  test("5 总截止后才结算的 200 被丢弃，走最终超时，无消费副作用", async () => {
    const clock = installClock();
    let calls = 0;
    try {
      const fetchImpl: typeof fetch = async () => {
        calls += 1;
        clock.advance(200_000);
        return new Response(JSON.stringify(SAMPLE_MESSAGE), { status: 200 });
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(calls).toBe(1);
      expect((err as ApiError).kind).toBe("total_deadline");
      expect((err as ApiError).message).toMatch(/observed per-call clamp/);
    } finally {
      clock.restore();
    }
  });

  test("6 父 abort 保留 Error/string/symbol/object/null，且不再发后续段", async () => {
    const reasons: unknown[] = [
      new Error("parent-err"),
      "parent-str",
      Symbol("parent-sym"),
      { tag: "parent-obj" },
      null,
    ];
    for (const reason of reasons) {
      const ac = new AbortController();
      let calls = 0;
      const fetchImpl: typeof fetch = async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          ac.abort(reason as never);
          clockAdvanceAndTimeout(init);
          return timeout408(50);
        }
        throw new Error(`extra request for ${String(reason)}`);
      };
      const clock = installClock();
      const clockAdvanceAndTimeout = (init?: RequestInit) => {
        const call = parseCall(init);
        clock.advance(Number(call.body.timeoutSec) * 1000);
      };
      try {
        const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
          .waitFor(ADDRESS, { timeoutSec: 120, signal: ac.signal })
          .catch((e) => e);
        expect(calls).toBe(1);
        expect(err).toBe(reason);
      } finally {
        clock.restore();
      }
    }
  });

  test("12 容差：timeoutSec-125ms 可再武装；-500ms 立刻 fail-fast", async () => {
    const retryClock = installClock();
    let retryCalls = 0;
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        retryCalls += 1;
        const n = Number(parseCall(init).body.timeoutSec);
        retryClock.advance(n * 1000 - 125);
        return timeout408(n);
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(retryCalls).toBeGreaterThan(1);
      expect((err as ApiError).kind).toBe("total_deadline");
    } finally {
      retryClock.restore();
    }

    let earlyCalls = 0;
    const earlyClock = installClock();
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        earlyCalls += 1;
        const n = Number(parseCall(init).body.timeoutSec);
        earlyClock.advance(n * 1000 - 500);
        return timeout408(n);
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(earlyCalls).toBe(1);
      expect((err as ApiError).kind).toBe("upstream_timeout_early");
    } finally {
      earlyClock.restore();
    }
  });

  test("13 段间父 abort 阻止下一请求；同轮父原因压过内部截止", async () => {
    const ac = new AbortController();
    let calls = 0;
    const clock = installClock();
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          clock.advance(Number(parseCall(init).body.timeoutSec) * 1000);
          ac.abort("between-segments");
          return timeout408(50);
        }
        throw new Error("must not send next segment");
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120, signal: ac.signal })
        .catch((e) => e);
      expect(calls).toBe(1);
      expect(err).toBe("between-segments");
    } finally {
      clock.restore();
    }

    const parent = new AbortController();
    const hangFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            parent.abort("parent-same-turn");
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    const started = Date.now();
    const same = await new OpenAgentEmailClient("http://api.test", "oa_token", hangFetch)
      .waitFor(ADDRESS, { timeoutSec: 1, signal: parent.signal })
      .catch((e) => e);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(same).toBe("parent-same-turn");
  }, 3500);

  test("16 malformed/early 与 4-5 总截止文案/kind 可区分", async () => {
    const malformed = await new OpenAgentEmailClient("http://api.test", "oa_token", async () =>
      timeout408(50, { header: null, body: { error: "timeout", timeoutSec: 50 } }),
    )
      .waitFor(ADDRESS, { timeoutSec: 120 })
      .catch((e) => e as ApiError);
    const early = await new OpenAgentEmailClient("http://api.test", "oa_token", async () => timeout408(50))
      .waitFor(ADDRESS, { timeoutSec: 120 })
      .catch((e) => e as ApiError);
    const clock = installClock();
    let total: ApiError;
    try {
      total = (await new OpenAgentEmailClient("http://api.test", "oa_token", async () => {
        clock.advance(200_000);
        return new Response(JSON.stringify(SAMPLE_MESSAGE), { status: 200 });
      })
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e)) as ApiError;
    } finally {
      clock.restore();
    }
    expect(malformed.kind).toBe("upstream_408_malformed");
    expect(early.kind).toBe("upstream_timeout_early");
    expect(total.kind).toBe("total_deadline");
    expect(new Set([malformed.kind, early.kind, total.kind]).size).toBe(3);
    expect(malformed.message).not.toBe(total.message);
    expect(early.message).not.toBe(total.message);
  });

  test("墙钟跳变不改变再武装或总截止；决策只跟单调钟", async () => {
    const wallEarly = installClock();
    let wallEarlyCalls = 0;
    try {
      const fetchImpl: typeof fetch = async () => {
        wallEarlyCalls += 1;
        wallEarly.jumpWall(180_000);
        return timeout408(50);
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(wallEarlyCalls).toBe(1);
      expect((err as ApiError).kind).toBe("upstream_timeout_early");
      expect((err as ApiError).message).not.toMatch(/observed per-call clamp/);
    } finally {
      wallEarly.restore();
    }

    const wallSuccess = installClock();
    try {
      const fetchImpl: typeof fetch = async () => {
        wallSuccess.jumpWall(200_000);
        return new Response(JSON.stringify(SAMPLE_MESSAGE), { status: 200 });
      };
      const message = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl).waitFor(
        ADDRESS,
        { timeoutSec: 120 },
      );
      expect(message.id).toBe("9");
    } finally {
      wallSuccess.restore();
    }

    const monoOnly = installClock();
    const monoCalls: FetchCall[] = [];
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const call = parseCall(init);
        monoCalls.push(call);
        monoOnly.advanceMono(Number(call.body.timeoutSec) * 1000);
        return timeout408(Number(call.body.timeoutSec));
      };
      const err = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl)
        .waitFor(ADDRESS, { timeoutSec: 120 })
        .catch((e) => e);
      expect(monoCalls.length).toBeGreaterThan(1);
      expect((err as ApiError).kind).toBe("total_deadline");
    } finally {
      monoOnly.restore();
    }
  });

  test("多段再武装后父与内部 abort listener 收支平衡", async () => {
    const clock = installClock();
    const parent = new AbortController();
    const tap = tapAbortListenerBalance(parent.signal);
    try {
      let calls = 0;
      const fetchImpl: typeof fetch = async (_input, init) => {
        calls += 1;
        const asked = Number(parseCall(init).body.timeoutSec);
        // 前两段消耗 interval；成功段不拨钟，避免刚好踩上总截止。
        if (calls < 3) {
          clock.advance(asked * 1000);
          return timeout408(asked);
        }
        return new Response(JSON.stringify(SAMPLE_MESSAGE), { status: 200 });
      };
      const message = await new OpenAgentEmailClient("http://api.test", "oa_token", fetchImpl).waitFor(
        ADDRESS,
        { timeoutSec: 120, signal: parent.signal },
      );
      expect(message.id).toBe("9");
      const bal = tap.snapshot();
      expect(bal.leftover).toBe(0);
      expect(bal.parentLeftover).toBe(0);
      expect(bal.adds).toBe(bal.removes);
      expect(bal.parentAdds).toBe(bal.parentRemoves);
      // 外层父→内部 1 次 + 每段父/内部各 1 次；三段则全体 >= 7、父 >= 4
      expect(bal.adds).toBeGreaterThanOrEqual(7);
      expect(bal.parentAdds).toBeGreaterThanOrEqual(4);
    } finally {
      tap.restore();
      clock.restore();
    }
  });
});
