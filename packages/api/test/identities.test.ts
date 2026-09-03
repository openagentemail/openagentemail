// Identity-store tests. config.ts parses env at import time, so set the
// required variables BEFORE importing anything that pulls it in.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
type Identity = import('../src/lib/identities.ts').Identity;
const { identitiesRoute } = await import('../src/routes/identities.ts');
const { processWatchedMessage } = await import('../src/lib/notification-watcher.ts');

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

  test('invalid persisted pushContentTier normalizes to tier 1 without corrupting the store', () => {
    const good = createIdentity({ localpart: 'compat-good' })!;
    setIdentityPushContentTier(good.identity.address, 2);
    const other = createIdentity({ localpart: 'compat-bad-tier' })!;

    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<Record<string, unknown>>;
    const bad = raw.find((entry) => entry.address === other.identity.address);
    expect(bad).toBeDefined();
    bad!.pushContentTier = 99;
    writeFileSync(storeFile(), JSON.stringify(raw, null, 2));

    // Store still loads; unknown enum resolves as tier 1 but is preserved on disk/object (F94).
    expect(listIdentities().some((i) => i.address === good.identity.address)).toBe(true);
    expect(resolvePushContentTier(findIdentity(other.identity.address)!)).toBe(1);
    expect((findIdentity(other.identity.address) as { pushContentTier?: unknown })?.pushContentTier).toBe(
      99,
    );
    // Sibling entry keeps its valid tier.
    expect(findIdentity(good.identity.address)?.pushContentTier).toBe(2);
  });

  test('coerceIdentity preserves unknown fields and future tier across rewrite (F94)', () => {
    const normal = createIdentity({ localpart: 'f94-normal' })!;
    const future = createIdentity({ localpart: 'f94-future' })!;

    const seeded = JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<Record<string, unknown>>;
    const futureRow = seeded.find((entry) => entry.address === future.identity.address)!;
    futureRow.pushContentTier = 4;
    futureRow.futureField = { nested: true, note: 'from-newer-binary' };
    writeFileSync(storeFile(), JSON.stringify(seeded, null, 2));

    // Load: future tier resolves as 1; raw value kept.
    const loaded = findIdentity(future.identity.address) as Identity & {
      futureField?: { nested: boolean; note: string };
      pushContentTier?: number;
    };
    expect(resolvePushContentTier(loaded)).toBe(1);
    expect(loaded.pushContentTier).toBe(4);
    expect(loaded.futureField).toEqual({ nested: true, note: 'from-newer-binary' });

    // Mutate a different identity and save — future row must not be stripped.
    setIdentityPushContentTier(normal.identity.address, 2);
    const after = JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<Record<string, unknown>>;
    const still = after.find((entry) => entry.address === future.identity.address)!;
    expect(still.pushContentTier).toBe(4);
    expect(still.futureField).toEqual({ nested: true, note: 'from-newer-binary' });
    const normalRow = after.find((entry) => entry.address === normal.identity.address)!;
    expect(normalRow.pushContentTier).toBe(2);
  });
});

