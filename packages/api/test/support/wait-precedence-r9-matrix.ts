/**
 * R9 矩阵子进程体：含 imapflow mock。父测试只 spawn，不在主进程加载本文件。
 * 保留 11 组语义与 create/connect/close 计数。
 */
/**
 * #206 R9 RED/GREEN：撤销优先于断开、可取消 IMAP DNS、logout 不再二次等待。
 * 计数必须来自 create/connect/close，不得只靠 HTTP 状态推断。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-r9';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
// 复用父 helper 注入的 DATA_DIR；仅直跑本文件时才自建，避免父进程清不掉孤儿目录。
process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'oae-wait-r9-'));
process.env.UI_ENABLED = 'false';

const { afterEach, beforeEach, describe, expect, mock, test } = await import('bun:test');

type FakeMessage = {
  uid: number;
  envelope: {
    from: { address: string }[];
    to: { address: string }[];
    subject: string;
    date: Date;
  };
  internalDate: Date;
  flags: Set<string>;
  headers: Buffer;
  source?: Buffer;
};

let fakeMessages: FakeMessage[] = [];
let hangConnect = false;
let hangIdle = false;
let hangLogout = false;
let logoutIgnoresClose = false;
let failMailboxLock = false;
let failIdleOrdinary = false;
let refuseFirstConnect = false;
let refusePollConfiguredHost = false;
let hangPollConnect = false;
let missingUidValidity = false;
let searchHook: (() => void) | undefined;
let lateLogoutReject: ((err: Error) => void) | undefined;
/** 夹具显式角色：IDLE 会话 vs 回落后的轮询。不得只靠 created 计数猜阶段。 */
type FakeClientRole = 'idle' | 'poll';
let nextClientRole: FakeClientRole = 'idle';
const createdClients: FakeImapFlow[] = [];

class FakeImapFlow extends EventEmitter {
  closed = false;
  loggedOut = false;
  connectStarted = false;
  idleStarted = false;
  logoutStarted = false;
  closeCount = 0;
  idleActive = 0;
  maxIdleActive = 0;
  servername?: string;
  readonly role: FakeClientRole;
  /** configured-host 无 SNI；fresh-dns 重试带 servername。 */
  readonly connectMode: 'configured-host' | 'fresh-dns';
  private closedWaiters: Array<() => void> = [];

  constructor(opts?: { host?: string; servername?: string }) {
    super();
    this.servername = opts?.servername;
    this.role = nextClientRole;
    this.connectMode = opts?.servername ? 'fresh-dns' : 'configured-host';
    createdClients.push(this);
  }

  get mailbox() {
    return missingUidValidity ? {} : { uidValidity: 17n };
  }

  get released() {
    return this.closed || this.loggedOut;
  }

