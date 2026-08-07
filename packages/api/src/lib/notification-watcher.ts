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
  hasStrongOtpCue,
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

/** Cap list length and per-entry size for tier-3 OTP *code* fields. */
export function boundPushOtpEntries(items: string[]): string[] {
  return items.slice(0, PUSH_OTP_ITEM_MAX).map((item) => {
    if (item.length <= PUSH_OTP_ENTRY_CHARS) return item;
    return `${item.slice(0, PUSH_OTP_ENTRY_CHARS)}…`;
  });
}

/**
 * Tier-3 verification links must stay complete (F79) — truncating mid-token
 * yields unusable URLs. Keep full strings up to PUSH_OTP_ITEM_MAX; callers pack
 * under the total body byte budget and omit the tail with an honest note.
 */
export function boundPushLinkEntries(items: string[]): string[] {
  return items.slice(0, PUSH_OTP_ITEM_MAX);
}

const MORE_LINKS_NOTE = (n: number) =>
  `(+${n} more links, open the dashboard to view)`;

/**
 * Pack full verification links under the remaining UTF-8 body budget (F79).
 * Never mid-truncates a URL; drops the tail and appends a +N note when needed.
 */
export function packPushLinkLines(
  baseBody: string,
  links: string[],
  maxBytes = PUSH_MESSAGE_MAX_BYTES,
): string[] {
  if (links.length === 0) return [];
  const candidates = boundPushLinkEntries(links);
  let dropped = Math.max(0, links.length - candidates.length);
  const kept: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const tryKept = [...kept, candidates[i]!];
    const stillDrop = dropped + (candidates.length - tryKept.length);
    const note = stillDrop > 0 ? `\n${MORE_LINKS_NOTE(stillDrop)}` : '';
    const trial = `${baseBody}\nLinks:\n${tryKept.join('\n')}${note}`;
    if (Buffer.byteLength(trial, 'utf8') <= maxBytes) {
      kept.push(candidates[i]!);
      continue;
    }
    dropped += candidates.length - kept.length;
    break;
  }

  if (kept.length === 0) {
    // Even one full link does not fit; prefer an honest note over a broken URL.
    if (links.length > 0) {
      const onlyNote = `${baseBody}\nLinks:\n${MORE_LINKS_NOTE(links.length)}`;
      if (Buffer.byteLength(onlyNote, 'utf8') <= maxBytes) {
        return [`Links:\n${MORE_LINKS_NOTE(links.length)}`];
      }
    }
    return [];
  }

  const out = [`Links:\n${kept.join('\n')}`];
  // dropped already includes candidates not kept + beyond PUSH_OTP_ITEM_MAX.
  if (dropped > 0) out.push(MORE_LINKS_NOTE(dropped));
  return out;
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
 * Alphanumeric OTP shape for tier-2 *metadata only* (F77/F81): 4–8 ASCII alnum
 * with at least one letter and one digit (aligned with digit-code min length 4).
 * Bounds exclude adjacent alnum so CJK-glued `验证码是A1B2C3` still matches.
 */
const META_ALNUM_OTP_RE = /(?<![A-Za-z0-9])([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/g;

function isMixedAlnumOtp(form: string): boolean {
  return /[A-Za-z]/.test(form) && /[0-9]/.test(form);
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect alnum OTPs from from/subject when a strong cue is present (F77/F81).
 * Does not touch body extractCodes / extractOtp semantics.
 */
export function extractMetaAlnumCodes(metaText: string): string[] {
  if (!metaText || !hasStrongOtpCue(metaText)) return [];
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const match of metaText.matchAll(META_ALNUM_OTP_RE)) {
    const form = match[1]!;
    if (!isMixedAlnumOtp(form) || seen.has(form)) continue;
    seen.add(form);
    codes.push(form);
  }
  return codes;
}

/**
 * One global regex that masks every exact alnum form in a single left-to-right
 * pass (F83). Forms are length-desc so longer spellings win at each position.
 * Empty input → null (caller skips). Exported for structural unit tests.
 */
export function buildAlnumMaskRe(forms: string[]): RegExp | null {
  if (forms.length === 0) return null;
  // Dedupe while preserving longest-first order for alternation priority.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const form of [...forms].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    if (!form || seen.has(form)) continue;
    seen.add(form);
    ordered.push(form);
  }
  if (ordered.length === 0) return null;
  const alt = ordered.map(escapeRegExpLiteral).join('|');
  return new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, 'g');
}

/**
 * Mask already-extracted OTP codes/links in metadata text for tier-2 pushes.
 * Links: normalize via validatedHttpUrl then replace original spelling
 * (maskNormalizedHttpUrls). Digit codes: otpCodeRunRe + canonicalDigits
 * (F69/F75). Alnum codes (F77/F83): single alternation replace with alnum bounds.
 */
export function maskSensitiveFragments(
  text: string,
  codes: string[],
  links: string[],
): string {
  if (!text) return text;
  // URLs first so a full verify link is one unit before digit-code scans.
  let result = maskNormalizedHttpUrls(text, links);
  const digitCanon = new Set<string>();
  const exactAlnum: string[] = [];
  for (const code of codes) {
    if (!code) continue;
    if (isMixedAlnumOtp(code)) {
      exactAlnum.push(code);
      continue;
    }
    const canon = canonicalDigits(code);
    if (canon) digitCanon.add(canon);
  }
  if (digitCanon.size > 0) {
    result = result.replace(otpCodeRunRe(), (run) =>
      digitCanon.has(canonicalDigits(run)) ? '•••' : run,
    );
  }
  const alnumRe = buildAlnumMaskRe(exactAlnum);
  if (alnumRe) {
    result = result.replace(alnumRe, '•••');
  }
  return result;
}

/**
 * Truncate plain-text preview on a Unicode code-point boundary (F82).
 * Avoids lone surrogates from `String#slice` mid-emoji. Count is code points,
 * same numeric cap as PUSH_BODY_PREVIEW_CHARS.
 */
export function boundPreviewChars(text: string, maxChars = PUSH_BODY_PREVIEW_CHARS): string {
  if (!text) return text;
  let count = 0;
  let end = 0;
  for (const point of text) {
    if (count >= maxChars) break;
    count += 1;
    end += point.length;
  }
  return text.slice(0, end);
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
    // Strong-cue alnum OTPs in metadata only (F77) — not body extract.
    ...extractMetaAlnumCodes(metaText),
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
    if (codes.length) lines.push(`Codes: ${codes.join(', ')}`);
    // Links: full URLs only; pack under total body budget (F79).
    const baseForLinks = lines.join('\n');
    lines.push(...packPushLinkLines(baseForLinks, extras.links));
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
      extras.preview = boundPreviewChars(text, PUSH_BODY_PREVIEW_CHARS);
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