describe('identity store mtime cache + address index (F41)', () => {
  /** External rewrite that must miss the mtime cache even within the same ms. */
  function writeStoreExternal(entries: Array<Record<string, unknown>>): void {
    writeFileSync(storeFile(), JSON.stringify(entries, null, 2), { mode: 0o600 });
    const bumped = Date.now() / 1000 + 2;
    utimesSync(storeFile(), bumped, bumped);
  }

  test('findIdentity matches a full list scan (index correctness)', () => {
    createIdentity({ localpart: 'idx-alpha' });
    createIdentity({ localpart: 'idx-beta' });
    setIdentityPushContentTier('idx-beta@test.example', 2);

    const listed = listIdentities();
    for (const row of listed) {
      const found = findIdentity(row.address);
      expect(found?.address).toBe(row.address);
      expect(found?.pushContentTier).toBe(row.pushContentTier);
      // Case-insensitive lookup.
      expect(findIdentity(row.address.toUpperCase())?.address).toBe(row.address);
    }
    expect(findIdentity('missing-index@test.example')).toBeUndefined();
  });

  test('save invalidates cache so same-ms rewrites are visible without mtime help', () => {
    const address = createIdentity({ localpart: 'same-ms-cache' })!.identity.address;
    // Populate cache at current mtime.
    expect(resolvePushContentTier(findIdentity(address)!)).toBe(1);

    // In-process save path (explicit invalidate) must surface the new tier immediately.
    setIdentityPushContentTier(address, 3);
    expect(findIdentity(address)?.pushContentTier).toBe(3);
    expect(resolvePushContentTier(findIdentity(address)!)).toBe(3);

    // Second write in the same tick path: still visible after save.
    setIdentityPushContentTier(address, 2);
    expect(findIdentity(address)?.pushContentTier).toBe(2);
  });

  test('processWatchedMessage with findIdentity refresh stays under 1s on 5k store / 50 recipients', async () => {
    const createdAt = '2026-08-02T00:00:00.000Z';
    const bulk = Array.from({ length: 5_000 }, (_, i) => ({
      address: `bulk${i}@test.example`,
      createdAt,
      // Mix tiers so refreshIdentity actually resolves something meaningful.
      ...(i % 5 === 0 ? { pushContentTier: 2 as const } : {}),
    }));
    writeStoreExternal(bulk);

    // Spot-check the indexed store loaded the bulk file.
    expect(findIdentity('bulk0@test.example')?.address).toBe('bulk0@test.example');
    expect(findIdentity('bulk4999@test.example')?.address).toBe('bulk4999@test.example');
    expect(listIdentities()).toHaveLength(5_000);

    // bulk0..bulk49: store has tier 2 when index % 5 === 0, else default tier 1.
    // Snapshot pretends tier 3 so a working refreshIdentity is required for correctness.
    const recipients = Array.from({ length: 50 }, (_, i) => ({
      address: `bulk${i}@test.example`,
      createdAt,
      pushContentTier: 3 as const,
    }));

    const calls: unknown[] = [];
    const started = performance.now();
    await processWatchedMessage(
      {
        envelope: {
          from: [{ name: 'auth', address: 'auth@example.net' }],
          to: recipients.map((r) => ({ address: r.address })),
          subject: 'Hello',
        },
        headers: Buffer.from(
          recipients.map((r) => `Delivered-To: ${r.address}`).join('\r\n') + '\r\n',
        ),
        source: Buffer.from(
          'From: auth@example.net\r\nSubject: Hello\r\n\r\nYour verification code is 482731\r\n',
        ),
      } as any,
      recipients,
      'otp',
      {
        publish: async (payload) => {
          calls.push(payload);
          return { target: payload.target, title: payload.title, level: payload.level };
        },
      },
      {
        // Production path after F41: O(1) indexed lookup + mtime/invalidate cache.
        refreshIdentity: (address) => findIdentity(address),
      },
    );
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(50);

    const bodies = calls.map((c) => (c as { message: string }).message);
    // Store tier 2 (index % 5 === 0): subject/from, no Codes (not snapshot tier 3).
    const tier2Body = bodies[0];
    expect(tier2Body).toContain('Subject:');
    expect(tier2Body).not.toContain('Codes:');
    // Store default tier 1: interrupt only.
    const tier1Body = bodies[1];
    expect(tier1Body).not.toContain('Subject:');
    expect(tier1Body).not.toContain('Codes:');
  });
});

describe('identity store save failure drops cache (F42)', () => {
  /**
   * Force save() to throw after invalidateStoreCache(). save() re-chmods the
   * data dir to 0o700 before writing, so a read-only data dir is not a reliable
   * fault injection; blocking the identities.json.tmp write path is.
   */
  function withBlockedSaveTmp(run: () => void): void {
    const tmpPath = `${storeFile()}.tmp`;
    rmSync(tmpPath, { recursive: true, force: true });
    mkdirSync(tmpPath);
    try {
      run();
    } finally {
      rmSync(tmpPath, { recursive: true, force: true });
      try {
        chmodSync(storeDir(), 0o700);
      } catch {
        // best effort restore
      }
    }
  }

  test('failed rotateIdentityToken keeps the old token hash after reload', () => {
    const created = createIdentity({ localpart: 'save-fail-rotate' })!;
    const address = created.identity.address;
    const oldToken = created.token;
    const oldHash = findIdentity(address)!.tokenHash;
    expect(oldHash).toBeDefined();
    expect(findIdentityByToken(oldToken)?.address).toBe(address);

    withBlockedSaveTmp(() => {
      expect(() => rotateIdentityToken(address)).toThrow();
    });

    // Cache was dropped before the failed write; disk still has the old hash.
    expect(findIdentity(address)?.tokenHash).toBe(oldHash);
    expect(findIdentityByToken(oldToken)?.address).toBe(address);
  });

  test('failed createIdentity leaves no ghost identity after reload', () => {
    const ghost = 'ghost-save-fail@test.example';
    expect(findIdentity(ghost)).toBeUndefined();

    withBlockedSaveTmp(() => {
      expect(() => createIdentity({ localpart: 'ghost-save-fail' })).toThrow();
    });

    expect(findIdentity(ghost)).toBeUndefined();
    expect(listIdentities().some((i) => i.address === ghost)).toBe(false);
  });
});