  private waitUntilClosed(ms: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('imap hang expired (no abort close)')), ms);
      this.closedWaiters.push(() => {
        clearTimeout(timer);
        reject(new Error('closed'));
      });
    });
  }

  async connect() {
    this.connectStarted = true;
    // 首次拨号无 servername；新鲜 DNS 重试才带 SNI。
    if (refuseFirstConnect && this.connectMode === 'configured-host') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    // 仅轮询配置主机拒绝：IDLE 先普通回落，再在 withInboxAbortable 里挂新鲜 DNS。
    if (refusePollConfiguredHost && this.role === 'poll' && this.connectMode === 'configured-host') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }
    if (hangConnect || (hangPollConnect && this.role === 'poll')) await this.waitUntilClosed(2000);
  }

  async getMailboxLock() {
    if (failMailboxLock && this.role === 'idle') {
      nextClientRole = 'poll';
      throw new Error('mailbox lock failed');
    }
    return { release() {} };
  }

  async idle() {
    this.idleStarted = true;
    this.idleActive += 1;
    this.maxIdleActive = Math.max(this.maxIdleActive, this.idleActive);
    try {
      if (failIdleOrdinary) throw new Error('idle exploded');
      if (hangIdle) await this.waitUntilClosed(2000);
      else await new Promise((resolve) => setTimeout(resolve, 15));
    } finally {
      this.idleActive -= 1;
    }
  }

  async search() {
    searchHook?.();
    return fakeMessages.map((m) => m.uid);
  }

  async *fetch() {
    yield* fakeMessages;
  }

  async fetchOne(uid: number) {
    const message = fakeMessages.find((m) => m.uid === uid);
    if (!message) return false;
    return {
      ...message,
      source:
        message.source ??
        Buffer.from(
          `From: sender@example.net\r\nTo: ${message.envelope.to[0]?.address}\r\n` +
            `Subject: ${message.envelope.subject}\r\n\r\nbody`,
        ),
    };
  }

  async logout() {
    this.logoutStarted = true;
    if (logoutIgnoresClose) {
      return new Promise<void>((_resolve, reject) => {
        lateLogoutReject = reject;
      });
    }
    if (hangLogout) await this.waitUntilClosed(2000);
    this.loggedOut = true;
  }

  close() {
    this.closeCount += 1;
    this.closed = true;
    for (const wake of this.closedWaiters.splice(0)) wake();
  }
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { createApp } = await import('../../src/app.ts');
const { config } = await import('../../src/lib/config.ts');
const { createIdentity } = await import('../../src/lib/identities.ts');
const { createDelegation, revokeDelegation, resetDelegationStoreForTests } = await import(
  '../../src/lib/delegations.ts'
);
const { MAX_WAITS_PER_SLOT, acquireWaitSlot, releaseWaitSlot, resetWaitSlots } = await import(
  '../../src/lib/ratelimit.ts'
);
const {
  setWaitMailserverResolverForTests,
  waitHeartbeatLiveForTests,
  waitForMessage,
  DelegationRevokedError,
  ClientDisconnectedError,
} = await import('../../src/lib/imap.ts');
const { setWaitMonotonicNowForTests, waitMonotonicNow } = await import('../../src/lib/wait-clock.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: false });
const realDateNow = Date.now;

function resetIdentitiesStore(): void {
  writeFileSync(join(config.dataDir, 'identities.json'), '[]', { mode: 0o600 });
}

function matchingMail(to: string, uid = 7): FakeMessage {
  return {
    uid,
    envelope: {
      from: [{ address: 'sender@example.net' }],
      to: [{ address: to }],
      subject: 'found',
      date: new Date('2026-09-12T00:00:00Z'),
    },
    internalDate: new Date('2026-09-12T00:00:00Z'),
    flags: new Set<string>(),
    headers: Buffer.from(`Delivered-To: ${to}\r\n`),
    source: Buffer.from(`From: sender@example.net\r\nTo: ${to}\r\nSubject: found\r\n\r\nbody`),
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 1200): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await Bun.sleep(8);
  }
}

function restWait(address: string, timeoutSec: number, signal?: AbortSignal): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request('http://localhost/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address, timeoutSec }),
        signal,
      }),
    ),
  );
}

function makeDelegate(suffix: string) {
  const alice = createIdentity({ localpart: `alice-${suffix}` })!;
  const bob = createIdentity({ localpart: `bob-${suffix}`, scopes: ['read:messages'] })!;
  const grant = createDelegation({
    mailbox: alice.identity.address,
    grantee: bob.identity.address,
    createdBy: alice.identity.address,
  });
  return { alice, bob, grant };
}

function delegatedWait(
  pair: ReturnType<typeof makeDelegate>,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request('http://localhost/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${pair.bob.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: pair.alice.identity.address, timeoutSec }),
        signal,
      }),
    ),
  );
}

async function expectSlotReusable(caller: string, mailbox: string): Promise<void> {
  await waitUntil(() => {
    const ok = acquireWaitSlot(caller, mailbox);
    if (ok) releaseWaitSlot(caller, mailbox);
    return ok;
  }, 800);
}

beforeEach(() => {
  fakeMessages = [];
  hangConnect = false;
  hangIdle = false;
  hangLogout = false;
  logoutIgnoresClose = false;
  failMailboxLock = false;
  failIdleOrdinary = false;
  refuseFirstConnect = false;
  refusePollConfiguredHost = false;
  hangPollConnect = false;
  missingUidValidity = false;
  nextClientRole = 'idle';
  searchHook = undefined;
  lateLogoutReject = undefined;
  createdClients.length = 0;
  Date.now = realDateNow;
  setWaitMonotonicNowForTests();
  setWaitMailserverResolverForTests();
  resetWaitSlots();
  resetIdentitiesStore();
  resetDelegationStoreForTests();
});

afterEach(() => {
  Date.now = realDateNow;
  setWaitMonotonicNowForTests();
  setWaitMailserverResolverForTests();
});

