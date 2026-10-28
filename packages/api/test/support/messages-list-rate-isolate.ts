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
/**
 * EBADF 恢复时排空等待上限。
 * `drainText()` 已用 `Response.text()` 锁住管道，`cancelStream()` 取消不了。
 * 若一直等到共享 deadline，剩余预算耗尽，`runIsolatedChild()` 会跳过唯一一次重试。
 */
const EBADF_DRAIN_BOUND_MS = 200;

export type IsolatedChildResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  reaped: boolean;
  dataDir: string;
};

/**
 * 仅测试注入。缺省是 Bun.spawn。
 * 句柄只保留本运输会碰到的字段，方便模拟 `exited` 拒绝。
 */
export type IsolatedChildSpawn = (
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdout: 'pipe';
    stderr: 'pipe';
  },
) => IsolatedChildHandle;

type IsolatedChildHandle = {
  stdout: unknown;
  stderr: unknown;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
};

type IsolatedAttempt =
  | { ok: true; result: IsolatedChildResult }
  | { ok: false; error: unknown; exitWatch: boolean };

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

function drainText(stream: unknown): Promise<string> {
  if (stream && typeof stream === 'object' && 'getReader' in stream) {
    return new Response(stream as ReadableStream<Uint8Array>).text();
  }
  return Promise.resolve('');
}

/** 流已锁或已关闭时取消会抛，调用方忽略。 */
function cancelStream(stream: unknown): void {
  if (!stream || typeof stream !== 'object' || !('cancel' in stream)) return;
  const cancel = (stream as { cancel?: unknown }).cancel;
  if (typeof cancel !== 'function') return;
  try {
    const pending = cancel.call(stream) as unknown;
    if (
      pending &&
      typeof pending === 'object' &&
      'catch' in pending &&
      typeof (pending as { catch?: unknown }).catch === 'function'
    ) {
      void (pending as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* 尽力取消 */
  }
}

/**
 * Bun 1.2.21 CI 的形态：`code === 'EBADF'`。
 * `syscall` 缺省时视为同一次监视器失败；带了则必须是 `epoll_ctl`。
 */
function isBunEbadfEpollCtl(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const rec = err as { code?: unknown; syscall?: unknown };
  if (rec.code !== 'EBADF') return false;
  if (rec.syscall !== undefined && rec.syscall !== 'epoll_ctl') return false;
  return true;
}

function defaultIsolatedSpawn(
  argv: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdout: 'pipe';
    stderr: 'pipe';
  },
): IsolatedChildHandle {
  return Bun.spawn(argv, options);
}

/** 与原先 50ms 轮询相同；退出或拒绝时清掉定时器，拒绝不会变成未处理拒绝。 */
function pollChildExit(
  child: IsolatedChildHandle,
): Promise<{ done: true; code: number } | { done: false }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), 50);
    child.exited.then(
      (code) => {
        clearTimeout(timer);
        resolve({ done: true, code });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 排空不超过 min(剩余预算, maxWaitMs)。
 * 到点就返回，不再 await 仍挂起的流；`allSettled` 接住后续拒绝，避免未处理拒绝。
 */
async function drainWithinBudget(
  stdoutP: Promise<string>,
  stderrP: Promise<string>,
  deadline: number,
  maxWaitMs: number,
): Promise<void> {
  const budgetMs = Math.min(Math.max(0, deadline - Date.now()), Math.max(0, maxWaitMs));
  // 先接住，再决定等不等。锁死的流可以一直 pending，调用方不再等待它。
  const drained = Promise.allSettled([stdoutP, stderrP]);
  if (budgetMs === 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, budgetMs);
    // allSettled 不会拒绝。回调若抛错，catch 掉，避免未处理拒绝。
    void drained.then(() => {
      clearTimeout(timer);
      resolve();
    }).catch(() => undefined);
  });
}

async function runOneIsolatedAttempt(
  opts: {
    argv: string[];
    env?: Record<string, string | undefined>;
  },
  spawnChild: IsolatedChildSpawn,
  deadline: number,
): Promise<IsolatedAttempt> {
  const dataDir = mkdtempSync(join(tmpdir(), 'oae-list-rate-child-'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let child: IsolatedChildHandle | undefined;
  let stdoutP = Promise.resolve('');
  let stderrP = Promise.resolve('');
  let timedOut = false;
  let reaped = false;
  let exitCode = -1;
  let infrastructureError: unknown;
  let attempt: IsolatedAttempt = {
    ok: false,
    error: new Error('isolate attempt did not finish'),
    exitWatch: false,
  };
  try {
    child = spawnChild(opts.argv, {
      cwd: PKG_DIR,
      env: childEnv(dataDir, opts.env),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    stdoutP = drainText(child.stdout);
    stderrP = drainText(child.stderr);
    for (;;) {
      let outcome: { done: true; code: number } | { done: false };
      try {
        outcome = await pollChildExit(child);
      } catch (err) {
        infrastructureError = err;
        throw err;
      }
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
    attempt = {
      ok: true,
      result: {
        exitCode,
        stdout,
        stderr,
        timedOut,
        reaped,
        dataDir,
      },
    };
  } catch (err) {
    // 监视器注册失败时先杀掉仍活着的子进程，再尽力排空/取消管道。dataDir 在 finally 里删。
    if (child && err === infrastructureError && isBunEbadfEpollCtl(err)) {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
      cancelStream(child.stdout);
      cancelStream(child.stderr);
      // 流已被 Response.text() 锁住，cancel 无效。只等短上限，把同一 deadline 留给重试。
      try {
        await drainWithinBudget(stdoutP, stderrP, deadline, EBADF_DRAIN_BOUND_MS);
      } catch {
        /* 尽力排空；未结束的 drain 已由 allSettled 接住 */
      }
    }
    attempt = { ok: false, error: err, exitWatch: err === infrastructureError };
  } finally {
    if (child && child.exitCode === null) {
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
  return attempt;
}

/**
 * 有界 spawn：spawn 后立即并发 drain 双管道；超时 SIGKILL+reap 后先收齐流再返回。
 * Bun 1.2.21 的 ubuntu CI 偶发（前面几文件跑过 Playwright/Chromium 之后）：
 * `child.exited` 在约 2–7ms 以 EBADF、syscall epoll_ctl（errno -9）拒绝。
 * 这是退出监视器注册失败，不是列表限速逻辑。丢掉该子进程，在同一截止时间内用新 dataDir 只再拉起一次。
 * EBADF 路径上的排空最多 `EBADF_DRAIN_BOUND_MS`，不把共享截止时间耗尽。
 */
export async function runIsolatedChild(
  opts: {
    argv: string[];
    timeoutMs: number;
    env?: Record<string, string | undefined>;
  },
  spawnChild: IsolatedChildSpawn = defaultIsolatedSpawn,
): Promise<IsolatedChildResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const first = await runOneIsolatedAttempt(opts, spawnChild, deadline);
  if (first.ok) return first.result;
  // 第二次 EBADF、其它错误，或剩余预算已用尽：原样抛出，不包一层。
  if (!first.exitWatch || !isBunEbadfEpollCtl(first.error) || Date.now() >= deadline) {
    throw first.error;
  }
  const second = await runOneIsolatedAttempt(opts, spawnChild, deadline);
  if (second.ok) return second.result;
  throw second.error;
}
