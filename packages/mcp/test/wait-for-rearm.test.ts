/**
 * #203 RED：客户端 waitFor 分块再武装、最终超时文案、中止不再发后续请求。
 * 本文件只测 OpenAgentEmailClient.waitFor；不改生产代码时应全部失败。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, OpenAgentEmailClient } from "../../api/src/mcp/client.ts";

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

/** 可控墙钟：假 fetch 立即返回时必须推进 Date.now，否则再武装会无限循环。 */
function installClock(start = 1_700_000_000_000) {
  let now = start;
  const realNow = Date.now;
  Date.now = () => now;
  return {
    advance(ms: number) {
      now += ms;
    },
    restore() {
      Date.now = realNow;
    },
  };
}

function parseCall(init?: RequestInit): FetchCall {
  const raw = init?.body;
  const text = typeof raw === "string" ? raw : raw == null ? "{}" : String(raw);
  return { body: JSON.parse(text) as Record<string, unknown>, signal: init?.signal };
}

const realDateNow = Date.now;
afterEach(() => {
  Date.now = realDateNow;
});

describe("#203 waitFor 分块再武装", () => {
  test("假 fetch 408→408→200：每段最多 50 秒、过滤条件不变、最终返回信件", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const call = parseCall(init);
      calls.push(call);
      if (calls.length < 3) {
        return new Response(JSON.stringify({ error: "timeout", timeoutSec: 50 }), { status: 408 });
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
  });

  test("总超时与更小的服务端钳制：文案含总时长/钳制/轮询次数，且不再建议加大 timeoutSec", async () => {
    const clock = installClock();
    const calls: FetchCall[] = [];
    try {
      const fetchImpl: typeof fetch = async (_input, init) => {
        const call = parseCall(init);
        calls.push(call);
        // 每次假等待消耗所请求的 chunk，逼近总截止
        clock.advance(Number(call.body.timeoutSec) * 1000);
        return new Response(JSON.stringify({ error: "timeout", timeoutSec: 30 }), { status: 408 });
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
        return new Response(JSON.stringify({ error: "timeout", timeoutSec: 50 }), { status: 408 });
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
    expect(seenSignals[0]).toBe(ac.signal);
    expect(err).toBeTruthy();
    expect(calls).toBe(1);
    if (err instanceof ApiError) expect(err.status).not.toBe(408);
  });

  test("chunk 之间 abort：不得再发后续请求，也不得当成 408 再武装", async () => {
    const ac = new AbortController();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (init?.signal) expect(init.signal).toBe(ac.signal);
      if (calls === 1) {
        ac.abort();
        return new Response(JSON.stringify({ error: "timeout", timeoutSec: 50 }), { status: 408 });
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
