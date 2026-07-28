import { Hono } from 'hono';
import { z } from 'zod';
import { getMessage, listMessages, setMessageSeen, waitForMessage } from '../lib/imap.ts';
import { forbidUnlessAddress } from '../lib/auth.ts';
import { acquireWaitSlot, releaseWaitSlot } from '../lib/ratelimit.ts';

const listQuerySchema = z.object({
  address: z.string().email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const getQuerySchema = z.object({
  address: z.string().email(),
});

const seenSchema = z
  .object({
    address: z.string().email(),
    seen: z.boolean(),
  })
  .strict();

const waitSchema = z.object({
  address: z.string().email(),
  fromContains: z.string().max(200).optional(),
  subjectContains: z.string().max(200).optional(),
  timeoutSec: z.coerce.number().int().min(1).max(600).default(120),
});

export const messagesRoute = new Hono()
  .get('/', async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const denied = forbidUnlessAddress(c, parsed.data.address);
    if (denied) return denied;
    const messages = await listMessages(parsed.data.address, parsed.data.limit);
    return c.json({ messages });
  })
  .get('/:id', async (c) => {
    const parsed = getQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const denied = forbidUnlessAddress(c, parsed.data.address);
    if (denied) return denied;
    const message = await getMessage(parsed.data.address, c.req.param('id'));
    if (!message) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json(message);
  })
  .post('/:id/seen', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = seenSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const id = c.req.param('id');
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const denied = forbidUnlessAddress(c, parsed.data.address);
    if (denied) return denied;
    const marked = await setMessageSeen(parsed.data.address, id, parsed.data.seen);
    if (!marked) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ id, seen: parsed.data.seen });
  })
  .post('/wait', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = waitSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const { address, fromContains, subjectContains, timeoutSec } = parsed.data;
    const denied = forbidUnlessAddress(c, address);
    if (denied) return denied;
    // Each wait pins an IMAP connection for up to 10 minutes; cap how many
    // can be in flight so one caller can't starve the whole mailbox.
    if (!acquireWaitSlot(address)) {
      return c.json({ error: 'too_many_waits', retryAfterSec: 5 }, 429);
    }
    try {
      const message = await waitForMessage(address, { fromContains, subjectContains }, timeoutSec);
      if (!message) {
        return c.json({ error: 'timeout' }, 408);
      }
      return c.json(message);
    } finally {
      releaseWaitSlot(address);
    }
  });
