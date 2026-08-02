import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bearerAuth, resolveToken, type Auth } from './lib/auth.ts';
import { config } from './lib/config.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from './lib/ui-session.ts';
import { identitiesRoute } from './routes/identities.ts';
import { messagesRoute } from './routes/messages.ts';
import { sendRoute } from './routes/send.ts';
import { notifyRoute } from './routes/notify.ts';
import { createUiApiRoutes } from './routes/ui.ts';
import { registerUiAssets } from './routes/ui-assets.ts';
import { createUiFrameRoutes } from './routes/ui-frame.ts';

type AppOptions = {
  uiEnabled?: boolean;
  tokenResolver?: (token: string) => Auth | null;
};

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  // Bound allocation before auth or JSON parsing.
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
  app.route('/v1/notify', notifyRoute);

  if (options.uiEnabled ?? config.uiEnabled) {
    const uiSessions = new UiSessionStore({
      resolveToken: options.tokenResolver ?? resolveToken,
    });
    registerUiAssets(app);
    app.use('/ui/api/session', uiSessionBodyLimit);
    app.use('/ui/api/session', requireUiOrigin);
    app.route('/ui/api/session', createUiSessionRoutes(uiSessions));
    // /ui/api/* now has unsafe methods too (POST messages/:id/seen); the gate
    // passes GET/HEAD/OPTIONS through, so this only guards the writes.
    app.use('/ui/api/*', uiSessionBodyLimit);
    app.use('/ui/api/*', requireUiOrigin);
    app.route('/ui/api', createUiApiRoutes(uiSessions));
    app.route('/ui/frame', createUiFrameRoutes(uiSessions));
  }

  app.onError((err, c) => {
    console.error('[api] unhandled error:', err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
