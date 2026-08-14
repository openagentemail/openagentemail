import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { notifyTrustedAgentDelivery } from '../lib/notify.ts';
import { sendMail } from '../lib/smtp.ts';
import { forbidUnlessAddress, getAuth } from '../lib/auth.ts';
import { checkSendLimit, releaseSendLimit } from '../lib/ratelimit.ts';
import { isLocalSendFailure } from '../lib/sendfailure.ts';
import { describeFailure } from '../lib/redact.ts';
import { recordSentMessageIdAfterSend } from '../lib/sent-registry.ts';
import {
  InvalidSendCursorError,
  SEND_LOG_EMAIL_MAX_LEN,
  SendLogCorruptError,
  appendSendLog,
  claimRateLimitedLog,
  getSendLogRecord,
  isSendLogLimit,
  querySendLog,
  sendLogHealthAlert,
  type SendLogRecord,
  type SendLogSource,
} from '../lib/send-log.ts';
import { resolveSendLogSource } from '../lib/send-source.ts';

const emailField = z.string().email().max(SEND_LOG_EMAIL_MAX_LEN);

const sendSchema = z.object({
  from: emailField,
  to: z.union([emailField, z.array(emailField).min(1).max(50)]),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(1_000_000).optional(),
});

const historyQuerySchema = z.object({
  address: emailField.optional(),
  limit: z
    .union([z.literal('20'), z.literal('50'), z.literal('100')])
    .optional()
    .default('20')
    .transform((value) => Number(value)),
  cursor: z.string().min(1).max(1024).optional(),
});

function sendSource(c: Context): SendLogSource {
  // 不信任公共 X-OAE-Send-Source；只认 HMAC 签头。
  return resolveSendLogSource(c.req.header('x-oae-send-source-mac'), config.taskSigningSecret);
}

function recipientsOf(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** 记审计失败不得改 SMTP 结果；调用方仍可没有 id。 */
async function recordSend(input: {
  from: string;
  to: string[];
  subject: string;
  messageId?: string | null;
  result: 'queued' | 'failed';
  error?: string;
  source: SendLogSource;
}): Promise<SendLogRecord | null> {
  try {
    return await appendSendLog(input);
  } catch (err) {
    sendLogHealthAlert('append_failed_after_send', {
      result: input.result,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

function historyError(c: Context, err: unknown) {
  if (err instanceof InvalidSendCursorError) return c.json({ error: 'invalid_cursor' }, 400);
  if (err instanceof SendLogCorruptError) return c.json({ error: 'send_log_corrupt' }, 500);
  throw err;
}

/** identity 只能查自己的 from；admin 可筛任意地址。 */
function resolveHistoryAddress(c: Context, requested?: string): string | { error: ReturnType<Context['json']> } {
  const auth = getAuth(c);
  if (auth.kind === 'identity') {
    if (requested && requested.toLowerCase() !== auth.address.toLowerCase()) {
      return { error: c.json({ error: 'forbidden: token is scoped to another address' }, 403) };
    }
    return auth.address.toLowerCase();
  }
  return requested ? requested.toLowerCase() : '';
}

export const sendRoute = new Hono();

sendRoute.get('/history', async (c) => {
  const parsed = historyQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'invalid_request', details: parsed.error.issues }, 400);
  if (!isSendLogLimit(parsed.data.limit)) return c.json({ error: 'invalid_request' }, 400);
  const scoped = resolveHistoryAddress(c, parsed.data.address);
  if (typeof scoped !== 'string') return scoped.error;
  try {
    const page = await querySendLog({
      address: scoped || undefined,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    return c.json(page);
  } catch (err) {
    return historyError(c, err);
  }
});

sendRoute.get('/history/:id', async (c) => {
  const id = c.req.param('id');
  if (!id.startsWith('snd_')) return c.json({ error: 'invalid_request' }, 400);
  try {
    const row = await getSendLogRecord(id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const denied = forbidUnlessAddress(c, row.from);
    if (denied) return denied;
    return c.json(row);
  } catch (err) {
    return historyError(c, err);
  }
});

sendRoute.post('/', async (c) => {
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
  const toList = recipientsOf(to);
  const source = sendSource(c);

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
    // 每身份每窗口最多 1 条 rate_limited，避免 429 刷盘。
    const logged = claimRateLimitedLog(from)
      ? await recordSend({
          from,
          to: toList,
          subject,
          result: 'failed',
          error: 'rate_limited',
          source,
        })
      : null;
    return c.json(
      {
        error: 'rate_limited',
        limit: config.sendRateLimit,
        retryAfterSec: limit.retryAfterSec,
        ...(logged ? { id: logged.id } : {}),
      },
      429,
    );
  }

  try {
    const { messageId } = await sendMail({
      from,
      to: toList,
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
    for (const recipient of toList) {
      void notifyTrustedAgentDelivery(recipient);
    }
    const logged = await recordSend({
      from,
      to: toList,
      subject,
      messageId,
      result: 'queued',
      source,
    });
    return c.json({ queued: true, messageId, ...(logged ? { id: logged.id } : {}) }, 200);
  } catch (err) {
    // Our own mail server being unreachable shouldn't cost the user a slot;
    // anything the server actually answered to stays counted.
    if (isLocalSendFailure(err)) releaseSendLimit(from, limit.reservation);
    // SMTP errors carry server responses, relay hostnames and adapter context
    // (some adapters even echo the configured password). The operator needs
    // that in the log; the caller only gets a stable code.
    console.warn('[smtp] send failed:', describeFailure(err));
    const logged = await recordSend({
      from,
      to: toList,
      subject,
      result: 'failed',
      error: 'smtp_error',
      source,
    });
    return c.json({ error: 'smtp_error', ...(logged ? { id: logged.id } : {}) }, 502);
  }
});
