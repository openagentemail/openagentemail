/**
 * OTP / verification-link extraction. Pure functions — no I/O — so they
 * are unit-testable against sample mails (see test/otp.test.ts).
 *
 * - codes: 4–8 digit sequences that appear near a keyword
 *   (code / verification / otp / passcode / 验证码 / 动态码 / ...).
 * - links: URLs (from the HTML part's anchors or bare URLs in text) whose
 *   URL or anchor text matches verif|confirm|activate|reset|signin|login.
 */

/**
 * Keywords that unlock continuous 4–8 digit extraction (any nearby match).
 * Exported so alignment tests can keep STRONG_OTP_CUES in sync (F71).
 */
export const CODE_KEYWORDS = [
  'code',
  'verification',
  'verify',
  'otp',
  'one-time',
  'one time',
  'passcode',
  'security code',
  'confirmation',
  'pin',
  '验证码',
  '动态码',
  '校验码',
  '確認コード',
  '認証コード',
] as const;

/**
 * Strong cues for year-shaped continuous codes (F65) and delimited forms
 * (F68/F71). Only terms that *themselves* mean "a code" / PIN / OTP.
 *
 * Not listed as array entries (weak / action / generic — still in
 * CODE_KEYWORDS for continuous non-year extract): verification, verify,
 * confirmation, one-time, one time. Those alone must not unlock year PIN or
 * delimited OTP. The phrase "security code" is also kept out of this array
 * as a whole, but bare `\bcode\b` still matches inside it — intentional so
 * Microsoft/Discord-style "security code" mail keeps strong paths.
 */
export const STRONG_OTP_CUES = [
  'code',
  'otp',
  'passcode',
  'pin',
  '验证码',
  '动态码',
  '校验码',
  '確認コード',
  '認証コード',
] as const;

const LINK_INTENT = /verif|confirm|activate|reset|signin|sign-in|login|log-in/i;

/** How many characters around a digit run to scan for a keyword. */
const KEYWORD_WINDOW = 80;

/** Escape a literal for embedding in a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Built from STRONG_OTP_CUES so Latin tokens keep word boundaries and CJK/JP
 * tokens match as substrings (same surface as the former hand-written re).
 */
function buildStrongOtpCueRe(cues: readonly string[]): RegExp {
  const latin: string[] = [];
  const other: string[] = [];
  for (const cue of cues) {
    if (/^[a-z]+(?:-[a-z]+)*$/i.test(cue)) latin.push(escapeRegExp(cue));
    else other.push(escapeRegExp(cue));
  }
  const parts: string[] = [];
  if (latin.length > 0) parts.push(`\\b(?:${latin.join('|')})\\b`);
  parts.push(...other);
  return new RegExp(parts.join('|'));
}

const STRONG_OTP_CUE = buildStrongOtpCueRe(STRONG_OTP_CUES);

/**
 * True when text contains a strong OTP cue (F71 list; case-folded for Latin).
 * NFKC first so compatibility-form cues match: fullwidth `ｃｏｄｅ` lowercases
 * to fullwidth, never to ASCII `code`, so a labeled fullwidth subject would
 * otherwise bypass tier-2 masking entirely (F103).
 */
export function hasStrongOtpCue(text: string): boolean {
  return STRONG_OTP_CUE.test(text.normalize('NFKC').toLowerCase());
}

