import { Hono } from 'hono';
import { z } from 'zod';
import {
  getMessage,
  InvalidMailCursorError,
  listMessages,
  listMessagesSince,
  setMessageSeen,
  StaleMessageGenerationError,
  waitForMessage,
} from '../lib/imap.ts';
import { forbidUnlessAddress, forbidUnlessMailboxAccess } from '../lib/auth.ts';
import { clampWaitSeconds } from '../lib/config.ts';
import { acquireWaitSlot, releaseWaitSlot } from '../lib/ratelimit.ts';

const listQuerySchema = z.object({
  address: z.string().email(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  since: z.string().optional(),
  cursor: z.string().optional(),
});

const getQuerySchema = z.object({
  address: z.string().email(),
  uidValidity: z.coerce.number().int().positive().optional(),
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
    if (parsed.data.since && parsed.data.cursor && parsed.data.since !== parsed.data.cursor) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const denied = forbidUnlessMailboxAccess(c, parsed.data.address);
    if (denied) return denied;
    const sinceToken = parsed.data.since ?? parsed.data.cursor;
    if (sinceToken !== undefined) {
      try {
        const page = await listMessagesSince(parsed.data.address, sinceToken, parsed.data.limit);
        return c.json({ messages: page.messages, nextCursor: page.nextCursor });
      } catch (err) {
        if (err instanceof InvalidMailCursorError) {
          return c.json({ error: 'invalid_cursor' }, 400);
        }
        throw err;
      }
    }
    const messages = await listMessages(parsed.data.address, parsed.data.limit);
    return c.json({ messages });
  })
  .get('/:id', async (c) => {
    const parsed = getQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
    }
    const denied = forbidUnlessMailboxAccess(c, parsed.data.address);
    if (denied) return denied;
    try {
      const message = await getMessage(parsed.data.address, c.req.param('id'), {
        uidValidity: parsed.data.uidValidity,
      });
      if (!message) {
        return c.json({ error: 'not_found' }, 404);
      }
      return c.json(message);
    } catch (err) {
      if (err instanceof StaleMessageGenerationError) {
        return c.json({ error: 'stale_message_generation' }, 404);
      }
      throw err;
    }
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
    const denied = forbidUnlessMailboxAccess(c, address);
    if (denied) return denied;
    // schema 仍允许 ≤600（历史客户端）；服务端静默钳到 MCP_MAX_WAIT_SECONDS
    const effectiveTimeout = clampWaitSeconds(timeoutSec);
    c.header('X-OAE-Wait-Timeout-Sec', String(effectiveTimeout));
    // Each wait pins an IMAP connection for up to the configured ceiling; cap
    // how many can be in flight so one caller can't starve the whole mailbox.
    if (!acquireWaitSlot(address)) {
      return c.json({ error: 'too_many_waits', retryAfterSec: 5 }, 429);
    }
    try {
      const message = await waitForMessage(
        address,
        { fromContains, subjectContains },
        effectiveTimeout,
      );
      if (!message) {
        // 暴露有效钳制值，便于客户端对齐轮询节奏（不 400 超参）
        return c.json({ error: 'timeout', timeoutSec: effectiveTimeout }, 408);
      }
      return c.json(message);
    } finally {
      releaseWaitSlot(address);
    }
  });
