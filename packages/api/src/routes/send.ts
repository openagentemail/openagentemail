import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { findIdentity } from '../lib/identities.ts';
import { notifyTrustedAgentDelivery } from '../lib/notify.ts';
import { sendMail } from '../lib/smtp.ts';
import { forbidUnlessAddress, getAuth, type Auth } from '../lib/auth.ts';
import {
  checkAndReserveAutoReplyCooldown,
  finalizeAutoReplyCooldownReservation,
  releaseAutoReplyCooldownReservation,
  type AutoReplyCooldownReservation,
} from '../lib/auto-reply-cooldown.ts';
import { checkSendLimit, releaseSendLimit } from '../lib/ratelimit.ts';
import {
  beginSendIdempotency,
  completeSendIdempotency,
  isSendIdempotencyReplayUnavailable,
  parseSendIdempotencyKey,
  queuedSendResponse,
  releaseSendIdempotency,
  smtpErrorSendResponse,
  type SendIdempotencyReservation,
} from '../lib/send-idempotency.ts';
import { isAmbiguousPostDataSendFailure, isLocalSendFailure } from '../lib/sendfailure.ts';
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
import { logInvalidCursorRejectionFor } from '../lib/invalid-cursor-observability.ts';
import {
  rejectReferencesWithoutInReplyTo,
  replyReferencesSchema,
  rfc5322MsgIdSchema,
} from '../lib/reply-thread.ts';

const emailField = z.string().email().max(SEND_LOG_EMAIL_MAX_LEN);

/**
 * 仅 POST /v1/send 用：身份 token 是否以归属子地址发信（#275）。
 * 不改动通用 forbidUnlessAddress，保持最小爆炸半径。
 * #317：有意不查 attribution——OAuth 视同父身份本人（语义钉见
 * docs/security.md「OAuth access tokens」节），勿当遗漏修掉。
 */
function allowParentSendAsChild(auth: Auth, from: string): boolean {
  if (auth.kind !== 'identity') return false;
  const child = findIdentity(from);
  return child?.parentIdentity === auth.address.toLowerCase();
}

// #324：未知键拒绝（.strict），避免静默剥离 attachments 等同族键
const sendSchema = z.object({
  from: emailField,
  to: z.union([emailField, z.array(emailField).min(1).max(50)]),
  subject: z.string().max(998),
  text: z.string().max(1_000_000),
  html: z.string().max(1_000_000).optional(),
  // #363-A：可选布尔。仅 true 由 SMTP 写固定 Auto-Submitted；未知键仍拒绝。
  autoReply: z.boolean().optional(),
  // 可选线程头。省略两个字段时不写 In-Reply-To / References。
  inReplyTo: rfc5322MsgIdSchema.optional(),
  references: replyReferencesSchema.optional(),
}).strict().superRefine(rejectReferencesWithoutInReplyTo);

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

