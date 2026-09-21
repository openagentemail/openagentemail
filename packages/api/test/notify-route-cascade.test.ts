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
  isWriteServerConfigIdleForTests,
  NtfyNotificationService,
  provisionIdentityNotifications,
  purgeOrphanFullAddressAgentRoutes,
  reconcilePendingReaderRevokes,
  removeAgentRouteOnIdentityDelete,
  resetNotificationStateForTests,
  setAfterCreateRuntimeReaderForTests,
  setNotificationAgentRouteForTests,
  setNotifyPasswordHashForTests,
  setOnReaderRevokeReconcileRunForTests,
  setReaderRevokeReconcileBudgetForTests,
  setReaderRevokeReconcileMaxRowsForTests,
  setSyncCascadeCommitForTests,
  setWriteServerConfigObserverForTests,
  whenReaderRevokeReconcileIdleForTests,
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

/** provision / publish / admin DELETE 用的最小 ntfy mock。 */
function mockNtfyOk(options?: {
  onPublish?: (topic: string) => void;
  onDelete?: (username: string) => void;
}): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'DELETE' && url.includes('/v1/users')) {
      let username = '';
      if (typeof init?.body === 'string') {
        try {
          username = String((JSON.parse(init.body) as { username?: string }).username ?? '');
        } catch {
          username = '';
        }
      }
      options?.onDelete?.(username);
      return new Response('', { status: 200 });
    }
    if (method === 'POST' && url.includes('/v1/account/token')) {
      return new Response(JSON.stringify({ token: `tk_${cryptoRandomToken()}` }), {
        status: 200,
      });
    }
    if (method === 'POST' && options?.onPublish && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { topic?: string };
        if (body.topic) options.onPublish(body.topic);
      } catch {
        /* ignore */
      }
    }
    return new Response(method === 'POST' && !url.includes('/v1/') ? '{"id":"ok"}' : '', {
      status: 200,
    });
  }) as typeof fetch;
}

/** 测试用随机 token 后缀，避免同址重建两次 provision 撞同一 mock token。 */
function cryptoRandomToken(): string {
  return Array.from({ length: 29 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]!).join('');
}

