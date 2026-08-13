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
process.env.NOTIFY_PUBLIC_URL = 'https://notify.test';
process.env.NTFY_ENABLED = 'true';
process.env.NTFY_ADMIN_PASSWORD = 'ntfy-admin-secret';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { config } = await import('../src/lib/config.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { resetNotifyUserLimits } = await import('../src/lib/ratelimit.ts');
const { createNotifyRoutes } = await import('../src/routes/notify.ts');
const {
  boundJsonEscapedText,
  classifyNtfyUserDeleteResponse,
  commitNotificationState,
  createNotificationDevice,
  createRuntimeReader,
  jsonEscapedByteLength,
  listNotificationDevices,
  notifyAvailableMessageBytes,
  NotifyError,
  NTFY_REQUEST_MAX_BYTES,
  NtfyNotificationService,
  physicalAgentTopic,
  revokeNotificationDevice,
  userRouteKey,
} = await import('../src/lib/notify.ts');
const {
  deviceRegistryPathForTests,
  registerPairedDevice,
  resetDeviceRegistryForTests,
  setDeviceRegistryPersistHookForTests,
} = await import('../src/lib/notification-devices.ts');
const {
  queryNotificationLog,
  resetNotificationLogForTests,
  setNotificationLogPersistHookForTests,
} = await import('../src/lib/notification-log.ts');
const { existsSync, readFileSync } = await import('node:fs');
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

function appFor(
  auth: { kind: 'admin' } | { kind: 'identity'; address: string },
  createDevice?: (options?: { displayName?: string }) => Promise<{
    username: string;
    password: string;
    serverUrl: string;
    topics: { userAlerts: string; userLow: string };
  }>,
) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/notify', createNotifyRoutes({ service, createDevice, publicUrl: 'https://notify.test' }));
  return app;
}

