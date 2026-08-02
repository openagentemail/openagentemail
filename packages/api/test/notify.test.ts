// Notification routes must keep their ACL and rate-limit logic server-side.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-notify-'));

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { createIdentity } = await import('../src/lib/identities.ts');
const { resetNotifyUserLimits } = await import('../src/lib/ratelimit.ts');
const { createNotifyRoutes } = await import('../src/routes/notify.ts');
const {
  commitNotificationState,
  createRuntimeReader,
  physicalAgentTopic,
  userRouteKey,
} = await import('../src/lib/notify.ts');
type NotifyService = import('../src/lib/notify.ts').NotifyService;

const published: unknown[] = [];
const readCalls: unknown[] = [];
const originalFetch = globalThis.fetch;

const service: NotifyService = {
  async publish(input) {
    published.push(input);
    return { target: input.target, title: input.title, level: input.level };
  },
  async messages(topic, identityAddress, since) {
    readCalls.push({ topic, identityAddress, since });
    return [{ id: 'event-1', time: 1, title: 'check', message: 'safe', priority: 3, tags: [] }];
  },
  async verify() {
    return { ok: true };
  },
};

const allowed = createIdentity({ localpart: 'allowed', canNotifyUser: true })!.identity;
const ordinary = createIdentity({ localpart: 'ordinary' })!.identity;

function appFor(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/notify', createNotifyRoutes({ service }));
  return app;
}

beforeEach(() => {
  published.length = 0;
  readCalls.length = 0;
  resetNotifyUserLimits();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('human-alert ACL', () => {
  test('identity without can_notify_user cannot call notify_user', async () => {
    const response = await appFor({ kind: 'identity', address: ordinary.address }).request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'user', title: 'wake', message: 'please look', level: 'urgent' }),
    });

    expect(response.status).toBe(403);
    expect(published).toEqual([]);
  });

  test('explicitly authorized identity uses the independent user alert channel', async () => {
    const response = await appFor({ kind: 'identity', address: allowed.address }).request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'user', title: 'wake', message: 'please look', level: 'urgent' }),
    });

    expect(response.status).toBe(200);
    expect(published).toEqual([{
      target: 'user', title: 'wake', message: 'please look', level: 'urgent',
    }]);
  });

  test('identity tokens cannot target another agent or mint a route for a guessed name', async () => {
    const sideways = await appFor({ kind: 'identity', address: allowed.address }).request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'agent:ordinary', title: 'wake', message: 'please look' }),
    });
    expect(sideways.status).toBe(403);

    const missing = await appFor({ kind: 'admin' }).request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'agent:not-real', title: 'wake', message: 'please look' }),
    });
    expect(missing.status).toBe(404);
    expect(published).toEqual([]);
  });
});

describe('notification history ACL', () => {
  test('an identity can read only its mapped agent topic', async () => {
    const own = await appFor({ kind: 'identity', address: allowed.address })
      .request('/v1/notify/messages?topic=self');
    expect(own.status).toBe(200);
    expect(readCalls).toEqual([{ topic: 'agent:allowed', identityAddress: allowed.address, since: undefined }]);

    const other = await appFor({ kind: 'identity', address: allowed.address })
      .request('/v1/notify/messages?topic=agent:ordinary');
    expect(other.status).toBe(403);
    const human = await appFor({ kind: 'identity', address: allowed.address })
      .request('/v1/notify/messages?topic=user-alerts');
    expect(human.status).toBe(403);
    expect(readCalls).toHaveLength(1);
  });
});

describe('private ntfy topic mapping', () => {
  test('low alerts use the separate low-priority user route', () => {
    expect(userRouteKey('urgent')).toBe('userAlerts');
    expect(userRouteKey('normal')).toBe('userAlerts');
    expect(userRouteKey('low')).toBe('userLow');
  });

  test('valid identity localparts always map to a legal, distinct ntfy topic', () => {
    const dotted = physicalAgentTopic('foo.bar', 'x7k2');
    const long = physicalAgentTopic('a'.repeat(63), 'x7k2');

    expect(dotted).toMatch(/^[-_A-Za-z0-9]{1,64}$/);
    expect(long).toMatch(/^[-_A-Za-z0-9]{1,64}$/);
    expect(dotted).not.toBe(physicalAgentTopic('foo-bar', 'x7k2'));
  });
});

describe('live ntfy reader provisioning', () => {
  test('does not commit JSON state when its startup config write fails', async () => {
    let saved = false;
    await expect(commitNotificationState(
      async () => { throw new Error('read-only volume'); },
      () => { saved = true; },
    )).rejects.toThrow('read-only volume');
    expect(saved).toBe(false);
  });

  test('removes a partially created reader when ACL setup fails', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      const status = calls.length === 2 ? 503 : 200;
      return new Response('', { status });
    }) as typeof fetch;

    await expect(createRuntimeReader({
      topic: 'agent-test-x7k2',
      reader: { username: 'reader-agent-test-x7k2', token: 'tk_abcdefghijklmnopqrstuvwxyz12345' },
    } as any)).rejects.toThrow('notify_unavailable');

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST http://ntfy/v1/users',
      'POST http://ntfy/v1/users/access',
      'DELETE http://ntfy/v1/users',
    ]);
  });
});
