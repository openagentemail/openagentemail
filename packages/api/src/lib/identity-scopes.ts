/**
 * 身份 scope 叶子常量：无服务端 env / config 依赖。
 * MCP stdio 客户端只应拉这份，禁止经 identities.ts 把 parseConfig 打进 bundle。
 */

/** 身份 token 一等支持的 scope。 */
export const SUPPORTED_SCOPES = ['read:messages'] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];
export const SUPPORTED_SCOPES_SET = new Set<string>(SUPPORTED_SCOPES);

export function isSupportedScope(scope: string): scope is SupportedScope {
  return SUPPORTED_SCOPES_SET.has(scope);
}

export const MAX_SCOPES_COUNT = 10;
export const MAX_SCOPE_LENGTH = 64;
