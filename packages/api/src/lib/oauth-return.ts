/**
 * OAuth 同意页登录回跳：用 Path=/ui 的短时 cookie 携带 returnTo，
 * 避免前端读 location.search（UI 资产契约禁止 URLSearchParams）。
 */

import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';

const COOKIE_NAME = 'oae_oauth_return';
const MAX_AGE_S = 10 * 60;

function cookieSecure(url: string): boolean {
  const parsed = new URL(url);
  const localHost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  return !(parsed.protocol === 'http:' && localHost);
}

/** 仅允许同站 /ui/... 相对路径，防开放重定向。 */
export function sanitizeUiReturnTo(raw: string): string | null {
  if (!raw || raw.charAt(0) !== '/' || raw.startsWith('//')) return null;
  if (raw !== '/ui' && !raw.startsWith('/ui/')) return null;
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return null;
  return raw;
}

export function setOAuthReturnCookie(c: Context, returnPath: string): void {
  const safe = sanitizeUiReturnTo(returnPath);
  if (!safe) return;
  setCookie(c, COOKIE_NAME, safe, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/ui',
    secure: cookieSecure(c.req.url),
    maxAge: MAX_AGE_S,
  });
}

/** 读取并清除 return cookie；非法则丢弃。无 cookie 时不写 Set-Cookie，避免干扰会话测试。 */
export function consumeOAuthReturnCookie(c: Context): string | undefined {
  const raw = getCookie(c, COOKIE_NAME);
  if (!raw) return undefined;
  deleteCookie(c, COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/ui',
    secure: cookieSecure(c.req.url),
  });
  return sanitizeUiReturnTo(raw) ?? undefined;
}
