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
import { createApp } from './app.ts';

const app = createApp();

startRetentionLoop();
startNotificationLogMaintenance();
startSendLogMaintenance();
await inspectDeviceRegistryAtBoot();
if (config.ntfy.enabled) {
  await initializeNotifications();
  startNotificationWatcher();
}

console.log(`[api] listening on :${config.port} (domain ${config.domain})`);

/** 去掉末尾 `/`（根路径除外），避免 `/mcp/` 漏匹配。 */
function requestPath(req: Request): string {
  const path = new URL(req.url).pathname;
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * 应用层长轮询入口。进 fetch 后才按请求禁用空闲掐线；
 * 请求尚未读完（慢上传 / 未完成握手）仍受全局 idleTimeout 约束。
 */
function isLongPollRequest(req: Request): boolean {
  const path = requestPath(req);
  if (req.method === 'POST' && (path === '/mcp' || path === '/v1/messages/wait' || path === '/v1/tasks')) {
    return true;
  }
  // GET /v1/tasks/:id?wait=true 与 mail_wait_for 同属阻塞等待。
  if (req.method === 'GET' && /^\/v1\/tasks\/[^/]+$/.test(path)) {
    return new URL(req.url).searchParams.get('wait') === 'true';
  }
  return false;
}

export default {
  port: config.port,
  // 短请求保留 Bun 默认 10s，避免公网慢连接无限占 socket。
  // 长轮询在 fetch 里 server.timeout(req, 0) 按请求豁免。
  idleTimeout: 10,
  fetch(req: Request, server: { timeout(request: Request, seconds: number): void }) {
    if (isLongPollRequest(req)) {
      server.timeout(req, 0);
    }
    return app.fetch(req);
  },
};
