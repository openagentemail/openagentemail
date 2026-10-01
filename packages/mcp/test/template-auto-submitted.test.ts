// #363-B：模板 A/B 跳过非 no。假 spawn / 假 LLM / 假 send，不打真实端点。
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, expect, test } from "bun:test";

const SECRET = `whs_${"ab".repeat(32)}`;
process.env.WEBHOOK_SIGNING_SECRET = SECRET;
process.env.OPENAGENTEMAIL_API_URL = "http://127.0.0.1:9";
process.env.OPENAGENTEMAIL_API_KEY = "oa_test";

const { receiverServer, templateAHooks } = await import(
  "../../../examples/agent-responder/receiver.mjs"
);
const worker = (await import("../../../examples/agent-responder/worker.js")).default;

function sign(raw: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", Buffer.from(SECRET, "utf8"))
    .update(`${t}.`)
    .update(raw)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

test("模板 A：非 no 不 spawn；缺省与 no 仍 spawn 且提示要求重读", async () => {
  const spawned: string[] = [];
  templateAHooks.checkGeneration = async () => "ok";
  templateAHooks.spawnHeadless = (prompt: string) => {
    spawned.push(prompt);
    const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
    child.pid = 1;
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("exit", 0);
    });
    return child;
  };
  await new Promise<void>((resolve) => receiverServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (receiverServer.address() as { port: number }).port;
  let n = 0;
  const post = async (autoSubmitted?: string, from = "human@example.net") => {
    n += 1;
    const data: Record<string, unknown> = {
      address: "agent@test.example",
      messageId: "9",
      uidValidity: 17,
      from: { address: from },
    };
    if (autoSubmitted !== undefined) data.autoSubmitted = autoSubmitted;
    const raw = JSON.stringify({ id: `evt_a_${n}`, type: "mail.received", data });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "x-oae-signature": sign(raw) },
      body: raw,
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const before = spawned.length;
  for (const value of ["auto-generated", "auto-replied", "other"]) {
    await post(value);
    expect(spawned.length).toBe(before);
  }
  await post(undefined);
  await post("no");
  expect(spawned.length).toBe(before + 2);
  for (const prompt of spawned) {
    expect(prompt).toContain("mail_read_message");
    expect(prompt).toContain("Before any mail_send");
    expect(prompt).toContain('not "no"');
    expect(prompt).toContain("not proof of human origin");
  }
  // 伪造 no / 省略不能绕过代际预检或自地址守卫。
  const guarded = spawned.length;
  templateAHooks.checkGeneration = async () => "stale";
  await post("no");
  await post(undefined);
  expect(spawned.length).toBe(guarded);
  templateAHooks.checkGeneration = async () => "ok";
  await post("no", "agent@test.example");
  await post(undefined, "agent@test.example");
  expect(spawned.length).toBe(guarded);
});

afterAll(() => {
  receiverServer.close();
});

