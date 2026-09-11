/**
 * 列表限速矩阵的子进程运输：父测试只 spawn/回收，不加载 app/config/imap。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PKG_DIR = join(import.meta.dir, '..');
/** 必须传绝对路径：`bun test support/foo.ts` 会被当成过滤器，不会跑文件。 */
export const MATRIX_FILE = join(import.meta.dir, 'messages-list-rate-matrix.ts');
export const PROBE_FILE = join(import.meta.dir, 'messages-list-rate-reset-probe.ts');
export const STALL_FILE = join(import.meta.dir, 'messages-list-rate-stall-child.ts');
export const VERBOSE_FILE = join(import.meta.dir, 'messages-list-rate-verbose-child.ts');

/** 必须低于 bun:test 默认 5s 父预算，并留出 kill/reap/drain 余量。不扩大父超时。 */
export const MATRIX_TIMEOUT_MS = 3_500;
export const PROBE_TIMEOUT_MS = 3_500;
export const STALL_PARENT_BUDGET_MS = 1_500;
export const VERBOSE_TIMEOUT_MS = 3_500;
/** 超过常见 64KiB 管道容量，用来证明立即 drain 而不是等 exited。 */
export const VERBOSE_BYTES_PER_STREAM = 128 * 1024;

export type IsolatedChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  reaped: boolean;
  dataDir: string;
};

function childEnv(dataDir: string, extra?: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  merged.NODE_ENV = 'test';
  merged.DOMAIN = 'test.example';
  merged.API_KEYS = 'admin-list-rate-a,admin-list-rate-b';
  merged.IMAP_USER = 'agent@test.example';
  merged.IMAP_PASS = 'imap-secret';
  merged.SMTP_USER = 'agent@test.example';
  merged.SMTP_PASS = 'smtp-secret';
  merged.MCP_PUBLIC_URL = 'http://localhost';
  merged.DATA_DIR = dataDir;
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function drainText(stream: ReadableStream<Uint8Array> | number | undefined): Promise<string> {
  if (stream && typeof stream === 'object' && 'getReader' in stream) {
    return new Response(stream).text();
  }
  return Promise.resolve('');
}

/** 有界 spawn：spawn 后立即并发 drain 双管道；超时 SIGKILL+reap 后先收齐流再返回。 */
export async function runIsolatedChild(opts: {
  argv: string[];
  timeoutMs: number;
  env?: Record<string, string | undefined>;
}): Promise<IsolatedChildResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oae-list-rate-child-'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(opts.argv, {
    cwd: PKG_DIR,
    env: childEnv(dataDir, opts.env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutP = drainText(child.stdout);
  const stderrP = drainText(child.stderr);
  const deadline = Date.now() + opts.timeoutMs;
  let timedOut = false;
  let reaped = false;
  let exitCode = -1;
  try {
    for (;;) {
      const outcome = await Promise.race([
        child.exited.then((code) => ({ done: true as const, code })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 50)),
      ]);
      if (outcome.done) {
        exitCode = outcome.code;
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        exitCode = await child.exited.catch(() => -1);
        reaped = true;
        break;
      }
    }
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      reaped,
      dataDir,
    };
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      await child.exited.catch(() => undefined);
      reaped = true;
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
