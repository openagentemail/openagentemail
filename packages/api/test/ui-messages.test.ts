import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');

function makeApp(overrides: Partial<UiApiDependencies> = {}) {
  const deps: UiApiDependencies = {
    listIdentities: () => [],
    listMessages: mock(async () => [
      {
        id: '2',
        from: 'new@example.net',
        to: 'fox@test.example',
        subject: 'New',
        date: '2026-07-27T02:00:00.000Z',
        seen: false,
        snippet: 'newest',
        hasOtp: true,
      },
      {
        id: '1',
        from: 'old@example.net',
        to: 'fox@test.example',
        subject: 'Old',
        date: '2026-07-27T01:00:00.000Z',
        seen: true,
        snippet: 'older',
        hasOtp: false,
      },
    ]),
    getMessage: mock(async () => ({
      id: '2',
      from: 'new@example.net',
      to: 'fox@test.example',
      subject: 'New',
      date: '2026-07-27T02:00:00.000Z',
      text: 'Code 123456. Visit https://example.net/news',
      html: '<img src=x onerror=alert(1)><p>Code 123456</p>',
      otp: { codes: ['123456'], links: ['https://example.net/verify'] },
      links: ['https://example.net/news', 'https://example.net/verify'],
    })),
    ...overrides,
  };
  const store = new UiSessionStore({
    resolveToken: (token) => (token === 'ok' ? { kind: 'admin' } : null),
  });
  const created = store.create('ok', '127.0.0.1');
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  return { app, deps, cookie: `oae_ui=${created.sid}` };
}

describe('UI message JSON contract', () => {
  test('summaries preserve newest-first order and hasOtp', async () => {
    const { app, cookie } = makeApp();
    const response = await app.request(
      '/ui/api/messages?address=fox%40test.example',
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; hasOtp: boolean }>;
    };
    expect(body.messages.map((message: { id: string }) => message.id)).toEqual(['2', '1']);
    expect(body.messages.map((message: { hasOtp: boolean }) => message.hasOtp)).toEqual([
      true,
      false,
    ]);
  });

  test('detail omits raw html but preserves OTP and validated body links', async () => {
    const { app, cookie } = makeApp();
    const response = await app.request(
      '/ui/api/messages/2?address=fox%40test.example',
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      html?: string;
      hasHtml?: boolean;
      htmlTooLarge?: boolean;
      otp: { codes: string[]; links: string[] };
      links: string[];
    };
    expect(body.html).toBeUndefined();
    expect(body.hasHtml).toBe(true);
    expect(body.htmlTooLarge).toBe(false);
    expect(body.otp).toEqual({
      codes: ['123456'],
      links: ['https://example.net/verify'],
    });
    expect(body.links).toEqual([
      'https://example.net/news',
      'https://example.net/verify',
    ]);
  });

  test('oversized HTML is disclosed without returning the HTML itself', async () => {
    const { app, cookie } = makeApp({
      getMessage: mock(async () => ({
        id: '3',
        from: 'large@example.net',
        to: 'fox@test.example',
        subject: 'Large',
        date: '2026-07-27T03:00:00.000Z',
        text: 'Use the plain-text version.',
        html: 'x'.repeat(512 * 1024 + 1),
        otp: { codes: [], links: [] },
        links: [],
      })),
    });
    const response = await app.request(
      '/ui/api/messages/3?address=fox%40test.example',
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.html).toBeUndefined();
    expect(body.hasHtml).toBe(true);
    expect(body.htmlTooLarge).toBe(true);
  });

  test('limit is 1-200, defaults to 50 and is passed as an integer', async () => {
    const { app, deps, cookie } = makeApp();
    expect(
      (
        await app.request('/ui/api/messages?address=fox%40test.example&limit=200', {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect(deps.listMessages).toHaveBeenLastCalledWith('fox@test.example', 200);

    for (const limit of ['0', '201', '1.5', 'nope']) {
      const response = await app.request(
        `/ui/api/messages?address=fox%40test.example&limit=${limit}`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(400);
    }
  });

  test('malformed UIDs are rejected before touching IMAP', async () => {
    const getMessage = mock(async () => null);
    const { app, cookie } = makeApp({ getMessage });
    for (const id of ['1e3', '0', '-1', '999999999999999999999999999999999']) {
      const response = await app.request(
        `/ui/api/messages/${encodeURIComponent(id)}?address=fox%40test.example`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(400);
    }
    const traversal = await app.request(
      '/ui/api/messages/%2E%2E%2F7?address=fox%40test.example',
      { headers: { cookie } },
    );
    expect([400, 404]).toContain(traversal.status);
    expect(getMessage).not.toHaveBeenCalled();
  });
});
