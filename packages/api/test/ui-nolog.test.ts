import { afterEach, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';
import type { Auth } from '../src/lib/auth.ts';
import {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} from '../src/lib/ui-session.ts';

afterEach(() => {
  (console.log as typeof console.log & { mockRestore?: () => void }).mockRestore?.();
  (console.warn as typeof console.warn & { mockRestore?: () => void }).mockRestore?.();
  (console.error as typeof console.error & { mockRestore?: () => void }).mockRestore?.();
});

test('login never writes or returns the submitted token', async () => {
  const secret = 'oa_unique-secret-that-must-not-escape';
  const resolver = (token: string): Auth | null => (token === secret ? { kind: 'admin' } : null);
  const app = new Hono();
  app.use('/ui/api/session', uiSessionBodyLimit);
  app.use('/ui/api/session', requireUiOrigin);
  app.route('/ui/api/session', createUiSessionRoutes(new UiSessionStore({ resolveToken: resolver })));

  const calls: unknown[][] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
  }

  const response = await app.request('http://localhost/ui/api/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ token: secret }),
  });

  expect(response.status).toBe(200);
  const exposed = [
    await response.text(),
    response.headers.get('set-cookie') ?? '',
    response.headers.get('location') ?? '',
    JSON.stringify(calls),
  ].join('\n');
  expect(exposed).not.toContain(secret);
});
