import { readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { mock } from 'bun:test';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-sendhist-'));
process.env.TASK_SIGNING_SECRET = 'send-history-test-secret';
process.env.UI_ENABLED = 'true';

const sendMail = mock(async () => ({ messageId: '<hist@test.example>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { createIdentity } = await import('../src/lib/identities.ts');
const { sendRoute } = await import('../src/routes/send.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { resetSendLogForTests, sendLogPathForTests } = await import('../src/lib/send-log.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { readFileSync: readSrc } = await import('node:fs');

const fox = createIdentity({ localpart: 'fox-send' })!;
const owl = createIdentity({ localpart: 'owl-send' })!;

function bearerApp(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/send', sendRoute);
  return app;
}

function uiApp(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
  const store = new UiSessionStore({
    resolveToken: (token) => {
      if (token === 'admin-ok' && auth.kind === 'admin') return { kind: 'admin' };
      if (token === 'id-ok' && auth.kind === 'identity') {
        return { kind: 'identity', address: auth.address };
      }
      return null;
    },
  });
  const token = auth.kind === 'admin' ? 'admin-ok' : 'id-ok';
  const created = store.create(token, '127.0.0.1');
  if (!created.ok) throw new Error('session');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store));
  return { app, cookie: `oae_ui=${created.sid}` };
}

beforeEach(() => {
  resetSendLogForTests();
  resetRateLimits();
  sendMail.mockImplementation(async () => ({ messageId: '<hist@test.example>' }));
});

afterEach(() => {
  resetSendLogForTests();
});

describe('send history ACL and audit', () => {
  test('successful send returns logged id and appears in Sent history', async () => {
    const app = bearerApp({ kind: 'admin' });
    const sent = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'Visible in Sent',
        text: 'BODY-SECRET-SHOULD-NOT-LAND',
      }),
    });
    expect(sent.status).toBe(200);
    const body = await sent.json();
    expect(body.queued).toBe(true);
    expect(body.id).toMatch(/^snd_/);

    const listed = await app.request(
      `/v1/send/history?address=${encodeURIComponent(fox.identity.address)}&limit=20`,
    );
    expect(listed.status).toBe(200);
    const page = await listed.json();
    expect(page.items[0]?.subject).toBe('Visible in Sent');
    expect(page.items[0]?.result).toBe('queued');
    expect(page.items[0]?.from).toBe(fox.identity.address);
    expect(page.items[0]?.to).toEqual(['out@example.net']);

    const disk = readFileSync(sendLogPathForTests(), 'utf8');
    expect(disk).not.toContain('BODY-SECRET-SHOULD-NOT-LAND');
    expect(disk).not.toContain(fox.token);
    expect(statSync(sendLogPathForTests()).mode & 0o777).toBe(0o600);
  });

  test('failed send is recorded with smtp_error', async () => {
    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('550 no'), { responseCode: 550 });
    });
    const app = bearerApp({ kind: 'admin' });
    const sent = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'Failed send',
        text: 'nope',
      }),
    });
    expect(sent.status).toBe(502);
    const body = await sent.json();
    expect(body.error).toBe('smtp_error');
    expect(body.id).toMatch(/^snd_/);
    const listed = await app.request(
      `/v1/send/history?address=${encodeURIComponent(fox.identity.address)}`,
    );
    const page = await listed.json();
    expect(page.items[0]?.result).toBe('failed');
    expect(page.items[0]?.error).toBe('smtp_error');
  });

  test('identity only sees own sends; peeking at a peer is 403', async () => {
    const admin = bearerApp({ kind: 'admin' });
    await admin.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'a@example.net',
        subject: 'fox mail',
        text: 'x',
      }),
    });
    await admin.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: owl.identity.address,
        to: 'b@example.net',
        subject: 'owl mail',
        text: 'y',
      }),
    });

    const foxApp = bearerApp({ kind: 'identity', address: fox.identity.address });
    const own = await foxApp.request('/v1/send/history?limit=20');
    expect(own.status).toBe(200);
    const ownPage = await own.json();
    expect(ownPage.items.every((row: { from: string }) => row.from === fox.identity.address)).toBe(
      true,
    );
    expect(ownPage.items.some((row: { subject: string }) => row.subject === 'owl mail')).toBe(false);

    const peek = await foxApp.request(
      `/v1/send/history?address=${encodeURIComponent(owl.identity.address)}`,
    );
    expect(peek.status).toBe(403);
    expect(await peek.json()).toEqual({ error: 'forbidden: token is scoped to another address' });
  });

  test('MCP header tags source=mcp', async () => {
    const app = bearerApp({ kind: 'admin' });
    await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oae-send-source': 'mcp' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'from mcp',
        text: 'x',
      }),
    });
    const listed = await app.request(`/v1/send/history?address=${fox.identity.address}`);
    expect((await listed.json()).items[0]?.source).toBe('mcp');
  });

  test('UI send-log mirrors ACL and identity 403', async () => {
    const admin = bearerApp({ kind: 'admin' });
    await admin.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'ui row',
        text: 'x',
      }),
    });
    const { app, cookie } = uiApp({ kind: 'identity', address: fox.identity.address });
    const ok = await app.request(`/ui/api/send-log?address=${fox.identity.address}`, {
      headers: { cookie },
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).items[0]?.subject).toBe('ui row');

    const denied = await app.request(`/ui/api/send-log?address=${owl.identity.address}`, {
      headers: { cookie },
    });
    expect(denied.status).toBe(403);
  });
});

describe('watch out: Sent copy must not pollute INBOX unseen', () => {
  test('/v1/send does not IMAP-append and smtp/send have no APPEND', () => {
    const sendSrc = readSrc(new URL('../src/routes/send.ts', import.meta.url), 'utf8');
    const smtpSrc = readSrc(new URL('../src/lib/smtp.ts', import.meta.url), 'utf8');
    expect(sendSrc).not.toMatch(/from ['\"]\.\.\/lib\/imap/);
    expect(sendSrc).not.toMatch(/\bAPPEND\b/i);
    expect(smtpSrc).not.toMatch(/\bAPPEND\b/i);
    expect(smtpSrc).not.toMatch(/imap/i);
  });
});
