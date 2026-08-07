/**
 * OTP / verification-link extraction. Pure functions — no I/O — so they
 * are unit-testable against sample mails (see test/otp.test.ts).
 *
 * - codes: 4–8 digit sequences that appear near a keyword
 *   (code / verification / otp / passcode / 验证码 / 动态码 / ...).
 * - links: URLs (from the HTML part's anchors or bare URLs in text) whose
 *   URL or anchor text matches verif|confirm|activate|reset|signin|login.
 */

const CODE_KEYWORDS = [
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
];

const LINK_INTENT = /verif|confirm|activate|reset|signin|sign-in|login|log-in/i;

/** How many characters around a digit run to scan for a keyword. */
const KEYWORD_WINDOW = 80;

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

/** Extract 4–8 digit codes appearing near an OTP keyword. */
export function extractCodes(text: string): string[] {
  const lower = text.toLowerCase();
  const codes: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(/\b(\d{4,8})\b/g)) {
    const digits = match[1];
    const idx = match.index ?? 0;
    const window = lower.slice(
      Math.max(0, idx - KEYWORD_WINDOW),
      Math.min(lower.length, idx + digits.length + KEYWORD_WINDOW),
    );
    if (!CODE_KEYWORDS.some((kw) => window.includes(kw))) continue;
    // Skip obvious years that merely sit next to a keyword.
    if (/^(19|20)\d{2}$/.test(digits) && !/code|otp|passcode|验证码|动态码/.test(window)) continue;
    if (!seen.has(digits)) {
      seen.add(digits);
      codes.push(digits);
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
 * Peel trailing prose from a bounded candidate [0, length): `.,;`, unbalanced
 * trailing `)`/`]`, and an odd trailing `'`. O(length).
 */
function peelTrailingProse(candidate: string): { clean: string; trail: string } {
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

  let end = candidate.length;
  while (end > 0) {
    const ch = candidate[end - 1]!;
    if (ch === '.' || ch === ',' || ch === ';') {
      end -= 1;
      continue;
    }
    if (ch === ')' && closeParen > openParen) {
      closeParen -= 1;
      end -= 1;
      continue;
    }
    if (ch === ']' && closeBracket > openBracket) {
      closeBracket -= 1;
      end -= 1;
      continue;
    }
    if (ch === "'" && apostrophes % 2 === 1) {
      apostrophes -= 1;
      end -= 1;
      continue;
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
};

/**
 * Single-pass bare URL tokenizer. O(n) over the full text:
 * pre-scan scheme positions, then for each start scan once with depth tracking;
 * an unbalanced closer is a hard cut only when immediately followed by `[` or
 * `(` (Markdown chain glue: `)[`, `)(`, `][`, `](`). Nested redirects like
 * `)token=…?next=https://` keep the closer inside the URL (WHATWG); the inner
 * scheme is skipped by the post-span scheme advance. Bounded tail peel removes
 * free trailers without re-matching the remainder.
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

    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (isJsWhitespace(ch) || ch === '<' || ch === '>' || ch === '"') {
        end = i;
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
        // Unbalanced closer: hard-cut only for tightly adjacent Markdown chain
        // openers. `?next=https://` after `)token=…` is not a chain — keep ) in URL.
        const next = text[i + 1];
        if (next === '[' || next === '(') {
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
        const next = text[i + 1];
        if (next === '[' || next === '(') {
          end = i;
          break;
        }
        continue;
      }
    }

    const raw = text.slice(start, end);
    const { clean } = peelTrailingProse(raw);
    if (clean.length === 0) {
      schemeIdx += 1;
      continue;
    }
    const cleanEnd = start + clean.length;
    yield { start, end: cleanEnd, clean };

    // Skip schemes that fell inside this span (e.g. nested ?next=https://…).
    while (schemeIdx < schemePos.length && schemePos[schemeIdx]! < cleanEnd) {
      schemeIdx += 1;
    }
  }
}

/**
 * Replace bare URLs in `text` whose validatedHttpUrl form is in `normalizedLinks`
 * with `placeholder`, keeping the original spelling span as the match (so
 * EXAMPLE.com:443 still redacts when the needle is https://example.com/...).
 * Each adjacent link is a separate span so Markdown chains mask fully.
 */
export function maskNormalizedHttpUrls(
  text: string,
  normalizedLinks: string[],
  placeholder = '•••',
): string {
  if (!text || normalizedLinks.length === 0) return text;
  const targets = new Set(normalizedLinks.filter(Boolean));
  if (targets.size === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of bareUrlSpans(text)) {
    out += text.slice(cursor, span.start);
    const validated = validatedHttpUrl(span.clean);
    out += validated && targets.has(validated) ? placeholder : span.clean;
    cursor = span.end;
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
