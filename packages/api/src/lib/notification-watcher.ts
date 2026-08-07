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
 * Continuous alnum OTP for tier-2 *metadata only* (F77/F81/F86/F95): 4–8 alnum
 * (ASCII and/or fullwidth). Accepted after match when mixed (letter+digit) or
 * letter-only all-caps (F95). Bounds exclude adjacent alnum (incl. fullwidth)
 * so CJK-glued forms still match.
 */
const META_ALNUM_OTP_RE = new RegExp(
  `${META_ALNUM_BOUND_LEFT}([${META_ALNUM_CHAR}]{4,8})${META_ALNUM_BOUND_RIGHT}`,
  'g',
);

/**
 * Delimited mixed alnum OTP (F84/F85/F86): 2–4 groups of 2–4 alnum
 * (ASCII + fullwidth).
 *
 * Non-whitespace seps (hyphen/dash/dot/fullwidth) allow 2–4 groups with F74-style
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
 */
const META_ALNUM_SEP_TIGHT = '[-–—.\uFF0D\uFF0E]';
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

/** NFKC then require ≥1 Latin letter and ≥1 digit (F86 fullwidth → ASCII). */
function isMixedAlnumOtp(form: string): boolean {
  const nfkc = form.normalize('NFKC');
  return /[A-Za-z]/.test(nfkc) && /[0-9]/.test(nfkc);
}

/**
 * Letter-only continuous OTP for tier-2 metadata under a strong cue (F95).
 * NFKC then `/^[A-Z]{4,8}$/`: real letter-only codes are almost always
 * shouted (`WXYZ`); all-uppercase excludes prose (`pending`, `Ready`, `wxyz`).
 * Fullwidth uppercase (ＷＸＹＺ) NFKC-normalizes to ASCII and is covered.
 *
 * Tradeoff under the strong-cue gate: an all-caps non-code word of length 4–8
 * (e.g. `READY` in `Your verification code is READY NOW`) is masked — accepted
 * for the metadata privacy boundary; the rest of the subject stays readable.
 *
 * Delimited letter-only forms (`WX-YZ`) are out of scope: this predicate only
 * matches continuous tokens, so tight/space loops never accept them.
 */
function isLetterOnlyOtp(form: string): boolean {
  return /^[A-Z]{4,8}$/.test(form.normalize('NFKC'));
}

/** Mixed alnum or strongly labeled letter-only continuous form (F77/F95). */
function isMetaAlnumOtpForm(form: string): boolean {
  return isMixedAlnumOtp(form) || isLetterOnlyOtp(form);
}

function splitSpaceAlnumGroups(form: string): string[] {
  return form.split(new RegExp(META_ALNUM_SEP_SPACE)).filter(Boolean);
}

function nfkcGroup(g: string): string {
  return g.normalize('NFKC');
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
 * Collect alnum OTPs from from/subject when a strong cue is present
 * (F77/F81 continuous + F84 tight delimited + F85 space runs + F86 fullwidth +
 * F95 letter-only all-caps continuous). Does not touch body extract semantics.
 */
export function extractMetaAlnumCodes(metaText: string): string[] {
  if (!metaText || !hasStrongOtpCue(metaText)) return [];
  const codes: string[] = [];
  const seen = new Set<string>();
  const push = (form: string) => {
    // Delimited letter-only (WX-YZ) stays rejected: isLetterOnlyOtp is continuous-only.
    if (!isMetaAlnumOtpForm(form) || seen.has(form)) return;
    seen.add(form);
    codes.push(form);
  };
  // Space digit-bearing runs first: whole-chain consume, then 2–4 accept / 5+ drop.
  for (const match of metaText.matchAll(META_ALNUM_DELIMITED_SPACE_DIGIT)) {
    const form = match[1]!;
    if (!isPlausibleSpaceDigitRun(form)) continue;
    push(form);
  }
  for (const match of metaText.matchAll(META_ALNUM_DELIMITED_SPACE_CLASSIC)) {
    const form = match[1]!;
    if (!isPlausibleSpaceClassic(form)) continue;
    push(form);
  }
  for (const match of metaText.matchAll(META_ALNUM_OTP_RE)) {
    push(match[1]!);
  }
  for (const match of metaText.matchAll(META_ALNUM_DELIMITED_TIGHT)) {
    const form = match[1]!;
    // Year-shaped pure-digit groups (Mar - 2026) — privacy-safe to skip (F87 nit).
    const groups = form
      .split(new RegExp(`${META_ALNUM_SEP_RUN_WITH_TIGHT}`))
      .map((g) => g.trim())
      .filter(Boolean);
    if (groups.some((g) => /^(19|20)\d{2}$/.test(g.normalize('NFKC')))) continue;
    push(form);
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
      packedWith.droppedLinks > 0 &&
      maxNoClick > maxWithClick
    ) {
      const packedNo = packTier3ArrivalBody(
        head,
        codesLine,
        extras.preview,
        extras.links,
        maxNoClick,
      );
      // Prefer fewer link evictions; publish() click-drop (F76) delivers the
      // larger body. Equal eviction → keep with-click packing (click survives).
      if (packedNo.droppedLinks < packedWith.droppedLinks) {
        return packedNo.body;
      }
    }
    return packedWith.body;
  }

  // Tier 1–2: raw byte bound is fine (no long verify links).
  return boundPushMessage(
    lines.join('\n'),
    Math.min(PUSH_MESSAGE_MAX_BYTES, maxWithClick),
  );
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
