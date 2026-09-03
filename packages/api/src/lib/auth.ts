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

import { createHash, timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { config } from './config.ts';
import { findIdentity, findIdentityByToken, findIdentityByTokenHash } from './identities.ts';
import { getGrant, lookupAccessToken } from './oauth-store.ts';
import { resolveResourceUri } from './oauth-url.ts';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 常量时间比较两个 hex/字符串哈希（长度不同直接 false）。 */
function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type Auth =
  | { kind: 'admin' }
  | { kind: 'identity'; address: string; scopes?: readonly string[] };

/**
 * /mcp 审计与限量用的窄路身份（与 Auth 解耦：/v1 仍只读 auth，行为不变）。
 * - admin → 标 admin（attribution 记录；REST actor 债另案）
 * - oa_ identity → address
 * - OAuth access → clientId + grantId + address
 */
export type TokenAttribution =
  | { kind: 'admin' }
  | { kind: 'identity'; address: string }
  | { kind: 'oauth'; address: string; grantId: string; clientId: string };

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
  | { status: 'ok'; auth: Auth; attribution: TokenAttribution }
  | { status: 'unauthorized' }
  | { status: 'forbidden_audience' };

/**
 * 解析凭证到授权范围（含 OAuth aud/过期细分）。
 * /v1 与 /mcp 应走此入口，避免分叉。
 * attribution 仅供 /mcp 审计/分层；/v1 继续只用 auth。
 */
export function resolveAccessToken(
  token: string,
  options: ResolveTokenOptions = {},
): ResolveAccessResult {
  if (config.apiKeys.has(token)) {
    return {
      status: 'ok',
      auth: { kind: 'admin' },
      attribution: { kind: 'admin' },
    };
  }

  let identity: ReturnType<typeof findIdentityByToken>;
  try {
    identity = findIdentityByToken(token);
  } catch {
    identity = undefined;
  }
  if (identity) {
    return {
      status: 'ok',
      auth: {
        kind: 'identity',
        address: identity.address,
        ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
      },
      attribution: { kind: 'identity', address: identity.address },
    };
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
  // 读库抛错时 fail-closed 拒认（401），不回退到无 scope 全权票
  let oauthIdentity: ReturnType<typeof findIdentity>;
  try {
    oauthIdentity = findIdentity(oauth.address);
  } catch {
    return { status: 'unauthorized' };
  }
  if (!oauthIdentity) {
    return { status: 'unauthorized' };
  }

  const grant = getGrant(oauth.grantId);
  // grant 缺失时 lookupAccessToken 已当 missing；此处防御性回落
  const clientId = grant?.clientId ?? 'unknown';

  return {
    status: 'ok',
    // /v1 行为：仍是 identity scope，不含 grant 字段；继承身份当前落盘的 scopes
    auth: {
      kind: 'identity',
      address: oauth.address,
      ...(oauthIdentity.scopes !== undefined ? { scopes: oauthIdentity.scopes } : {}),
    },
    attribution: {
      kind: 'oauth',
      address: oauth.address,
      grantId: oauth.grantId,
      clientId,
    },
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
 * Dashboard UI session exchange: recognizes only admin API_KEYS and unscoped oa_ identity tokens.
 * Scoped tokens are rejected from UI session creation to prevent creating unrestricted UI sessions.
 * Never checks the OAuth access table.
 */
export function resolveUiSessionToken(token: string): Auth | null {
  if (config.apiKeys.has(token)) return { kind: 'admin' };
  const identity = findIdentityByToken(token);
  if (!identity || identity.scopes !== undefined) return null;
  return { kind: 'identity', address: identity.address };
}

/**
 * UI session persistence path: resolves principal by tokenHash only.
 * Scoped identity tokens are rejected from UI session hash resolution.
 */
export function resolveUiSessionTokenByHash(tokenHash: string): Auth | null {
  for (const key of config.apiKeys) {
    if (hashEquals(sha256Hex(key), tokenHash)) return { kind: 'admin' };
  }
  const identity = findIdentityByTokenHash(tokenHash);
  if (!identity || identity.scopes !== undefined) return null;
  return { kind: 'identity', address: identity.address };
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
