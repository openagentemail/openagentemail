// config.ts 在 import 时解析 env；裸 env 单跑会 ZodError/TDZ。套件标准前奏。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-origin-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
const {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} = await import('../src/lib/ui-session.ts');

const resolver = (token: string): Auth | null => (token === 'ok' ? { kind: 'admin' } : null);

function appWithOriginGuard() {
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(new UiSessionStore({ resolveToken: resolver })));
  return app;
}

function post(headers: Record<string, string>, body = '{"token":"ok"}') {
  return appWithOriginGuard().request('https://mail.example/ui/api/session', {
    method: 'POST',
    headers,
    body,
  });
}

describe('UI unsafe-method Origin gate', () => {
  test('same-origin JSON is accepted', async () => {
    const response = await post({
      'content-type': 'application/json',
      origin: 'https://mail.example',
      'sec-fetch-site': 'same-origin',
    });
    expect(response.status).toBe(200);
  });

  test('application/json from an evil Origin is rejected before login', async () => {
    const response = await post({
      'content-type': 'application/json',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
  });

  test('cross-site text/plain is rejected and no CORS permission leaks', async () => {
    const response = await post({
      'content-type': 'text/plain',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('missing Origin needs an explicit same-origin browser signal', async () => {
    const allowed = await post({
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    });
    expect(allowed.status).toBe(200);

    const ambiguous = await post({ 'content-type': 'application/json' });
    expect(ambiguous.status).toBe(403);
  });

  test('TLS termination may change only the upstream scheme, not the public host', async () => {
    const app = appWithOriginGuard();
    const response = await app.request('http://mail.example/ui/api/session', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://mail.example',
        'sec-fetch-site': 'same-origin',
      },
      body: '{"token":"ok"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
});