beforeEach(() => {
  published.length = 0;
  readCalls.length = 0;
  resetNotifyUserLimits();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetDeviceRegistryForTests();
  resetNotificationLogForTests();
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
      target: 'user',
      title: 'wake',
      message: 'please look',
      level: 'urgent',
      source: 'manual',
      logicalChannel: 'user-alerts',
      sensitive: false,
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

describe('phone device ACL', () => {
  const device = {
    username: 'phone-x7k2',
    password: 'one-time-phone-password',
    serverUrl: 'https://notify.test',
    topics: { userAlerts: 'user-alerts-x7k2', userLow: 'user-low-x7k2' },
  };

  test('only an admin can create the human phone reader', async () => {
    let calls = 0;
    const response = await appFor(
      { kind: 'identity', address: allowed.address },
      async () => { calls += 1; return device; },
    ).request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.test' }),
    });
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  test('requires the active HTTPS public URL before emitting credentials', async () => {
    let calls = 0;
    const response = await appFor(
      { kind: 'admin' },
      async () => { calls += 1; return device; },
    ).request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://old-localhost.test' }),
    });
    expect(response.status).toBe(409);
    expect(calls).toBe(0);
  });

  test('returns the two read-only human topics to an admin once', async () => {
    let calls = 0;
    const response = await appFor(
      { kind: 'admin' },
      async () => { calls += 1; return device; },
    ).request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.test' }),
    });
    expect(response.status).toBe(201);
    expect(calls).toBe(1);
    expect(await response.json()).toEqual(device);
  });

  test('device pairing accepts path trailing slash + query via shared normalizeUrl', async () => {
    // config/active: pathname trailing slash stripped; query kept.
    // Old compare only did href.replace(/\/$/, '') and would 409 on /base/?x=1.
    let calls = 0;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'admin' });
      await next();
    });
    app.route(
      '/v1/notify',
      createNotifyRoutes({
        service,
        createDevice: async () => {
          calls += 1;
          return device;
        },
        publicUrl: 'https://notify.example/base/',
      }),
    );
    const response = await app.request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.example/base/?x=1' }),
    });
    // Path /base/ normalizes to /base on both sides; query must match too.
    // Active without query vs request with query is a real mismatch:
    expect(response.status).toBe(409);
    expect(calls).toBe(0);

    const match = await app.request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.example/base/' }),
    });
    expect(match.status).toBe(201);
    expect(calls).toBe(1);

    const withQueryApp = new Hono();
    withQueryApp.use('*', async (c, next) => {
      c.set('auth', { kind: 'admin' });
      await next();
    });
    let qCalls = 0;
    withQueryApp.route(
      '/v1/notify',
      createNotifyRoutes({
        service,
        createDevice: async () => {
          qCalls += 1;
          return device;
        },
        publicUrl: 'https://notify.example/base?x=1',
      }),
    );
    const qMatch = await withQueryApp.request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.example/base/?x=1' }),
    });
    expect(qMatch.status).toBe(201);
    expect(qCalls).toBe(1);
  });

  test('old POST without displayName still 201 and identity cannot list or revoke', async () => {
    const created = await appFor({ kind: 'admin' }, async () => device).request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.test' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { username: string; password: string };
    expect(body.username).toBe(device.username);
    expect(body.password).toBe(device.password);

    const listed = await appFor({ kind: 'identity', address: allowed.address }).request(
      '/v1/notify/devices',
    );
    expect(listed.status).toBe(403);
    const revoked = await appFor({ kind: 'identity', address: allowed.address }).request(
      '/v1/notify/devices/dev_nope',
      { method: 'DELETE' },
    );
    expect(revoked.status).toBe(403);
  });

  test('displayName is accepted on create without breaking the publicUrl gate', async () => {
    let seen: { displayName?: string } | undefined;
    const response = await appFor({ kind: 'admin' }, async (options) => {
      seen = options;
      return { ...device, id: 'dev_test', displayName: options?.displayName ?? 'Phone' };
    }).request('/v1/notify/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicUrl: 'https://notify.test', displayName: 'Kitchen' }),
    });
    expect(response.status).toBe(201);
    expect(seen).toEqual({ displayName: 'Kitchen' });
  });

  test('removes a phone account if granting the second human topic fails', async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-reader-test', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response('', { status: calls.length === 3 ? 503 : 200 });
    }) as typeof fetch;

    try {
      await expect(createNotificationDevice()).rejects.toThrow('notify_unavailable');

      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'POST http://ntfy/v1/users',
        'POST http://ntfy/v1/users/access',
        'POST http://ntfy/v1/users/access',
        'DELETE http://ntfy/v1/users',
      ]);
      expect(calls.slice(1, 3).map((call) => call.body)).toEqual([
        expect.objectContaining({ topic: expect.stringMatching(/^user-alerts-/), permission: 'read-only' }),
        expect.objectContaining({ topic: expect.stringMatching(/^user-low-/), permission: 'read-only' }),
      ]);
      expect(calls[3]?.body).toEqual({ username: expect.stringMatching(/^phone-/) });
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('registry persist failure after ntfy create deletes the ghost user and returns 502', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-registry-fail', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    setDeviceRegistryPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    try {
      await expect(createNotificationDevice({ displayName: 'Ghost' })).rejects.toMatchObject({
        code: 'device_registry_unavailable',
      });
      expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/v1/users'))).toBe(
        true,
      );
      const disk = deviceRegistryPathForTests();
      const { existsSync } = await import('node:fs');
      if (existsSync(disk)) {
        expect(readFileSync(disk, 'utf8')).not.toMatch(/"password"\s*:/);
      }
    } finally {
      setDeviceRegistryPersistHookForTests(null);
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('successful create never writes password to DATA_DIR', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-ok', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    let password = '';
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'POST' && String(_input).endsWith('/v1/users') && init.body) {
        const body = JSON.parse(String(init.body)) as { password?: string };
        if (body.password) password = body.password;
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const created = await createNotificationDevice({ displayName: 'Desk' });
      expect(created.displayName).toBe('Desk');
      expect(created.password.length).toBeGreaterThan(8);
      expect(created.qrPayload.password).toBe(created.password);
      expect(created.qr?.size).toBeGreaterThanOrEqual(21);
      expect(created.qr?.modules).toMatch(/^[01]+$/);
      expect(created.qr?.modules.length).toBe((created.qr?.size ?? 0) ** 2);
      password = created.password;
      const dataDir = process.env.DATA_DIR!;
      const { readdirSync } = await import('node:fs');
      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const next = join(dir, name.name);
          if (name.isDirectory()) out.push(...walk(next));
          else out.push(readFileSync(next, 'utf8'));
        }
        return out;
      };
      const blobs = walk(dataDir).join('\n');
      expect(blobs).not.toContain(password);
      expect(blobs).not.toMatch(/"password"\s*:/);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });
});

