import type { Context } from 'hono';
import type { Hono } from 'hono';
import { OUTER_CSP, UI_CSS, UI_HTML, UI_JS } from '../ui/assets.ts';

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
}
