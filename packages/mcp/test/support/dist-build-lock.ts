/**
 * #272：dist 钉子测试阶段 bun build 的包内串行锁。
 *
 * 协议：`net.createServer().listen(固定端口, '127.0.0.1')` 占锁。
 * EADDRINUSE = 锁被占而非服务冲突（本端口专用于 dist build 互斥）。
 * 内核保证持锁进程死即释放——无 stale 回收 / PID 判断整层。
 * 同步路径：Worker 线程内 listen（同进程），主线程 Atomics.wait；
 *   临界区内可安全 spawnSync(bun build)；kill -9 整进程即释端口。
 * 零构建面变化（不改 build 脚本/产物路径）。
 *
 * mcp=43302 / api=43301：双包独立高位冷门端口，避免两包 build 串在同一把锁上。
 */
import { createServer, type Server } from 'node:net';
import { Worker } from 'node:worker_threads';

export const DIST_BUILD_LOCK_PORT = 43302;

export type DistBuildLockOptions = {
  /** 锁端口；默认本包 DIST_BUILD_LOCK_PORT。负控可注入隔离端口。 */
  port?: number;
  /** 轮询间隔毫秒。 */
  pollMs?: number;
  /** 最长等锁毫秒；超时抛错。 */
  timeoutMs?: number;
};

type HeldLock = { release: () => void };

/** Worker 内 listen 脚本：state[0] 0=pending 1=ok 2=busy 3=err */
const HOLDER_WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { createServer } = require('node:net');
  const state = new Int32Array(workerData.sab);
  const server = createServer();
  server.once('error', (err) => {
    const busy = err && (err.code === 'EADDRINUSE' || /EADDRINUSE/i.test(String(err.message || '')));
    Atomics.store(state, 0, busy ? 2 : 3);
    Atomics.notify(state, 0);
  });
  server.listen(workerData.port, '127.0.0.1', () => {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  });
  parentPort.on('message', (msg) => {
    if (msg === 'release') {
      try { server.close(); } catch (_) {}
      process.exit(0);
    }
  });
`;

/**
 * 同步尝试占 127.0.0.1:port；成功返回句柄，EADDRINUSE 返回 null。
 * EADDRINUSE = 锁被占而非服务冲突（见文件头）。
 */
function tryAcquirePortSync(port: number): HeldLock | null {
  const sab = new SharedArrayBuffer(8);
  const state = new Int32Array(sab);
  const worker = new Worker(HOLDER_WORKER_SOURCE, {
    eval: true,
    workerData: { sab, port },
  });
  // 最多等 2s 报到
  Atomics.wait(state, 0, 0, 2_000);
  const v = Atomics.load(state, 0);
  if (v === 1) {
    return {
      release: () => {
        try {
          worker.postMessage('release');
        } catch {
          // ignore
        }
        try {
          void worker.terminate();
        } catch {
          // ignore
        }
      },
    };
  }
  try {
    void worker.terminate();
  } catch {
    // ignore
  }
  if (v === 2) return null;
  if (v === 0) {
    throw new Error(`[dist-build-lock] timeout acquiring 127.0.0.1:${port}`);
  }
  throw new Error(`[dist-build-lock] listen failed on 127.0.0.1:${port} (state=${v})`);
}

function isAddrInUse(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { message?: string };
  return e?.code === 'EADDRINUSE' || /EADDRINUSE/i.test(String(e?.message ?? err));
}

async function tryAcquirePortAsync(port: number): Promise<HeldLock | null> {
  const server: Server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return {
      release: () => {
        try {
          server.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (err) {
    try {
      server.close();
    } catch {
      // ignore
    }
    if (isAddrInUse(err)) return null;
    throw err;
  }
}

/**
 * 在端口锁内执行同步 fn；第二进程自旋等待，持锁进程死=锁即释放。
 */
export function withDistBuildLock<T>(options: DistBuildLockOptions, fn: () => T): T {
  const { port = DIST_BUILD_LOCK_PORT, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let held: HeldLock | null = null;

  for (;;) {
    held = tryAcquirePortSync(port);
    if (held) break;
    if (Date.now() > deadline) {
      throw new Error(`[dist-build-lock] timeout waiting for 127.0.0.1:${port}`);
    }
    Bun.sleepSync(pollMs);
  }

  try {
    return fn();
  } finally {
    held.release();
  }
}

/**
 * 异步临界区版：持锁覆盖 await 全程（供 dist-bundle 子进程+资产断言）。
 */
export async function withDistBuildLockAsync<T>(
  options: DistBuildLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { port = DIST_BUILD_LOCK_PORT, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let held: HeldLock | null = null;

  for (;;) {
    held = await tryAcquirePortAsync(port);
    if (held) break;
    if (Date.now() > deadline) {
      throw new Error(`[dist-build-lock] timeout waiting for 127.0.0.1:${port}`);
    }
    await Bun.sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    held.release();
  }
}
