import { Hono } from 'hono';
import { z } from 'zod';
import { getMessage, listMessages, waitForMessage } from '../lib/imap.ts';
import { forbidUnlessAddress } from '../lib/auth.ts';

const listQuerySchema = z.object({
  address: z.string().email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const getQuerySchema = z.object({
  address: z.string().email(),
});

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
    const message = await waitForMessage(address, { fromContains, subjectContains }, timeoutSec);
    if (!message) {
      return c.json({ error: 'timeout' }, 408);
    }
    return c.json(message);
  });