describe('ntfy publish payload budget', () => {
  function withPublishCapture(run: (svc: NtfyNotificationService, captured: string[]) => Promise<void>) {
    return async () => {
      const captured: string[] = [];
      const previousNtfy = { ...config.ntfy };
      Object.assign(config.ntfy as {
        enabled: boolean;
        adminPassword?: string;
        publicUrl: string;
      }, {
        enabled: true,
        adminPassword: 'ntfy-admin-secret',
        publicUrl: 'https://notify.test',
      });
      globalThis.fetch = (async (_input, init) => {
        captured.push(String(init?.body ?? ''));
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      try {
        await run(new NtfyNotificationService(), captured);
      } finally {
        Object.assign(config.ntfy, previousNtfy);
      }
    };
  }

  test('drops click when serialized JSON would exceed 4000 bytes', withPublishCapture(async (svc, captured) => {
    const longClick = `https://dash.example/ui/${'x'.repeat(800)}`;
    await svc.publish({
      target: 'user',
      title: 'openagent.email new mail',
      message: 'm'.repeat(3_500),
      level: 'normal',
      tags: ['email'],
      click: longClick,
      // Fits after click-drop; overflow mode must not matter.
      overflow: 'error',
    });
    expect(captured).toHaveLength(1);
    expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(parsed.click).toBeUndefined();
    // Message fits base payload after click drop — no ellipsis truncation.
    expect(parsed.message).toBe('m'.repeat(3_500));
    expect(String(parsed.message)).not.toMatch(/…$/);
  }));

  test('drops click to keep full long message between dual budgets (F93)', withPublishCapture(async (svc, captured) => {
    // Body sized between with-click and no-click residuals → click dropped, message full.
    const clickUrl = `https://dash.example/ui/${'c'.repeat(400)}`;
    const withClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
      click: clickUrl,
    });
    const noClickBudget = notifyAvailableMessageBytes({
      title: 'openagent.email new mail',
      level: 'urgent',
      tags: ['email'],
    });
    expect(withClickBudget).toBeLessThan(noClickBudget);
    // Mid-band message: too big for with-click framing, fine after click-drop.
    const mid = Math.floor((withClickBudget + noClickBudget) / 2);
    const message = `https://example.com/verify?token=${'a'.repeat(Math.max(0, mid - 40))}`;
    expect(jsonEscapedByteLength(message)).toBeGreaterThan(withClickBudget);
    expect(jsonEscapedByteLength(message)).toBeLessThanOrEqual(noClickBudget);

    await svc.publish({
      target: 'user',
      title: 'openagent.email new mail',
      message,
      level: 'urgent',
      tags: ['email'],
      click: clickUrl,
      overflow: 'error',
    });
    expect(captured).toHaveLength(1);
    expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(parsed.click).toBeUndefined();
    expect(parsed.message).toBe(message);
  }));

  test('keeps click and full message when the serialized body fits', withPublishCapture(async (svc, captured) => {
    await svc.publish({
      target: 'user',
      title: 'short',
      message: 'hello',
      level: 'normal',
      click: 'https://dash.example/ui',
    });
    expect(captured).toHaveLength(1);
    expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    expect(JSON.parse(captured[0]!)).toMatchObject({
      message: 'hello',
      click: 'https://dash.example/ui',
    });
  }));

  test('truncates JSON-expanded poison message so publish stays under budget', withPublishCapture(async (svc, captured) => {
    // Control chars expand 1 → 6 bytes under JSON.stringify (\\u0001).
    // 3500 of them blow past ntfy even after click is dropped.
    const poison = '\u0001'.repeat(3_500);
    await svc.publish({
      target: 'user',
      title: 'openagent.email new mail',
      message: poison,
      level: 'urgent',
      tags: ['email'],
      click: 'https://dash.example/ui',
      overflow: 'truncate', // watcher path (F76)
    });
    expect(captured).toHaveLength(1);
    const raw = captured[0]!;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.click).toBeUndefined();
    expect(typeof parsed.message).toBe('string');
    const message = parsed.message as string;
    expect(message.endsWith('…')).toBe(true);
    // Escaped length of message content alone must fit the residual budget.
    const overhead = Buffer.byteLength(
      JSON.stringify({ ...parsed, message: '' }),
      'utf8',
    );
    const escapedMessageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8') - 2; // strip surrounding quotes
    expect(escapedMessageBytes).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES - overhead);
    expect(escapedMessageBytes).toBe(
      Buffer.byteLength(JSON.stringify(boundJsonEscapedText(poison, NTFY_REQUEST_MAX_BYTES - overhead)), 'utf8') - 2,
    );
  }));

  test('boundJsonEscapedText accounts for control-char expansion', () => {
    expect(boundJsonEscapedText('hi', 100)).toBe('hi');
    // Each \\u0001 costs 6 escaped bytes; budget 10 → one control (6) + ellipsis (3).
    const truncated = boundJsonEscapedText('\u0001'.repeat(10), 10);
    expect(truncated).toBe('\u0001…');
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8') - 2).toBeLessThanOrEqual(10);
    // Budget smaller than ellipsis → empty (same discipline as boundTextBytes).
    expect(boundJsonEscapedText('abcdef', 2)).toBe('');
    // Quote/backslash double under JSON escape.
    expect(boundJsonEscapedText('""', 3)).toBe('…'); // each " costs 2; cannot keep either + ellipsis
  });

  test('boundJsonEscapedText costs lone surrogates as JSON \\uXXXX (6 bytes)', () => {
    // JSON.stringify emits \\ud800 (6); Buffer.byteLength would undercount as 3.
    const truncated = boundJsonEscapedText('\ud800'.repeat(10), 10);
    expect(truncated).toBe('\ud800…');
    expect(Buffer.byteLength(JSON.stringify(truncated), 'utf8') - 2).toBeLessThanOrEqual(10);
  });

  test('truncates lone-surrogate poison message under request budget', withPublishCapture(async (svc, captured) => {
    const poison = '\ud800'.repeat(3_500);
    await svc.publish({
      target: 'user',
      title: 'openagent.email new mail',
      message: poison,
      level: 'urgent',
      tags: ['email'],
      click: 'https://dash.example/ui',
      overflow: 'truncate',
    });
    expect(captured).toHaveLength(1);
    const raw = captured[0]!;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.click).toBeUndefined();
    expect(typeof parsed.message).toBe('string');
    expect((parsed.message as string).endsWith('…')).toBe(true);
  }));

  test('default overflow errors on oversize ASCII; truncate mode still sends (F76)', withPublishCapture(async (svc, captured) => {
    const huge = 'a'.repeat(4_000);
    await expect(
      svc.publish({
        target: 'user',
        title: 'openagent.email new mail',
        message: huge,
        level: 'normal',
        tags: ['email'],
      }),
    ).rejects.toMatchObject({
      code: 'message_too_large',
      details: {
        maxRequestBytes: NTFY_REQUEST_MAX_BYTES,
        availableMessageBytes: expect.any(Number),
      },
    } satisfies Partial<NotifyError>);
    expect(captured).toHaveLength(0);

    await svc.publish({
      target: 'user',
      title: 'openagent.email new mail',
      message: huge,
      level: 'normal',
      tags: ['email'],
      overflow: 'truncate',
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as { message: string };
    expect(parsed.message.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
  }));

  test('default overflow errors on oversize CJK; truncate stays code-point safe (F76)', withPublishCapture(async (svc, captured) => {
    const hugeCjk = '字'.repeat(4_000);
    await expect(
      svc.publish({
        target: 'user',
        title: 't',
        message: hugeCjk,
        level: 'normal',
      }),
    ).rejects.toMatchObject({ code: 'message_too_large' } satisfies Partial<NotifyError>);
    expect(captured).toHaveLength(0);

    await svc.publish({
      target: 'user',
      title: 't',
      message: hugeCjk,
      level: 'normal',
      overflow: 'truncate',
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as { message: string };
    expect(parsed.message.endsWith('…')).toBe(true);
    // No lone high/low surrogate split — JSON round-trip stays valid.
    expect(() => JSON.parse(captured[0]!)).not.toThrow();
    expect(Buffer.byteLength(captured[0]!, 'utf8')).toBeLessThanOrEqual(NTFY_REQUEST_MAX_BYTES);
  }));

  test('beforeSend false aborts before fetch; true allows send (F47)', withPublishCapture(async (svc, captured) => {
    await expect(
      svc.publish({
        target: 'user',
        title: 't',
        message: 'm',
        level: 'normal',
        beforeSend: () => false,
      }),
    ).rejects.toMatchObject({ code: 'notify_cancelled' } satisfies Partial<NotifyError>);
    expect(captured).toHaveLength(0);

    await svc.publish({
      target: 'user',
      title: 't',
      message: 'm',
      level: 'normal',
      beforeSend: () => true,
    });
    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0]!)).toMatchObject({ message: 'm' });
  }));
});

