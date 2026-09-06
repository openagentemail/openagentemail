import { Hono } from 'hono';
import { z } from 'zod';
import { getAuth, getAttribution } from '../lib/auth.ts';
import { findIdentity, validateScopesInput } from '../lib/identities.ts';
import {
  createDelegation,
  findActiveDelegation,
  getDelegation,
  getDroppedDelegation,
  listDelegations,
  revokeDelegation,
} from '../lib/delegations.ts';
import { recordAuditEvent } from '../lib/audit.ts';
import { config } from '../lib/config.ts';
import { clientIp } from '../lib/net.ts';
import { checkDelegationDeniedAuditLimit } from '../lib/ratelimit.ts';

function scopesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((s) => setA.has(s));
}

const postDelegationSchema = z.object({
  mailbox: z.string().email().max(320),
  grantee: z.string().email().max(320),
  scopes: z.unknown().optional(),
});

const listQuerySchema = z.object({
  mailbox: z.string().email().max(320).optional(),
  grantee: z.string().email().max(320).optional(),
}).strict();

export const delegationsRoute = new Hono()
  .post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = postDelegationSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }

    let requestedScopes: string[] = ['read:messages'];
    if (body && typeof body === 'object' && 'scopes' in body) {
      const rawScopes = (body as Record<string, unknown>).scopes;
      if (Array.isArray(rawScopes) && rawScopes.length === 0) {
        return c.json({ error: 'invalid_request', details: 'scopes cannot be empty' }, 400);
      }
      const validated = validateScopesInput(rawScopes);
      if (validated.ok) {
        requestedScopes = validated.scopes;
      } else {
        return c.json({ error: validated.error, details: validated.details }, 400);
      }
    }

    const mailbox = parsed.data.mailbox.trim().toLowerCase();
    const grantee = parsed.data.grantee.trim().toLowerCase();
    const auth = getAuth(c);
    const attribution = getAttribution(c);
    const actor = auth.kind === 'admin' ? 'admin' : auth.address.toLowerCase();
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === mailbox;

    function recordDeniedAuditIfAllowed() {
      const ip = clientIp(c);
      const rl = checkDelegationDeniedAuditLimit(ip);
      if (rl.allowed) {
        recordAuditEvent({
          event: 'delegation.grant.denied',
          outcome: 'denied',
          actor,
          mailbox,
          grantee,
          scopes: requestedScopes,
          ip,
        });
      }
    }

    if (attribution?.kind === 'oauth') {
      recordDeniedAuditIfAllowed();
      return c.json(
        { error: 'forbidden: delegation management requires direct identity credentials' },
        403,
      );
    }

    if (!isAdmin && !isOwner) {
      recordDeniedAuditIfAllowed();
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    // Item 3 (#1451: 两拒——外部域 400，未注册 localpart 404):
    const mailboxDomain = mailbox.split('@')[1]?.toLowerCase() ?? '';
    if (!config.allDomains.has(mailboxDomain)) {
      return c.json(
        { error: 'invalid_domain', details: 'mailbox domain is not hosted by this instance' },
        400,
      );
    }
    if (!findIdentity(mailbox)) {
      return c.json({ error: 'not_found', details: 'mailbox identity not found' }, 404);
    }

    const granteeDomain = grantee.split('@')[1]?.toLowerCase() ?? '';
    if (!config.allDomains.has(granteeDomain)) {
      return c.json(
        { error: 'invalid_domain', details: 'grantee domain is not hosted by this instance' },
        400,
      );
    }
    if (!findIdentity(grantee)) {
      return c.json({ error: 'not_found', details: 'grantee identity not found' }, 404);
    }

    const existing = findActiveDelegation(mailbox, grantee);
    if (existing) {
      if (!scopesEqual(existing.scopes, requestedScopes)) {
        return c.json(
          {
            error: 'conflict',
            details: 'active delegation grant exists with different scopes',
            existingScopes: existing.scopes,
            requestedScopes,
          },
          409,
        );
      }
      return c.json(existing, 200);
    }

    const grant = createDelegation({
      mailbox,
      grantee,
      scopes: requestedScopes,
      createdBy: actor,
    });

    recordAuditEvent({
      event: 'delegation.grant',
      outcome: 'ok',
      grantId: grant.id,
      actor,
      mailbox,
      grantee,
      scopes: grant.scopes,
    });

    return c.json(grant, 201);
  })
  .get('/', async (c) => {
    c.header('Cache-Control', 'no-store');
    const query = c.req.query();
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }

    const auth = getAuth(c);
    const isAdmin = auth.kind === 'admin';
    const callerAddress = auth.kind === 'identity' ? auth.address.toLowerCase() : null;

    const mailboxParam = parsed.data.mailbox ? parsed.data.mailbox.trim().toLowerCase() : undefined;
    const granteeParam = parsed.data.grantee ? parsed.data.grantee.trim().toLowerCase() : undefined;

    if (isAdmin) {
      const delegations = listDelegations({ mailbox: mailboxParam, grantee: granteeParam });
      return c.json({ delegations });
    }

    // Non-admin identity caller
    const isGranteeSelf = granteeParam === callerAddress;
    const isOwnerSelf = mailboxParam === callerAddress;

    if (!isGranteeSelf && !isOwnerSelf) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const delegations = listDelegations({ mailbox: mailboxParam, grantee: granteeParam });
    return c.json({ delegations });
  })
  .get('/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    if (!id || typeof id !== 'string' || !id.startsWith('delg_')) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const grant = getDelegation(id);
    if (!grant) {
      return c.json({ error: 'not_found' }, 404);
    }

    const auth = getAuth(c);
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === grant.mailbox.toLowerCase();
    const isGrantee = auth.kind === 'identity' && auth.address.toLowerCase() === grant.grantee.toLowerCase();

    if (!isAdmin && !isOwner && !isGrantee) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }
    return c.json(grant);
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!id || typeof id !== 'string' || !id.startsWith('delg_')) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // load() 剔除的 grant 也要能撤销（幂等墓碑磁盘残留），授权基于其原始视图。
    const grant = getDelegation(id) ?? getDroppedDelegation(id);
    if (!grant) {
      return c.json({ error: 'not_found' }, 404);
    }

    const auth = getAuth(c);
    const attribution = getAttribution(c);
    const actor = auth.kind === 'admin' ? 'admin' : auth.address.toLowerCase();
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === grant.mailbox.toLowerCase();
    // 与 POST 的 delegation.grant.denied 同款限速：超限只抑制 audit 落盘，不改变 403。
    const ip = clientIp(c);
    const recordDeniedAuditIfAllowed = () => {
      const rl = checkDelegationDeniedAuditLimit(ip);
      if (rl.allowed) {
        recordAuditEvent({
          event: 'delegation.revoke',
          outcome: 'denied',
          grantId: grant.id,
          actor,
          mailbox: grant.mailbox,
          grantee: grant.grantee,
          scopes: grant.scopes,
          ip,
        });
      }
    };

    if (attribution?.kind === 'oauth') {
      recordDeniedAuditIfAllowed();
      return c.json(
        { error: 'forbidden: delegation management requires direct identity credentials' },
        403,
      );
    }

    if (!isAdmin && !isOwner) {
      recordDeniedAuditIfAllowed();
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const revokedGrant = revokeDelegation(id, actor);

    recordAuditEvent({
      event: 'delegation.revoke',
      outcome: 'ok',
      grantId: grant.id,
      actor,
      mailbox: grant.mailbox,
      grantee: grant.grantee,
      scopes: grant.scopes,
    });

    return c.json({
      ...revokedGrant,
      revoked: true,
      revokedAt: revokedGrant?.revokedAt ?? grant.revokedAt,
    });
  });
