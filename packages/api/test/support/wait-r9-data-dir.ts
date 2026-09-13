/**
 * R9 矩阵 DATA_DIR 门控：只有父 helper 显式标记才复用其目录。
 * .env / 直跑带进来的 DATA_DIR 一律自建，避免 beforeEach 清库误伤。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 父 isolate 注入的显式标记；缺省或非 1 视为直跑。 */
export const WAIT_R9_PARENT_ENV = 'OAE_WAIT_R9_PARENT';

/** 解析本进程该用的 DATA_DIR；调用方负责写回 process.env。 */
export function resolveWaitR9DataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env[WAIT_R9_PARENT_ENV] === '1' && env.DATA_DIR) return env.DATA_DIR;
  return mkdtempSync(join(tmpdir(), 'oae-wait-r9-'));
}
