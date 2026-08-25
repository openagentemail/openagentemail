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
import {
  jsonEscapedByteLength,
  isNotifyServiceFailure,
  notifyAvailableMessageBytes,
  NotifyError,
  type NotifyService,
  notificationService,
} from './notify.ts';
import {
  canonicalDigits,
  extractHttpLinks,
  extractOtp,
  hasStrongOtpCue,
  htmlToText,
  maskNormalizedHttpUrls,
  otpCodeRunRe,
  STRONG_OTP_CUES,
} from './otp.ts';
import { MAX_EMAIL_HTML_LENGTH } from './sanitize-email-html.ts';
import { approvalEventForWatcher } from './tasks.ts';
import { truncateUtf8Bytes } from './utf8-truncate.ts';

const RECONNECT_INITIAL_MS = 2_000;
const RECONNECT_MAX_MS = 120_000;
const RECONNECT_STABLE_MS = 30_000;
const PUBLISH_MAX_ATTEMPTS = 3;
const PUBLISH_RETRY_INITIAL_MS = 250;
const PUBLISH_RETRY_MAX_MS = 500;
const SERVICE_FAILURE_MAX_MS = 10 * 60_000;
const WATCHER_ERROR_LOG_MAX_BYTES = 512;
const WATCHER_ERROR_TRUNCATED = '… [truncated]';
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
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    resolve();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
});

function watcherErrorLogMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const encoded = Buffer.from(message, 'utf8');
  if (encoded.length <= WATCHER_ERROR_LOG_MAX_BYTES) return message;
  const markerBytes = Buffer.byteLength(WATCHER_ERROR_TRUNCATED, 'utf8');
  return truncateUtf8Bytes(encoded, WATCHER_ERROR_LOG_MAX_BYTES - markerBytes).toString('utf8') +
    WATCHER_ERROR_TRUNCATED;
}

