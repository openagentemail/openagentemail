/**
 * #212 dist 钉测：stdio/API 产物不得再含测试 mutator 字符串，防回流生产面。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const apiPkg = join(import.meta.dir, '..');
const mcpPkg = join(apiPkg, '..', 'mcp');
/** 生产 mutator 历史符号；任一 dist 命中即红。 */
const MUTATOR = 'setWaitMonotonicNowForTests';

describe('dist has no wait-clock test mutator (#212)', () => {
  test('mcp dist/main.js 与 api dist/*.js 不含 setWaitMonotonicNowForTests', () => {
    const mcpBuild = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: mcpPkg,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (mcpBuild.exitCode !== 0) {
      throw new Error(`mcp build failed:\n${mcpBuild.stderr.toString()}\n${mcpBuild.stdout.toString()}`);
    }
    const mcpMain = join(mcpPkg, 'dist', 'main.js');
    expect(existsSync(mcpMain)).toBe(true);
    expect(readFileSync(mcpMain, 'utf8')).not.toContain(MUTATOR);

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
