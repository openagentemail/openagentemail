/**
 * Bearer-token auth middleware. Two kinds of tokens:
 *
 *   admin    — keys from the API_KEYS env. Full access: manage identities,
 *              read/send as any address.
 *   identity — per-identity scoped tokens issued by POST /v1/identities
 *              (hashed in the identity store). May only touch its own
 *              address; routes enforce the scope via `getAuth(c)`.
 *
 * All /v1/* routes sit behind this.
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { config } from './config.ts';
import { findIdentityByToken } from './identities.ts';

export type Auth =
  | { kind: 'admin' }
  | { kind: 'identity'; address: string };

declare module 'hono' {
  interface ContextVariableMap {
    auth: Auth;
  }
}

export const bearerAuth = createMiddleware(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (config.apiKeys.has(token)) {
    c.set('auth', { kind: 'admin' });
    await next();
    return;
  }
  const identity = findIdentityByToken(token);
  if (identity) {
    c.set('auth', { kind: 'identity', address: identity.address });
    await next();
    return;
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
