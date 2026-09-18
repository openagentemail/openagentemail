/**
 * #226①：dist build 锁——陈旧 PID 回收；并行第二进程等锁。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withDistBuildLock } from './support/dist-build-lock.ts';

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
});
