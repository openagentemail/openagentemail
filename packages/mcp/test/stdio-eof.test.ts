/**
 * #357：stdio stdin EOF 后进程行为钉版（SDK 2.1.0 实测：connected 后 EOF → exit 0）。
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDistBuildLock } from "./support/dist-build-lock.ts";

const mcpRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distMain = join(mcpRoot, "dist/main.js");

test("#357 stdio：stdin EOF 后进程退出（2.1.0 实测）", async () => {
  withDistBuildLock({}, () => {
    if (existsSync(distMain)) return;
    const build = Bun.spawnSync(["bun", "run", "build"], {
      cwd: mcpRoot, stdout: "inherit", stderr: "inherit",
    });
    expect(build.exitCode).toBe(0);
  });

  const result = await new Promise<{
    code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
  }>((resolve, reject) => {
    const child = spawn("node", [distMain], {
      env: {
        ...process.env,
        OPENAGENTEMAIL_API_URL: "http://127.0.0.1:3100",
        OPENAGENTEMAIL_API_KEY: "stdio-eof-regression-key",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ended = false;
    let settled = false;
    // 相对超时仅防挂死，判据是 exit 而非耗时
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`stdio EOF wait hung: ${stderr.slice(0, 200)}`));
    }, 15_000);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    };
    const endStdinOnce = () => {
      if (ended) return;
      ended = true;
      child.stdin.end(); // EOF
    };
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => {
      stderr += String(c);
      // 等 transport 挂上再 EOF，避免冷启动竞态（全量套件偶发）
      if (/openagentemail-mcp connected/.test(stderr)) endStdinOnce();
    });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    // close：stdio 流关闭后触发（exit 不保证 stdout 已冲完，CI 可假红）
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "stdio-eof-357", version: "0.0.0" },
      },
    })}\n`);
  });

  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  expect(result.stdout).toContain('"id":1');
  expect(result.stderr).toMatch(/openagentemail-mcp connected/);
}, 20_000);
