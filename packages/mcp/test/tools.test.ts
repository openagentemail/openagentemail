// MCP 工具 schema 必须和 REST API 的契约一致：schema 放行、服务端却拒绝的
// 输入，只会让 agent 拿到一个 400，而不是它要的数据。
//
// 这里把 SDK 换成假的，好把 registerTool() 的配置抓出来直接断言。
import { expect, mock, test } from "bun:test";
import { z } from "zod";

type SchemaMap = Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: SchemaMap;
  outputSchema?: SchemaMap;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

const toolSchemas = new Map<string, SchemaMap>();
const toolConfigs = new Map<string, ToolConfig>();

class FakeMcpServer {
  registerTool(name: string, config: ToolConfig) {
    toolConfigs.set(name, config);
    toolSchemas.set(name, config.inputSchema ?? {});
  }

  async connect() {}
}

mock.module("@modelcontextprotocol/server", () => ({ McpServer: FakeMcpServer }));
mock.module("@modelcontextprotocol/server/stdio", () => ({
  StdioServerTransport: class {},
}));

process.env.OPENAGENTEMAIL_API_KEY = "test-key";
await import("../src/main.ts");

test("15 个工具都公布新 SDK 支持的元数据", () => {
  expect([...toolConfigs.keys()]).toEqual([
    "mail_new_identity",
    "mail_list_identities",
    "mail_list_messages",
    "mail_read_message",
    "mail_mark_seen",
    "mail_wait_for",
    "mail_send",
    "notify_user",
    "notify_agent",
    "notify_check",
    "notify_verify",
    "task_create",
    "task_list",
    "task_get",
    "task_update",
  ]);

  for (const config of toolConfigs.values()) {
    expect(config.title).toBeTruthy();
    expect(config.outputSchema).toBeDefined();
    expect(config.annotations).toBeDefined();
    expect(config.annotations?.openWorldHint).toBe(true);
  }

  expect(toolConfigs.get("mail_list_messages")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("mail_send")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("mail_send")?.annotations?.destructiveHint).toBe(false);
  expect(toolConfigs.get("mail_mark_seen")?.annotations?.destructiveHint).toBe(false);
  expect(toolConfigs.get("mail_mark_seen")?.annotations?.idempotentHint).toBe(true);
  expect(toolConfigs.get("notify_check")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("notify_user")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_list")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("task_get")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("task_create")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("task_update")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("mail_read_message")?.outputSchema).toBe(
    toolConfigs.get("mail_wait_for")?.outputSchema,
  );
});

test("读信类工具带 untrustedContentHint，description 钉死 fail-closed 可信口径", () => {
  for (const name of ["mail_list_messages", "mail_read_message", "mail_wait_for"] as const) {
    const config = toolConfigs.get(name);
    expect(config?.annotations?.untrustedContentHint).toBe(true);
    expect(config?.description ?? "").toContain("untrusted");
    expect(config?.description ?? "").toContain("source=internal");
    expect(config?.description ?? "").toContain("missing/unknown/external");
  }
  const listDesc = toolConfigs.get("mail_list_messages")?.description ?? "";
  // F1：snippet 已围栏，不得再声称 not fenced。
  expect(listDesc).not.toContain("Snippets are not fenced");
  expect(listDesc).toContain("Non-internal snippets are fenced");
  // 非读信工具不应误标。
  expect(toolConfigs.get("mail_send")?.annotations?.untrustedContentHint).toBeUndefined();
});

test("mail_list_messages limit 不能超出 REST API 接受的范围", () => {
  const limit = toolSchemas.get("mail_list_messages")!.limit;
  expect(limit.safeParse(1).success).toBe(true);
  expect(limit.safeParse(50).success).toBe(true);
  expect(limit.safeParse(200).success).toBe(true);
  // GET /v1/messages 的 zod 是 .max(200)，201 会被服务端以 400 拒掉。
  expect(limit.safeParse(201).success).toBe(false);
  expect(limit.safeParse(500).success).toBe(false);
});

