import { Hono } from 'hono';
import { z } from 'zod';
import { getAuth, getAttribution } from '../lib/auth.ts';
import { validateScopesInput } from '../lib/identities.ts';
import {
  createDelegation,
  findActiveDelegation,
  getDelegation,
  listDelegations,
  revokeDelegation,
} from '../lib/delegations.ts';
import { recordAuditEvent } from '../lib/audit.ts';

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

    if (attribution?.kind === 'oauth') {
      recordAuditEvent({
        event: 'delegation.grant.denied',
        outcome: 'denied',
        actor,
        mailbox,
        grantee,
        scopes: requestedScopes,
      });
      return c.json(
        { error: 'forbidden: delegation management requires direct identity credentials' },
        403,
      );
    }

    if (!isAdmin && !isOwner) {
      recordAuditEvent({
        event: 'delegation.grant.denied',
        outcome: 'denied',
        actor,
        mailbox,
        grantee,
        scopes: requestedScopes,
      });
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const existing = findActiveDelegation(mailbox, grantee);
    if (existing) {
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

    const grant = getDelegation(id);
    if (!grant) {
      return c.json({ error: 'not_found' }, 404);
    }

    const auth = getAuth(c);
    const attribution = getAttribution(c);
    const actor = auth.kind === 'admin' ? 'admin' : auth.address.toLowerCase();
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === grant.mailbox.toLowerCase();

    if (attribution?.kind === 'oauth') {
      recordAuditEvent({
        event: 'delegation.revoke',
        outcome: 'denied',
        grantId: grant.id,
        actor,
        mailbox: grant.mailbox,
        grantee: grant.grantee,
        scopes: grant.scopes,
      });
      return c.json(
        { error: 'forbidden: delegation management requires direct identity credentials' },
        403,
      );
    }

    if (!isAdmin && !isOwner) {
      recordAuditEvent({
        event: 'delegation.revoke',
        outcome: 'denied',
        grantId: grant.id,
        actor,
        mailbox: grant.mailbox,
        grantee: grant.grantee,
        scopes: grant.scopes,
      });
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
