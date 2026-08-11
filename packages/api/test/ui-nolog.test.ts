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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-nolog-'));

const { afterEach, expect, spyOn, test } = await import('bun:test');
const { Hono } = await import('hono');
type Auth = import('../src/lib/auth.ts').Auth;
const {
  UiSessionStore,
  createUiSessionRoutes,
  requireUiOrigin,
  uiSessionBodyLimit,
} = await import('../src/lib/ui-session.ts');

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
