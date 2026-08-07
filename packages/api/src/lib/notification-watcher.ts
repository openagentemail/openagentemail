/**
 * Long-lived IMAP watcher for server-side mail notifications.
 *
 * This owns one IDLE connection, unlike mail_wait_for which intentionally owns
 * one connection per caller. It starts from the current mailbox high-water
 * mark so enabling notifications never replays old mail, and reconnects after
 * a dropped IDLE socket. Recipient matching reuses the same exact primitive as
 * read authorization; a watcher must never invent a second interpretation.
 */

import { simpleParser } from 'mailparser';
import type { FetchMessageObject, ImapFlow } from 'imapflow';
import { config } from './config.ts';
import {
  findIdentity,
  listIdentities,
  resolvePushContentTier,
  type Identity,
  type PushContentTier,
} from './identities.ts';
import { connectImap, messageRecipients } from './imap.ts';
import { NotifyError, type NotifyService, notificationService } from './notify.ts';
import {
  canonicalDigits,
  extractHttpLinks,
  extractOtp,
  htmlToText,
  maskNormalizedHttpUrls,
  otpCodeRunRe,
} from './otp.ts';
import { MAX_EMAIL_HTML_LENGTH } from './sanitize-email-html.ts';

const RECONNECT_MS = 3_000;
/** Bounded plain-text preview length for tier-3 mail-arrival pushes. */
export const PUSH_BODY_PREVIEW_CHARS = 280;
/** Max OTP codes/links included in a tier-3 push (each list). */
export const PUSH_OTP_ITEM_MAX = 5;
/** Max characters per code/link entry before truncation. */
export const PUSH_OTP_ENTRY_CHARS = 200;
/**
 * Hard cap on the full ntfy message body in UTF-8 bytes. ntfy rejects ~4096
 * bytes; leave headroom for title/tags/JSON framing so one oversized mail
 * cannot make publish() throw and stall the UID watermark forever.
 * Measured as encoded bytes, not JS string length (CJK/emoji are multi-byte).
 */
export const PUSH_MESSAGE_MAX_BYTES = 3500;
/**
 * Per-field UTF-8 byte cap for tier-2+ From/Subject lines so a huge subject
 * cannot consume the whole message budget before Preview/Codes/Links.
 */
export const PUSH_META_FIELD_MAX_BYTES = 400;
/** UTF-8 ellipsis used when the body is truncated to stay under the byte budget. */
const PUSH_BODY_ELLIPSIS = '…';
const PUSH_BODY_ELLIPSIS_BYTES = Buffer.byteLength(PUSH_BODY_ELLIPSIS, 'utf8');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type WatchedMessage = Pick<FetchMessageObject, 'envelope' | 'headers' | 'source'>;

export type WatcherDispatch = {
  /** May carry NotifyInput.beforeSend for final tier/delete checks at fetch boundary. */
  publish: NotifyService['publish'];
};

/** Optional processWatchedMessage knobs (tests inject clickUrl; prod uses config). */
export type ProcessWatchedOptions = {
  /** When set, each mail-arrival push includes ntfy `click` = this URL. */
  clickUrl?: string;
  /**
   * Re-read identity immediately before each payload so a mid-flight admin
   * tier change is visible. When provided, `undefined` means the identity was
   * deleted (skip publish); when omitted, the matched snapshot is used.
   */
  refreshIdentity?: (address: string) => Identity | undefined;
};

/** In-memory watermark survives a dropped IMAP connection in this process. */
export type WatcherWatermark = { uid?: number };

export type MailContentExtras = {
  subject: string;
  from: string;
  preview: string;
  codes: string[];
  links: string[];
};

/**
 * The first successful connection starts at the mailbox high-water mark so an
 * enable does not replay old mail. Later connections reuse that watermark and
 * therefore pick up mail delivered while the socket was reconnecting.
 */
export function unseenWatcherUids(uids: number[], watermark: WatcherWatermark): number[] {
  const currentHighWater = Math.max(0, ...uids);
  if (watermark.uid === undefined) {
    watermark.uid = currentHighWater;
    return [];
  }
  return uids.filter((uid) => uid > watermark.uid!);
}

