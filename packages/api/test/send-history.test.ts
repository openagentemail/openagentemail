import { existsSync, readFileSync, statSync } from 'node:fs';
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
const { resetSendLogForTests, sendLogAlertsForTests, sendLogPathForTests } =
  await import('../src/lib/send-log.ts');
const { macForMcpSendSource, SEND_SOURCE_MAC_HEADER } = await import('../src/lib/send-source.ts');
const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { config } = await import('../src/lib/config.ts');
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

  test('forged X-OAE-Send-Source still records api', async () => {
    const app = bearerApp({ kind: 'admin' });
    await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-oae-send-source': 'mcp' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'forged public header',
        text: 'x',
      }),
    });
    const listed = await app.request(`/v1/send/history?address=${fox.identity.address}`);
    expect((await listed.json()).items[0]?.source).toBe('api');
  });

  test('valid send-source MAC records mcp; bad or missing MAC records api', async () => {
    const app = bearerApp({ kind: 'admin' });
    const good = await app.request('/v1/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SEND_SOURCE_MAC_HEADER]: macForMcpSendSource(config.taskSigningSecret),
      },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'signed mcp',
        text: 'x',
      }),
    });
    expect(good.status).toBe(200);
    expect((await app.request(`/v1/send/history?address=${fox.identity.address}`).then((r) => r.json()))
      .items[0]?.source).toBe('mcp');

    await app.request('/v1/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SEND_SOURCE_MAC_HEADER]: 'not-a-valid-mac',
      },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'bad mac',
        text: 'x',
      }),
    });
    expect((await app.request(`/v1/send/history?address=${fox.identity.address}`).then((r) => r.json()))
      .items[0]?.source).toBe('api');
  });

  test('OpenAgentEmailClient.send injects MAC and records mcp', async () => {
    const app = bearerApp({ kind: 'admin' });
    const client = new OpenAgentEmailClient(
      'http://localhost',
      'admin-key',
      (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url, 'http://localhost').pathname;
        return app.request(path, init);
      },
      { sendSourceSecret: config.taskSigningSecret },
    );
    const sent = await client.send(fox.identity.address, 'out@example.net', 'from client', 'x');
    expect(sent.id).toMatch(/^snd_/);
    const listed = await app.request(`/v1/send/history?address=${fox.identity.address}`);
    expect((await listed.json()).items[0]?.source).toBe('mcp');
  });

  test('N rate-limited requests log only one rate_limited row', async () => {
    const prev = config.sendRateLimit;
    Object.assign(config, { sendRateLimit: 1 });
    try {
      const app = bearerApp({ kind: 'admin' });
      const body = JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'rl',
        text: 'x',
      });
      const first = await app.request('/v1/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(first.status).toBe(200);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const res = await app.request('/v1/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        statuses.push(res.status);
      }
      expect(statuses.every((s) => s === 429)).toBe(true);
      const listed = await app.request(`/v1/send/history?address=${fox.identity.address}`);
      const rows = (await listed.json()).items as { error?: string; result: string }[];
      expect(rows.filter((row) => row.error === 'rate_limited')).toHaveLength(1);
    } finally {
      Object.assign(config, { sendRateLimit: prev });
    }
  });

  test('oversized to address is rejected and does not land a giant row', async () => {
    const app = bearerApp({ kind: 'admin' });
    const huge = `${'z'.repeat(300)}@example.net`;
    const res = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: huge,
        subject: 'too long',
        text: 'x',
      }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(sendLogPathForTests()) ? readFileSync(sendLogPathForTests(), 'utf8') : '').not.toContain(
      'z'.repeat(300),
    );
  });

  test('persist failure after send raises HIGH alert and still returns 200', async () => {
    const { setSendLogPersistHookForTests } = await import('../src/lib/send-log.ts');
    setSendLogPersistHookForTests(() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    const app = bearerApp({ kind: 'admin' });
    const sent = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fox.identity.address,
        to: 'out@example.net',
        subject: 'persist-fail',
        text: 'x',
      }),
    });
    expect(sent.status).toBe(200);
    expect((await sent.json()).id).toBeUndefined();
    expect(sendLogAlertsForTests()).toContain('append_failed_after_send');
    expect(sendLogAlertsForTests()).toContain('persist_failed');
    setSendLogPersistHookForTests(null);
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
