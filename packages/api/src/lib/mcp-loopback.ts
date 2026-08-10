/**
 * /mcp → /v1 进程内回环的公共 base 上下文。
 * 用 AsyncLocalStorage 传递「外部请求 origin / MCP_PUBLIC_URL」，
 * 让 /v1 bearerAuth 的 c.req.url.origin 与 OAuth aud 同一条规则推导。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<string>();

/** 当前 MCP 工具回环应使用的绝对 base（无尾斜杠）。 */
export function getMcpLoopbackBase(): string | undefined {
  return store.getStore();
}

/** 在 publicBase 上下文中执行（POST /mcp 包裹工具调度）。 */
export function runWithMcpLoopbackBase<T>(publicBase: string, fn: () => T): T {
  return store.run(publicBase.replace(/\/+$/, ''), fn);
}
