/**
 * #235 第 1/3：deleteIdentity 级联清理完整地址 agents 键 + reader pending_revoke 对账。
 * 含 R2 返工：串行化 writeServerConfig、reconcile 差集、isState 校验、purge 回滚、boot fixture、禁用不物化。
 */
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-notify-cascade-'));
process.env.NOTIFY_PUBLIC_URL = 'https://notify.test';
// 不在模块顶置 NTFY_ENABLED：避免抢先 import config 时把全套件默认改成 true，
// 污染 oauth-as 同意页建身份（会走 provision → 无 mock 则 400）。
process.env.NTFY_ADMIN_PASSWORD = 'ntfy-admin-secret';

const { afterEach, beforeEach, describe, expect, test } = await import('bun:test');
const { config } = await import('../src/lib/config.ts');
const { createIdentity, deleteIdentity, findIdentity } = await import('../src/lib/identities.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const {
  flushWriteServerConfigForTests,
  getNotificationAgentRouteForTests,
  getPendingReaderRevokesForTests,
  initializeNotifications,
  NtfyNotificationService,
  provisionIdentityNotifications,
  purgeOrphanFullAddressAgentRoutes,
  reconcilePendingReaderRevokes,
  removeAgentRouteOnIdentityDelete,
  resetNotificationStateForTests,
  setNotificationAgentRouteForTests,
  setNotifyPasswordHashForTests,
  setSyncCascadeCommitForTests,
  setWriteServerConfigObserverForTests,
} = await import('../src/lib/notify.ts');

const originalFetch = globalThis.fetch;
const previousNtfy = { ...config.ntfy };

/** 清掉 notifications.json，避免 pending/agents 跨用例串扰。 */
function wipeNotificationStore(): void {
  resetNotificationStateForTests();
  const path = join(dirname(config.ntfy.configPath), 'notifications.json');
  if (existsSync(path)) unlinkSync(path);
  resetNotificationStateForTests();
}

function notificationStorePath(): string {
  return join(dirname(config.ntfy.configPath), 'notifications.json');
}

/** provision / publish 用的最小 ntfy admin mock。 */
function mockNtfyOk(onPublish?: (topic: string) => void): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.includes('/v1/account/token')) {
      return new Response(JSON.stringify({ token: 'tk_provisioned123456789012345678901' }), {
        status: 200,
      });
    }
    if (method === 'POST' && onPublish && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { topic?: string };
        if (body.topic) onPublish(body.topic);
      } catch {
        /* ignore */
      }
    }
    return new Response(method === 'POST' && !url.includes('/v1/') ? '{"id":"ok"}' : '', {
      status: 200,
    });
  }) as typeof fetch;
}

beforeEach(() => {
  setNotifyPasswordHashForTests(async () => '$2b$10$cascade-test-hash.................');
  setSyncCascadeCommitForTests(null);
  setWriteServerConfigObserverForTests(null);
  Object.assign(config.ntfy, {
    enabled: true,
    adminPassword: 'ntfy-admin-secret',
    publicUrl: 'https://notify.test',
    configPath: join(process.env.DATA_DIR!, 'ntfy', 'server.yml'),
  });
  wipeNotificationStore();
  resetAuditForTests();
});

afterEach(async () => {
  await flushWriteServerConfigForTests();
  globalThis.fetch = originalFetch;
  setNotifyPasswordHashForTests(null);
  setSyncCascadeCommitForTests(null);
  setWriteServerConfigObserverForTests(null);
  wipeNotificationStore();
  // 强制关 ntfy，避免抢先加载本文件时把全套件 enabled 留 true。
  Object.assign(config.ntfy, previousNtfy, { enabled: false });
});

