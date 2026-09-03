import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getAuth } from '../lib/auth.ts';
import { config, normalizeUrl } from '../lib/config.ts';
import { findIdentity, listIdentities, type Identity } from '../lib/identities.ts';
import {
  NotifyError,
  NTFY_REQUEST_MAX_BYTES,
  createNotificationDevice,
  listNotificationDevices,
  revokeNotificationDevice,
  type NotificationDevice,
  type NotifyLevel,
  type NotifyService,
  type NotifyTarget,
  type NotifyTopic,
  notificationService,
} from '../lib/notify.ts';
import {
  DeviceNotFoundError,
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  DeviceRevokeTransientError,
} from '../lib/notification-devices.ts';
import {
  checkNotifyUserLimit,
  releaseNotifyUserLimit,
} from '../lib/ratelimit.ts';

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const notifySchema = z.object({
  target: z.union([
    z.literal('user'),
    z.string().max(320).regex(/^agent:[a-z0-9][a-z0-9._-]{0,62}(?:@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)?$/i),
  ]),
  title: z.string().min(1).max(256),
  message: z.string().min(1).max(4_000),
  level: z.enum(['urgent', 'normal', 'low']).default('normal'),
  tags: z.array(z.string().min(1).max(64)).max(5).optional(),
}).strict();

const historySchema = z.object({
  topic: z.string().min(1).max(80),
  since: z.string().min(1).max(64).optional(),
});

const deviceSchema = z.object({
  // This must match the active server config. It prevents handing out a phone
  // reader before NOTIFY_PUBLIC_URL has been made public and the stack restarted.
  publicUrl: z.string().url(),
  displayName: z.string().max(80).optional(),
}).strict();

/** 与 routes/ui.ts#toNotifyTopic 必须保持同一口径（Bearer 入口）；改则两边同步。 */
function toTopic(value: string): NotifyTopic | null {
  if (value === 'self' || value === 'user-alerts' || value === 'user-low') return value;
  if (!value.startsWith('agent:')) return null;
  const agent = value.slice('agent:'.length);
  return AGENT_NAME_RE.test(agent) ? `agent:${agent}` : null;
}

function notificationError(c: Context, err: unknown) {
  if (err instanceof DeviceNotFoundError) return c.json({ error: err.code }, 404);
  if (err instanceof DeviceRegistryCorruptError) return c.json({ error: err.code }, 500);
  if (err instanceof DeviceRegistryPersistError) return c.json({ error: err.code }, 502);
  if (err instanceof DeviceRevokeTransientError) return c.json({ error: err.code }, 502);
  if (!(err instanceof NotifyError)) throw err;
  if (err.code === 'notifications_disabled' || err.code === 'notifications_unconfigured') {
    return c.json(
      err.details?.message ? { error: err.code, message: err.details.message } : { error: err.code },
      503,
    );
  }
  if (err.code === 'unknown_agent') return c.json({ error: err.code }, 404);
  if (err.code === 'device_registry_unavailable') return c.json({ error: err.code }, 502);
  if (err.code === 'message_too_large') {
    // 413: payload exceeds the ntfy request budget after framing (F76).
    return c.json(
      {
        error: err.code,
        maxRequestBytes: err.details?.maxRequestBytes ?? NTFY_REQUEST_MAX_BYTES,
        availableMessageBytes: err.details?.availableMessageBytes ?? 0,
      },
      413,
    );
  }
  return c.json({ error: err.code }, 502);
}

function ownAgentTopic(c: Context): NotifyTopic | null {
  const auth = getAuth(c);
  if (auth.kind !== 'identity') return null;
  const localpart = auth.address.split('@')[0];
  return localpart ? `agent:${localpart}` : null;
}

/** Root-level user alerts require an explicit per-identity grant. */
function requireUserNotifyPermission(c: Context, find = findIdentity) {
  const auth = getAuth(c);
  if (auth.kind === 'admin') return { actor: 'admin' };
  if (!find(auth.address)?.canNotifyUser) {
    return c.json({ error: 'forbidden: can_notify_user required' }, 403);
  }
  return { actor: auth.address };
}