export function htmlToText(html: string): string {
  let s = html;
  // Drop non-content blocks entirely.
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
  // Keep anchor destinations visible so bare-URL extraction still works.
  s = s.replace(/<a\b[^>]*>/gi, ' ');
  // Block-level boundaries become newlines (open and close tags).
  s = s.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|table|ul|ol)>/gi, '\n');
  s = s.replace(/<(p|div|li|tr|td|th|h[1-6]|section|article|table|ul|ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Inline tags vanish WITHOUT a space — codes are often split across
  // spans ("G- <span>77</span><span>4102</span>") and must rejoin.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Tidy whitespace per line, collapse blank runs.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Numeric entities come from untrusted mail, so an out-of-range code point
 * must not throw (String.fromCodePoint raises RangeError above U+10FFFF) and
 * must not survive as digits either — `&#99999999;` left as text would be
 * mistaken for an 8-digit OTP. Lone surrogates are dropped for the same
 * reason: they only produce mojibake in the JSON response.
 */
function codePointToString(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return '';
  if (cp >= 0xd800 && cp <= 0xdfff) return '';
  return String.fromCodePoint(cp);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => codePointToString(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePointToString(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Unicode decimal digit (F75). JS `\d` is ASCII-only; fullwidth / Arabic-Indic
 * / etc. need `\p{Nd}` with the `u` flag on every consuming pattern.
 */
const ND = '\\p{Nd}';

/**
 * OTP token edges (F75). Equivalent to classic `\b` for ASCII `\w` text, but
 * treats any `\p{Nd}` as a "word" char so fullwidth/Arabic runs get edges.
 * **Must not** use `\p{L}` — CJK letters would then glue to ASCII digits and
 * break `验证码是123456` (CJK is non-word under old `\b` and must stay that way).
 */
const OTP_BOUND_LEFT = `(?<![A-Za-z0-9_${ND}])`;
const OTP_BOUND_RIGHT = `(?![A-Za-z0-9_${ND}])`;

/**
 * Single separator class for delimited OTP (F68/F70/F75): hyphen, en/em dash,
 * period, fullwidth hyphen/period, ASCII space/tab, and common Unicode spaces
 * (NBSP, NNBSP, em space, ideographic space, BOM as space, …).
 * F128: slash (ASCII + fullwidth) joins — providers format numeric codes as
 * `123/456`, and the metadata alnum slash matcher deliberately rejects
 * pure-digit groups, so this extractor is the only masking path. Dates
 * (`08/07/2026`) match exactly like the hyphen/dot forms already do — the
 * established privacy-over-readability tradeoff for cued digit runs.
 * F129: colon (ASCII + fullwidth) joins for the same reason (`123:456`);
 * clock forms (`12:30`) are the colon equivalent of the date tradeoff —
 * delimited forms still require a strong cue outside metadata masking.
 *
 * Newlines (\n \r \u2028 \u2029) are intentionally excluded: maskTier2Metadata
 * joins from/subject with `\n`, and allowing line breaks would glue digits
 * across fields into a fake delimited form.
 */
export const DELIMITED_OTP_SEP_CLASS =
  '[-–—./:：\uFF0D\uFF0E\uFF0F\t \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]';

/**
 * One to three separator chars between digit groups (F72). Covers ` - `,
 * double space, ` – `; four+ seps (e.g. `123    456`) intentionally miss —
 * rare layout, prefer a bounded false-positive surface over open-ended sep runs.
 */
const DELIMITED_OTP_SEP_MAX = 3;
const DELIMITED_OTP_SEP_RUN = `(?:${DELIMITED_OTP_SEP_CLASS}){1,${DELIMITED_OTP_SEP_MAX}}`;

/**
 * One digit group of a delimited OTP (F73–F75): 2–4 Unicode decimal digits.
 * Full form is 2–4 such groups joined by SEP_RUN — or, since F132, a
 * single-digit chain of 4–8 one-digit groups (`1 2 3 4 5 6`).
 *
 * End guards (F74, shared by capture + run) reject 5+ group chains without
 * taking a 3–4 group prefix/suffix. Total digits may reach 4–16 (privacy-safe
 * over-mask). Partial forms like `code 123-456-7` no longer extract a 2-group
 * prefix — full-run integrity wins.
 */
const DELIMITED_OTP_GROUP = `${ND}{2,4}`;
// F132: single-digit chains (`1 2 3 4 5 6`) — providers render codes
// spaced for readability. 4–8 one-digit groups across the same bounded
// separators; the shared lead/tail guards refuse 9+ chains whole.
const DELIMITED_OTP_SINGLE_FORM = `${ND}(?:${DELIMITED_OTP_SEP_RUN}${ND}){3,7}`;
const DELIMITED_OTP_FORM = `(?:${DELIMITED_OTP_GROUP}(?:${DELIMITED_OTP_SEP_RUN}${DELIMITED_OTP_GROUP}){1,3}|${DELIMITED_OTP_SINGLE_FORM})`;
/**
 * Leading guard: not immediately after digit+sep (blocks mid-chain starts).
 * Tradeoff: a valid form glued after e.g. `1 12 34 56` is also refused — rare in OTP mail.
 */
const DELIMITED_OTP_LEAD_GUARD = `(?<!${ND}${DELIMITED_OTP_SEP_RUN})`;
/** Trailing guard: not immediately before sep+digit (blocks short prefixes). */
const DELIMITED_OTP_TAIL_GUARD = `(?!${DELIMITED_OTP_SEP_RUN}${ND})`;
const DELIMITED_OTP_BOUNDED = `${DELIMITED_OTP_LEAD_GUARD}${OTP_BOUND_LEFT}${DELIMITED_OTP_FORM}${OTP_BOUND_RIGHT}${DELIMITED_OTP_TAIL_GUARD}`;

/** Lookbehind for half-suppress: max group digits + max seps + small margin. */
const HALF_OF_DELIMITED_BEFORE_CHARS = 4 + DELIMITED_OTP_SEP_MAX + 3;

/** Non-global: continuous run followed by sep-run + 2–4 digit group. */
const HALF_OF_DELIMITED_AFTER = new RegExp(
  `^${DELIMITED_OTP_SEP_RUN}${DELIMITED_OTP_GROUP}${OTP_BOUND_RIGHT}`,
  'u',
);
/** Non-global: 2–4 digit group + sep-run immediately before a continuous run. */
const HALF_OF_DELIMITED_BEFORE = new RegExp(
  `${OTP_BOUND_LEFT}${DELIMITED_OTP_GROUP}${DELIMITED_OTP_SEP_RUN}$`,
  'u',
);

/**
 * Starts of contiguous 10-wide Nd decades (F75). Fullwidth/math digits usually
 * NFKC to ASCII; these cover common scripts that do not. Keep in sync when
 * adding extract languages — unmapped Nd fail closed to raw Nd sequence below.
 */
const ND_BLOCK_STARTS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
  0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0,
  0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0x104a0, 0x10d30, 0x11066, 0x110f0,
  0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0,
  0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60, 0x16b50, 0x16d70, 0x1d7ce, 0x1d7d8,
  0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950, 0x1fbf0,
] as const;

function mapNdToAscii(ch: string): string | null {
  if (ch >= '0' && ch <= '9') return ch;
  if (!/\p{Nd}/u.test(ch)) return null;
  const nfkc = ch.normalize('NFKC');
  if (nfkc.length === 1 && nfkc >= '0' && nfkc <= '9') return nfkc;
  const cp = ch.codePointAt(0)!;
  for (const start of ND_BLOCK_STARTS) {
    if (cp >= start && cp < start + 10) return String(cp - start);
  }
  // Last resort: NFKC may expand to ASCII digits for some forms.
  const only = nfkc.replace(/\D/g, '');
  return only.length === 1 ? only : null;
}

/**
 * Digit-only form for cross-script OTP equality (F69/F75): body `123456` and
 * subject `１２３４５６` / `١٢٣٤٥٦` compare equal after mapping to ASCII.
 * Non-digits are stripped. If any Nd cannot be mapped, fall back to the raw
 * Nd sequence (same-script mask still works; avoids empty-canon fail-open).
 */
export function canonicalDigits(s: string): string {
  let out = '';
  let rawNd = '';
  let unmapped = false;
  for (const ch of s) {
    if (!/\p{Nd}/u.test(ch)) continue;
    rawNd += ch;
    const mapped = mapNdToAscii(ch);
    if (mapped === null) {
      unmapped = true;
    } else if (!unmapped) {
      out += mapped;
    }
  }
  return unmapped ? rawNd : out;
}

/**
 * Fresh global regex for one delimited OTP form (capture group 1 = full form).
 * Callers must not share a single global instance across concurrent scans.
 */
export function delimitedOtpCaptureRe(): RegExp {
  return new RegExp(
    `${DELIMITED_OTP_LEAD_GUARD}${OTP_BOUND_LEFT}(${DELIMITED_OTP_FORM})${OTP_BOUND_RIGHT}${DELIMITED_OTP_TAIL_GUARD}`,
    'gu',
  );
}

/**
 * Fresh global regex for continuous 4–8 digit runs and delimited OTP forms.
 * Delimited alternative is first so `12 34 56 78` / `1234-5678` is one span.
 * Shared by extractCodes output shapes and tier-2 mask/meta scans (F70–F75);
 * half-suppress uses HALF_OF_DELIMITED_* built from the same SEP_RUN/GROUP.
 */
export function otpCodeRunRe(): RegExp {
  return new RegExp(
    `${DELIMITED_OTP_BOUNDED}|${OTP_BOUND_LEFT}${ND}{4,8}${OTP_BOUND_RIGHT}`,
    'gu',
  );
}

/**
 * True when a continuous 4–8 Nd run is one side of a delimited OTP shape
 * (`1234-5678` / `1234 - 56`). Continuous extract only yields 4–8 digit runs,
 * and only a **4-digit** run can be a delimited group; longer runs like
 * `123456-7890` stay continuous so they are not dropped without recovery.
 */
function isHalfOfDelimitedOtp(text: string, idx: number, digits: string): boolean {
  // Continuous matches are 4–8 Nd code points; only a 4-digit run is a group half.
  // BMP Nd (fullwidth/Arabic/…) have length === code-point count.
  if ([...digits].length !== 4) return false;
  const after = text.slice(idx + digits.length);
  if (HALF_OF_DELIMITED_AFTER.test(after)) return true;
  const before = text.slice(Math.max(0, idx - HALF_OF_DELIMITED_BEFORE_CHARS), idx);
  return HALF_OF_DELIMITED_BEFORE.test(before);
}

/** Continuous 4–8 Nd run with OTP bounds (capture group 1 = run). */
function continuousOtpCaptureRe(): RegExp {
  return new RegExp(`${OTP_BOUND_LEFT}(${ND}{4,8})${OTP_BOUND_RIGHT}`, 'gu');
}

/**
 * Keyword window around a match: slice the **original** text at original
 * offsets, then NFKC + lowercase only the window (F99/F104). Whole-string
 * `toLowerCase()` shifts later indices when case-fold expands (Turkish `İ` →
 * `i`+combining dot), so a pre-lowercased buffer must not be sliced with
 * source indices. NFKC lets compatibility-form keywords (fullwidth `ｃｏｄｅ`)
 * match CODE_KEYWORDS / STRONG_OTP_CUE inside the window; the window feeds
 * keyword search only, never extraction offsets, so NFKC length drift is safe.
 */
function keywordWindow(text: string, idx: number, matchLen: number): string {
  return text
    .slice(Math.max(0, idx - KEYWORD_WINDOW), Math.min(text.length, idx + matchLen + KEYWORD_WINDOW))
    .normalize('NFKC')
    .toLowerCase();
}

/** Extract 4–8 digit codes (continuous or delimited) near an OTP keyword. */
export function extractCodes(text: string): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(continuousOtpCaptureRe())) {
    const digits = match[1]!;
    const idx = match.index ?? 0;
    // Leave `1234-5678` / Unicode-space halves to the delimited pass (F68/F70).
    if (isHalfOfDelimitedOtp(text, idx, digits)) continue;
    const window = keywordWindow(text, idx, digits.length);
    if (!CODE_KEYWORDS.some((kw) => window.includes(kw))) continue;
    // Years need a strong OTP cue (not mere "verification"/"identity") so
    // roadmap copy like "for 2026" does not fire false OTP alerts (F65).
    // Compare on ASCII-mapped digits so fullwidth years get the same guard.
    const yearCanon = canonicalDigits(digits);
    if (/^(19|20)\d{2}$/.test(yearCanon) && !STRONG_OTP_CUE.test(window)) {
      continue;
    }
    if (!seen.has(digits)) {
      seen.add(digits);
      codes.push(digits);
    }
  }

  // F68/F70: `123-456` / `1234\u00A05678` only with a strong cue (not phone/roadmap).
  // Keep original spelling (including NBSP) so maskSensitiveFragments can match.
  for (const match of text.matchAll(delimitedOtpCaptureRe())) {
    const form = match[1]!;
    const idx = match.index ?? 0;
    const window = keywordWindow(text, idx, form.length);
    if (!STRONG_OTP_CUE.test(window)) continue;
    if (!seen.has(form)) {
      seen.add(form);
      codes.push(form);
    }
  }
  return codes;
}

interface Anchor {
  url: string;
  anchorText: string;
}

/**
 * Pull href + anchor text pairs out of an HTML part. The href is an HTML
 * attribute value, so it must be entity-decoded: real mail writes query
 * separators as `&amp;`, and handing the agent a link with a literal
 * "&amp;" in it makes the verification request fail. Safe to decode here
 * only because codePointToString() already refuses out-of-range entities.
 */
function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    anchors.push({ url: decodeEntities(m[1]).trim(), anchorText: htmlToText(m[2]) });
  }
  return anchors;
}

