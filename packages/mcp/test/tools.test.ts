// MCP 工具 schema 必须和 REST API 的契约一致：schema 放行、服务端却拒绝的
// 输入，只会让 agent 拿到一个 400，而不是它要的数据。
//
// 这里把 SDK 换成假的，好把 server.tool() 注册的 zod schema 抓出来直接断言。
import { expect, mock, test } from "bun:test";

type SchemaMap = Record<string, { safeParse(value: unknown): { success: boolean } }>;

const toolSchemas = new Map<string, SchemaMap>();

class FakeMcpServer {
  tool(name: string, _description: string, schema: SchemaMap) {
    toolSchemas.set(name, schema);
  }

  async connect() {}
}

mock.module("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: FakeMcpServer }));
mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

process.env.OPENAGENTEMAIL_API_KEY = "test-key";
await import("../src/main.ts");

test("mail_list_messages limit 不能超出 REST API 接受的范围", () => {
  const limit = toolSchemas.get("mail_list_messages")!.limit;
  expect(limit.safeParse(1).success).toBe(true);
  expect(limit.safeParse(50).success).toBe(true);
  expect(limit.safeParse(200).success).toBe(true);
  // GET /v1/messages 的 zod 是 .max(200)，201 会被服务端以 400 拒掉。
  expect(limit.safeParse(201).success).toBe(false);
  expect(limit.safeParse(500).success).toBe(false);
});