test("工具入参约束要和 REST API 对齐，别把服务端必拒的值放过去", () => {
  const ok = (schema: SchemaMap, field: string, value: unknown) =>
    schema[field]!.safeParse(value).success;

  const newIdentity = toolSchemas.get("mail_new_identity")!;
  expect(ok(newIdentity, "name", "Fox")).toBe(true);
  expect(ok(newIdentity, "name", "")).toBe(false); // API: z.string().min(1)
  expect(ok(newIdentity, "name", "x".repeat(101))).toBe(false); // API: .max(100)
  expect(ok(newIdentity, "localpart", "my-bot")).toBe(true);
  expect(ok(newIdentity, "localpart", "qoder-cn-mbp")).toBe(true);
  expect(ok(newIdentity, "localpart", "My-Bot")).toBe(false); // uppercase not allowed
  expect(ok(newIdentity, "localpart", "-bot")).toBe(false); // must start alphanumeric
  expect(ok(newIdentity, "localpart", "a".repeat(64))).toBe(false); // max 63 chars

  const list = toolSchemas.get("mail_list_messages")!;
  expect(ok(list, "address", "fox-k7d2@test.example")).toBe(true);
  expect(ok(list, "address", "not-an-email")).toBe(false);

  const read = toolSchemas.get("mail_read_message")!;
  expect(ok(read, "id", "7")).toBe(true);
  expect(ok(read, "id", "../7")).toBe(false); // 服务端 Number(id) 会判非法
  expect(ok(read, "id", "0")).toBe(false);
  expect(ok(read, "address", "not-an-email")).toBe(false);

  const markSeen = toolSchemas.get("mail_mark_seen")!;
  expect(markSeen).toBeDefined();
  expect(ok(markSeen, "id", "7")).toBe(true);
  expect(ok(markSeen, "id", "../7")).toBe(false);
  expect(ok(markSeen, "id", "0")).toBe(false);
  expect(ok(markSeen, "address", "not-an-email")).toBe(false);
  expect(ok(markSeen, "seen", true)).toBe(true);
  expect(ok(markSeen, "seen", false)).toBe(true);
  expect(ok(markSeen, "seen", "yes")).toBe(false); // API: z.boolean()

  const waitFor = toolSchemas.get("mail_wait_for")!;
  expect(ok(waitFor, "address", "not-an-email")).toBe(false);
  expect(ok(waitFor, "fromContains", "x".repeat(200))).toBe(true);
  expect(ok(waitFor, "fromContains", "x".repeat(201))).toBe(false); // API: .max(200)
  expect(ok(waitFor, "subjectContains", "x".repeat(201))).toBe(false);

  const send = toolSchemas.get("mail_send")!;
  expect(ok(send, "from", "not-an-email")).toBe(false);
  expect(ok(send, "to", "not-an-email")).toBe(false);
  expect(ok(send, "subject", "x".repeat(998))).toBe(true);
  expect(ok(send, "subject", "x".repeat(999))).toBe(false); // API: .max(998)
  expect(ok(send, "text", "x".repeat(1_000_001))).toBe(false); // API: .max(1_000_000)
  expect(ok(send, "html", "x".repeat(1_000_001))).toBe(false);

  const notifyUser = toolSchemas.get("notify_user")!;
  expect(ok(notifyUser, "title", "wake")).toBe(true);
  expect(ok(notifyUser, "title", "")).toBe(false);
  expect(ok(notifyUser, "message", "x".repeat(4_000))).toBe(true);
  expect(ok(notifyUser, "message", "x".repeat(4_001))).toBe(false);
  expect(ok(notifyUser, "level", "urgent")).toBe(true);
  expect(ok(notifyUser, "level", "loud")).toBe(false);

  const notifyAgent = toolSchemas.get("notify_agent")!;
  expect(ok(notifyAgent, "name", "qa-bot")).toBe(true);
  expect(ok(notifyAgent, "name", "QA-Bot")).toBe(false);
  expect(ok(notifyAgent, "name", "-bot")).toBe(false);

  const taskCreate = toolSchemas.get("task_create")!;
  expect(ok(taskCreate, "to", "bravo@test.example")).toBe(true);
  expect(ok(taskCreate, "to", "not-an-email")).toBe(false);
  expect(ok(taskCreate, "subject", "x".repeat(998))).toBe(true);
  expect(ok(taskCreate, "subject", "x".repeat(999))).toBe(false);
  expect(ok(taskCreate, "body", "x".repeat(1_000_001))).toBe(false);
  expect(ok(taskCreate, "wait", true)).toBe(true);
  expect(ok(taskCreate, "wait", "yes")).toBe(false);

  const taskUpdate = toolSchemas.get("task_update")!;
  expect(ok(taskUpdate, "id", "0fdc3207-056e-47c1-a65c-b29d39f66b83")).toBe(true);
  expect(ok(taskUpdate, "id", "not-a-task")).toBe(false);
  expect(ok(taskUpdate, "state", "input-required")).toBe(true);
  expect(ok(taskUpdate, "state", "reopened")).toBe(false);
  expect(ok(taskUpdate, "body", "x".repeat(1_000_001))).toBe(false);
});