async function waitForReconnect(
  wait: typeof sleep,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([wait(ms, signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

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
  /** @internal Retry timer injection; production uses the module sleep helper. */
  wait?: (ms: number) => Promise<void>;
  /** @internal Identity-level poison logging injection. */
  error?: typeof console.error;
};

/** In-memory watermark survives a dropped IMAP connection in this process. */
export type WatcherWatermark = {
  uid?: number;
  uidValidity?: bigint;
  /** @internal First provider-wide failure for the blocked UID, across reconnects. */
  serviceFailure?: { uid: number; sinceMs: number };
};

export type MailContentExtras = {
  subject: string;
  from: string;
  preview: string;
  codes: string[];
  links: string[];
};

class WatcherPublishError extends Error {
  readonly attempts: number;
  readonly reason: unknown;

  constructor(attempts: number, reason: unknown) {
    super(watcherErrorLogMessage(reason));
    this.name = 'WatcherPublishError';
    this.attempts = attempts;
    this.reason = reason;
  }
}

async function publishWithRetry(
  publish: () => ReturnType<NotifyService['publish']>,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    try {
      await publish();
      return;
    } catch (err) {
      if (err instanceof NotifyError && err.code === 'notify_cancelled') throw err;
      lastError = err;
      if (attempt < PUBLISH_MAX_ATTEMPTS) {
        await wait(Math.min(PUBLISH_RETRY_INITIAL_MS * 2 ** (attempt - 1), PUBLISH_RETRY_MAX_MS));
      }
    }
  }
  throw new WatcherPublishError(PUBLISH_MAX_ATTEMPTS, lastError);
}

/**
 * The first successful connection starts at the mailbox high-water mark so an
 * enable does not replay old mail. Later connections reuse that watermark and
 * therefore pick up mail delivered while the socket was reconnecting.
 * F111: a recreated mailbox (new UIDVALIDITY) restarts UIDs from scratch, so
 * the old numeric watermark would reject every replacement message until its
 * counter climbs back; re-anchor at the new generation's high-water mark.
 * F115: only the FIRST sight of a generation keeps the no-replay startup
 * behavior. When an already-observed mailbox changes UIDVALIDITY, the
 * replacement INBOX may already hold mail delivered during the disconnect —
 * treat every current UID as pending so reconnects still catch offline
 * deliveries.
 * F118: the replacement generation starts BELOW all pending UIDs (UIDs
 * restart at 1) instead of at the high-water mark, so the watcher's
 * per-message advancement only records mail that was actually processed — a
 * transient publish failure retries the remainder on reconnect rather than
 * losing it to a prematurely raised watermark.
 */
export function unseenWatcherUids(
  uids: number[],
  watermark: WatcherWatermark,
  uidValidity?: bigint,
): number[] {
  const currentHighWater = Math.max(0, ...uids);
  if (uidValidity !== undefined && watermark.uidValidity !== uidValidity) {
    const firstSight = watermark.uidValidity === undefined;
    // First sight of this mailbox generation, or a recreated INBOX: re-anchor
    // instead of comparing against the previous generation's UIDs.
    watermark.uidValidity = uidValidity;
    watermark.serviceFailure = undefined;
    if (firstSight) {
      watermark.uid = currentHighWater;
      return [];
    }
    watermark.uid = 0;
    return uids.slice();
  }
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
 * Pack full verification links under the remaining **JSON-escaped** body budget
 * (F79/F88). Never mid-truncates a URL; drops the tail and appends a +N note.
 * Measure with jsonEscapedByteLength so packing matches ntfy publish framing.
 */
export function packPushLinkLines(
  baseBody: string,
  links: string[],
  maxEscapedBytes = PUSH_MESSAGE_MAX_BYTES,
  measure: (text: string) => number = jsonEscapedByteLength,
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
    if (measure(trial) <= maxEscapedBytes) {
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
      if (measure(onlyNote) <= maxEscapedBytes) {
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
 * Truncate plain text so its JSON-escaped form is ≤ maxEscapedBytes (F88).
 * Prefer whole code points; used for Preview when packing under ntfy budget.
 */
export function boundPreviewByEscapedBytes(text: string, maxEscapedBytes: number): string {
  if (jsonEscapedByteLength(text) <= maxEscapedBytes) return text;
  if (maxEscapedBytes <= 0) return '';
  let used = 0;
  let end = 0;
  for (const point of text) {
    const cost = jsonEscapedByteLength(point);
    if (used + cost > maxEscapedBytes) break;
    used += cost;
    end += point.length;
  }
  return text.slice(0, end);
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
 * ASCII + fullwidth Latin letters/digits only (F86). Explicit FF ranges —
 * never `\p{L}` / Alphabetic (would swallow CJK and break glue bounds).
 */
const META_ALNUM_CHAR = 'A-Za-z0-9\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A';
const META_ALNUM_BOUND_LEFT = `(?<![${META_ALNUM_CHAR}])`;
const META_ALNUM_BOUND_RIGHT = `(?![${META_ALNUM_CHAR}])`;
/** Letters only (ASCII + fullwidth) for classic space forms. */
const META_ALNUM_LETTER = 'A-Za-z\\uFF21-\\uFF3A\\uFF41-\\uFF5A';
/** Digits only (ASCII + fullwidth) for classic space forms / year checks. */
const META_ALNUM_DIGIT = '0-9\\uFF10-\\uFF19';

/**
 * Continuous alnum OTP for tier-2 *metadata only* (F77/F81/F86/F95/F101): 4–8
 * alnum (ASCII and/or fullwidth). Accepted after match when mixed (letter+digit)
 * or letter-only continuous case-insensitive (F101). Bounds exclude adjacent
 * alnum (incl. fullwidth) so CJK-glued forms still match.
 */
const META_ALNUM_OTP_RE = new RegExp(
  `${META_ALNUM_BOUND_LEFT}([${META_ALNUM_CHAR}]{4,8})${META_ALNUM_BOUND_RIGHT}`,
  'g',
);

/**
 * Delimited mixed alnum OTP (F84/F85/F86): 2–4 groups of 2–4 alnum
 * (ASCII + fullwidth).
 *
 * Non-whitespace seps (hyphen/dash/dot/slash + fullwidth) allow 2–4 groups with F74-style
 * mid-chain lead/tail guards.
 *
 * Whitespace seps (F85):
 * - Longest run of **digit-bearing** groups (`A1 B2 C3`) so English words never
 *   join the chain; accept 2–4 groups, reject 5+ whole.
 * - Classic two-group letter-block (3–4 letters) + digit-block (`ABC 123`).
 * No “tail rejects more space+alnum” half-window: consume the full run then decide.
 *
 * Pure-digit forms are left to the digit delimited path (≥1 letter + ≥1 digit).
 */
const META_ALNUM_GROUP = `[${META_ALNUM_CHAR}]{2,4}`;
/**
 * Split of otp.ts DELIMITED_OTP_SEP_CLASS: non-whitespace vs whitespace.
 * F87: sep runs of 1–3 that include **at least one tight** sep so `ABC - 123`
 * and `ABC--123` match, while pure-space chains stay on F85 paths and English
 * `code is ABC-123` cannot glue via space-only gaps.
 * F112: slash (ASCII + fullwidth) joins the tight class — `A1/B2` metadata
 * codes bypassed every matcher; URLs are unaffected (link-masked first).
 * F121: nonbreaking hyphen U+2011 and its NFKC form U+2010 join too —
 * `AB‑12` (U+2011) published unmasked; NFKC maps U+2011 → U+2010, so the
 * compatibility pass only recovers it when both are in the class.
 */
const META_ALNUM_SEP_TIGHT = '[-–—./\u2010\u2011\uFF0D\uFF0E\uFF0F]';
const META_ALNUM_SEP_SPACE =
  '[\\t \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000\\uFEFF]';
const T = META_ALNUM_SEP_TIGHT;
const S = META_ALNUM_SEP_SPACE;
/** 1–3 seps with ≥1 tight char (enumerated; max length 3). */
const META_ALNUM_SEP_RUN_WITH_TIGHT =
  `(?:${T}|${T}${T}|${T}${T}${T}|${T}${S}|${S}${T}|${T}${S}${T}|${T}${T}${S}|${S}${T}${T}|${T}${S}${S}|${S}${T}${S}|${S}${S}${T})`;
/**
 * Mid-chain lead: alnum then a sep-run that ends in a tight sep
 * (blocks `AB - CD` starting at CD; allows `is ABC-123` after a bare space).
 */
const META_ALNUM_LEAD_MID =
  `(?<![${META_ALNUM_CHAR}](?:${S}|${T}){0,2}${T})`;
// 2–4 groups with mixed sep runs that include a tight separator (F87).
const META_ALNUM_DELIMITED_TIGHT = new RegExp(
  `${META_ALNUM_LEAD_MID}${META_ALNUM_BOUND_LEFT}` +
    `(${META_ALNUM_GROUP}(?:${META_ALNUM_SEP_RUN_WITH_TIGHT}${META_ALNUM_GROUP}){1,3})` +
    `(?!${META_ALNUM_SEP_RUN_WITH_TIGHT}[${META_ALNUM_CHAR}])${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/**
 * Tight-delimited single-character chains (F105): 4–8 groups of exactly 1
 * alnum (`A-1-B-2`). LEAD_MID + the tail guard reject 9+-group chains whole
 * (no mid-chain restart after a tight sep). Candidate only — acceptance is
 * the predicate: joined form must be mixed (letter+digit); letter-only chains
 * stay rejected (delimited letter-only = F97 uppercase 2–4 groups of 2–4).
 */
const META_ALNUM_DELIMITED_TIGHT_SINGLE = new RegExp(
  `${META_ALNUM_LEAD_MID}${META_ALNUM_BOUND_LEFT}` +
    `([${META_ALNUM_CHAR}](?:${META_ALNUM_SEP_RUN_WITH_TIGHT}[${META_ALNUM_CHAR}]){3,7})` +
    `(?!${META_ALNUM_SEP_RUN_WITH_TIGHT}[${META_ALNUM_CHAR}])${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/**
 * Bounded single-separator delimited pair (F117 colon, F124 underscore):
 * 2–4 groups of 2–4 alnum, and 4–8 single-char chains, joined by ONE sep
 * each. The separator stays OUT of the tight class on purpose:
 * - colon would glue `x:ABC-123` into mid-chain blocks and URLs/versions into
 *   unrelated matchers;
 * - underscore is a word char — snake_case tokens (`otp_code`) would glue.
 * Pure-digit joins (12:30) and letter-only joins (snake_case words) drop at
 * the push() predicate; http(s) URLs are link-masked before the alnum pass.
 */
function boundedDelimitedMatchers(sepClass: string): { multi: RegExp; single: RegExp } {
  /** Lead: not immediately after `alnum<sep>` (blocks mid-chain restarts). */
  const lead = `(?<![${META_ALNUM_CHAR}]${sepClass})`;
  return {
    multi: new RegExp(
      `${lead}${META_ALNUM_BOUND_LEFT}` +
        `(${META_ALNUM_GROUP}(?:${sepClass}${META_ALNUM_GROUP}){1,3})` +
        `(?!${sepClass}[${META_ALNUM_CHAR}])${META_ALNUM_BOUND_RIGHT}`,
      'g',
    ),
    single: new RegExp(
      `${lead}${META_ALNUM_BOUND_LEFT}` +
        `([${META_ALNUM_CHAR}](?:${sepClass}[${META_ALNUM_CHAR}]){3,7})` +
        `(?!${sepClass}[${META_ALNUM_CHAR}])${META_ALNUM_BOUND_RIGHT}`,
      'g',
    ),
  };
}

/** Single-chain acceptance for one separator class: NFKC, split on sep runs,
 * 4–8 groups of exactly 1 char. Mixed/letter acceptance happens in push() via
 * isMetaAlnumOtpForm — pure-digit and letter-only chains drop there.
 */
function singleChainPredicate(sepClass: string): (form: string) => boolean {
  const splitRe = new RegExp(`${sepClass}+`);
  return (form) => {
    const parts = form.normalize('NFKC').split(splitRe).filter(Boolean);
    return parts.length >= 4 && parts.length <= 8 && parts.every((g) => g.length === 1);
  };
}

/** F117: `AB:12:CD`, `A:1:B:2` (ASCII + fullwidth colon). */
const META_ALNUM_SEP_COLON = '[:：]';
const META_ALNUM_DELIMITED_COLON_PAIR = boundedDelimitedMatchers(META_ALNUM_SEP_COLON);
const isPlausibleColonSingleChain = singleChainPredicate(META_ALNUM_SEP_COLON);
/** F124: `AB_12`, `A_1_B_2` (ASCII + fullwidth underscore). */
const META_ALNUM_SEP_UNDER = '[_＿]';
const META_ALNUM_DELIMITED_UNDER_PAIR = boundedDelimitedMatchers(META_ALNUM_SEP_UNDER);
const isPlausibleUnderSingleChain = singleChainPredicate(META_ALNUM_SEP_UNDER);
/**
 * 2–4 alnum chars that include a digit after NFKC (lookahead fixes length).
 * Used for space runs so pure-letter English tokens are not groups.
 */
const META_ALNUM_GROUP_WITH_DIGIT =
  `(?=[${META_ALNUM_CHAR}]{2,4}(?![${META_ALNUM_CHAR}]))` +
  `(?=[${META_ALNUM_CHAR}]*[${META_ALNUM_DIGIT}])` +
  `[${META_ALNUM_CHAR}]{2,4}`;
// Longest space-separated digit-bearing group run (F85).
const META_ALNUM_DELIMITED_SPACE_DIGIT = new RegExp(
  `${META_ALNUM_BOUND_LEFT}` +
    `(${META_ALNUM_GROUP_WITH_DIGIT}(?:${META_ALNUM_SEP_SPACE}${META_ALNUM_GROUP_WITH_DIGIT})+)` +
    `${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
// Classic `ABC 123` / fullwidth (letter block 3–4 + digit block 2–4).
const META_ALNUM_DELIMITED_SPACE_CLASSIC = new RegExp(
  `${META_ALNUM_BOUND_LEFT}` +
    `([${META_ALNUM_LETTER}]{3,4}${META_ALNUM_SEP_SPACE}[${META_ALNUM_DIGIT}]{2,4})` +
    `${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/**
 * 2–4 all-caps letter groups of 2–4 (ASCII A–Z + fullwidth FF21–FF3A),
 * space-joined (F97). Uppercase-only groups prevent English glue (`code is WX YZ`
 * must not form one space chain). isLetterOnlyDelimitedOtp still NFKC-checks.
 */
const META_ALNUM_UPPER = 'A-Z\\uFF21-\\uFF3A';
const META_ALNUM_GROUP_UPPER =
  `(?=[${META_ALNUM_UPPER}]{2,4}(?![${META_ALNUM_CHAR}]))` +
  `[${META_ALNUM_UPPER}]{2,4}`;
const META_ALNUM_DELIMITED_SPACE_LETTER = new RegExp(
  `${META_ALNUM_BOUND_LEFT}` +
    `(${META_ALNUM_GROUP_UPPER}(?:${META_ALNUM_SEP_SPACE}${META_ALNUM_GROUP_UPPER})+)` +
    `${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/**
 * Space-separated single-character chains (F106): `A 1 B 2`. Each internal
 * group is a single alnum **not glued to a following alnum**, so the run
 * cannot eat the first char of a following word (`A 1 B 2 today` stops at
 * `2`). Unbounded consume: the whole run is matched, then the predicate
 * accepts 4–8 groups / drops others whole (F85 doctrine). Candidate only —
 * mixed acceptance happens in push(); pure-digit and letter-only chains drop.
 */
const META_ALNUM_SINGLE = `[${META_ALNUM_CHAR}](?![${META_ALNUM_CHAR}])`;
const META_ALNUM_DELIMITED_SPACE_SINGLE = new RegExp(
  `${META_ALNUM_BOUND_LEFT}` +
    `([${META_ALNUM_CHAR}](?:${META_ALNUM_SEP_SPACE}+${META_ALNUM_SINGLE})+)` +
    `${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/**
 * Mixed-separator single-character chains (F109): `A 1-B 2` — sep runs mixing
 * whitespace and tight chars of any length between 4–8 groups of exactly 1
 * alnum. Whole-run consume + SINGLE tail chars mirror F106: a following word's
 * first char cannot join, and a 9+-group chain drops whole at the predicate.
 * Pure-space chains stay F106's; push()'s seen set dedupes any overlap.
 */
const META_ALNUM_SEP_RUN_MIXED = `(?:${META_ALNUM_SEP_TIGHT}|${META_ALNUM_SEP_SPACE})+`;
const META_ALNUM_DELIMITED_MIXED_SINGLE = new RegExp(
  `${META_ALNUM_BOUND_LEFT}` +
    `([${META_ALNUM_CHAR}](?:${META_ALNUM_SEP_RUN_MIXED}${META_ALNUM_SINGLE})+)` +
    `${META_ALNUM_BOUND_RIGHT}`,
  'g',
);
/** Split form into groups on any tight or space sep run (F97). */
const META_ALNUM_SEP_ANY_RUN = new RegExp(
  `(?:${META_ALNUM_SEP_TIGHT}|${META_ALNUM_SEP_SPACE})+`,
);

/** NFKC then require ≥1 Latin letter and ≥1 digit (F86 fullwidth → ASCII). */
function isMixedAlnumOtp(form: string): boolean {
  const nfkc = form.normalize('NFKC');
  return /[A-Za-z]/.test(nfkc) && /[0-9]/.test(nfkc);
}

/**
 * Code-shaped alnum form (F134–F136): mixed letter+digit, or shouted
 * letter-only with separators stripped (`WXYZ`, `A-B-C-D`). Cue words the
 * masking path deliberately over-extracts (`Your`, `code`, title/lowercase
 * words) are not codes — not listed at tier 3, and per F136 not an OTP
 * classification signal either.
 */
function isDisplayableAlnumCode(form: string): boolean {
  // A shouted cue word (`CODE`, `OTP`) labeling a real code is not itself
  // a code — listing/waking on it is noise.
  if ((STRONG_OTP_CUES as readonly string[]).includes(form.normalize('NFKC').toLowerCase())) {
    return false;
  }
  if (isMixedAlnumOtp(form)) return true;
  const core = form.normalize('NFKC').split(META_ALNUM_SEP_ANY_RUN).join('');
  return /^[A-Z]{4,8}$/.test(core);
}

/**
 * Letter-only continuous OTP for tier-2 metadata under a strong cue (F95/F101).
 * NFKC then `/^[A-Za-z]{4,8}$/` — case-insensitive continuous tokens so
 * lowercase/title-case codes (`abcd`, `Abcd`) mask like shouted `ABCD`.
 * Fullwidth letters NFKC-normalize to ASCII and are covered.
 *
 * Scope is **continuous only**. Delimited letter-only (F97) stays all-caps:
 * lowercase hyphens would over-mask English compounds (`sign-in`, `follow-up`).
 *
 * Tradeoff under the strong-cue gate: any 4–8 letter word (ready/here/valid/
 * Pending) is masked — privacy over readability; the rest of the subject stays.
 */
function isLetterOnlyOtp(form: string): boolean {
  return /^[A-Za-z]{4,8}$/.test(form.normalize('NFKC'));
}

/**
 * Letter-only delimited OTP under a strong cue (F97): NFKC, split on tight or
 * space sep runs, require 2–4 groups each `/^[A-Z]{2,4}$/` (uppercase only —
 * F101 does **not** relax this). Tradeoff: all-caps acronym chains under a
 * strong cue (`NASA HQ`, `GO NOW`) may mask — accepted for privacy.
 *
 * Tight path reuses META_ALNUM_DELIMITED_TIGHT; space path uses
 * META_ALNUM_DELIMITED_SPACE_LETTER (consume full run, reject 5+ whole).
 */
function isLetterOnlyDelimitedOtp(form: string): boolean {
  const parts = form
    .normalize('NFKC')
    .split(META_ALNUM_SEP_ANY_RUN)
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((g) => /^[A-Z]{2,4}$/.test(g));
}

/**
 * Letter-only single-char chain OTP under a strong cue (F135): NFKC, split
 * on any sep run, 4–8 groups of exactly 1 letter. All-caps only, mirroring
 * the delimited letter-only scope (F97) — lowercase chains (`a b c d`) stay
 * rejected so English prose is not over-masked.
 */
function isLetterOnlySingleChainOtp(form: string): boolean {
  const parts = form
    .normalize('NFKC')
    .split(META_ALNUM_SEP_ANY_RUN)
    .filter(Boolean);
  return parts.length >= 4 && parts.length <= 8 && parts.every((g) => /^[A-Z]$/.test(g));
}

/** Mixed, letter-only continuous/delimited/single-chain form (F77/F95/F97/F135). */
function isMetaAlnumOtpForm(form: string): boolean {
  return (
    isMixedAlnumOtp(form) ||
    isLetterOnlyOtp(form) ||
    isLetterOnlyDelimitedOtp(form) ||
    isLetterOnlySingleChainOtp(form)
  );
}

function splitSpaceAlnumGroups(form: string): string[] {
  return form.split(new RegExp(META_ALNUM_SEP_SPACE)).filter(Boolean);
}

function nfkcGroup(g: string): string {
  return g.normalize('NFKC');
}

/** Accept space letter-only run: 2–4 all-caps groups (5+ refused whole, F97). */
function isPlausibleSpaceLetterRun(form: string): boolean {
  return isLetterOnlyDelimitedOtp(form);
}

/**
 * Accept a tight single-char chain (F105): NFKC, split on any sep run, 4–8
 * groups of exactly 1 char. Mixed/letter acceptance happens in push() via
 * isMetaAlnumOtpForm — letter-only chains pass since F135; pure-digit drops.
 */
function isPlausibleSingleChain(form: string): boolean {
  const parts = form
    .normalize('NFKC')
    .split(META_ALNUM_SEP_ANY_RUN)
    .filter(Boolean);
  return parts.length >= 4 && parts.length <= 8 && parts.every((g) => g.length === 1);
}

/**
 * Accept a space single-char chain (F106): NFKC, split on space runs, 4–8
 * groups of exactly 1 char. Mixed/letter acceptance happens in push() via
 * isMetaAlnumOtpForm — letter-only chains pass since F135; pure-digit drops.
 */
function isPlausibleSpaceSingleChain(form: string): boolean {
  const parts = form
    .normalize('NFKC')
    .split(new RegExp(`${META_ALNUM_SEP_SPACE}+`))
    .filter(Boolean);
  return parts.length >= 4 && parts.length <= 8 && parts.every((g) => g.length === 1);
}

/** Accept a digit-bearing space run: 2–4 groups only (5+ refused whole). */
function isPlausibleSpaceDigitRun(form: string): boolean {
  if (!isMixedAlnumOtp(form)) return false;
  const parts = splitSpaceAlnumGroups(form);
  if (parts.length < 2 || parts.length > 4) return false;
  // Digit check after NFKC so fullwidth digits count; reject year-shaped groups.
  return parts.every((g) => {
    const n = nfkcGroup(g);
    return /[0-9]/.test(n) && !/^(19|20)\d{2}$/.test(n);
  });
}

/** Accept classic two-group letter-block + digit-block (`ABC 123` / fullwidth). */
function isPlausibleSpaceClassic(form: string): boolean {
  if (!isMixedAlnumOtp(form)) return false;
  const parts = splitSpaceAlnumGroups(form);
  if (parts.length !== 2) return false;
  const letters = nfkcGroup(parts[0]!);
  const digits = nfkcGroup(parts[1]!);
  if (!/^[A-Za-z]{3,4}$/.test(letters)) return false;
  if (!/^[0-9]{2,4}$/.test(digits)) return false;
  if (/^(19|20)\d{2}$/.test(digits)) return false;
  return true;
}

function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * NFKC-normalize per code point, remembering for every normalized UTF-16 unit
 * the source-unit offset it came from (F113). Per-code-point normalization is
 * deliberate: the map only needs to be self-consistent for span recovery.
 */
function nfkcWithSourceMap(text: string): { normalized: string; map: number[] } {
  const parts: string[] = [];
  const map: number[] = [];
  let unit = 0;
  for (const ch of text) {
    const norm = ch.normalize('NFKC');
    parts.push(norm);
    for (let k = 0; k < norm.length; k++) map.push(unit);
    unit += ch.length;
  }
  return { normalized: parts.join(''), map };
}

/**
 * Run every metadata alnum matcher on `text` and report each accepted form
 * with its span in the scanned text. Every matcher wraps its single capture
 * in zero-width lookarounds, so the match start is the form start.
 */
function collectMetaAlnumForms(
  text: string,
  report: (form: string, start: number, end: number) => void,
): void {
  const emit = (match: RegExpMatchArray) => {
    const form = match[1]!;
    const start = (match.index ?? 0) + match[0]!.indexOf(form);
    report(form, start, start + form.length);
  };
  // Space digit-bearing runs first: whole-chain consume, then 2–4 accept / 5+ drop.
  for (const match of text.matchAll(META_ALNUM_DELIMITED_SPACE_DIGIT)) {
    const form = match[1]!;
    if (!isPlausibleSpaceDigitRun(form)) continue;
    emit(match);
  }
  for (const match of text.matchAll(META_ALNUM_DELIMITED_SPACE_CLASSIC)) {
    const form = match[1]!;
    if (!isPlausibleSpaceClassic(form)) continue;
    emit(match);
  }
  // F97: space letter-only runs (`WX YZ`); 2–4 groups after full-run consume.
  for (const match of text.matchAll(META_ALNUM_DELIMITED_SPACE_LETTER)) {
    const form = match[1]!;
    if (!isPlausibleSpaceLetterRun(form)) continue;
    emit(match);
  }
  for (const match of text.matchAll(META_ALNUM_OTP_RE)) {
    emit(match);
  }
  for (const match of text.matchAll(META_ALNUM_DELIMITED_TIGHT)) {
    const form = match[1]!;
    // Year-shaped pure-digit groups (Mar - 2026) — privacy-safe to skip (F87 nit).
    const groups = form
      .split(new RegExp(`${META_ALNUM_SEP_RUN_WITH_TIGHT}`))
      .map((g) => g.trim())
      .filter(Boolean);
    if (groups.some((g) => /^(19|20)\d{2}$/.test(g.normalize('NFKC')))) continue;
    emit(match);
  }
  // F105: tight single-char chains (`A-1-B-2`); mixed passes push(), pure-digit
  // and letter-only chains drop at the predicate.
  for (const match of text.matchAll(META_ALNUM_DELIMITED_TIGHT_SINGLE)) {
    const form = match[1]!;
    if (!isPlausibleSingleChain(form)) continue;
    emit(match);
  }
  // F106: space single-char chains (`A 1 B 2`); same predicate split as F105.
  for (const match of text.matchAll(META_ALNUM_DELIMITED_SPACE_SINGLE)) {
    const form = match[1]!;
    if (!isPlausibleSpaceSingleChain(form)) continue;
    emit(match);
  }
  // F109: mixed-separator single-char chains (`A 1-B 2`); same predicate as
  // F105 — overlaps with the tight/space matchers dedupe in push().
  for (const match of text.matchAll(META_ALNUM_DELIMITED_MIXED_SINGLE)) {
    const form = match[1]!;
    if (!isPlausibleSingleChain(form)) continue;
    emit(match);
  }
  // F117/F124: colon- and underscore-delimited forms (`AB:12:CD`, `AB_12` and
  // single-char chains) — bounded matcher pairs, neither separator joins the
  // tight class.
  for (const pair of [
    { sep: META_ALNUM_SEP_COLON, matchers: META_ALNUM_DELIMITED_COLON_PAIR, plausible: isPlausibleColonSingleChain },
    { sep: META_ALNUM_SEP_UNDER, matchers: META_ALNUM_DELIMITED_UNDER_PAIR, plausible: isPlausibleUnderSingleChain },
  ]) {
    for (const match of text.matchAll(pair.matchers.multi)) {
      const form = match[1]!;
      const groups = form.split(new RegExp(`${pair.sep}+`)).filter(Boolean);
      if (groups.some((g) => /^(19|20)\d{2}$/.test(g.normalize('NFKC')))) continue;
      emit(match);
    }
    for (const match of text.matchAll(pair.matchers.single)) {
      const form = match[1]!;
      if (!pair.plausible(form)) continue;
      emit(match);
    }
  }
}

/**
 * Collect alnum OTPs from from/subject when a strong cue is present
 * (F77/F81 continuous + F84 tight delimited + F85 space runs + F86 fullwidth +
 * F95 letter-only continuous + F97 letter-only delimited + F105 tight
 * single-char chains + F106 space single-char chains + F109 mixed-separator
 * single-char chains + F113 compatibility forms + F117 colon-delimited +
 * F124 underscore-delimited forms). Does not touch body extract semantics.
 *
 * F113: compatibility characters beyond the fullwidth ranges (Ⓐ①Ⓑ②, 𝐀𝟏𝐁𝟐)
 * normalize to valid codes but never matched the classes above. When NFKC
 * changes the text, the same matchers run once more on the normalized string
 * and each hit is mapped back to its original span so masking keeps the
 * source spelling.
 */
export function extractMetaAlnumCodes(metaText: string): string[] {
  if (!metaText || !hasStrongOtpCue(metaText)) return [];
  const codes: string[] = [];
  const seen = new Set<string>();
  const push = (form: string) => {
    if (!isMetaAlnumOtpForm(form) || seen.has(form)) return;
    seen.add(form);
    codes.push(form);
  };
  collectMetaAlnumForms(metaText, (form) => push(form));
  const { normalized, map } = nfkcWithSourceMap(metaText);
  if (normalized !== metaText) {
    collectMetaAlnumForms(normalized, (_form, start, end) => {
      const sourceStart = map[start]!;
      const sourceEnd = end < normalized.length ? map[end]! : metaText.length;
      if (sourceEnd > sourceStart) push(metaText.slice(sourceStart, sourceEnd));
    });
  }
  return codes;
}

/**
 * One global regex that masks every exact alnum form in a single left-to-right
 * pass (F83/F84). Forms are length-desc so longer spellings win at each
 * position. Separators in forms (e.g. `ABC-123`) are escaped as literals.
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
  // Bounds include fullwidth alnum (F86) so we do not leave a half-run next to
  // longer fullwidth tokens; hyphens/spaces/CJK still allow a match.
  return new RegExp(
    `${META_ALNUM_BOUND_LEFT}(?:${alt})${META_ALNUM_BOUND_RIGHT}`,
    'g',
  );
}

/**
 * Mask already-extracted OTP codes/links in metadata text for tier-2 pushes.
 * Links: normalize via validatedHttpUrl then replace original spelling
 * (maskNormalizedHttpUrls). Alnum codes (F77/F83/F91/F95): exact-form
 * alternation before digit runs so `ABC-1234` is not half-masked to `ABC-•••`
 * when both spellings are in the code set, and letter-only `WXYZ` is bucketed
 * as exact alnum (not silently dropped via empty canonicalDigits). Digit codes:
 * otpCodeRunRe + canonicalDigits (F69/F75) after alnum.
 */
export function maskSensitiveFragments(
  text: string,
  codes: string[],
  links: string[],
): string {
  if (!text) return text;
  // URLs first so a full verify link is one unit before code scans.
  let result = maskNormalizedHttpUrls(text, links);
  const digitCanon = new Set<string>();
  const exactAlnum: string[] = [];
  for (const code of codes) {
    if (!code) continue;
    if (isMetaAlnumOtpForm(code)) {
      exactAlnum.push(code);
      continue;
    }
    const canon = canonicalDigits(code);
    if (canon) digitCanon.add(canon);
  }
  // F91: alnum spans before digit sub-runs — digit pass would otherwise rewrite
  // `ABC-1234` → `ABC-•••` and leave a non-matching `ABC-` prefix leak.
  const alnumRe = buildAlnumMaskRe(exactAlnum);
  if (alnumRe) {
    result = result.replace(alnumRe, '•••');
  }
  if (digitCanon.size > 0) {
    result = result.replace(otpCodeRunRe(), (run) =>
      digitCanon.has(canonicalDigits(run)) ? '•••' : run,
    );
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
  //
  // F120: cap metadata BEFORE extraction/masking. Only the capped prefixes are
  // ever published (buildMailArrivalMessage re-caps at PUSH_META_FIELD_MAX_BYTES),
  // so scanning untrusted full-length headers just lets a strong-cue subject
  // with thousands of distinct tokens compile one enormous masking alternation
  // and stall the single watcher. The window keeps 64 extra code points so any
  // form starting inside the published prefix (max form ~30 chars) still ends
  // inside the window and gets masked — no half-form leak at the cut.
  let from = boundPreviewChars(extras.from, PUSH_META_FIELD_MAX_BYTES + 64);
  let subject = boundPreviewChars(extras.subject, PUSH_META_FIELD_MAX_BYTES + 64);
  const metaText = [from, subject].filter(Boolean).join('\n');
  const metaOtp = extractOtp(metaText);
  const metaHttpLinks = extractHttpLinks(metaText);
  // Body codes enter the mask list when their digit-only form appears as any
  // continuous/delimited meta run (F69: body `123456` ↔ subject `123-456`).
  // O(|meta|) collect + O(|codes|) filter — not a per-needle scan of meta.
  // otpCodeRunRe excludes newlines so from\nsubject cannot glue digits (F70).
  const metaCanonRuns = new Set<string>();
  // Surface spellings of meta digit runs (continuous + delimited shapes).
  const metaDigitSurfaces: string[] = [];
  for (const match of metaText.matchAll(otpCodeRunRe())) {
    const surface = match[0]!;
    const canon = canonicalDigits(surface);
    if (!canon) continue;
    metaCanonRuns.add(canon);
    metaDigitSurfaces.push(surface);
  }
  // F102: under a strong cue on joined meta, every meta digit run joins
  // maskCodes by surface form — no KEYWORD_WINDOW / body confirmation.
  // Side effects: strong-cue subject can mask years/order ids and a digit run
  // only in From when Subject carries the cue — privacy over readability.
  const strongMetaCue = hasStrongOtpCue(metaText);
  // Alnum meta extract is **per field** (each needs its own strong cue) so a
  // cue on Subject does not treat From localparts like `auth`/`example` as
  // letter-only OTPs under F101 case-insensitive continuous matching.
  const maskCodes = [
    ...metaOtp.codes,
    // F138: code-shaped alnum extras enter by exact/normalized form too —
    // `Reference A1B2` has no cue and no digit run, so the digit-canon
    // filter alone published the repeated body code unchanged.
    ...extras.codes.filter(
      (code) => metaCanonRuns.has(canonicalDigits(code)) || isMetaAlnumOtpForm(code),
    ),
    ...extractMetaAlnumCodes(subject),
    ...extractMetaAlnumCodes(from),
    ...(strongMetaCue ? metaDigitSurfaces : []),
  ];
  const maskLinks = [...extras.links, ...metaHttpLinks];
  from = maskSensitiveFragments(from, maskCodes, maskLinks);
  subject = maskSensitiveFragments(subject, maskCodes, maskLinks);
  return { from, subject };
}

/** Options for packing under the live ntfy JSON message budget (F88). */
export type BuildMailArrivalOptions = {
  /** When set, framing budget accounts for ntfy click (with click-drop). */
  clickUrl?: string;
};

/** How many input links were omitted from a packPushLinkLines result. */
function countDroppedPackedLinks(links: string[], linkLines: string[]): number {
  if (links.length === 0) return 0;
  let kept = 0;
  for (const line of linkLines) {
    if (!line.startsWith('Links:\n')) continue;
    for (const part of line.slice('Links:\n'.length).split('\n')) {
      // Note-only block is `Links:\n(+N more…)` — not a kept URL.
      if (part && !part.startsWith('(+')) kept += 1;
    }
  }
  return Math.max(0, links.length - kept);
}

/**
 * Pack tier-3 body under one escaped-byte budget (F88 order: links first,
 * preview eats remainder). Returns the body plus how many links were evicted.
 */
function packTier3ArrivalBody(
  head: string,
  codesLine: string,
  previewSource: string,
  links: string[],
  maxEscaped: number,
): { body: string; droppedLinks: number } {
  const baseNoPreview = head + (codesLine ? `\n${codesLine}` : '');
  const linkLines = packPushLinkLines(baseNoPreview, links, maxEscaped);
  const withLinks =
    linkLines.length > 0 ? `${baseNoPreview}\n${linkLines.join('\n')}` : baseNoPreview;

  let previewLine = '';
  if (previewSource) {
    const roomForPreview =
      maxEscaped -
      jsonEscapedByteLength(withLinks) -
      jsonEscapedByteLength('\nPreview: ');
    if (roomForPreview > 0) {
      const trimmed = boundPreviewByEscapedBytes(previewSource, roomForPreview);
      if (trimmed) previewLine = `Preview: ${trimmed}`;
    }
  }

  // Assembly: title/From/Subject → Preview → Codes → Links.
  const parts = [head];
  if (previewLine) parts.push(previewLine);
  if (codesLine) parts.push(codesLine);
  if (linkLines.length > 0) parts.push(...linkLines);
  return {
    body: parts.join('\n'),
    droppedLinks: countDroppedPackedLinks(links, linkLines),
  };
}

/** Build the human-facing push body for one identity's content tier. */
export function buildMailArrivalMessage(
  address: string,
  tier: PushContentTier,
  hasOtpOrLink: boolean,
  extras: MailContentExtras,
  maskedTier2Meta?: { from: string; subject: string },
  options: BuildMailArrivalOptions = {},
): string {
  // Pack under the JSON-escaped message budget so full links survive publish()
  // serialization (F88). Conservative max topic length matches ntfy cap.
  const level = hasOtpOrLink ? 'urgent' : 'normal';
  const frameBase = {
    title: 'openagent.email new mail',
    level: level as 'urgent' | 'normal',
    tags: ['email'],
  };
  const availableWithClick = notifyAvailableMessageBytes({
    ...frameBase,
    click: options.clickUrl,
  });
  const availableNoClick = notifyAvailableMessageBytes(frameBase);
  // F93 dual budgets for tier-3 packing: ntfy residual with/without click.
  // Both sides use the same residual source (notifyAvailableMessageBytes); we
  // deliberately do **not** min with historical PUSH_MESSAGE_MAX_BYTES (3500)
  // here — that undercut a larger no-click residual (~3846) and evicted links
  // that publish()'s click-drop could still deliver. Tier 1–2 still use the
  // historical raw-byte cap below.
  const maxWithClick = availableWithClick;
  const maxNoClick = availableNoClick;

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
    const codes = boundPushOtpEntries(extras.codes);
    const codesLine = codes.length ? `Codes: ${codes.join(', ')}` : '';
    const head = lines.join('\n');
    // Prefer with-click packing so click survives when everything fits (F93).
    const packedWith = packTier3ArrivalBody(
      head,
      codesLine,
      extras.preview,
      extras.links,
      maxWithClick,
    );
    if (
      options.clickUrl &&
      maxNoClick > maxWithClick
    ) {
      // F125: when the head alone is over the with-click budget the click
      // cannot survive this payload at all — any with-click degradation
      // (omitted/truncated preview) was for nothing, so also repack no-click.
      const clickDoomed = jsonEscapedByteLength(packedWith.body) > maxWithClick;
      if (clickDoomed || packedWith.droppedLinks > 0) {
        const packedNo = packTier3ArrivalBody(
          head,
          codesLine,
          extras.preview,
          extras.links,
          maxNoClick,
        );
        // Click doomed → roomier pack retains more preview, publish()'s
        // click-drop (F76) delivers it minus the action. Otherwise prefer
        // fewer link evictions; equal eviction → keep with-click packing.
        if (clickDoomed || packedNo.droppedLinks < packedWith.droppedLinks) {
          return packedNo.body;
        }
      }
    }
    return packedWith.body;
  }

  // Tier 1–2: raw byte bound is fine (no long verify links).
  const body = lines.join('\n');
  const withClickCap = Math.min(PUSH_MESSAGE_MAX_BYTES, maxWithClick);
  // F123: never truncate the core alert to preserve the click action — a long
  // DASHBOARD_PUBLIC_URL would otherwise shrink the with-click budget below
  // the interrupt text itself (`fox@example.…`). When the body only fits
  // without the click, pack under the no-click budget; publish()'s click-drop
  // fallback (F76) delivers it minus the action.
  if (options.clickUrl && Buffer.byteLength(body, 'utf8') > withClickCap) {
    return boundPushMessage(body, Math.min(PUSH_MESSAGE_MAX_BYTES, maxNoClick));
  }
  return boundPushMessage(body, withClickCap);
}

/** ASCII lowercase letter → fullwidth twin for cue-window surfaces (F139). */
function toFullwidthLatin(s: string): string {
  return s.replace(/[a-z]/g, (ch) => String.fromCodePoint(0xff41 + ch.codePointAt(0)! - 0x61));
}

/**
 * Body window around one strong cue for alnum extraction (F139): 160
 * code points each side covers cue-before/code-after phrasing with margin.
 */
const ALNUM_BODY_CUE_WINDOW = 160;

/**
 * Cue alternation for locating body windows on the ORIGINAL text (F139).
 * Latin cues case-insensitive with word bounds; CJK cues and fullwidth-
 * Latin spellings as substrings (hasStrongOtpCue reaches fullwidth forms
 * through NFKC, which window finding cannot run without index drift).
 */
const BODY_CUE_WINDOW_SOURCE = ((): string => {
  const latin: string[] = [];
  const other: string[] = [];
  for (const cue of STRONG_OTP_CUES) {
    if (/^[a-z]+(?:-[a-z]+)*$/.test(cue)) {
      latin.push(escapeRegExpLiteral(cue));
      other.push(escapeRegExpLiteral(toFullwidthLatin(cue)));
    } else {
      other.push(escapeRegExpLiteral(cue));
    }
  }
  return `\\b(?:${latin.join('|')})\\b|${other.join('|')}`;
})();

/**
 * Bounded body windows around strong OTP cues (F139): alnum extraction
 * runs per window, never over the whole untrusted body — one cue inside a
 * multi-MB message must not turn every full-string regex/NFKC pass into a
 * seconds-long stall while the single watcher awaits each message, and a
 * shouted word far from any cue is not an OTP signal. Overlapping windows
 * merge; a fresh regex instance per call keeps scans concurrency-safe.
 */
function bodyAlnumCueWindows(text: string): string[] {
  const windows: string[] = [];
  const re = new RegExp(BODY_CUE_WINDOW_SOURCE, 'giu');
  let start = -1;
  let end = -1;
  for (const m of text.matchAll(re)) {
    const wStart = Math.max(0, (m.index ?? 0) - ALNUM_BODY_CUE_WINDOW);
    const wEnd = Math.min(text.length, (m.index ?? 0) + m[0].length + ALNUM_BODY_CUE_WINDOW);
    if (start === -1) {
      start = wStart;
      end = wEnd;
    } else if (wStart <= end) {
      end = Math.max(end, wEnd);
    } else {
      windows.push(text.slice(start, end));
      start = wStart;
      end = wEnd;
    }
  }
  if (start !== -1) windows.push(text.slice(start, end));
  return windows;
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
  let approvalPreview: string | null = null;
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
      const parsedText = (parsed.text ?? '').trim();
      const htmlText = html ? htmlToText(html) : '';
      const text = parsedText || htmlText;
      const otp = extractOtp(text, html);
      hasOtpOrLink = otp.codes.length > 0 || otp.links.length > 0;
      extras.codes = otp.codes;
      extras.links = otp.links;
      // F137: strongly cued alphanumeric BODY codes classify too (the
      // subject path F134/F136 covered only metadata). Same code-shaped
      // filter. Bodies never publish at tier ≤2, so no masking path here.
      // F139: extraction runs on bounded cue windows, not the whole body.
      // F140: scan the HTML alternative too — extractOtp already scans both
      // parts, and a stub plain-text part (`open in an HTML client`) must
      // not hide an HTML-only credential from the otp policy.
      for (const scanText of new Set([text, htmlText].filter(Boolean))) {
        for (const cueWindow of bodyAlnumCueWindows(scanText)) {
          for (const code of extractMetaAlnumCodes(cueWindow)) {
            if (!isDisplayableAlnumCode(code)) continue;
            hasOtpOrLink = true;
            if (!extras.codes.includes(code)) extras.codes.push(code);
          }
        }
      }
      extras.preview = boundPreviewChars(text, PUSH_BODY_PREVIEW_CHARS);
      const approval = await approvalEventForWatcher(message as FetchMessageObject);
      if (approval) {
        approvalPreview = approval.type === 'request'
          ? 'Approval request recorded. Open the task dashboard to review.'
          : approval.type === 'decision'
            ? `Approval decision recorded: ${approval.decision}.`
            : 'Approval expired.';
        // A trusted approval push is intentionally metadata-only. Do not let
        // arbitrary action arguments/body be reintroduced through OTP/links.
        extras.preview = approvalPreview;
        extras.codes = [];
        extras.links = [];
        hasOtpOrLink = false;
      }
    } catch {
      // A malformed message is never an OTP match. `all` policy still sends a
      // payload with no message content, which is safe and useful.
    }
  }
  // F110: classify on the subject too — a subject-only code or verify link
  // (`Subject: Your verification code is 123456` with a plain body) must still
  // pass the `otp` policy. The subject line itself shows at tier ≥2 (masked at
  // tier 2). F116/F119: ALWAYS merge subject credentials into extras (deduped)
  // — tier 3 would otherwise truncate a long signed subject URL at the
  // metadata cap and publish an unusable partial link, even when the body
  // independently matched.
  if (extras.subject && !approvalPreview) {
    const subjectOtp = extractOtp(extras.subject);
    hasOtpOrLink =
      hasOtpOrLink || subjectOtp.codes.length > 0 || subjectOtp.links.length > 0;
    for (const code of subjectOtp.codes) {
      if (!extras.codes.includes(code)) extras.codes.push(code);
    }
    for (const link of subjectOtp.links) {
      if (!extras.links.includes(link)) extras.links.push(link);
    }
    // F134: strongly cued alphanumeric subject codes classify too — the
    // tier-2 mask path (extractMetaAlnumCodes) already recognizes `A1B2`,
    // but numeric-only extractOtp misses it, and the default `otp` policy
    // would silently drop the notification. Classification takes every
    // strongly cued form; `Codes:` display takes only code-shaped forms so
    // over-extracted cue words (`Your`, `code`) stay out of tier 3.
    const subjectAlnum = extractMetaAlnumCodes(extras.subject);
    // F136: classify only on code-shaped candidates — `Error code has
    // expired` over-extracts English words for masking but is not an OTP.
    if (subjectAlnum.some(isDisplayableAlnumCode)) hasOtpOrLink = true;
    for (const code of subjectAlnum) {
      if (!isDisplayableAlnumCode(code)) continue;
      if (!extras.codes.includes(code)) extras.codes.push(code);
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
      const level = hasOtpOrLink ? 'urgent' : 'normal';
      const body = buildMailArrivalMessage(
        current.address,
        tier,
        hasOtpOrLink,
        extras,
        tier === 2 ? tier2Meta : undefined,
        { clickUrl: options.clickUrl },
      );
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
        await publishWithRetry(
          () => dispatch.publish({
            target: 'user',
            title: 'openagent.email new mail',
            message: body,
            level,
            tags: ['email'],
            // Truncate rather than throw: publish errors before UID advance stall
            // the watcher (F76). Manual /v1/notify keeps the default overflow=error.
            overflow: 'truncate',
            source: 'watcher',
            logicalChannel: 'user-alerts',
            // tier 3 才把正文/OTP 送出服务器；与 level 正交，供 UI 默认遮蔽。
            sensitive: tier === 3,
            identityAddress: current.address,
            ...(clickUrl ? { click: clickUrl } : {}),
            ...(beforeSend ? { beforeSend } : {}),
          }),
          options.wait ?? sleep,
        );
        break; // sent
      } catch (err) {
        if (err instanceof WatcherPublishError) {
          if (isNotifyServiceFailure(err.reason)) throw err;
          (options.error ?? console.error)(
            `[notify] IMAP watcher skipped identity ${current.address} after ${err.attempts} publish attempts:`,
            watcherErrorLogMessage(err.reason),
          );
          break;
        }
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

type WatchConnectionRuntime = {
  identities: typeof listIdentities;
  identity: typeof findIdentity;
  wait: typeof sleep;
  error: typeof console.error;
  now: typeof Date.now;
};

/** @internal Exported so poison-message batch progression can be regression-tested. */
export async function watchConnection(
  signal: AbortSignal,
  client: ImapFlow,
  dispatch: WatcherDispatch,
  watermark: WatcherWatermark,
  runtime: WatchConnectionRuntime = {
    identities: listIdentities,
    identity: findIdentity,
    wait: sleep,
    error: console.error,
    now: Date.now,
  },
): Promise<void> {
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  let consecutivePublishSkips = 0;
  try {
    lock = await client.getMailboxLock('INBOX');
    // F111: track the selected mailbox generation so a recreated INBOX
    // re-anchors the watermark instead of starving notifications.
    // (client.mailbox is `false | MailboxObject` before/without selection.)
    const uidValidity = client.mailbox ? client.mailbox.uidValidity : undefined;
    const initial = await client.search({ all: true }, { uid: true });
    let pending = unseenWatcherUids(Array.isArray(initial) ? initial : [], watermark, uidValidity);

    while (!signal.aborted) {
      if (pending.length > 0) {
        for await (const message of client.fetch(
          pending,
          { envelope: true, headers: ['delivered-to'], source: true },
          { uid: true },
        )) {
          try {
            await processWatchedMessage(
              message,
              runtime.identities(),
              config.ntfy.pushPolicy,
              dispatch,
              {
                clickUrl: config.dashboardPublicUrl,
                // O(1) indexed lookup; mtime/invalidate cache still sees tier PUTs.
                refreshIdentity: (address) => runtime.identity(address),
                wait: runtime.wait,
                error: runtime.error,
              },
            );
            consecutivePublishSkips = 0;
            watermark.serviceFailure = undefined;
          } catch (err) {
            if (!(err instanceof WatcherPublishError)) throw err;
            if (isNotifyServiceFailure(err.reason)) {
              const now = runtime.now();
              const observed = watermark.serviceFailure;
              if (!observed || observed.uid !== message.uid) {
                watermark.serviceFailure = { uid: message.uid, sinceMs: now };
                throw err;
              }
              const unavailableMs = Math.max(0, now - observed.sinceMs);
              if (unavailableMs < SERVICE_FAILURE_MAX_MS) throw err;
              runtime.error(
                `[notify] CRITICAL IMAP watcher abandoned UID ${message.uid} after notification service ` +
                  `failure persisted for ${unavailableMs}ms (hard limit: ${SERVICE_FAILURE_MAX_MS}ms):`,
                watcherErrorLogMessage(err.reason),
              );
            } else {
              consecutivePublishSkips += 1;
              runtime.error(
                `[notify] IMAP watcher skipped UID ${message.uid} after ${err.attempts} publish attempts ` +
                  `(consecutive skips: ${consecutivePublishSkips}):`,
                watcherErrorLogMessage(err.reason),
              );
            }
            watermark.serviceFailure = undefined;
          }
          watermark.uid = Math.max(watermark.uid ?? 0, message.uid);
        }
      }
      pending = [];

      // IDLE gives prompt delivery where the server reports EXISTS, while the
      // heartbeat keeps this watcher correct on servers that occasionally keep
      // an IDLE command open after mail arrives. Socket errors still escape to
      // the outer reconnect loop instead of leaving a stale watcher forever.
      await Promise.race([client.idle(), runtime.wait(3_000)]);
      if (signal.aborted) break;
      const found = await client.search({ all: true }, { uid: true });
      pending = unseenWatcherUids(Array.isArray(found) ? found : [], watermark, uidValidity);
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

type WatcherRuntime = {
  connect: typeof connectImap;
  watch: typeof watchConnection;
  wait: typeof sleep;
  warn: typeof console.warn;
  connectionId: string;
  now: typeof Date.now;
};

/** @internal Exported so the reconnect/error boundary can be regression-tested. */
export async function runWatcher(
  signal: AbortSignal,
  dispatch: WatcherDispatch,
  runtime: WatcherRuntime = {
    connect: connectImap,
    watch: watchConnection,
    wait: sleep,
    warn: console.warn,
    connectionId: `${config.imap.host}:${config.imap.port}`,
    now: Date.now,
  },
): Promise<void> {
  const watermark: WatcherWatermark = {};
  let reconnectMs = RECONNECT_INITIAL_MS;
  while (!signal.aborted) {
    let connectedAt: number | undefined;
    try {
      const client = await runtime.connect();
      connectedAt = runtime.now();
      const onError = (err: unknown) => {
        runtime.warn(
          `[notify] IMAP watcher connection ${runtime.connectionId} error:`,
          watcherErrorLogMessage(err),
        );
        // ImapFlow emits connection errors outside the awaited command chain.
        // Closing makes the active IDLE/search fail into the reconnect guard.
        try {
          client.close();
        } catch {
          /* already closed */
        }
      };
      client.on('error', onError);
      try {
        await runtime.watch(signal, client, dispatch, watermark);
      } finally {
        client.off('error', onError);
      }
    } catch (err) {
      if (!signal.aborted) {
        runtime.warn(
          `[notify] IMAP watcher connection ${runtime.connectionId} reconnecting:`,
          watcherErrorLogMessage(err),
        );
      }
    }
    if (signal.aborted) break;
    if (connectedAt !== undefined && runtime.now() - connectedAt >= RECONNECT_STABLE_MS) {
      reconnectMs = RECONNECT_INITIAL_MS;
    }
    await waitForReconnect(runtime.wait, reconnectMs, signal);
    if (signal.aborted) break;
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
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
