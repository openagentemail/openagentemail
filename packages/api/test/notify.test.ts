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
  initializeNotifications,
  isNotifyServiceFailure,
  jsonEscapedByteLength,
  listNotificationDevices,
  notifyAvailableMessageBytes,
  NotifyError,
  NTFY_ADMIN_FETCH_TIMEOUT_MS,
  NTFY_REQUEST_MAX_BYTES,
  NtfyNotificationService,
  physicalAgentTopic,
  revokeNotificationDevice,
  setNotifyPasswordHashForTests,
  userRouteKey,
} = await import('../src/lib/notify.ts');
const {
  DeviceRegistryCorruptError,
  DeviceRegistryPersistError,
  deviceRegistryPathForTests,
  inspectDeviceRegistryAtBoot,
  listPairedDevices,
  registerPairedDevice,
  resetDeviceRegistryForTests,
  revokePairedDevice,
  setDeviceRegistryDirFsyncHookForTests,
  setDeviceRegistryPersistHookForTests,
} = await import('../src/lib/notification-devices.ts');
const {
  queryNotificationLog,
  resetNotificationLogForTests,
  setNotificationLogPersistHookForTests,
} = await import('../src/lib/notification-log.ts');
const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
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

  test('corrupt registry with ntfy enabled does not block startup and fail-closes devices', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-corrupt-boot', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    writeFileSync(
      deviceRegistryPathForTests(),
      '{"password":"leaked-secret-value","not":json',
      { mode: 0o600 },
    );
    const alerts: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      alerts.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    // CI 根因：initializeNotifications → writeServerConfig 做 bcrypt cost=10
    //（admin+publisher+每个 reader）。本机 ~1.1s，CI 套件 105s vs 本机 15s，
    // 哈希把单测拖过 bun 默认 5s。不是 ntfyFetch 8s（本路径不 fetch）。
    setNotifyPasswordHashForTests(async () => '$2b$10$testhashforcorruptboot.............');
    const fetchDuringBoot = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('corrupt-boot test must not wait on ntfy');
    }) as typeof fetch;
    try {
      await expect(inspectDeviceRegistryAtBoot()).resolves.toBeUndefined();
      await expect(initializeNotifications()).resolves.toBeUndefined();
      const { createApp } = await import('../src/app.ts');
      const app = createApp({ uiEnabled: false });
      const health = await app.request('/healthz');
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const adminKey = [...config.apiKeys][0]!;
      const devices = await app.request('/v1/notify/devices', {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(devices.status).toBe(500);
      expect(await devices.json()).toEqual({ error: 'device_registry_corrupt' });
      await expect(listNotificationDevices()).rejects.toBeInstanceOf(DeviceRegistryCorruptError);
      const blob = alerts.join('\n');
      expect(blob).toContain('corrupt');
      expect(blob).not.toContain('leaked-secret-value');
      expect(blob.toLowerCase()).not.toContain('password');
    } finally {
      console.error = originalError;
      setNotifyPasswordHashForTests(null);
      globalThis.fetch = fetchDuringBoot;
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('overwrite directory fsync failure keeps old registry and deletes the new ntfy user', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-overwrite-fsync', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    const created: string[] = [];
    const deleted: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      let username = '';
      if (typeof init?.body === 'string') {
        try {
          username = String((JSON.parse(init.body) as { username?: string }).username ?? '');
        } catch {
          username = '';
        }
      }
      if (method === 'POST' && url.endsWith('/v1/users') && username) created.push(username);
      if (method === 'DELETE' && username) deleted.push(username);
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const kept = await createNotificationDevice({ displayName: 'Keep' });
      let dirFsyncs = 0;
      setDeviceRegistryDirFsyncHookForTests(() => {
        dirFsyncs += 1;
        if (dirFsyncs > 1) return;
        const err = new Error('EIO: dir fsync');
        (err as NodeJS.ErrnoException).code = 'EIO';
        throw err;
      });
      await expect(createNotificationDevice({ displayName: 'New' })).rejects.toBeInstanceOf(
        DeviceRegistryPersistError,
      );
      const disk = JSON.parse(readFileSync(deviceRegistryPathForTests(), 'utf8')) as {
        devices: Array<{ id: string; displayName: string; ntfyUsername: string }>;
      };
      expect(disk.devices).toHaveLength(1);
      expect(disk.devices[0]?.id).toBe(kept.id);
      expect(disk.devices[0]?.displayName).toBe('Keep');
      expect(existsSync(`${deviceRegistryPathForTests()}.bak`)).toBe(false);
      const newUser = created.find((name) => name !== kept.username);
      expect(newUser).toBeTruthy();
      expect(deleted).toContain(newUser);
      expect(deleted).not.toContain(kept.username);
      expect(JSON.stringify(disk)).not.toMatch(/"password"\s*:/);
    } finally {
      setDeviceRegistryDirFsyncHookForTests(null);
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

  test('create succeeds when displayName contains password/token key-like text', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-name-ok', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    const deletes: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (init?.method === 'DELETE') deletes.push(String(input));
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const name = 'My "password": vault "token": phone';
    try {
      const created = await createNotificationDevice({ displayName: name });
      expect(created.displayName).toBe(name);
      expect(deletes).toEqual([]);
      const listed = await listPairedDevices();
      expect(listed[0]?.displayName).toBe(name);
      const disk = JSON.parse(readFileSync(deviceRegistryPathForTests(), 'utf8')) as {
        devices: Array<Record<string, unknown>>;
      };
      const keys: string[] = [];
      const walkKeys = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const item of value) walkKeys(item);
          return;
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          keys.push(key.toLowerCase());
          walkKeys(child);
        }
      };
      walkKeys(disk);
      expect(keys.filter((key) => key === 'password' || key === 'token')).toEqual([]);
      expect(disk.devices[0]?.displayName).toBe(name);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('ghost user cleanup warns when delete fails and still returns 502', async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as {
      enabled: boolean;
      adminPassword?: string;
      configPath: string;
      publicUrl: string;
    }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      configPath: join(process.env.DATA_DIR!, 'phone-ghost-warn', 'server.yml'),
      publicUrl: 'https://notify.test',
    });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'DELETE') throw new Error('ECONNRESET');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    setDeviceRegistryPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    try {
      await expect(createNotificationDevice({ displayName: 'Ghost' })).rejects.toMatchObject({
        code: 'device_registry_unavailable',
      });
      expect(warnings.some((line) => line.includes('ghost ntfy user cleanup failed'))).toBe(true);
    } finally {
      console.warn = originalWarn;
      setDeviceRegistryPersistHookForTests(null);
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

  test('publish keeps notify_unavailable externally while distinguishing rejection from outage internally', async () => {
    const previousNtfy = { ...config.ntfy };
    const previousFetch = globalThis.fetch;
    Object.assign(config.ntfy, { enabled: true, adminPassword: 'ntfy-admin-secret' });
    const service = new NtfyNotificationService();
    const input = {
      target: 'user' as const,
      title: 'classification',
      message: 'classification',
      level: 'normal' as const,
    };
    const caught: unknown[] = [];

    try {
      for (const response of [
        async () => new Response('', { status: 400 }),
        async () => new Response('', { status: 413 }),
        async () => new Response('', { status: 422 }),
        async () => new Response('', { status: 404 }),
        async () => new Response('', { status: 405 }),
        async () => new Response('', { status: 401 }),
        async () => new Response('', { status: 403 }),
        async () => new Response('', { status: 407 }),
        async () => new Response('', { status: 408 }),
        async () => new Response('', { status: 425 }),
        async () => new Response('', { status: 429 }),
        async () => new Response('', { status: 503 }),
        async () => { throw new TypeError('network down'); },
      ]) {
        globalThis.fetch = response as unknown as typeof fetch;
        try {
          await service.publish(input);
        } catch (err) {
          caught.push(err);
        }
      }
    } finally {
      globalThis.fetch = previousFetch;
      Object.assign(config.ntfy, previousNtfy);
    }

    expect(caught.map((err) => err instanceof NotifyError ? err.code : undefined)).toEqual([
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
      'notify_unavailable',
    ]);
    expect(caught.map(isNotifyServiceFailure)).toEqual([
      false, false, false,
      true, true,
      true, true, true, true, true, true, true, true,
    ]);
  });

  test('publish aborts a never-settling fetch at the shared 8s deadline and marks it service-level', async () => {
    const previousNtfy = { ...config.ntfy };
    const previousFetch = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    Object.assign(config.ntfy, { enabled: true, adminPassword: 'ntfy-admin-secret' });
    const timeoutMs: number[] = [];

    AbortSignal.timeout = ((ms: number) => {
      timeoutMs.push(ms);
      const controller = new AbortController();
      queueMicrotask(() => controller.abort(new DOMException('publish timed out', 'TimeoutError')));
      return controller.signal;
    }) as typeof AbortSignal.timeout;
    globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new DOMException('publish timed out', 'TimeoutError'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    })) as unknown as typeof fetch;

    try {
      const pending = new NtfyNotificationService().publish({
        target: 'user',
        title: 'timeout',
        message: 'timeout',
        level: 'normal',
      }).catch((err) => err as unknown);
      const outcome = await Promise.race([
        pending,
        new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 50)),
      ]);

      expect(outcome).toBeInstanceOf(NotifyError);
      expect(outcome).toMatchObject({ code: 'notify_unavailable' });
      expect(isNotifyServiceFailure(outcome)).toBe(true);
      expect(timeoutMs).toEqual([NTFY_ADMIN_FETCH_TIMEOUT_MS]);
    } finally {
      AbortSignal.timeout = originalTimeout;
      globalThis.fetch = previousFetch;
      Object.assign(config.ntfy, previousNtfy);
    }
  });

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

  test('a failed urgent publish records a body-free delivery failure for the dashboard', async () => {
    await withLivePublish(async () => new Response('nope', { status: 503 }), async (svc) => {
      await expect(svc.publish({
        target: 'user',
        title: 'urgent task update',
        message: 'do not persist this body',
        level: 'urgent',
        source: 'task',
        sensitive: true,
      })).rejects.toThrow('notify_unavailable');
      const page = await queryNotificationLog({ limit: 20 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        delivery: 'failed',
        level: 'urgent',
        source: 'task',
        title: 'urgent task update',
        message: '',
        sensitive: true,
      });
    });
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
    expect(classifyNtfyUserDeleteResponse(200, '{}')).toBe('deleted');
    expect(classifyNtfyUserDeleteResponse(503, 'unavailable')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(404, '{"code":40401,"error":"page not found"}')).toBe(
      'transient',
    );
    expect(
      classifyNtfyUserDeleteResponse(
        400,
        JSON.stringify({ code: 40024, http: 400, error: 'invalid request: request body must be valid JSON' }),
      ),
    ).toBe('transient');
  });

  test('5xx body containing user-does-not-exist stays transient; 40031/404 still not_found', () => {
    const missing = JSON.stringify({
      code: 40031,
      http: 500,
      error: 'invalid request: user does not exist',
    });
    expect(classifyNtfyUserDeleteResponse(500, missing)).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(503, 'user does not exist')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(502, 'not_found')).toBe('transient');
    expect(
      classifyNtfyUserDeleteResponse(
        400,
        JSON.stringify({ code: 40024, http: 400, error: 'invalid request: request body must be valid JSON' }),
      ),
    ).toBe('transient');
    expect(
      classifyNtfyUserDeleteResponse(
        400,
        JSON.stringify({ code: 40031, http: 400, error: 'invalid request: user does not exist' }),
      ),
    ).toBe('not_found');
    expect(classifyNtfyUserDeleteResponse(404, 'not_found')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(404, '{"error":"route_not_found"}')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(404, 'user does not exist')).toBe('not_found');
  });

  test('gateway 404 route_not_found body stays transient and does not converge', async () => {
    expect(classifyNtfyUserDeleteResponse(404, '')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(404, '{}')).toBe('transient');
    expect(classifyNtfyUserDeleteResponse(404, '{"error":"route_not_found"}')).toBe('transient');
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ error: 'route_not_found' }), { status: 404 });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Gateway-404',
        ntfyUsername: 'phone-gw404',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      await expect(revokeNotificationDevice(record.id)).rejects.toMatchObject({
        code: 'device_revoke_retry',
      });
      const listed = await listPairedDevices();
      expect(listed[0]?.revokeStatus).toBe('pending_revoke');
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('revoke with ntfy disabled does not mark a remote username revoked', async () => {
    const previousNtfy = { ...config.ntfy };
    const record = await registerPairedDevice({
      displayName: 'Still-live',
      ntfyUsername: 'phone-stilllive',
      topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
    });
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
      enabled: false,
      adminPassword: undefined,
    });
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      await expect(revokeNotificationDevice(record.id)).rejects.toMatchObject({
        code: 'notifications_disabled',
      });
      expect(fetches).toBe(0);
      const listed = await listPairedDevices();
      expect(listed[0]?.id).toBe(record.id);
      expect(listed[0]?.revokeStatus).toBe('active');

      const second = await registerPairedDevice({
        displayName: 'Unconfigured',
        ntfyUsername: 'phone-unconf',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
        enabled: true,
        adminPassword: undefined,
      });
      await expect(revokeNotificationDevice(second.id)).rejects.toMatchObject({
        code: 'notifications_unconfigured',
      });
      expect(fetches).toBe(0);
      expect((await listPairedDevices()).some((row) => row.id === second.id && row.revokeStatus === 'active')).toBe(
        true,
      );
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('already revoked stays idempotent when ntfy is fully unconfigured', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    let fetches = 0;
    globalThis.fetch = (async (_input, init) => {
      fetches += 1;
      if (init?.method === 'DELETE') {
        return new Response(
          JSON.stringify({ code: 40031, http: 400, error: 'invalid request: user does not exist' }),
          { status: 400 },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Was-revoked',
        ntfyUsername: 'phone-wasrevoked',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      expect(await revokeNotificationDevice(record.id)).toBe('revoked');
      const deletesBefore = fetches;
      Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
        enabled: false,
        adminPassword: undefined,
      });
      expect(await revokeNotificationDevice(record.id)).toBe('already_revoked');
      expect(fetches).toBe(deletesBefore);
      const all = await listPairedDevices({ includeRevoked: true });
      expect(all[0]?.revokeStatus).toBe('revoked');
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('5xx with user-does-not-exist body does not converge pending_revoke to revoked', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'DELETE') {
        return new Response(
          JSON.stringify({ code: 40031, http: 500, error: 'invalid request: user does not exist' }),
          { status: 503 },
        );
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Still-there',
        ntfyUsername: 'phone-stillthere',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      await expect(revokeNotificationDevice(record.id)).rejects.toMatchObject({
        code: 'device_revoke_retry',
      });
      const listed = await listPairedDevices();
      expect(listed[0]?.id).toBe(record.id);
      expect(listed[0]?.revokeStatus).toBe('pending_revoke');
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('concurrent listNotificationDevices share one in-flight reconcile', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deletes = 0;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        await gate;
        return new Response('unavailable', { status: 503 });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Coalesce',
        ntfyUsername: 'phone-coalesce',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      await expect(revokePairedDevice(record.id, async () => 'transient')).rejects.toMatchObject({
        code: 'device_revoke_retry',
      });
      const a = listNotificationDevices();
      const b = listNotificationDevices();
      release();
      await Promise.all([a, b]);
      expect(deletes).toBe(1);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('pending_revoke target issues a single DELETE when ntfy is 503', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string; publicUrl: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
      publicUrl: 'https://notify.test',
    });
    let deletes = 0;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'DELETE') {
        deletes += 1;
        return new Response('unavailable', { status: 503 });
      }
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const record = await registerPairedDevice({
        displayName: 'Once-delete',
        ntfyUsername: 'phone-oncedelete',
        topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
      });
      await expect(revokeNotificationDevice(record.id)).rejects.toMatchObject({
        code: 'device_revoke_retry',
      });
      expect((await listPairedDevices())[0]?.revokeStatus).toBe('pending_revoke');
      deletes = 0;
      await expect(revokeNotificationDevice(record.id)).rejects.toMatchObject({
        code: 'device_revoke_retry',
      });
      expect(deletes).toBe(1);
      expect((await listPairedDevices())[0]?.revokeStatus).toBe('pending_revoke');
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
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
      expect(listed.headers.get('cache-control')).toBe('no-store');
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

  test('admin revoke is 503 when ntfy is disabled and the row has a remote username', async () => {
    const previousNtfy = { ...config.ntfy };
    const record = await registerPairedDevice({
      displayName: 'Keep-alive',
      ntfyUsername: 'phone-keepalive',
      topics: { userAlerts: 'user-alerts-x', userLow: 'user-low-x' },
    });
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
      enabled: false,
      adminPassword: undefined,
    });
    try {
      const response = await appFor({ kind: 'admin' }).request(`/v1/notify/devices/${record.id}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: 'notifications_disabled',
        message: expect.stringContaining('Restore ntfy admin access'),
      });
      expect((await listPairedDevices())[0]?.revokeStatus).toBe('active');
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });
});

describe('NtfyNotificationService.messages timeout (#9)', () => {
  test('messages() fetch timeout maps to NotifyError notify_unavailable', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
    });

    const timeoutMs: number[] = [];
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ((ms: number) => {
      timeoutMs.push(ms);
      const controller = new AbortController();
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      return controller.signal;
    }) as typeof AbortSignal.timeout;

    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
      }
      throw new Error('messages() must pass an already-aborted timeout signal');
    }) as typeof fetch;

    try {
      const svc = new NtfyNotificationService();
      let caught: unknown;
      try {
        await svc.messages('user-alerts');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotifyError);
      expect(caught).toMatchObject({ code: 'notify_unavailable' } satisfies Partial<NotifyError>);
      expect(timeoutMs).toEqual([NTFY_ADMIN_FETCH_TIMEOUT_MS]);
    } finally {
      AbortSignal.timeout = originalTimeout;
      Object.assign(config.ntfy, previousNtfy);
    }
  });

  test('messages() body read timeout maps to NotifyError notify_unavailable', async () => {
    const previousNtfy = { ...config.ntfy };
    Object.assign(config.ntfy as { enabled: boolean; adminPassword?: string }, {
      enabled: true,
      adminPassword: 'ntfy-admin-secret',
    });

    globalThis.fetch = (async () =>
      ({
        ok: true,
        async text() {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      }) as Response) as typeof fetch;

    try {
      const svc = new NtfyNotificationService();
      let caught: unknown;
      try {
        await svc.messages('user-alerts');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotifyError);
      expect(caught).toMatchObject({ code: 'notify_unavailable' } satisfies Partial<NotifyError>);
    } finally {
      Object.assign(config.ntfy, previousNtfy);
    }
  });
});

describe('multi-domain notify target resolution', () => {
  const mockIdentities: Identity[] = [
    {
      address: 'shared@primary.example',
      tokenHash: 'h1',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      address: 'shared@secondary.example',
      tokenHash: 'h2',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      address: 'unique@secondary.example',
      tokenHash: 'h3',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  function mockNotifyApp(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      await next();
    });
    app.route(
      '/v1/notify',
      createNotifyRoutes({
        service,
        findIdentity: (addr) =>
          mockIdentities.find((i) => i.address.toLowerCase() === addr.toLowerCase()),
        listIdentities: () => mockIdentities,
        publicUrl: 'https://notify.test',
      }),
    );
    return app;
  }

  test('resolves fully-qualified agent target agent:<localpart@domain>', async () => {
    const app = mockNotifyApp({ kind: 'admin' });
    const res = await app.request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'agent:shared@secondary.example',
        title: 'Task update',
        message: 'hello secondary',
        level: 'normal',
      }),
    });
    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0].identityAddress).toBe('shared@secondary.example');
    expect(published[0].logicalChannel).toBe('agent:shared');
  });

  test('resolves unambiguous bare agent target agent:<localpart>', async () => {
    const app = mockNotifyApp({ kind: 'admin' });
    const res = await app.request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'agent:unique',
        title: 'Task update',
        message: 'hello unique',
        level: 'normal',
      }),
    });
    expect(res.status).toBe(200);
    expect(published).toHaveLength(1);
    expect(published[0].identityAddress).toBe('unique@secondary.example');
    expect(published[0].logicalChannel).toBe('agent:unique');
  });

  test('returns 400 ambiguous_agent when bare target exists in multiple domains', async () => {
    const app = mockNotifyApp({ kind: 'admin' });
    const res = await app.request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'agent:shared',
        title: 'Task update',
        message: 'hello shared',
        level: 'normal',
      }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe('ambiguous_agent');
    expect(data.domains).toEqual(['primary.example', 'secondary.example']);
    expect(published).toHaveLength(0);
  });

  test('returns 404 when agent target is not found', async () => {
    const app = mockNotifyApp({ kind: 'admin' });
    const res = await app.request('/v1/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'agent:unknown@secondary.example',
        title: 'Task update',
        message: 'hello unknown',
        level: 'normal',
      }),
    });
    expect(res.status).toBe(404);
  });
});
