/**
 * 不拉起真子进程。注入 spawn，模拟 Bun 1.2.21 上 `child.exited` 的 EBADF / epoll_ctl。
 */
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  EBADF_DRAIN_BOUND_MS,
  EBADF_RETRY_RESERVE_MS,
  runIsolatedChild,
  type IsolatedChildSpawn,
} from './support/messages-list-rate-isolate.ts';

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** 有字节但永不 close。Response.text() 锁住后，cancel 取消不了，排空会一直挂起。 */
function hungStdout(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hung'));
    },
  });
}

/** 仿 Node SystemError：message 里带 syscall，字段给判定用。 */
function systemError(code: string, syscall?: string): Error {
  const err = new Error(
    syscall ? `${code}: bad file descriptor, ${syscall}` : `${code}: bad file descriptor`,
  );
  const extra: { code: string; errno: number; syscall?: string } = { code, errno: -9 };
  if (syscall !== undefined) extra.syscall = syscall;
  return Object.assign(err, extra);
}

function fakeChild(spec: {
  reject?: unknown;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** stdout 永不结束，用来卡住被锁住的 drain。 */
  hangStdout?: boolean;
  kills: Array<number | NodeJS.Signals | undefined>;
}): ReturnType<IsolatedChildSpawn> {
  let exitCode: number | null = null;
  const exited = new Promise<number>((resolve, reject) => {
    queueMicrotask(() => {
      if (spec.reject !== undefined) {
        reject(spec.reject);
        return;
      }
      exitCode = spec.exitCode ?? 0;
      resolve(exitCode);
    });
  });
  return {
    stdout: spec.hangStdout ? hungStdout() : textStream(spec.stdout ?? ''),
    stderr: textStream(spec.stderr ?? ''),
    exited,
    get exitCode() {
      return exitCode;
    },
    kill(signal?: number | NodeJS.Signals) {
      spec.kills.push(signal);
    },
  };
}