test("模板 B：事件非 no 不调 LLM；读回非 no 不发送；no 与 internal 仍走旧发送", async () => {
  const calls: Array<{ href: string; body?: string }> = [];
  let read: Record<string, unknown> = { text: "hello", autoSubmitted: "no", source: "internal" };
  // none=成功读；status=非 2xx；throw=读抛错。后两者都回到旧的元数据起草，不是 fail-closed。
  let readFailure: "none" | "status" | "throw" = "none";
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ href, body });
    if (href.includes("/v1/messages/")) {
      if (readFailure === "throw") throw new Error("boom");
      return new Response(JSON.stringify(read), { status: readFailure === "status" ? 404 : 200 });
    }
    if (href.includes("/v1/send")) {
      return new Response(JSON.stringify({ queued: true, messageId: "<m@test>" }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "Thanks" } }] }), {
      status: 200,
    });
  }) as typeof fetch;
  const env = {
    WEBHOOK_SIGNING_SECRET: SECRET,
    OPENAGENTEMAIL_API_URL: "http://127.0.0.1:9",
    OPENAGENTEMAIL_API_KEY: "oa_test",
    LLM_API_URL: "http://127.0.0.1:9/llm",
    LLM_API_KEY: "sk-test",
  };
  const run = async (
    autoSubmitted: string | undefined,
    nextRead: Record<string, unknown>,
    from = "human@example.net",
    uidValidity: number | null = 17,
  ) => {
    calls.length = 0;
    read = nextRead;
    const data: Record<string, unknown> = {
      address: "agent@test.example",
      messageId: "9",
      subject: "Hi",
      from: { address: from },
      // 显式 null 才省略代际；undefined 会吃到默认值 17。
      ...(uidValidity == null ? {} : { uidValidity }),
    };
    if (autoSubmitted !== undefined) data.autoSubmitted = autoSubmitted;
    const raw = JSON.stringify({ id: `evt_b_${autoSubmitted ?? "missing"}_${calls.length}`, type: "mail.received", data });
    let job: Promise<unknown> = Promise.resolve();
    const res = await worker.fetch(
      new Request("http://receiver.test/hook", {
        method: "POST",
        headers: { "X-OAE-Signature": sign(raw) },
        body: raw,
      }),
      env,
      { waitUntil(p: Promise<unknown>) { job = p; } },
    );
    expect(res.status).toBe(200);
    await job;
  };
  try {
    for (const value of ["auto-generated", "auto-replied", "other"]) {
      await run(value, { text: "hello", autoSubmitted: "no", source: "internal" });
      expect(calls).toEqual([]);
    }
    await run("no", { text: "hello", autoSubmitted: "auto-replied", source: "internal" });
    expect(calls.some((call) => call.href.includes("/v1/messages/"))).toBe(true);
    expect(calls.some((call) => call.href.includes("/llm"))).toBe(false);
    expect(calls.some((call) => call.href.includes("/v1/send"))).toBe(false);
    await run(undefined, { text: "hello", autoSubmitted: null, source: "internal" });
    const send = calls.find((call) => call.href.includes("/v1/send"));
    expect(calls.some((call) => call.href.includes("/llm"))).toBe(true);
    expect(send).toBeDefined();
    const payload = JSON.parse(send!.body ?? "{}") as Record<string, unknown>;
    expect(payload.autoReply).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("Auto-Submitted");
    expect(payload.text).toBe("Thanks");
    // 事件缺省，当前读变成 auto-generated：不调用 LLM、不发送。source 不抵消。
    await run(undefined, { text: "hello", autoSubmitted: "auto-generated", source: "internal" });
    expect(calls.some((call) => call.href.includes("/v1/messages/"))).toBe(true);
    expect(calls.some((call) => call.href.includes("/llm"))).toBe(false);
    expect(calls.some((call) => call.href.includes("/v1/send"))).toBe(false);
    // 伪造 no 或省略仍被自地址守卫拦住，且不取信、不调 LLM。
    await run("no", { text: "hello", autoSubmitted: "no" }, "agent@test.example");
    expect(calls).toEqual([]);
    await run(undefined, { text: "hello" }, "agent@test.example");
    expect(calls).toEqual([]);
    // 读失败或无代际：即使信上会是非 no，也仍按元数据起草并发送。
    readFailure = "status";
    await run("no", { text: "hidden", autoSubmitted: "auto-replied", source: "internal" });
    expect(calls.some((call) => call.href.includes("/v1/messages/"))).toBe(true);
    expect(calls.some((call) => call.href.includes("/llm"))).toBe(true);
    expect(calls.some((call) => call.href.includes("/v1/send"))).toBe(true);
    readFailure = "throw";
    await run(undefined, { text: "hidden", autoSubmitted: "auto-replied" });
    expect(calls.some((call) => call.href.includes("/v1/send"))).toBe(true);
    expect(calls.some((call) => call.href.includes("/llm"))).toBe(true);
    readFailure = "none";
    await run("no", { text: "hidden", autoSubmitted: "auto-replied" }, "human@example.net", null);
    expect(calls.some((call) => call.href.includes("/v1/messages/"))).toBe(false);
    expect(calls.some((call) => call.href.includes("/v1/send"))).toBe(true);
  } finally {
    globalThis.fetch = original;
  }
});
