/**
 * Webhooks REST API Routes (RFC-0001 §10.3, §10.4, §10.6, §12).
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { StaleMessageGenerationError } from '../lib/imap.ts';
import {
  forbidUnlessAddress,
  getAttribution,
  getAuth,
} from '../lib/auth.ts';
import { recordAuditEvent } from '../lib/audit.ts';
import { clientIp } from '../lib/net.ts';
import {
  checkSubscriptionLimits,
  createWebhookSubscription,
  deleteWebhookSubscription,
  findCreateIdempotency,
  findRotateIdempotency,
  getWebhookSubscription,
  listWebhookSubscriptions,
  saveCreateIdempotency,
  saveRotateIdempotency,
  updateWebhookSubscription,
  type WebhookRecord,
} from '../lib/webhook-store.ts';
import { deriveWebhookKey } from '../lib/webhook-signing.ts';
import {
  deliveryLimiter,
  deliveryQueue,
  executeWebhookTestProbe,
  fireCreationPing,
  getLatestDeliveryForWebhook,
  readDeliveryLogRows,
  redeliverWebhookDelivery,
  validateWebhookUrlResolution,
} from '../lib/webhook-delivery.ts';

function requireAdmin(c: Context) {
  const auth = getAuth(c);
  if (auth.kind !== 'admin') {
    return c.json({ error: 'forbidden: admin key required' }, 403);
  }
  return null;
}

function forbidOAuthMutation(c: Context) {
  const attr = getAttribution(c);
  if (attr?.kind === 'oauth') {
    return c.json(
      { error: 'forbidden: oauth tokens may not mutate webhook subscriptions' },
      403,
    );
  }
  return null;
}

function forbidOAuthRead(c: Context) {
  const attr = getAttribution(c);
  if (attr?.kind === 'oauth') {
    return c.json(
      { error: 'forbidden: oauth tokens may not reveal webhook secrets' },
      403,
    );
  }
  return null;
}

type InFlightCreateResult = { status: number; body: any };
const inFlightCreateIdempotency = new Map<string, Promise<InFlightCreateResult>>();

function redactWebhookSecret(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), secret: null };
  }
  return body;
}

const createSchema = z
  .object({
    url: z.string().url().max(2048),
    address: z.string().email(),
    events: z
      .array(z.enum(['mail.received', 'approval.requested']))
      .min(1, 'events must be non-empty')
      .refine((arr) => new Set(arr).size === arr.length, 'events must be unique'),
    contentScope: z.enum(['metadata', 'preview']).optional().default('metadata'),
    description: z.string().max(1000).optional().default(''),
  })
  .strict();

const updateSchema = z
  .object({
    url: z.string().url().max(2048).optional(),
    events: z
      .array(z.enum(['mail.received', 'approval.requested']))
      .min(1, 'events must be non-empty')
      .refine((arr) => new Set(arr).size === arr.length, 'events must be unique')
      .optional(),
    contentScope: z.enum(['metadata', 'preview']).optional(),
    description: z.string().max(1000).optional(),
  })
  .strict();

function formatSubscriptionDetail(sub: WebhookRecord) {
  const lastDelivery = getLatestDeliveryForWebhook(sub.id);
  return {
    id: sub.id,
    url: sub.url,
    address: sub.address,
    events: sub.events,
    contentScope: sub.contentScope,
    description: sub.description,
    state: sub.state,
    disabledReason: sub.disabledReason,
    secretPrefix: sub.secretPrefix,
    signatureScheme: 'v1',
    timestampToleranceSec: config.webhooks.timestampToleranceSec,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    rotatedAt: sub.rotatedAt,
    consecutiveFailures: sub.consecutiveFailures,
    privateTargetGranted: sub.privateTargetGranted,
    lastDelivery: lastDelivery
      ? {
          deliveryId: lastDelivery.deliveryId,
          ts: lastDelivery.ts,
          attempt: lastDelivery.attempt,
          outcome: lastDelivery.outcome,
          status: lastDelivery.status,
          durationMs: lastDelivery.durationMs,
          reason: lastDelivery.reason,
        }
      : null,
  };
}

export const webhooksRoute = new Hono()
  .use('*', async (c, next) => {
    if (!config.webhooks.enabled) {
      return c.json({ error: 'webhooks_disabled' }, 404);
    }
    await next();
  })

  // POST /v1/webhooks - Create subscription
  .post('/', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }

    const auth = getAuth(c);
    const targetAddress = parsed.data.address.toLowerCase();

    // Scope check: identity can only create for own address
    if (auth.kind === 'identity' && auth.address !== targetAddress) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    // Preview contentScope requires admin
    if (auth.kind === 'identity' && parsed.data.contentScope === 'preview') {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    // Rate limiting
    const tokenKey = auth.kind === 'admin' ? 'admin' : auth.address;
    const rateRes = deliveryLimiter.checkCreateRate(tokenKey);
    if (!rateRes.allowed) {
      c.header('Retry-After', String(rateRes.retryAfterSec));
      return c.json({ error: 'rate_limited', retryAfterSec: rateRes.retryAfterSec }, 429);
    }

    // Idempotency check
    const idempotencyKey = c.req.header('idempotency-key')?.trim();
    const compositeKey = idempotencyKey ? `${idempotencyKey}:${targetAddress}` : null;
    if (idempotencyKey && compositeKey) {
      const pending = inFlightCreateIdempotency.get(compositeKey);
      if (pending) {
        try {
          const cached = await pending;
          return c.json(redactWebhookSecret(cached.body), cached.status as any);
        } catch {
          // ignore failure and proceed
        }
      }
      const found = findCreateIdempotency(idempotencyKey, targetAddress);
      if (found) {
        return c.json(found.responseBody, 201);
      }
    }

    const executeCreate = async (): Promise<InFlightCreateResult> => {
      // URL validation (static & DNS resolution)
      const resolution = await validateWebhookUrlResolution(parsed.data.url, {
        allowPrivateTargets: config.webhooks.allowPrivateTargets,
      });
      if (!resolution.valid) {
        return {
          status: 400,
          body: {
            error:
              resolution.code === 'webhook_target_forbidden'
                ? 'webhook_target_forbidden'
                : 'invalid_webhook_url',
          },
        };
      }

      // Rule C: private target requires admin
      if (resolution.isPrivateTarget && auth.kind !== 'admin') {
        return { status: 400, body: { error: 'webhook_target_forbidden' } };
      }

      // Subscription limit check
      const limits = checkSubscriptionLimits(targetAddress);
      if (!limits.allowed) {
        return { status: 409, body: { error: 'webhook_limit_reached' } };
      }

      const createdBy = auth.kind === 'admin' ? 'admin' : auth.address;
      const record = createWebhookSubscription({
        url: parsed.data.url,
        address: targetAddress,
        events: parsed.data.events,
        contentScope: parsed.data.contentScope,
        description: parsed.data.description,
        privateTargetGranted: resolution.isPrivateTarget && auth.kind === 'admin',
        createdBy,
      });

      const derived = deriveWebhookKey(
        config.webhooks.signingSecret || config.taskSigningSecret,
        record.id,
        record.epoch,
      );

      // Fire asynchronous ping at creation (§5.1, D12, Item 19)
      fireCreationPing(record, 'creation', tokenKey);

      recordAuditEvent({
        event: 'webhook.create',
        outcome: 'ok',
        address: record.address,
        webhookId: record.id,
      });

      const response = {
        id: record.id,
        url: record.url,
        address: record.address,
        events: record.events,
        contentScope: record.contentScope,
        description: record.description,
        state: record.state,
        secret: derived.displayedSecret,
        secretPrefix: record.secretPrefix,
        signatureScheme: 'v1',
        timestampToleranceSec: config.webhooks.timestampToleranceSec,
        createdAt: record.createdAt,
      };

      if (idempotencyKey) {
        saveCreateIdempotency({
          key: idempotencyKey,
          address: record.address,
          webhookId: record.id,
          responseBody: { ...response, secret: null },
          createdAt: record.createdAt,
        });
      }

      return { status: 201, body: response };
    };

    if (compositeKey) {
      let promise = inFlightCreateIdempotency.get(compositeKey);
      const waiter = Boolean(promise);
      if (!promise) {
        promise = executeCreate();
        inFlightCreateIdempotency.set(compositeKey, promise);
      }
      try {
        const res = await promise;
        if (waiter) {
          return c.json(redactWebhookSecret(res.body), res.status as any);
        }
        return c.json(res.body, res.status as any);
      } finally {
        inFlightCreateIdempotency.delete(compositeKey);
      }
    } else {
      const res = await executeCreate();
      return c.json(res.body, res.status as any);
    }
  })

  // GET /v1/webhooks - List subscriptions
  .get('/', async (c) => {
    const auth = getAuth(c);
    const addressParam = c.req.query('address')?.trim()?.toLowerCase();
    if (addressParam && auth.kind !== 'admin') {
      return c.json({ error: 'forbidden: admin key required' }, 403);
    }

    const all = listWebhookSubscriptions();
    let filtered: WebhookRecord[];
    if (auth.kind === 'admin') {
      filtered = addressParam ? all.filter((s) => s.address === addressParam) : all;
    } else {
      filtered = all.filter((s) => s.address === auth.address);
    }

    return c.json({
      webhooks: filtered.map((sub) => formatSubscriptionDetail(sub)),
    });
  })

  // POST /v1/webhooks/deliveries/:deliveryId/redeliver - Replay delivery
  .post('/deliveries/:deliveryId/redeliver', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const deliveryId = c.req.param('deliveryId');
    try {
      const result = await redeliverWebhookDelivery(deliveryId);

      recordAuditEvent({
        event: 'webhook.redeliver',
        outcome: 'ok',
        address: result.address,
        webhookId: result.webhookId,
      });

      return c.json({
        ok: true,
        deliveryId: result.deliveryId,
        eventId: result.eventId,
      });
    } catch (err: any) {
      if (err.code === 'delivery_not_found') {
        return c.json({ error: 'delivery_not_found' }, 404);
      }
      if (err.code === 'not_found' || err.code === 'webhook_not_found') {
        return c.json({ error: 'webhook_not_found' }, 404);
      }
      if (err.code === 'message_not_found' || err.reason === 'message_not_found') {
        return c.json({ error: 'message_not_found' }, 404);
      }
      if (err.code === 'task_not_found' || err.reason === 'task_not_found') {
        return c.json({ error: 'task_not_found' }, 404);
      }
      if (
        err instanceof StaleMessageGenerationError ||
        err?.name === 'StaleMessageGenerationError' ||
        err.code === 'stale_message_generation' ||
        err.reason === 'stale_message_generation'
      ) {
        return c.json({ error: 'stale_message_generation' }, 409);
      }
      if (err.code === 'uidvalidity_required' || err.reason === 'uidvalidity_required') {
        return c.json({ error: 'uidvalidity_required' }, 409);
      }
      if (err.code === 'webhook_disabled') {
        return c.json({ error: 'webhook_disabled', disabledReason: err.disabledReason }, 409);
      }
      throw err;
    }
  })

  // GET /v1/webhooks/:id - Get subscription detail
  .get('/:id', async (c) => {
    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const denied = forbidUnlessAddress(c, sub.address);
    if (denied) return denied;

    return c.json(formatSubscriptionDetail(sub));
  })

  // POST /v1/webhooks/:id - Update subscription
  .post('/:id', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }

    const auth = getAuth(c);

    // Rule B: preview contentScope requires admin
    if (parsed.data.contentScope === 'preview' && auth.kind !== 'admin') {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    // Rule B: if stored contentScope is preview, identity cannot change url
    if (
      sub.contentScope === 'preview' &&
      auth.kind !== 'admin' &&
      parsed.data.url !== undefined &&
      parsed.data.url !== sub.url
    ) {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    let urlChanged = false;
    let isPrivateTarget = sub.privateTargetGranted;

    if (parsed.data.url && parsed.data.url !== sub.url) {
      urlChanged = true;
      const resolution = await validateWebhookUrlResolution(parsed.data.url, {
        allowPrivateTargets: config.webhooks.allowPrivateTargets,
      });
      if (!resolution.valid) {
        return c.json(
          {
            error:
              resolution.code === 'webhook_target_forbidden'
                ? 'webhook_target_forbidden'
                : 'invalid_webhook_url',
          },
          400,
        );
      }
      if (resolution.isPrivateTarget && auth.kind !== 'admin') {
        return c.json({ error: 'webhook_target_forbidden' }, 400);
      }
      isPrivateTarget = resolution.isPrivateTarget && auth.kind === 'admin';
    }

    const updated = updateWebhookSubscription(sub.id, (s) => {
      if (parsed.data.url) s.url = parsed.data.url;
      if (parsed.data.events) s.events = parsed.data.events;
      if (parsed.data.contentScope) s.contentScope = parsed.data.contentScope;
      if (parsed.data.description !== undefined) s.description = parsed.data.description;
      if (urlChanged) {
        s.consecutiveFailures = 0;
        if (s.state !== 'disabled') {
          s.state = 'unverified';
        }
        s.privateTargetGranted = isPrivateTarget;
      }
    });

    if (!updated) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (urlChanged) {
      const tokenKey = auth.kind === 'admin' ? 'admin' : auth.address;
      fireCreationPing(updated, 'creation', tokenKey);
    }

    recordAuditEvent({
      event: 'webhook.update',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    return c.json(formatSubscriptionDetail(updated));
  })

  // GET /v1/webhooks/:id/secret - Reveal signing secret
  .get('/:id/secret', async (c) => {
    const deniedOAuth = forbidOAuthRead(c);
    if (deniedOAuth) return deniedOAuth;

    c.header('Cache-Control', 'no-store');

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    const auth = getAuth(c);

    // Rule D: Identity caller can only reveal if created by itself
    if (auth.kind === 'identity' && sub.createdBy !== auth.address) {
      return c.json({ error: 'forbidden: admin key required' }, 403);
    }

    // Rule D / §12.3: Identity caller requires metadata scope
    if (auth.kind === 'identity' && sub.contentScope !== 'metadata') {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    const derived = deriveWebhookKey(
      config.webhooks.signingSecret || config.taskSigningSecret,
      sub.id,
      sub.epoch,
    );

    recordAuditEvent({
      event: 'webhook.reveal',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    return c.json({
      id: sub.id,
      secret: derived.displayedSecret,
      secretPrefix: sub.secretPrefix,
      epoch: sub.epoch,
      overlapUntil: sub.overlapUntil,
    });
  })

  // DELETE /v1/webhooks/:id - Delete subscription
  .delete('/:id', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    const auth = getAuth(c);

    // Rule D: Identity caller can only delete if created by itself
    if (auth.kind === 'identity' && sub.createdBy !== auth.address) {
      return c.json({ error: 'forbidden: admin key required' }, 403);
    }

    // Rule B: Identity caller requires metadata scope
    if (auth.kind === 'identity' && sub.contentScope !== 'metadata') {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    deleteWebhookSubscription(sub.id);
    deliveryQueue.cancelForWebhook(sub.id, 'subscription_deleted');

    recordAuditEvent({
      event: 'webhook.delete',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    return c.json({ ok: true });
  })

  // POST /v1/webhooks/:id/rotate - Rotate signing secret
  .post('/:id/rotate', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    const auth = getAuth(c);

    // Rule D: Identity caller can only rotate if created by itself
    if (auth.kind === 'identity' && sub.createdBy !== auth.address) {
      return c.json({ error: 'forbidden: admin key required' }, 403);
    }

    // Rule B: Identity caller requires metadata scope
    if (auth.kind === 'identity' && sub.contentScope !== 'metadata') {
      return c.json({ error: 'content_scope_requires_admin' }, 403);
    }

    // Idempotency check (cached hits skip the write-amplification limiter)
    const idempotencyKey = c.req.header('idempotency-key')?.trim();
    if (idempotencyKey) {
      const found = findRotateIdempotency(sub.id, idempotencyKey);
      if (found) {
        return c.json(found.responseBody, 200);
      }
    }

    // Overlap window check
    const force = c.req.query('force') === 'true';
    if (
      sub.overlapUntil &&
      new Date(sub.overlapUntil).getTime() > Date.now() &&
      !force
    ) {
      return c.json(
        { error: 'rotation_window_open', overlapUntil: sub.overlapUntil },
        409,
      );
    }

    const tokenKey = auth.kind === 'admin' ? 'admin' : auth.address;
    const rotateRate = deliveryLimiter.checkRotateRate(tokenKey);
    if (!rotateRate.allowed) {
      c.header('Retry-After', String(rotateRate.retryAfterSec));
      return c.json({ error: 'rate_limited', retryAfterSec: rotateRate.retryAfterSec }, 429);
    }

    const nextEpoch = sub.epoch + 1;
    const now = Date.now();
    const overlapUntil =
      config.webhooks.rotationOverlapMs > 0
        ? new Date(now + config.webhooks.rotationOverlapMs).toISOString()
        : null;

    const derived = deriveWebhookKey(
      config.webhooks.signingSecret || config.taskSigningSecret,
      sub.id,
      nextEpoch,
    );

    updateWebhookSubscription(sub.id, (s) => {
      s.epoch = nextEpoch;
      s.secretPrefix = derived.secretPrefix;
      s.overlapUntil = overlapUntil;
      s.rotatedAt = new Date(now).toISOString();
    });

    recordAuditEvent({
      event: 'webhook.rotate',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    const response = {
      id: sub.id,
      epoch: nextEpoch,
      secret: derived.displayedSecret,
      secretPrefix: derived.secretPrefix,
      overlapUntil,
    };

    if (idempotencyKey) {
      saveRotateIdempotency({
        key: idempotencyKey,
        webhookId: sub.id,
        epoch: nextEpoch,
        responseBody: { ...response, secret: null },
        createdAt: new Date(now).toISOString(),
      });
    }

    return c.json(response, 200);
  })

  // POST /v1/webhooks/:id/test - Test probe
  .post('/:id/test', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    if (sub.state === 'disabled') {
      return c.json(
        { error: 'webhook_disabled', disabledReason: sub.disabledReason },
        409,
      );
    }

    const auth = getAuth(c);
    const tokenKey = auth.kind === 'admin' ? 'admin' : auth.address;

    try {
      const probeRes = await executeWebhookTestProbe(sub, tokenKey, {
        clientIp: clientIp(c),
      });

      let auditOutcome: 'ok' | 'denied' | 'error' = 'ok';
      if (probeRes.outcome === 'refused') {
        auditOutcome = 'denied';
      } else if (probeRes.outcome !== 'success') {
        auditOutcome = 'error';
      }

      recordAuditEvent({
        event: 'webhook.test',
        outcome: auditOutcome,
        address: sub.address,
        webhookId: sub.id,
      });

      return c.json(probeRes, 200);
    } catch (err: any) {
      if (err.code === 'rate_limited') {
        if (err.retryAfterSec) {
          c.header('Retry-After', String(err.retryAfterSec));
        }
        return c.json({ error: 'rate_limited', retryAfterSec: err.retryAfterSec }, 429);
      }
      if (err.code === 'webhook_disabled') {
        return c.json(
          { error: 'webhook_disabled', disabledReason: err.disabledReason },
          409,
        );
      }
      throw err;
    }
  })

  // POST /v1/webhooks/:id/disable - Manual pause
  .post('/:id/disable', async (c) => {
    const deniedOAuth = forbidOAuthMutation(c);
    if (deniedOAuth) return deniedOAuth;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const deniedAddress = forbidUnlessAddress(c, sub.address);
    if (deniedAddress) return deniedAddress;

    const auth = getAuth(c);

    // Rule D: Identity caller can only disable if created by itself
    if (auth.kind === 'identity' && sub.createdBy !== auth.address) {
      return c.json({ error: 'forbidden: admin key required' }, 403);
    }

    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'disabled';
      s.disabledReason = 'manual';
    });
    deliveryQueue.cancelForWebhook(sub.id, 'webhook_disabled');

    recordAuditEvent({
      event: 'webhook.disabled',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    return c.json({ ok: true, state: 'disabled', disabledReason: 'manual' });
  })

  // POST /v1/webhooks/:id/enable - Resume endpoint (admin only)
  .post('/:id/enable', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (sub.state !== 'disabled') {
      return c.json({ error: 'webhook_not_disabled' }, 409);
    }

    const updated = updateWebhookSubscription(sub.id, (s) => {
      s.state = 'unverified';
      s.disabledReason = null;
      s.consecutiveFailures = 0;
    });

    if (updated) {
      fireCreationPing(updated, 'creation', 'admin');
    }

    recordAuditEvent({
      event: 'webhook.enabled',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });

    return c.json({ ok: true, state: 'unverified' });
  })

  // GET /v1/webhooks/:id/deliveries - List deliveries (admin only)
  .get('/:id/deliveries', async (c) => {
    const denied = requireAdmin(c);
    if (denied) return denied;

    const sub = getWebhookSubscription(c.req.param('id'));
    if (!sub) {
      return c.json({ error: 'not_found' }, 404);
    }

    const rawLimit = c.req.query('limit');
    let limit = 20;
    if (rawLimit !== undefined && rawLimit !== '') {
      const n = Number(rawLimit);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return c.json(
          { error: 'invalid_request', error_description: 'limit must be a positive integer' },
          400,
        );
      }
      limit = Math.min(n, 100);
    }
    const cursor = c.req.query('cursor');

    const res = readDeliveryLogRows({
      webhookId: sub.id,
      limit,
      cursor,
    });

    return c.json(res);
  });
