import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { OUTER_CSP, UI_CSS, UI_HTML, UI_JS, UI_LOGO_SVG } from '../ui/assets.ts';
import { uiShellRegisterPaths } from '../ui/shell-routes.ts';

// Satoshi 字体与官网（website/public/fonts/）同源同文件；缺失时启动即报错，不半死不活。
const UI_FONTS: Record<string, Uint8Array> = {
  'Satoshi-Regular.woff2': readFileSync(new URL('../ui/fonts/Satoshi-Regular.woff2', import.meta.url)),
  'Satoshi-Medium.woff2': readFileSync(new URL('../ui/fonts/Satoshi-Medium.woff2', import.meta.url)),
  'Satoshi-Bold.woff2': readFileSync(new URL('../ui/fonts/Satoshi-Bold.woff2', import.meta.url)),
  'Satoshi-Black.woff2': readFileSync(new URL('../ui/fonts/Satoshi-Black.woff2', import.meta.url)),
};

/** ADR #26：app shell 覆盖的真实 /ui/* 子路径（须在 API/assets/frame/OAuth 之后注册）。 */
const UI_SHELL_PATHS = uiShellRegisterPaths();

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

/** 静态资产：js/css/fonts/favicon。不含 shell 深链（防注册顺序吞路由）。 */
export function registerUiAssets(app: Hono): void {
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
  app.get('/ui/fonts/:name', (c) => {
    const data = UI_FONTS[c.req.param('name')];
    if (!data) return c.body(null, 404);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    // 文件名随官网字体变更而同步换内容（sha256 钉在测试里），可安全长缓存。
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
    c.header('Content-Type', 'font/woff2');
    return c.body(data);
  });
  // 旧外壳可能仍在缓存里，保留 204 以免它拿到 404。
  app.get('/ui/favicon.ico', (c) => {
    commonHeaders(c);
    return c.body(null, 204);
  });
}

/**
 * Dashboard shell 深链：必须在 /ui/api、/ui/frame、/ui/oauth 之后注册（ADR #26）。
 * 路径与 API 前缀无交集，但后挂才能保证后续加宽匹配时不吞专用路由。
 */
export function registerUiShell(app: Hono): void {
  // B6 0 期：旧 Overview 书签只做永久兼容跳转，不再返回旧 shell。
  app.get('/ui/overview', (c) => c.redirect('/ui', 301));
  app.get('/ui/overview/', (c) => c.redirect('/ui', 301));
  for (const path of UI_SHELL_PATHS) {
    app.get(path, shell);
  }
}