/**
 * Scheme finder / tests only. Prose extraction uses bareUrlSpans (single-pass
 * tokenizer). Kept for callers and tests that still import the pattern.
 */
export const BARE_URL_RE = /https?:\/\//gi;

function looksLikeActionLink(url: string, anchorText = ''): boolean {
  return LINK_INTENT.test(url) || LINK_INTENT.test(anchorText);
}

/**
 * Canonical WHATWG form for http(s) candidates (hostname lowercased, default
 * ports dropped). Returns null for non-http(s) or unparseable input.
 * Shared by extractLinks and tier-2 URL masking so both use one normalizer.
 */
export function validatedHttpUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** JS `\\s` set (NBSP, em space, etc.) — same rule for scan and glue checks. */
function isJsWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Prose close-context after a quote closer (F64/F122): end of text,
 * whitespace, or terminal punctuation (ASCII plus CJK, F131) — an internal
 * apostrophe (`o'brien`) or quote-joined URL content sees anything else.
 */
function isProseCloseContext(next: string): boolean {
  return (
    next === '' ||
    isJsWhitespace(next) ||
    next === '!' ||
    next === '.' ||
    next === ',' ||
    next === ';' ||
    next === ':' ||
    next === '?' ||
    next === ')' ||
    next === ']' ||
    next === '}' ||
    // CJK terminal punctuation plays the same prose-closing role (F131).
    next === '\u3001' ||
    next === '\u3002' ||
    next === '\uFF01' ||
    next === '\uFF0C' ||
    next === '\uFF1A' ||
    next === '\uFF1B' ||
    next === '\uFF1F' ||
    next === '\uFF09'
  );
}

