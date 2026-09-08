/**
 * #168 净环境启动回归：stdio bundle 不得在模块加载期 parse 服务端 env。
 * 只给 OPENAGENTEMAIL_API_URL + OPENAGENTEMAIL_API_KEY，必须完成 initialize + tools/list。
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mcpRoot = join(here, "..");
const distMain = join(mcpRoot, "dist/main.js");
const SERVER_ENV_KEYS = [
  "DOMAIN",
  "API_KEYS",
  "IMAP_USER",
  "IMAP_PASS",
  "SMTP_USER",
  "SMTP_PASS",
] as const;

/** MCP SDK v2 stdio 是换行 JSON，不是 Content-Length。 */
function encodeMcpMessage(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function decodeMcpMessages(buffer: string): { messages: Record<string, unknown>[]; rest: string } {
  const messages: Record<string, unknown>[] = [];
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return { messages, rest };
}

async function handshakeCleanBoot(command: string, args: string[]): Promise<{
  initialize: Record<string, unknown>;
  tools: string[];
  stderr: string;
}> {
  const env = { ...process.env };
  for (const key of SERVER_ENV_KEYS) delete env[key];
  env.OPENAGENTEMAIL_API_URL = "http://127.0.0.1:3100";
  env.OPENAGENTEMAIL_API_KEY = "repro-placeholder-not-a-secret";

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let initialize: Record<string, unknown> | undefined;
    let tools: string[] | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve({ initialize: initialize!, tools: tools!, stderr });
    };

    const timer = setTimeout(() => {
      finish(new Error(`clean-boot handshake timed out: ${stderr || "(no stderr)"}`));
    }, 20_000);

    const consume = () => {
      const decoded = decodeMcpMessages(stdout);
      stdout = decoded.rest;
      for (const message of decoded.messages) {
        if (message.id === 1 && message.result && !initialize) {
          initialize = message.result as Record<string, unknown>;
          child.stdin.write(encodeMcpMessage({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }));
          child.stdin.write(encodeMcpMessage({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }));
        }
        if (message.id === 2 && message.result) {
          const list = message.result as { tools?: Array<{ name?: string }> };
          tools = (list.tools ?? []).map((tool) => tool.name ?? "").filter(Boolean);
          if (tools.length === 0) {
            finish(new Error("tools/list returned no tools"));
            return;
          }
          finish();
        }
        if (message.error) {
          finish(new Error(`MCP error: ${JSON.stringify(message.error)}`));
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      consume();
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`stdio bundle exited ${code} before handshake: ${stderr}`));
      }
    });

    child.stdin.write(encodeMcpMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "clean-boot-regression", version: "0.0.0" },
      },
    }));
  });
}

test("#168 净环境 dist bundle 完成 initialize + tools/list，且不含服务端 parseConfig", async () => {
  if (!existsSync(distMain)) {
    const build = spawn("bun", ["run", "build"], { cwd: mcpRoot, stdio: "inherit" });
    const status = await new Promise<number>((resolve, reject) => {
      build.on("error", reject);
      build.on("exit", (code) => resolve(code ?? 1));
    });
    expect(status).toBe(0);
  }
  const bundle = readFileSync(distMain, "utf8");
  expect(bundle).not.toContain("parseConfig(process.env)");
  expect(bundle).not.toMatch(/envSchema\.parse\(\s*env\s*\)/);

  const result = await handshakeCleanBoot("node", [distMain]);
  const serverInfo = result.initialize.serverInfo as { name?: string; version?: string } | undefined;
  expect(serverInfo?.name).toBe("openagentemail");
  expect(result.tools).toContain("mail_list_identities");
  expect(result.tools).toContain("task_list");
  expect(result.stderr).not.toMatch(/ZodError|DOMAIN|IMAP_USER|SMTP_USER/);
}, 20_000);
