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
];

/**
 * Centralized scope policy enforcement middleware for all /v1/* REST routes.
 *
 * Evaluates after bearer authentication:
 * - Admin keys, OAuth tokens, and legacy unscoped identity tokens (scopes === undefined) pass through.
 * - Scoped identity tokens are subject to default-deny scope evaluation.
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
