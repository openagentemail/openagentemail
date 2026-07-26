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
  // Block-level boundaries become newlines.
  s = s.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|table|ul|ol)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Everything else just goes.
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // Tidy whitespace per line, collapse blank runs.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
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

/** Pull href + anchor text pairs out of an HTML part. */
function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    anchors.push({ url: m[1], anchorText: htmlToText(m[2]) });
  }
  return anchors;
}

const BARE_URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function looksLikeActionLink(url: string, anchorText = ''): boolean {
  return LINK_INTENT.test(url) || LINK_INTENT.test(anchorText);
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
    if (!seen.has(clean)) {
      seen.add(clean);
      links.push(clean);
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
  const effectiveText = text.trim() || (html ? htmlToText(html) : '');
  return {
    codes: extractCodes(effectiveText),
    links: extractLinks(effectiveText, html),
  };
}
