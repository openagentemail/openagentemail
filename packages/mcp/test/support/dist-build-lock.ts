/**
 * #226①：dist 钉子测试阶段 bun build 的包内串行锁。
 * 协议：staging 写好 PID 后 rename→锁路径（原子占锁）。
 * 陈旧回收身份绑定：rename 前重读确认仍是目标死 PID；rename 后校验 trash，
 * 误收他人新锁则立刻归还；回收后一律回到抢锁循环（不假定已得锁）。
 * 零构建面变化（不改 build 脚本/产物路径）。
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

/** 读取锁目录内 PID；无法解析则返回 NaN。 */
function readLockPid(lockPath: string): number {
  try {
    return Number(readFileSync(join(lockPath, 'pid'), 'utf8').trim());
  } catch {
    return NaN;
  }
}

/**
 * 身份绑定回收：仅当锁内 PID 仍等于 expectedDeadPid 时 rename 走 trash；
 * 若 trash 内 PID 已变（误收他人新活锁）则立刻归还。
 * @returns 是否成功清掉该死锁（调用方必须 continue 抢锁，不得假定持锁）
 */
function tryReclaimStaleDeadPid(lockDir: string, expectedDeadPid: number): boolean {
  // 回收前再确认仍是那个死 PID（双竞争者同见死 PID 时后手不得盲 rename）
  const before = readLockPid(lockDir);
  if (before !== expectedDeadPid) return false;

  const trash = `${lockDir}.stale.${expectedDeadPid}.${process.pid}.${Date.now()}`;
  try {
    renameSync(lockDir, trash);
  } catch {
    return false;
  }

  const moved = readLockPid(trash);
  if (moved !== expectedDeadPid) {
    // 误收了他人新锁：立刻归还
    console.warn(
      `[dist-build-lock] reclaim raced (expected dead ${expectedDeadPid}, got ${moved}); restoring`,
    );
    try {
      renameSync(trash, lockDir);
    } catch {
      // 归还失败则尽力保留 trash，避免丢锁目录
    }
    return false;
  }

  console.warn(`[dist-build-lock] stale PID ${expectedDeadPid} reclaiming ${lockDir}`);
  rmSync(trash, { recursive: true, force: true });
  return true;
}

/**
 * 无合法 PID 的半写锁：确认仍无合法 PID 后再收；误收则归还。
 */
function tryReclaimBrokenLock(lockDir: string): boolean {
  const before = readLockPid(lockDir);
  if (Number.isFinite(before) && before > 0) return false;

  const trash = `${lockDir}.broken.${process.pid}.${Date.now()}`;
  try {
    renameSync(lockDir, trash);
  } catch {
    return false;
  }

  const moved = readLockPid(trash);
  if (Number.isFinite(moved) && moved > 0) {
    console.warn(`[dist-build-lock] broken reclaim raced (got pid ${moved}); restoring`);
    try {
      renameSync(trash, lockDir);
    } catch {
      // ignore
    }
    return false;
  }

  console.warn(`[dist-build-lock] lock without valid pid, reclaiming ${lockDir}`);
  rmSync(trash, { recursive: true, force: true });
  return true;
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
 * 在互斥锁内执行 fn；第二进程自旋等待，陈旧 PID 身份绑定回收。
 */
export function withDistBuildLock<T>(options: DistBuildLockOptions, fn: () => T): T {
  const { lockDir, pollMs = 50, timeoutMs = 180_000 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // 每轮新 staging，避免崩溃残留同名目录
    const staging = `${lockDir}.staging.${process.pid}.${Date.now()}`;
    try {
      mkdirSync(staging);
      writeFileSync(join(staging, 'pid'), String(process.pid), 'utf8');
      // rename 目录在同文件系统上原子排他
      renameSync(staging, lockDir);
      break;
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });

      const code = (err as { code?: string }).code;
      const targetBusy =
        code === 'EEXIST' || code === 'ENOTEMPTY' || (code !== undefined && existsSync(lockDir));
      if (!targetBusy && code !== undefined) {
        throw err;
      }

      if (existsSync(lockDir)) {
        const holder = readLockPid(lockDir);
        if (Number.isFinite(holder) && holder > 0 && !isPidAlive(holder)) {
          // 身份绑定回收后必须回到抢锁循环（不假定得锁）
          tryReclaimStaleDeadPid(lockDir, holder);
          // 无论成败都 continue：成功则下轮抢；失败则下轮再观察
          if (Date.now() > deadline) {
            throw new Error(`[dist-build-lock] timeout waiting for ${lockDir}`);
          }
          Bun.sleepSync(pollMs);
          continue;
        }
        // 无合法 PID：宽限等待，临近超时再 broken 回收
        if (!Number.isFinite(holder) || holder <= 0) {
          if (Date.now() + pollMs > deadline) {
            tryReclaimBrokenLock(lockDir);
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
    // 仅当 PID 仍是本进程时释放；读失败不盲删
    const holder = readLockPid(lockDir);
    if (holder === process.pid) {
      const trash = `${lockDir}.release.${process.pid}.${Date.now()}`;
      try {
        renameSync(lockDir, trash);
        rmSync(trash, { recursive: true, force: true });
      } catch {
        // 已被回收则忽略
      }
    }
  }
}
