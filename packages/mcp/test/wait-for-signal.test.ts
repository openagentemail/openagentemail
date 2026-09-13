/**
 * #203 RED：仅 mail_wait_for 注册转发 MCP handler 的 context signal。
 * 其它工具 schema / annotations 字节行为保持不变。
 */
import { expect, mock, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/server";

type ToolHandler = (args: Record<string, unknown>, ctx?: { mcpReq?: { signal: AbortSignal }; signal?: AbortSignal }) => Promise<CallToolResult> | CallToolResult;

type ToolConfig = {
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

const toolHandlers = new Map<string, ToolHandler>();
const toolConfigs = new Map<string, ToolConfig>();

class FakeMcpServer {
  registerTool(name: string, config: ToolConfig, handler?: ToolHandler) {
    toolConfigs.set(name, config);
    if (handler) toolHandlers.set(name, handler);
  }
  async connect() {}
}

mock.module("@modelcontextprotocol/server", () => ({ McpServer: FakeMcpServer }));

const waitFor = mock(async (_address: string, _opts: Record<string, unknown>) => ({
  id: "9",
  from: "alice@example.com",
  to: "bot@test.example",
  subject: "hello",
  date: "2026-09-12T00:00:00.000Z",
  seen: false,
  snippet: "hi",
  text: "hi",
  html: undefined,
  otp: { codes: [], links: [] },
  links: [],
  source: "external",
}));

const { registerOpenAgentEmailTools } = await import("../../api/src/mcp/tools.ts");

test("#203 mail_wait_for 把 handler context signal 传给 client.waitFor", async () => {
  const server = new FakeMcpServer();
  registerOpenAgentEmailTools(server as never, { waitFor } as never);

  const handler = toolHandlers.get("mail_wait_for");
  expect(handler, "mail_wait_for must register a callback").toBeDefined();
  // 当前实现只声明一个参数，忽略 ctx → RED
  expect(handler!.length).toBe(2);

  const listHandler = toolHandlers.get("mail_list_messages");
  expect(listHandler).toBeDefined();
  expect(listHandler!.length).toBeLessThan(2);

  const ac = new AbortController();
  const ctx = { mcpReq: { signal: ac.signal }, signal: ac.signal };
  await handler!(
    { address: "bot@test.example", fromContains: "alice", subjectContains: "hi", timeoutSec: 30 },
    ctx,
  );

  expect(waitFor).toHaveBeenCalled();
  const opts = waitFor.mock.calls[0]?.[1] as { signal?: AbortSignal; timeoutSec?: number; fromContains?: string };
  expect(opts.signal).toBe(ac.signal);
  expect(opts.timeoutSec).toBe(30);
  expect(opts.fromContains).toBe("alice");
});

test("#203 其它工具 schema/annotations 保持不变", () => {
  const server = new FakeMcpServer();
  registerOpenAgentEmailTools(server as never, { waitFor } as never);

  expect(toolConfigs.get("mail_list_messages")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("mail_list_messages")?.annotations?.untrustedContentHint).toBe(true);
  expect(toolConfigs.get("mail_send")?.annotations?.readOnlyHint).toBe(false);
  expect(toolConfigs.get("mail_send")?.annotations?.destructiveHint).toBe(false);
  expect(toolConfigs.get("mail_wait_for")?.annotations?.readOnlyHint).toBe(true);
  expect(toolConfigs.get("mail_wait_for")?.annotations?.idempotentHint).toBe(false);
  expect(toolConfigs.get("mail_mark_seen")?.annotations?.idempotentHint).toBe(true);
});
