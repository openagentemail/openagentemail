/**
 * #225：wait-clock 测试 mock 共享 helper。
 * 动态比对真实模块运行时导出键；mock 缺口时报「does not cover」（禁硬编码清单）。
 */
import { mock } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 与生产 wait-clock 品牌类型同形（测试侧本地别名）。 */
type WaitMonotonicMs = number & { readonly __brand: 'WaitMonotonicMs' };

const asWaitMonotonicMs = (n: number): WaitMonotonicMs => n as WaitMonotonicMs;

/** mock 安装后可供用例注入/清除单调钟。 */
export type WaitClockMockControls = {
  /** 注入或清除测试单调钟（闭包状态，非生产导出）。 */
  setWaitMonotonicNowForTests: (fn?: () => number) => void;
};

/**
 * 子进程加载真实 wait-clock，避开本进程 mock.module 拦截。
 * @param realModuleFsPath wait-clock.ts 文件系统路径
 */
export function readRealWaitClockExportKeys(realModuleFsPath: string): string[] {
  const abs = resolve(realModuleFsPath);
  const href = pathToFileURL(abs).href;
  // 独立 bun 进程 import，拿到未被 mock 的运行时导出键
  const script = `
    const m = await import(${JSON.stringify(href)});
    process.stdout.write(JSON.stringify(Object.keys(m).sort()));
  `;
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `failed to probe real wait-clock exports:\n${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
  }
  return JSON.parse(result.stdout.toString()) as string[];
}

/**
 * 断言 mock 导出面覆盖真实模块；缺键则抛「does not cover」。
 */
export function assertWaitClockMockCoversReal(
  mockExports: Record<string, unknown>,
  realModuleFsPath: string,
): void {
  const realKeys = readRealWaitClockExportKeys(realModuleFsPath);
  const mockKeys = new Set(Object.keys(mockExports));
  const missing = realKeys.filter((k) => !mockKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `wait-clock mock does not cover real exports: ${missing.join(', ')}`,
    );
  }
}

/**
 * 构造可注入的 wait-clock mock 导出对象（仅两运行时导出）。
 */
export function createWaitClockMockExports(getInjected: () => (() => number) | undefined): {
  waitMonotonicNow: () => WaitMonotonicMs;
  waitMonotonicDeadlineAfter: (timeoutMs: number) => WaitMonotonicMs;
} {
  return {
    waitMonotonicNow: (): WaitMonotonicMs =>
      asWaitMonotonicMs(getInjected() ? getInjected()!() : performance.now()),
    waitMonotonicDeadlineAfter: (timeoutMs: number): WaitMonotonicMs =>
      asWaitMonotonicMs((getInjected() ? getInjected()!() : performance.now()) + timeoutMs),
  };
}

/**
 * 断言导出面后注册 mock.module，返回注入控件。
 * 使用绝对路径注册，避免 mock.module 相对路径按本 helper 文件解析而漂移。
 * @param realModuleFsPath 真实 wait-clock.ts 路径（绝对或相对均可）
 */
export function installWaitClockMock(realModuleFsPath: string): WaitClockMockControls {
  const absPath = resolve(realModuleFsPath);
  let waitMonoInjected: (() => number) | undefined;
  const mockExports = createWaitClockMockExports(() => waitMonoInjected);
  assertWaitClockMockCoversReal(mockExports, absPath);
  // 绝对路径：api/mcp 两侧 import 说明符不同，解析后落同一文件
  mock.module(absPath, () => mockExports);
  return {
    setWaitMonotonicNowForTests(fn?: () => number) {
      waitMonoInjected = fn;
    },
  };
}
