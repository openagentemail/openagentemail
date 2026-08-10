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
 *   POST /mcp                                  (stateless MCP; Bearer admin or oa_)
 *   GET  /.well-known/oauth-protected-resource (RFC 9728)
 * Auth: `Authorization: Bearer <key>` — admin keys from API_KEYS env, or a
 * per-identity scoped token issued at identity creation.
 */

import { config } from './lib/config.ts';
import { initializeNotifications } from './lib/notify.ts';
import { startNotificationWatcher } from './lib/notification-watcher.ts';
import { startRetentionLoop } from './lib/retention.ts';
import { createApp } from './app.ts';

const app = createApp();

startRetentionLoop();
if (config.ntfy.enabled) {
  await initializeNotifications();
  startNotificationWatcher();
}

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

export default {
  port: config.port,
  fetch: app.fetch,
};