/** 每小时额度的准入时刻。限额关闭时没有 reservation，不写 rateLimitAt。 */
function hourlySlotAt(reservation: number | undefined): string | undefined {
  if (typeof reservation !== 'number' || !Number.isFinite(reservation)) return undefined;
  return new Date(reservation).toISOString();
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
  autoReply?: boolean;
  /** 只给 SMTP catch。分类必须和下面的 isLocalSendFailure 是同一次判断。 */
  failureKind?: 'smtp_response' | 'local';
  /** 准入时刻。只传给真正占住每小时额度的行。 */
  rateLimitAt?: string;
  /**
   * 只在缓存幂等结果时传入：200，以及对端已应答的 502。
   * 都是哈希，不是原始键。额度拒绝和连接类失败不传。
   */
  idempotencyKeyHash?: string;
  requestHash?: string;
  /** 与 sentAt 同一刻再确认身份。返回 false 则不写两个哈希。 */
  keepIdempotencyHashes?: () => boolean;
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

function historyError(c: Context, err: unknown, _cursor?: string) {
  if (err instanceof InvalidSendCursorError) {
    // #202/#270：send 族拒收可观测；decoder kind 直传；400 体逐字不变
    logInvalidCursorRejectionFor('send', err.kind, { cursorTs: err.cursorTs });
    return c.json({ error: 'invalid_cursor' }, 400);
  }
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
    return historyError(c, err, parsed.data.cursor);
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
  // 与 webhook 同一套 trim / 空键 / 128 上限，另外拒绝控制字符。坏键在读 body 之前就 400。
  const idempotencyKey = parseSendIdempotencyKey(c.req.header('idempotency-key'));
  if (!idempotencyKey.ok) return c.json({ error: 'invalid_request' }, 400);

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
  const { from, to, subject, text, html, autoReply, inReplyTo, references } = parsed.data;
  const toList = recipientsOf(to);
  const source = sendSource(c);

  // Identity tokens may only send as themselves.
  const denied = forbidUnlessAddress(c, from);
  if (denied) {
    // #275：父对子归属放行（from.parentIdentity === auth.address）
    const auth = getAuth(c);
    if (!allowParentSendAsChild(auth, from)) return denied;
  }

  // `from` must be an existing identity on an allowed domain.
  const fromDomain = from.split('@')[1]?.toLowerCase() ?? '';
  const sender = findIdentity(from);
  if (!config.allowedSendDomains.includes(fromDomain) || !sender) {
    return c.json({ error: 'forbidden: from is not a known identity' }, 403);
  }

  // 幂等键在身份校验之后、冷却和每小时额度之前。
  // 启动回放失败时带键请求直接 503，不占位、不碰冷却、不占额度、不打 SMTP。
  // 不带键的请求照常。下一次回放成功后恢复。
  if (idempotencyKey.key && isSendIdempotencyReplayUnavailable()) {
    return c.json({ error: 'idempotency_unavailable' }, 503);
  }
  // 检查和占位同步完成，后面的 await 插不进第二封 SMTP。
  // 已完成且指纹相同：原样返回，不发信、不占额度、不碰冷却、不新写日志。
  // 指纹不同：422。同一指纹仍在发送：409。
  // 4xx/429 和连接类失败放开键。200 和对端已应答的 502 记成已完成。
  // 占位时记下这一任身份。完成时身份没了或 createdAt 变了，就不记回放。
  // sendSchema 已拒绝非法 inReplyTo / references。400 走不到这里，不会占键。
  // parsed.data 带着通过校验的线程字段，指纹把它们算进去。
  const begun = beginSendIdempotency(from, idempotencyKey.key, parsed.data, sender.createdAt);
  if (begun.outcome === 'replay') {
    c.header('Idempotent-Replayed', 'true');
    if (begun.status === 200) return c.json(begun.body, 200);
    return c.json(begun.body, 502);
  }
  if (begun.outcome === 'reused') return c.json({ error: 'idempotency_key_reused' }, 422);
  if (begun.outcome === 'in_flight') {
    return c.json({ error: 'idempotency_in_flight', retryAfterSec: 1 }, 409);
  }
  if (begun.outcome === 'table_full') {
    return c.json({ error: 'idempotency_table_full', retryAfterSec: 1 }, 429);
  }
  const reservation: SendIdempotencyReservation | undefined =
    begun.outcome === 'reserved' ? begun.reservation : undefined;
  // 没有键时一开始就算处理完，finally 不会去放开一张不存在的票。
  let idempotencySettled = reservation === undefined;
  // 落盘回调里置位。true 才把结果放进内存；身份已换则保持 false，finally 放开占位。
  let bindIdempotency = false;
  /** 这一任身份还在。删掉或同址新建（createdAt 不同）都不是。 */
  const identityStillReserved = (): boolean => {
    const createdAt = reservation?.identityCreatedAt;
    if (!createdAt) return false;
    const current = findIdentity(from);
    return current !== undefined && current.createdAt === createdAt;
  };
  // 哈希在生成 sentAt 的那一刻才决定写不写。回调顺手记下能不能进内存表。
  const idemLog = (): {
    idempotencyKeyHash?: string;
    requestHash?: string;
    keepIdempotencyHashes?: () => boolean;
  } => {
    if (!reservation) return {};
    return {
      idempotencyKeyHash: reservation.keyHash,
      requestHash: reservation.requestHash,
      keepIdempotencyHashes: () => {
        try {
          bindIdempotency = identityStillReserved();
          return bindIdempotency;
        } catch (err) {
          // SMTP 已接受之后身份库读失败。先标成终态再抛出：
          // 发送日志会接住并照写哈希，finishIdempotency 记下实际返回的响应。
          // finally 看到已结算，不会放开占位。
          bindIdempotency = true;
          throw err;
        }
      },
    };
  };
  const finishIdempotency = (status: 200 | 502, body: Record<string, unknown>) => {
    if (bindIdempotency && completeSendIdempotency(reservation, status, body)) {
      idempotencySettled = true;
    }
  };

  try {
    // 自动回复冷却在每小时额度之前。false / 省略不进这里，因此不读也不写冷却表。
    // 检查和占位同步完成，后面的 await（额度日志、SMTP）插不进第二封。
    // 任一收件人仍在冷却或占位中就整封拒绝：不打 SMTP、不占每小时额度、不写 send-log
    // （信没交到 SMTP，不落盘，避免 429 刷审计；重建也看不到它）。
    // 与 rate_limited 一样只在 JSON 里给 retryAfterSec，不另加 Retry-After 头。
    let autoReplyReservation: AutoReplyCooldownReservation | undefined;
    if (autoReply === true && config.autoReplyCooldownSec > 0) {
      const cooled = checkAndReserveAutoReplyCooldown(from, toList, config.autoReplyCooldownSec);
      if (!cooled.reserved) {
        // 冷却拒绝不缓存。放开幂等键，同一 body 在冷却结束后还能发。
        releaseSendIdempotency(reservation);
        idempotencySettled = true;
        return c.json(
          { error: 'auto_reply_cooldown', retryAfterSec: cooled.retryAfterSec },
          429,
        );
      }
      autoReplyReservation = cooled.reservation;
    }

    // Per-identity rate limit (rolling hour; 0 disables in config).
    const limit = checkSendLimit(from, config.sendRateLimit);
    if (!limit.allowed) {
      // 额度没扣成。占位要在记审计之前放开，且只删这张票自己的格子。
      releaseAutoReplyCooldownReservation(autoReplyReservation);
      // 429 不缓存。在写审计的 await 之前放开，避免这段时间把重试挡成 409。
      releaseSendIdempotency(reservation);
      idempotencySettled = true;
      // 每身份每窗口最多 1 条 rate_limited，避免 429 刷盘。
      const logged = claimRateLimitedLog(from)
        ? await recordSend({
            from,
            to: toList,
            subject,
            result: 'failed',
            error: 'rate_limited',
            source,
            autoReply,
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

    // 槽在准入时占上。sentAt 要等 SMTP 返回才写，回放必须用这一刻，否则慢请求重启后槽会晚过期。
    const rateLimitAt = hourlySlotAt(limit.reservation);

    try {
      const { messageId } = await sendMail({
        from,
        to: toList,
        subject,
        text,
        ...(html ? { html } : {}),
        // false 与省略都不传，避免服务端把普通 API 发信标成自动回复。
        ...(autoReply === true ? { autoReply: true } : {}),
        // 不进冷却、不改额度。inReplyTo 不写 send-log：回放不读它，省略以免改审计行。
        ...(inReplyTo ? { inReplyTo, ...(references ? { references } : {}) } : {}),
      });
      // SMTP 已接受。截止时间从这一刻起算，不依赖后面的审计追加。
      finalizeAutoReplyCooldownReservation(autoReplyReservation, config.autoReplyCooldownSec);
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
        autoReply,
        rateLimitAt,
        ...idemLog(),
      });
      const payload = queuedSendResponse(messageId, logged?.id);
      finishIdempotency(200, payload);
      return c.json(payload, 200);
    } catch (err) {
      // Our own mail server being unreachable shouldn't cost the user a slot;
      // anything the server actually answered to stays counted.
      // 冷却与额度同一口径：连接类失败放开占位；对端已经应答则从这一刻起算。
      // failureKind 仍用 isLocalSendFailure，重启后的额度/冷却回放不把 DATA 断线算进去。
      // 幂等单独看 command：DATA 及更晚表示正文可能已经写出，按 502 缓存，不放开键。
      const localFailure = isLocalSendFailure(err);
      const ambiguousDelivery = localFailure && isAmbiguousPostDataSendFailure(err);
      if (localFailure) {
        releaseSendLimit(from, limit.reservation);
        releaseAutoReplyCooldownReservation(autoReplyReservation);
        if (!ambiguousDelivery) {
          // 信还没进入 DATA。放开键，重试可以再发。这行日志不带幂等哈希。
          releaseSendIdempotency(reservation);
          idempotencySettled = true;
        }
      } else {
        finalizeAutoReplyCooldownReservation(autoReplyReservation, config.autoReplyCooldownSec);
      }
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
        failureKind: localFailure ? 'local' : 'smtp_response',
        source,
        autoReply,
        // 连接类失败（含 DATA 阶段不确定失败）已经退还额度，不留准入时刻。
        // 对端应答过的失败仍占着那一枚。
        rateLimitAt: localFailure ? undefined : rateLimitAt,
        // 对端应答，或 DATA 及更晚的断线，都留下哈希供幂等回放。
        // 更早的连接类失败上面已经放开键，不写哈希。
        // 身份已换时 idemLog 的回调也会把哈希拿掉。
        ...(localFailure && !ambiguousDelivery ? {} : idemLog()),
      });
      const payload = smtpErrorSendResponse(logged?.id);
      if (!localFailure || ambiguousDelivery) finishIdempotency(502, payload);
      return c.json(payload, 502);
    }
  } finally {
    // 还没记成已完成、也没显式放开的（意外抛出）在离开前放开，避免键永远停在占位。
    if (!idempotencySettled) releaseSendIdempotency(reservation);
  }
});
