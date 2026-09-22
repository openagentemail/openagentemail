import { createMiddleware } from 'hono/factory';
import { isSupportedScope, type SupportedScope } from './identities.ts';

export interface OperationPolicy {
  readonly id: string;
  readonly requiredScope: SupportedScope;
  matches(method: string, path: string): boolean;
}

/**
 * Centralized operation policy table for scoped identity tokens.
 *
 * Scoped tokens are subtractive and default-deny: only operations explicitly
 * listed here can be granted by their required scope. All other endpoints and
 * unlisted methods are denied 403 for any scoped token.
 */
export const OPERATION_POLICIES: readonly OperationPolicy[] = [
  {
    id: 'messages:list',
    requiredScope: 'read:messages',
    matches: (method, path) => method === 'GET' && path === '/v1/messages',
  },
  {
    id: 'messages:wait',
    requiredScope: 'read:messages',
    matches: (method, path) => method === 'POST' && path === '/v1/messages/wait',
  },
  {
    id: 'messages:get',
    requiredScope: 'read:messages',
    matches: (method, path) => method === 'GET' && /^\/v1\/messages\/[^/]+$/.test(path),
  },
  {
    id: 'delegations:list',
    requiredScope: 'read:messages',
    matches: (method, path) => method === 'GET' && path === '/v1/delegations',
  },
  {
    id: 'delegations:get',
    requiredScope: 'read:messages',
    matches: (method, path) => method === 'GET' && /^\/v1\/delegations\/[^/]+$/.test(path),
  },
  // #275：scoped 父凭据可创建归属子身份（单层；路由层再强制子⊆父与白名单）
  {
    id: 'identities:create',
    requiredScope: 'identities:create',
    matches: (method, path) => method === 'POST' && path === '/v1/identities',
  },
  // #275：scoped 凭据可对自身或归属子身份发信（路由层再校验归属）
  {
    id: 'messages:send',
    requiredScope: 'messages:send',
    matches: (method, path) => method === 'POST' && path === '/v1/send',
  },
];

// Note on future expansion: If SUPPORTED_SCOPES is extended beyond 'read:messages',
// audit all forbidUnlessMailboxAccess call sites to ensure delegation remains strictly read-only.
//
// #275 scopes（追加，不改既有 read 语义）：
// - identities:create → POST /v1/identities（非 admin 创建归属子；删/rotate/push-tier 仍 admin-only）
// - messages:send → POST /v1/send（自身或 parentIdentity 归属的子 from）

/**
 * Centralized scope policy enforcement middleware for all /v1/* REST routes.
 *
 * Evaluates after bearer authentication:
 * - Admin keys and legacy unscoped identity/OAuth tokens (scopes === undefined) pass through.
 * - Scoped identity and OAuth tokens are subject to default-deny scope evaluation.
 * - If stored scope metadata contains any unknown/unsupported scope, fails closed (403) on all routes.
 * - If the operation is not granted by the token's scopes, rejects with 403 forbidden: insufficient_scope.
 */
export const scopePolicyMiddleware = createMiddleware(async (c, next) => {
  const auth = c.get('auth');
  if (!auth || auth.kind !== 'identity' || auth.scopes === undefined) {
    await next();
    return;
  }

  // Fail closed if any stored scope is unknown or unsupported
  const hasUnsupportedScope = auth.scopes.some((scope) => !isSupportedScope(scope));
  if (hasUnsupportedScope) {
    return c.json({ error: 'forbidden: insufficient_scope' }, 403);
  }

  const method = c.req.method.toUpperCase();
  const path = c.req.path.replace(/\/+$/, '') || '/';

  const matchedPolicy = OPERATION_POLICIES.find((policy) => policy.matches(method, path));
  if (!matchedPolicy) {
    // Default-deny: endpoint has no scope granting it
    return c.json({ error: 'forbidden: insufficient_scope' }, 403);
  }

  if (!auth.scopes.includes(matchedPolicy.requiredScope)) {
    return c.json({ error: 'forbidden: insufficient_scope' }, 403);
  }

  await next();
});
