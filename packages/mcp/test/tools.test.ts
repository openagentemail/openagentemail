// MCP 工具 schema 必须和 REST API 的契约一致：schema 放行、服务端却拒绝的
// 输入，只会让 agent 拿到一个 400，而不是它要的数据。
//
// 这里把 SDK 换成假的，好把 registerTool() 的配置抓出来直接断言。
import { expect, mock, test } from "bun:test";

type SchemaMap = Record<string, { safeParse(value: unknown): { success: boolean } }>;
type ToolConfig = {
  title?: string;
  inputSchema?: SchemaMap;
  outputSchema?: SchemaMap;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
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

test("7 个工具都公布新 SDK 支持的元数据", () => {
  expect([...toolConfigs.keys()]).toEqual([
    "mail_new_identity",
    "mail_list_identities",
    "mail_list_messages",
    "mail_read_message",
    "mail_mark_seen",
    "mail_wait_for",
    "mail_send",
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
  expect(toolConfigs.get("mail_read_message")?.outputSchema).toBe(
    toolConfigs.get("mail_wait_for")?.outputSchema,
  );
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
});