describe('#235 deleteIdentity notify route cascade', () => {
  test('1. deleteIdentity 删完整地址键 + pending_revoke + audit；解析 unknown_agent', async () => {
    const created = createIdentity({ localpart: 'cascade-one' })!;
    const address = created.identity.address;
    setNotificationAgentRouteForTests(address, {
      topic: 'agent-cascade-one-old',
      reader: {
        username: 'reader-cascade-one',
        token: 'tk_cascadeone123456789012345678901',
      },
    });

    expect(deleteIdentity(address)).toBe(true);
    expect(findIdentity(address)).toBeUndefined();
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();

    const pending = getPendingReaderRevokesForTests();
    expect(pending).toEqual([
      expect.objectContaining({
        username: 'reader-cascade-one',
        address,
        status: 'pending_revoke',
      }),
    ]);

    const audit = readAuditEvents({ event: 'identity.notify_route.delete' }).find(
      (e) => e.address === address,
    );
    expect(audit).toMatchObject({
      event: 'identity.notify_route.delete',
      outcome: 'ok',
      address,
      actor: 'deleteIdentity',
    });

    const svc = new NtfyNotificationService();
    await expect(
      svc.publish({
        target: `agent:${address}`,
        title: 'x',
        message: 'must miss',
        level: 'normal',
      }),
    ).rejects.toMatchObject({ code: 'unknown_agent' });
  });

  test('2. 同址重建 → 新 topic/reader；旧 topic 不再被解析', async () => {
    const created = createIdentity({ localpart: 'cascade-rebuild' })!;
    const address = created.identity.address;
    const oldTopic = 'agent-cascade-rebuild-OLD';
    const oldReader = 'reader-cascade-rebuild-old';
    setNotificationAgentRouteForTests(address, {
      topic: oldTopic,
      reader: {
        username: oldReader,
        token: 'tk_cascaderebuildold123456789012345',
      },
    });

    expect(deleteIdentity(address)).toBe(true);
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();

    mockNtfyOk();
    const again = createIdentity({ localpart: 'cascade-rebuild' })!;
    await provisionIdentityNotifications(again.identity);

    const fresh = getNotificationAgentRouteForTests(address);
    expect(fresh).toBeDefined();
    expect(fresh!.topic).not.toBe(oldTopic);
    expect(fresh!.reader.username).not.toBe(oldReader);

    // 旧 topic 无路由入口：publish 走新 topic，物理隔离 12h 缓存。
    const published: string[] = [];
    mockNtfyOk((topic) => published.push(topic));
    const svc = new NtfyNotificationService();
    await svc.publish({
      target: `agent:${address}`,
      title: 'new',
      message: 'fresh route',
      level: 'normal',
    });
    expect(published.some((t) => t === oldTopic)).toBe(false);
    expect(published.some((t) => t === fresh!.topic)).toBe(true);

    deleteIdentity(address);
  });

  test('3. reconcile 三分类：2xx→出队；40031→出队；5xx→留 pending', async () => {
    setNotificationAgentRouteForTests('ghost@test.example', {
      topic: 'agent-ghost-recon',
      reader: {
        username: 'reader-recon-a',
        token: 'tk_reconaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost@test.example');
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-recon-a']);

    // transient 5xx：留 pending
    await reconcilePendingReaderRevokes(async () => 'transient');
    expect(getPendingReaderRevokesForTests()).toHaveLength(1);

    // not_found 收敛
    await reconcilePendingReaderRevokes(async () => 'not_found');
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);

    // 再入队，2xx deleted 收敛
    setNotificationAgentRouteForTests('ghost2@test.example', {
      topic: 'agent-ghost2',
      reader: {
        username: 'reader-recon-b',
        token: 'tk_reconbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost2@test.example');
    await reconcilePendingReaderRevokes(async () => 'deleted');
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);

    // mock fetch 分类：40031 / 5xx
    setNotificationAgentRouteForTests('ghost3@test.example', {
      topic: 'agent-ghost3',
      reader: {
        username: 'reader-recon-c',
        token: 'tk_reconccccccccccccccccccccccccc',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost3@test.example');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: 40031, error: 'invalid request: user does not exist' }),
        { status: 400 },
      )) as typeof fetch;
    await reconcilePendingReaderRevokes();
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);

    setNotificationAgentRouteForTests('ghost4@test.example', {
      topic: 'agent-ghost4',
      reader: {
        username: 'reader-recon-d',
        token: 'tk_reconddddddddddddddddddddddddd',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost4@test.example');
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    await reconcilePendingReaderRevokes();
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-recon-d']);
  });

  test('3b. reconcile 迭代间隙新入队不丢行（差集合并）', async () => {
    setNotificationAgentRouteForTests('gap-a@test.example', {
      topic: 'agent-gap-a',
      reader: { username: 'reader-gap-a', token: 'tk_gapaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    setNotificationAgentRouteForTests('gap-b@test.example', {
      topic: 'agent-gap-b',
      reader: { username: 'reader-gap-b', token: 'tk_gapbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    removeAgentRouteOnIdentityDelete('gap-a@test.example');
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-gap-a']);

    await reconcilePendingReaderRevokes(async (username) => {
      if (username === 'reader-gap-a') {
        // 迭代间隙：新删入队，旧实现整体覆盖会抹掉 reader-gap-b
        removeAgentRouteOnIdentityDelete('gap-b@test.example');
        return 'deleted';
      }
      return 'deleted';
    });

    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-gap-b']);
  });

  test('4. 负控：他址键保留；裸 localpart 键不碰', () => {
    const a = createIdentity({ localpart: 'keep-a' })!;
    const b = createIdentity({ localpart: 'keep-b' })!;
    const addrA = a.identity.address;
    const addrB = b.identity.address;

    setNotificationAgentRouteForTests(addrA, {
      topic: 'agent-keep-a',
      reader: { username: 'reader-keep-a', token: 'tk_keepaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    setNotificationAgentRouteForTests(addrB, {
      topic: 'agent-keep-b',
      reader: { username: 'reader-keep-b', token: 'tk_keepbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    setNotificationAgentRouteForTests('barelocal', {
      topic: 'agent-bare-stale',
      reader: { username: 'reader-bare', token: 'tk_barecccccccccccccccccccccccccc' },
      ownerAddress: addrA,
    });

    expect(deleteIdentity(addrA)).toBe(true);
    expect(getNotificationAgentRouteForTests(addrA)).toBeUndefined();
    expect(getNotificationAgentRouteForTests(addrB)?.topic).toBe('agent-keep-b');
    expect(getNotificationAgentRouteForTests('barelocal')?.topic).toBe('agent-bare-stale');
    expect(getNotificationAgentRouteForTests('barelocal')?.ownerAddress).toBe(addrA);

    deleteIdentity(addrB);
  });

  test('5. 级联 fail-closed：state 持久化失败 → 抛错且身份仍在', () => {
    const created = createIdentity({ localpart: 'fail-closed' })!;
    const address = created.identity.address;
    setNotificationAgentRouteForTests(address, {
      topic: 'agent-fail-closed',
      reader: {
        username: 'reader-fail-closed',
        token: 'tk_failclosed123456789012345678901',
      },
    });

    setSyncCascadeCommitForTests((_writeConfig, _save) => {
      throw new Error('notification_store_persist_failed');
    });

    expect(() => deleteIdentity(address)).toThrow('notification_store_persist_failed');
    expect(findIdentity(address)).toBeDefined();
    // 内存键回滚，外泄通道记录仍在，可重试
    expect(getNotificationAgentRouteForTests(address)?.topic).toBe('agent-fail-closed');
    expect(
      getPendingReaderRevokesForTests().every((r) => r.username !== 'reader-fail-closed'),
    ).toBe(true);

    setSyncCascadeCommitForTests(null);
    expect(deleteIdentity(address)).toBe(true);
    expect(findIdentity(address)).toBeUndefined();
  });

  test('6. boot reconcile 独立 fixture：只调 initializeNotifications 清幽灵', async () => {
    const live = createIdentity({ localpart: 'live-boot' })!;
    const liveAddr = live.identity.address;

    setNotificationAgentRouteForTests(liveAddr, {
      topic: 'agent-live-boot',
      reader: { username: 'reader-live-boot', token: 'tk_liveboot1234567890123456789012' },
    });
    setNotificationAgentRouteForTests('ghost-boot@test.example', {
      topic: 'agent-ghost-boot',
      reader: {
        username: 'reader-ghost-boot',
        token: 'tk_ghostboot123456789012345678901',
      },
    });
    setNotificationAgentRouteForTests('bareboot', {
      topic: 'agent-bare-boot',
      reader: { username: 'reader-bare-boot', token: 'tk_bareboot1234567890123456789012' },
      ownerAddress: liveAddr,
    });

    mockNtfyOk();
    // 不直调 purge：删掉 boot 挂点则本断言必红。
    await initializeNotifications();

    expect(getNotificationAgentRouteForTests('ghost-boot@test.example')).toBeUndefined();
    expect(getNotificationAgentRouteForTests(liveAddr)).toBeDefined();
    expect(getNotificationAgentRouteForTests('bareboot')?.topic).toBe('agent-bare-boot');

    const audit = readAuditEvents({ event: 'identity.notify_route.delete' }).find(
      (e) => e.address === 'ghost-boot@test.example',
    );
    expect(audit?.actor).toBe('boot_reconcile');

    deleteIdentity(liveAddr);
  });

  test('6b. purge save 失败回滚且不发 audit', () => {
    setNotificationAgentRouteForTests('ghost-rollback@test.example', {
      topic: 'agent-ghost-rollback',
      reader: {
        username: 'reader-ghost-rollback',
        token: 'tk_ghostrollback12345678901234567',
      },
    });

    setSyncCascadeCommitForTests(() => {
      throw new Error('purge_persist_failed');
    });

    expect(() => purgeOrphanFullAddressAgentRoutes('boot_reconcile')).toThrow(
      'purge_persist_failed',
    );
    expect(getNotificationAgentRouteForTests('ghost-rollback@test.example')?.topic).toBe(
      'agent-ghost-rollback',
    );
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);
    expect(
      readAuditEvents({ event: 'identity.notify_route.delete' }).some(
        (e) => e.address === 'ghost-rollback@test.example',
      ),
    ).toBe(false);
  });

  test('7. writeServerConfig 串行化：后写覆盖先写，终态无幽灵 reader', async () => {
    const a = createIdentity({ localpart: 'serial-a' })!;
    const b = createIdentity({ localpart: 'serial-b' })!;
    const addrA = a.identity.address;
    const addrB = b.identity.address;
    setNotificationAgentRouteForTests(addrA, {
      topic: 'agent-serial-a',
      reader: { username: 'reader-serial-a', token: 'tk_serialaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    setNotificationAgentRouteForTests(addrB, {
      topic: 'agent-serial-b',
      reader: { username: 'reader-serial-b', token: 'tk_serialbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });

    const snapshots: string[][] = [];
    setWriteServerConfigObserverForTests((keys) => snapshots.push([...keys]));

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let blockedOnce = false;
    setNotifyPasswordHashForTests(async () => {
      if (!blockedOnce) {
        blockedOnce = true;
        await gate;
      }
      return '$2b$10$cascade-serial-hash...............';
    });

    deleteIdentity(addrA);
    // 等首写进入哈希闸门（observer 已拍快照）
    for (let i = 0; i < 50 && snapshots.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    deleteIdentity(addrB);
    release();
    await flushWriteServerConfigForTests();

    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    const last = snapshots[snapshots.length - 1]!;
    expect(last).not.toContain(addrA);
    expect(last).not.toContain(addrB);

    const yml = readFileSync(config.ntfy.configPath, 'utf8');
    expect(yml).not.toContain('reader-serial-a');
    expect(yml).not.toContain('reader-serial-b');
  });

  test('8. isState 拒收非法 pendingReaderRevokes（corrupt 口径）', () => {
    setNotificationAgentRouteForTests('shape@test.example', {
      topic: 'agent-shape',
      reader: { username: 'reader-shape', token: 'tk_shapeaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    // 落盘后破坏 pending 行形状
    resetNotificationStateForTests();
    const path = notificationStorePath();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    parsed.pendingReaderRevokes = [{ length: 1 }];
    writeFileSync(path, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    resetNotificationStateForTests();

    expect(() => getPendingReaderRevokesForTests()).toThrow('notification_store_corrupt');
  });

  test('9. ntfy 未启用：deleteIdentity 不物化 notifications.json', () => {
    Object.assign(config.ntfy, { enabled: false });
    wipeNotificationStore();
    expect(existsSync(notificationStorePath())).toBe(false);

    const created = createIdentity({ localpart: 'ntfy-off' })!;
    expect(deleteIdentity(created.identity.address)).toBe(true);
    expect(existsSync(notificationStorePath())).toBe(false);
  });

  test('mutation：删键步骤缺失则键残留（对照必红逻辑）', () => {
    // 文档化 mutation 意图：若去掉 removeAgentRouteOnIdentityDelete，本断言会红。
    const created = createIdentity({ localpart: 'mutation-probe' })!;
    const address = created.identity.address;
    setNotificationAgentRouteForTests(address, {
      topic: 'agent-mutation',
      reader: { username: 'reader-mutation', token: 'tk_mutation1234567890123456789012' },
    });
    deleteIdentity(address);
    // 有删键步骤 → 必须 undefined；无则残留 topic（mutation 红灯）。
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();
  });
});
