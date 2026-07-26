import { Hono } from 'hono';
import { z } from 'zod';
import { createIdentity, listIdentities, LOCALPART_RE } from '../lib/identities.ts';

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  localpart: z.string().regex(LOCALPART_RE, 'invalid localpart').optional(),
});

export const identitiesRoute = new Hono()
  .post('/', async (c) => {
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
      const identity = createIdentity(parsed.data);
      if (!identity) {
        return c.json({ error: 'address_exists' }, 409);
      }
      return c.json(
        { address: identity.address, ...(identity.name ? { name: identity.name } : {}) },
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
    return c.json({ identities: listIdentities() });
  });
