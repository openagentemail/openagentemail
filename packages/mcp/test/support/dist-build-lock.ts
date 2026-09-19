/**
 * #272：dist 钉子测试阶段 bun build 的包内串行锁。
 *
 * 协议：`Bun.serve({ port, hostname: '127.0.0.1' })` 占锁（同步；EADDRINUSE 抛错）。
 * 「Failed to start server / port in use」= 锁被占而非服务冲突（本端口专用于 dist build 互斥）。
 * 内核保证持锁进程死即释放——无 stale 回收 / PID 判断整层。
 * 零构建面变化（不改 build 脚本/产物路径）。
 *
 * mcp=43302 / api=43301：双包独立高位冷门端口，避免两包 build 串在同一把锁上。
 */
export const DIST_BUILD_LOCK_PORT = 43302;

export type DistBuildLockOptions = {
  /** 锁端口；默认本包 DIST_BUILD_LOCK_PORT。负控可注入隔离端口。 */
  port?: number;
  /** 轮询间隔毫秒。 */
  pollMs?: number;
  /** 最长等锁毫秒；超时抛错。 */
  timeoutMs?: number;
};

type HeldServer = { stop: (closeActiveConnections?: boolean) => void; port: number };

/**
 * 尝试占锁。成功返回 Bun Server；端口被占返回 null。
 * EADDRINUSE / "port in use" = 锁被占而非服务冲突（见文件头）。
 */
function tryAcquirePort(port: number): HeldServer | null {
  try {
    // fetch 永不被业务调用；仅用 listen 作互斥原语
    return Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch() {
        return new Response('dist-build-lock');
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Bun：Failed to start server. Is port N in use?
    if (/port .+ in use/i.test(msg) || /EADDRINUSE/i.test(msg)) return null;
    throw err;
  }
}

function releasePort(server: HeldServer): void {
  try {
    server.stop(true);
  } catch {
    // 已被内核回收则忽略
  }
}

/**
 * 在端口锁内执行同步 fn；第二进程自旋等待，持锁进程死=锁即释放。
 */
export function withDistBuildLock<T>(options: DistBuildLockOptions, fn: () => T): T {
  const { port = DIST_BUILD_LOCK_PORT, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let held: HeldServer | null = null;

  for (;;) {
    held = tryAcquirePort(port);
    if (held) break;
    if (Date.now() > deadline) {
      throw new Error(`[dist-build-lock] timeout waiting for 127.0.0.1:${port}`);
    }
    Bun.sleepSync(pollMs);
  }

  try {
    return fn();
  } finally {
    releasePort(held);
  }
}

/**
 * 异步临界区版：持锁覆盖 await 全程。
 */
export async function withDistBuildLockAsync<T>(
  options: DistBuildLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { port = DIST_BUILD_LOCK_PORT, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let held: HeldServer | null = null;

  for (;;) {
    held = tryAcquirePort(port);
    if (held) break;
    if (Date.now() > deadline) {
      throw new Error(`[dist-build-lock] timeout waiting for 127.0.0.1:${port}`);
    }
    await Bun.sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    releasePort(held);
  }
}
