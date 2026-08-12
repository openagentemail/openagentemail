import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { notifyTrustedAgentDelivery } from '../lib/notify.ts';
import { sendMail } from '../lib/smtp.ts';
import { forbidUnlessAddress } from '../lib/auth.ts';
import { checkSendLimit, releaseSendLimit } from '../lib/ratelimit.ts';
import { isLocalSendFailure } from '../lib/sendfailure.ts';
import { describeFailure } from '../lib/redact.ts';
import { recordSentMessageIdAfterSend } from '../lib/sent-registry.ts';

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

  // Identity tokens may only send as themselves.
  const denied = forbidUnlessAddress(c, from);
  if (denied) return denied;

  // `from` must be an existing identity on an allowed domain.
  const fromDomain = from.split('@')[1]?.toLowerCase() ?? '';
  if (!config.allowedSendDomains.includes(fromDomain) || !findIdentity(from)) {
    return c.json({ error: 'forbidden: from is not a known identity' }, 403);
  }

  // Per-identity rate limit (rolling hour; 0 disables in config).
  const limit = checkSendLimit(from, config.sendRateLimit);
  if (!limit.allowed) {
    return c.json(
      { error: 'rate_limited', limit: config.sendRateLimit, retryAfterSec: limit.retryAfterSec },
      429,
    );
  }

  try {
    const { messageId } = await sendMail({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(html ? { html } : {}),
    });
    // /v1/send 出站登记：sendMail 已 best-effort 写入；此处再记一次以覆盖测试里 mock 掉 smtp 的路径。
    // 登记失败不 502：SMTP 已接受时失败会让调用方重试、重复外发。
    recordSentMessageIdAfterSend(messageId, from);
    // This is the only path that wakes an agent topic: it is a successful,
    // authenticated server-side send to another managed address. Inbound mail
    // never gets this capability because any sender header can be forged.
    for (const recipient of (Array.isArray(to) ? to : [to])) {
      void notifyTrustedAgentDelivery(recipient);
    }
    return c.json({ queued: true, messageId }, 200);
  } catch (err) {
    // Our own mail server being unreachable shouldn't cost the user a slot;
    // anything the server actually answered to stays counted.
    if (isLocalSendFailure(err)) releaseSendLimit(from, limit.reservation);
    // SMTP errors carry server responses, relay hostnames and adapter context
    // (some adapters even echo the configured password). The operator needs
    // that in the log; the caller only gets a stable code.
    console.warn('[smtp] send failed:', describeFailure(err));
    return c.json({ error: 'smtp_error' }, 502);
  }
});