/** Non-overlapping positions of https?:// (case-insensitive). O(n). */
function findSchemePositions(text: string): number[] {
  const positions: number[] = [];
  const re = /https?:\/\//gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    positions.push(match.index);
  }
  return positions;
}

/**
 * Prose terminal punctuation that may trail a URL (peel loop / F90–F96).
 * Includes `:` for look-back over stacked trailers (e.g. `):.`) but bare `:`
 * peels only with closer context (F96) — never unconditional.
 */
function isUrlTerminalPunct(ch: string): boolean {
  return (
    ch === '.' ||
    ch === ',' ||
    ch === ';' ||
    ch === '!' ||
    ch === '?' ||
    ch === ':'
  );
}

/**
 * Look-back from candidate[end-1]: skip terminal punct, return the index of the
 * first non-punct char (or -1) and whether it is a closer `)`/`]`/`'` (F92/F96).
 */
function scanTerminalPunctCloserContext(
  candidate: string,
  end: number,
): { boundary: number; verdict: boolean } {
  let i = end - 2;
  while (i >= 0 && isUrlTerminalPunct(candidate[i]!)) i -= 1;
  if (i < 0) return { boundary: -1, verdict: false };
  const ch = candidate[i]!;
  return {
    boundary: i,
    verdict: ch === ')' || ch === ']' || ch === "'",
  };
}

/**
 * Whether an already-peeled trailer forces peeling a structural first `?` (F100).
 * Closers / quotes / non-`?` terminal punct after the `?` mean sentence context
 * (`verify?)`, `verify?).`). A trailer of only extra `?` does **not** force peel
 * of the first (`??` → keep one empty-query `?`).
 */
