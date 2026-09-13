/**
 * #204 RED：REST / MCP wait 取消传播、槽位归还、403/408/200 保持可区分。
 * 假 IMAP 可在 connect/IDLE 挂起；未接线 abort 时用短超时避免 RED 挂死。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-cancel';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-wait-cancel-'));
process.env.UI_ENABLED = 'false';

const { beforeEach, describe, expect, mock, test } = await import('bun:test');

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
let failMailboxLock = false;
let hangPollConnect = false;
const createdClients: FakeImapFlow[] = [];

class FakeImapFlow extends EventEmitter {
  closed = false;
  loggedOut = false;
  connectStarted = false;
  idleStarted = false;
  logoutStarted = false;
  private closedWaiters: Array<() => void> = [];

  constructor() {
    super();
    createdClients.push(this);
  }

  get mailbox() {
    return { uidValidity: 17n };
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
    // 第二个 client 起才是 IDLE 失败后的轮询连接
    const isPollClient = hangPollConnect && createdClients.indexOf(this) >= 1;
    if (hangConnect || isPollClient) await this.waitUntilClosed(1500);
  }

  async getMailboxLock() {
    // 只让 IDLE 首连失败，轮询二次连接仍能进 INBOX 并走到成功路径 logout
    if (failMailboxLock && createdClients.indexOf(this) === 0) throw new Error('mailbox lock failed');
    return { release() {} };
  }

  async idle() {
    this.idleStarted = true;
    if (hangIdle) await this.waitUntilClosed(1500);
    else await new Promise((resolve) => setTimeout(resolve, 15));
  }

  async search() {
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
    if (hangLogout) await this.waitUntilClosed(1500);
    this.loggedOut = true;
  }

  close() {
    this.closed = true;
    for (const wake of this.closedWaiters.splice(0)) wake();
  }
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { createDelegation, revokeDelegation, resetDelegationStoreForTests } = await import(
  '../src/lib/delegations.ts'
);
const { MAX_WAITS_PER_SLOT, acquireWaitSlot, releaseWaitSlot, resetWaitSlots } = await import(
  '../src/lib/ratelimit.ts'
);

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: false });
const MCP_ACCEPT = 'application/json, text/event-stream';

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

async function waitUntil(pred: () => boolean, timeoutMs = 800): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await Bun.sleep(8);
  }
}

function restWait(address: string, timeoutSec: number, signal?: AbortSignal): Promise<Response> {
  // Hono request 可能同步返回 Response，统一包成 Promise 供 TS 收窄
  return Promise.resolve(app.request(
    new Request('http://localhost/v1/messages/wait', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address, timeoutSec }),
      signal,
    }),
  ));
}

beforeEach(() => {
  fakeMessages = [];
  hangConnect = false;
  hangIdle = false;
  hangLogout = false;
  failMailboxLock = false;
  hangPollConnect = false;
  createdClients.length = 0;
  resetWaitSlots();
  resetIdentitiesStore();
  resetDelegationStoreForTests();
});

describe('#204 REST wait 取消与槽位', () => {
  test('连接前 abort：迅速结束、关 client、499、槽位可被替换 wait 占用', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const res = await restWait('pre@test.example', 2, ac.signal);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(400);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.every((c) => c.released)).toBe(true);

    // 泄漏槽位会让第 MAX 个替换 wait 变成 429
    const replacements = await Promise.all(
      Array.from({ length: MAX_WAITS_PER_SLOT }, () => restWait('pre@test.example', 1)),
    );
    expect(replacements.every((r) => r.status !== 429)).toBe(true);
    expect(replacements.some((r) => r.status === 408)).toBe(true);
  });

  test('connect 期间 abort：关断挂起的 client 并释放槽位', async () => {
    hangConnect = true;
    const ac = new AbortController();
    const pending = restWait('mid-connect@test.example', 2, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.connectStarted));
    ac.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.some((c) => c.released)).toBe(true);

    hangConnect = false;
    const replacement = await restWait('mid-connect@test.example', 1);
    expect(replacement.status).toBe(408);
  });

  test('IDLE 期间 abort：迅速结束、关 client、允许替换 wait', async () => {
    hangIdle = true;
    const ac = new AbortController();
    const pending = restWait('idle@test.example', 2, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.idleStarted));
    const started = Date.now();
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(499);
    expect(createdClients.every((c) => c.released)).toBe(true);

    hangIdle = false;
    const replacement = await restWait('idle@test.example', 1);
    expect(replacement.status).toBe(408);
  });

  test('命中后 logout 挂起时 abort：迅速 499、关 client、槽位可替换', async () => {
    hangLogout = true;
    fakeMessages = [matchingMail('logout-abort@test.example')];
    const ac = new AbortController();
    const pending = restWait('logout-abort@test.example', 2, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.logoutStarted));
    const started = Date.now();
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.every((c) => c.released)).toBe(true);

    hangLogout = false;
    fakeMessages = [];
    const replacements = await Promise.all(
      Array.from({ length: MAX_WAITS_PER_SLOT }, () => restWait('logout-abort@test.example', 1)),
    );
    expect(replacements.every((r) => r.status !== 429)).toBe(true);
  });

  test('IDLE 失败落入轮询后 abort：迅速 499、关 client、不再开下一轮轮询', async () => {
    failMailboxLock = true;
    hangPollConnect = true;
    const ac = new AbortController();
    const pending = restWait('poll-abort@test.example', 2, ac.signal);
    await waitUntil(() => createdClients.filter((c) => c.connectStarted).length >= 2);
    const clientsAtAbort = createdClients.length;
    const started = Date.now();
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.length).toBe(clientsAtAbort);
    expect(createdClients.every((c) => c.released)).toBe(true);

    failMailboxLock = false;
    hangPollConnect = false;
    const replacement = await restWait('poll-abort@test.example', 1);
    expect(replacement.status).toBe(408);
  });

  test('轮询命中后 logout 挂起时 abort：迅速 499、关 client、不再开下一轮、槽位可替换', async () => {
    // IDLE 锁失败落入轮询；轮询 client 已命中，成功路径 logout 再挂起。
    failMailboxLock = true;
    hangLogout = true;
    fakeMessages = [matchingMail('poll-logout-abort@test.example')];
    const ac = new AbortController();
    const pending = restWait('poll-logout-abort@test.example', 2, ac.signal);
    await waitUntil(() => createdClients.some((c) => c.logoutStarted));
    const clientsAtAbort = createdClients.length;
    const started = Date.now();
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(499);
    expect(await res.json()).toEqual({ error: 'client_disconnected' });
    expect(createdClients.length).toBe(clientsAtAbort);
    expect(createdClients.every((c) => c.released)).toBe(true);

    failMailboxLock = false;
    hangLogout = false;
    fakeMessages = [];
    const replacements = await Promise.all(
      Array.from({ length: MAX_WAITS_PER_SLOT }, () => restWait('poll-logout-abort@test.example', 1)),
    );
    expect(replacements.every((r) => r.status !== 429)).toBe(true);
  });

  test('轮询命中后 logout 期间撤销再 abort：须 403 不得改判 499', async () => {
    // IDLE→轮询命中后 logout 挂起：先撤销委托再 abort，撤销优先于断开。
    failMailboxLock = true;
    hangLogout = true;
    const alice = createIdentity({ localpart: 'alice-poll-revoke' })!;
    const bob = createIdentity({ localpart: 'bob-poll-revoke', scopes: ['read:messages'] })!;
    const grant = createDelegation({
      mailbox: alice.identity.address,
      grantee: bob.identity.address,
      createdBy: alice.identity.address,
    });
    fakeMessages = [matchingMail(alice.identity.address)];
    const ac = new AbortController();
    const pending = Promise.resolve(app.request(
      new Request('http://localhost/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bob.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: alice.identity.address, timeoutSec: 2 }),
        signal: ac.signal,
      }),
    ));
    await waitUntil(() => createdClients.some((c) => c.logoutStarted));
    const clientsAtAbort = createdClients.length;
    revokeDelegation(grant.id, alice.identity.address);
    const started = Date.now();
    ac.abort();
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(400);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: token is scoped to another address' });
    expect(createdClients.length).toBe(clientsAtAbort);
    expect(createdClients.every((c) => c.released)).toBe(true);

    failMailboxLock = false;
    hangLogout = false;
    fakeMessages = [];
    const caller = bob.identity.address.toLowerCase();
    const mailbox = alice.identity.address;
    await waitUntil(() => {
      const ok = acquireWaitSlot(caller, mailbox);
      if (ok) releaseWaitSlot(caller, mailbox);
      return ok;
    }, 800);
  });
});

describe('#204 既有 wait 结果保持可区分', () => {
  test('普通超时仍是 408', async () => {
    const res = await restWait('timeout@test.example', 1);
    expect(res.status).toBe(408);
    const body = (await res.json()) as { error: string; timeoutSec?: number };
    expect(body.error).toBe('timeout');
    expect(typeof body.timeoutSec).toBe('number');
  });

  test('命中信件仍是 200', async () => {
    fakeMessages = [matchingMail('hit@test.example')];
    const res = await restWait('hit@test.example', 2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; subject: string };
    expect(body.id).toBe('7');
    expect(body.subject).toBe('found');
  });

  test('IDLE 失败后轮询命中仍是 200', async () => {
    failMailboxLock = true;
    fakeMessages = [matchingMail('poll-hit@test.example')];
    const res = await restWait('poll-hit@test.example', 2);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; subject: string };
    expect(body.id).toBe('7');
    expect(body.subject).toBe('found');
  });

  test('委托中途撤销仍是 403，不得改判 client_disconnected', async () => {
    const alice = createIdentity({ localpart: 'alice-wait-cancel' })!;
    const bob = createIdentity({ localpart: 'bob-wait-cancel', scopes: ['read:messages'] })!;
    const grant = createDelegation({
      mailbox: alice.identity.address,
      grantee: bob.identity.address,
      createdBy: alice.identity.address,
    });
    setTimeout(() => revokeDelegation(grant.id, alice.identity.address), 30);
    const res = await app.request('/v1/messages/wait', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bob.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: alice.identity.address, timeoutSec: 2 }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden: token is scoped to another address' });
  });
});

describe('#204 HTTP /mcp 外层 abort 传到内层 REST wait', () => {
  test('外层 Request abort 到达内层 wait 并释放槽位', async () => {
    hangIdle = true;
    const ac = new AbortController();
    const pending = app.request(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: MCP_ACCEPT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'mail_wait_for',
            arguments: { address: 'mcp-abort@test.example', timeoutSec: 2 },
          },
        }),
        signal: ac.signal,
      }),
    );
    await waitUntil(
      () => createdClients.some((c) => c.connectStarted || c.idleStarted),
      1200,
    );
    const started = Date.now();
    ac.abort();
    let settled: Response | Error;
    try {
      settled = await pending;
    } catch (err) {
      settled = err as Error;
    }
    expect(Date.now() - started).toBeLessThan(800);
    await waitUntil(() => createdClients.every((c) => c.released), 800);
    // 外层 /mcp Promise 可能先于路由 finally 结算，等到 admin 槽位真正归还
    await waitUntil(() => {
      const ok = acquireWaitSlot('admin', 'mcp-abort@test.example');
      if (ok) releaseWaitSlot('admin', 'mcp-abort@test.example');
      return ok;
    }, 800);

    hangIdle = false;
    const replacements = await Promise.all(
      Array.from({ length: MAX_WAITS_PER_SLOT }, () => restWait('mcp-abort@test.example', 1)),
    );
    expect(replacements.every((r) => r.status !== 429)).toBe(true);
    expect(settled).toBeTruthy();
  });
});
