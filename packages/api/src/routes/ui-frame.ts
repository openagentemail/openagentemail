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

function frameDocument(body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>OpenAgent Inbox message</title>' +
    '<style>html{color-scheme:dark}body{margin:0;padding:24px;background:#fff;color:#171717;' +
    'font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'overflow-wrap:anywhere}main{max-width:760px;margin:auto}table{border-collapse:collapse;max-width:100%}' +
    'th,td{border:1px solid #bbb;padding:6px}pre{white-space:pre-wrap}h1{font-size:1.15rem}</style>' +
    `</head><body>${body}</body></html>`
  );
}

function errorBody(message: string): string {
  return `<main><h1>OpenAgent Inbox</h1><p>${message}</p></main>`;
}

function frameResponse(
  c: Context,
  body: string,
  status: FrameStatus,
) {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Security-Policy', FRAME_CSP);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('Vary', 'Authorization, Cookie');
  return c.body(frameDocument(body), status);
}

export function createUiFrameRoutes(
  store: UiSessionStore,
  dependencies: UiFrameDependencies = { getMessage },
): Hono {
  const routes = new Hono();
  const sanitize = dependencies.sanitizeEmailHtml ?? sanitizeEmailHtml;

  routes.get('/:id', async (c) => {
    const sid = getCookie(c, 'oae_ui');
    const session = sid ? store.authenticate(sid) : null;
    if (!session) {
      return frameResponse(
        c,
        errorBody('Your session has expired. Return to the inbox and sign in again.'),
        401,
      );
    }

    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success || !isValidMessageUid(c.req.param('id'))) {
      return frameResponse(c, errorBody('This message request is invalid.'), 400);
    }
    const address = parsed.data.address.toLowerCase();
    if (
      session.auth.kind === 'identity' &&
      session.auth.address !== address
    ) {
      return frameResponse(c, errorBody('This inbox is not available to this session.'), 403);
    }

    let message: MessageDetail | null;
    try {
      message = await dependencies.getMessage(address, c.req.param('id'));
    } catch {
      return frameResponse(
        c,
        errorBody('The HTML preview is unavailable. Use the plain-text view instead.'),
        500,
      );
    }
    if (!message) {
      return frameResponse(c, errorBody('This email is no longer available.'), 404);
    }
    if (!message.html) {
      return frameResponse(c, errorBody('This email has no HTML version.'), 404);
    }

    const sanitized = sanitize(message.html);
    if (sanitized.kind === 'too_large') {
      return frameResponse(
        c,
        errorBody('This email is too large to preview. Use the plain-text view instead.'),
        413,
      );
    }
    if (sanitized.kind === 'failed') {
      return frameResponse(
        c,
        errorBody('The HTML preview is unavailable. Use the plain-text view instead.'),
        500,
      );
    }
    return frameResponse(c, sanitized.html, 200);
  });

  return routes;
}