function trailerForcesQuestionPeel(trailer: string): boolean {
  for (let i = 0; i < trailer.length; i++) {
    const ch = trailer[i]!;
    if (
      ch === ')' ||
      ch === ']' ||
      ch === "'" ||
      ch === '.' ||
      ch === ',' ||
      ch === ';' ||
      ch === '!'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Peel trailing prose from a bounded candidate [0, length): `.,;`, conditional
 * trailing `?`/`!`/`:`, unbalanced trailing `)`/`]`, and trailing `'`.
 * - Terminal `.`/`,`/`;` peel unconditionally.
 * - Terminal `?` (F100): **keep** the first bare `?` (WHATWG empty query is
 *   significant for strict servers; usually same route as no-query). **Peel**
 *   a later `?` (query already started — prose question mark wins), or a first
 *   `?` followed by peeled closers/quotes/`!.,;` (`verify?)`), or a first `?`
 *   with closer-context look-back (`)!?` stacked prose). Mid-URL `?query` is
 *   never trailing.
 * - Terminal `!` peels only with closer context (`)!` / `]!` / `'!` / `).!`),
 *   so bare `…/token!` keeps the bang (F90 + F92). Mid-URL `!` stays put.
 * - Terminal `:` peels only with closer context (`):` / `]:` / `':` / `):.`),
 *   so bare `…/v:` keeps the colon (F96). Port/mid-URL `:` are never trailing.
 * - openQuoted false: peel `'` only while the remaining apostrophe count is odd.
 * - openQuoted true (span started after prose `'`): peel exactly one closing
 *   `'` via a one-shot flag (F61/F63) — odd-parity must not fire as well, or a
 *   legal URL-terminal `'` would be stripped after the outer closer (F63).
 * - Terminal `'s` (F108): an English possessive at the candidate end peels
 *   (`verify's` → `verify`); internal apostrophes (`don't/verify`) are never
 *   trailing and stay put. Skipped under preserveApostrophes.
 *
 * F98: closer-context look-back is cached per contiguous terminal-punct run so
 * a long `!!!!` / `::::` / `????` suffix is O(length), not O(length²).
 */
function peelTrailingProse(
  candidate: string,
  openQuoted = false,
  /** When true, never peel `'` (outer closer already left outside the span; F64 cut). */
  preserveApostrophes = false,
): { clean: string; trail: string } {
  if (!candidate) return { clean: '', trail: '' };

  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let apostrophes = 0;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (ch === '(') openParen += 1;
    else if (ch === ')') closeParen += 1;
    else if (ch === '[') openBracket += 1;
    else if (ch === ']') closeBracket += 1;
    else if (ch === "'") apostrophes += 1;
  }

  // O(1) later-`?` checks for F100 (single scan budget per peel call).
  const firstQuestionIdx = candidate.indexOf('?');

  // openQuoted: authorize exactly one outer closer peel (after any .,;!?:).
  let peelOpenQuote = openQuoted;
  let end = candidate.length;
  // F98: cache look-back for one contiguous `!`/`:`/`?` (mixed terminal) run.
  let cachedBoundary: number | null = null;
  let cachedVerdict = false;
  while (end > 0) {
    const ch = candidate[end - 1]!;
    if (ch === '.' || ch === ',' || ch === ';') {
      // Unconditional peel may exit/enter a conditional run — drop cache.
      cachedBoundary = null;
      end -= 1;
      continue;
    }
    // F108: English possessive at candidate end (`verify's`) peels `'s`;
    // internal apostrophes (`don't/verify`) are never trailing and stay put.
    if (
      !preserveApostrophes &&
      ch === 's' &&
      end >= 3 &&
      candidate[end - 2] === "'" &&
      /[A-Za-z0-9]/.test(candidate[end - 3]!)
    ) {
      apostrophes -= 1;
      cachedBoundary = null;
      end -= 2;
      continue;
    }
    // F100: conditional `?` — keep first bare empty-query; peel later / prose.
    if (ch === '?') {
      const laterQuestion = firstQuestionIdx >= 0 && firstQuestionIdx < end - 1;
      if (laterQuestion || trailerForcesQuestionPeel(candidate.slice(end))) {
        cachedBoundary = null;
        end -= 1;
        continue;
      }
      // First `?` with empty/only-`?` trailer: peel only with closer context
      // (stacked `)!?` / `]?`); otherwise keep structural empty query.
      if (cachedBoundary === null || !(end - 2 > cachedBoundary)) {
        const scan = scanTerminalPunctCloserContext(candidate, end);
        cachedBoundary = scan.boundary;
        cachedVerdict = scan.verdict;
      }
      if (cachedVerdict) {
        end -= 1;
        continue;
      }
      break;
    }
    // F92/F96: peel `!` or `:` only when glued to ) ] ' (skip other terminal punct).
    if (ch === '!' || ch === ':') {
      // Same run while end-2 is still strictly after the first non-punct char.
      if (cachedBoundary === null || !(end - 2 > cachedBoundary)) {
        const scan = scanTerminalPunctCloserContext(candidate, end);
        cachedBoundary = scan.boundary;
        cachedVerdict = scan.verdict;
      }
      if (cachedVerdict) {
        end -= 1;
        continue;
      }
      break;
    }
    if (ch === ')' && closeParen > openParen) {
      closeParen -= 1;
      cachedBoundary = null;
      end -= 1;
      continue;
    }
    if (ch === ']' && closeBracket > openBracket) {
      closeBracket -= 1;
      cachedBoundary = null;
      end -= 1;
      continue;
    }
    if (ch === "'" && !preserveApostrophes) {
      if (openQuoted) {
        // F63: only the one-shot flag; parity never stacks a second peel.
        if (!peelOpenQuote) break;
        peelOpenQuote = false;
        apostrophes -= 1;
        cachedBoundary = null;
        end -= 1;
        continue;
      }
      if (apostrophes % 2 === 1) {
        apostrophes -= 1;
        cachedBoundary = null;
        end -= 1;
        continue;
      }
    }
    break;
  }

  return { clean: candidate.slice(0, end), trail: candidate.slice(end) };
}

/**
 * Split a single candidate (typically starting at a scheme) into clean URL +
 * trail using the same glue/peel rules as bareUrlSpans. Prefer bareUrlSpans for
 * full-text walks; this remains for unit tests and single-match call sites.
 */
export function splitBareUrlCandidate(candidate: string): { clean: string; trail: string } {
  if (!candidate) return { clean: '', trail: '' };
  for (const span of bareUrlSpans(candidate)) {
    if (span.start === 0) {
      return { clean: span.clean, trail: candidate.slice(span.end) };
    }
    break;
  }
  return { clean: candidate, trail: '' };
}

/** One prose URL span (indices into the full text). */
export type BareUrlSpan = {
  /** Start index of `clean` in the full text. */
  start: number;
  /** Exclusive end index of `clean` in the full text. */
  end: number;
  clean: string;
  /**
   * When this span ended on a proven Markdown-chain cut, the glue between the
   * unbalanced closer and the next scheme (e.g. `)[token=secret](`). Indices
   * into the full text, half-open [start, end). Extractors ignore this; only
   * maskNormalizedHttpUrls redacts it with the adjacent URLs.
   */
  glueAfter?: { start: number; end: number };
  /**
   * When this span ended on a `"`, `<`, or `>` hard cut with a glued non-whitespace
   * tail (e.g. `"token=secret` or `>token=secret`), the half-open range from the
   * boundary char through that tail (stops before the next scheme if one sits
   * inside the tail). Extractors ignore this; maskNormalizedHttpUrls redacts it
   * when the URL itself is a redaction target.
   */
  tailAfter?: { start: number; end: number };
};

/**
 * True when an unbalanced closer at `i` is proven Markdown-chain glue to the
 * next scheme (O(1)): `)(scheme`, `](scheme`, `)[scheme`, `][scheme`, or
 * `)[label](scheme` / `][label](scheme`. Bare `)[token=…` is a legal URL path
 * and must not cut.
 */
function isMarkdownChainGlue(text: string, i: number, nextScheme: number | undefined): boolean {
  if (nextScheme === undefined) return false;
  const next = text[i + 1];
  if (next === '(' && nextScheme === i + 2) return true;
  if (next === '[') {
    if (nextScheme === i + 2) return true;
    // )[label](https://…  — scheme is immediately after "]("
    if (
      nextScheme >= 2 &&
      text[nextScheme - 2] === ']' &&
      text[nextScheme - 1] === '('
    ) {
      return true;
    }
  }
  return false;
}

/**
 * F122/F131: paired Unicode prose quotes that may wrap a bare URL. When a
 * span opens right after one of these openers, the matching closer in prose
 * close context ends the span — the closer is prose punctuation, not URL
 * content (the WHATWG parser percent-encodes it into a different, unusable
 * destination). Covers smart quotes, guillemets, German low-9 quotes, and
 * the CJK bracket family.
 */
const PAIRED_URL_QUOTES: Record<string, string> = {
  '\u201C': '\u201D', // curly double quotes
  '\u2018': '\u2019', // curly single quotes
  '\u201E': '\u201C', // German low-9 double quote
  '\u201A': '\u2018', // German low-9 single quote
  '\u00AB': '\u00BB', // guillemets
  '\u2039': '\u203A', // single guillemets
  '\u300C': '\u300D', // CJK corner brackets
  '\u300E': '\u300F', // CJK double corner brackets
  '\u3008': '\u3009', // CJK angle brackets
  '\u300A': '\u300B', // CJK double angle brackets
  '\u3010': '\u3011', // CJK lenticular brackets
  '\uFF62': '\uFF63', // halfwidth CJK corner brackets (F133)
  '\uFF08': '\uFF09', // fullwidth parentheses (F133)
  '\uFF1C': '\uFF1E', // fullwidth angle brackets (F133)
};

/**
 * Single-pass bare URL tokenizer. O(n) over the full text:
 * pre-scan scheme positions, then for each start scan once with depth tracking;
 * an unbalanced closer is a hard cut when (1) the next scheme is a proven
 * Markdown chain (tight `)(`, `](`, `)[`, `][`, or `)[label](` / `][label](`),
 * or (2) the span opened after `](` / prose `(` (first free `)` closes the
 * wrapper — F59/F64) or after prose `[` (first free `]` closes — F67; not
 * `][` chain glue). Bare URLs keep free `)` in-path (e.g. F48 `confirm)[token=`).
 * openQuoted spans also cut before a closing `'` when the next char is prose
 * close context (F64). Nested redirects stay inside the URL when no cut applies.
 * Bounded tail peel removes free trailers without re-matching.
 * Spans wrapped in paired Unicode prose quotes (smart quotes, guillemets,
 * CJK brackets — PAIRED_URL_QUOTES) likewise cut before the matching closer
 * in close context (F122/F131) so the quote is not percent-encoded
 * into the published destination. Markdown-wrapped spans (`` ` ``/`*`/`**`)
 * cut before the closing delimiter run in close context (F130).
 */
export function* bareUrlSpans(text: string): Generator<BareUrlSpan> {
  if (!text) return;
  const schemePos = findSchemePositions(text);
  let schemeIdx = 0;

  while (schemeIdx < schemePos.length) {
    const start = schemePos[schemeIdx]!;
    let parenDepth = 0;
    let bracketDepth = 0;
    let end = text.length;
    // First scheme strictly after the current closer; skips nested schemes that
    // fell inside this span (e.g. ?next=https:// before a Markdown )[label]().
    let probeIdx = schemeIdx + 1;
    // Set when we hard-cut on Markdown chain glue (closer index + next scheme).
    let glueCut: { closer: number; nextScheme: number } | undefined;
    // Set when we hard-cut on " < > with a glued non-whitespace tail (F55).
    let tailCut: { start: number; end: number } | undefined;
    // F59: Markdown `](https://…)`. F64: prose `(https://…)` — not `](`.
    const markdownLinkOpen =
      start >= 2 && text[start - 1] === '(' && text[start - 2] === ']';
    const proseParenOpen =
      start >= 1 &&
      text[start - 1] === '(' &&
      (start < 2 || text[start - 2] !== ']');
    const cutOnFreeParen = markdownLinkOpen || proseParenOpen;
    // F67: prose `[https://…]` — not `][` (Markdown/reference chain glue).
    const proseBracketOpen =
      start >= 1 &&
      text[start - 1] === '[' &&
      (start < 2 || text[start - 2] !== ']');
    // F61/F63: span opened after a prose apostrophe.
    const openQuoted = start >= 1 && text[start - 1] === "'";
    // True when F64 cut left the outer closer outside the raw span — peel must
    // not also strip a legal URL-terminal ' (F63).
    let openQuotedCut = false;
    // F122/F131: span opened after a paired-quote opener — the matching
    // closer is prose context, not URL content (the WHATWG parser
    // percent-encodes it into a different, unusable destination).
    const openSmartQuote: string | undefined =
      start >= 1 ? PAIRED_URL_QUOTES[text[start - 1]!] : undefined;
    // F130: span opened after a Markdown inline-code/emphasis wrapper
    // (`` ` `` or `*`/`**`) — the closing delimiter is markup, not URL
    // content (`https://example.com/verify%60`, path trailing `**`).
    const mdWrapper =
      start >= 1 && (text[start - 1] === '`' || text[start - 1] === '*')
        ? (text[start - 1] as '`' | '*')
        : undefined;

    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (isJsWhitespace(ch) || ch === '<' || ch === '>' || ch === '"') {
        end = i;
        // Quote/angle hard cut: glued non-ws tail may hold secrets (e.g. "token=).
        // Whitespace cuts never record a tail (balanced "url" / <url> keep delimiters).
        // F58: resolve nextScheme *before* walking the tail so dense "https://a/N"x=
        // fragments stay O(n) (walk is bounded by the next scheme, not the full suffix).
        if (
          (ch === '<' || ch === '>' || ch === '"') &&
          i + 1 < text.length &&
          !isJsWhitespace(text[i + 1]!)
        ) {
          while (probeIdx < schemePos.length && schemePos[probeIdx]! <= i) {
            probeIdx += 1;
          }
          const nextScheme = schemePos[probeIdx];
          const scanLimit = nextScheme !== undefined ? nextScheme : text.length;
          let tailEnd = i + 1;
          while (tailEnd < scanLimit && !isJsWhitespace(text[tailEnd]!)) {
            tailEnd += 1;
          }
          if (tailEnd > i) {
            tailCut = { start: i, end: tailEnd };
          }
        }
        break;
      }
      if (ch === '(') {
        parenDepth += 1;
        continue;
      }
      if (ch === '[') {
        bracketDepth += 1;
        continue;
      }
      if (ch === ')') {
        if (parenDepth > 0) {
          parenDepth -= 1;
          continue;
        }
        while (probeIdx < schemePos.length && schemePos[probeIdx]! <= i) probeIdx += 1;
        const nextScheme = schemePos[probeIdx];
        if (isMarkdownChainGlue(text, i, nextScheme)) {
          end = i;
          glueCut = { closer: i, nextScheme: nextScheme! };
          break;
        }
        // After glue: MD `](` or prose `(` openers cut at first free closer.
        if (cutOnFreeParen) {
          end = i;
          break;
        }
        continue;
      }
      if (ch === ']') {
        if (bracketDepth > 0) {
          bracketDepth -= 1;
          continue;
        }
        while (probeIdx < schemePos.length && schemePos[probeIdx]! <= i) probeIdx += 1;
        const nextScheme = schemePos[probeIdx];
        if (isMarkdownChainGlue(text, i, nextScheme)) {
          end = i;
          glueCut = { closer: i, nextScheme: nextScheme! };
          break;
        }
        // After glue: prose `[` opener cuts at first free closer (F67).
        if (proseBracketOpen) {
          end = i;
          break;
        }
        continue;
      }
      // F64: outer prose quote closes when ' is followed by close-context.
      // Internal apostrophes (o'brien) and URL-terminal ' before another '
      // (token'' + space → cut only the outer closer) stay in the URL.
      if (ch === "'" && openQuoted) {
        const next = i + 1 < text.length ? text[i + 1]! : '';
        if (isProseCloseContext(next)) {
          end = i;
          openQuotedCut = true;
          break;
        }
        continue;
      }
      // F122/F131: the matching paired-quote closer closes a quoted span
      // in close context; anything else keeps it as (rare, invalid) content.
      if (openSmartQuote !== undefined && ch === openSmartQuote) {
        const next = i + 1 < text.length ? text[i + 1]! : '';
        if (isProseCloseContext(next)) {
          end = i;
          break;
        }
        continue;
      }
      // F130: matching Markdown wrapper closer in close context ends the span.
      // `*` closes on a 1–2 char run so a `**` closer never leaves one behind.
      if (mdWrapper === '`' && ch === '`') {
        const next = i + 1 < text.length ? text[i + 1]! : '';
        if (isProseCloseContext(next)) {
          end = i;
          break;
        }
        continue;
      }
      if (mdWrapper === '*' && ch === '*') {
        const runEnd = text[i + 1] === '*' ? i + 2 : i + 1;
        const next = runEnd < text.length ? text[runEnd]! : '';
        if (isProseCloseContext(next)) {
          end = i;
          break;
        }
        continue;
      }
    }

    const raw = text.slice(start, end);
    // F64 cut left outer closer outside the span: keep any URL-terminal ' (F63).
    const { clean } = peelTrailingProse(
      raw,
      openQuoted && !openQuotedCut,
      openQuotedCut,
    );
    if (clean.length === 0) {
      schemeIdx += 1;
      continue;
    }
    const cleanEnd = start + clean.length;
    const span: BareUrlSpan = { start, end: cleanEnd, clean };
    // Glue is always [closer, nextScheme) even if peel shortened cleanEnd.
    if (glueCut) {
      span.glueAfter = { start: glueCut.closer, end: glueCut.nextScheme };
    }
    // Tail is [boundary, tailEnd); independent of peel (boundary was never in raw).
    if (tailCut) {
      span.tailAfter = tailCut;
    }
    yield span;

    // Skip schemes that fell inside this span (e.g. nested ?next=https://…).
    while (schemeIdx < schemePos.length && schemePos[schemeIdx]! < cleanEnd) {
      schemeIdx += 1;
    }
  }
}

/** Exclusive end of a span including any recorded glue/tail after the clean URL. */
function spanExtentEnd(span: BareUrlSpan): number {
  let end = span.end;
  if (span.glueAfter && span.glueAfter.end > end) end = span.glueAfter.end;
  if (span.tailAfter && span.tailAfter.end > end) end = span.tailAfter.end;
  return end;
}

/**
 * Replace bare URLs in `text` whose validatedHttpUrl form is in `normalizedLinks`
 * with `placeholder`, keeping the original spelling span as the match (so
 * EXAMPLE.com:443 still redacts when the needle is https://example.com/...).
 * Markdown-chain glue (span.glueAfter) adjacent to a target URL on either side
 * is redacted too so labels like `)[token=secret](` cannot leak between spans.
 * Quote/angle tails (span.tailAfter) are redacted when this URL is a target so
 * `"token=secret` / `>token=secret` cannot leak after a hard cut (F55).
 * After a glue/tail redaction lands on the next span start, invalid spans
 * (validatedHttpUrl null) are swallowed into the redaction zone so nested
 * `https://[token=…` cannot leak (F57). Valid spans always stop the chain.
 */
export function maskNormalizedHttpUrls(
  text: string,
  normalizedLinks: string[],
  placeholder = '•••',
): string {
  if (!text || normalizedLinks.length === 0) return text;
  const targets = new Set(normalizedLinks.filter(Boolean));
  if (targets.size === 0) return text;
  const spans = [...bareUrlSpans(text)];
  let out = '';
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    // Span already consumed while swallowing invalid neighbors after a prior cut.
    if (cursor > span.start) {
      cursor = Math.max(cursor, spanExtentEnd(span));
      continue;
    }
    if (cursor < span.start) {
      out += text.slice(cursor, span.start);
    }

    const validated = validatedHttpUrl(span.clean);
    const maskThis = Boolean(validated && targets.has(validated));
    out += maskThis ? placeholder : span.clean;
    cursor = span.end;

    let redactedAdjacent = false;
    const glue = span.glueAfter;
    if (glue && glue.end > glue.start) {
      // Mask glue when either adjacent URL is a redaction target (label may hold secrets).
      let maskNext = false;
      const next = spans[i + 1];
      if (next) {
        const nextValidated = validatedHttpUrl(next.clean);
        maskNext = Boolean(nextValidated && targets.has(nextValidated));
      }
      if (maskThis || maskNext) {
        // Skip any peel gap before the closer, then redact [closer, nextScheme).
        out += placeholder;
        cursor = glue.end;
        redactedAdjacent = true;
      }
    }

    const tail = span.tailAfter;
    if (maskThis && tail && tail.end > tail.start && tail.end > cursor) {
      // URL was redacted: redact glued " / < / > tail so secrets cannot stick.
      out += placeholder;
      cursor = tail.end;
      redactedAdjacent = true;
    }

    // F57: glue/tail may stop at a nested scheme that is not a valid URL; swallow
    // those invalid spans (and their own glue/tail) while they remain adjacent.
    if (redactedAdjacent) {
      let j = i + 1;
      while (j < spans.length) {
        const neighbor = spans[j]!;
        if (neighbor.start !== cursor) break;
        if (validatedHttpUrl(neighbor.clean) !== null) break;
        cursor = spanExtentEnd(neighbor);
        j += 1;
      }
      if (j > i + 1) i = j - 1;
    }
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Extract verification-ish links. Prefers the HTML part's anchors (so
 * anchor text like "Verify your email" can qualify a neutral URL), then
 * falls back to bare URLs found in the text.
 */
export function extractLinks(text: string, html?: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const pushValidated = (candidate: string) => {
    const validated = validatedHttpUrl(candidate);
    if (validated && !seen.has(validated)) {
      seen.add(validated);
      links.push(validated);
    }
  };

  if (html) {
    // Anchor hrefs are attribute-delimited — never prose-trim their tails.
    for (const a of extractAnchors(html)) {
      if (/^https?:\/\//i.test(a.url) && looksLikeActionLink(a.url, a.anchorText)) {
        pushValidated(a.url);
      }
    }
  }
  for (const span of bareUrlSpans(text)) {
    if (looksLikeActionLink(span.clean)) pushValidated(span.clean);
  }
  return links;
}

export interface OtpExtraction {
  codes: string[];
  links: string[];
}

/** Full extraction: codes from text, links from text + HTML. */
export function extractOtp(text: string, html?: string): OtpExtraction {
  const effectiveText = [text.trim(), html ? htmlToText(html) : '']
    .filter(Boolean)
    .join('\n');
  return {
    codes: extractCodes(effectiveText),
    links: extractLinks(effectiveText, html),
  };
}

/** All body links for the human UI, independent of OTP intent matching. */
export function extractHttpLinks(text: string, html?: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const pushValidated = (candidate: string) => {
    const validated = validatedHttpUrl(candidate);
    if (validated && !seen.has(validated)) {
      seen.add(validated);
      links.push(validated);
    }
  };

  if (html) {
    // Anchor hrefs are attribute-delimited — never prose-trim their tails.
    for (const anchor of extractAnchors(html)) pushValidated(anchor.url);
  }
  const visibleText = [text, html ? htmlToText(html) : ''].join('\n');
  for (const span of bareUrlSpans(visibleText)) pushValidated(span.clean);
  return links;
}
