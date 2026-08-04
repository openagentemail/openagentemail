import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getAuth } from '../lib/auth.ts';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import {
  NotifyError,
  createNotificationDevice,
  type NotificationDevice,
  type NotifyLevel,
  type NotifyService,
  type NotifyTarget,
  type NotifyTopic,
  notificationService,
} from '../lib/notify.ts';
import {
  checkNotifyUserLimit,
  releaseNotifyUserLimit,
} from '../lib/ratelimit.ts';

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const notifySchema = z.object({
  target: z.union([z.literal('user'), z.string().regex(/^agent:[a-z0-9][a-z0-9._-]{0,62}$/)]),
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
}).strict();

function toTopic(value: string): NotifyTopic | null {
  if (value === 'self' || value === 'user-alerts' || value === 'user-low') return value;
  if (!value.startsWith('agent:')) return null;
  const agent = value.slice('agent:'.length);
  return AGENT_NAME_RE.test(agent) ? `agent:${agent}` : null;
}

function notificationError(c: Context, err: unknown) {
  if (!(err instanceof NotifyError)) throw err;
  if (err.code === 'notifications_disabled' || err.code === 'notifications_unconfigured') {
    return c.json({ error: err.code }, 503);
  }
  if (err.code === 'unknown_agent') return c.json({ error: err.code }, 404);
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
  createDevice?: () => Promise<NotificationDevice>;
  /** Test seam; production always uses the active ntfy configuration. */
  publicUrl?: string;
};

export function createNotifyRoutes(options: NotifyRouteOptions = {}) {
  const service = options.service ?? notificationService();
  const find = options.findIdentity ?? findIdentity;
  const createDevice = options.createDevice ?? createNotificationDevice;
  const activePublicUrl = options.publicUrl ?? config.ntfy.publicUrl;

  return new Hono()
    .post('/', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const parsed = notifySchema.safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
      const input = parsed.data as { target: NotifyTarget; title: string; message: string; level: NotifyLevel; tags?: string[] };

      if (input.target.startsWith('agent:')) {
        const agent = input.target.slice('agent:'.length);
        const addressed = find(`${agent}@${config.domain}`);
        if (!addressed) return c.json({ error: 'not_found' }, 404);
        const auth = getAuth(c);
        // Scoped identity tokens never become a sideways command channel.
        if (auth.kind === 'identity' && auth.address !== addressed.address) {
          return c.json({ error: 'forbidden: token is scoped to another agent' }, 403);
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
        return c.json(await service.publish(input), 200);
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
      if (requestedPublicUrl.href.replace(/\/$/, '') !== activePublicUrl) {
        return c.json({ error: 'notify_public_url_mismatch: set NOTIFY_PUBLIC_URL and restart the stack first' }, 409);
      }
      try {
        return c.json(await createDevice(), 201);
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
