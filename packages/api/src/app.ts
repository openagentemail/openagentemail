import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bearerAuth, resolveUiSessionToken, type Auth } from './lib/auth.ts';
import { config } from './lib/config.ts';
import { JSON_BODY_LIMIT_BYTES } from './lib/limits.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from './lib/ui-session.ts';
import { registerMcpHttpRoutes } from './mcp/http.ts';
import { identitiesRoute } from './routes/identities.ts';
import { messagesRoute } from './routes/messages.ts';
import { sendRoute } from './routes/send.ts';
import { notifyRoute } from './routes/notify.ts';
import { tasksRoute } from './routes/tasks.ts';
import { agentCardRoute } from './routes/agent-card.ts';
import { registerOAuthRoutes, type OAuthRouteOptions } from './routes/oauth.ts';
import { createUiApiRoutes } from './routes/ui.ts';
import { registerUiAssets } from './routes/ui-assets.ts';
import { createUiFrameRoutes } from './routes/ui-frame.ts';
import {
  createUiOAuthApiRoutes,
  createUiOAuthPageRoutes,
} from './routes/ui-oauth.ts';

type AppOptions = {
  uiEnabled?: boolean;
  tokenResolver?: (token: string) => Auth | null;
  /** 测试可注入 CIMD fetcher。 */
  oauth?: OAuthRouteOptions;
};

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));
  // PRM / 8414 必须在 agentCard 子应用之前注册，避免 /.well-known 前缀吞掉路径。
  registerMcpHttpRoutes(app, {
    // OpenAgentEmailClient 固定 base `http://mcp.internal`；此处只取 pathname+search
    // 回环进本进程。host 必须是 mcp.internal，否则视为契约破坏（显式断言）。
    apiFetch: (input, init) => {
      if (typeof input !== 'string' && !(input instanceof URL) && init === undefined) {
        const host = new URL(input.url).hostname;
        if (host !== 'mcp.internal') {
          throw new Error(`mcp apiFetch: unexpected host ${host}; expected mcp.internal`);
        }
        return app.fetch(input);
      }
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const url = new URL(href);
      if (url.hostname !== 'mcp.internal') {
        throw new Error(`mcp apiFetch: unexpected host ${url.hostname}; expected mcp.internal`);
      }
      return app.request(url.pathname + url.search, init);
    },
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
  app.route('/v1/tasks', tasksRoute);

  if (options.uiEnabled ?? config.uiEnabled) {
    const uiSessions = new UiSessionStore({
      // UI 会话默认拒 OAuth access；测试可经 tokenResolver 注入覆盖。
      resolveToken: options.tokenResolver ?? resolveUiSessionToken,
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
  }

  app.onError((err, c) => {
    console.error('[api] unhandled error:', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
