/**
 * #212 dist 钉测（mcp 半边）：stdio 产物不得含测试 mutator 字符串。
 * 放在 mcp test——CI 此时已 install mcp 依赖，自 build 确定性成立。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const mcpPkg = join(import.meta.dir, '..');
/** 生产 mutator 历史符号；dist 命中即红。 */
const MUTATOR = 'setWaitMonotonicNowForTests';

describe('mcp dist has no wait-clock test mutator (#212)', () => {
  test('mcp dist/main.js 不含 setWaitMonotonicNowForTests', () => {
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
  }, 120_000);
});
