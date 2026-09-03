import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  createIdentity,
  deleteIdentity,
  findIdentity,
  listIdentities,
  rotateIdentityToken,
  resolvePushContentTier,
  setIdentityPushContentTier,
  validateScopesInput,
  LOCALPART_RE,
  PUSH_TIER3_WARNING,
  type Identity,
  type PushContentTier,
} from '../lib/identities.ts';
import { NotifyError, provisionIdentityNotifications } from '../lib/notify.ts';
import { getAuth } from '../lib/auth.ts';

const createSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  localpart: z.string().regex(LOCALPART_RE, 'invalid localpart').optional(),
  // This is intentionally opt-in and admin-only: it authorizes an identity
  // to interrupt the human notification channel.
  canNotifyUser: z.boolean().optional(),
  scopes: z.unknown().optional(),
}).strict();

const pushTierSchema = z
  .object({
    pushContentTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    // Tier 3 ships body/OTP off-box via ntfy; require an explicit ack.
    confirm_risk: z.boolean().optional(),
  })
  .strict();

const rotateTokenSchema = z
  .object({
    scopes: z.unknown(),
  })
  .strict();

// Identity management is admin-only: identity tokens may not mint, list or
// delete identities (that would let a leaked token escalate sideways).
function requireAdmin(c: Context) {
  if (getAuth(c).kind !== 'admin') {
    return c.json({ error: 'forbidden: admin key required' }, 403);
  }
  return null;
}

function pushTierResponse(address: string, tier: PushContentTier) {
  return {
    address,
    pushContentTier: tier,
    ...(tier === 3 ? { warning: PUSH_TIER3_WARNING } : {}),
  };
}

function publicIdentity(identity: Identity) {
  const tier = resolvePushContentTier(identity);
  return {
    address: identity.address,
    ...(identity.name ? { name: identity.name } : {}),
    createdAt: identity.createdAt,
    ...(identity.canNotifyUser ? { canNotifyUser: true } : {}),
    pushContentTier: tier,
    ...(tier === 3 ? { pushContentTierWarning: PUSH_TIER3_WARNING } : {}),
    ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
  };
}

export const identitiesRoute = new Hono()
  .post('/', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    const parsed = createSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    let requestedScopes: string[] | undefined = undefined;
    if (body && typeof body === 'object' && 'scopes' in body) {
      const validated = validateScopesInput((body as Record<string, unknown>).scopes);
      if (!validated.ok) {
        return c.json({ error: validated.error, details: validated.details }, 400);
      }
      requestedScopes = validated.scopes;
    }
    try {
      const created = createIdentity({
        name: parsed.data.name,
        localpart: parsed.data.localpart,
        canNotifyUser: parsed.data.canNotifyUser,
        scopes: requestedScopes,
      });
      if (!created) {
        return c.json({ error: 'address_exists' }, 409);
      }
      const { identity, token } = created;
      try {
        await provisionIdentityNotifications(identity);
      } catch (err) {
        // Do not hand out a usable mail identity if its promised ntfy reader
        // could not be created in the same live stack.
        deleteIdentity(identity.address);
        if (err instanceof NotifyError) {
          return c.json({ error: err.code }, 503);
        }
        throw err;
      }
      return c.json(
        {
          address: identity.address,
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.canNotifyUser ? { canNotifyUser: true } : {}),
          pushContentTier: resolvePushContentTier(identity),
          ...(identity.scopes !== undefined ? { scopes: identity.scopes } : {}),
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
    return c.json({
      identities: listIdentities().map((identity) => publicIdentity(identity)),
    });
  })
  .get('/:address/push-tier', (c) => {
    const address = c.req.param('address').toLowerCase();
    const auth = getAuth(c);
    // Identity tokens may read their own tier; only admins may read others.
    if (auth.kind === 'identity' && auth.address !== address) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }
    const identity = findIdentity(address);
    if (!identity) return c.json({ error: 'not_found' }, 404);
    return c.json(pushTierResponse(address, resolvePushContentTier(identity)));
  })
  .put('/:address/push-tier', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = pushTierSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const { pushContentTier: tier, confirm_risk: confirmRisk } = parsed.data;
    if (tier === 3 && confirmRisk !== true) {
      return c.json(
        {
          error: 'confirm_risk_required',
          message: PUSH_TIER3_WARNING,
        },
        400,
      );
    }
    const updated = setIdentityPushContentTier(c.req.param('address'), tier);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(pushTierResponse(updated.address, resolvePushContentTier(updated)));
  })
  .post('/:address/token', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    const address = c.req.param('address').toLowerCase();
    const existing = findIdentity(address);
    if (!existing) return c.json({ error: 'not_found' }, 404);

    // A bodyless REST rotation is the explicit compatibility escape hatch
    // back to a legacy full-permission token. Internal callers that omit the
    // second argument preserve scopes instead.
    let requestedScopes: string[] | null = null;
    const text = await c.req.text();
    if (text.trim().length > 0) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = rotateTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      }
      const validated = validateScopesInput(parsed.data.scopes);
      if (!validated.ok) {
        return c.json({ error: validated.error, details: validated.details }, 400);
      }
      requestedScopes = validated.scopes;
    }

    const token = rotateIdentityToken(address, requestedScopes);
    if (!token) return c.json({ error: 'not_found' }, 404);
    const updated = findIdentity(address);
    return c.json({
      address,
      token,
      ...(updated?.scopes !== undefined ? { scopes: updated.scopes } : {}),
    });
  })
  .delete('/:address', (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;
    if (!deleteIdentity(c.req.param('address'))) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ deleted: true });
  });
