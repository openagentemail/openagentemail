// #360：admin PATCH 只改既有身份 canNotifyUser。先鉴权再解析 body；
// 同值不写盘不审计；notify 走 fake，禁止真 ntfy/network。
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-360';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-id-flags-'));
process.env.NTFY_ENABLED = 'false';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { config } = await import('../src/lib/config.ts');
const { bearerAuth } = await import('../src/lib/auth.ts');
const { scopePolicyMiddleware } = await import('../src/lib/scope-policy.ts');
const {
  createIdentity,
  findIdentity,
  findIdentityByToken,
  setIdentityPushContentTier,
} = await import('../src/lib/identities.ts');
const { readAuditEvents, recordAuditEvent, resetAuditForTests } = await import('../src/lib/audit.ts');
const { resetNotifyUserLimits } = await import('../src/lib/ratelimit.ts');
const { identitiesRoute } = await import('../src/routes/identities.ts');
const { createNotifyRoutes } = await import('../src/routes/notify.ts');
type NotifyService = import('../src/lib/notify.ts').NotifyService;

const adminKey = [...config.apiKeys][0]!;
const originalFetch = globalThis.fetch;
const published: Array<Record<string, unknown>> = [];
let fetchCalls = 0;

const service: NotifyService = {
  async publish(input) {
    published.push({ ...input });
    return { target: input.target, title: input.title, level: input.level };
  },
  async messages() {
    return [];
  },
  async verify() {
    return { ok: true };
  },
};

function buildApp() {
  const app = new Hono();
  // 与生产 /v1 同序：先 bearer，再 scope。不挂生产 notifyRoute，避免真 ntfy。
  app.use('/v1/*', bearerAuth);
  app.use('/v1/*', scopePolicyMiddleware);
  app.route('/v1/identities', identitiesRoute);
  app.route('/v1/notify', createNotifyRoutes({ service, publicUrl: 'https://notify.test' }));
  return app;
}

const app = buildApp();
const storeFile = () => join(config.dataDir, 'identities.json');

function bearer(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function snapStore() {
  const st = statSync(storeFile());
  return { text: readFileSync(storeFile(), 'utf8'), ino: st.ino, mtimeMs: st.mtimeMs };
}

function diskRecord(address: string) {
  const rows = JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<Record<string, unknown>>;
  return rows.find((row) => row.address === address);
}

function flagAudits() {
  return readAuditEvents({ event: 'identity.flags.update', limit: 20 });
}

async function patch(token: string, address: string, body: string) {
  return app.request(`/v1/identities/${encodeURIComponent(address)}`, {
    method: 'PATCH',
    headers: bearer(token),
    body,
  });
}

async function notifyUser(token: string) {
  return app.request('/v1/notify', {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ target: 'user', title: 'wake', message: 'please look', level: 'urgent' }),
  });
}

beforeEach(() => {
  published.length = 0;
  fetchCalls = 0;
  resetAuditForTests();
  resetNotifyUserLimits();
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('ntfy network forbidden');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(fetchCalls).toBe(0);
});

