/**
 * #212 dist 钉测（api 半边）：本包产物不得含测试 mutator 字符串。
 * 只 build api——CI 在 api test 阶段尚未 bun install mcp，不可在此拉 mcp build。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const apiPkg = join(import.meta.dir, '..');
/** 生产 mutator 历史符号；任一 dist 命中即红。 */
const MUTATOR = 'setWaitMonotonicNowForTests';

describe('api dist has no wait-clock test mutator (#212)', () => {
  test('api dist/*.js 不含 setWaitMonotonicNowForTests', () => {
    const apiBuild = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: apiPkg,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (apiBuild.exitCode !== 0) {
      throw new Error(`api build failed:\n${apiBuild.stderr.toString()}\n${apiBuild.stdout.toString()}`);
    }
    const apiDist = join(apiPkg, 'dist');
    expect(existsSync(apiDist)).toBe(true);
    for (const name of readdirSync(apiDist)) {
      if (!name.endsWith('.js')) continue;
      const path = join(apiDist, name);
      expect(readFileSync(path, 'utf8'), path).not.toContain(MUTATOR);
    }
  }, 120_000);
});