describe('manual notify overflow via /v1/notify (F76)', () => {
  test('oversize message returns 413 with budget fields; in-budget delivers full body', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    const captured: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      captured.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { kind: 'admin' });
      await next();
    });
    app.route('/v1/notify', createNotifyRoutes({
      service: new NtfyNotificationService(),
      publicUrl: 'https://notify.test',
    }));
    try {
      const over = await app.request('/v1/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'user',
          title: 'wake',
          message: 'a'.repeat(4_000),
          level: 'normal',
        }),
      });
      expect(over.status).toBe(413);
      const errBody = await over.json() as {
        error: string;
        maxRequestBytes: number;
        availableMessageBytes: number;
      };
      expect(errBody.error).toBe('message_too_large');
      expect(errBody.maxRequestBytes).toBe(NTFY_REQUEST_MAX_BYTES);
      expect(errBody.availableMessageBytes).toBeGreaterThan(0);
      expect(errBody.availableMessageBytes).toBeLessThan(NTFY_REQUEST_MAX_BYTES);
      expect(captured).toHaveLength(0);

      const ok = await app.request('/v1/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'user',
          title: 'wake',
          message: 'fits fine',
          level: 'normal',
        }),
      });
      expect(ok.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(JSON.parse(captured[0]!)).toMatchObject({ message: 'fits fine' });
      expect(String(JSON.parse(captured[0]!).message)).not.toMatch(/…$/);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
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

describe('publish success path writes the 30-day notification log', () => {
  function logText(): string {
    const path = join(process.env.DATA_DIR!, 'notification-log.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  beforeEach(() => {
    resetNotificationLogForTests();
  });

  async function withLivePublish<T>(
    fetchImpl: typeof fetch,
    run: (svc: NtfyNotificationService) => Promise<T>,
  ): Promise<T> {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      return await run(new NtfyNotificationService());
    } finally {
      globalThis.fetch = previousFetch;
      Object.assign(config.ntfy, previousNtfy);
      resetNotificationLogForTests();
    }
  }

  test('a successful ntfy response writes exactly one log row after send, not before', async () => {
    const order: string[] = [];
    await withLivePublish(async (_input, init) => {
      order.push('ntfy');
      expect(String(init?.body ?? '')).not.toContain('"source"');
      expect(String(init?.body ?? '')).not.toContain('"sensitive"');
      expect(String(init?.body ?? '')).not.toContain('logicalChannel');
      return new Response('{}', { status: 200 });
    }, async (svc) => {
      await svc.publish({
        target: 'user',
        title: 'hello',
        message: 'world',
        level: 'urgent',
        source: 'watcher',
        sensitive: true,
        identityAddress: 'fox@test.example',
      });
      order.push('returned');
      const page = await queryNotificationLog({ limit: 20 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.source).toBe('watcher');
      expect(page.items[0]?.sensitive).toBe(true);
    });
    expect(order).toEqual(['ntfy', 'returned']);
  });

  test('failed ntfy response and cancelled beforeSend do not write a log row', async () => {
    await withLivePublish(async () => new Response('nope', { status: 503 }), async (svc) => {
      await expect(svc.publish({
        target: 'user',
        title: 'hello',
        message: 'world',
        level: 'normal',
        source: 'manual',
      })).rejects.toThrow('notify_unavailable');
    });
    expect(logText()).toBe('');

    await withLivePublish(async () => new Response('{}', { status: 200 }), async (svc) => {
      await expect(svc.publish({
        target: 'user',
        title: 'hello',
        message: 'world',
        level: 'normal',
        source: 'watcher',
        beforeSend: () => false,
      })).rejects.toThrow('notify_cancelled');
    });
    expect(logText()).toBe('');
  });

  test('verify() self-call records source=verify on the same success path', async () => {
    let posted = '';
    await withLivePublish(async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST' && !url.includes('/json')) {
        posted = String(init?.body ?? '');
        return new Response('{}', { status: 200 });
      }
      const payload = JSON.parse(posted) as { message: string; title: string };
      return new Response(
        `${JSON.stringify({
          event: 'message',
          id: 'evt-verify',
          time: 1,
          title: payload.title,
          message: payload.message,
          priority: 3,
        })}\n`,
        { status: 200 },
      );
    }, async (svc) => {
      await svc.verify();
      const page = await queryNotificationLog({ limit: 20 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.source).toBe('verify');
      expect(page.items[0]?.logicalChannel).toBe('user-alerts');
    });
  });

  test('append failure after ntfy success still returns ok and does not throw', async () => {
    setNotificationLogPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    await withLivePublish(async () => new Response('{}', { status: 200 }), async (svc) => {
      await expect(svc.publish({
        target: 'user',
        title: 'hello',
        message: 'world',
        level: 'normal',
        source: 'task',
      })).resolves.toMatchObject({ title: 'hello' });
    });
  });
});

