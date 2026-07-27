import type { Context } from 'hono';
import type { Hono } from 'hono';
import { OUTER_CSP, UI_CSS, UI_HTML, UI_JS, UI_LOGO_SVG } from '../ui/assets.ts';

function commonHeaders(c: Context): void {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-cache');
}

function shell(c: Context) {
  commonHeaders(c);
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Security-Policy', OUTER_CSP);
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  return c.body(UI_HTML);
}

export function registerUiAssets(app: Hono): void {
  app.get('/ui', shell);
  app.get('/ui/', shell);
  app.get('/ui/app.js', (c) => {
    commonHeaders(c);
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(UI_JS);
  });
  app.get('/ui/styles.css', (c) => {
    commonHeaders(c);
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(UI_CSS);
  });
  app.get('/ui/favicon.svg', (c) => {
    commonHeaders(c);
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    // 被直接导航打开时也不可能跑脚本、不可能取任何子资源
    c.header('Content-Security-Policy', "default-src 'none'");
    return c.body(UI_LOGO_SVG);
  });
  // 旧外壳可能仍在缓存里，保留 204 以免它拿到 404。
  app.get('/ui/favicon.ico', (c) => {
    commonHeaders(c);
    return c.body(null, 204);
  });
}