function formatAddressList(
  list: Array<{ name?: string | null; address?: string | null }> | undefined,
): string {
  if (!list?.length) return '';
  return list
    .map((entry) => {
      const address = (entry.address ?? '').trim();
      const name = (entry.name ?? '').trim();
      if (name && address) return `${name} <${address}>`;
      return address || name;
    })
    .filter(Boolean)
    .join(', ');
}

/** Cap list length and per-entry size for tier-3 OTP fields. */
export function boundPushOtpEntries(items: string[]): string[] {
  return items.slice(0, PUSH_OTP_ITEM_MAX).map((item) => {
    if (item.length <= PUSH_OTP_ENTRY_CHARS) return item;
    return `${item.slice(0, PUSH_OTP_ENTRY_CHARS)}…`;
  });
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary
 * (never mid-surrogate or mid multi-byte sequence), reserving room for `…`.
 */
export function boundTextBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  if (maxBytes < PUSH_BODY_ELLIPSIS_BYTES) return '';
  const budget = maxBytes - PUSH_BODY_ELLIPSIS_BYTES;
  if (budget <= 0) return PUSH_BODY_ELLIPSIS;

  let used = 0;
  let end = 0;
  for (const point of text) {
    const cost = Buffer.byteLength(point, 'utf8');
    if (used + cost > budget) break;
    used += cost;
    end += point.length;
  }
  return `${text.slice(0, end)}${PUSH_BODY_ELLIPSIS}`;
}

/** Enforce the total-body UTF-8 byte cap (final backstop after field caps). */
export function boundPushMessage(body: string, maxBytes = PUSH_MESSAGE_MAX_BYTES): string {
  return boundTextBytes(body, maxBytes);
}

/**
 * Mask already-extracted OTP codes/links in metadata text for tier-2 pushes.
 * Links: normalize via validatedHttpUrl then replace original spelling
 * (maskNormalizedHttpUrls). Codes: scan continuous / delimited runs via shared
 * otpCodeRunRe (Unicode Nd + seps, F68–F75); replace when the run's
 * canonicalDigits form is in the code set (F69/F75 cross-form/script).
 *
 * Membership is O(text) Set lookups on canonical digits — no multi-branch
 * needle alternation. Extract still yields original spelling (extractCodes).
 */
export function maskSensitiveFragments(
  text: string,
  codes: string[],
  links: string[],
): string {
  if (!text) return text;
  // URLs first so a full verify link is one unit before digit-code scans.
  let result = maskNormalizedHttpUrls(text, links);
  const codeSet = new Set<string>();
  for (const code of codes) {
    if (!code) continue;
    const canon = canonicalDigits(code);
    if (canon) codeSet.add(canon);
  }
  if (codeSet.size === 0) return result;
  return result.replace(otpCodeRunRe(), (run) =>
    codeSet.has(canonicalDigits(run)) ? '•••' : run,
  );
}

/**
 * Mask From/Subject for tier-2 pushes. Message-level only (depends on extras,
 * not the recipient) so processWatchedMessage can memoize once per mail.
 */
export function maskTier2Metadata(
  extras: MailContentExtras,
): { from: string; subject: string } {
  // Cap From/Subject independently so OTP/preview content still fits.
  // Tier 2 must not leak OTP/link strings in metadata. Codes: body extras +
  // extractOtp over subject/from. Links in metadata: ALL http(s) URLs
  // (extractHttpLinks — no LINK_INTENT filter) so "Verify here: https://…"
  // still redacts; extras.links stay intent-filtered for policy/tier-3 only.
  let from = extras.from;
  let subject = extras.subject;
  const metaText = [extras.from, extras.subject].filter(Boolean).join('\n');
  const metaOtp = extractOtp(metaText);
  const metaHttpLinks = extractHttpLinks(metaText);
  // Body codes enter the mask list when their digit-only form appears as any
  // continuous/delimited meta run (F69: body `123456` ↔ subject `123-456`).
  // O(|meta|) collect + O(|codes|) filter — not a per-needle scan of meta.
  // otpCodeRunRe excludes newlines so from\nsubject cannot glue digits (F70).
  const metaCanonRuns = new Set<string>();
  for (const match of metaText.matchAll(otpCodeRunRe())) {
    const canon = canonicalDigits(match[0]!);
    if (canon) metaCanonRuns.add(canon);
  }
  const maskCodes = [
    ...metaOtp.codes,
    ...extras.codes.filter((code) => metaCanonRuns.has(canonicalDigits(code))),
  ];
  const maskLinks = [...extras.links, ...metaHttpLinks];
  from = maskSensitiveFragments(from, maskCodes, maskLinks);
  subject = maskSensitiveFragments(subject, maskCodes, maskLinks);
  return { from, subject };
}