describe('list-rate isolate EBADF retry', () => {
  test('list-rate isolate: EBADF epoll_ctl 只重试一次，结果来自第二个子进程，第一个 dataDir 已删', async () => {
    const ebadf = systemError('EBADF', 'epoll_ctl');
    const dirs: string[] = [];
    const argvs: string[][] = [];
    const firstKills: Array<number | NodeJS.Signals | undefined> = [];
    const secondKills: Array<number | NodeJS.Signals | undefined> = [];
    let firstRemovedBeforeRetry = false;
    let firstKilledBeforeRetry = false;
    const spawnChild: IsolatedChildSpawn = (argv, options) => {
      argvs.push([...argv]);
      const dataDir = options.env.DATA_DIR ?? '';
      if (dirs.length === 1) {
        firstRemovedBeforeRetry = !existsSync(dirs[0] ?? '');
        // 第二次拉起前，第一次的 SIGKILL 必须已经发出。
        firstKilledBeforeRetry = firstKills.includes('SIGKILL');
      }
      dirs.push(dataDir);
      if (dirs.length === 1) {
        return fakeChild({ reject: ebadf, kills: firstKills });
      }
      return fakeChild({
        exitCode: 4,
        stdout: 'second-out',
        stderr: 'second-err',
        kills: secondKills,
      });
    };
    const result = await runIsolatedChild(
      { argv: ['bun', 'list-rate-child'], timeoutMs: 2_000 },
      spawnChild,
    );
    expect(argvs).toEqual([
      ['bun', 'list-rate-child'],
      ['bun', 'list-rate-child'],
    ]);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(firstRemovedBeforeRetry).toBe(true);
    expect(firstKilledBeforeRetry).toBe(true);
    expect(existsSync(dirs[0] ?? '')).toBe(false);
    expect(firstKills.includes('SIGKILL')).toBe(true);
    expect(secondKills).toEqual([]);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toBe('second-out');
    expect(result.stderr).toBe('second-err');
    expect(result.timedOut).toBe(false);
    expect(result.dataDir).toBe(dirs[1]);
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: stdout 永不关闭且 exited 为 EBADF 时，仍重试且结果来自第二个子进程', async () => {
    const ebadf = systemError('EBADF', 'epoll_ctl');
    const argvs: string[][] = [];
    const spawnChild: IsolatedChildSpawn = (argv) => {
      argvs.push([...argv]);
      if (argvs.length === 1) {
        return fakeChild({ reject: ebadf, hangStdout: true, kills: [] });
      }
      return fakeChild({
        exitCode: 7,
        stdout: 'retry-out',
        stderr: 'retry-err',
        kills: [],
      });
    };
    const timeoutMs = 2_000;
    const result = await runIsolatedChild({ argv: ['bun', 'hang-stdout'], timeoutMs }, spawnChild);
    expect(argvs).toEqual([
      ['bun', 'hang-stdout'],
      ['bun', 'hang-stdout'],
    ]);
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('retry-out');
    expect(result.stderr).toBe('retry-err');
    expect(result.timedOut).toBe(false);
  });

  test('list-rate isolate: 剩余预算小于排空上限时，锁住的 stdout 仍会进入第二次尝试', async () => {
    const ebadf = systemError('EBADF', 'epoll_ctl');
    const argvs: string[][] = [];
    // 小于排空上限，也小于重试预留。旧逻辑会把剩余时间全部耗在排空上，第二次不会跑。
    const timeoutMs = 150;
    expect(timeoutMs).toBeLessThan(EBADF_DRAIN_BOUND_MS);
    expect(timeoutMs).toBeLessThan(EBADF_RETRY_RESERVE_MS);
    const result = await runIsolatedChild(
      { argv: ['bun', 'tight-budget'], timeoutMs },
      (argv) => {
        argvs.push([...argv]);
        if (argvs.length === 1) {
          return fakeChild({ reject: ebadf, hangStdout: true, kills: [] });
        }
        return fakeChild({
          exitCode: 5,
          stdout: 'tight-out',
          stderr: 'tight-err',
          kills: [],
        });
      },
    );
    expect(argvs).toEqual([
      ['bun', 'tight-budget'],
      ['bun', 'tight-budget'],
    ]);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('tight-out');
    expect(result.stderr).toBe('tight-err');
    expect(result.timedOut).toBe(false);
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: 第二次 EBADF 原样抛出', async () => {
    const firstErr = systemError('EBADF', 'epoll_ctl');
    const secondErr = systemError('EBADF', 'epoll_ctl');
    const dirs: string[] = [];
    let calls = 0;
    let thrown: unknown;
    try {
      await runIsolatedChild({ argv: ['bun', 'again'], timeoutMs: 2_000 }, (_argv, options) => {
        calls += 1;
        const dataDir = options.env.DATA_DIR ?? '';
        if (calls === 2) {
          expect(existsSync(dirs[0] ?? '')).toBe(false);
        }
        dirs.push(dataDir);
        return fakeChild({
          reject: calls === 1 ? firstErr : secondErr,
          kills: [],
        });
      });
      throw new Error('should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(2);
    expect(thrown).toBe(secondErr);
    expect(existsSync(dirs[0] ?? '')).toBe(false);
    expect(existsSync(dirs[1] ?? '')).toBe(false);
  });

  test('list-rate isolate: 非 EBADF 的 exited 拒绝不重试', async () => {
    const boom = Object.assign(new Error('disk full'), { code: 'EIO' });
    let calls = 0;
    let dataDir = '';
    let thrown: unknown;
    try {
      await runIsolatedChild({ argv: ['bun', 'once'], timeoutMs: 2_000 }, (_argv, options) => {
        calls += 1;
        dataDir = options.env.DATA_DIR ?? '';
        return fakeChild({ reject: boom, kills: [] });
      });
      throw new Error('should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(1);
    expect(thrown).toBe(boom);
    expect(existsSync(dataDir)).toBe(false);
  });

  test('list-rate isolate: EBADF 但 syscall 不是 epoll_ctl 时不重试', async () => {
    const otherFd = systemError('EBADF', 'read');
    let calls = 0;
    let thrown: unknown;
    try {
      await runIsolatedChild({ argv: ['bun', 'syscall'], timeoutMs: 2_000 }, () => {
        calls += 1;
        return fakeChild({ reject: otherFd, kills: [] });
      });
      throw new Error('should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(calls).toBe(1);
    expect(thrown).toBe(otherFd);
  });
});
