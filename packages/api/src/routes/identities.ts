import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  createIdentity,
  deleteIdentity,
  listIdentities,
  rotateIdentityToken,
  LOCALPART_RE,
} from '../lib/identities.ts';
import { getAuth } from '../lib/auth.ts';

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  localpart: z.string().regex(LOCALPART_RE, 'invalid localpart').optional(),
});

// Identity management is admin-only: identity tokens may not mint, list or
// delete identities (that would let a leaked token escalate sideways).
function requireAdmin(c: Context) {
  if (getAuth(c).kind !== 'admin') {
    return c.json({ error: 'forbidden: admin key required' }, 403);
  }
  return null;
}

export const identitiesRoute = new Hono()
  .post('/', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    try {
      const created = createIdentity(parsed.data);
      if (!created) {
        return c.json({ error: 'address_exists' }, 409);
      }
      const { identity, token } = created;
      return c.json(
        {
          address: identity.address,
          ...(identity.name ? { name: identity.name } : {}),
          // Shown exactly once — store it now. Only its hash persists.
          token,
        },
        201,
      );
    } catch (err) {
      if ((err as Error).message === 'invalid_localpart') {
        return c.json({ error: 'invalid_localpart' }, 400);
      }
      throw err;
    }
  })
  .get('/', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    return c.json({ identities: listIdentities() });
  })
  .post('/:address/token', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const token = rotateIdentityToken(c.req.param('address'));
    if (!token) return c.json({ error: 'not_found' }, 404);
    return c.json({ address: c.req.param('address').toLowerCase(), token });
  })
  .delete('/:address', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    if (!deleteIdentity(c.req.param('address'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ deleted: true });
  });
