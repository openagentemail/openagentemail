/**
 * 跨测试文件隔离。
 * bun test 单进程按文件顺序执行：mock.restore() 不会撤销 mock.module，
 * 且 config 只在首次 import 时读取 MCP_PUBLIC_URL。
 * 泄漏方在 afterAll 里交还真实 imapflow，并按进入文件前的 env 还原 mcpPublicUrl。
 */
import { ImapFlow } from 'imapflow';
import { mock } from 'bun:test';

// 必须在任何 mock.module('imapflow') 之前首次求值；const 拍下真实构造器，避免活绑定被 mock 改写。
const realImapFlow = ImapFlow;

/** 把 imapflow 交还给后续测试文件（已 import 的 imap.ts 会跟上这次覆盖）。 */
export function restoreRealImapFlow(): void {
  mock.module('imapflow', () => ({ ImapFlow: realImapFlow }));
}

/** 本文件期间钉死 config.mcpPublicUrl（config 可能已被更早的文件解析）。 */
export function pinMcpPublicUrl(config: object, url: string): void {
  (config as { mcpPublicUrl?: string }).mcpPublicUrl = url;
}

/**
 * 按进入本文件之前的 MCP_PUBLIC_URL 还原。
 * 首次解析 config 的文件会把当时的 env 烘焙进单例；只删 env 不够。
 */
export function restoreMcpPublicUrl(config: object, envBefore: string | undefined): void {
  const cfg = config as { mcpPublicUrl?: string };
  if (envBefore === undefined || envBefore === '') {
    cfg.mcpPublicUrl = undefined;
    delete process.env.MCP_PUBLIC_URL;
    return;
  }
  process.env.MCP_PUBLIC_URL = envBefore;
  try {
    // 与 config.normalizeUrl 对「无 path」origin 的结果一致：去掉尾斜杠。
    cfg.mcpPublicUrl = new URL(envBefore).href.replace(/\/+$/, '');
  } catch {
    cfg.mcpPublicUrl = undefined;
    delete process.env.MCP_PUBLIC_URL;
  }
}
