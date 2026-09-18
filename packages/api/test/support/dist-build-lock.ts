/**
 * #226①：dist 钉子测试阶段 bun build 的包内串行锁。
 * 协议：staging 目录写好 PID 后 rename→锁路径（原子占锁），避免 mkdir→写 PID 窗口被抢。
 * 持锁进程已死则收锁；不改 build 脚本/产物路径（零构建面变化）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 探测 PID 是否仍存活（signal 0）。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 读取锁内 PID；无法解析则返回 NaN。 */
function readLockPid(lockDir: string): number {
  try {
    return Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim());
  } catch {
    return NaN;
  }
}

/** 把锁目录 rename 到 trash 再删，降低与新持锁者撞车。 */
function reclaimLockDir(lockDir: string, tag: string): void {
  const trash = `${lockDir}.${tag}.${Date.now()}`;
  try {
    renameSync(lockDir, trash);
    rmSync(trash, { recursive: true, force: true });
  } catch {
    // 他人已收走则忽略
  }
}

export type DistBuildLockOptions = {
  /** 锁目录路径（通常为 package 根下 .dist-build.lock）。 */
  lockDir: string;
  /** 轮询间隔毫秒。 */
  pollMs?: number;
  /** 最长等锁毫秒；超时抛错。 */
  timeoutMs?: number;
};

/**
 * 在互斥锁内执行 fn；第二进程自旋等待，陈旧 PID 自动收锁。
 */
export function withDistBuildLock<T>(options: DistBuildLockOptions, fn: () => T): T {
  const { lockDir, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;
  // staging：先写完 PID 再 rename 到 lockDir，关闭 mkdir→pid 窗口
  const staging = `${lockDir}.staging.${process.pid}.${Date.now()}`;

  for (;;) {
    try {
      mkdirSync(staging);
      writeFileSync(join(staging, 'pid'), String(process.pid), 'utf8');
      // rename 目录在同文件系统上原子排他
      renameSync(staging, lockDir);
      break;
    } catch (err) {
      // 清理本轮 staging（若仍在）
      rmSync(staging, { recursive: true, force: true });

      const code = (err as { code?: string }).code;
      // 目标已占用：EEXIST / ENOTEMPTY；其余错误若锁已在则继续等，否则抛出
      const targetBusy =
        code === 'EEXIST' || code === 'ENOTEMPTY' || (code !== undefined && existsSync(lockDir));
      if (!targetBusy && code !== undefined) {
        throw err;
      }

      if (existsSync(lockDir)) {
        const holder = readLockPid(lockDir);
        if (Number.isFinite(holder) && holder > 0 && !isPidAlive(holder)) {
          console.warn(`[dist-build-lock] stale PID ${holder} reclaiming ${lockDir}`);
          reclaimLockDir(lockDir, `stale.${holder}`);
          continue;
        }
        // 无合法 PID：宽限等待，临近超时再当半写崩溃回收（禁止立即 rm）
        if (!Number.isFinite(holder) || holder <= 0) {
          if (Date.now() + pollMs > deadline) {
            console.warn(`[dist-build-lock] lock without valid pid, reclaiming ${lockDir}`);
            reclaimLockDir(lockDir, 'broken');
            continue;
          }
        }
      }

      if (Date.now() > deadline) {
        throw new Error(`[dist-build-lock] timeout waiting for ${lockDir}`);
      }
      Bun.sleepSync(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    // 仅当 PID 仍是本进程时释放；读失败不盲删（防误伤他人锁）
    const holder = readLockPid(lockDir);
    if (holder === process.pid) {
      reclaimLockDir(lockDir, `release.${process.pid}`);
    }
  }
}
