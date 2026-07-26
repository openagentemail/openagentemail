import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { sendMail } from '../lib/smtp.ts';

const sendSchema = z.object({
  from: z.string().email(),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(1_000_000).optional(),
});

export const sendRoute = new Hono().post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
  }
  const { from, to, subject, text, html } = parsed.data;

  // `from` must be an existing identity on an allowed domain.
  const fromDomain = from.split('@')[1]?.toLowerCase() ?? '';
  if (!config.allowedSendDomains.includes(fromDomain) || !findIdentity(from)) {
    return c.json({ error: 'forbidden: from is not a known identity' }, 403);
  }

  try {
    const { messageId } = await sendMail({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(html ? { html } : {}),
    });
    return c.json({ queued: true, messageId }, 200);
  } catch (err) {
    return c.json({ error: `smtp_error: ${(err as Error).message}` }, 502);
  }
});