export type NotifyRouteOptions = {
  service?: NotifyService;
  findIdentity?: typeof findIdentity;
  listIdentities?: typeof listIdentities;
  createDevice?: (options?: { displayName?: string }) => Promise<NotificationDevice>;
  /** Test seam; production always uses the active ntfy configuration. */
  publicUrl?: string;
};

export function createNotifyRoutes(options: NotifyRouteOptions = {}) {
  const service = options.service ?? notificationService();
  const find = options.findIdentity ?? findIdentity;
  const list = options.listIdentities ?? listIdentities;
  const createDevice = options.createDevice ?? createNotificationDevice;
  // Same normalizer as config (pathname trailing slash, not string-end slash).
  const activePublicUrl = normalizeUrl(options.publicUrl ?? config.ntfy.publicUrl);

  return new Hono()
    .post('/', async (c) => {
      c.header('Cache-Control', 'no-store');
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = notifySchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      const input = parsed.data as { target: NotifyTarget; title: string; message: string; level: NotifyLevel; tags?: string[] };

      let addressed: Identity | undefined;
      if (input.target.startsWith('agent:')) {
        const agentTarget = input.target.slice('agent:'.length).trim().toLowerCase();
        const auth = getAuth(c);

        if (auth.kind === 'identity') {
          // Identity-token scope check happens before ambiguity resolution.
          // An identity token is strictly scoped to itself.
          const callerAddress = auth.address.toLowerCase();
          const callerLocalpart = callerAddress.split('@')[0];
          if (agentTarget.includes('@')) {
            if (agentTarget !== callerAddress) {
              return c.json({ error: 'forbidden: token is scoped to another agent' }, 403);
            }
            addressed = find(agentTarget);
            if (!addressed) return c.json({ error: 'not_found' }, 404);
          } else {
            if (agentTarget !== callerLocalpart) {
              return c.json({ error: 'forbidden: token is scoped to another agent' }, 403);
            }
            const matches = list().filter(
              (i) => i.address.split('@')[0].toLowerCase() === agentTarget,
            );
            // Non-admin callers unify not-found and ambiguous outcomes to a single 404
            if (matches.length !== 1 || matches[0].address.toLowerCase() !== callerAddress) {
              return c.json({ error: 'not_found' }, 404);
            }
            addressed = matches[0];
          }
        } else {
          // Admin caller: full ambiguity resolution with candidate domains list
          if (agentTarget.includes('@')) {
            addressed = find(agentTarget);
            if (!addressed) return c.json({ error: 'not_found' }, 404);
          } else {
            const matches = list().filter(
              (i) => i.address.split('@')[0].toLowerCase() === agentTarget,
            );
            if (matches.length === 0) return c.json({ error: 'not_found' }, 404);
            if (matches.length > 1) {
              const domains = matches.map((m) => m.address.split('@')[1].toLowerCase());
              return c.json(
                {
                  error: 'ambiguous_agent',
                  message: `Agent localpart is ambiguous across multiple domains: ${domains.join(', ')}`,
                  domains,
                },
                400,
              );
            }
            addressed = matches[0];
          }
        }
      }

      let reservation: number | undefined;
      let actor: string | undefined;
      if (input.target === 'user') {
        const allowed = requireUserNotifyPermission(c, find);
        if (allowed instanceof Response) return allowed;
        actor = allowed.actor;
        const limit = checkNotifyUserLimit(actor, config.ntfy.notifyRateLimit);
        if (!limit.allowed) {
          return c.json(
            { error: 'notify_rate_limited', limit: config.ntfy.notifyRateLimit, retryAfterSec: limit.retryAfterSec },
            429,
          );
        }
        reservation = limit.reservation;
      }

      try {
        const agentLocalpart = addressed ? addressed.address.split('@')[0] : undefined;
        const publishTarget: NotifyTarget =
          input.target === 'user' ? 'user' : (`agent:${agentLocalpart}` as const);
        return c.json(
          await service.publish({
            ...input,
            target: publishTarget,
            source: 'manual',
            logicalChannel:
              input.target === 'user'
                ? input.level === 'low'
                  ? 'user-low'
                  : 'user-alerts'
                : (`agent:${agentLocalpart}` as const),
            sensitive: false,
            ...(addressed ? { identityAddress: addressed.address } : {}),
          }),
          200,
        );
      } catch (err) {
        // A local transport failure must not let a caller burn the alert budget.
        if (actor) releaseNotifyUserLimit(actor, reservation);
        return notificationError(c, err);
      }
    })
    .post('/devices', async (c) => {
      if (getAuth(c).kind !== 'admin') {
        return c.json({ error: 'forbidden: admin key required' }, 403);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = deviceSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      let requestedPublicUrl: URL;
      try {
        requestedPublicUrl = new URL(parsed.data.publicUrl);
      } catch {
        return c.json({ error: 'invalid_request' }, 400);
      }
      if (requestedPublicUrl.protocol !== 'https:') {
        return c.json({ error: 'invalid_request: publicUrl must use https' }, 400);
      }
      if (normalizeUrl(parsed.data.publicUrl) !== activePublicUrl) {
        return c.json({ error: 'notify_public_url_mismatch: set NOTIFY_PUBLIC_URL and restart the stack first' }, 409);
      }
      try {
        const created = await createDevice({ displayName: parsed.data.displayName });
        c.header('Cache-Control', 'no-store');
        return c.json(created, 201);
      } catch (err) {
        return notificationError(c, err);
      }
    })
    .get('/devices', async (c) => {
      if (getAuth(c).kind !== 'admin') {
        return c.json({ error: 'forbidden: admin key required' }, 403);
      }
      try {
        c.header('Cache-Control', 'no-store');
        return c.json({ devices: await listNotificationDevices() });
      } catch (err) {
        return notificationError(c, err);
      }
    })
    .delete('/devices/:id', async (c) => {
      if (getAuth(c).kind !== 'admin') {
        return c.json({ error: 'forbidden: admin key required' }, 403);
      }
      const id = c.req.param('id');
      if (!id || !id.startsWith('dev_') || id.length > 64) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      try {
        await revokeNotificationDevice(id);
        return c.body(null, 204);
      } catch (err) {
        return notificationError(c, err);
      }
    })
    .get('/messages', async (c) => {
      const parsed = historySchema.safeParse(c.req.query());
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      let topic = toTopic(parsed.data.topic);
      if (!topic) return c.json({ error: 'invalid_request' }, 400);

      const auth = getAuth(c);
      let identityAddress: string | undefined;
      if (auth.kind === 'identity') {
        const own = ownAgentTopic(c);
        if (!own) return c.json({ error: 'forbidden' }, 403);
        // This is an authorization boundary, not a client-side convenience:
        // an identity cannot use history to inspect user alerts or another
        // agent's topic, even when it guesses the logical topic name.
        if (topic === 'self') topic = own;
        if (topic !== own) {
          return c.json({ error: 'forbidden: token is scoped to another notification topic' }, 403);
        }
        identityAddress = auth.address;
      } else if (topic === 'self') {
        return c.json({ error: 'invalid_request: admin must choose a topic' }, 400);
      }

      try {
        return c.json({ messages: await service.messages(topic, identityAddress, parsed.data.since) });
      } catch (err) {
        return notificationError(c, err);
      }
    })
    .post('/verify', async (c) => {
      const allowed = requireUserNotifyPermission(c, find);
      if (allowed instanceof Response) return allowed;
      const limit = checkNotifyUserLimit(allowed.actor, config.ntfy.notifyRateLimit);
      if (!limit.allowed) {
        return c.json(
          { error: 'notify_rate_limited', limit: config.ntfy.notifyRateLimit, retryAfterSec: limit.retryAfterSec },
          429,
        );
      }
      try {
        return c.json(await service.verify());
      } catch (err) {
        releaseNotifyUserLimit(allowed.actor, limit.reservation);
        return notificationError(c, err);
      }
    });
}

export const notifyRoute = createNotifyRoutes();