describe('#206 R9 撤销/断开优先级', () => {
  test('1 HTTP 路由已撤销且已 abort：403，零 create/connect；仅 abort 仍 499', async () => {
    const pair = makeDelegate('entry');
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    const ac = new AbortController();
    ac.abort();
    const res = await delegatedWait(pair, 2, ac.signal);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: token is scoped to another address' });
    expect(createdClients.length).toBe(0);
    expect(createdClients.filter((c) => c.connectStarted).length).toBe(0);

    const abortOnly = new AbortController();
    abortOnly.abort();
    const res499 = await restWait('r9-entry-abort@test.example', 2, abortOnly.signal);
    expect(res499.status).toBe(499);
    expect(res499.headers.get('X-OAE-Wait-Timeout-Sec')).toBe('2');
    expect(await res499.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.length).toBe(0);
  });

  test('1 waitForMessage 直调入口：shouldContinue=false 且已 abort → DelegationRevokedError，零 create/connect', async () => {
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await waitForMessage('r9-direct-entry@test.example', {}, 2, () => false, ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DelegationRevokedError);
    expect(caught).not.toBeInstanceOf(ClientDisconnectedError);
    expect(createdClients.length).toBe(0);
    expect(createdClients.filter((c) => c.connectStarted).length).toBe(0);
  });

  test('2 活动 IDLE 先撤销再 abort：403，close 且槽位可复用一次', async () => {
    hangIdle = true;
    const pair = makeDelegate('idle-rev');
    const ac = new AbortController();
    const pending = delegatedWait(pair, 3, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.idleStarted));
    const creates = createdClients.length;
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: token is scoped to another address' });
    expect(createdClients.length).toBe(creates);
    expect(createdClients.every((c) => c.released)).toBe(true);
    expect(createdClients.reduce((n, c) => n + c.closeCount, 0)).toBeGreaterThanOrEqual(1);
    await expectSlotReusable(pair.bob.identity.address.toLowerCase(), pair.alice.identity.address);
  });

  test('3 活动 IDLE 仅 abort：499 带头，无后续迭代/连接', async () => {
    hangIdle = true;
    const ac = new AbortController();
    const pending = restWait('r9-idle-abort@test.example', 5, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.idleStarted));
    const creates = createdClients.length;
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(res.headers.get('X-OAE-Wait-Timeout-Sec')).toBe('5');
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.length).toBe(creates);
    expect(createdClients.every((c) => c.released)).toBe(true);
    hangIdle = false;
    await expectSlotReusable('admin', 'r9-idle-abort@test.example');
  });

  test('4 活动轮询先撤销再 abort：403，close 且无后续 poll', async () => {
    failMailboxLock = true;
    hangPollConnect = true;
    const pair = makeDelegate('poll-rev');
    const ac = new AbortController();
    const pending = delegatedWait(pair, 4, ac.signal);
    await waitUntil(() => createdClients.filter((c) => c.connectStarted).length >= 2);
    const creates = createdClients.length;
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(createdClients.length).toBe(creates);
    expect(createdClients.every((c) => c.released)).toBe(true);
    await expectSlotReusable(pair.bob.identity.address.toLowerCase(), pair.alice.identity.address);
  });

  test('5 普通 IDLE 失败后兜底 sleep 中撤销+abort：403，不跟扫描', async () => {
    failIdleOrdinary = true;
    const pair = makeDelegate('idle-sleep');
    const ac = new AbortController();
    const pending = delegatedWait(pair, 5, ac.signal);
    // 兜底 sleep 进行中：IDLE 竞赛心跳未 dispose，abortableSleep 再占一格。
    await waitUntil(
      () =>
        createdClients.some((c) => c.idleStarted && c.idleActive === 0) &&
        waitHeartbeatLiveForTests() >= 2,
    );
    const creates = createdClients.length;
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(createdClients.length).toBe(creates);
    expect(createdClients.every((c) => c.released)).toBe(true);
    await expectSlotReusable(pair.bob.identity.address.toLowerCase(), pair.alice.identity.address);
  });

  test('6 轮询间隔 sleep 中撤销+abort：403，无后续连接', async () => {
    failMailboxLock = true;
    const pair = makeDelegate('inter-sleep');
    const ac = new AbortController();
    const pending = delegatedWait(pair, 5, ac.signal);
    // 第一轮空扫描结束后，轮询间隔 abortableSleep 才真正挂起。
    await waitUntil(
      () =>
        createdClients.filter((c) => c.connectStarted).length >= 2 &&
        waitHeartbeatLiveForTests() >= 1,
    );
    const creates = createdClients.length;
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(createdClients.length).toBe(creates);
    await expectSlotReusable(pair.bob.identity.address.toLowerCase(), pair.alice.identity.address);
  });

  test('7 轮询截止边界：abort→499 先于 408；撤销+abort→403；普通超时 408', async () => {
    failMailboxLock = true;
    const frozen = realDateNow();
    const frozenMono = waitMonotonicNow();
    const ac = new AbortController();
    searchHook = () => {
      // 墙钟与单调钟一并越过截止，才能测 abort/撤销对 408 的优先级。
      Date.now = () => frozen + 60_000;
      setWaitMonotonicNowForTests(() => frozenMono + 60_000);
      ac.abort();
    };
    const res499 = await restWait('r9-deadline-abort@test.example', 2, ac.signal);
    expect(res499.status).toBe(499);
    expect(res499.headers.get('X-OAE-Wait-Timeout-Sec')).toBe('2');
    Date.now = realDateNow;
    setWaitMonotonicNowForTests();

    const pair = makeDelegate('deadline-rev');
    const ac2 = new AbortController();
    searchHook = () => {
      Date.now = () => frozen + 60_000;
      setWaitMonotonicNowForTests(() => frozenMono + 60_000);
      revokeDelegation(pair.grant.id, pair.alice.identity.address);
      ac2.abort();
    };
    const res403 = await delegatedWait(pair, 2, ac2.signal);
    expect(res403.status).toBe(403);
    Date.now = realDateNow;
    setWaitMonotonicNowForTests();
    searchHook = undefined;

    const res408 = await restWait('r9-deadline-plain@test.example', 1);
    expect(res408.status).toBe(408);
    const body = (await res408.json()) as { error: string };
    expect(body.error).toBe('timeout');
  });

  test('8 新鲜 DNS 挂起：abort→499 / 撤销+abort→403，无重试 client；未 abort 只重试一次；败者可观察', async () => {
    refuseFirstConnect = true;
    const rejections: unknown[] = [];
    const onRej = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRej);
    try {
      let releaseDns: ((addr: string) => void) | undefined;
      let rejectDns: ((err: Error) => void) | undefined;
      setWaitMailserverResolverForTests(
        () =>
          new Promise<string>((resolve, reject) => {
            releaseDns = resolve;
            rejectDns = reject;
          }),
      );

      const ac = new AbortController();
      const pending = restWait('r9-dns-abort@test.example', 8, ac.signal);
      await waitUntil(
        () => createdClients.some((c) => c.connectStarted) && typeof releaseDns === 'function',
      );
      const createsAtAbort = createdClients.length;
      ac.abort();
      const res = await pending;
      expect(res.status).toBe(499);
      expect(createdClients.length).toBe(createsAtAbort);
      expect(createdClients.filter((c) => c.connectStarted).length).toBe(1);
      await expectSlotReusable('admin', 'r9-dns-abort@test.example');
      // 败者迟到 resolve 不得再 create
      releaseDns?.('172.18.0.9');
      await Bun.sleep(20);
      expect(createdClients.length).toBe(createsAtAbort);

      const pair = makeDelegate('dns-rev');
      releaseDns = undefined;
      setWaitMailserverResolverForTests(
        () =>
          new Promise<string>((resolve, reject) => {
            releaseDns = resolve;
            rejectDns = reject;
          }),
      );
      const ac2 = new AbortController();
      const pending2 = delegatedWait(pair, 8, ac2.signal);
      await waitUntil(
        () =>
          createdClients.filter((c) => c.connectStarted).length >= 2 &&
          typeof releaseDns === 'function',
      );
      const creates2 = createdClients.length;
      revokeDelegation(pair.grant.id, pair.alice.identity.address);
      ac2.abort();
      const res403 = await pending2;
      expect(res403.status).toBe(403);
      expect(createdClients.length).toBe(creates2);
      rejectDns?.(new Error('late dns reject'));
      await Bun.sleep(20);
      expect(rejections).toEqual([]);

      // 未 abort：解析成功则恰好一次重试（IDLE 配置主机失败后的新鲜 DNS）
      setWaitMailserverResolverForTests(async () => '172.18.0.10');
      const before = createdClients.length;
      const res408 = await restWait('r9-dns-retry@test.example', 1);
      expect(res408.status).toBe(408);
      expect(createdClients.length).toBe(before + 2);

      // 轮询新鲜 DNS：IDLE 先普通回落，再拒绝 poll 配置主机并挂 resolver。
      refuseFirstConnect = false;
      failMailboxLock = true;
      refusePollConfiguredHost = true;
      nextClientRole = 'idle';
      let releasePollDns: ((addr: string) => void) | undefined;
      let rejectPollDns: ((err: Error) => void) | undefined;
      setWaitMailserverResolverForTests(
        () =>
          new Promise<string>((resolve, reject) => {
            releasePollDns = resolve;
            rejectPollDns = reject;
          }),
      );
      const acPoll = new AbortController();
      const pollMark = createdClients.length;
      const pendingPoll = restWait('r9-dns-poll-abort@test.example', 8, acPoll.signal);
      await waitUntil(
        () =>
          createdClients
            .slice(pollMark)
            .some((c) => c.role === 'idle' && c.connectStarted) &&
          createdClients
            .slice(pollMark)
            .some(
              (c) =>
                c.role === 'poll' &&
                c.connectMode === 'configured-host' &&
                c.connectStarted,
            ) &&
          typeof releasePollDns === 'function',
      );
      const pollCreates = createdClients.length;
      const pollIdle = createdClients
        .slice(pollMark)
        .filter((c) => c.role === 'idle').length;
      const pollConfigured = createdClients
        .slice(pollMark)
        .filter((c) => c.role === 'poll' && c.connectMode === 'configured-host').length;
      const pollFresh = createdClients
        .slice(pollMark)
        .filter((c) => c.role === 'poll' && c.connectMode === 'fresh-dns').length;
      expect(pollIdle).toBe(1);
      expect(pollConfigured).toBe(1);
      expect(pollFresh).toBe(0);
      acPoll.abort();
      const resPoll499 = await pendingPoll;
      expect(resPoll499.status).toBe(499);
      expect(resPoll499.headers.get('X-OAE-Wait-Timeout-Sec')).toBe('8');
      expect(await resPoll499.json()).toEqual({ error: 'client_disconnected' });
      expect(createdClients.length).toBe(pollCreates);
      expect(
        createdClients.filter((c) => c.role === 'poll' && c.connectMode === 'fresh-dns').length,
      ).toBe(0);
      await expectSlotReusable('admin', 'r9-dns-poll-abort@test.example');
      releasePollDns?.('172.18.0.11');
      await Bun.sleep(20);
      expect(createdClients.length).toBe(pollCreates);
      expect(
        createdClients.filter((c) => c.role === 'poll' && c.connectMode === 'fresh-dns').length,
      ).toBe(0);

      const pairPoll = makeDelegate('dns-poll-rev');
      nextClientRole = 'idle';
      let releasePollDns2: ((addr: string) => void) | undefined;
      let rejectPollDns2: ((err: Error) => void) | undefined;
      setWaitMailserverResolverForTests(
        () =>
          new Promise<string>((resolve, reject) => {
            releasePollDns2 = resolve;
            rejectPollDns2 = reject;
          }),
      );
      const acPoll2 = new AbortController();
      const pollMark2 = createdClients.length;
      const pendingPoll2 = delegatedWait(pairPoll, 8, acPoll2.signal);
      await waitUntil(
        () =>
          createdClients
            .slice(pollMark2)
            .some((c) => c.role === 'idle' && c.connectStarted) &&
          createdClients
            .slice(pollMark2)
            .some(
              (c) =>
                c.role === 'poll' &&
                c.connectMode === 'configured-host' &&
                c.connectStarted,
            ) &&
          typeof releasePollDns2 === 'function',
      );
      const pollCreates2 = createdClients.length;
      revokeDelegation(pairPoll.grant.id, pairPoll.alice.identity.address);
      acPoll2.abort();
      const resPoll403 = await pendingPoll2;
      expect(resPoll403.status).toBe(403);
      expect(createdClients.length).toBe(pollCreates2);
      expect(
        createdClients.filter((c) => c.role === 'poll' && c.connectMode === 'fresh-dns').length,
      ).toBe(0);
      await expectSlotReusable(
        pairPoll.bob.identity.address.toLowerCase(),
        pairPoll.alice.identity.address,
      );
      rejectPollDns2?.(new Error('late poll dns reject'));
      await Bun.sleep(20);
      expect(rejections).toEqual([]);
      expect(createdClients.length).toBe(pollCreates2);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  }, 12000);

  test('9 close 后 logout 仍挂起：截止/abort 在既有界内结算，close 一次，迟到 reject 被观察', async () => {
    logoutIgnoresClose = true;
    fakeMessages = [matchingMail('r9-logout-bound@test.example')];
    const rejections: unknown[] = [];
    const onRej = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRej);
    try {
      const started = Date.now();
      const res = await restWait('r9-logout-bound@test.example', 1);
      expect(Date.now() - started).toBeLessThan(1800);
      expect(res.status).toBe(408);
      expect(createdClients.reduce((n, c) => n + c.closeCount, 0)).toBe(1);
      await expectSlotReusable('admin', 'r9-logout-bound@test.example');

      fakeMessages = [matchingMail('r9-logout-abort@test.example')];
      const ac = new AbortController();
      const pending = restWait('r9-logout-abort@test.example', 3, ac.signal);
      await waitUntil(() => createdClients.some((c) => c.logoutStarted));
      ac.abort();
      const res499 = await pending;
      expect(res499.status).toBe(499);
      expect(createdClients.filter((c) => c.logoutStarted).every((c) => c.closeCount >= 1)).toBe(true);

      lateLogoutReject?.(new Error('late logout reject'));
      await Bun.sleep(20);
      expect(rejections).toEqual([]);

      // 矩阵 9：search 已 abort，logoutBounded 必须观察当前 aborted，不得空等 3s 截止。
      fakeMessages = [matchingMail('r9-logout-already-aborted@test.example')];
      logoutIgnoresClose = true;
      searchHook = undefined;
      const acAlready = new AbortController();
      searchHook = () => acAlready.abort();
      const promptStarted = performance.now();
      const resAlready = await restWait(
        'r9-logout-already-aborted@test.example',
        3,
        acAlready.signal,
      );
      expect(performance.now() - promptStarted).toBeLessThan(800);
      expect(resAlready.status).toBe(499);
      expect(resAlready.headers.get('X-OAE-Wait-Timeout-Sec')).toBe('3');
      expect(await resAlready.json()).toEqual({ error: 'client_disconnected' });
      expect(
        createdClients
          .filter((c) => c.logoutStarted)
          .every((c) => c.closeCount >= 1),
      ).toBe(true);
      await expectSlotReusable('admin', 'r9-logout-already-aborted@test.example');
      const rejectAlready = lateLogoutReject;
      rejectAlready?.(new Error('late logout reject after already-aborted'));
      await Bun.sleep(20);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });

  test('10 初连已 create 后挂起：撤销+abort→403，close，无 DNS 重试，槽位可复用', async () => {
    hangConnect = true;
    const pair = makeDelegate('conn-stage');
    const ac = new AbortController();
    const pending = delegatedWait(pair, 4, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.connectStarted));
    expect(createdClients.length).toBe(1);
    revokeDelegation(pair.grant.id, pair.alice.identity.address);
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(createdClients.length).toBe(1);
    expect(createdClients[0]?.released).toBe(true);
    await expectSlotReusable(pair.bob.identity.address.toLowerCase(), pair.alice.identity.address);
  });

  test('11 坏游标 400；普通非 abort IDLE 失败仍回落轮询；200 与仅撤销 403 不变', async () => {
    missingUidValidity = true;
    fakeMessages = [matchingMail('r9-cursor@test.example')];
    const bad = await restWait('r9-cursor@test.example', 2);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'invalid_cursor' });
    missingUidValidity = false;

    failMailboxLock = true;
    fakeMessages = [matchingMail('r9-poll-hit@test.example')];
    const hit = await restWait('r9-poll-hit@test.example', 2);
    expect(hit.status).toBe(200);
    expect(((await hit.json()) as { subject: string }).subject).toBe('found');
    failMailboxLock = false;

    fakeMessages = [matchingMail('r9-ok@test.example')];
    const ok = await restWait('r9-ok@test.example', 2);
    expect(ok.status).toBe(200);

    const pair = makeDelegate('only-rev');
    setTimeout(() => revokeDelegation(pair.grant.id, pair.alice.identity.address), 30);
    const rev = await delegatedWait(pair, 2);
    expect(rev.status).toBe(403);
  });
});
