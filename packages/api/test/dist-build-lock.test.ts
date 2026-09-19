/**
 * #272：dist-build-lock 端口锁负控——双进程争锁 / kill -9 即释放 / 无 stale 概念。
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DIST_BUILD_LOCK_PORT,
  classifyPortAcquireState,
  withDistBuildLock,
} from './support/dist-build-lock.ts';

/** 负控用高位隔离端口，避免与包默认 43301 及并行套件撞车。 */
function allocTestPort(): number {
  // 43310–43399：测试专用段
  return 43310 + (process.pid % 80);
}

describe('#272 dist-build-lock port lock', () => {
  test('并行双进程：第二进程等锁后再进入', async () => {
    const port = allocTestPort();
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    const script = `
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      const start = Date.now();
      withDistBuildLock({ port: ${port}, pollMs: 20, timeoutMs: 15_000 }, () => {
        Bun.sleepSync(200);
      });
      process.stdout.write(String(Date.now() - start));
    `;

    const p1 = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
    expect(t1).toBeGreaterThanOrEqual(180);
    expect(t2).toBeGreaterThanOrEqual(180);
    expect(Math.max(t1, t2)).toBeGreaterThanOrEqual(350);
  }, 20_000);

  test('压力：多进程交错占锁不得双持', async () => {
    const port = allocTestPort() + 1;
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    // 崩溃残留 marker 会使下次全员 existsSync→OVERLAP；启动前清 + finally 再清
    const { mkdtempSync, unlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const markerDir = mkdtempSync(join(tmpdir(), `dist-lock-overlap-${port}-`));
    const markerPath = join(markerDir, 'overlap.marker');
    try {
      try {
        unlinkSync(markerPath);
      } catch {
        // ignore
      }
      const script = `
      import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ port: ${port}, pollMs: 5, timeoutMs: 30_000 }, () => {
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
    } finally {
      try {
        unlinkSync(markerPath);
      } catch {
        // ignore
      }
      try {
        rmSync(markerDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }, 60_000);

  test('持锁进程 kill -9 后锁即释放（无 stale 回收）', async () => {
    const port = allocTestPort() + 2;
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    const readyPath = join(import.meta.dir, `tmp-held-${port}.ready`);
    try {
      const { unlinkSync } = await import('node:fs');
      try {
        unlinkSync(readyPath);
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    // 子进程占锁后写 ready 标记并挂起，等父进程 kill -9
    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        `
          import { writeFileSync } from 'node:fs';
          import { withDistBuildLock } from ${JSON.stringify(helperHref)};
          withDistBuildLock({ port: ${port}, timeoutMs: 60_000 }, () => {
            writeFileSync(${JSON.stringify(readyPath)}, '1');
            Bun.sleepSync(60_000);
          });
        `,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const { existsSync } = await import('node:fs');
    const started = Date.now();
    while (!existsSync(readyPath) && Date.now() - started < 5_000) {
      await Bun.sleep(20);
    }
    expect(existsSync(readyPath)).toBe(true);

    holder.kill(9);
    await holder.exited;

    // kill -9 后立即可获锁（无 stale PID 层）
    const acquired = withDistBuildLock({ port, timeoutMs: 5_000 }, () => 'ok');
    expect(acquired).toBe('ok');
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(readyPath);
    } catch {
      // ignore
    }
  }, 20_000);

  test('包默认端口钉死为 api=43301（与 mcp=43302 分立）', () => {
    expect(DIST_BUILD_LOCK_PORT).toBe(43301);
  });

  test('R2：慢报到 state=0 / busy=2 均 classify→retry（不抛），fatal 才抛', () => {
    // 直接单测 v=0 路径：交上层 withDistBuildLock 180s 轮询，不得在 tryAcquire 内 throw
    expect(classifyPortAcquireState(0)).toBe('retry');
    expect(classifyPortAcquireState(2)).toBe('retry');
    expect(classifyPortAcquireState(1)).toBe('held');
    expect(classifyPortAcquireState(3)).toBe('fatal');
    expect(classifyPortAcquireState(-1)).toBe('fatal');
  });

  test('R2 P1-2：dist-bundle 与 mutator 并行写 dist 不撞', async () => {
    const apiPkg = join(import.meta.dir, '..');
    const helperHref = pathToFileURL(
      join(import.meta.dir, 'support/dist-build-lock.ts'),
    ).href;
    const mutatorScript = `
      import { existsSync, readdirSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ pollMs: 20, timeoutMs: 180_000 }, () => {
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
          readFileSync(join(dist, name), 'utf8');
        }
        process.stdout.write('MUTATOR_OK');
      });
    `;
    const bundleScript = `
      import { existsSync, rmSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { withDistBuildLock } from ${JSON.stringify(helperHref)};
      withDistBuildLock({ pollMs: 20, timeoutMs: 180_000 }, () => {
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
});
