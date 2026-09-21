/**
 * 邮件 HTML iframe 文档面（#137 B1/B2：用户可见串走 tServer + 会话 locale）。
 */
import { getCookie } from 'hono/cookie';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { getMessage, type MessageDetail } from '../lib/imap.ts';
import {
  sanitizeEmailHtml,
  type SanitizedEmailHtml,
} from '../lib/sanitize-email-html.ts';
import { UiSessionStore } from '../lib/ui-session.ts';
import { getUiI18nDict } from '../ui/client/i18n-dicts.ts';
import { tServer as t } from '../ui/client/i18n-en.ts';
import { resolveUiLocale, type UiLocale } from '../ui/i18n/resolve-ui-locale.ts';
import { isValidMessageUid } from './ui.ts';

export const FRAME_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox";

export type UiFrameDependencies = {
  getMessage: (address: string, id: string) => Promise<MessageDetail | null>;
  sanitizeEmailHtml?: (html: string) => SanitizedEmailHtml;
};

const querySchema = z.object({
  address: z.string().email(),
});

type FrameStatus = 200 | 400 | 401 | 403 | 404 | 413 | 500;

type FrameCtx = {
  locale: UiLocale;
  dict?: Record<string, string>;
};

/** 与 dashboard 同源：oa_lang → Accept-Language → en。 */
function frameLocaleOf(c: Context): FrameCtx {
  const locale = resolveUiLocale({
    cookie: getCookie(c, 'oa_lang'),
    acceptLanguage: c.req.header('Accept-Language'),
  });
  return { locale, dict: getUiI18nDict(locale) };
}

function frameDocument(ctx: FrameCtx, body: string): string {
  const lang = ctx.locale;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' +
    t('frame.docTitle', ctx.dict) +
    '</title>' +
    '<style>html{color-scheme:dark}body{margin:0;padding:24px;background:#fff;color:#171717;' +
    'font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'overflow-wrap:anywhere}main{max-width:760px;margin:auto}table{border-collapse:collapse;max-width:100%}' +
    'th,td{border:1px solid #bbb;padding:6px}pre{white-space:pre-wrap}h1{font-size:1.15rem}</style>' +
    `</head><body>${body}</body></html>`
  );
}

function errorBody(ctx: FrameCtx, messageKey: string): string {
  return `<main><h1>${t('frame.brandH1', ctx.dict)}</h1><p>${t(messageKey, ctx.dict)}</p></main>`;
}

function frameResponse(
  c: Context,
  ctx: FrameCtx,
  body: string,
  status: FrameStatus,
) {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Security-Policy', FRAME_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  // Cookie（会话 + oa_lang）与 Accept-Language 均影响渲染
  c.header('Vary', 'Authorization, Cookie, Accept-Language');
  return c.body(frameDocument(ctx, body), status);
}

export function createUiFrameRoutes(
  store: UiSessionStore,
  dependencies: UiFrameDependencies = { getMessage },
): Hono {
  const routes = new Hono();
  const sanitize = dependencies.sanitizeEmailHtml ?? sanitizeEmailHtml;

  routes.get('/:id', async (c) => {
    const ctx = frameLocaleOf(c);
    const sid = getCookie(c, 'oae_ui');
    const session = sid ? store.authenticate(sid) : null;
    if (!session) {
      return frameResponse(
        c,
        ctx,
        errorBody(ctx, 'frame.error.sessionExpired'),
        401,
      );
    }

    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success || !isValidMessageUid(c.req.param('id'))) {
      return frameResponse(
        c,
        ctx,
        errorBody(ctx, 'frame.error.invalidRequest'),
        400,
      );
    }
    const address = parsed.data.address.toLowerCase();
    if (
      session.auth.kind === 'identity' &&
      session.auth.address !== address
    ) {
      return frameResponse(c, ctx, errorBody(ctx, 'frame.error.forbidden'), 403);
    }

    let message: MessageDetail | null;
    try {
      message = await dependencies.getMessage(address, c.req.param('id'));
    } catch {
      return frameResponse(
        c,
        ctx,
        errorBody(ctx, 'frame.error.previewUnavailable'),
        500,
      );
    }
    if (!message) {
      return frameResponse(c, ctx, errorBody(ctx, 'frame.error.gone'), 404);
    }
    if (!message.html) {
      return frameResponse(c, ctx, errorBody(ctx, 'frame.error.noHtml'), 404);
    }

    const sanitized = sanitize(message.html);
    if (sanitized.kind === 'too_large') {
      return frameResponse(
        c,
        ctx,
        errorBody(ctx, 'frame.error.tooLarge'),
        413,
      );
    }
    if (sanitized.kind === 'failed') {
      return frameResponse(
        c,
        ctx,
        errorBody(ctx, 'frame.error.previewUnavailable'),
        500,
      );
    }
    return frameResponse(c, ctx, sanitized.html, 200);
  });

  return routes;
}
