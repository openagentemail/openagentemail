/**
 * 不拉起真子进程。注入 spawn，模拟 Bun 1.2.21 上 `child.exited` 的 EBADF / epoll_ctl。
 */
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { runIsolatedChild, type IsolatedChildSpawn } from './support/messages-list-rate-isolate.ts';

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
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
    stdout: textStream(spec.stdout ?? ''),
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
    const spawnChild: IsolatedChildSpawn = (argv, options) => {
      argvs.push([...argv]);
      const dataDir = options.env.DATA_DIR ?? '';
      if (dirs.length === 1) {
        firstRemovedBeforeRetry = !existsSync(dirs[0] ?? '');
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
    const started = Date.now();
    const result = await runIsolatedChild(
      { argv: ['bun', 'list-rate-child'], timeoutMs: 2_000 },
      spawnChild,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(argvs).toEqual([
      ['bun', 'list-rate-child'],
      ['bun', 'list-rate-child'],
    ]);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(firstRemovedBeforeRetry).toBe(true);
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