describe('ntfy user delete classification (revoke reconcile)', () => {
  test('live ntfy missing user is HTTP 400 / code 40031, not 404', () => {
    expect(
      classifyNtfyUserDeleteResponse(
        400,
        JSON.stringify({ code: 40031, http: 400, error: 'invalid request: user does not exist' }),
      ),
    ).toBe('not_found');
    expect(classifyNtfyUserDeleteResponse(404, '{"code":40401,"error":"page not found"}')).toBe(
      'not_found',
    );
    expect(classifyNtfyUserDeleteResponse(200, '{}')).toBe('deleted');
    expect(classifyNtfyUserDeleteResponse(503, 'unavailable')).toBe('transient');
    expect(
      classifyNtfyUserDeleteResponse(
        400,
        JSON.stringify({ code: 40024, http: 400, error: 'invalid request: request body must be valid JSON' }),
      ),
    ).toBe('transient');
  });
});

describe('device list and revoke (Bearer)', () => {
  test('identity cannot GET or DELETE devices; admin revoke is 204 including repeats and ntfy 40031', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    const deletes: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (init?.method === 'DELETE') {
        deletes.push(String(input));
        return new Response(
          JSON.stringify({ code: 40031, http: 400, error: 'invalid request: user does not exist' }),
          { status: 400 },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Curl-phone',
        ntfyUsername: 'phone-curltest',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      const identGet = await appFor({ kind: 'identity', address: allowed.address }).request(
        '/v1/notify/devices',
      );
      expect(identGet.status).toBe(403);
      const identDel = await appFor({ kind: 'identity', address: allowed.address }).request(
        `/v1/notify/devices/${record.id}`,
        { method: 'DELETE' },
      );
      expect(identDel.status).toBe(403);

      const listed = await appFor({ kind: 'admin' }).request('/v1/notify/devices');
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as {
        devices: { displayName: string; pairedAt: string; topicLabels?: { userAlerts: string } }[];
      };
      expect(page.devices[0]?.displayName).toBe('Curl-phone');
      expect(page.devices[0]?.pairedAt).toBeTruthy();
      expect(page.devices[0]?.topicLabels?.userAlerts).toBe('User alerts');
      expect(JSON.stringify(page)).not.toMatch(/"password"\s*:/);
      expect(JSON.stringify(page)).not.toMatch(/"qr"\s*:/);

      const revoked = await appFor({ kind: 'admin' }).request(`/v1/notify/devices/${record.id}`, {
        method: 'DELETE',
      });
      expect(revoked.status).toBe(204);
      expect(deletes.some((url) => url.includes('/v1/users'))).toBe(true);

      const again = await appFor({ kind: 'admin' }).request(`/v1/notify/devices/${record.id}`, {
        method: 'DELETE',
      });
      expect(again.status).toBe(204);
      expect(deletes).toHaveLength(1);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });
});
