/**
 * dist 进程冒烟共用：空闲端口、探活。
 * dist 产物测试和启动回放测试都从这里拿，避免各写一份。
 * 构建互斥锁仍在 dist-build-lock.ts。
 */
import { createServer } from 'node:net';
import { join } from 'node:path';

/** packages/api 根目录。 */
export const apiPackageDir = join(import.meta.dir, '..', '..');
/** `bun run build` 的产物目录。 */
export const apiDistDir = join(apiPackageDir, 'dist');

/**
 * 等到 GET /healthz 返回 2xx。超时带上启动日志，避免子进程静默挂死。
 */
export async function waitForServer(
  port: number,
  deadlineMs: number,
  getBootLog: () => string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch {
      // 端口还没听上
    }
    if (Date.now() - started > deadlineMs) {
      throw new Error(`dist server did not come up; boot log:\n${getBootLog()}`);
    }
    await Bun.sleep(200);
  }
}

/**
 * 探测一个当下空闲的端口（绑定后立即释放，交给 dist 进程使用）。
 * 免并行下硬编码端口碰撞。
 */
export async function freePort(): Promise<number> {
  for (let candidate = 24_000 + Math.floor(Math.random() * 20_000); ; candidate++) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (ok) return candidate;
  }
}
