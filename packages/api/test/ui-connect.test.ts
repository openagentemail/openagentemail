import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-connect-'));

const { describe, expect, test } = await import('bun:test');
const { createApp } = await import('../src/app.ts');

function resolver(token: string) {
  if (token === 'oa_fox-secret') {
    return { kind: 'identity' as const, address: 'fox@test.example' };
  }
  if (token === 'admin-secret') return { kind: 'admin' as const };
  return null;
}

async function login(
  app: ReturnType<typeof createApp>,
  token: string,
): Promise<string> {
  const response = await app.request(
    'https://internal.example/ui/api/session',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://internal.example',
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({ token }),
    },
  );
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0]!;
}

describe('Connect-agent dashboard API', () => {
  test('returns the public MCP endpoint and direct identity session token without caching', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example/base/',
    });
    const cookie = await login(app, 'oa_fox-secret');
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: { cookie },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      endpoint: 'https://mail.public.example/base/mcp',
      identity: 'fox@test.example',
      token: 'oa_fox-secret',
      unavailable: null,
    });
  });

  test('never exposes an admin credential', async () => {
    const app = createApp({
      uiEnabled: true,
      tokenResolver: resolver,
      mcpPublicBaseUrl: 'https://mail.public.example',
    });
    const cookie = await login(app, 'admin-secret');
    const response = await app.request(
      'https://internal.example/ui/api/connect',
      {
        headers: { cookie },
      },
    );
    expect(await response.json()).toEqual({
      endpoint: 'https://mail.public.example/mcp',
      identity: null,
      token: null,
      unavailable: 'identity_session_required',
    });
  });
});
