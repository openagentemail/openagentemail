/**
 * #226①：dist build 锁——陈旧 PID 回收；并行第二进程等锁。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPidAlive, withDistBuildLock } from './support/dist-build-lock.ts';

describe('#226① dist-build-lock', () => {
  test('陈旧 PID 回收后可重新占锁', () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), 'oae-dist-lock-')), '.dist-build.lock');
    mkdirSync(lockDir);
    // 不可能存活的 PID
    writeFileSync(join(lockDir, 'pid'), '999999999', 'utf8');

    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const saw = withDistBuildLock({ lockDir, timeoutMs: 5_000 }, () => 'held');
      expect(saw).toBe('held');
      expect(warns.some((w) => /stale PID/.test(w))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  test('并行双进程：第二进程等锁后再进入', async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), 'oae-dist-lock-')), '.dist-build.lock');
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    // 子进程脚本：占锁 sleep 200ms，打印耗时（第二进程应明显更长）
    const script = `
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      const start = Date.now();
      withDistBuildLock({ lockDir: ${JSON.stringify(lockDir)}, pollMs: 20, timeoutMs: 15_000 }, () => {
        Bun.sleepSync(200);
      });
      process.stdout.write(String(Date.now() - start));
    `;

    const p1 = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // 确保第一进程先占锁
    await Bun.sleep(40);
    const p2 = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [e1, e2] = await Promise.all([p1.exited, p2.exited]);
    expect(e1).toBe(0);
    expect(e2).toBe(0);
    const t1 = Number(await new Response(p1.stdout).text());
    const t2 = Number(await new Response(p2.stdout).text());
    // 第二进程至少等了第一段持锁，总耗时应明显大于单段 sleep
    expect(t1).toBeGreaterThanOrEqual(180);
    expect(t2).toBeGreaterThanOrEqual(180);
    // 串行证据：两者之和接近两段持锁，且 max 接近 sum（重叠很少）
    expect(Math.max(t1, t2)).toBeGreaterThanOrEqual(350);
  }, 20_000);

  test('压力：多进程交错占锁不得双持（TOCTOU 回归）', async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), 'oae-dist-lock-')), '.dist-build.lock');
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    const markerPath = join(lockDir, '..', 'overlap.marker');
    // 持锁临界区内若见他人已写 marker 则打印 OVERLAP
    const script = `
      import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ lockDir: ${JSON.stringify(lockDir)}, pollMs: 5, timeoutMs: 30_000 }, () => {
        if (existsSync(${JSON.stringify(markerPath)})) {
          process.stdout.write('OVERLAP');
          return;
        }
        writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
        Bun.sleepSync(30);
        const holder = readFileSync(${JSON.stringify(markerPath)}, 'utf8');
        if (holder !== String(process.pid)) process.stdout.write('OVERLAP');
        else process.stdout.write('OK');
        try { unlinkSync(${JSON.stringify(markerPath)}); } catch {}
      });
    `;
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }),
    );
    const exits = await Promise.all(procs.map((p) => p.exited));
    expect(exits.every((e) => e === 0)).toBe(true);
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()));
    expect(outs.every((o) => o === 'OK')).toBe(true);
    expect(outs.some((o) => o.includes('OVERLAP'))).toBe(false);
  }, 60_000);

  test('R2 P1-1：双竞争者同见死 PID，不得双双入临界区', async () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), 'oae-dist-lock-')), '.dist-build.lock');
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    const markerPath = join(lockDir, '..', 'stale-race.marker');
    // 预置死 PID 锁，逼两进程同时走 stale 回收
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), '999999999', 'utf8');

    // 回收前故意 sleep，放大「同见死 PID → 盲 rename」窗口
    const script = `
      import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      // 放大竞争：先自旋一小会再抢
      Bun.sleepSync(20 + Math.floor(Math.random() * 40));
      withDistBuildLock({ lockDir: ${JSON.stringify(lockDir)}, pollMs: 5, timeoutMs: 20_000 }, () => {
        if (existsSync(${JSON.stringify(markerPath)})) {
          process.stdout.write('DOUBLE');
          return;
        }
        writeFileSync(${JSON.stringify(markerPath)}, String(process.pid));
        Bun.sleepSync(80);
        const holder = readFileSync(${JSON.stringify(markerPath)}, 'utf8');
        if (holder !== String(process.pid)) process.stdout.write('DOUBLE');
        else process.stdout.write('SOLO');
        try { unlinkSync(${JSON.stringify(markerPath)}); } catch {}
      });
    `;

    const p1 = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const p2 = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [e1, e2] = await Promise.all([p1.exited, p2.exited]);
    expect(e1).toBe(0);
    expect(e2).toBe(0);
    const o1 = await new Response(p1.stdout).text();
    const o2 = await new Response(p2.stdout).text();
    expect(o1).toBe('SOLO');
    expect(o2).toBe('SOLO');
    expect(o1 + o2).not.toContain('DOUBLE');
  }, 30_000);

  test('R2 P1-2：dist-bundle 与 mutator 并行写 dist 不撞', async () => {
    const apiPkg = join(import.meta.dir, '..');
    const lockDir = join(apiPkg, '.dist-build.lock');
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    // 两子进程：一个模拟 mutator build，一个模拟 dist-bundle rm+build；串行证据=无交错失败
    const mutatorScript = `
      import { existsSync, readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ lockDir: ${JSON.stringify(lockDir)}, pollMs: 20, timeoutMs: 180_000 }, () => {
        const build = Bun.spawnSync(['bun', 'run', 'build'], {
          cwd: ${JSON.stringify(apiPkg)},
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (build.exitCode !== 0) {
          process.stdout.write('FAIL_BUILD');
          process.exit(1);
        }
        const dist = join(${JSON.stringify(apiPkg)}, 'dist');
        if (!existsSync(dist)) { process.stdout.write('FAIL_NODIST'); process.exit(1); }
        for (const name of readdirSync(dist)) {
          if (!name.endsWith('.js')) continue;
          // 读完整文件：若并行半写会抛或读到残缺
          readFileSync(join(dist, name), 'utf8');
        }
        process.stdout.write('MUTATOR_OK');
      });
    `;
    const bundleScript = `
      import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ lockDir: ${JSON.stringify(lockDir)}, pollMs: 20, timeoutMs: 180_000 }, () => {
        const dist = join(${JSON.stringify(apiPkg)}, 'dist');
        rmSync(dist, { recursive: true, force: true });
        const build = Bun.spawnSync(['bun', 'run', 'build'], {
          cwd: ${JSON.stringify(apiPkg)},
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (build.exitCode !== 0) {
          process.stdout.write('FAIL_BUILD');
          process.exit(1);
        }
        if (!existsSync(join(dist, 'main.js'))) { process.stdout.write('FAIL_NOMAIN'); process.exit(1); }
        readFileSync(join(dist, 'main.js'), 'utf8');
        process.stdout.write('BUNDLE_OK');
      });
    `;

    const a = Bun.spawn([process.execPath, '-e', mutatorScript], { stdout: 'pipe', stderr: 'pipe' });
    await Bun.sleep(30);
    const b = Bun.spawn([process.execPath, '-e', bundleScript], { stdout: 'pipe', stderr: 'pipe' });
    const [ea, eb] = await Promise.all([a.exited, b.exited]);
    expect(ea).toBe(0);
    expect(eb).toBe(0);
    expect(await new Response(a.stdout).text()).toBe('MUTATOR_OK');
    expect(await new Response(b.stdout).text()).toBe('BUNDLE_OK');
  }, 300_000);

  test('R3 P1-1：kill EPERM 视为存活，锁不得被回收', () => {
    const lockDir = join(mkdtempSync(join(tmpdir(), 'oae-dist-lock-')), '.dist-build.lock');
    mkdirSync(lockDir);
    // 任意正 PID；mock kill(0)→EPERM 模拟「活但无权」
    writeFileSync(join(lockDir, 'pid'), '424242', 'utf8');

    const realKill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 || signal === undefined) {
        const err = new Error('kill EPERM') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return realKill(pid, signal as NodeJS.Signals | number);
    }) as typeof process.kill;

    try {
      expect(isPidAlive(424242)).toBe(true);
      expect(() =>
        withDistBuildLock({ lockDir, pollMs: 30, timeoutMs: 250 }, () => 'stolen'),
      ).toThrow(/timeout/);
      // 锁仍在且 PID 未变——证明未走 stale 回收
      expect(existsSync(lockDir)).toBe(true);
      expect(readFileSync(join(lockDir, 'pid'), 'utf8').trim()).toBe('424242');
    } finally {
      process.kill = realKill;
    }
  });
});
