/** #275 Scoped Permissions 负控矩阵 + 兼容两腿 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigurableFakeMailbox } from './helpers/imap-fake-mailbox.ts';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-scoped-id-test';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.MCP_PUBLIC_URL = 'http://localhost';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-scoped-id-'));

const { beforeAll, describe, expect, mock, test } = await import('bun:test');

let fakeMessages: any[] = [
  {
    uid: 201,
    flags: new Set(),
    envelope: {
      date: new Date('2026-09-01T00:00:00Z'),
      subject: 'Hello child mailbox',
      from: [{ address: 'sender@example.net', name: 'Sender' }],
      to: [{ address: 'child-read@test.example', name: 'Child' }],
    },
    internalDate: new Date('2026-09-01T00:00:00Z'),
    source: Buffer.from(
      'From: sender@example.net\r\nTo: child-read@test.example\r\nSubject: Hello child mailbox\r\n\r\nbody',
    ),
  },
];

const fakeMailbox = createConfigurableFakeMailbox();

class FakeImapFlow extends EventEmitter {
  get mailbox() {
    return fakeMailbox.mailbox;
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search() {
    return fakeMessages.map((m) => m.uid);
  }
  async *fetch() {
    yield* fakeMessages;
  }
  async fetchOne(uid: number) {
    const msg = fakeMessages.find((m) => m.uid === uid);
    if (!msg) return false;
    return { ...msg, source: msg.source ?? Buffer.from('From: x\r\n\r\nbody') };
  }
  async messageFlagsAdd() {}
  async messageFlagsRemove() {}
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));
const sendMailMock = mock(async () => ({ messageId: '<scoped-send@test.example>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail: sendMailMock }));

const { config } = await import('../src/lib/config.ts');
const { createApp } = await import('../src/app.ts');
const {
  createIdentity,
  findIdentity,
  countChildren,
  isParentOf,
  MAX_CHILD_IDENTITIES,
  listIdentities,
  resolvePushContentTier,
  setIdentityPushContentTier,
  deleteIdentity,
  rotateIdentityTokenDetailed,
  findIdentityByToken,
} = await import('../src/lib/identities.ts');
import type { Identity } from '../src/lib/identities.ts';
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: true });
const storeFile = () => join(config.dataDir, 'identities.json');

async function mintParent(localpart: string, scopes: string[]) {
  const res = await app.request('/v1/identities', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ localpart, scopes }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { address: string; token: string };
}

function authJson(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('Issue #275: scoped identities create + parent ownership', () => {
  describe('负控矩阵 · 创建门控', () => {
    test('1. 无 identities:create → 403 default-deny', async () => {
      const parent = await mintParent('neg-no-create', ['read:messages']);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'should-fail' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('2+8. 跨域 / 显式他域 → 400 invalid_domain', async () => {
      const parent = await mintParent('neg-cross-domain', ['identities:create', 'read:messages']);
      (config.allDomains as Set<string>).add('secondary.example');
      try {
        const res = await app.request('/v1/identities', {
          method: 'POST',
          headers: authJson(parent.token),
          body: JSON.stringify({ localpart: 'cross-dom-child', domain: 'secondary.example' }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: 'invalid_domain',
          details: 'child identity must share the parent identity domain',
        });
      } finally {
        (config.allDomains as Set<string>).delete('secondary.example');
      }
    });

    test('3. 二层嵌套授 identities:create → 400', async () => {
      const parent = await mintParent('neg-nest', ['identities:create', 'read:messages']);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'nested-child', scopes: ['identities:create'] }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      });
    });

    test('4. 传 canNotifyUser → 403', async () => {
      const parent = await mintParent('neg-notify', ['identities:create', 'read:messages']);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'notify-child', canNotifyUser: true }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden: admin key required for canNotifyUser',
      });
    });

    test('5. 子凭据越父 → 403 scope exceeds parent', async () => {
      const parent = await mintParent('neg-exceed', ['identities:create', 'read:messages']);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'exceed-child', scopes: ['messages:send'] }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden: scope exceeds parent permissions',
      });
    });

    test('7. 触配额第 51 个 → 403 child_limit_reached', async () => {
      const parent = await mintParent('quota-parent', ['identities:create', 'read:messages']);
      for (let i = 0; i < MAX_CHILD_IDENTITIES; i++) {
        expect(
          createIdentity({
            localpart: `quota-seed-${i}`,
            parentIdentity: parent.address,
            scopes: ['read:messages'],
          }),
        ).not.toBeNull();
      }
      expect(countChildren(parent.address)).toBe(50);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'quota-51' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'child_limit_reached', limit: 50 });
    });

    test('默认 scopes：省略 → [read:messages] + parentIdentity', async () => {
      const parent = await mintParent('pos-default', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'default-child' }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as { address: string; scopes?: string[] };
      expect(data.scopes).toEqual(['read:messages']);
      expect(findIdentity(data.address)!.parentIdentity).toBe(parent.address);
      expect(isParentOf(parent.address, data.address)).toBe(true);
    });
  });

  describe('负控矩阵 · 发送侧归属', () => {
    let parentToken: string;
    let parentAddress: string;
    let childAddress: string;
    let orphanAddress: string;

    beforeAll(async () => {
      const parent = await mintParent('send-parent', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);
      parentToken = parent.token;
      parentAddress = parent.address;
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parentToken),
        body: JSON.stringify({
          localpart: 'send-child',
          scopes: ['read:messages', 'messages:send'],
        }),
      });
      expect(childRes.status).toBe(201);
      childAddress = ((await childRes.json()) as { address: string }).address;
      orphanAddress = createIdentity({ localpart: 'send-orphan' })!.identity.address;
      resetRateLimits();
    });

    test('6a. 非归属子发信 → 403', async () => {
      const res = await app.request('/v1/send', {
        method: 'POST',
        headers: authJson(parentToken),
        body: JSON.stringify({
          from: orphanAddress,
          to: 'rcpt@example.net',
          subject: 'nope',
          text: 'x',
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });
    });

    test('6b. 归属子发信 → 200 + 子桶限速', async () => {
      sendMailMock.mockClear();
      resetRateLimits();
      const prevLimit = config.sendRateLimit;
      Object.assign(config, { sendRateLimit: 2 });
      try {
        const send = (subject: string) =>
          app.request('/v1/send', {
            method: 'POST',
            headers: authJson(parentToken),
            body: JSON.stringify({
              from: childAddress,
              to: 'rcpt@example.net',
              subject,
              text: 'body',
            }),
          });
        expect((await send('ok')).status).toBe(200);
        expect((sendMailMock.mock.calls[0]![0] as { from: string }).from).toBe(childAddress);
        expect((await send('ok2')).status).toBe(200);
        const third = await send('ok3');
        expect(third.status).toBe(429);
        expect(((await third.json()) as { error: string }).error).toBe('rate_limited');
        const parentSend = await app.request('/v1/send', {
          method: 'POST',
          headers: authJson(parentToken),
          body: JSON.stringify({
            from: parentAddress,
            to: 'rcpt@example.net',
            subject: 'parent',
            text: 'body',
          }),
        });
        expect(parentSend.status).toBe(200);
      } finally {
        Object.assign(config, { sendRateLimit: prevLimit });
        resetRateLimits();
      }
    });
  });

  describe('负控矩阵 · 读侧 + 管理面 + 子 token', () => {
    let parentWithRead: { address: string; token: string };
    let parentNoRead: { address: string; token: string };
    let childOfRead: string;
    let childOfNoRead: string;
    let childToken: string;

    beforeAll(async () => {
      parentWithRead = await mintParent('read-parent', ['identities:create', 'read:messages']);
      parentNoRead = await mintParent('noread-parent', ['identities:create']);
      const c1 = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parentWithRead.token),
        body: JSON.stringify({ localpart: 'child-read' }),
      });
      expect(c1.status).toBe(201);
      const d1 = (await c1.json()) as { address: string; token: string };
      childOfRead = d1.address;
      childToken = d1.token;
      const c2 = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parentNoRead.token),
        body: JSON.stringify({ localpart: 'child-noread-parent' }),
      });
      expect(c2.status).toBe(201);
      const d2 = (await c2.json()) as { address: string; scopes?: string[] };
      expect(d2.scopes).toEqual([]);
      childOfNoRead = d2.address;
      fakeMessages[0]!.envelope.to = [{ address: childOfRead, name: 'Child' }];
    });

    test('9a. 父无 read:messages 读子 → 403', async () => {
      const res = await app.request(`/v1/messages?address=${childOfNoRead}`, {
        headers: { authorization: `Bearer ${parentNoRead.token}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('9b. 有 read:messages → list/get/wait；wait shouldContinue 正控', async () => {
      expect(
        (
          await app.request(`/v1/messages?address=${childOfRead}`, {
            headers: { authorization: `Bearer ${parentWithRead.token}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(`/v1/messages/201?address=${childOfRead}`, {
            headers: { authorization: `Bearer ${parentWithRead.token}` },
          })
        ).status,
      ).toBe(200);
      const wait = await app.request('/v1/messages/wait', {
        method: 'POST',
        headers: authJson(parentWithRead.token),
        body: JSON.stringify({ address: childOfRead, timeoutSec: 1 }),
      });
      expect([200, 408]).toContain(wait.status);
      expect(wait.status).not.toBe(403);
    });

    test('10. delete/rotate/push-tier 对子 → 403', async () => {
      expect(
        (
          await app.request(`/v1/identities/${childOfRead}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${parentWithRead.token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/v1/identities/${childOfRead}/token`, {
            method: 'POST',
            headers: { authorization: `Bearer ${parentWithRead.token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(`/v1/identities/${childOfRead}/push-tier`, {
            method: 'PUT',
            headers: authJson(parentWithRead.token),
            body: JSON.stringify({ pushContentTier: 2 }),
          })
        ).status,
      ).toBe(403);
    });

    test('11. 子 token 默认面：读自己 ✓ / 发 ✗ / 建 delegation ✗', async () => {
      expect(
        (
          await app.request(`/v1/messages?address=${childOfRead}`, {
            headers: { authorization: `Bearer ${childToken}` },
          })
        ).status,
      ).toBe(200);
      const send = await app.request('/v1/send', {
        method: 'POST',
        headers: authJson(childToken),
        body: JSON.stringify({
          from: childOfRead,
          to: 'rcpt@example.net',
          subject: 'no',
          text: 'x',
        }),
      });
      expect(send.status).toBe(403);
      expect(await send.json()).toEqual({ error: 'forbidden: insufficient_scope' });
      const deleg = await app.request('/v1/delegations', {
        method: 'POST',
        headers: authJson(childToken),
        body: JSON.stringify({
          mailbox: childOfRead,
          grantee: parentWithRead.address,
          scope: 'read:messages',
        }),
      });
      expect(deleg.status).toBe(403);
      expect(await deleg.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });
  });

  describe('12. admin / unscoped / read:messages 回归', () => {
    test('admin create 不写 parentIdentity', async () => {
      const res = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ localpart: 'admin-top' }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as { address: string };
      expect(findIdentity(data.address)?.parentIdentity).toBeUndefined();
    });

    test('unscoped 可读自己、不可建身份', async () => {
      const created = createIdentity({ localpart: 'unscoped-reg' })!;
      expect(
        (
          await app.request(`/v1/messages?address=${created.identity.address}`, {
            headers: { authorization: `Bearer ${created.token}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request('/v1/identities', {
            method: 'POST',
            headers: authJson(created.token),
            body: JSON.stringify({ localpart: 'nope' }),
          })
        ).status,
      ).toBe(403);
    });

    test('既有 read:messages 只能读自己', async () => {
      const created = createIdentity({
        localpart: 'legacy-read',
        scopes: ['read:messages'],
      })!;
      expect(
        (
          await app.request(`/v1/messages?address=${created.identity.address}`, {
            headers: { authorization: `Bearer ${created.token}` },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request('/v1/messages?address=victim@test.example', {
            headers: { authorization: `Bearer ${created.token}` },
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('兼容两腿（真实路径）', () => {
    test('① 新代码读旧数据（无 parentIdentity）→ 行为不变', () => {
      const legacy = createIdentity({ localpart: 'compat-legacy' })!;
      const loaded = findIdentity(legacy.identity.address)!;
      expect(loaded.parentIdentity).toBeUndefined();
      expect(isParentOf(legacy.identity.address, 'anyone@test.example')).toBe(false);
      expect(countChildren(legacy.identity.address)).toBe(0);
      expect(listIdentities().some((i) => i.address === legacy.identity.address)).toBe(true);
    });

    test('② F94：含 parentIdentity 的新数据经 load/rewrite 保留', () => {
      const normal = createIdentity({ localpart: 'f94-275-normal' })!;
      const future = createIdentity({
        localpart: 'f94-275-parented',
        parentIdentity: 'parent@test.example',
        scopes: ['read:messages'],
      })!;
      const seeded = JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<
        Record<string, unknown>
      >;
      const futureRow = seeded.find((e) => e.address === future.identity.address)!;
      expect(futureRow.parentIdentity).toBe('parent@test.example');
      futureRow.futureField = { from: 'newer-binary' };
      writeFileSync(storeFile(), JSON.stringify(seeded, null, 2));
      const loaded = findIdentity(future.identity.address) as Identity & {
        futureField?: { from: string };
      };
      expect(loaded.parentIdentity).toBe('parent@test.example');
      expect(loaded.futureField).toEqual({ from: 'newer-binary' });
      setIdentityPushContentTier(normal.identity.address, 2);
      const still = (
        JSON.parse(readFileSync(storeFile(), 'utf8')) as Array<Record<string, unknown>>
      ).find((e) => e.address === future.identity.address)!;
      expect(still.parentIdentity).toBe('parent@test.example');
      expect(still.futureField).toEqual({ from: 'newer-binary' });
      expect(resolvePushContentTier(findIdentity(normal.identity.address)!)).toBe(2);
    });
  });

  describe('#275 R1 闸变修复', () => {
    test('F1: OAuth 票含 identities:create → POST /v1/identities 403；直连身份 token 不受影响', async () => {
      const parent = await mintParent('r1-oauth-parent', [
        'identities:create',
        'read:messages',
      ]);
      const { putAccessTokenForTests } = await import('../src/lib/oauth-store.ts');
      const { resolveResourceUri } = await import('../src/lib/oauth-url.ts');
      const resource = resolveResourceUri('http://localhost')!;
      const oauthToken = 'oa_r1_oauth_create_token';
      putAccessTokenForTests({
        token: oauthToken,
        grantId: 'grant-r1-oauth-create',
        address: parent.address,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-r1', clientName: 'R1 Client' },
      });
      const oauthRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(oauthToken),
        body: JSON.stringify({ localpart: 'oauth-child-nope' }),
      });
      expect(oauthRes.status).toBe(403);
      expect(await oauthRes.json()).toEqual({
        error: 'forbidden: child identity creation requires direct identity credentials',
      });
      // 直连身份 token 仍可创建
      const ok = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'oauth-child-ok' }),
      });
      expect(ok.status).toBe(201);
    });

    test('F2: 删父清子归属；同址重建不可收养；wait 中止', async () => {
      const parent = await mintParent('r1-orphan-parent', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r1-orphan-child' }),
      });
      expect(childRes.status).toBe(201);
      const child = (await childRes.json()) as { address: string };
      expect(findIdentity(child.address)?.parentIdentity).toBe(parent.address);

      // ③ 已运行 wait：删父后中止（不返回新邮件）
      fakeMessages = [];
      const waitPromise = app.request('/v1/messages/wait', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ address: child.address, timeoutSec: 4 }),
      });
      await Bun.sleep(80);
      expect(deleteIdentity(parent.address)).toBe(true);

      // ① store：子 parentIdentity 已清除
      expect(findIdentity(child.address)?.parentIdentity).toBeUndefined();
      expect(countChildren(parent.address)).toBe(0);

      const waitRes = await waitPromise;
      expect(waitRes.status).toBe(403);
      expect(await waitRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      // ② 同址重建 → 对旧子读/发 403
      const resurrected = createIdentity({
        localpart: 'r1-orphan-parent',
        scopes: ['read:messages', 'messages:send', 'identities:create'],
      })!;
      expect(resurrected.identity.address).toBe(parent.address);
      const list = await app.request(`/v1/messages?address=${child.address}`, {
        headers: { authorization: `Bearer ${resurrected.token}` },
      });
      expect(list.status).toBe(403);
      const send = await app.request('/v1/send', {
        method: 'POST',
        headers: authJson(resurrected.token),
        body: JSON.stringify({
          from: child.address,
          to: 'rcpt@example.net',
          subject: 'adopt',
          text: 'x',
        }),
      });
      expect(send.status).toBe(403);
    });

    test('F3: rotate 子约束 — create/越父/null 拒；合法 ⊆父 → 200', async () => {
      const parent = await mintParent('r1-rot-parent', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r1-rot-child', scopes: ['read:messages'] }),
      });
      expect(childRes.status).toBe(201);
      const childAddr = ((await childRes.json()) as { address: string }).address;

      const rotCreate = await app.request(`/v1/identities/${childAddr}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['identities:create'] }),
      });
      expect(rotCreate.status).toBe(400);
      expect(await rotCreate.json()).toEqual({
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      });

      // 收窄父 scopes 后越权
      await app.request(`/v1/identities/${parent.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['identities:create', 'read:messages'] }),
      });
      const rotExceed = await app.request(`/v1/identities/${childAddr}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['messages:send'] }),
      });
      expect(rotExceed.status).toBe(403);
      expect(await rotExceed.json()).toEqual({
        error: 'forbidden: scope exceeds parent permissions',
      });

      const rotNull = await app.request(`/v1/identities/${childAddr}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: null }),
      });
      expect(rotNull.status).toBe(400);
      expect(await rotNull.json()).toEqual({
        error: 'invalid_request',
        details: 'child identity cannot be reset to an unscoped token',
      });

      const rotOk = await app.request(`/v1/identities/${childAddr}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(rotOk.status).toBe(200);
      expect(((await rotOk.json()) as { scopes: string[] }).scopes).toEqual(['read:messages']);
    });

    test('F4: delegation 仅允许 read:messages；messages:send → 400', async () => {
      const owner = createIdentity({ localpart: 'r1-del-owner' })!;
      const grantee = createIdentity({ localpart: 'r1-del-grantee' })!;
      const bad = await app.request('/v1/delegations', {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({
          mailbox: owner.identity.address,
          grantee: grantee.identity.address,
          scopes: ['messages:send'],
        }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: 'unsupported_scope',
        details: 'Unsupported scope: messages:send',
      });
      const good = await app.request('/v1/delegations', {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({
          mailbox: owner.identity.address,
          grantee: grantee.identity.address,
          scopes: ['read:messages'],
        }),
      });
      expect(good.status).toBe(201);
    });

    test('F5: 归属分支要求 requiredScope；仅 messages:send 不可读子', async () => {
      const { Hono } = await import('hono');
      const { forbidUnlessMailboxAccess } = await import('../src/lib/auth.ts');
      const parent = createIdentity({
        localpart: 'r1-f5-parent',
        scopes: ['messages:send'],
      })!;
      const child = createIdentity({
        localpart: 'r1-f5-child',
        parentIdentity: parent.identity.address,
        scopes: ['read:messages'],
      })!;
      const mini = new Hono();
      mini.use('*', async (c, next) => {
        c.set('auth', {
          kind: 'identity',
          address: parent.identity.address,
          scopes: ['messages:send'],
        });
        await next();
      });
      mini.get('/probe', (c) => {
        const denied = forbidUnlessMailboxAccess(c, child.identity.address, 'read:messages');
        if (denied) return denied;
        return c.json({ ok: true });
      });
      const denied = await mini.request('/probe');
      expect(denied.status).toBe(403);

      // 含 read:messages 可经归属分支
      const mini2 = new Hono();
      mini2.use('*', async (c, next) => {
        c.set('auth', {
          kind: 'identity',
          address: parent.identity.address,
          scopes: ['read:messages'],
        });
        await next();
      });
      mini2.get('/probe', (c) => {
        const d = forbidUnlessMailboxAccess(c, child.identity.address, 'read:messages');
        if (d) return d;
        return c.json({ ok: true });
      });
      expect((await mini2.request('/probe')).status).toBe(200);
    });

    test('F6: admin list 含 parentIdentity', async () => {
      const parent = await mintParent('r1-list-parent', [
        'identities:create',
        'read:messages',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r1-list-child' }),
      });
      expect(childRes.status).toBe(201);
      const childAddr = ((await childRes.json()) as { address: string }).address;
      const list = await app.request('/v1/identities', {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        identities: Array<{ address: string; parentIdentity?: string }>;
      };
      const row = body.identities.find((i) => i.address === childAddr);
      expect(row?.parentIdentity).toBe(parent.address);
    });

    test('F7: parentIdentity 审计 scrub maxLen 320', async () => {
      const { recordAuditEvent, readAuditEvents, scrubAuditField } = await import(
        '../src/lib/audit.ts'
      );
      const long = `${'a'.repeat(300)}@test.example`;
      expect(long.length).toBeGreaterThan(256);
      expect(scrubAuditField(long, 320).length).toBe(long.length);
      expect(scrubAuditField(long, 320).length).toBeLessThanOrEqual(320);
      recordAuditEvent({
        event: 'identity.create',
        address: 'child@test.example',
        parentIdentity: long,
        outcome: 'ok',
      });
      const events = readAuditEvents({ event: 'identity.create' });
      const hit = events.find((e) => e.parentIdentity === long);
      expect(hit?.parentIdentity).toBe(long);
    });
  });

  describe('#275 R2 闸变修复', () => {
    test('F9: createDelegation 拒 messages:send；load 剔除后 read 授权不 409', async () => {
      const {
        createDelegation,
        findActiveDelegation,
        listDelegations,
        invalidateDelegationStoreCache,
        DELEGATION_STORE_SCHEMA_VERSION,
      } = await import('../src/lib/delegations.ts');
      const owner = createIdentity({ localpart: 'r2-f9-owner' })!;
      const grantee = createIdentity({ localpart: 'r2-f9-grantee' })!;

      // ① 内部路径仅 messages:send → 过滤后空 → 抛
      expect(() =>
        createDelegation({
          mailbox: owner.identity.address,
          grantee: grantee.identity.address,
          scopes: ['messages:send'],
          createdBy: 'admin',
        }),
      ).toThrow(/invalid_scopes/);

      // ② 手工植入含 messages:send 的 grant → load 后不 active
      const storePath = join(config.dataDir, 'delegations.json');
      writeFileSync(
        storePath,
        JSON.stringify(
          {
            schemaVersion: DELEGATION_STORE_SCHEMA_VERSION,
            grants: [
              {
                id: 'delg_r2_send_only',
                mailbox: owner.identity.address,
                grantee: grantee.identity.address,
                scopes: ['messages:send'],
                createdAt: '2026-09-22T00:00:00Z',
                createdBy: 'admin',
                revokedAt: null,
                revokedBy: null,
              },
            ],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      invalidateDelegationStoreCache();
      expect(listDelegations().some((g) => g.id === 'delg_r2_send_only')).toBe(false);
      expect(
        findActiveDelegation(owner.identity.address, grantee.identity.address),
      ).toBeUndefined();

      // ③ 后续合法 read 授权 → 201 不 409
      const ok = await app.request('/v1/delegations', {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({
          mailbox: owner.identity.address,
          grantee: grantee.identity.address,
          scopes: ['read:messages'],
        }),
      });
      expect(ok.status).toBe(201);
    });

    test('F10: mail_list_identities 含子 parentIdentity 过 MCP schema', async () => {
      const parent = await mintParent('r2-f10-parent', [
        'identities:create',
        'read:messages',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r2-f10-child' }),
      });
      expect(childRes.status).toBe(201);
      const childAddr = ((await childRes.json()) as { address: string }).address;

      async function readMcpJson(res: Response): Promise<unknown> {
        const text = await res.text();
        const dataLines = text
          .split('\n')
          .filter((line) => line.startsWith('data:') || line.startsWith('data: '));
        if (dataLines.length > 0) {
          const last = dataLines[dataLines.length - 1]!;
          const payload = last.startsWith('data: ') ? last.slice(6) : last.slice(5);
          return JSON.parse(payload.trim());
        }
        return JSON.parse(text);
      }

      const listTools = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(listTools.status).toBe(200);
      const toolsData = (await readMcpJson(listTools)) as {
        result?: {
          tools?: Array<{
            name: string;
            outputSchema?: { properties?: Record<string, unknown> };
          }>;
        };
      };
      const listTool = toolsData.result?.tools?.find((t) => t.name === 'mail_list_identities');
      expect(listTool?.outputSchema?.properties?.identities).toBeDefined();
      // identities items → parentIdentity optional on identity object
      const idProps = (
        listTool?.outputSchema?.properties?.identities as {
          items?: { properties?: Record<string, unknown> };
        }
      )?.items?.properties;
      expect(idProps).toHaveProperty('parentIdentity');

      const call = await app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'mail_list_identities', arguments: {} },
        }),
      });
      expect(call.status).toBe(200);
      const payload = (await readMcpJson(call)) as {
        result?: {
          isError?: boolean;
          structuredContent?: {
            identities?: Array<{ address: string; parentIdentity?: string }>;
          };
        };
        error?: unknown;
      };
      expect(payload.error).toBeUndefined();
      expect(payload.result?.isError).toBeFalsy();
      const row = payload.result?.structuredContent?.identities?.find(
        (i) => i.address === childAddr,
      );
      expect(row?.parentIdentity).toBe(parent.address);
    });

    test('F11: client 序列化 canNotifyUser=false → REST 403（与直连一致）', async () => {
      const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');
      const parent = await mintParent('r2-f11-parent', [
        'identities:create',
        'read:messages',
      ]);
      let capturedBody: unknown;
      const client = new OpenAgentEmailClient(
        'http://test.local',
        parent.token,
        (input, init) => {
          capturedBody = JSON.parse(String(init?.body ?? '{}'));
          if (input instanceof Request) return app.fetch(new Request(input, init));
          return app.fetch(new Request(input.toString(), init));
        },
      );
      await expect(
        client.createIdentity({ localpart: 'r2-f11-child', canNotifyUser: false }),
      ).rejects.toThrow();
      expect(capturedBody).toEqual(
        expect.objectContaining({ localpart: 'r2-f11-child', canNotifyUser: false }),
      );
      // 直连 REST 同结果
      const rest = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r2-f11-rest', canNotifyUser: false }),
      });
      expect(rest.status).toBe(403);
      expect(await rest.json()).toEqual({
        error: 'forbidden: admin key required for canNotifyUser',
      });
    });
  });

  describe('#275 R3 闸变修复', () => {
    test('F12a: 悬空子 rotate → 400；正常子 rotate 不回归', async () => {
      const dangling = createIdentity({
        localpart: 'r3-f12a-dangling',
        parentIdentity: 'missing-parent@test.example',
        scopes: ['read:messages'],
      })!;
      const bad = await app.request(`/v1/identities/${dangling.identity.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({
        error: 'invalid_request',
        details: 'child identity has no existing parent identity',
      });

      const parent = await mintParent('r3-f12a-parent', [
        'identities:create',
        'read:messages',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r3-f12a-child' }),
      });
      expect(childRes.status).toBe(201);
      const childAddr = ((await childRes.json()) as { address: string }).address;
      const ok = await app.request(`/v1/identities/${childAddr}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(ok.status).toBe(200);
    });

    test('F12b: create 同址自愈悬空归属；新身份零继承', async () => {
      const reclaimLp = 'r3-f12b-reclaim';
      const reclaimAddr = `${reclaimLp}@${config.domain}`;
      const stale = createIdentity({
        localpart: 'r3-f12b-stale',
        parentIdentity: reclaimAddr,
        scopes: ['read:messages'],
      })!;
      expect(findIdentity(stale.identity.address)?.parentIdentity).toBe(reclaimAddr);

      const created = createIdentity({
        localpart: reclaimLp,
        scopes: ['read:messages', 'messages:send', 'identities:create'],
      })!;
      expect(created.identity.address).toBe(reclaimAddr);
      expect(findIdentity(stale.identity.address)?.parentIdentity).toBeUndefined();

      const list = await app.request(`/v1/messages?address=${stale.identity.address}`, {
        headers: { authorization: `Bearer ${created.token}` },
      });
      expect(list.status).toBe(403);
      const send = await app.request('/v1/send', {
        method: 'POST',
        headers: authJson(created.token),
        body: JSON.stringify({
          from: stale.identity.address,
          to: 'rcpt@example.net',
          subject: 'no-adopt',
          text: 'x',
        }),
      });
      expect(send.status).toBe(403);

      // ③ 无悬空时 create 行为不变
      const plain = createIdentity({ localpart: 'r3-f12b-plain' })!;
      expect(plain.identity.parentIdentity).toBeUndefined();
      expect(findIdentity(plain.identity.address)?.address).toBe(plain.identity.address);
    });

    test('F13: body 后重解析 — 删父→401；scopes 收窄后旧能力不放行', async () => {
      const parent = await mintParent('r3-f13-parent', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);

      // ② 分块慢传：body 读完前删父 → 重解析 401，无子产生
      const encoder = new TextEncoder();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('{"localpart":"r3-f13-slow"'));
          await gate;
          controller.enqueue(encoder.encode('}'));
          controller.close();
        },
      });
      const slowPromise = app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${parent.token}`,
          'content-type': 'application/json',
        },
        body: stream,
      });
      await Bun.sleep(30);
      expect(deleteIdentity(parent.address)).toBe(true);
      release();
      const slowRes = await slowPromise;
      expect(slowRes.status).toBe(401);
      expect(await slowRes.json()).toEqual({ error: 'unauthorized' });
      expect(findIdentity(`r3-f13-slow@${config.domain}`)).toBeUndefined();

      // ③ 父 scopes 收窄（当前 live scopes 无 messages:send）→ 403
      const narrow = await mintParent('r3-f13-narrow', [
        'identities:create',
        'read:messages',
      ]);
      const exceed = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(narrow.token),
        body: JSON.stringify({
          localpart: 'r3-f13-exceed',
          scopes: ['messages:send'],
        }),
      });
      expect(exceed.status).toBe(403);
      expect(await exceed.json()).toEqual({
        error: 'forbidden: scope exceeds parent permissions',
      });

      // ① 正常创建回归
      const ok = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(narrow.token),
        body: JSON.stringify({ localpart: 'r3-f13-ok' }),
      });
      expect(ok.status).toBe(201);
    });

    test('F14: cascade 失败不污染子缓存；正常删除仍清归属', async () => {
      const { invalidateDelegationStoreCache } = await import('../src/lib/delegations.ts');
      const parent = createIdentity({
        localpart: 'r3-f14-parent',
        scopes: ['identities:create', 'read:messages'],
      })!;
      const child = createIdentity({
        localpart: 'r3-f14-child',
        parentIdentity: parent.identity.address,
        scopes: ['read:messages'],
      })!;
      expect(findIdentity(child.identity.address)?.parentIdentity).toBe(
        parent.identity.address,
      );

      // ① cascade 失败：delegations.json 损坏 → 抛错；子对象未改
      const delgPath = join(config.dataDir, 'delegations.json');
      writeFileSync(delgPath, 'CORRUPTED_JSON{', { mode: 0o600 });
      invalidateDelegationStoreCache();
      expect(() => deleteIdentity(parent.identity.address)).toThrow(
        'delegation_store_corrupt',
      );
      expect(findIdentity(parent.identity.address)).toBeDefined();
      expect(findIdentity(child.identity.address)?.parentIdentity).toBe(
        parent.identity.address,
      );

      // 修复 store 后正常删除
      writeFileSync(
        delgPath,
        JSON.stringify({ schemaVersion: 1, grants: [] }, null, 2),
        { mode: 0o600 },
      );
      invalidateDelegationStoreCache();
      expect(deleteIdentity(parent.identity.address)).toBe(true);
      expect(findIdentity(parent.identity.address)).toBeUndefined();
      expect(findIdentity(child.identity.address)?.parentIdentity).toBeUndefined();
    });
  });

  describe('#275 R4 闸变修复', () => {
    test('F15: 空 body 悬空子 rotate → 400；正常子空 body → 200；显式违规不回归', async () => {
      // ① 悬空子空 body：路由层检查被跳过，store 层兜住
      const dangling = createIdentity({
        localpart: 'r4-f15-dangling',
        parentIdentity: 'ghost-parent@test.example',
        scopes: ['read:messages'],
      })!;
      const emptyBad = await app.request(`/v1/identities/${dangling.identity.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: '',
      });
      expect(emptyBad.status).toBe(400);
      expect(await emptyBad.json()).toEqual({
        error: 'invalid_request',
        details: 'child identity has no existing parent identity',
      });
      // 拒绝后旧 token 仍可用（未 mutate）
      expect(findIdentityByToken(dangling.token)).toBeDefined();

      // ③ 正常子空 body → 200 保留 scopes
      const parent = await mintParent('r4-f15-parent', [
        'identities:create',
        'read:messages',
        'messages:send',
      ]);
      const childRes = await app.request('/v1/identities', {
        method: 'POST',
        headers: authJson(parent.token),
        body: JSON.stringify({ localpart: 'r4-f15-child', scopes: ['read:messages'] }),
      });
      expect(childRes.status).toBe(201);
      const child = (await childRes.json()) as { address: string; token: string };
      const emptyOk = await app.request(`/v1/identities/${child.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: '',
      });
      expect(emptyOk.status).toBe(200);
      const emptyBody = (await emptyOk.json()) as { token: string; scopes?: string[] };
      expect(emptyBody.token.startsWith('oa_')).toBe(true);
      expect(emptyBody.scopes).toEqual(['read:messages']);

      // ④ 显式违规 REST 不回归
      const rotCreate = await app.request(`/v1/identities/${child.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['identities:create'] }),
      });
      expect(rotCreate.status).toBe(400);
      expect(await rotCreate.json()).toEqual({
        error: 'invalid_request',
        details: 'identities:create cannot be granted to child identities',
      });

      await app.request(`/v1/identities/${parent.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['identities:create', 'read:messages'] }),
      });
      const rotExceed = await app.request(`/v1/identities/${child.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: ['messages:send'] }),
      });
      expect(rotExceed.status).toBe(403);
      expect(await rotExceed.json()).toEqual({
        error: 'forbidden: scope exceeds parent permissions',
      });

      const rotNull = await app.request(`/v1/identities/${child.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: JSON.stringify({ scopes: null }),
      });
      expect(rotNull.status).toBe(400);
      expect(await rotNull.json()).toEqual({
        error: 'invalid_request',
        details: 'child identity cannot be reset to an unscoped token',
      });

      // ⑤ admin 非子身份 rotate 不回归
      const plain = createIdentity({ localpart: 'r4-f15-plain', scopes: ['read:messages'] })!;
      const plainRot = await app.request(`/v1/identities/${plain.identity.address}/token`, {
        method: 'POST',
        headers: authJson(adminKey),
        body: '',
      });
      expect(plainRot.status).toBe(200);
      expect(((await plainRot.json()) as { scopes: string[] }).scopes).toEqual(['read:messages']);

      // store 直调：显式违规同样拒（UI 路径同源）
      const storeCreate = rotateIdentityTokenDetailed(child.address, ['identities:create']);
      expect(storeCreate).toMatchObject({
        ok: false,
        error: 'child_scope_invalid',
        status: 400,
      });
      const storeNull = rotateIdentityTokenDetailed(child.address, null);
      expect(storeNull).toMatchObject({
        ok: false,
        error: 'child_scope_invalid',
        status: 400,
        body: {
          error: 'invalid_request',
          details: 'child identity cannot be reset to an unscoped token',
        },
      });
    });
  });
});
