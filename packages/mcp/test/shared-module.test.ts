/**
 * 回归：stdio 入口必须复用 api 共享注册，禁止在 mcp 包内再留一份工具实现。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerOpenAgentEmailTools } from "../../api/src/mcp/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mainSrc = readFileSync(join(here, "../src/main.ts"), "utf8");

test("registerOpenAgentEmailTools 从共享模块导出", () => {
  expect(typeof registerOpenAgentEmailTools).toBe("function");
});

test("stdio main 从 ../../api/src/mcp 导入注册函数且自身不再 registerTool", () => {
  expect(mainSrc).toContain('from "../../api/src/mcp/tools.ts"');
  expect(mainSrc).toContain("registerOpenAgentEmailTools");
  expect(mainSrc).not.toContain("server.registerTool");
  // 实现文件不得再留在 mcp/src/lib（移动而非复制）
  expect(mainSrc).not.toContain("./lib/client");
  expect(mainSrc).not.toContain("./lib/fence");
});
