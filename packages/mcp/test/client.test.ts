// 诊断信息不能把配置里的凭据带出去 —— 它会进 agent 的上下文和客户端日志。
// 但也不能把故障原因抹干净，否则"连不上"这类最常见的问题没法排查。
import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, OpenAgentEmailClient, apiUrlForDisplay } from "../../api/src/mcp/client.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function failFetchWith(err: unknown) {
  globalThis.fetch = (async () => {
    throw err;
  }) as typeof fetch;
}

describe("apiUrlForDisplay", () => {
  test("抹掉 URL 里的用户名和密码", () => {
    expect(apiUrlForDisplay("https://agent:super-secret@mail.example.test")).not.toContain(
      "super-secret",
    );
    expect(apiUrlForDisplay("https://agent:super-secret@mail.example.test")).toContain(
      "mail.example.test",
    );
  });

  test("抹掉敏感 query 参数和 fragment", () => {
    const shown = apiUrlForDisplay("https://h.example/api?token=abc123&page=2#tok-xyz");
    expect(shown).not.toContain("abc123");
    expect(shown).not.toContain("tok-xyz");
    expect(shown).toContain("page=2");
  });

  test("普通 URL 原样显示（去掉多余的尾斜杠）", () => {
    expect(apiUrlForDisplay("http://localhost:3100")).toBe("http://localhost:3100");
    expect(apiUrlForDisplay("http://localhost:3100/")).toBe("http://localhost:3100");
    expect(apiUrlForDisplay("http://127.0.0.1:3100/base")).toBe("http://127.0.0.1:3100/base");
  });

  // new URL() 失败的路径才是最容易出事的：用户填错 URL 的同时，凭据往往就
  // 写在那串错的东西里。只剥 userinfo、其余原样返回等于全泄漏。
  test("解析失败的 URL 也要把敏感 query 抹掉", () => {
    const cases = [
      "http://[::1?token=super-secret",
      "://bad?api_key=super-secret",
      "http://[::1?apiKey=super-secret&page=2",
      "https://agent:super-secret@[::1?auth=super-secret#tok-super-secret",
    ];
    for (const raw of cases) {
      const shown = apiUrlForDisplay(raw);
      expect(shown).not.toContain("super-secret");
    }
    // 无关参数要保留，否则等于什么都没告诉用户。
    expect(apiUrlForDisplay("http://[::1?apiKey=super-secret&page=2")).toContain("page=2");
    expect(apiUrlForDisplay("http://[::1?token=super-secret")).toContain("[::1");
  });

  test("解析不了的 URL 仍然告诉用户他填了什么，但去掉 user:pass", () => {
    // 最常见的配置错误就是漏掉 http:// —— 显示成 "[invalid URL]" 等于没提示。
    expect(apiUrlForDisplay("localhost:3100")).toContain("localhost:3100");
    expect(apiUrlForDisplay("agent:super-secret@localhost:3100")).not.toContain("super-secret");
  });
});

describe("网络故障诊断", () => {
  test("不泄露 URL 里的凭据（Node 的 fetch 会把它写进 err.message）", async () => {
    const url = "https://agent:super-secret@mail.example.test";
    failFetchWith(
      new TypeError(
        `Request cannot be constructed from a URL that includes credentials: ${url}/v1/identities`,
      ),
    );
    const client = new OpenAgentEmailClient(url, "oa_token");

    const err = (await client.listIdentities().catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).not.toContain("super-secret");
    expect(err.message).toContain("mail.example.test");
  });

  test("保留故障代码（ECONNREFUSED 之类），排障还能用", async () => {
    failFetchWith(Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }));
    const direct = (await new OpenAgentEmailClient("http://localhost:3100", "oa_token")
      .listIdentities()
      .catch((e) => e)) as ApiError;
    expect(direct.message).toContain("ECONNREFUSED");

    // Node 把真正的原因放在 cause 里。
    failFetchWith(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      }),
    );
    const nested = (await new OpenAgentEmailClient("http://localhost:3100", "oa_token")
      .listIdentities()
      .catch((e) => e)) as ApiError;
    expect(nested.message).toContain("ENOTFOUND");
  });
});

describe("#362 readMessage 的 uidValidity 查询", () => {
  function jsonFetch(onUrl: (url: string) => void) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      onUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  }

  test("省略 uidValidity 时 URL 与旧调用一致", async () => {
    let seen = "";
    jsonFetch((url) => {
      seen = url;
    });
    await new OpenAgentEmailClient("http://127.0.0.1:3100", "oa_token").readMessage(
      "fox@test.example",
      "7",
    );
    expect(seen).toBe("http://127.0.0.1:3100/v1/messages/7?address=fox%40test.example");
  });

  test("传入的正十进制串进入编码后的查询，且不改成数字", async () => {
    let seen = "";
    jsonFetch((url) => {
      seen = url;
    });
    await new OpenAgentEmailClient("http://127.0.0.1:3100", "oa_token").readMessage(
      "a+b@test.example",
      "7",
      "9007199254740993",
    );
    expect(seen).toBe(
      "http://127.0.0.1:3100/v1/messages/7?address=a%2Bb%40test.example&uidValidity=9007199254740993",
    );
  });

  // #363-B1：客户端原样带回有界信号，不改查询形状。
  test("readMessage 返回有界 autoSubmitted", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "7", text: "hi", autoSubmitted: "auto-generated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const msg = await new OpenAgentEmailClient("http://127.0.0.1:3100", "oa_token").readMessage(
      "fox@test.example",
      "7",
    );
    expect(msg.autoSubmitted).toBe("auto-generated");
  });

  // #5597：旧 API 响应省略 autoSubmitted。原样为 undefined，不合成 null 或 no。
  test("readMessage 旧 API 缺 autoSubmitted 时返回 undefined", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "7", text: "hi" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const msg = await new OpenAgentEmailClient("http://127.0.0.1:3100", "oa_token").readMessage(
      "fox@test.example",
      "7",
    );
    expect(msg.autoSubmitted).toBeUndefined();
  });
});

describe("mail_send autoReply 传到 REST（#363-A）", () => {
  test("省略不进 body；false 与 true 原样进入且不含 headers", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ queued: true, messageId: "<m@test>" }), { status: 200 });
    }) as typeof fetch;
    const client = new OpenAgentEmailClient("http://127.0.0.1:9", "oa_test", fetchImpl);
    await client.send("a@test.example", "b@example.net", "s", "t");
    await client.send("a@test.example", "b@example.net", "s", "t", undefined, false);
    await client.send("a@test.example", "b@example.net", "s", "t", "<p>h</p>", true);
    expect(bodies[0]).not.toHaveProperty("autoReply");
    expect(bodies[0]).not.toHaveProperty("headers");
    expect(bodies[1]).toMatchObject({ autoReply: false });
    expect(bodies[1]).not.toHaveProperty("headers");
    expect(JSON.stringify(bodies[1])).not.toContain("Auto-Submitted");
    expect(bodies[2]).toMatchObject({ autoReply: true, html: "<p>h</p>" });
    expect(bodies[2]).not.toHaveProperty("headers");
    expect(JSON.stringify(bodies[2])).not.toContain("Auto-Submitted");
  });
});
