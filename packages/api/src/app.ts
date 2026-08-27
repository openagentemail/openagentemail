import { join } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  bearerAuth,
  resolveUiSessionToken,
  resolveUiSessionTokenByHash,
  type Auth,
} from './lib/auth.ts';
import { config } from './lib/config.ts';
import { JSON_BODY_LIMIT_BYTES } from './lib/limits.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from './lib/ui-session.ts';
import { getMcpLoopbackBase } from './lib/mcp-loopback.ts';
import { registerMcpHttpRoutes } from './mcp/http.ts';
import { auditRoute } from './routes/audit.ts';
import { identitiesRoute } from './routes/identities.ts';
import { messagesRoute } from './routes/messages.ts';
import { sendRoute } from './routes/send.ts';
import { notifyRoute } from './routes/notify.ts';
import { createTaskRoutes, tasksRoute } from './routes/tasks.ts';
import type { TaskService } from './lib/tasks.ts';
import { agentCardRoute } from './routes/agent-card.ts';
import { registerOAuthRoutes, type OAuthRouteOptions } from './routes/oauth.ts';
import { createUiApiRoutes } from './routes/ui.ts';
import { registerUiAssets, registerUiShell } from './routes/ui-assets.ts';
import { createUiFrameRoutes } from './routes/ui-frame.ts';
import {
  createUiOAuthApiRoutes,
  createUiOAuthPageRoutes,
} from './routes/ui-oauth.ts';

type AppOptions = {
  uiEnabled?: boolean;
  tokenResolver?: (token: string) => Auth | null;
  /** 测试可注入：按 tokenHash 反解（与 tokenResolver 配套；默认走生产实现）。 */
  tokenHashResolver?: (tokenHash: string) => Auth | null;
  /** 测试可注入 CIMD fetcher。 */
  oauth?: OAuthRouteOptions;
  /** 测试可注入 MCP 对外 base（等同 MCP_PUBLIC_URL；含 401 resource_metadata）。 */
  mcpPublicBaseUrl?: string;
  /**
   * 测试可注入 task 服务（MCP /v1 回环走同一条 REST，不改响应形态）。
   * @internal 仅测试可用，禁止用于生产组装。
   */
  taskService?: TaskService;
};

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  // PRM / 8414 必须在 agentCard 子应用之前注册，避免 /.well-known 前缀吞掉路径。
  registerMcpHttpRoutes(app, {
    // 工具回环：base 为外部 origin / MCP_PUBLIC_URL（见 mcp-loopback ALS）。
    // 必须用完整绝对 URL 的 Request 走 app.fetch，使 /v1 的 c.req.url.origin
    // 与 OAuth aud 同源——禁止额外 header 传信任（/v1 对外可达）。
    apiFetch: (input, init) => {
      const expectedBase = getMcpLoopbackBase();
      if (!expectedBase) {
        throw new Error('mcp apiFetch: missing loopback public base context');
      }
      const expectedOrigin = new URL(expectedBase).origin;

      let request: Request;
      if (typeof input !== 'string' && !(input instanceof URL) && init === undefined) {
        request = input;
      } else {
        const href =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        request = new Request(href, init);
      }
      const url = new URL(request.url);
      if (url.origin !== expectedOrigin) {
        throw new Error(
          `mcp apiFetch: unexpected origin ${url.origin}; expected ${expectedOrigin}`,
        );
      }
      // 保留绝对 URL，供 bearerAuth 用同一 origin 推导 resource
      return app.fetch(request);
    },
    publicBaseUrl: options.mcpPublicBaseUrl,
  });
  registerOAuthRoutes(app, options.oauth ?? {});
  app.route('/.well-known', agentCardRoute);

  // Bound allocation before auth or JSON parsing.
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: JSON_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'request_too_large' }, 413),
    }),
  );
  app.use('/v1/*', bearerAuth);
  app.route('/v1/identities', identitiesRoute);
  app.route('/v1/messages', messagesRoute);
  app.route('/v1/send', sendRoute);
  app.route('/v1/notify', notifyRoute);
  app.route(
    '/v1/tasks',
    options.taskService
        ? createTaskRoutes({
          service: options.taskService,
        })
      : tasksRoute,
  );
  app.route('/v1/audit', auditRoute);

  if (options.uiEnabled ?? config.uiEnabled) {
    const uiSessions = new UiSessionStore({
      // UI 会话默认拒 OAuth access；测试可经 tokenResolver 注入覆盖。
      resolveToken: options.tokenResolver ?? resolveUiSessionToken,
      // 重启后落盘会话无明文 token，按 hash 反解（与 resolveUiSessionToken 同范围）。
      resolveTokenHash: options.tokenHashResolver ?? resolveUiSessionTokenByHash,
      // Trust-30d 必须活过 api 容器重建：落盘 DATA_DIR/ui-sessions.json
      persistPath: join(config.dataDir, 'ui-sessions.json'),
    });
    registerUiAssets(app);
    app.use('/ui/api/session', uiSessionBodyLimit);
    app.use('/ui/api/session', requireUiOrigin);
    app.route('/ui/api/session', createUiSessionRoutes(uiSessions));
    // /ui/api/* now has unsafe methods too (POST messages/:id/seen); the gate
    // passes GET/HEAD/OPTIONS through, so this only guards the writes.
    app.use('/ui/api/*', uiSessionBodyLimit);
    app.use('/ui/api/*', requireUiOrigin);
    app.route('/ui/api/oauth', createUiOAuthApiRoutes(uiSessions));
    app.route('/ui/api', createUiApiRoutes(uiSessions));
    app.route('/ui/oauth', createUiOAuthPageRoutes(uiSessions, options.oauth ?? {}));
    app.route('/ui/frame', createUiFrameRoutes(uiSessions));
    // ADR #26：shell 深链必须在 API / OAuth / frame 之后，防止吞专用路由。
    registerUiShell(app);
  }

  app.onError((err, c) => {
    console.error('[api] unhandled error:', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