/** Build the human-facing push body for one identity's content tier. */
export function buildMailArrivalMessage(
  address: string,
  tier: PushContentTier,
  hasOtpOrLink: boolean,
  extras: MailContentExtras,
  maskedTier2Meta?: { from: string; subject: string },
): string {
  const lines: string[] = [
    hasOtpOrLink
      ? `${address} received new email (contains OTP or verification link)`
      : `${address} received new email`,
  ];

  if (tier >= 2) {
    let from = extras.from;
    let subject = extras.subject;
    if (tier < 3) {
      const masked = maskedTier2Meta ?? maskTier2Metadata(extras);
      from = masked.from;
      subject = masked.subject;
    }
    if (from) {
      lines.push(`From: ${boundTextBytes(from, PUSH_META_FIELD_MAX_BYTES)}`);
    }
    if (subject) {
      lines.push(`Subject: ${boundTextBytes(subject, PUSH_META_FIELD_MAX_BYTES)}`);
    }
  }

  if (tier >= 3) {
    if (extras.preview) lines.push(`Preview: ${extras.preview}`);
    const codes = boundPushOtpEntries(extras.codes);
    const links = boundPushOtpEntries(extras.links);
    if (codes.length) lines.push(`Codes: ${codes.join(', ')}`);
    if (links.length) lines.push(`Links:\n${links.join('\n')}`);
  }

  return boundPushMessage(lines.join('\n'));
}

/** Process one newly delivered message. Exported for policy/security tests. */
export async function processWatchedMessage(
  message: WatchedMessage,
  identities: Identity[],
  policy: 'otp' | 'all' | 'none',
  dispatch: WatcherDispatch,
  options: ProcessWatchedOptions = {},
): Promise<void> {
  if (policy === 'none') return;
  const recipients = messageRecipients(message as FetchMessageObject);
  const matched = identities.filter((identity) => recipients.has(identity.address));
  if (matched.length === 0) return;

  let hasOtpOrLink = false;
  const extras: MailContentExtras = {
    subject: typeof message.envelope?.subject === 'string' ? message.envelope.subject : '',
    from: formatAddressList(message.envelope?.from as Array<{ name?: string | null; address?: string | null }> | undefined),
    preview: '',
    codes: [],
    links: [],
  };

  if (message.source) {
    try {
      const parsed = await simpleParser(message.source);
      if (!extras.subject && typeof parsed.subject === 'string') {
        extras.subject = parsed.subject;
      }
      if (!extras.from && parsed.from?.text) {
        extras.from = parsed.from.text;
      }
      const html = typeof parsed.html === 'string' && parsed.html.length <= MAX_EMAIL_HTML_LENGTH
        ? parsed.html
        : undefined;
      const text = (parsed.text ?? '').trim() || (html ? htmlToText(html) : '');
      const otp = extractOtp(text, html);
      hasOtpOrLink = otp.codes.length > 0 || otp.links.length > 0;
      extras.codes = otp.codes;
      extras.links = otp.links;
      extras.preview = text.slice(0, PUSH_BODY_PREVIEW_CHARS);
    } catch {
      // A malformed message is never an OTP match. `all` policy still sends a
      // payload with no message content, which is safe and useful.
    }
  }
  if (policy === 'otp' && !hasOtpOrLink) return;

  const clickUrl = options.clickUrl;
  // Tier-2 metadata mask is message-level; compute at most once per mail.
  let tier2Meta: { from: string; subject: string } | undefined;
  const maxAttempts = 3;

  for (const identity of matched) {
    // Re-read per identity after await simpleParser / previous publish so a
    // concurrent tier change or DELETE is visible before the next payload.
    const refreshed = options.refreshIdentity?.(identity.address);
    // findIdentity undefined = deleted (store corrupt throws). Do not fall back
    // to the pre-parse snapshot — that would still emit tier-3 OTP after DELETE.
    if (options.refreshIdentity && !refreshed) continue;
    let current = refreshed ?? identity;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const tier = resolvePushContentTier(current);
      if (tier === 2 && !tier2Meta) tier2Meta = maskTier2Metadata(extras);
      const body = buildMailArrivalMessage(
        current.address,
        tier,
        hasOtpOrLink,
        extras,
        tier === 2 ? tier2Meta : undefined,
      );
      const level = hasOtpOrLink ? 'urgent' : 'normal';
      // Re-check at the publish fetch boundary (after publish's own awaits).
      // Abort only when privacy tightened (delete or downgrade); upgrades keep
      // the already-safe lower-tier body. `tier` is closed over per attempt.
      const beforeSend = options.refreshIdentity
        ? (): boolean => {
            const again = options.refreshIdentity!(identity.address);
            return again !== undefined && resolvePushContentTier(again) >= tier;
          }
        : undefined;
      try {
        await dispatch.publish({
          target: 'user',
          title: 'openagent.email new mail',
          message: body,
          level,
          tags: ['email'],
          // Truncate rather than throw: publish errors before UID advance stall
          // the watcher (F76). Manual /v1/notify keeps the default overflow=error.
          overflow: 'truncate',
          ...(clickUrl ? { click: clickUrl } : {}),
          ...(beforeSend ? { beforeSend } : {}),
        });
        break; // sent
      } catch (err) {
        if (!(err instanceof NotifyError && err.code === 'notify_cancelled')) throw err;
        if (!options.refreshIdentity) break;
        // Downgrade: rebuild at the safer tier. Delete: silent skip.
        const again = options.refreshIdentity(identity.address);
        if (!again) break;
        if (resolvePushContentTier(again) < tier) {
          current = again;
          continue;
        }
        break;
      }
    }
  }
}

