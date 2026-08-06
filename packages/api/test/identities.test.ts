// Identity-store tests. config.ts parses env at import time, so set the
// required variables BEFORE importing anything that pulls it in.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-1,admin-key-2';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-identities-'));

const { describe, expect, test } = await import('bun:test');
const { Hono } = await import('hono');
const { config } = await import('../src/lib/config.ts');
const {
  createIdentity,
  deleteIdentity,
  findIdentity,
  findIdentityByToken,
  listIdentities,
  resolvePushContentTier,
  rotateIdentityToken,
  setIdentityPushContentTier,
  PUSH_TIER3_WARNING,
} = await import('../src/lib/identities.ts');
const { identitiesRoute } = await import('../src/routes/identities.ts');

/** Always use the process-wide config path (other files may race on DATA_DIR env). */
const storeDir = () => config.dataDir;
const storeFile = () => join(config.dataDir, 'identities.json');

function appFor(auth: { kind: 'admin' } | { kind: 'identity'; address: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.route('/v1/identities', identitiesRoute);
  return app;
}

describe('identity tokens', () => {
  test('create returns a plaintext token once; store keeps only the hash', () => {
    const created = createIdentity({ localpart: 'tok-one' });
    expect(created).not.toBeNull();
    const { identity, token } = created!;
    expect(identity.address).toBe('tok-one@test.example');
    expect(token.startsWith('oa_')).toBe(true);
    // The stored identity must not contain the plaintext token.
    const stored = findIdentity('tok-one@test.example')!;
    expect(stored.tokenHash).toBeDefined();
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test('findIdentityByToken resolves the right identity', () => {
    const { token } = createIdentity({ localpart: 'tok-two' })!;
    const found = findIdentityByToken(token);
    expect(found?.address).toBe('tok-two@test.example');
    expect(findIdentityByToken('oa_wrong-token')).toBeUndefined();
  });

  test('rotation kills the old token and issues a working new one', () => {
    const { token: oldToken } = createIdentity({ localpart: 'tok-three' })!;
    const newToken = rotateIdentityToken('tok-three@test.example');
    expect(newToken).not.toBeNull();
    expect(newToken).not.toBe(oldToken);
    expect(findIdentityByToken(oldToken!)).toBeUndefined();
    expect(findIdentityByToken(newToken!)?.address).toBe('tok-three@test.example');
    expect(rotateIdentityToken('ghost@test.example')).toBeNull();
  });

  test('delete removes identity and its token', () => {
    const { token } = createIdentity({ localpart: 'tok-four' })!;
    expect(deleteIdentity('tok-four@test.example')).toBe(true);
    expect(deleteIdentity('tok-four@test.example')).toBe(false);
    expect(findIdentityByToken(token)).toBeUndefined();
    expect(findIdentity('tok-four@test.example')).toBeUndefined();
  });

  test('listIdentities never leaks token hashes', () => {
    for (const i of listIdentities()) {
      expect(i).not.toHaveProperty('tokenHash');
    }
  });

  test('duplicate address returns null', () => {
    expect(createIdentity({ localpart: 'tok-one' })).toBeNull();
  });

  // 身份库里存着所有身份的令牌哈希，别的本地用户不该读得到。
  test('store file and data dir are not readable by other users', () => {
    const dir = storeDir();
    // 模拟"目录已经存在且权限宽松"——mkdirSync 的 mode 对已存在目录不生效，
    // 只测 mkdtemp 造出来的 0700 目录等于没测（Codex 复核指出的盲点）。
    chmodSync(dir, 0o755);
    createIdentity({ localpart: 'tok-perm' });
    expect(statSync(join(dir, 'identities.json')).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });
});

// 身份库损坏时绝不能"当成空库继续跑"：随便一次 create/轮换都会把损坏文件
// 覆盖成"空库 + 新身份"，所有既有身份和令牌一次性丢光。
describe('identity store 损坏时 fail closed', () => {
  test('截断的 JSON：读取直接抛错，而不是静默返回空库', () => {
    createIdentity({ localpart: 'before-corrupt' });
    const good = readFileSync(storeFile(), 'utf8');
    try {
      writeFileSync(storeFile(), '[{"address":"x@test.example"');
      expect(() => listIdentities()).toThrow('identity_store_corrupt');
      expect(() => findIdentity('before-corrupt@test.example')).toThrow('identity_store_corrupt');
      expect(() => findIdentityByToken('oa_whatever')).toThrow('identity_store_corrupt');
      expect(() => createIdentity({ localpart: 'after-corrupt' })).toThrow('identity_store_corrupt');
    } finally {
      writeFileSync(storeFile(), good);
    }
  });

  test('结构不对（不是身份数组）也算损坏', () => {
    const good = readFileSync(storeFile(), 'utf8');
    try {
      writeFileSync(storeFile(), '{"identities":[]}');
      expect(() => listIdentities()).toThrow('identity_store_corrupt');
      writeFileSync(storeFile(), '[{"address":123}]');
      expect(() => listIdentities()).toThrow('identity_store_corrupt');
    } finally {
      writeFileSync(storeFile(), good);
    }
  });

  test('修好之后一切照常', () => {
    expect(listIdentities().some((i) => i.address === 'before-corrupt@test.example')).toBe(true);
  });
});

describe('push content tier store and REST', () => {
  function ensureTierAddress(): string {
    const existing = findIdentity('tier-agent@test.example');
    if (existing) return existing.address;
    return createIdentity({ localpart: 'tier-agent' })!.identity.address;
  }

  test('unset tier resolves to interrupt-only (1)', () => {
    expect(resolvePushContentTier({})).toBe(1);
    const address = ensureTierAddress();
    // Reset to absent/default for this assertion when possible.
    setIdentityPushContentTier(address, 1);
    expect(resolvePushContentTier(findIdentity(address)!)).toBe(1);
  });

  test('setIdentityPushContentTier persists and list surfaces the value', () => {
    const address = ensureTierAddress();
    expect(setIdentityPushContentTier(address, 2)?.pushContentTier).toBe(2);
    expect(findIdentity(address)?.pushContentTier).toBe(2);
    const listed = listIdentities().find((i) => i.address === address);
    expect(listed?.pushContentTier).toBe(2);
    expect(setIdentityPushContentTier('missing@test.example', 1)).toBeNull();
  });

  test('identity token cannot set its own tier (403)', async () => {
    const address = ensureTierAddress();
    const response = await appFor({ kind: 'identity', address }).request(
      `/v1/identities/${encodeURIComponent(address)}/push-tier`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pushContentTier: 1 }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden: admin key required' });
  });

  test('identity token may read its own tier', async () => {
    const address = ensureTierAddress();
    setIdentityPushContentTier(address, 2);
    const response = await appFor({ kind: 'identity', address }).request(
      `/v1/identities/${encodeURIComponent(address)}/push-tier`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      address,
      pushContentTier: 2,
    });
  });

  test('identity token cannot read another identity tier', async () => {
    const address = ensureTierAddress();
    const other =
      findIdentity('other-tier-read@test.example') ??
      createIdentity({ localpart: 'other-tier-read' })!.identity;
    const response = await appFor({ kind: 'identity', address }).request(
      `/v1/identities/${encodeURIComponent(other.address)}/push-tier`,
    );
    expect(response.status).toBe(403);
  });

  test('admin can set non-tier-3 without confirm_risk', async () => {
    const address = ensureTierAddress();
    const response = await appFor({ kind: 'admin' }).request(
      `/v1/identities/${encodeURIComponent(address)}/push-tier`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pushContentTier: 1 }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      address,
      pushContentTier: 1,
    });
  });

  test('tier 3 requires confirm_risk: true and returns the risk warning', async () => {
    const address = ensureTierAddress();
    setIdentityPushContentTier(address, 1);
    const denied = await appFor({ kind: 'admin' }).request(
      `/v1/identities/${encodeURIComponent(address)}/push-tier`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pushContentTier: 3 }),
      },
    );
    expect(denied.status).toBe(400);
    const deniedBody = (await denied.json()) as { error: string; message: string };
    expect(deniedBody.error).toBe('confirm_risk_required');
    expect(deniedBody.message).toBe(PUSH_TIER3_WARNING);
    expect(resolvePushContentTier(findIdentity(address)!)).toBe(1);

    const allowed = await appFor({ kind: 'admin' }).request(
      `/v1/identities/${encodeURIComponent(address)}/push-tier`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pushContentTier: 3, confirm_risk: true }),
      },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      address,
      pushContentTier: 3,
      warning: PUSH_TIER3_WARNING,
    });
    expect(findIdentity(address)?.pushContentTier).toBe(3);
  });

  test('GET list includes pushContentTier for every identity', async () => {
    const fresh =
      findIdentity('unset-tier-list@test.example') ??
      createIdentity({ localpart: 'unset-tier-list' })!.identity;
    const response = await appFor({ kind: 'admin' }).request('/v1/identities');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      identities: Array<{ address: string; pushContentTier: number }>;
    };
    const row = body.identities.find((i) => i.address === fresh.address);
    expect(row?.pushContentTier).toBe(resolvePushContentTier(findIdentity(fresh.address)!));
  });
});
