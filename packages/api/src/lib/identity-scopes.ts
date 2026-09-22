/**
 * 身份 scope 叶子常量：无服务端 env / config 依赖。
 * MCP stdio 客户端只应拉这份，禁止经 identities.ts 把 parseConfig 打进 bundle。
 */

/**
 * 身份 token 一等支持的 scope。
 * 顺序：read 在前；其后为创建子身份 / 以归属子发信。
 */
export const SUPPORTED_SCOPES = ['read:messages', 'identities:create', 'messages:send'] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];
export const SUPPORTED_SCOPES_SET = new Set<string>(SUPPORTED_SCOPES);

export function isSupportedScope(scope: string): scope is SupportedScope {
  return SUPPORTED_SCOPES_SET.has(scope);
}

export const MAX_SCOPES_COUNT = 10;
export const MAX_SCOPE_LENGTH = 64;

/**
 * Delegation 可授予的 scope 专用白名单（#275 R1 F4）。
 * 与 SUPPORTED_SCOPES 解耦：扩容身份 scope 不得自动进入 delegation。
 */
export const DELEGATION_SCOPES = ['read:messages'] as const;
export type DelegationScope = (typeof DELEGATION_SCOPES)[number];
export const DELEGATION_SCOPES_SET = new Set<string>(DELEGATION_SCOPES);

export function isDelegationScope(scope: string): scope is DelegationScope {
  return DELEGATION_SCOPES_SET.has(scope);
}