describe('#360 PATCH canNotifyUser', () => {
  test('① admin false→true→false：PATCH/GET/落盘一致，原 token notify 403→fake→403', async () => {
    const parent = createIdentity({ localpart: 'flag-parent' })!;
    const created = createIdentity({
      name: 'Flag Agent',
      localpart: 'flag-agent',
      parentIdentity: parent.identity.address,
    })!;
    const address = created.identity.address;
    const token = created.token;
    setIdentityPushContentTier(address, 2);
    const frozen = {
      address,
      name: 'Flag Agent',
      createdAt: findIdentity(address)!.createdAt,
      tokenHash: findIdentity(address)!.tokenHash,
      parentIdentity: parent.identity.address,
      pushContentTier: 2 as const,
      scopes: undefined,
    };
    const expectFrozen = () => {
      const live = findIdentity(address)!;
      expect({
        address: live.address,
        name: live.name,
        createdAt: live.createdAt,
        tokenHash: live.tokenHash,
        parentIdentity: live.parentIdentity,
        pushContentTier: live.pushContentTier,
        scopes: live.scopes,
      }).toEqual(frozen);
      expect(findIdentityByToken(token)?.address).toBe(address);
      expect(JSON.stringify(diskRecord(address))).not.toContain(token);
    };

    const absent = snapStore();
    const noopFalse = await patch(adminKey, address.toUpperCase(), '{"canNotifyUser":false}');
    expect(noopFalse.status).toBe(200);
    const noopFalseBody = await noopFalse.json();
    expect(noopFalseBody).not.toHaveProperty('canNotifyUser');
    expect(snapStore()).toEqual(absent);
    expect(flagAudits()).toEqual([]);
    expectFrozen();

    const denied = await notifyUser(token);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden: can_notify_user required' });
    expect(published).toEqual([]);
    const ownTier = await app.request(`/v1/identities/${encodeURIComponent(address)}/push-tier`, {
      headers: bearer(token),
    });
    expect(ownTier.status).toBe(200);

    const turnedOn = await patch(adminKey, `Flag-Agent@TEST.example`, '{"canNotifyUser":true}');
    expect(turnedOn.status).toBe(200);
    const onBody = (await turnedOn.json()) as Record<string, unknown>;
    expect(onBody.canNotifyUser).toBe(true);
    const listedOn = await app.request('/v1/identities', { headers: bearer(adminKey) });
    const listOn = ((await listedOn.json()) as { identities: Array<Record<string, unknown>> }).identities.find(
      (row) => row.address === address,
    );
    expect(listOn).toEqual(onBody);
    expect(diskRecord(address)?.canNotifyUser).toBe(true);
    expectFrozen();

    const allowed = await notifyUser(token);
    expect(allowed.status).toBe(200);
    expect(published).toEqual([
      {
        target: 'user',
        title: 'wake',
        message: 'please look',
        level: 'urgent',
        source: 'manual',
        logicalChannel: 'user-alerts',
        sensitive: false,
      },
    ]);

    const stillOn = snapStore();
    const noopTrue = await patch(adminKey, address, '{"canNotifyUser":true}');
    expect(noopTrue.status).toBe(200);
    expect(await noopTrue.json()).toEqual(onBody);
    expect(snapStore()).toEqual(stillOn);

    const turnedOff = await patch(adminKey, address, '{"canNotifyUser":false}');
    expect(turnedOff.status).toBe(200);
    const offBody = (await turnedOff.json()) as Record<string, unknown>;
    expect(offBody).not.toHaveProperty('canNotifyUser');
    const listedOff = await app.request('/v1/identities', { headers: bearer(adminKey) });
    const listOff = ((await listedOff.json()) as { identities: Array<Record<string, unknown>> }).identities.find(
      (row) => row.address === address,
    );
    expect(listOff).toEqual(offBody);
    expect(diskRecord(address)).not.toHaveProperty('canNotifyUser');
    expectFrozen();

    const deniedAgain = await notifyUser(token);
    expect(deniedAgain.status).toBe(403);
    expect(published).toHaveLength(1);

    const rows = flagAudits();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({
        ts: expect.any(String),
        event: 'identity.flags.update',
        address,
        outcome: 'ok',
        ip: expect.any(String),
        changedFields: ['canNotifyUser'],
      });
    }
    const rawAudit = readFileSync(join(config.dataDir, 'audit.jsonl'), 'utf8');
    expect(rawAudit).not.toContain(token);
    expect(rawAudit).not.toContain('true');
    expect(rawAudit).not.toContain('false');
    expect(rawAudit).not.toContain('please look');
    expect(fetchCalls).toBe(0);
  });

  test('② 身份 token 与 scoped 子身份 PATCH 403，畸形 JSON 也是 403，零写入零审计', async () => {
    const parent = createIdentity({
      localpart: 'gate-parent',
      scopes: ['identities:create', 'read:messages'],
    })!;
    const plain = createIdentity({ localpart: 'gate-plain', name: 'Plain' })!;
    const child = createIdentity({
      localpart: 'gate-child',
      name: 'Child',
      scopes: ['read:messages'],
      parentIdentity: parent.identity.address,
    })!;
    const before = snapStore();
    const plainDenied = await patch(plain.token, plain.identity.address, '{');
    expect(plainDenied.status).toBe(403);
    expect(await plainDenied.json()).toEqual({ error: 'forbidden: admin key required' });
    const childDenied = await patch(
      child.token,
      child.identity.address,
      JSON.stringify({ canNotifyUser: true }),
    );
    expect(childDenied.status).toBe(403);
    expect(snapStore()).toEqual(before);
    expect(readAuditEvents({ limit: 20 })).toEqual([]);

    const childHash = findIdentity(child.identity.address)!.tokenHash;
    const childScopes = findIdentity(child.identity.address)!.scopes;
    const turned = await patch(adminKey, child.identity.address, '{"canNotifyUser":true}');
    expect(turned.status).toBe(200);
    const live = findIdentity(child.identity.address)!;
    expect(live.canNotifyUser).toBe(true);
    expect(live.tokenHash).toBe(childHash);
    expect(live.scopes).toEqual(childScopes);
    expect(live.parentIdentity).toBe(parent.identity.address);
    expect(live.name).toBe('Child');
    expect(findIdentityByToken(child.token)?.address).toBe(child.identity.address);
  });

  test('② 非法 JSON、未知键、空体、非布尔、name 为 400，缺失身份 404，零写入零审计', async () => {
    const created = createIdentity({ localpart: 'gate-bad', name: 'Bad' })!;
    const cases = [
      { body: '', error: 'invalid_request' },
      { body: '   ', error: 'invalid_request' },
      { body: '{', error: 'invalid_json' },
      { body: 'null', error: 'invalid_request' },
      { body: '[]', error: 'invalid_request' },
      { body: '{}', error: 'invalid_request' },
      { body: '{"canNotifyUser":"true"}', error: 'invalid_request' },
      { body: '{"canNotifyUser":null}', error: 'invalid_request' },
      { body: '{"canNotifyUser":1}', error: 'invalid_request' },
      { body: '{"name":"x"}', error: 'invalid_request' },
      { body: '{"canNotifyUser":true,"name":"x"}', error: 'invalid_request' },
      { body: '{"canNotifyUser":true,"extra":1}', error: 'invalid_request' },
    ];
    for (const item of cases) {
      const before = snapStore();
      const res = await patch(adminKey, created.identity.address, item.body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe(item.error);
      expect(snapStore()).toEqual(before);
      expect(readAuditEvents({ limit: 20 })).toEqual([]);
    }
    const beforeMissing = snapStore();
    const missing = await patch(adminKey, 'missing@test.example', '{"canNotifyUser":true}');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect(snapStore()).toEqual(beforeMissing);
    expect(readAuditEvents({ limit: 20 })).toEqual([]);
  });

  test('③ changedFields 只保留 canNotifyUser，不落 token/body/布尔值', () => {
    recordAuditEvent({
      event: 'identity.flags.update',
      outcome: 'ok',
      address: 'scrub@test.example',
      ip: '203.0.113.5',
      ...({ changedFields: ['token', 'canNotifyUser', 'body', 'canNotifyUser\ninjected'] } as object),
    } as Parameters<typeof recordAuditEvent>[0]);
    const row = flagAudits()[0] as { changedFields?: string[] };
    expect(row?.changedFields).toEqual(['canNotifyUser']);
    const raw = readFileSync(join(config.dataDir, 'audit.jsonl'), 'utf8');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('body');
    expect(raw).not.toContain('injected');
    expect(raw).not.toContain('true');
    expect(raw).not.toContain('false');
  });

  test('审计追加失败不回滚已落盘的 flag', async () => {
    const created = createIdentity({ localpart: 'audit-soft', name: 'Soft' })!;
    const auditPath = join(config.dataDir, 'audit.jsonl');
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);
    try {
      const res = await patch(adminKey, created.identity.address, '{"canNotifyUser":true}');
      expect(res.status).toBe(200);
      expect(findIdentity(created.identity.address)?.canNotifyUser).toBe(true);
      expect(diskRecord(created.identity.address)?.canNotifyUser).toBe(true);
    } finally {
      rmSync(auditPath, { recursive: true, force: true });
    }
  });

  test('④ 创建时 admin 仍可设 canNotifyUser:true', async () => {
    const res = await app.request('/v1/identities', {
      method: 'POST',
      headers: bearer(adminKey),
      body: JSON.stringify({ localpart: 'create-notify-on', canNotifyUser: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { canNotifyUser?: boolean; token?: string };
    expect(body.canNotifyUser).toBe(true);
    expect(body.token?.startsWith('oa_')).toBe(true);
    expect(findIdentity('create-notify-on@test.example')?.canNotifyUser).toBe(true);
  });
});
