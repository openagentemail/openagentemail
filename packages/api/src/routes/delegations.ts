import { Hono } from 'hono';
import { z } from 'zod';
import { getAuth } from '../lib/auth.ts';
import { validateScopesInput } from '../lib/identities.ts';
import {
  createDelegation,
  getDelegation,
  listDelegations,
  revokeDelegation,
} from '../lib/delegations.ts';
import { recordAuditEvent } from '../lib/audit.ts';

const postDelegationSchema = z.object({
  mailbox: z.string().email().max(320),
  grantee: z.string().email().max(320),
  scopes: z.unknown().optional(),
  ts: z.string().optional(),
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
    const actor = auth.kind === 'admin' ? 'admin' : auth.address.toLowerCase();
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === mailbox;

    const auditTs = c.req.header('x-audit-ts') ?? parsed.data.ts;

    if (!isAdmin && !isOwner) {
      recordAuditEvent({
        event: 'delegation.grant.denied',
        outcome: 'denied',
        actor,
        mailbox,
        grantee,
        scopes: requestedScopes,
        ...(auditTs ? { ts: auditTs } : {}),
      });
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const grant = createDelegation({
      mailbox,
      grantee,
      scopes: requestedScopes,
      createdBy: actor,
      createdAt: auditTs,
    });

    recordAuditEvent({
      event: 'delegation.grant',
      outcome: 'ok',
      grantId: grant.id,
      actor,
      mailbox,
      grantee,
      scopes: grant.scopes,
      ...(auditTs ? { ts: auditTs } : {}),
    });

    return c.json(grant, 201);
  })
  .get('/', async (c) => {
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
    if (!mailboxParam && !granteeParam) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    if (mailboxParam && mailboxParam !== callerAddress) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    if (granteeParam && granteeParam !== callerAddress && mailboxParam !== callerAddress) {
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const delegations = listDelegations({ mailbox: mailboxParam, grantee: granteeParam });
    return c.json({ delegations });
  })
  .get('/:id', async (c) => {
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
    const actor = auth.kind === 'admin' ? 'admin' : auth.address.toLowerCase();
    const isAdmin = auth.kind === 'admin';
    const isOwner = auth.kind === 'identity' && auth.address.toLowerCase() === grant.mailbox.toLowerCase();

    const auditTs = c.req.header('x-audit-ts');

    if (!isAdmin && !isOwner) {
      recordAuditEvent({
        event: 'delegation.revoke',
        outcome: 'denied',
        grantId: grant.id,
        actor,
        mailbox: grant.mailbox,
        grantee: grant.grantee,
        scopes: grant.scopes,
        ...(auditTs ? { ts: auditTs } : {}),
      });
      return c.json({ error: 'forbidden: token is scoped to another address' }, 403);
    }

    const revokedGrant = revokeDelegation(id, actor, auditTs);

    recordAuditEvent({
      event: 'delegation.revoke',
      outcome: 'ok',
      grantId: grant.id,
      actor,
      mailbox: grant.mailbox,
      grantee: grant.grantee,
      scopes: grant.scopes,
      ...(auditTs ? { ts: auditTs } : {}),
    });

    return c.json({
      ...revokedGrant,
      revoked: true,
      revokedAt: revokedGrant?.revokedAt ?? grant.revokedAt,
    });
  });
