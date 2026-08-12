import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { UiApiDependencies } from '../src/routes/ui.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-ui-nlog-'));
process.env.NTFY_ENABLED = 'false';

const { UiSessionStore } = await import('../src/lib/ui-session.ts');
const { createUiApiRoutes } = await import('../src/routes/ui.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const {
  appendNotificationLog,
  resetNotificationLogForTests,
  setNotificationLogNowForTests,
} = await import('../src/lib/notification-log.ts');
const { resetNotifyUserLimits } = await import('../src/lib/ratelimit.ts');

type AuthKind = { kind: 'admin' } | { kind: 'identity'; address: string };

function makeApp(auth: AuthKind, overrides: Partial<UiApiDependencies> = {}) {
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
    notifyMessages: mock(async () => []),
    notifyVerify: mock(async () => ({ ok: true as const })),
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
  return { app, deps, cookie: `oae_ui=${created.sid}` };
}

describe('UI 30-day notification log APIs', () => {
  test('identity is forced to its own agent channel and cannot read user-alerts', async () => {
    resetNotificationLogForTests();
    setNotificationLogNowForTests(() => Date.parse('2026-08-12T12:00:00.000Z'));
    await appendNotificationLog({
      source: 'task',
      logicalTarget: 'agent:fox',
      logicalChannel: 'agent:fox',
      level: 'normal',
      title: 'own',
      message: 'for fox',
      identityAddress: 'fox@test.example',
    });
    await appendNotificationLog({
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'urgent',
      title: 'human',
      message: 'secret',
    });
    const { app, cookie } = makeApp({ kind: 'identity', address: 'fox@test.example' });
    const own = await app.request('/ui/api/notifications?limit=20', { headers: { cookie } });
    expect(own.status).toBe(200);
    const body = await own.json() as { items: Array<{ title: string; logicalChannel: string }> };
    expect(body.items.map((row) => row.title)).toEqual(['own']);

    const peek = await app.request('/ui/api/notifications?channel=user-alerts&limit=20', {
      headers: { cookie },
    });
    expect(peek.status).toBe(403);
  });

  test('admin can list every logical channel and page with an opaque cursor', async () => {
    resetNotificationLogForTests();
    const base = Date.parse('2026-08-12T12:00:00.000Z');
    for (let i = 0; i < 3; i++) {
      setNotificationLogNowForTests(() => base + i * 1000);
      await appendNotificationLog({
        source: 'manual',
        logicalTarget: 'user',
        logicalChannel: 'user-alerts',
        level: 'normal',
        title: `row-${i}`,
        message: 'm',
      });
    }
    const { app, cookie } = makeApp({ kind: 'admin' });
    const first = await app.request('/ui/api/notifications?limit=20', { headers: { cookie } });
    expect(first.status).toBe(200);
    const page = await first.json() as { items: Array<{ title: string }>; nextCursor: string | null };
    expect(page.items.map((row) => row.title)).toEqual(['row-2', 'row-1', 'row-0']);

    const filtered = await app.request('/ui/api/notifications?channel=user-alerts&level=normal&limit=20', {
      headers: { cookie },
    });
    expect(filtered.status).toBe(200);
  });

  test('summary echoes the day/tz window and matches list totals for that window', async () => {
    resetNotificationLogForTests();
    setNotificationLogNowForTests(() => Date.parse('2026-08-12T08:00:00.000Z'));
    await appendNotificationLog({
      source: 'watcher',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'urgent',
      title: 'ring',
      message: 'otp',
      sensitive: true,
    });
    await appendNotificationLog({
      source: 'manual',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'normal',
      title: 'ok',
      message: 'hi',
    });
    const { app, cookie } = makeApp({ kind: 'admin' });
    const summaryRes = await app.request('/ui/api/notify/summary?date=today&tz=UTC', {
      headers: { cookie },
    });
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json() as {
      date: string;
      tz: string;
      from: string;
      to: string;
      total: number;
      ringCount: number;
    };
    expect(summary.date).toBe('2026-08-12');
    expect(summary.tz).toBe('UTC');
    expect(summary.total).toBe(2);
    expect(summary.ringCount).toBe(1);

    const list = await app.request(
      `/ui/api/notifications?from=${encodeURIComponent(summary.from)}&to=${encodeURIComponent(summary.to)}&limit=20`,
      { headers: { cookie } },
    );
    const listed = await list.json() as { items: unknown[] };
    expect(listed.items).toHaveLength(summary.total);
  });

  test('diagnostics never returns physical topic or secret and is honest when ntfy is off', async () => {
    const { app, cookie } = makeApp({ kind: 'admin' });
    const res = await app.request('/ui/api/notify/diagnostics', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(false);
    expect(body.canVerify).toBe(true);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain('topic');
    expect(dumped).not.toContain('secret');
    expect(dumped).not.toContain('password');
    expect(dumped).not.toContain('token');
  });

  test('verify mirrors Bearer permission: identity without canNotifyUser is 403', async () => {
    resetNotifyUserLimits();
    const { app, cookie } = makeApp({ kind: 'identity', address: 'fox@test.example' });
    const res = await app.request('/ui/api/notify/verify', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(res.status).toBe(403);
  });

  test('verify allows admin and reuses the injected service', async () => {
    resetNotifyUserLimits();
    const { app, cookie, deps } = makeApp({ kind: 'admin' });
    const res = await app.request('/ui/api/notify/verify', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deps.notifyVerify).toHaveBeenCalled();
  });

  test('verify allows an identity with canNotifyUser', async () => {
    resetNotifyUserLimits();
    createIdentity({ localpart: 'herald', canNotifyUser: true });
    const { app, cookie } = makeApp({ kind: 'identity', address: 'herald@test.example' });
    const res = await app.request('/ui/api/notify/verify', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(res.status).toBe(200);
  });

  test('sensitive content is still returned for authorized readers (UI masks it)', async () => {
    resetNotificationLogForTests();
    setNotificationLogNowForTests(() => Date.parse('2026-08-12T12:00:00.000Z'));
    await appendNotificationLog({
      source: 'watcher',
      logicalTarget: 'user',
      logicalChannel: 'user-alerts',
      level: 'urgent',
      title: 'mail',
      message: 'code 482731',
      sensitive: true,
    });
    const { app, cookie } = makeApp({ kind: 'admin' });
    const res = await app.request('/ui/api/notifications?limit=20', { headers: { cookie } });
    const body = await res.json() as { items: Array<{ sensitive: boolean; message: string }> };
    expect(body.items[0]?.sensitive).toBe(true);
    expect(body.items[0]?.message).toBe('code 482731');
  });
});
