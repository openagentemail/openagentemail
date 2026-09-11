/**
 * 列表限速父包装：不导入 app/config/imap，只拉起 support 子进程并证明回收。
 */
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  MATRIX_FILE,
  MATRIX_TIMEOUT_MS,
  PROBE_FILE,
  PROBE_TIMEOUT_MS,
  STALL_FILE,
  STALL_PARENT_BUDGET_MS,
  VERBOSE_BYTES_PER_STREAM,
  VERBOSE_FILE,
  VERBOSE_TIMEOUT_MS,
  runIsolatedChild,
} from './support/messages-list-rate-isolate.ts';

describe('list-rate isolate parent', () => {
  test('list-rate isolate: 矩阵子进程 16/0 且临时目录已回收', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, 'test', MATRIX_FILE],
      timeoutMs: MATRIX_TIMEOUT_MS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const childOut = `${result.stdout}\n${result.stderr}`;
    expect(childOut).toContain('16 pass');
    expect(childOut).toContain('0 fail');
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: resetRateLimits 现会清列表桶', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, PROBE_FILE],
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const line = result.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
    const report = JSON.parse(line) as {
      afterFillAllowed: boolean;
      sizeAfterFill: number;
      sizeAfterCommonReset: number;
      afterCommonResetAllowed: boolean;
      commonResetClearsList: boolean;
    };
    expect(report.afterFillAllowed).toBe(false);
    expect(report.sizeAfterFill).toBe(1);
    expect(report.sizeAfterCommonReset).toBe(0);
    expect(report.afterCommonResetAllowed).toBe(true);
    expect(report.commonResetClearsList).toBe(true);
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: 超时 SIGKILL 并 reap，再进入下一用例', async () => {
    const started = Date.now();
    const result = await runIsolatedChild({
      argv: [process.execPath, STALL_FILE],
      timeoutMs: STALL_PARENT_BUDGET_MS,
      env: { LIST_RATE_STALL_MS: '10000' },
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.reaped).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: 超管道容量立即 drain 且正常退出', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, VERBOSE_FILE],
      timeoutMs: VERBOSE_TIMEOUT_MS,
      env: { LIST_RATE_VERBOSE_BYTES: String(VERBOSE_BYTES_PER_STREAM) },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.includes('VERBOSE_OK')).toBe(true);
    expect(result.stderr.includes('VERBOSE_ERR_OK')).toBe(true);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    expect(result.stderr.length).toBeGreaterThan(65_536);
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('list-rate isolate: 非零退出原样上浮', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, '-e', 'process.exit(7)'],
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(existsSync(result.dataDir)).toBe(false);
  });
});
