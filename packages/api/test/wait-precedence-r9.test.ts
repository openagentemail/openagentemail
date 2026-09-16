/**
 * #206 R9 父包装：不 import/mock imap，只复用已有 isolate 运输。
 * 子进程跑 11 组真实 route/core 与动作计数；主进程不得留下 imapflow mock。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runIsolatedChild } from './support/messages-list-rate-isolate.ts';
import { WAIT_R9_PARENT_ENV, resolveWaitR9DataDir } from './support/wait-r9-data-dir.ts';

const MATRIX_FILE = join(import.meta.dir, 'support/wait-precedence-r9-matrix.ts');
/** 子套件含 DNS/截止用例，高于 list-rate 的 3.5s，仍远低于全量腿。 */
const R9_CHILD_TIMEOUT_MS = 20_000;

function childDataDir(out: string): string | undefined {
  return /oae-wait-r9-data-dir=(\S+)/.exec(out)?.[1];
}

/** #223：exit≠0 时 dump 子输出，避免 CI 看不到矩阵哪条挂。 */
function dumpChildIfFailed(
  label: string,
  result: { exitCode: number; timedOut: boolean; stdout: string; stderr: string },
): void {
  if (result.exitCode === 0) return;
  console.error(
    `[r9-parent] ${label} exitCode=${result.exitCode} timedOut=${result.timedOut}`,
  );
  console.error('--- child stdout ---\n' + result.stdout);
  console.error('--- child stderr ---\n' + result.stderr);
}

describe('#206 R9 撤销/断开优先级（隔离子进程）', () => {
  test('R9 矩阵子进程 12/0 且临时目录已回收', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, 'test', MATRIX_FILE],
      timeoutMs: R9_CHILD_TIMEOUT_MS,
      env: { [WAIT_R9_PARENT_ENV]: '1' },
    });
    dumpChildIfFailed('R9 矩阵', result);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const childOut = `${result.stdout}\n${result.stderr}`;
    expect(childOut).toContain('12 pass');
    expect(childOut).toContain('0 fail');
    expect(childDataDir(childOut)).toBe(result.dataDir);
    expect(existsSync(result.dataDir)).toBe(false);
  }, 25_000);

  test('直跑无父标记时不动既有 DATA_DIR', async () => {
    const existing = mkdtempSync(join(tmpdir(), 'oae-r9-dotenv-'));
    writeFileSync(join(existing, 'KEEP'), 'keep');
    writeFileSync(join(existing, 'identities.json'), '["must-keep"]', { mode: 0o600 });
    try {
      // 纯函数负控：无标记不得复用外来目录。
      const resolved = resolveWaitR9DataDir({ DATA_DIR: existing });
      expect(resolved).not.toBe(existing);
      rmSync(resolved, { recursive: true, force: true });

      // 真跑矩阵：.env 式 DATA_DIR 不得被 beforeEach 写成 []。
      const result = await runIsolatedChild({
        argv: [process.execPath, 'test', MATRIX_FILE],
        timeoutMs: R9_CHILD_TIMEOUT_MS,
        env: { DATA_DIR: existing },
      });
      dumpChildIfFailed('直跑 DATA_DIR', result);
      expect(result.exitCode).toBe(0);
      const used = childDataDir(`${result.stdout}\n${result.stderr}`);
      expect(used).toBeTruthy();
      expect(used).not.toBe(existing);
      expect(readFileSync(join(existing, 'KEEP'), 'utf8')).toBe('keep');
      expect(readFileSync(join(existing, 'identities.json'), 'utf8')).toBe('["must-keep"]');
      if (used && used !== result.dataDir) {
        rmSync(used, { recursive: true, force: true });
      }
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  }, 25_000);
});
