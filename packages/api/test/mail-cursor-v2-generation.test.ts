/**
 * #144 / 2262 代际矩阵父包装：不 import/mock imap，只复用 143 isolate 运输。
 * 父预算保持 bun 默认 5s；子进程立即 drain，超时 SIGKILL+reap。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  MATRIX_TIMEOUT_MS,
  runIsolatedChild,
} from './support/messages-list-rate-isolate.ts';

const MATRIX_FILE = join(import.meta.dir, 'support/mail-cursor-v2-generation-matrix.ts');
const NEGATIVE_FILE = join(import.meta.dir, 'support/mail-cursor-v2-canon-negative.ts');

describe('mail-cursor-v2 isolate parent', () => {
  test('代际矩阵子进程 10/0 且临时目录已回收', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, 'test', MATRIX_FILE],
      timeoutMs: MATRIX_TIMEOUT_MS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const childOut = `${result.stdout}\n${result.stderr}`;
    expect(childOut).toContain('10 pass');
    expect(childOut).toContain('0 fail');
    expect(existsSync(result.dataDir)).toBe(false);
  });

  test('真实一处改写负控：去掉 BigInt.toString 后前导零合同失败', async () => {
    const result = await runIsolatedChild({
      argv: [process.execPath, NEGATIVE_FILE],
      timeoutMs: MATRIX_TIMEOUT_MS,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(2);
    const childOut = `${result.stdout}\n${result.stderr}`;
    expect(childOut).toContain('NEGATIVE_HIT');
    const negMatch = childOut.match(/^NEG_TEMP=(\S+)/m);
    expect(negMatch).toBeTruthy();
    const negTemp = negMatch![1];
    // 证明泄漏的是负控自己的 oae-canon-neg 目录，且已被 finally 删掉（不是只回收 parent dataDir）。
    expect(negTemp.includes('oae-canon-neg-')).toBe(true);
    expect(negTemp).not.toBe(result.dataDir);
    expect(existsSync(negTemp)).toBe(false);
    expect(existsSync(result.dataDir)).toBe(false);
  });
});