// 输出 schema 与 API 对齐：显示名 From/To 必须能过校验，且真返回字段不被剥掉。
test("message 输出 schema 接受 RFC-5322 显示名 from/to，并保留 hasOtp/links/task 字段", () => {
  const listMessages = toolConfigs.get("mail_list_messages")!.outputSchema!.messages;
  const summary = {
    id: "42",
    from: "Alice <alice@example.com>",
    to: "Bob <bob@example.com>, Carol <carol@example.com>",
    subject: "hi",
    date: "2026-08-09T00:00:00.000Z",
    seen: false,
    snippet: "body",
    hasOtp: true,
    source: "external",
  };
  const listParsed = listMessages.safeParse([summary]);
  expect(listParsed.success).toBe(true);
  if (listParsed.success) {
    const rows = listParsed.data as typeof summary[];
    // 校验后字段仍在，不能被 schema strip 掉。
    expect(rows[0]?.hasOtp).toBe(true);
    expect(rows[0]?.from).toBe("Alice <alice@example.com>");
    expect(rows[0]?.to).toBe("Bob <bob@example.com>, Carol <carol@example.com>");
  }

  const readOut = toolConfigs.get("mail_read_message")!.outputSchema!;
  const detail = {
    ...summary,
    text: "plain",
    html: "<p>plain</p>",
    otp: { codes: ["123456"], links: ["https://example.com/otp"] },
    links: ["https://example.com/a", "https://example.com/b"],
    taskId: "task-1",
    taskState: "submitted",
  };
  // 整对象过 outputSchema：显示名过，且 links/task* 校验后仍保留。
  const detailParsed = z.object(readOut as z.ZodRawShape).safeParse(detail);
  expect(detailParsed.success).toBe(true);
  if (detailParsed.success) {
    expect(detailParsed.data.hasOtp).toBe(true);
    expect(detailParsed.data.links).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(detailParsed.data.taskId).toBe("task-1");
    expect(detailParsed.data.taskState).toBe("submitted");
  }
  // 可选字段缺省也应放行。
  const { taskId: _tid, taskState: _ts, ...detailWithoutTask } = detail;
  expect(z.object(readOut as z.ZodRawShape).safeParse(detailWithoutTask).success).toBe(true);

  // RFC 5322 单行上限 998：超长 from/to 必须拒绝。
  expect(readOut.from!.safeParse("x".repeat(998)).success).toBe(true);
  expect(readOut.from!.safeParse("x".repeat(999)).success).toBe(false);
  expect(readOut.to!.safeParse("y".repeat(998)).success).toBe(true);
  expect(readOut.to!.safeParse("y".repeat(999)).success).toBe(false);

  // task 参与者仍是裸地址校验——不要跟着 message 一起放宽。
  const taskCreate = toolSchemas.get("task_create")!;
  expect(taskCreate.to!.safeParse("Alice <alice@example.com>").success).toBe(false);
  expect(taskCreate.to!.safeParse("alice@example.com").success).toBe(true);
});