describe('identity store composite cache version (F56)', () => {
  /** Pin mtime to whole milliseconds so utimes can reproduce the cached value. */
  function stabilizeMtimeAndRecache(address: string) {
    const st = statSync(storeFile());
    const ms = Math.floor(st.mtimeMs);
    utimesSync(storeFile(), new Date(ms), new Date(ms));
    // Composite key sees ctime change → reload with rounded mtime in cache.
    findIdentity(address);
    return statSync(storeFile());
  }

  test('atomic replace with forced same mtime reloads new content', () => {
    const created = createIdentity({ localpart: 'f56-atomic' })!;
    const address = created.identity.address;
    const oldToken = created.token;
    const oldHash = findIdentity(address)!.tokenHash!;
    expect(oldHash.length).toBe(64);
    expect(findIdentityByToken(oldToken)?.address).toBe(address);

    const before = stabilizeMtimeAndRecache(address);
    const raw = readFileSync(storeFile(), 'utf8');
    // Same-size body: only swap the 64-hex hash so size stays put.
    const nextRaw = raw.replace(oldHash, 'a'.repeat(64));
    expect(nextRaw).not.toBe(raw);
    expect(Buffer.byteLength(nextRaw)).toBe(Buffer.byteLength(raw));

    const tmp = `${storeFile()}.f56-atomic.tmp`;
    writeFileSync(tmp, nextRaw, { mode: 0o600 });
    renameSync(tmp, storeFile());
    utimesSync(storeFile(), new Date(before.mtimeMs), new Date(before.mtimeMs));

    const after = statSync(storeFile());
    // Prove mtime-only would still hit; composite must see ino.
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).not.toBe(before.ino);

    expect(findIdentityByToken(oldToken)).toBeUndefined();
    expect(findIdentity(address)?.tokenHash).toBe('a'.repeat(64));
  });

  test('in-place rewrite with same size and mtime reloads new content', () => {
    const created = createIdentity({ localpart: 'f56-inplace' })!;
    const address = created.identity.address;
    setIdentityPushContentTier(address, 3);
    expect(findIdentity(address)?.pushContentTier).toBe(3);

    const before = stabilizeMtimeAndRecache(address);
    const raw = readFileSync(storeFile(), 'utf8');
    // Same byte length: swap tier 3 → tier 1 in place without size change.
    expect(raw).toContain('"pushContentTier": 3');
    const rewritten = raw.replace('"pushContentTier": 3', '"pushContentTier": 1');
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(raw));

    writeFileSync(storeFile(), rewritten, { mode: 0o600 });
    utimesSync(storeFile(), new Date(before.mtimeMs), new Date(before.mtimeMs));

    const after = statSync(storeFile());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    // ctimeMs must diverge so a composite key misses (mtime-only would hit).
    expect(after.ctimeMs).not.toBe(before.ctimeMs);

    expect(findIdentity(address)?.pushContentTier).toBe(1);
    expect(resolvePushContentTier(findIdentity(address)!)).toBe(1);
  });

  test('unchanged file returns the same cached identity object', () => {
    createIdentity({ localpart: 'f56-stable' });
    const first = listIdentities();
    // Same Map value object ⇒ storeCache was not rebuilt between loads.
    const a = findIdentity('f56-stable@test.example');
    const b = findIdentity('f56-stable@test.example');
    expect(a).toBe(b);
    expect(listIdentities().map((i) => i.address).sort()).toEqual(
      first.map((i) => i.address).sort(),
    );
  });
});

describe('multi-domain identities', () => {
  test('creates identities under secondary domains and preserves per-domain uniqueness', async () => {
    const prevNtfy = config.ntfy.enabled;
    (config.ntfy as { enabled: boolean }).enabled = false;
    (config.allDomains as Set<string>).add('secondary.example');
    (config.extraDomains as string[]).push('secondary.example');

    try {
      const app = appFor({ kind: 'admin' });

      // Rejects invalid unconfigured domain with 400
      const resBad = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'shared-name', domain: 'not-configured.example' }),
      });
      expect(resBad.status).toBe(400);
      expect(await resBad.json()).toEqual({ error: 'invalid_domain' });

      // Create shared-name on primary domain
      const resPrimary = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'shared-name', domain: 'test.example' }),
      });
      expect(resPrimary.status).toBe(201);
      const dataPrimary = (await resPrimary.json()) as any;
      expect(dataPrimary.address).toBe('shared-name@test.example');

      // Attempting same localpart on secondary domain is rejected with 409 localpart_conflict
      const resConflict = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'shared-name', domain: 'secondary.example' }),
      });
      expect(resConflict.status).toBe(409);
      expect(resConflict.headers.get('cache-control')).toBe('no-store');
      const dataConflict = (await resConflict.json()) as any;
      expect(dataConflict.error).toBe('localpart_conflict');
      expect(dataConflict.domains).toContain('test.example');

      // Distinct localpart on secondary domain succeeds
      const resSecondary = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'other-name', domain: 'secondary.example' }),
      });
      expect(resSecondary.status).toBe(201);
      const dataSecondary = (await resSecondary.json()) as any;
      expect(dataSecondary.address).toBe('other-name@secondary.example');

      // Both identities exist simultaneously
      expect(findIdentity('shared-name@test.example')).toBeDefined();
      expect(findIdentity('other-name@secondary.example')).toBeDefined();

      // Duplicate within same primary domain returns 409 address_exists
      const resDup = await app.request('/v1/identities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ localpart: 'shared-name', domain: 'test.example' }),
      });
      expect(resDup.status).toBe(409);
      expect(await resDup.json()).toEqual({ error: 'address_exists' });
    } finally {
      (config.ntfy as { enabled: boolean }).enabled = prevNtfy;
      (config.allDomains as Set<string>).delete('secondary.example');
      const idx = config.extraDomains.indexOf('secondary.example');
      if (idx !== -1) config.extraDomains.splice(idx, 1);
    }
  });
});

