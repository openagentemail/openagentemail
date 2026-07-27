/**
 * openagent.email REST API — entrypoint.
 *
 * Routes:
 *   GET  /healthz                              (unauthenticated)
 *   POST /v1/identities                        (admin)
 *   GET  /v1/identities                        (admin)
 *   POST /v1/identities/:address/token         (admin — rotate scoped token)
 *   DELETE /v1/identities/:address             (admin)
 *   GET  /v1/messages?address=&limit=          (admin, or the identity itself)
 *   GET  /v1/messages/:id?address=             (admin, or the identity itself)
 *   POST /v1/messages/wait                     (admin, or the identity itself)
 *   POST /v1/send                              (admin, or the identity itself)
 * Auth: `Authorization: Bearer <key>` — admin keys from API_KEYS env, or a
 * per-identity scoped token issued at identity creation.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { config } from './lib/config.ts';
import { bearerAuth, resolveToken } from './lib/auth.ts';
import { startRetentionLoop } from './lib/retention.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from './lib/ui-session.ts';
import { identitiesRoute } from './routes/identities.ts';
import { messagesRoute } from './routes/messages.ts';
import { sendRoute } from './routes/send.ts';
import { createUiApiRoutes } from './routes/ui.ts';
import { createUiFrameRoutes } from './routes/ui-frame.ts';

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));

// Bound the allocation before anything parses JSON. The send schema allows up
// to 1M characters each for text and html, so 16 MiB leaves room for UTF-8 and
// JSON escaping while refusing payloads sized to exhaust the process. Ahead of
// auth on purpose: an unauthenticated caller shouldn't get to stream GiBs in
// either.
app.use(
  '/v1/*',
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }),
);
app.use('/v1/*', bearerAuth);
app.route('/v1/identities', identitiesRoute);
app.route('/v1/messages', messagesRoute);
app.route('/v1/send', sendRoute);

if (config.uiEnabled) {
  const uiSessions = new UiSessionStore({ resolveToken });
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(uiSessions));
  app.route('/ui/api', createUiApiRoutes(uiSessions));
  app.route('/ui/frame', createUiFrameRoutes(uiSessions));
}

app.onError((err, c) => {
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'internal_error' }, 500);
});

startRetentionLoop();

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
