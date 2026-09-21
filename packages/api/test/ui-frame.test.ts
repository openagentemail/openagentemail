import { describe, expect, mock, test } from 'bun:test';
import type { Auth } from '../src/lib/auth.ts';
import type { MessageDetail } from '../src/lib/imap.ts';
import type { UiFrameDependencies } from '../src/routes/ui-frame.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { Hono } = await import('hono');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { FRAME_CSP, createUiFrameRoutes } = await import('../src/routes/ui-frame.ts');

const detail: MessageDetail = {
  id: '7',
  from: 'sender@example.net',
  to: 'fox@test.example',
  subject: 'Poison',
  date: '2026-07-27T00:00:00.000Z',
  text: 'plain fallback',
  html: '<p>Hello</p><img src=x onerror=alert(1)><script>alert(2)</script>',
  otp: { codes: [], links: [] },
  links: [],
  source: 'external',
};

function frameApp(
  auth: Auth,
  overrides: Partial<UiFrameDependencies> = {},
) {
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'ok' ? auth : null),
  });
  const created = store.create('ok', '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const dependencies: UiFrameDependencies = {
    getMessage: mock(async () => detail),
    ...overrides,
  };
  const app = new Hono();
  app.route('/ui/frame', createUiFrameRoutes(store, dependencies));
  return { app, cookie: `oae_ui=${created.sid}`, dependencies };
}

function getFrame(app: InstanceType<typeof Hono>, cookie?: string, address = 'fox@test.example') {
  return app.request(`/ui/frame/7?address=${encodeURIComponent(address)}`, {
    headers: cookie ? { cookie } : {},
  });
}

function expectFrameSecurityHeaders(response: Response): void {
  expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('content-security-policy')).toBe(FRAME_CSP);
}

describe('/ui/frame isolation response', () => {
  test('returns only sanitized HTML under the exact browser containment headers', async () => {
    const { app, cookie } = frameApp({ kind: 'admin' });
    const response = await getFrame(app, cookie);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(FRAME_CSP);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization, Cookie, Accept-Language');
    expect(body).toContain('<p>Hello</p>');
    expect(body).not.toMatch(/script|onerror|<img/i);
  });

  test('missing sessions and cross-identity reads are branded HTML errors', async () => {
    const unauthenticated = frameApp({ kind: 'admin' });
    const missing = await getFrame(unauthenticated.app);
    expect(missing.status).toBe(401);
    expectFrameSecurityHeaders(missing);
    expect(await missing.text()).toContain('OpenAgent Inbox');

    const scoped = frameApp({ kind: 'identity', address: 'fox@test.example' });
    const denied = await getFrame(scoped.app, scoped.cookie, 'owl@test.example');
    expect(denied.status).toBe(403);
    expectFrameSecurityHeaders(denied);
    expect(await denied.text()).not.toContain('owl@test.example');
  });

  test('invalid queries and messages without HTML keep frame containment', async () => {
    const { app, cookie } = frameApp(
      { kind: 'admin' },
      { getMessage: mock(async () => ({ ...detail, html: undefined })) },
    );
    const invalid = await app.request('/ui/frame/7', {
      headers: { cookie },
    });
    expect(invalid.status).toBe(400);
    expectFrameSecurityHeaders(invalid);

    const noHtml = await getFrame(app, cookie);
    expect(noHtml.status).toBe(404);
    expectFrameSecurityHeaders(noHtml);
    expect(await noHtml.text()).toContain('OpenAgent Inbox');
  });

  test('missing, oversized, malformed and parser-failed messages never expose raw HTML', async () => {
    const cases: Array<{
      overrides: Partial<UiFrameDependencies>;
      status: number;
      forbidden: string;
    }> = [
      { overrides: { getMessage: mock(async () => null) }, status: 404, forbidden: 'raw-404' },
      {
        overrides: {
          getMessage: mock(async () => ({
            ...detail,
            html: `<p>oversized-secret</p>${'x'.repeat(512 * 1024 + 1)}`,
          })),
        },
        status: 413,
        forbidden: 'oversized-secret',
      },
      {
        overrides: {
          getMessage: mock(async () => {
            throw new Error('mail disappeared with raw-500');
          }),
        },
        status: 500,
        forbidden: 'raw-500',
      },
      {
        overrides: {
          sanitizeEmailHtml: () => ({ kind: 'failed', html: '' }),
        },
        status: 500,
        forbidden: '<p>Hello</p>',
      },
    ];

    for (const testCase of cases) {
      const { app, cookie } = frameApp({ kind: 'admin' }, testCase.overrides);
      const response = await getFrame(app, cookie);
      const body = await response.text();
      expect(response.status).toBe(testCase.status);
      expectFrameSecurityHeaders(response);
      expect(body).not.toContain(testCase.forbidden);
      expect(body).toContain('OpenAgent Inbox');
    }
  });

  test('malformed UIDs are rejected before IMAP', async () => {
    const getMessage = mock(async () => detail);
    const { app, cookie } = frameApp({ kind: 'admin' }, { getMessage });
    for (const id of ['1e3', '0', '-1', '999999999999999999999999']) {
      const response = await app.request(
        `/ui/frame/${encodeURIComponent(id)}?address=fox%40test.example`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(400);
      expectFrameSecurityHeaders(response);
    }
    expect(getMessage).not.toHaveBeenCalled();
  });

  test('#137 B2 R1：非 en 会话 iframe 错误页 lang + 本地化串', async () => {
    const { I18N_ZH_CN } = await import('../src/ui/client/i18n-zh-cn.ts');
    const { I18N_JA } = await import('../src/ui/client/i18n-ja.ts');
    const unauthenticated = frameApp({ kind: 'admin' });
    const zh = await unauthenticated.app.request(
      `/ui/frame/7?address=${encodeURIComponent('fox@test.example')}`,
      { headers: { Cookie: 'oa_lang=zh-CN' } },
    );
    expect(zh.status).toBe(401);
    const zhBody = await zh.text();
    expect(zhBody).toContain('<html lang="zh-CN">');
    expect(zhBody).toContain(I18N_ZH_CN['frame.error.sessionExpired']!);
    expect(zhBody).not.toContain('Your session has expired');

    const scoped = frameApp({ kind: 'identity', address: 'fox@test.example' });
    const ja = await scoped.app.request(
      `/ui/frame/7?address=${encodeURIComponent('owl@test.example')}`,
      { headers: { cookie: `${scoped.cookie}; oa_lang=ja` } },
    );
    expect(ja.status).toBe(403);
    const jaBody = await ja.text();
    expect(jaBody).toContain('<html lang="ja">');
    expect(jaBody).toContain(I18N_JA['frame.error.forbidden']!);
    expect(jaBody).not.toContain('This inbox is not available');
  });
});
