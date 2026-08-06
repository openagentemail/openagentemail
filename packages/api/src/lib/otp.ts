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

/** Bare http(s) URLs in plain text; scheme is case-insensitive (RFC 3986). */
export const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

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

/**
 * Replace bare URLs in `text` whose validatedHttpUrl form is in `normalizedLinks`
 * with `placeholder`, keeping the original spelling span as the match (so
 * EXAMPLE.com:443 still redacts when the needle is https://example.com/...).
 */
export function maskNormalizedHttpUrls(
  text: string,
  normalizedLinks: string[],
  placeholder = '•••',
): string {
  if (!text || normalizedLinks.length === 0) return text;
  const targets = new Set(normalizedLinks.filter(Boolean));
  if (targets.size === 0) return text;
  return text.replace(BARE_URL_RE, (raw) => {
    const clean = raw.replace(/[.,;]+$/, '');
    const trail = raw.slice(clean.length);
    const validated = validatedHttpUrl(clean);
    if (validated && targets.has(validated)) return `${placeholder}${trail}`;
    return raw;
  });
}

/**
 * Extract verification-ish links. Prefers the HTML part's anchors (so
 * anchor text like "Verify your email" can qualify a neutral URL), then
 * falls back to bare URLs found in the text.
 */
export function extractLinks(text: string, html?: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const push = (url: string) => {
    const clean = url.replace(/[.,;]+$/, '');
    const validated = validatedHttpUrl(clean);
    if (validated && !seen.has(validated)) {
      seen.add(validated);
      links.push(validated);
    }
  };

  if (html) {
    for (const a of extractAnchors(html)) {
      if (/^https?:\/\//i.test(a.url) && looksLikeActionLink(a.url, a.anchorText)) push(a.url);
    }
  }
  for (const m of text.matchAll(BARE_URL_RE)) {
    if (looksLikeActionLink(m[0])) push(m[0]);
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
  const push = (candidate: string) => {
    const clean = candidate.replace(/[.,;]+$/, '');
    const validated = validatedHttpUrl(clean);
    if (validated && !seen.has(validated)) {
      seen.add(validated);
      links.push(validated);
    }
  };

  if (html) {
    for (const anchor of extractAnchors(html)) push(anchor.url);
  }
  const visibleText = [text, html ? htmlToText(html) : ''].join('\n');
  for (const match of visibleText.matchAll(BARE_URL_RE)) push(match[0]);
  return links;
}