async function watchConnection(
  signal: AbortSignal,
  client: ImapFlow,
  dispatch: WatcherDispatch,
  watermark: WatcherWatermark,
): Promise<void> {
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  try {
    lock = await client.getMailboxLock('INBOX');
    const initial = await client.search({ all: true }, { uid: true });
    let pending = unseenWatcherUids(Array.isArray(initial) ? initial : [], watermark);

    while (!signal.aborted) {
      if (pending.length > 0) {
        for await (const message of client.fetch(
          pending,
          { envelope: true, headers: ['delivered-to'], source: true },
          { uid: true },
        )) {
          await processWatchedMessage(
            message,
            listIdentities(),
            config.ntfy.pushPolicy,
            dispatch,
            {
              clickUrl: config.dashboardPublicUrl,
              // O(1) indexed lookup; mtime/invalidate cache still sees tier PUTs.
              refreshIdentity: (address) => findIdentity(address),
            },
          );
          watermark.uid = Math.max(watermark.uid ?? 0, message.uid);
        }
      }
      pending = [];

      // IDLE gives prompt delivery where the server reports EXISTS, while the
      // heartbeat keeps this watcher correct on servers that occasionally keep
      // an IDLE command open after mail arrives. Socket errors still escape to
      // the outer reconnect loop instead of leaving a stale watcher forever.
      await Promise.race([client.idle(), sleep(3_000)]);
      if (signal.aborted) break;
      const found = await client.search({ all: true }, { uid: true });
      pending = unseenWatcherUids(Array.isArray(found) ? found : [], watermark);
    }
  } finally {
    lock?.release();
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    }
  }
}

async function runWatcher(signal: AbortSignal, dispatch: WatcherDispatch): Promise<void> {
  const watermark: WatcherWatermark = {};
  while (!signal.aborted) {
    try {
      const client = await connectImap();
      await watchConnection(signal, client, dispatch, watermark);
    } catch (err) {
      if (!signal.aborted) console.warn('[notify] IMAP watcher reconnecting:', (err as Error).message);
    }
    if (!signal.aborted) await sleep(RECONNECT_MS);
  }
}

let watcherAbort: AbortController | undefined;

/** Start one process-wide watcher; calling it again returns the same stopper. */
export function startNotificationWatcher(): () => void {
  if (!config.ntfy.enabled || config.ntfy.pushPolicy === 'none') return () => {};
  if (!watcherAbort) {
    watcherAbort = new AbortController();
    void runWatcher(watcherAbort.signal, { publish: notificationService().publish.bind(notificationService()) });
  }
  return () => {
    watcherAbort?.abort();
    watcherAbort = undefined;
  };
}
