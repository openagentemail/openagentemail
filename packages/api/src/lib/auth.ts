/**
 * Bearer-token auth middleware. Three kinds of tokens:
 *
 *   admin    — keys from the API_KEYS env. Full access: manage identities,
 *              read/send as any address.
 *   identity — per-identity scoped tokens issued by POST /v1/identities
 *              (hashed in the identity store). May only touch its own
 *              address; routes enforce the scope via `getAuth(c)`.
 *   oauth    — opaque access tokens from the P3 Authorization Server.
 *              Always map to identity scope (never admin). Require unexpired
 *              + audience match against our MCP resource URI.
 *
 * All /v1/* routes sit behind this.
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { config } from './config.ts';
import { findIdentity, findIdentityByToken } from './identities.ts';
import { lookupAccessToken } from './oauth-store.ts';
import { resolveResourceUri } from './oauth-url.ts';

export type Auth =
  | { kind: 'admin' }
  | { kind: 'identity'; address: string };

declare module 'hono' {
  interface ContextVariableMap {
    auth: Auth;
  }
}

export type ResolveTokenOptions = {
  /**
   * 期望的 RFC 8707 resource / aud（通常为 `{base}/mcp`）。
   * OAuth access 必须匹配；未提供时回落 MCP_PUBLIC_URL 推导值（若可解析）。
   */
  resource?: string;
  /** 测试可注入时钟。 */
  now?: number;
};

export type ResolveAccessResult =
  | { status: 'ok'; auth: Auth }
  | { status: 'unauthorized' }
  | { status: 'forbidden_audience' };

/**
 * 解析凭证到授权范围（含 OAuth aud/过期细分）。
 * /v1 与 /mcp 应走此入口，避免分叉。
 */
export function resolveAccessToken(
  token: string,
  options: ResolveTokenOptions = {},
): ResolveAccessResult {
  if (config.apiKeys.has(token)) {
    return { status: 'ok', auth: { kind: 'admin' } };
  }

  const identity = findIdentityByToken(token);
  if (identity) {
    return { status: 'ok', auth: { kind: 'identity', address: identity.address } };
  }

  const oauth = lookupAccessToken(token, options.now);
  if (oauth.status === 'missing') {
    return { status: 'unauthorized' };
  }
  if (oauth.status === 'expired') {
    return { status: 'unauthorized' };
  }

  // 安全红线：OAuth 票永远是 identity，永不升格 admin。
  // aud 必须有外部期望值（请求 resource 或 MCP_PUBLIC_URL）；禁止用令牌自带 aud 自洽，
  // 否则 UI session 等无 resource 入口会被 OAuth 票绕过观众校验。
  let expectedResource = options.resource;
  if (!expectedResource) {
    try {
      expectedResource = resolveResourceUri();
    } catch {
      return { status: 'unauthorized' };
    }
  }
  if (oauth.aud !== expectedResource) {
    return { status: 'forbidden_audience' };
  }

  // 身份已删：票作废（与级联吊销互补；防竞态/旧库残留）
  if (!findIdentity(oauth.address)) {
    return { status: 'unauthorized' };
  }

  return {
    status: 'ok',
    auth: { kind: 'identity', address: oauth.address },
  };
}

/**
 * Resolve either supported credential to its authorization scope.
 *
 * Both Bearer auth and the UI session exchange call this function so token
 * rotation/deletion and admin-key semantics cannot drift between entrances.
 * OAuth aud 不匹配时返回 null（与过期/无效同形）；需 403 的调用方请用 resolveAccessToken。
 */
export function resolveToken(
  token: string,
  options: ResolveTokenOptions = {},
): Auth | null {
  const result = resolveAccessToken(token, options);
  return result.status === 'ok' ? result.auth : null;
}

/**
 * Dashboard UI 会话交换专用：只认 admin API_KEYS 与 oa_ identity 票。
 * **永不**查 OAuth access 表——即使 MCP_PUBLIC_URL 已配置、aud 可解析，
 * OAuth 票也不能换浏览器会话（防注入邮件诱导的持久化 UI 入口）。
 */
export function resolveUiSessionToken(token: string): Auth | null {
  if (config.apiKeys.has(token)) return { kind: 'admin' };
  const identity = findIdentityByToken(token);
  return identity ? { kind: 'identity', address: identity.address } : null;
}

export const bearerAuth = createMiddleware(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const origin = new URL(c.req.url).origin;
  let resource: string | undefined;
  try {
    resource = resolveResourceUri(origin);
  } catch {
    resource = undefined;
  }
  const result = resolveAccessToken(token, { resource });
  if (result.status === 'ok') {
    c.set('auth', result.auth);
    await next();
    return;
  }
  if (result.status === 'forbidden_audience') {
    return c.json({ error: 'invalid_audience' }, 403);
  }
  return c.json({ error: 'unauthorized' }, 401);
});

export function getAuth(c: Context): Auth {
  return c.get('auth');
}

/**
 * Check that the caller may act as `address`. Admins may act as anyone;
 * identity tokens only as themselves. Returns the error response to send,
 * or null if allowed.
 */
export function forbidUnlessAddress(c: Context, address: string) {
  const auth = getAuth(c);
  if (auth.kind === 'admin') return null;
  if (auth.address === address.toLowerCase()) return null;
  return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
}
