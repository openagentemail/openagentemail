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

import { config } from './lib/config.ts';
import { startRetentionLoop } from './lib/retention.ts';
import { createApp } from './app.ts';

const app = createApp();

startRetentionLoop();

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
