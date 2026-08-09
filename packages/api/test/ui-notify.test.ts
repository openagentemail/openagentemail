import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { UiApiDependencies } from '../src/routes/ui.ts';
import type { NotifyMessage, NotifyTopic } from '../src/lib/notify.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');

const sample: NotifyMessage = {
  id: 'evt-1',
  time: 1_700_000_000,
  title: 'wake',
  message: 'please look',
  priority: 5,
  tags: ['warning'],
};

type AuthKind = { kind: 'admin' } | { kind: 'identity'; address: string };

function makeApp(
  auth: AuthKind,
  overrides: Partial<UiApiDependencies> = {},
) {
  const readCalls: Array<{ topic: NotifyTopic; identityAddress?: string; since?: string }> = [];
  const deps: UiApiDependencies = {
    listIdentities: () => [],
    listMessages: mock(async () => []),
    setMessageSeen: mock(async () => true),
    getMailboxScan: mock(async () => ({
      kind: 'ready' as const,
      now: Date.now(),
      snapshot: null,
      cached: false,
      revalidating: false,
      refreshError: false,
    })),
    getMessage: mock(async () => null),
    setPushContentTier: mock(() => null),
    notifyMessages: mock(async (topic, identityAddress, since) => {
      readCalls.push({ topic, identityAddress, since });
      return [sample];
    }),
    ...overrides,
  };
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
  if (!created.ok) throw new Error('test session was not created');
  const app = new Hono();
  app.route('/ui/api', createUiApiRoutes(store, deps));
  return { app, deps, cookie: `oae_ui=${created.sid}`, readCalls };
}

describe('UI notify history ACL', () => {
  test('identity can read self (mapped to own agent topic) and cannot read user or peer topics', async () => {
    const { app, cookie, readCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });

    const own = await app.request('/ui/api/notify/messages?topic=self&since=12h', {
      headers: { cookie },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ messages: [sample] });
    expect(readCalls).toEqual([
      { topic: 'agent:fox', identityAddress: 'fox@test.example', since: '12h' },
    ]);

    const peer = await app.request('/ui/api/notify/messages?topic=agent:other', {
      headers: { cookie },
    });
    expect(peer.status).toBe(403);

    const human = await app.request('/ui/api/notify/messages?topic=user-alerts', {
      headers: { cookie },
    });
    expect(human.status).toBe(403);
    expect(readCalls).toHaveLength(1);
  });

  test('admin can read user and agent topics but must not use self', async () => {
    const { app, cookie, readCalls } = makeApp({ kind: 'admin' });

    const self = await app.request('/ui/api/notify/messages?topic=self', {
      headers: { cookie },
    });
    expect(self.status).toBe(400);
    expect(readCalls).toEqual([]);

    const alerts = await app.request('/ui/api/notify/messages?topic=user-alerts&since=12h', {
      headers: { cookie },
    });
    expect(alerts.status).toBe(200);
    expect(await alerts.json()).toEqual({ messages: [sample] });

    const agent = await app.request('/ui/api/notify/messages?topic=agent:fox', {
      headers: { cookie },
    });
    expect(agent.status).toBe(200);
    expect(readCalls).toEqual([
      { topic: 'user-alerts', identityAddress: undefined, since: '12h' },
      { topic: 'agent:fox', identityAddress: undefined, since: undefined },
    ]);
  });

  test('disabled notifications surface as 503 without leaking stack details', async () => {
    const { NotifyError } = await import('../src/lib/notify.ts');
    const { app, cookie } = makeApp(
      { kind: 'admin' },
      {
        notifyMessages: mock(async () => {
          throw new NotifyError('notifications_disabled');
        }),
      },
    );
    const response = await app.request('/ui/api/notify/messages?topic=user-low', {
      headers: { cookie },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'notifications_disabled' });
  });

  test('unauthenticated sessions cannot read notify history', async () => {
    const { app } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/notify/messages?topic=user-alerts');
    expect(response.status).toBe(401);
  });

  test('identity may name its own agent topic explicitly', async () => {
    const { app, cookie, readCalls } = makeApp({
      kind: 'identity',
      address: 'fox@test.example',
    });
    const response = await app.request('/ui/api/notify/messages?topic=agent:fox', {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(readCalls).toEqual([
      { topic: 'agent:fox', identityAddress: 'fox@test.example', since: undefined },
    ]);
  });

  test('invalid agent topic grammar is rejected', async () => {
    const { app, cookie, readCalls } = makeApp({ kind: 'admin' });
    const response = await app.request('/ui/api/notify/messages?topic=agent:Bad', {
      headers: { cookie },
    });
    expect(response.status).toBe(400);
    expect(readCalls).toEqual([]);
  });

  test('unknown_agent surfaces as 404 so the UI can treat it as an empty channel', async () => {
    const { NotifyError } = await import('../src/lib/notify.ts');
    const { app, cookie } = makeApp(
      { kind: 'admin' },
      {
        notifyMessages: mock(async () => {
          throw new NotifyError('unknown_agent');
        }),
      },
    );
    const response = await app.request('/ui/api/notify/messages?topic=agent:ghost', {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'unknown_agent' });
  });
});
