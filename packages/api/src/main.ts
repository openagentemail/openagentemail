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
 *   POST /mcp                                  (stateless MCP; Bearer admin / oa_ / OAuth access)
 *   GET  /.well-known/oauth-protected-resource (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   GET  /authorize → /ui/oauth/authorize      (OAuth 同意页)
 *   POST /oauth/token | /oauth/revoke
 * Auth: `Authorization: Bearer <key>` — admin keys from API_KEYS env, or a
 * per-identity scoped token issued at identity creation.
 */

import { config } from './lib/config.ts';
import { initializeNotifications } from './lib/notify.ts';
import { inspectDeviceRegistryAtBoot } from './lib/notification-devices.ts';
import { startNotificationWatcher } from './lib/notification-watcher.ts';
import { startNotificationLogMaintenance } from './lib/notification-log.ts';
import { startSendLogMaintenance } from './lib/send-log.ts';
import { startRetentionLoop } from './lib/retention.ts';
import { startTaskLeaseReaper } from './lib/task-lease-reaper.ts';
import {
  reconstructPendingDeliveriesAtBoot,
  startWebhookMaintenance,
} from './lib/webhook-delivery.ts';
import { createApp } from './app.ts';

const app = createApp();

startRetentionLoop();
startTaskLeaseReaper();
startNotificationLogMaintenance();
startSendLogMaintenance();
await inspectDeviceRegistryAtBoot();
if (config.ntfy.enabled) {
  await initializeNotifications();
}
if ((config.ntfy.enabled && config.ntfy.pushPolicy !== 'none') || config.webhooks.enabled) {
  startNotificationWatcher();
}
if (config.webhooks.enabled) {
  startWebhookMaintenance();
  try {
    await reconstructPendingDeliveriesAtBoot();
  } catch (err) {
    console.error('[webhooks] boot reconstruction failed, proceeding with startup:', err);
  }
}

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

export default {
  port: config.port,
  // 禁用 Bun.serve 默认 10s 空闲掐线。mail_wait_for / POST /v1/messages/wait
  // 等长连接超时由应用层 MCP_MAX_WAIT_SECONDS（默认 60s）治理，不该在 server 层掐断。
  idleTimeout: 0,
  fetch: app.fetch,
};
