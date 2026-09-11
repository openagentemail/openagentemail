/**
 * 列表限速 16 项矩阵：只由父包装以精确文件路径拉起，避免 bun test 自动发现重复跑。
 * 子进程内 mock imapflow；进程退出即丢弃，不把任何实现标成“原生”。
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } = await import('bun:test');

process.env.DOMAIN ??= 'test.example';
process.env.API_KEYS ??= 'admin-list-rate-a,admin-list-rate-b';
process.env.IMAP_USER ??= 'agent@test.example';
process.env.IMAP_PASS ??= 'imap-secret';
process.env.SMTP_USER ??= 'agent@test.example';
process.env.SMTP_PASS ??= 'smtp-secret';
process.env.MCP_PUBLIC_URL ??= 'http://localhost';

let imapConnects = 0;
let imapSearchCalls = 0;
let failNextSearch = false;

class FakeImapFlow extends EventEmitter {
  constructor() {
    super();
    imapConnects += 1;
  }
  get mailbox() {
    return { uidValidity: 17n };
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async idle() {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  async search() {
    imapSearchCalls += 1;
    if (failNextSearch) {
      failNextSearch = false;
      throw new Error('imap_search_boom');
    }
    return [];
  }
  async *fetch() {
    yield* [];
  }
  async fetchOne() {
    return false;
  }
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { config } = await import('../../src/lib/config.ts');
const { createApp } = await import('../../src/app.ts');
const { createIdentity, rotateIdentityToken } = await import('../../src/lib/identities.ts');
const { createDelegation, resetDelegationStoreForTests } = await import('../../src/lib/delegations.ts');
const { putAccessTokenForTests, resetOAuthStoreCacheForTests } = await import('../../src/lib/oauth-store.ts');
const { resolveResourceUri } = await import('../../src/lib/oauth-url.ts');
const { encodeMailForwardCursor } = await import('../../src/lib/mail-cursor.ts');
const {
  LIST_MESSAGES_CAPACITY_RETRY_SEC,
  LIST_MESSAGES_LIMIT,
  LIST_MESSAGES_MAX_BUCKETS,
  LIST_MESSAGES_WINDOW_MS,
  checkListMessagesLimit,
  checkMcpRateLimit,
  checkSendLimit,
  listMessagesBucketCountForTests,
  listMessagesCallerKey,
  listMessagesHasBucketForTests,
  resetListMessagesLimits,
  resetMcpRateLimits,
  resetNotifyUserLimits,
  resetRateLimits,
  resetWaitSlots,
  seedListMessagesBucketForTests,
  setListMessagesNowForTests,
} = await import('../../src/lib/ratelimit.ts');

const ADMIN_A = 'admin-list-rate-a';
const ADMIN_B = 'admin-list-rate-b';

type HarnessSnap = { dataDir: string; apiKeys: Set<string> };

function snapshotHarness(): HarnessSnap {
  return { dataDir: config.dataDir, apiKeys: new Set(config.apiKeys) };
}

function restoreHarness(snap: HarnessSnap): void {
  (config as { dataDir: string }).dataDir = snap.dataDir;
  config.apiKeys.clear();
  for (const key of snap.apiKeys) config.apiKeys.add(key);
}

const importSnap = snapshotHarness();
const scopedDataDir = config.dataDir;

function applyScopedHarness(): void {
  mkdirSync(scopedDataDir, { recursive: true, mode: 0o700 });
  (config as { dataDir: string }).dataDir = scopedDataDir;
  config.apiKeys.add(ADMIN_A);
  config.apiKeys.add(ADMIN_B);
}

function resetIdentitiesStore(): void {
  writeFileSync(join(config.dataDir, 'identities.json'), '[]', { mode: 0o600 });
}

function resetTouchedStores(): void {
  resetIdentitiesStore();
  resetDelegationStoreForTests();
  resetOAuthStoreCacheForTests();
  resetRateLimits();
  resetWaitSlots();
  resetMcpRateLimits();
  resetNotifyUserLimits();
  setListMessagesNowForTests(null);
  imapConnects = 0;
  imapSearchCalls = 0;
  failNextSearch = false;
}

const app = createApp();

async function listAs(token: string, address: string, extra = ''): Promise<Response> {
  return app.request(`http://localhost/v1/messages?address=${encodeURIComponent(address)}${extra}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function admitN(token: string, address: string, n: number, extra = ''): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    statuses.push((await listAs(token, address, extra)).status);
  }
  return statuses;
}

function validSince(address: string): string {
  return encodeMailForwardCursor(
    {
      folder: 'inbox',
      address,
      t: 1000,
      uid: 1,
      uidValidity: 17,
    },
    config.taskSigningSecret,
  );
}

describe('GET /v1/messages caller list rate', () => {
  beforeAll(() => {
    applyScopedHarness();
    resetTouchedStores();
  });

  beforeEach(() => {
    applyScopedHarness();
    resetTouchedStores();
  });

  afterEach(() => {
    resetTouchedStores();
    applyScopedHarness();
  });

  afterAll(() => {
    resetTouchedStores();
    restoreHarness(importSnap);
  });

  test('signed RED: 同一 caller 第 61 次普通列表必须 429 rate_limited', async () => {
    const minted = createIdentity({ localpart: 'list-rate-red' })!;
    const address = minted.identity.address;
    const token = minted.token;

    expect(await admitN(token, address, 60)).toEqual(Array(60).fill(200));

    const limited = await listAs(token, address);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe('rate_limited');
    expect(Number.isInteger(body.retryAfterSec)).toBe(true);
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(limited.headers.get('Retry-After')).toBe(String(body.retryAfterSec));
  });

  test('ordinary+since 与 query 别名共用 caller 桶', async () => {
    const minted = createIdentity({ localpart: 'list-rate-mixed' })!;
    const address = minted.identity.address;
    const since = `&since=${encodeURIComponent(validSince(address))}`;
    expect(await admitN(minted.token, address, 30)).toEqual(Array(30).fill(200));
    expect(await admitN(minted.token, address.toUpperCase(), 30, since)).toEqual(Array(30).fill(200));
    const limited = await listAs(minted.token, address, since);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: string }).error).toBe('rate_limited');
  });

  test('since 分支 429 对下游 IMAP 零增量', async () => {
    const minted = createIdentity({ localpart: 'list-rate-since-429' })!;
    const since = `&since=${encodeURIComponent(validSince(minted.identity.address))}`;
    expect(await admitN(minted.token, minted.identity.address, 60, since)).toEqual(Array(60).fill(200));
    const connectsAfter = imapConnects;
    const searchesAfter = imapSearchCalls;
    const limited = await listAs(minted.token, minted.identity.address, since);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe('rate_limited');
    expect(imapConnects).toBe(connectsAfter);
    expect(imapSearchCalls).toBe(searchesAfter);
  });

  test('凭证轮换与 OAuth 同一地址聚合', async () => {
    const minted = createIdentity({ localpart: 'list-rate-cred' })!;
    const address = minted.identity.address;
    expect(await admitN(minted.token, address, 20)).toEqual(Array(20).fill(200));

    const rotated = rotateIdentityToken(address)!;
    expect(await admitN(rotated, address, 20)).toEqual(Array(20).fill(200));

    const oauthToken = 'oauth-list-rate-token-32bytes-pad!!';
    putAccessTokenForTests({
      token: oauthToken,
      grantId: 'g-list-rate',
      address,
      aud: resolveResourceUri('http://localhost'),
      expiresAt: Date.now() + 3600_000,
      ensureGrant: { clientId: 'https://client.example/cb', clientName: 'ListRate' },
    });
    expect(await admitN(oauthToken, address, 20)).toEqual(Array(20).fill(200));

    const limited = await listAs(oauthToken, address);
    expect(limited.status).toBe(429);
  });

  test('scope 拒绝的 OAuth 不消耗列表预算', async () => {
    const minted = createIdentity({ localpart: 'list-rate-noscope', scopes: [] })!;
    const address = minted.identity.address;
    const oauthToken = 'oauth-list-rate-denied-scope-32b!!';
    putAccessTokenForTests({
      token: oauthToken,
      grantId: 'g-list-rate-denied',
      address,
      aud: resolveResourceUri('http://localhost'),
      expiresAt: Date.now() + 3600_000,
      ensureGrant: { clientId: 'https://client.example/cb', clientName: 'ListRateDenied' },
    });

    const denied = await listAs(oauthToken, address);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    expect(imapConnects).toBe(0);

    const usable = rotateIdentityToken(address, ['read:messages'])!;
    expect(await admitN(usable, address, 60)).toEqual(Array(60).fill(200));
    expect((await listAs(usable, address)).status).toBe(429);
  });

  test('委托目标轮换不能重置 caller 预算；身份隔离', async () => {
    const alice = createIdentity({ localpart: 'list-rate-alice' })!;
    const bob = createIdentity({ localpart: 'list-rate-bob' })!;
    const carol = createIdentity({ localpart: 'list-rate-carol' })!;
    createDelegation({
      mailbox: alice.identity.address,
      grantee: bob.identity.address,
      createdBy: alice.identity.address,
    });
    createDelegation({
      mailbox: carol.identity.address,
      grantee: bob.identity.address,
      createdBy: carol.identity.address,
    });

    expect(await admitN(bob.token, alice.identity.address, 30)).toEqual(Array(30).fill(200));
    expect(await admitN(bob.token, carol.identity.address, 30)).toEqual(Array(30).fill(200));
    expect((await listAs(bob.token, alice.identity.address)).status).toBe(429);
    expect((await listAs(alice.token, alice.identity.address)).status).toBe(200);
  });

  test('全部 admin 凭证共享一个命名空间桶', async () => {
    expect(await admitN(ADMIN_A, 'anyone@test.example', 30)).toEqual(Array(30).fill(200));
    expect(await admitN(ADMIN_B, 'other@test.example', 30)).toEqual(Array(30).fill(200));
    expect((await listAs(ADMIN_A, 'third@test.example')).status).toBe(429);
    const minted = createIdentity({ localpart: 'list-rate-notadmin' })!;
    expect((await listAs(minted.token, minted.identity.address)).status).toBe(200);
  });

  test('invalid query / forbidden / unauthorized 保持原状态且不耗预算', async () => {
    const minted = createIdentity({ localpart: 'list-rate-acl' })!;
    const other = createIdentity({ localpart: 'list-rate-other' })!;

    const badQuery = await app.request('http://localhost/v1/messages?limit=1', {
      headers: { Authorization: `Bearer ${minted.token}` },
    });
    expect(badQuery.status).toBe(400);
    expect(((await badQuery.json()) as { error: string }).error).toBe('invalid_request');

    const forbidden = await listAs(minted.token, other.identity.address);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'forbidden: token is scoped to another address',
    });

    const unauth = await app.request(`http://localhost/v1/messages?address=${minted.identity.address}`);
    expect(unauth.status).toBe(401);

    expect(imapConnects).toBe(0);
    expect(await admitN(minted.token, minted.identity.address, 60)).toEqual(Array(60).fill(200));
  });

  test('429 零 IMAP；detail/wait 不受列表预算影响', async () => {
    const minted = createIdentity({ localpart: 'list-rate-zeroimap' })!;
    expect(await admitN(minted.token, minted.identity.address, 60)).toEqual(Array(60).fill(200));
    const connectsAfterAdmit = imapConnects;
    const searchesAfterAdmit = imapSearchCalls;

    const limited = await listAs(minted.token, minted.identity.address);
    expect(limited.status).toBe(429);
    expect(imapConnects).toBe(connectsAfterAdmit);
    expect(imapSearchCalls).toBe(searchesAfterAdmit);

    const detail = await app.request(
      `http://localhost/v1/messages/101?address=${encodeURIComponent(minted.identity.address)}`,
      { headers: { Authorization: `Bearer ${minted.token}` } },
    );
    expect(detail.status).not.toBe(429);
    expect(detail.status).toBe(404);

    const wait = await app.request('http://localhost/v1/messages/wait', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ address: minted.identity.address, timeoutSec: 1 }),
    });
    expect(wait.status).not.toBe(429);
    expect([200, 408]).toContain(wait.status);
  });

  test('下游 IMAP/游标失败已录取不退款', async () => {
    const minted = createIdentity({ localpart: 'list-rate-down' })!;
    const address = minted.identity.address;
    expect(await admitN(minted.token, address, 58)).toEqual(Array(58).fill(200));

    const tampered = `${validSince(address).split('.').slice(0, 2).join('.')}.badhmac`;
    const cursorRes = await listAs(minted.token, address, `&since=${encodeURIComponent(tampered)}`);
    expect(cursorRes.status).toBe(400);
    expect(await cursorRes.json()).toEqual({ error: 'invalid_cursor' });

    failNextSearch = true;
    const boom = await listAs(minted.token, address);
    expect(boom.status).toBe(500);

    const limited = await listAs(minted.token, address);
    expect(limited.status).toBe(429);
  });

  test('注入时钟：窗口到期恢复且 Retry-After 跟随最老活戳', async () => {
    const minted = createIdentity({ localpart: 'list-rate-clock' })!;
    const t0 = 4_000_000;
    setListMessagesNowForTests(t0);
    expect(await admitN(minted.token, minted.identity.address, 60)).toEqual(Array(60).fill(200));
    const limited = await listAs(minted.token, minted.identity.address);
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { retryAfterSec: number };
    expect(body.retryAfterSec).toBe(60);
    expect(limited.headers.get('Retry-After')).toBe('60');

    setListMessagesNowForTests(t0 + LIST_MESSAGES_WINDOW_MS);
    expect((await listAs(minted.token, minted.identity.address)).status).toBe(200);
  });

  test('生产时钟走线：墙钟双向跳动不得提前释放或冻结配额，流逝钟控制恢复', async () => {
    const minted = createIdentity({ localpart: 'list-rate-mono' })!;
    const realDateNow = Date.now;
    const realPerfNow = performance.now.bind(performance);
    let elapsed = 12_000;
    const wallBase = 1_700_000_000_000;
    try {
      Date.now = () => wallBase;
      (performance as { now: () => number }).now = () => elapsed;

      expect(await admitN(minted.token, minted.identity.address, 60)).toEqual(Array(60).fill(200));
      expect((await listAs(minted.token, minted.identity.address)).status).toBe(429);

      Date.now = () => wallBase + 3_600_000;
      expect((await listAs(minted.token, minted.identity.address)).status).toBe(429);

      Date.now = () => wallBase - 3_600_000;
      elapsed = 12_000 + 30_000;
      expect((await listAs(minted.token, minted.identity.address)).status).toBe(429);

      elapsed = 12_000 + LIST_MESSAGES_WINDOW_MS;
      expect((await listAs(minted.token, minted.identity.address)).status).toBe(200);
    } finally {
      Date.now = realDateNow;
      (performance as { now: typeof realPerfNow }).now = realPerfNow;
    }
  });

  test('restoreHarness 恢复其捕获的异种 admin/dataDir，不手写回滚', async () => {
    const foreignDir = mkdtempSync(join(tmpdir(), 'oae-list-rate-foreign-'));
    const foreignFixture = JSON.stringify([
      { address: 'keep@test.example', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    writeFileSync(join(foreignDir, 'identities.json'), foreignFixture, { mode: 0o600 });

    config.apiKeys.clear();
    config.apiKeys.add('foreign-earlier-admin-key');
    (config as { dataDir: string }).dataDir = foreignDir;
    resetOAuthStoreCacheForTests();
    const foreignSnap = snapshotHarness();

    applyScopedHarness();
    resetIdentitiesStore();
    expect(config.apiKeys.has(ADMIN_A)).toBe(true);
    const res = await listAs(ADMIN_A, 'anyone@test.example');
    expect(res.status).toBe(200);

    restoreHarness(foreignSnap);
    expect(config.dataDir).toBe(foreignDir);
    expect(readFileSync(join(foreignDir, 'identities.json'), 'utf8')).toBe(foreignFixture);
    expect([...config.apiKeys]).toEqual(['foreign-earlier-admin-key']);
    expect(config.apiKeys.has(ADMIN_A)).toBe(false);

    applyScopedHarness();
    rmSync(foreignDir, { recursive: true, force: true });
  });
});

describe('list limiter unit seams', () => {
  beforeEach(() => {
    resetRateLimits();
    resetMcpRateLimits();
    resetNotifyUserLimits();
  });

  afterEach(() => {
    resetRateLimits();
    resetMcpRateLimits();
    resetNotifyUserLimits();
    setListMessagesNowForTests(null);
  });

  test('N/N+1、精确窗口边界、命名空间键', () => {
    const key = listMessagesCallerKey({ kind: 'identity', address: 'Mix@Test.EXAMPLE' });
    expect(key).toBe('list:id:mix@test.example');
    expect(listMessagesCallerKey({ kind: 'admin' })).toBe('list:admin');

    const t0 = 8_000_000;
    for (let i = 0; i < LIST_MESSAGES_LIMIT; i++) {
      expect(checkListMessagesLimit(key, t0).allowed).toBe(true);
    }
    const blocked = checkListMessagesLimit(key, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);

    expect(checkListMessagesLimit(key, t0 + LIST_MESSAGES_WINDOW_MS).allowed).toBe(true);
  });

  test('新 key 满图保守 60s；不驱逐活桶；过期桶可回收', () => {
    const now = 9_000_000;
    for (let i = 0; i < LIST_MESSAGES_MAX_BUCKETS; i++) {
      seedListMessagesBucketForTests(`list:id:cap-${i}@test.example`, [now]);
    }
    expect(listMessagesBucketCountForTests()).toBe(LIST_MESSAGES_MAX_BUCKETS);

    const full = checkListMessagesLimit('list:id:newcomer@test.example', now);
    expect(full.allowed).toBe(false);
    expect(full.retryAfterSec).toBe(LIST_MESSAGES_CAPACITY_RETRY_SEC);
    expect(listMessagesHasBucketForTests('list:id:cap-1@test.example')).toBe(true);
    expect(listMessagesBucketCountForTests()).toBe(LIST_MESSAGES_MAX_BUCKETS);

    const existing = checkListMessagesLimit('list:id:cap-0@test.example', now);
    expect(existing.allowed).toBe(true);

    resetListMessagesLimits();
    const liveKey = 'list:id:live@test.example';
    for (let i = 0; i < LIST_MESSAGES_MAX_BUCKETS - 1; i++) {
      seedListMessagesBucketForTests(`list:id:expired-${i}@test.example`, [now - LIST_MESSAGES_WINDOW_MS]);
    }
    seedListMessagesBucketForTests(liveKey, [now]);
    expect(listMessagesBucketCountForTests()).toBe(LIST_MESSAGES_MAX_BUCKETS);
    const admitted = checkListMessagesLimit('list:id:after-reclaim@test.example', now);
    expect(admitted.allowed).toBe(true);
    expect(listMessagesHasBucketForTests(liveKey)).toBe(true);
    expect(listMessagesHasBucketForTests('list:id:expired-0@test.example')).toBe(false);
  });

  test('send/MCP 桶互不占额', () => {
    expect(checkSendLimit('a@test.example', 1, 60_000, 10_000).allowed).toBe(true);
    expect(checkSendLimit('a@test.example', 1, 60_000, 10_000).allowed).toBe(false);
    expect(checkMcpRateLimit('g-list', 'read', 1, 60_000, 10_000).allowed).toBe(true);
    expect(checkListMessagesLimit('list:id:a@test.example', 10_000).allowed).toBe(true);
    expect(checkListMessagesLimit('list:id:a@test.example', 10_000).allowed).toBe(true);
  });
});
