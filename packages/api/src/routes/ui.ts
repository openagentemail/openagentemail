import { Hono } from 'hono';
import { z } from 'zod';
import { forbidUnlessAddress, getAuth } from '../lib/auth.ts';
import { listIdentities, type Identity } from '../lib/identities.ts';
import {
  getMessage,
  listMessages,
  type MessageDetail,
  type MessageSummary,
} from '../lib/imap.ts';
import {
  UiSessionStore,
  uiPrivateHeaders,
  uiSessionAuth,
} from '../lib/ui-session.ts';

export type UiApiDependencies = {
  listIdentities: () => Identity[];
  listMessages: (address: string, limit: number) => Promise<MessageSummary[]>;
  getMessage: (address: string, id: string) => Promise<MessageDetail | null>;
};

const defaultDependencies: UiApiDependencies = {
  listIdentities,
  listMessages,
  getMessage,
};

const listQuerySchema = z.object({
  address: z.string().email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const detailQuerySchema = z.object({
  address: z.string().email(),
});

function identityProjection(identity: Identity) {
  return {
    address: identity.address,
    ...(identity.name ? { name: identity.name } : {}),
    createdAt: identity.createdAt,
  };
}

function validUid(id: string): boolean {
  if (!/^[1-9]\d{0,9}$/.test(id)) return false;
  const uid = Number(id);
  return Number.isSafeInteger(uid) && uid <= 4_294_967_295;
}

export function createUiApiRoutes(
  store: UiSessionStore,
  dependencies: UiApiDependencies = defaultDependencies,
): Hono {
  const routes = new Hono();

  routes.use('*', uiPrivateHeaders);
  routes.use('*', uiSessionAuth(store));

  routes.get('/me', (c) => c.json(getAuth(c)));

  routes.get('/identities', (c) => {
    const auth = getAuth(c);
    const all = dependencies.listIdentities();
    const visible =
      auth.kind === 'admin'
        ? all
        : all.filter((identity) => identity.address === auth.address);
    return c.json({ identities: visible.map(identityProjection) });
  });

  routes.get('/messages', async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const messages = await dependencies.listMessages(address, parsed.data.limit);
    return c.json({ messages });
  });

  routes.get('/messages/:id', async (c) => {
    const parsed = detailQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

    const address = parsed.data.address.toLowerCase();
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    const id = c.req.param('id');
    if (!validUid(id)) return c.json({ error: 'invalid_request' }, 400);

    const detail = await dependencies.getMessage(address, id);
    if (!detail) return c.json({ error: 'not_found' }, 404);
    const { html: _html, ...safeDetail } = detail;
    return c.json(safeDetail);
  });

  return routes;
}
