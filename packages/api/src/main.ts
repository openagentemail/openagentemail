/**
 * openagent.email REST API — entrypoint.
 *
 * Routes:
 *   GET  /healthz                  (unauthenticated)
 *   POST /v1/identities
 *   GET  /v1/identities
 *   GET  /v1/messages?address=&limit=
 *   GET  /v1/messages/:id?address=
 *   POST /v1/messages/wait
 *   POST /v1/send
 * All /v1/* require `Authorization: Bearer <key>` (keys from API_KEYS env).
 */

import { Hono } from 'hono';
import { config } from './lib/config.ts';
import { bearerAuth } from './lib/auth.ts';
import { identitiesRoute } from './routes/identities.ts';
import { messagesRoute } from './routes/messages.ts';
import { sendRoute } from './routes/send.ts';

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));

app.use('/v1/*', bearerAuth);
app.route('/v1/identities', identitiesRoute);
app.route('/v1/messages', messagesRoute);
app.route('/v1/send', sendRoute);

app.onError((err, c) => {
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'internal_error' }, 500);
});

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