beforeEach(() => {
  setNotifyPasswordHashForTests(async () => '$2b$10$cascade-test-hash.................');
  setSyncCascadeCommitForTests(null);
  setWriteServerConfigObserverForTests(null);
  setAfterCreateRuntimeReaderForTests(null);
  setReaderRevokeReconcileBudgetForTests(null);
  setReaderRevokeReconcileMaxRowsForTests(null);
  setOnReaderRevokeReconcileRunForTests(null);
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
  await whenReaderRevokeReconcileIdleForTests();
  await flushWriteServerConfigForTests();
  globalThis.fetch = originalFetch;
  setNotifyPasswordHashForTests(null);
  setSyncCascadeCommitForTests(null);
  setWriteServerConfigObserverForTests(null);
  setAfterCreateRuntimeReaderForTests(null);
  setReaderRevokeReconcileBudgetForTests(null);
  setReaderRevokeReconcileMaxRowsForTests(null);
  setOnReaderRevokeReconcileRunForTests(null);
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

  test('2. 同址重建：topic 确定性相同 + 新 reader + 首次吊销 DELETE（禁人工旧 topic fixture）', async () => {
    const deletedUsers: string[] = [];
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((r) => {
      releaseDelete = r;
    });

    // DELETE 闸门：先让同步路径断言 pending，再放行首次吊销收敛
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE' && url.includes('/v1/users')) {
        let username = '';
        if (typeof init?.body === 'string') {
          try {
            username = String((JSON.parse(init.body) as { username?: string }).username ?? '');
          } catch {
            username = '';
          }
        }
        deletedUsers.push(username);
        await deleteGate;
        return new Response('', { status: 200 });
      }
      if (method === 'POST' && url.includes('/v1/account/token')) {
        return new Response(JSON.stringify({ token: `tk_${cryptoRandomToken()}` }), {
          status: 200,
        });
      }
      return new Response(method === 'POST' && !url.includes('/v1/') ? '{"id":"ok"}' : '', {
        status: 200,
      });
    }) as typeof fetch;

    // 真实 provision，不用 setNotificationAgentRouteForTests 伪造旧 topic
    const created = createIdentity({ localpart: 'cascade-rebuild' })!;
    const address = created.identity.address;
    await provisionIdentityNotifications(created.identity);
    const old = getNotificationAgentRouteForTests(address);
    expect(old).toBeDefined();
    const oldTopic = old!.topic;
    const oldToken = old!.reader.token;
    const oldUser = old!.reader.username;

    expect(deleteIdentity(address)).toBe(true);
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();
    // 同步返回后、DELETE 闸门未放行：旧 reader 必在 pending_revoke
    expect(getPendingReaderRevokesForTests().some((r) => r.username === oldUser)).toBe(true);
    // 首次吊销已触发（fetch 已入队，username 已记录）
    for (let i = 0; i < 80 && !deletedUsers.includes(oldUser); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deletedUsers).toContain(oldUser);

    await flushWriteServerConfigForTests();
    // server.yml 重写不含旧 reader 的 auth-tokens / auth-access 声明
    const yml = readFileSync(config.ntfy.configPath, 'utf8');
    expect(yml).not.toContain(oldUser);

    releaseDelete();
    // 等首次吊销收敛出队
    for (let i = 0; i < 80 && getPendingReaderRevokesForTests().some((r) => r.username === oldUser); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // 同址重建走真实 provision：topic 确定性派生相同，reader 凭据换新
    mockNtfyOk({ onDelete: (u) => deletedUsers.push(u) });
    const again = createIdentity({ localpart: 'cascade-rebuild' })!;
    await provisionIdentityNotifications(again.identity);
    const fresh = getNotificationAgentRouteForTests(address);
    expect(fresh).toBeDefined();
    expect(fresh!.topic).toBe(oldTopic);
    expect(fresh!.reader.token).not.toBe(oldToken);
    expect(fresh!.reader.username).not.toBe(oldUser);

    deleteIdentity(address);
    await flushWriteServerConfigForTests();
  });

  test('3. reconcile 三分类：2xx→出队；40031→出队；5xx→留 pending', async () => {
    // 默认 503：remove 触发的首次吊销留 pending，由本测显式控制收敛
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;

    setNotificationAgentRouteForTests('ghost@test.example', {
      topic: 'agent-ghost-recon',
      reader: {
        username: 'reader-recon-a',
        token: 'tk_reconaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost@test.example');
    await whenReaderRevokeReconcileIdleForTests();
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
    await whenReaderRevokeReconcileIdleForTests();
    await reconcilePendingReaderRevokes(async () => 'deleted');
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);

    // 40031：先设 fetch 再 remove，首次吊销即 not_found 收敛
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: 40031, error: 'invalid request: user does not exist' }),
        { status: 400 },
      )) as typeof fetch;
    setNotificationAgentRouteForTests('ghost3@test.example', {
      topic: 'agent-ghost3',
      reader: {
        username: 'reader-recon-c',
        token: 'tk_reconccccccccccccccccccccccccc',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost3@test.example');
    for (let i = 0; i < 40 && getPendingReaderRevokesForTests().length > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(getPendingReaderRevokesForTests()).toHaveLength(0);

    // 5xx：首次吊销 transient，pending 保留
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    setNotificationAgentRouteForTests('ghost4@test.example', {
      topic: 'agent-ghost4',
      reader: {
        username: 'reader-recon-d',
        token: 'tk_reconddddddddddddddddddddddddd',
      },
    });
    removeAgentRouteOnIdentityDelete('ghost4@test.example');
    await new Promise((r) => setTimeout(r, 20));
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-recon-d']);
  });

  test('3b. reconcile 迭代间隙新入队不丢行（差集合并）', async () => {
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;

    setNotificationAgentRouteForTests('gap-a@test.example', {
      topic: 'agent-gap-a',
      reader: { username: 'reader-gap-a', token: 'tk_gapaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    setNotificationAgentRouteForTests('gap-b@test.example', {
      topic: 'agent-gap-b',
      reader: { username: 'reader-gap-b', token: 'tk_gapbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    removeAgentRouteOnIdentityDelete('gap-a@test.example');
    await whenReaderRevokeReconcileIdleForTests();
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-gap-a']);

    await reconcilePendingReaderRevokes(async (username) => {
      if (username === 'reader-gap-a') {
        // 迭代间隙：新删入队（会 again 重跑）；差集不得抹掉 B
        removeAgentRouteOnIdentityDelete('gap-b@test.example');
        return 'deleted';
      }
      // again 轮开到 B：留 transient，断言 B 仍在队（非被整体覆盖丢掉）
      return 'transient';
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

    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const last = snapshots[snapshots.length - 1]!;
    expect(last).not.toContain(addrA);
    expect(last).not.toContain(addrB);

    const yml = readFileSync(config.ntfy.configPath, 'utf8');
    expect(yml).not.toContain('reader-serial-a');
    expect(yml).not.toContain('reader-serial-b');
  });

  test('7b. writeServerConfig coalesce：连续触发实际重写次数 < 触发次数且终态正确', async () => {
    const ids = ['coa-a', 'coa-b', 'coa-c', 'coa-d'].map((lp) => createIdentity({ localpart: lp })!);
    for (const row of ids) {
      setNotificationAgentRouteForTests(row.identity.address, {
        topic: `agent-${row.identity.address.split('@')[0]}`,
        reader: {
          username: `reader-${row.identity.address.split('@')[0]}`,
          token: `tk_${row.identity.address.split('@')[0]}1234567890123456789012`.slice(0, 32),
        },
      });
    }

    let writes = 0;
    setWriteServerConfigObserverForTests(() => {
      writes += 1;
    });
    // 慢哈希拉长单次写窗口，便于后续删除 coalesce 进同一 drain
    setNotifyPasswordHashForTests(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return '$2b$10$cascade-coalesce-hash.............';
    });

    const triggers = ids.length;
    for (const row of ids) {
      deleteIdentity(row.identity.address);
    }
    await flushWriteServerConfigForTests();

    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThan(triggers);
    const yml = readFileSync(config.ntfy.configPath, 'utf8');
    for (const lp of ['coa-a', 'coa-b', 'coa-c', 'coa-d']) {
      expect(yml).not.toContain(`reader-${lp}`);
    }
  });

  test('7c. writeServerConfig drain 拒绝：无 unhandledrejection 且队列可再入', async () => {
    const created = createIdentity({ localpart: 'drain-rej' })!;
    const address = created.identity.address;
    setNotificationAgentRouteForTests(address, {
      topic: 'agent-drain-rej',
      reader: {
        username: 'reader-drain-rej',
        token: 'tk_drainrej1234567890123456789012',
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      // 首次重写在哈希阶段失败 → drain 拒绝
      setNotifyPasswordHashForTests(async () => {
        throw new Error('password_hash_boom');
      });
      expect(deleteIdentity(address)).toBe(true);
      await flushWriteServerConfigForTests();
      // 给 finally/.catch 微任务一轮时间
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(isWriteServerConfigIdleForTests()).toBe(true);

      // 后续写仍可排队并成功落盘
      const again = createIdentity({ localpart: 'drain-ok' })!;
      const addrOk = again.identity.address;
      setNotificationAgentRouteForTests(addrOk, {
        topic: 'agent-drain-ok',
        reader: {
          username: 'reader-drain-ok',
          token: 'tk_drainok12345678901234567890123',
        },
      });
      setNotifyPasswordHashForTests(async () => '$2b$10$cascade-drain-ok-hash............');
      expect(deleteIdentity(addrOk)).toBe(true);
      await flushWriteServerConfigForTests();
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toEqual([]);
      expect(isWriteServerConfigIdleForTests()).toBe(true);
      const yml = readFileSync(config.ntfy.configPath, 'utf8');
      expect(yml).not.toContain('reader-drain-ok');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // #278：生成器写出 >1024 listen-http，配合 compose 非 root。
  // 部署面锁步：compose 显式 NTFY_INTERNAL_URL=http://ntfy:2587；config 缺省同为 :2587（R3 bare 自洽）。
  // （显式 env 仍覆盖。grep/关系见 materials/278/completion.md）。
  test('7d. writeServerConfig 生成 listen-http :2587（#278 去 root）', async () => {
    mockNtfyOk();
    await initializeNotifications();
    await flushWriteServerConfigForTests();
    const yml = readFileSync(config.ntfy.configPath, 'utf8');
    expect(yml).toContain('listen-http: ":2587"');
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

  test('9. ntfy 未启用且无既有 store：deleteIdentity 不物化 notifications.json', () => {
    Object.assign(config.ntfy, { enabled: false });
    wipeNotificationStore();
    expect(existsSync(notificationStorePath())).toBe(false);

    const created = createIdentity({ localpart: 'ntfy-off' })!;
    expect(deleteIdentity(created.identity.address)).toBe(true);
    expect(existsSync(notificationStorePath())).toBe(false);
  });

  test('9b. #249-① 禁用窗有既有路由：级联入 pending 落盘，不发 DELETE', async () => {
    const deletedUsers: string[] = [];
    mockNtfyOk({ onDelete: (u) => deletedUsers.push(u) });

    const created = createIdentity({ localpart: 'ntfy-off-queued' })!;
    const address = created.identity.address;
    setNotificationAgentRouteForTests(address, {
      topic: 'agent-ntfy-off-queued',
      reader: {
        username: 'reader-ntfy-off-queued',
        token: 'tk_ntfyoffqueued1234567890123456',
      },
    });

    Object.assign(config.ntfy, { enabled: false });
    expect(deleteIdentity(address)).toBe(true);
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();
    expect(getPendingReaderRevokesForTests().some((r) => r.username === 'reader-ntfy-off-queued')).toBe(
      true,
    );
    // 禁用窗不发 live DELETE
    expect(deletedUsers).not.toContain('reader-ntfy-off-queued');
    expect(existsSync(notificationStorePath())).toBe(true);
  });

  test('9c. #249-⑥ 无 adminPassword：首次吊销不发 DELETE，行留 pending', async () => {
    const deletedUsers: string[] = [];
    mockNtfyOk({ onDelete: (u) => deletedUsers.push(u) });

    setNotificationAgentRouteForTests('nopw@test.example', {
      topic: 'agent-nopw',
      reader: { username: 'reader-nopw', token: 'tk_nopwaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    Object.assign(config.ntfy, { adminPassword: undefined });
    removeAgentRouteOnIdentityDelete('nopw@test.example');
    await whenReaderRevokeReconcileIdleForTests();

    expect(deletedUsers).toEqual([]);
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toContain('reader-nopw');
  });

  test('10. reconcile 整体预算：慢响应超预算则提前停，confirmed 收敛、剩余留队', async () => {
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    // 先入队 4 行；时间预算极紧 + 每行慢，使得开不完
    setReaderRevokeReconcileBudgetForTests(30);
    setReaderRevokeReconcileMaxRowsForTests(100);

    for (const id of ['bud-a', 'bud-b', 'bud-c', 'bud-d']) {
      setNotificationAgentRouteForTests(`${id}@test.example`, {
        topic: `agent-${id}`,
        reader: { username: `reader-${id}`, token: `tk_${id}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 32) },
      });
      removeAgentRouteOnIdentityDelete(`${id}@test.example`);
    }
    await whenReaderRevokeReconcileIdleForTests();

    const started: string[] = [];
    await reconcilePendingReaderRevokes(async (username) => {
      started.push(username);
      await new Promise((r) => setTimeout(r, 25));
      // 前两行收敛，后面若被开到也收敛——预算应使 started < 4
      return 'deleted';
    });

    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(4);
    const pending = getPendingReaderRevokesForTests().map((r) => r.username);
    // 已 confirmed 出队；未开行仍在队
    for (const u of started) {
      expect(pending).not.toContain(u);
    }
    expect(pending.length).toBe(4 - started.length);
  });

  test('12a. reconcile 轮换公平：maxRows=1 队首 transient 不饿死后续行', async () => {
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;

    for (const id of ['rot-a', 'rot-b']) {
      setNotificationAgentRouteForTests(`${id}@test.example`, {
        topic: `agent-${id}`,
        reader: {
          username: `reader-${id}`,
          token: `tk_${id}aaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 32),
        },
      });
      removeAgentRouteOnIdentityDelete(`${id}@test.example`);
    }
    for (let i = 0; i < 40 && getPendingReaderRevokesForTests().length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await whenReaderRevokeReconcileIdleForTests();
    const before = getPendingReaderRevokesForTests().map((r) => r.username);
    expect(before).toHaveLength(2);
    expect(new Set(before)).toEqual(new Set(['reader-rot-a', 'reader-rot-b']));
    const [head, next] = before;

    setReaderRevokeReconcileMaxRowsForTests(1);
    // 第1轮：只开队首 → transient → 落盘 [next, head]（confirmed 空仍 save）
    await reconcilePendingReaderRevokes(async (username) => {
      expect(username).toBe(head);
      return 'transient';
    });
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual([next, head]);
    // c. 磁盘 pendingReaderRevokes 顺序已变
    const disk = JSON.parse(readFileSync(notificationStorePath(), 'utf8')) as {
      pendingReaderRevokes?: Array<{ username: string }>;
    };
    expect(disk.pendingReaderRevokes?.map((r) => r.username)).toEqual([next, head]);

    // 第2轮：首先 DELETE 新队首 → deleted → 收敛后剩原 head
    await whenReaderRevokeReconcileIdleForTests();
    const started: string[] = [];
    await reconcilePendingReaderRevokes(async (username) => {
      started.push(username);
      if (username === next) return 'deleted';
      return 'transient';
    });
    expect(started[0]).toBe(next);
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual([head]);
  });

  test('12b. reconcile 轮换公平：时间预算只够 1 行时同样轮换', async () => {
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;

    for (const id of ['trot-a', 'trot-b']) {
      setNotificationAgentRouteForTests(`${id}@test.example`, {
        topic: `agent-${id}`,
        reader: {
          username: `reader-${id}`,
          token: `tk_${id}bbbbbbbbbbbbbbbbbbbbbbbbbbbb`.slice(0, 32),
        },
      });
      removeAgentRouteOnIdentityDelete(`${id}@test.example`);
    }
    for (let i = 0; i < 40 && getPendingReaderRevokesForTests().length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await whenReaderRevokeReconcileIdleForTests();
    const before = getPendingReaderRevokesForTests().map((r) => r.username);
    expect(before).toHaveLength(2);
    expect(new Set(before)).toEqual(new Set(['reader-trot-a', 'reader-trot-b']));
    const [head, next] = before;

    setReaderRevokeReconcileMaxRowsForTests(100);
    // 时间预算只够 1 行慢 DELETE
    setReaderRevokeReconcileBudgetForTests(20);
    await reconcilePendingReaderRevokes(async (username) => {
      expect(username).toBe(head);
      await new Promise((r) => setTimeout(r, 30));
      return 'transient';
    });
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual([next, head]);
    const disk = JSON.parse(readFileSync(notificationStorePath(), 'utf8')) as {
      pendingReaderRevokes?: Array<{ username: string }>;
    };
    expect(disk.pendingReaderRevokes?.map((r) => r.username)).toEqual([next, head]);
  });

  test('12c. reconcile 并发合并：连发 3 次 ≤2 轮且全 resolve；重跑处理间隙入队', async () => {
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;

    setNotificationAgentRouteForTests('merge-a@test.example', {
      topic: 'agent-merge-a',
      reader: {
        username: 'reader-merge-a',
        token: 'tk_mergeaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    setNotificationAgentRouteForTests('merge-b@test.example', {
      topic: 'agent-merge-b',
      reader: {
        username: 'reader-merge-b',
        token: 'tk_mergebbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    removeAgentRouteOnIdentityDelete('merge-a@test.example');
    await whenReaderRevokeReconcileIdleForTests();
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual(['reader-merge-a']);

    let runs = 0;
    setOnReaderRevokeReconcileRunForTests(() => {
      runs += 1;
    });

    const deleteUser = async (username: string) => {
      await new Promise((r) => setTimeout(r, 30));
      if (username === 'reader-merge-a') {
        // 首轮间隙入队 B → 触发 again，重跑轮应处理 B
        removeAgentRouteOnIdentityDelete('merge-b@test.example');
      }
      return 'deleted' as const;
    };

    const p1 = reconcilePendingReaderRevokes(deleteUser);
    const p2 = reconcilePendingReaderRevokes(deleteUser);
    const p3 = reconcilePendingReaderRevokes(deleteUser);
    await Promise.all([p1, p2, p3]);

    expect(runs).toBeGreaterThan(0);
    expect(runs).toBeLessThanOrEqual(2);
    expect(getPendingReaderRevokesForTests().map((r) => r.username)).toEqual([]);
  });

  test('11. provision 中途删身份：不提交键且吊销刚建 reader', async () => {
    const deletedUsers: string[] = [];
    mockNtfyOk({ onDelete: (u) => deletedUsers.push(u) });

    const created = createIdentity({ localpart: 'race-orphan' })!;
    const address = created.identity.address;
    let midReader = '';

    setAfterCreateRuntimeReaderForTests(() => {
      const route = getNotificationAgentRouteForTests(address);
      midReader = route?.reader.username ?? '';
      // createRuntimeReader 成功后、二次确认前同步删身份
      deleteIdentity(address);
    });

    await provisionIdentityNotifications(created.identity);

    expect(findIdentity(address)).toBeUndefined();
    expect(getNotificationAgentRouteForTests(address)).toBeUndefined();
    expect(midReader).toMatch(/^reader-agent-/);
    for (let i = 0; i < 40 && !deletedUsers.includes(midReader); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(deletedUsers).toContain(midReader);
  });

  test('11b. #249-⑤ provision 竞态：DELETE 瞬断时孤儿仍入 pending 队列', async () => {
    mockNtfyOk({
      onDelete: () => {
        throw new Error('ntfy_transient');
      },
    });

    const created = createIdentity({ localpart: 'race-pending' })!;
    const address = created.identity.address;
    let midReader = '';

    setAfterCreateRuntimeReaderForTests(() => {
      midReader = getNotificationAgentRouteForTests(address)?.reader.username ?? '';
      deleteIdentity(address);
    });

    await provisionIdentityNotifications(created.identity);
    await whenReaderRevokeReconcileIdleForTests();

    expect(midReader).toMatch(/^reader-agent-/);
    expect(getPendingReaderRevokesForTests().some((r) => r.username === midReader)).toBe(true);
  });

  test('13. #249-⑦ identities 源码不直接 import notify（回调注入）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dir, '../src/lib/identities.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]\.\/notify\.ts['"]/);
    expect(src).toContain('registerNotifyRouteDeleteCallback');
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
