import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-scope-test';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.MCP_PUBLIC_URL = 'http://localhost';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-scopes-test-'));

const { beforeAll, describe, expect, mock, spyOn, test } = await import('bun:test');

let fakeMessages: any[] = [
  {
    uid: 101,
    flags: new Set(),
    envelope: {
      date: new Date('2026-09-01T00:00:00Z'),
      subject: 'Hello scoped reader',
      from: [{ address: 'sender@example.net', name: 'Sender' }],
      to: [{ address: 'reader@test.example', name: 'Reader' }],
    },
    internalDate: new Date('2026-09-01T00:00:00Z'),
    source: Buffer.from(
      'From: sender@example.net\r\nTo: reader@test.example\r\nSubject: Hello scoped reader\r\n\r\nTest body content',
    ),
  },
];

class FakeImapFlow extends EventEmitter {
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
    return {
      ...msg,
      source: msg.source ?? Buffer.from('From: sender@example.net\r\n\r\nbody'),
    };
  }
  async messageFlagsAdd() {}
  async messageFlagsRemove() {}
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));
const sendMailMock = mock(async () => ({ messageId: '<test-send@test.example>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail: sendMailMock }));

const { config } = await import('../src/lib/config.ts');
const { createApp } = await import('../src/app.ts');
const identitiesModule = await import('../src/lib/identities.ts');
const {
  createIdentity,
  findIdentity,
  findIdentityByToken,
  listIdentities,
  rotateIdentityToken,
  validateScopesInput,
  SUPPORTED_SCOPES,
} = await import('../src/lib/identities.ts');
const {
  resolveAccessToken,
  resolveToken,
  resolveUiSessionToken,
  resolveUiSessionTokenByHash,
} = await import('../src/lib/auth.ts');
const { createHash } = await import('node:crypto');
const { OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { putAccessTokenForTests } = await import('../src/lib/oauth-store.ts');
const { resolveResourceUri } = await import('../src/lib/oauth-url.ts');

const sha256Hex = (val: string) => createHash('sha256').update(val).digest('hex');
const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: true });

describe('Issue #114: read-only API token scopes', () => {
  describe('Scope validation and registry', () => {
    test('SUPPORTED_SCOPES contains read:messages', () => {
      expect(SUPPORTED_SCOPES).toEqual(['read:messages']);
    });

    test('validateScopesInput accepts valid scopes array and empty array', () => {
      expect(validateScopesInput(['read:messages'])).toEqual({
        ok: true,
        scopes: ['read:messages'],
      });
      expect(validateScopesInput([])).toEqual({
        ok: true,
        scopes: [],
      });
    });

    test('validateScopesInput rejects non-arrays', () => {
      const res = validateScopesInput('read:messages');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('invalid_request');
    });

    test('validateScopesInput rejects duplicate scopes', () => {
      const res = validateScopesInput(['read:messages', 'read:messages']);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('invalid_request');
        expect(res.details).toBe('duplicate_scope');
      }
    });

    test('validateScopesInput rejects unsupported scopes with unsupported_scope', () => {
      const res = validateScopesInput(['unsupported:scope']);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('unsupported_scope');
      }
    });

    test('validateScopesInput rejects oversized scope count or item length', () => {
      const tooMany = Array.from({ length: 11 }, (_, i) => `scope:${i}`);
      const resCount = validateScopesInput(tooMany);
      expect(resCount.ok).toBe(false);
      if (!resCount.ok) expect(resCount.details).toBe('too_many_scopes');

      const longScope = 'a'.repeat(65);
      const resLong = validateScopesInput([longScope]);
      expect(resLong.ok).toBe(false);
      if (!resLong.ok) expect(resLong.details).toBe('invalid_scope_format');
    });
  });

  describe('Identity creation & token rotation with scopes', () => {
    test('createIdentity with absent scopes creates an unscoped token', () => {
      const created = createIdentity({ localpart: 'unscoped-user' })!;
      expect(created).not.toBeNull();
      expect(created.identity.scopes).toBeUndefined();

      const identityInList = listIdentities().find((i) => i.address === created.identity.address)!;
      expect(identityInList.scopes).toBeUndefined();

      const resolved = resolveAccessToken(created.token);
      expect(resolved.status).toBe('ok');
      if (resolved.status === 'ok') {
        expect(resolved.auth.kind).toBe('identity');
        if (resolved.auth.kind === 'identity') {
          expect(resolved.auth.scopes).toBeUndefined();
        }
      }
    });

    test('createIdentity with explicit read:messages stores and surfaces scopes', () => {
      const created = createIdentity({
        localpart: 'scoped-user',
        scopes: ['read:messages'],
      })!;
      expect(created).not.toBeNull();
      expect(created.identity.scopes).toEqual(['read:messages']);

      const identityInList = listIdentities().find((i) => i.address === created.identity.address)!;
      expect(identityInList.scopes).toEqual(['read:messages']);

      const resolved = resolveAccessToken(created.token);
      expect(resolved.status).toBe('ok');
      if (resolved.status === 'ok') {
        expect(resolved.auth.kind).toBe('identity');
        if (resolved.auth.kind === 'identity') {
          expect(resolved.auth.scopes).toEqual(['read:messages']);
        }
      }
    });

    test('createIdentity with explicit empty array [] stores scopes: []', () => {
      const created = createIdentity({
        localpart: 'empty-scope-user',
        scopes: [],
      })!;
      expect(created).not.toBeNull();
      expect(created.identity.scopes).toEqual([]);

      const identityInList = listIdentities().find((i) => i.address === created.identity.address)!;
      expect(identityInList.scopes).toEqual([]);

      const resolved = resolveAccessToken(created.token);
      expect(resolved.status).toBe('ok');
      if (resolved.status === 'ok') {
        expect(resolved.auth.kind).toBe('identity');
        if (resolved.auth.kind === 'identity') {
          expect(resolved.auth.scopes).toEqual([]);
        }
      }
    });

    test('POST /v1/identities returns scopes only when present, rejects invalid scopes', async () => {
      // 1. Unscoped creation
      const resUnscoped = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ localpart: 'rest-unscoped' }),
      });
      expect(resUnscoped.status).toBe(201);
      const dataUnscoped = (await resUnscoped.json()) as { scopes?: string[] };
      expect(dataUnscoped.scopes).toBeUndefined();

      // 2. Scoped creation
      const resScoped = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localpart: 'rest-scoped',
          scopes: ['read:messages'],
        }),
      });
      expect(resScoped.status).toBe(201);
      const dataScoped = (await resScoped.json()) as { scopes?: string[] };
      expect(dataScoped.scopes).toEqual(['read:messages']);

      // 3. Scoped with empty array
      const resEmpty = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localpart: 'rest-empty',
          scopes: [],
        }),
      });
      expect(resEmpty.status).toBe(201);
      const dataEmpty = (await resEmpty.json()) as { scopes?: string[] };
      expect(dataEmpty.scopes).toEqual([]);

      // 4. Unsupported scope rejection
      const resBad = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localpart: 'rest-bad',
          scopes: ['write:all'],
        }),
      });
      expect(resBad.status).toBe(400);
      expect(await resBad.json()).toEqual({
        error: 'unsupported_scope',
        details: 'Unsupported scope: write:all',
      });
      expect(findIdentity(`rest-bad@${config.domain}`)).toBeUndefined();

      // 5. Duplicate scope rejection
      const resDup = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localpart: 'rest-dup',
          scopes: ['read:messages', 'read:messages'],
        }),
      });
      expect(resDup.status).toBe(400);
      expect(findIdentity(`rest-dup@${config.domain}`)).toBeUndefined();
    });

    test('POST /v1/identities rejects misspelled or unknown fields without minting a full token', async () => {
      for (const [localpart, extra] of [
        ['rest-scope-typo', { scope: ['read:messages'] }],
        ['rest-scope-unknown', { unexpected: true }],
      ] as const) {
        const response = await app.request('/v1/identities', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${adminKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ localpart, ...extra }),
        });
        expect(response.status).toBe(400);
        expect(findIdentity(`${localpart}@${config.domain}`)).toBeUndefined();
      }
    });

    test('POST /v1/identities/:address/token rotation with absent vs explicit scopes', async () => {
      const created = createIdentity({
        localpart: 'rotate-target',
        scopes: ['read:messages'],
      })!;
      const addr = created.identity.address;

      // 1. Rotation with absent body -> preserves existing scopes
      const resPreserve = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(resPreserve.status).toBe(200);
      const dataPreserve = (await resPreserve.json()) as { token: string; scopes?: string[] };
      expect(dataPreserve.token).toBeTruthy();
      expect(dataPreserve.scopes).toEqual(['read:messages']);
      expect(findIdentity(addr)!.scopes).toEqual(['read:messages']);

      // Verify the new token has preserved scopes
      const resAuthPreserve = resolveAccessToken(dataPreserve.token);
      expect(resAuthPreserve.status).toBe('ok');
      if (resAuthPreserve.status === 'ok') {
        expect((resAuthPreserve.auth as any).scopes).toEqual(['read:messages']);
      }

      // 2. Rotation with explicit {"scopes": null} -> resets to unscoped full-permission token
      const resReset = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: null }),
      });
      expect(resReset.status).toBe(200);
      const dataReset = (await resReset.json()) as { token: string; scopes?: string[] };
      expect(dataReset.token).toBeTruthy();
      expect(dataReset.scopes).toBeUndefined();
      expect(findIdentity(addr)!.scopes).toBeUndefined();

      // Verify the new token is unscoped
      const resAuthReset = resolveAccessToken(dataReset.token);
      expect(resAuthReset.status).toBe('ok');
      if (resAuthReset.status === 'ok') {
        expect((resAuthReset.auth as any).scopes).toBeUndefined();
      }

      // 3. Rotation with explicit read:messages
      const resScoped = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(resScoped.status).toBe(200);
      const dataScoped = (await resScoped.json()) as { scopes?: string[] };
      expect(dataScoped.scopes).toEqual(['read:messages']);
      expect(findIdentity(addr)!.scopes).toEqual(['read:messages']);

      // 3. Rotation with explicit []
      const resEmpty = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(resEmpty.status).toBe(200);
      const dataEmpty = (await resEmpty.json()) as { scopes?: string[] };
      expect(dataEmpty.scopes).toEqual([]);
      expect(findIdentity(addr)!.scopes).toEqual([]);

      // 4. Rotation with invalid scopes fails with 400 and does not mutate old token
      const oldTokenHash = findIdentity(addr)!.tokenHash;
      const resInvalid = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['invalid:scope'] }),
      });
      expect(resInvalid.status).toBe(400);
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);
      expect(findIdentity(addr)!.scopes).toEqual([]);

      // 5. Rotation with malformed nonempty JSON returns 400 invalid_json without mutating token
      const resMalformed = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: '{"scopes": [not-valid-json',
      });
      expect(resMalformed.status).toBe(400);
      expect(await resMalformed.json()).toEqual({ error: 'invalid_json' });
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);

      // 6. Rotation with non-object JSON returns 400 invalid_request without mutating token
      const resNonObj = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: '["read:messages"]',
      });
      expect(resNonObj.status).toBe(400);
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);

      // 7. Rotation with typo field (e.g. "scpoes") returns 400 and does NOT mint unscoped token
      const resTypo = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scpoes: ['read:messages'] }),
      });
      expect(resTypo.status).toBe(400);
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);
      expect(findIdentity(addr)!.scopes).toEqual([]);

      // 8. Rotation with unknown extra field returns 400 and does NOT mutate token
      const resUnknown = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ foo: 1 }),
      });
      expect(resUnknown.status).toBe(400);
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);
      expect(findIdentity(addr)!.scopes).toEqual([]);

      // 9. Rotation with nonempty body containing empty object {} returns 400 (strict schema requires scopes)
      const resEmptyObj = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(resEmptyObj.status).toBe(400);
      expect(findIdentity(addr)!.tokenHash).toBe(oldTokenHash);
      expect(findIdentity(addr)!.scopes).toEqual([]);
    });

    test('OpenAgentEmailClient forwards scopes on token rotation', async () => {
      const created = createIdentity({ localpart: 'client-rotate-scope' })!;
      const client = new OpenAgentEmailClient(
        'http://localhost',
        adminKey,
        (input, init) => {
          if (input instanceof Request) return app.fetch(new Request(input, init));
          return app.fetch(new Request(input.toString(), init));
        },
      );
      const rotated = await client.rotateIdentityToken(created.identity.address, {
        scopes: ['read:messages'],
      });
      expect(rotated.scopes).toEqual(['read:messages']);
      expect(findIdentityByToken(rotated.token)?.scopes).toEqual(['read:messages']);
    });
  });

  describe('Persistence and future scope compatibility', () => {
    test('persisted scoped token reloads with identical scopes', () => {
      const created = createIdentity({
        localpart: 'persist-scope',
        scopes: ['read:messages'],
      })!;
      const addr = created.identity.address;

      const loaded = findIdentity(addr);
      expect(loaded?.scopes).toEqual(['read:messages']);

      const resolved = findIdentityByToken(created.token);
      expect(resolved?.scopes).toEqual(['read:messages']);
    });

    test('structurally valid future/unknown scope loads safely and fails closed on all routes', async () => {
      // Simulate a newer version writing a future scope to the identities file
      const storePath = join(config.dataDir, 'identities.json');
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      const futureToken = 'oa_future_token_12345678901234567890';
      const futureHash = sha256Hex(futureToken);
      const futureIdentity = {
        address: `future@${config.domain}`,
        createdAt: new Date().toISOString(),
        tokenHash: futureHash,
        scopes: ['read:messages', 'future:delegation:read'],
      };
      raw.push(futureIdentity);
      writeFileSync(storePath, JSON.stringify(raw, null, 2));

      // The store must NOT be corrupt: other identities and future identity load cleanly
      const loaded = findIdentity(`future@${config.domain}`);
      expect(loaded).toBeDefined();
      expect(loaded?.scopes).toEqual(['read:messages', 'future:delegation:read']);

      // Attempting to use this token must FAIL CLOSED on all routes (even message reads)
      const resList = await app.request(`/v1/messages?address=future@${config.domain}`, {
        headers: { authorization: `Bearer ${futureToken}` },
      });
      expect(resList.status).toBe(403);
      expect(await resList.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      const resSend = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${futureToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: `future@${config.domain}`,
          to: 'recipient@example.net',
          subject: 'Hi',
          text: 'Body',
        }),
      });
      expect(resSend.status).toBe(403);
      expect(await resSend.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('malformed scope field fails closed as identity_store_corrupt', () => {
      const storePath = join(config.dataDir, 'identities.json');
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      raw.push({
        address: `corrupt-scope@${config.domain}`,
        createdAt: new Date().toISOString(),
        tokenHash: 'abc',
        scopes: 'not-an-array', // Malformed!
      });
      writeFileSync(storePath, JSON.stringify(raw, null, 2));

      try {
        expect(() => listIdentities()).toThrow('identity_store_corrupt');
      } finally {
        const cleaned = raw.filter((i: any) => i.address !== `corrupt-scope@${config.domain}`);
        writeFileSync(storePath, JSON.stringify(cleaned, null, 2));
      }
    });
  });

  describe('Route authorization: read:messages permissions and denials', () => {
    let scopedReaderToken: string;
    let readerAddress: string;

    beforeAll(() => {
      const created = createIdentity({
        localpart: 'reader',
        scopes: ['read:messages'],
      })!;
      scopedReaderToken = created.token;
      readerAddress = created.identity.address;
    });

    test('read:messages permits GET /v1/messages for own address', async () => {
      const res = await app.request(`/v1/messages?address=${readerAddress}`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { messages: unknown[] };
      expect(Array.isArray(data.messages)).toBe(true);
    });

    test('read:messages permits GET /v1/messages/:id for own address', async () => {
      const res = await app.request(`/v1/messages/101?address=${readerAddress}`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string; subject: string };
      expect(data.id).toBe('101');
      expect(data.subject).toBe('Hello scoped reader');
    });

    test('read:messages permits POST /v1/messages/wait for own address', async () => {
      // Mock waitForMessage or test wait rejection on timeout
      const res = await app.request('/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          address: readerAddress,
          timeoutSec: 1,
        }),
      });
      // 408 timeout proves scope check passed and reached IMAP wait logic!
      expect([200, 408]).toContain(res.status);
    });

    test('read:messages is denied 403 when attempting to read another mailbox', async () => {
      const otherAddr = 'victim@test.example';
      const resList = await app.request(`/v1/messages?address=${otherAddr}`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resList.status).toBe(403);
      expect(await resList.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      const resGet = await app.request(`/v1/messages/101?address=${otherAddr}`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resGet.status).toBe(403);
      expect(await resGet.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      const resWait = await app.request('/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          address: otherAddr,
          timeoutSec: 1,
        }),
      });
      expect(resWait.status).toBe(403);
      expect(await resWait.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });
    });

    test('read:messages is denied 403 on POST /v1/messages/:id/seen', async () => {
      const res = await app.request('/v1/messages/101/seen', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          address: readerAddress,
          seen: true,
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('read:messages is denied 403 on POST /v1/send before SMTP dispatch', async () => {
      sendMailMock.mockClear();
      const res = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: readerAddress,
          to: 'recipient@example.net',
          subject: 'Unauthorized send',
          text: 'Blocked',
        }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden: insufficient_scope' });
      expect(sendMailMock).toHaveBeenCalledTimes(0);
    });

    test('read:messages is denied 403 on identities management routes', async () => {
      // 1. GET /v1/identities
      const resList = await app.request('/v1/identities', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resList.status).toBe(403);
      expect(await resList.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // 2. POST /v1/identities
      const resCreate = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ localpart: 'cannot-create' }),
      });
      expect(resCreate.status).toBe(403);
      expect(await resCreate.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // 3. POST /v1/identities/:address/token
      const resRotate = await app.request(`/v1/identities/${readerAddress}/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resRotate.status).toBe(403);
      expect(await resRotate.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // 4. DELETE /v1/identities/:address
      const resDelete = await app.request(`/v1/identities/${readerAddress}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resDelete.status).toBe(403);
      expect(await resDelete.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // 5. GET /v1/identities/:address/push-tier
      const resGetTier = await app.request(`/v1/identities/${readerAddress}/push-tier`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resGetTier.status).toBe(403);
      expect(await resGetTier.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // 6. PUT /v1/identities/:address/push-tier
      const resPutTier = await app.request(`/v1/identities/${readerAddress}/push-tier`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ pushContentTier: 1 }),
      });
      expect(resPutTier.status).toBe(403);
      expect(await resPutTier.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('read:messages is denied 403 on notify and device routes', async () => {
      // POST /v1/notify
      const resNotify = await app.request('/v1/notify', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ target: 'user', title: 'Alert', message: 'Hi' }),
      });
      expect(resNotify.status).toBe(403);
      expect(await resNotify.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // GET /v1/notify/messages
      const resNotifyHistory = await app.request('/v1/notify/messages?topic=self', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resNotifyHistory.status).toBe(403);
      expect(await resNotifyHistory.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // GET /v1/notify/devices
      const resGetDev = await app.request('/v1/notify/devices', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resGetDev.status).toBe(403);
      expect(await resGetDev.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // POST /v1/notify/devices
      const resPostDev = await app.request('/v1/notify/devices', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ publicUrl: 'https://ntfy.example.com' }),
      });
      expect(resPostDev.status).toBe(403);
      expect(await resPostDev.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // DELETE /v1/notify/devices/:id
      const resDelDev = await app.request('/v1/notify/devices/dev_123', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resDelDev.status).toBe(403);
      expect(await resDelDev.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // POST /v1/notify/verify
      const resVerify = await app.request('/v1/notify/verify', {
        method: 'POST',
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resVerify.status).toBe(403);
      expect(await resVerify.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('read:messages is denied 403 on tasks and audit routes', async () => {
      const taskId = '00000000-0000-4000-8000-000000000001';
      const expectInsufficientScope = async (response: Response) => {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'forbidden: insufficient_scope' });
      };

      // GET /v1/tasks
      const resTasks = await app.request('/v1/tasks', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resTasks.status).toBe(403);
      expect(await resTasks.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // POST /v1/tasks
      const resCreateTask = await app.request('/v1/tasks', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${scopedReaderToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: 'other@test.example',
          subject: 'Task',
          body: 'Do something',
        }),
      });
      expect(resCreateTask.status).toBe(403);
      expect(await resCreateTask.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // GET /v1/tasks/:id
      const resGetTask = await app.request(`/v1/tasks/${taskId}`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resGetTask.status).toBe(403);
      expect(await resGetTask.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      await expectInsufficientScope(await app.request(`/v1/tasks/${taskId}/children`, {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      }));

      for (const [operation, body] of [
        ['claim', { leaseSec: 60 }],
        ['lease', { leaseToken: 'lease-token', leaseSec: 60 }],
        ['release', { leaseToken: 'lease-token' }],
        ['decision', { decision: 'approved' }],
        ['state', { state: 'working', body: 'Blocked' }],
      ] as const) {
        await expectInsufficientScope(await app.request(`/v1/tasks/${taskId}/${operation}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${scopedReaderToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }));
      }

      // GET /v1/send/history
      const resSendHist = await app.request('/v1/send/history', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resSendHist.status).toBe(403);
      expect(await resSendHist.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      await expectInsufficientScope(await app.request('/v1/send/history/snd_test', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      }));

      // GET /v1/audit/events
      const resAudit = await app.request('/v1/audit/events', {
        headers: { authorization: `Bearer ${scopedReaderToken}` },
      });
      expect(resAudit.status).toBe(403);
      expect(await resAudit.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('empty scopes [] is denied 403 on ALL operations including message reads', async () => {
      const emptyUser = createIdentity({
        localpart: 'zero-perms',
        scopes: [],
      })!;
      const token = emptyUser.token;
      const addr = emptyUser.identity.address;

      const resList = await app.request(`/v1/messages?address=${addr}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(resList.status).toBe(403);
      expect(await resList.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      const resGet = await app.request(`/v1/messages/101?address=${addr}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(resGet.status).toBe(403);
      expect(await resGet.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      const resWait = await app.request('/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: addr, timeoutSec: 1 }),
      });
      expect(resWait.status).toBe(403);
      expect(await resWait.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });
  });

  describe('UI session bypass prevention', () => {
    test('resolveUiSessionToken and resolveUiSessionTokenByHash reject scoped tokens', () => {
      const scopedUser = createIdentity({
        localpart: 'ui-test-scoped',
        scopes: ['read:messages'],
      })!;
      const unscopedUser = createIdentity({
        localpart: 'ui-test-unscoped',
      })!;

      // 1. Scoped token rejected
      expect(resolveUiSessionToken(scopedUser.token)).toBeNull();
      expect(resolveUiSessionTokenByHash(sha256Hex(scopedUser.token))).toBeNull();

      // 2. Unscoped token accepted
      expect(resolveUiSessionToken(unscopedUser.token)).toEqual({
        kind: 'identity',
        address: unscopedUser.identity.address,
      });
      expect(resolveUiSessionTokenByHash(sha256Hex(unscopedUser.token))).toEqual({
        kind: 'identity',
        address: unscopedUser.identity.address,
      });

      // 3. Admin key accepted
      expect(resolveUiSessionToken(adminKey)).toEqual({ kind: 'admin' });
      expect(resolveUiSessionTokenByHash(sha256Hex(adminKey))).toEqual({ kind: 'admin' });
    });

    test('POST /ui/api/session rejects scoped token with 401 invalid_token', async () => {
      const scopedUser = createIdentity({
        localpart: 'ui-api-scoped',
        scopes: ['read:messages'],
      })!;
      const unscopedUser = createIdentity({
        localpart: 'ui-api-unscoped',
      })!;

      // Scoped login attempt
      const resScoped = await app.request('/ui/api/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ token: scopedUser.token }),
      });
      expect(resScoped.status).toBe(401);
      expect(await resScoped.json()).toEqual({ error: 'invalid_token' });

      // Unscoped login attempt
      const resUnscoped = await app.request('/ui/api/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ token: unscopedUser.token }),
      });
      expect(resUnscoped.status).toBe(200);
      const dataUnscoped = await resUnscoped.json();
      expect(dataUnscoped).toEqual({
        kind: 'identity',
        address: unscopedUser.identity.address,
      });
    });

    test('dashboard token rotation preserves existing scope restrictions', async () => {
      const scopedUser = createIdentity({
        localpart: 'ui-rotate-scoped',
        scopes: ['read:messages'],
      })!;
      const oldToken = scopedUser.token;
      const login = await app.request('/ui/api/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ token: adminKey }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
      expect(cookie).toBeTruthy();

      const rotated = await app.request(
        `/ui/api/identities/${encodeURIComponent(scopedUser.identity.address)}/token`,
        {
          method: 'POST',
          headers: {
            cookie: cookie!,
            origin: 'http://localhost',
          },
        },
      );
      expect(rotated.status).toBe(200);
      const data = (await rotated.json()) as { address: string; token: string; scopes?: string[] };
      expect(data.address).toBe(scopedUser.identity.address);
      expect(data.scopes).toEqual(['read:messages']);
      expect(findIdentityByToken(data.token)?.scopes).toEqual(['read:messages']);
      expect(findIdentityByToken(oldToken)).toBeUndefined();

      const denied = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${data.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: scopedUser.identity.address,
          to: 'recipient@example.net',
          subject: 'Still blocked after rotation',
          text: 'Blocked',
        }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });
  });

  describe('MCP loopback and body-limit safety', () => {
    async function readMcpJson(res: Response): Promise<unknown> {
      const text = await res.text();
      const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) return JSON.parse(dataLine.slice('data: '.length));
      return JSON.parse(text);
    }

    function mcpRequest(token: string, method: string, params: Record<string, unknown> = {}) {
      return app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
      });
    }

    function mcpCall(token: string, name: string, args: Record<string, unknown> = {}) {
      return mcpRequest(token, 'tools/call', { name, arguments: args });
    }

    test('MCP advertises and enforces the canonical scope input constraints', async () => {
      const resList = await mcpRequest(adminKey, 'tools/list');
      expect(resList.status).toBe(200);
      const listData = (await readMcpJson(resList)) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: {
              properties?: Record<string, {
                type?: string;
                items?: { enum?: string[] };
                maxItems?: number;
              }>;
            };
          }>;
        };
      };
      const createTool = listData.result?.tools?.find((tool) => tool.name === 'mail_new_identity');
      expect(createTool).toBeDefined();
      expect(createTool?.inputSchema?.properties?.scopes).toMatchObject({
        type: 'array',
        items: { enum: ['read:messages'] },
        maxItems: 10,
      });

      for (const [localpart, scopes] of [
        ['mcp-unsupported-scope', ['write:all']],
        ['mcp-duplicate-scope', ['read:messages', 'read:messages']],
      ] as const) {
        const response = await mcpCall(adminKey, 'mail_new_identity', { localpart, scopes });
        expect(response.status).toBe(200);
        const data = (await readMcpJson(response)) as {
          error?: { code?: number };
          result?: { isError?: boolean; content?: Array<{ text?: string }> };
        };
        if (data.error) {
          expect(data.error.code).toBe(-32602);
        } else {
          expect(data.result?.isError).toBe(true);
          expect(data.result?.content?.[0]?.text).toMatch(/invalid|duplicate/i);
        }
        expect(findIdentity(`${localpart}@${config.domain}`)).toBeUndefined();
      }
    });

    test('MCP mail_new_identity preserves requested scopes end to end', async () => {
      const resMint = await mcpCall(adminKey, 'mail_new_identity', {
        localpart: 'mcp-minted-reader',
        scopes: ['read:messages'],
      });
      expect(resMint.status).toBe(200);
      const mintData = (await readMcpJson(resMint)) as any;
      expect(mintData.result.isError).toBeFalsy();
      const minted = mintData.result.structuredContent as {
        address: string;
        token: string;
        scopes: string[];
      };
      expect(minted.scopes).toEqual(['read:messages']);
      expect(findIdentity(minted.address)?.scopes).toEqual(['read:messages']);

      const resRead = await app.request(`/v1/messages?address=${minted.address}`, {
        headers: { authorization: `Bearer ${minted.token}` },
      });
      expect(resRead.status).toBe(200);

      sendMailMock.mockClear();
      const resWrite = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${minted.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: minted.address,
          to: 'recipient@example.net',
          subject: 'Blocked scoped send',
          text: 'Blocked',
        }),
      });
      expect(resWrite.status).toBe(403);
      expect(await resWrite.json()).toEqual({ error: 'forbidden: insufficient_scope' });
      expect(sendMailMock).toHaveBeenCalledTimes(0);
    });

    test('MCP tool execution loops back to REST and enforces scopes', async () => {
      const scopedUser = createIdentity({
        localpart: 'mcp-reader',
        scopes: ['read:messages'],
      })!;

      fakeMessages.push({
        uid: 102,
        flags: new Set(),
        envelope: {
          date: new Date('2026-09-01T00:00:00Z'),
          subject: 'MCP test message',
          from: [{ address: 'sender@example.net', name: 'Sender' }],
          to: [{ address: scopedUser.identity.address, name: 'MCP Reader' }],
        },
        internalDate: new Date('2026-09-01T00:00:00Z'),
        source: Buffer.from(
          `From: sender@example.net\r\nTo: ${scopedUser.identity.address}\r\nSubject: MCP test message\r\n\r\nBody`,
        ),
      });

      // 1. Allowed read tool: mail_list_messages
      const resList = await mcpCall(scopedUser.token, 'mail_list_messages', {
        address: scopedUser.identity.address,
      });
      expect(resList.status).toBe(200);
      const listData = (await readMcpJson(resList)) as any;
      expect(listData.result).toBeDefined();
      expect(listData.result.isError).toBeFalsy();

      // 2. Allowed read tool: mail_read_message
      const resGet = await mcpCall(scopedUser.token, 'mail_read_message', {
        address: scopedUser.identity.address,
        id: '102',
      });
      expect(resGet.status).toBe(200);
      const getData = (await readMcpJson(resGet)) as any;
      expect(getData.result).toBeDefined();
      expect(getData.result.isError).toBeFalsy();

      // 3. Allowed read tool: mail_wait_for
      const resWait = await mcpCall(scopedUser.token, 'mail_wait_for', {
        address: scopedUser.identity.address,
        timeoutSec: 1,
      });
      expect(resWait.status).toBe(200);
      const waitData = (await readMcpJson(resWait)) as any;
      expect(waitData.result).toBeDefined();
      // timeout returns a response or message without 403 scope rejection
      if (waitData.result.isError) {
        expect(waitData.result.content[0].text).not.toContain('403');
      }

      // 4. Denied write tool: mail_send cannot bypass scope
      const resSend = await mcpCall(scopedUser.token, 'mail_send', {
        from: scopedUser.identity.address,
        to: 'recipient@example.net',
        subject: 'Try MCP bypass',
        text: 'Blocked',
      });
      expect(resSend.status).toBe(200);
      const sendData = (await readMcpJson(resSend)) as any;
      // Tools catch ApiError and return isError: true
      expect(sendData.result.isError).toBe(true);
      expect(sendData.result.content[0].text).toContain('403');
      expect(sendData.result.content[0].text).toContain('forbidden: insufficient_scope');

      // 5. Denied write tool: mail_mark_seen cannot bypass scope
      const resSeen = await mcpCall(scopedUser.token, 'mail_mark_seen', {
        address: scopedUser.identity.address,
        id: '101',
        seen: true,
      });
      expect(resSeen.status).toBe(200);
      const seenData = (await readMcpJson(resSeen)) as any;
      expect(seenData.result.isError).toBe(true);
      expect(seenData.result.content[0].text).toContain('403');
      expect(seenData.result.content[0].text).toContain('forbidden: insufficient_scope');

      // 6. Denied write tool: task_create cannot bypass scope
      const resTask = await mcpCall(scopedUser.token, 'task_create', {
        to: 'other@test.example',
        subject: 'Try MCP task create',
        body: 'Blocked',
      });
      expect(resTask.status).toBe(200);
      const taskData = (await readMcpJson(resTask)) as any;
      expect(taskData.result.isError).toBe(true);
      expect(taskData.result.content[0].text).toContain('403');
      expect(taskData.result.content[0].text).toContain('forbidden: insufficient_scope');

      // A scoped token cannot mint another identity through the MCP tool.
      const resMint = await mcpCall(scopedUser.token, 'mail_new_identity', {
        localpart: 'mcp-escalation-attempt',
      });
      expect(resMint.status).toBe(200);
      const mintData = (await readMcpJson(resMint)) as any;
      expect(mintData.result.isError).toBe(true);
      expect(mintData.result.content[0].text).toContain('forbidden: insufficient_scope');
      expect(findIdentity(`mcp-escalation-attempt@${config.domain}`)).toBeUndefined();
    });

    test('bad-auth-before-scope: bad token returns 401 unauthorized before scope checks', async () => {
      // POST /v1/send with bad token -> 401 unauthorized (not 403)
      const resSend = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: 'Bearer bad-token-12345',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: 'someone@test.example',
          to: 'recipient@example.net',
          subject: 'test',
          text: 'test',
        }),
      });
      expect(resSend.status).toBe(401);
      expect(await resSend.json()).toEqual({ error: 'unauthorized' });

      // GET /v1/messages with bad token -> 401 unauthorized (not 403)
      const resMessages = await app.request('/v1/messages?address=someone@test.example', {
        headers: { authorization: 'Bearer bad-token-12345' },
      });
      expect(resMessages.status).toBe(401);
      expect(await resMessages.json()).toEqual({ error: 'unauthorized' });
    });

    test('body limit 413 triggers before authentication and scope checks', async () => {
      // 16MB+ body rejected by bodyLimit
      const hugeBody = JSON.stringify({
        from: 'reader@test.example',
        to: 'recipient@example.net',
        subject: 'huge',
        text: 'x'.repeat(17 * 1024 * 1024),
      });
      const res = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: 'Bearer bad-token',
          'content-type': 'application/json',
        },
        body: hugeBody,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'request_too_large' });
    });
  });

  describe('Issue #127: OAuth channel inherits identity scopes and audit events', () => {
    const resource = resolveResourceUri('http://localhost');

    function getAuditLogs(): any[] {
      const p = join(config.dataDir, 'audit.jsonl');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    }

    test('1. OAuth access token inherits scoped identity scopes and is intercepted by scope policy', async () => {
      const created = createIdentity({
        localpart: 'oauth-scoped-user',
        scopes: ['read:messages'],
      })!;
      const oauthToken = 'oa_oauth_scoped_token_12345';
      putAccessTokenForTests({
        token: oauthToken,
        grantId: 'grant-oauth-scoped-1',
        address: created.identity.address,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-1', clientName: 'Client 1' },
      });

      // Verification: resolveAccessToken inherits scopes
      const authRes = resolveAccessToken(oauthToken, { resource });
      expect(authRes.status).toBe('ok');
      if (authRes.status === 'ok') {
        expect(authRes.auth.kind).toBe('identity');
        expect((authRes.auth as any).scopes).toEqual(['read:messages']);
      }

      // Read operation allowed
      const resRead = await app.request(`/v1/messages?address=${created.identity.address}`, {
        headers: { authorization: `Bearer ${oauthToken}` },
      });
      expect(resRead.status).toBe(200);

      // Write operation denied 403 forbidden: insufficient_scope
      const resSend = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${oauthToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: created.identity.address,
          to: 'recipient@example.net',
          subject: 'OAuth write attempt',
          text: 'Should be denied',
        }),
      });
      expect(resSend.status).toBe(403);
      expect(await resSend.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // Seen status update denied 403
      const resSeen = await app.request(`/v1/messages/101/seen`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${oauthToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: created.identity.address, seen: true }),
      });
      expect(resSeen.status).toBe(403);
      expect(await resSeen.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('2. Revocation sync: rotating identity scopes immediately affects OAuth access token resolution', async () => {
      const created = createIdentity({
        localpart: 'oauth-sync-user',
        scopes: ['read:messages'],
      })!;
      const oauthToken = 'oa_oauth_sync_token_54321';
      putAccessTokenForTests({
        token: oauthToken,
        grantId: 'grant-oauth-sync-2',
        address: created.identity.address,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-sync', clientName: 'Client Sync' },
      });

      // Before rotation: can read messages
      const beforeRes = await app.request(`/v1/messages?address=${created.identity.address}`, {
        headers: { authorization: `Bearer ${oauthToken}` },
      });
      expect(beforeRes.status).toBe(200);

      // Rotate identity token to narrow scopes to empty array []
      const rotateRes = await app.request(`/v1/identities/${created.identity.address}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(rotateRes.status).toBe(200);

      // Now OAuth token immediately inherits [] on resolution and is denied on reads!
      const afterRes = await app.request(`/v1/messages?address=${created.identity.address}`, {
        headers: { authorization: `Bearer ${oauthToken}` },
      });
      expect(afterRes.status).toBe(403);
      expect(await afterRes.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('3. Old data: identity record without scopes field in store yields full power for both OAuth and oa_ tokens', async () => {
      const storePath = join(config.dataDir, 'identities.json');
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      const legacyToken = 'oa_legacy_unscoped_token_999999999999';
      const legacyAddr = `legacy-user@${config.domain}`;
      raw.push({
        address: legacyAddr,
        createdAt: new Date().toISOString(),
        tokenHash: sha256Hex(legacyToken),
      });
      writeFileSync(storePath, JSON.stringify(raw, null, 2));

      // 1. oa_ token has no scopes attached -> full power
      const authOa = resolveAccessToken(legacyToken);
      expect(authOa.status).toBe('ok');
      if (authOa.status === 'ok') {
        expect((authOa.auth as any).scopes).toBeUndefined();
      }

      // 2. OAuth token also has no scopes attached -> full power
      const oauthLegacyToken = 'oa_oauth_legacy_token_88888';
      putAccessTokenForTests({
        token: oauthLegacyToken,
        grantId: 'grant-legacy-3',
        address: legacyAddr,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-legacy', clientName: 'Client Legacy' },
      });

      const authOauth = resolveAccessToken(oauthLegacyToken, { resource });
      expect(authOauth.status).toBe('ok');
      if (authOauth.status === 'ok') {
        expect((authOauth.auth as any).scopes).toBeUndefined();
      }

      // Send mail with OAuth token succeeds (does not hit 403 scope check)
      const resSend = await app.request('/v1/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${oauthLegacyToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: legacyAddr,
          to: 'recipient@example.net',
          subject: 'Legacy full power send',
          text: 'Allowed',
        }),
      });
      expect(resSend.status).toBe(200);
    });

    test('4. Audit events: scope set/changed paths append expected recordAuditEvent rows', async () => {
      // (a) Creation with scopes
      const resCreate = await app.request('/v1/identities', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          localpart: 'audit-user',
          scopes: ['read:messages'],
        }),
      });
      expect(resCreate.status).toBe(201);
      const auditAddr = `audit-user@${config.domain}`;

      let logs = getAuditLogs();
      const createEvent = logs.find((l) => l.address === auditAddr && l.event === 'identity.scopes.create');
      expect(createEvent).toBeDefined();
      expect(createEvent.outcome).toBe('ok');
      expect(createEvent.scopes).toEqual(['read:messages']);

      // (b) Rotation narrowing scopes: ['read:messages'] -> []
      const resNarrow = await app.request(`/v1/identities/${auditAddr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: [] }),
      });
      expect(resNarrow.status).toBe(200);

      logs = getAuditLogs();
      const narrowEvent = logs.find((l) => l.address === auditAddr && l.event === 'identity.scopes.narrow');
      expect(narrowEvent).toBeDefined();
      expect(narrowEvent.outcome).toBe('ok');
      expect(narrowEvent.scopes).toEqual([]);

      // (c) Rotation widening scopes: [] -> ['read:messages']
      const resWiden = await app.request(`/v1/identities/${auditAddr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(resWiden.status).toBe(200);

      logs = getAuditLogs();
      const widenEvent = logs.find((l) => l.address === auditAddr && l.event === 'identity.scopes.widen');
      expect(widenEvent).toBeDefined();
      expect(widenEvent.outcome).toBe('ok');
      expect(widenEvent.scopes).toEqual(['read:messages']);

      // (d) Rotation clearing scopes: ['read:messages'] -> {"scopes": null}
      const resClear = await app.request(`/v1/identities/${auditAddr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: null }),
      });
      expect(resClear.status).toBe(200);

      logs = getAuditLogs();
      const clearEvent = logs.find((l) => l.address === auditAddr && l.event === 'identity.scopes.clear');
      expect(clearEvent).toBeDefined();
      expect(clearEvent.outcome).toBe('ok');
      expect(clearEvent.scopes).toBeUndefined();

      // (e) Rotation setting scopes on previously cleared (unscoped) identity: undefined -> ['read:messages']
      const resSet = await app.request(`/v1/identities/${auditAddr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(resSet.status).toBe(200);

      logs = getAuditLogs();
      const setEvent = logs.find((l) => l.address === auditAddr && l.event === 'identity.scopes.set');
      expect(setEvent).toBeDefined();
      expect(setEvent.outcome).toBe('ok');
      expect(setEvent.scopes).toEqual(['read:messages']);

      // (f) Rotation with empty body (preserving scopes) does NOT append a new scope event
      const logsCountBefore = getAuditLogs().length;
      const resEmptyBody = await app.request(`/v1/identities/${auditAddr}/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(resEmptyBody.status).toBe(200);
      expect(getAuditLogs().length).toBe(logsCountBefore);

      // (g) Rotation replacing incomparable scopes: ['future:scope'] -> ['read:messages']
      const storePath = join(config.dataDir, 'identities.json');
      const raw = JSON.parse(readFileSync(storePath, 'utf8'));
      const incompAddr = `incomp-user@${config.domain}`;
      raw.push({
        address: incompAddr,
        createdAt: new Date().toISOString(),
        tokenHash: sha256Hex('oa_incomp_initial_token_12345'),
        scopes: ['future:scope'],
      });
      writeFileSync(storePath, JSON.stringify(raw, null, 2));

      const resReplace = await app.request(`/v1/identities/${incompAddr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['read:messages'] }),
      });
      expect(resReplace.status).toBe(200);

      logs = getAuditLogs();
      const replaceEvent = logs.find((l) => l.address === incompAddr && l.event === 'identity.scopes.replace');
      expect(replaceEvent).toBeDefined();
      expect(replaceEvent.outcome).toBe('ok');
      expect(replaceEvent.scopes).toEqual(['read:messages']);
    });

    test('5. Rotation semantics: empty body preserves, {"scopes": null} resets full power, invalid scopes 400', async () => {
      const ident = createIdentity({
        localpart: 'semantics-user',
        scopes: ['read:messages'],
      })!;
      const addr = ident.identity.address;

      // Empty body preserves
      const res1 = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(res1.status).toBe(200);
      expect(((await res1.json()) as any).scopes).toEqual(['read:messages']);
      expect(findIdentity(addr)?.scopes).toEqual(['read:messages']);

      // Explicit {"scopes": null} resets full power
      const res2 = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: null }),
      });
      expect(res2.status).toBe(200);
      expect(((await res2.json()) as any).scopes).toBeUndefined();
      expect(findIdentity(addr)?.scopes).toBeUndefined();

      // Empty body on unscoped preserves unscoped
      const res3 = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(res3.status).toBe(200);
      expect(((await res3.json()) as any).scopes).toBeUndefined();
      expect(findIdentity(addr)?.scopes).toBeUndefined();

      // Invalid scopes: string instead of array or null -> 400
      const res4 = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: 'read:messages' }),
      });
      expect(res4.status).toBe(400);

      // Unknown scope -> 400
      const res5 = await app.request(`/v1/identities/${addr}/token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ scopes: ['unsupported:scope'] }),
      });
      expect(res5.status).toBe(400);
    });

    test('6. Fail-closed: real corrupt-store path distinguishes credential classes (OAuth vs oa_/garbage)', async () => {
      const user = createIdentity({ localpart: 'failclosed-user', scopes: ['read:messages'] })!;
      const oaToken = user.token; // valid oa_ token
      const validOAuthToken = 'oauth_valid_failclosed_token_11111';
      const expiredOAuthToken = 'oauth_expired_failclosed_token_22222';
      const garbageToken = 'some_garbage_non_oauth_token_xyz';

      putAccessTokenForTests({
        token: validOAuthToken,
        grantId: 'grant-failclosed-4',
        address: user.identity.address,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-failclosed', clientName: 'Client Failclosed' },
      });

      const now = Date.now();
      putAccessTokenForTests({
        token: expiredOAuthToken,
        grantId: 'grant-failclosed-5',
        address: user.identity.address,
        aud: resource,
        expiresAt: now + 10_000,
        ensureGrant: { clientId: 'client-failclosed-exp', clientName: 'Client Failclosed Exp' },
      });

      const storePath = join(config.dataDir, 'identities.json');
      const goodData = readFileSync(storePath, 'utf8');

      try {
        // Write malformed JSON to identities store file on disk.
        writeFileSync(storePath, '[{ malformed json');

        // 1. oa_ identity token + malformed store -> 500 internal_error (error propagates per integrity contract)
        const resOa = await app.request(`/v1/messages?address=${user.identity.address}`, {
          headers: { authorization: `Bearer ${oaToken}` },
        });
        expect(resOa.status).toBe(500);
        expect(await resOa.json()).toEqual({ error: 'internal_error' });

        // 2. Garbage token + malformed store -> 500 internal_error (pre-existing behavior preserved)
        const resGarbage = await app.request(`/v1/messages?address=${user.identity.address}`, {
          headers: { authorization: `Bearer ${garbageToken}` },
        });
        expect(resGarbage.status).toBe(500);
        expect(await resGarbage.json()).toEqual({ error: 'internal_error' });

        // 3. Valid OAuth token + malformed store -> 401 unauthorized (Issue #127 fail-closed path)
        const resOAuth = await app.request(`/v1/messages?address=${user.identity.address}`, {
          headers: { authorization: `Bearer ${validOAuthToken}` },
        });
        expect(resOAuth.status).toBe(401);
        expect(await resOAuth.json()).toEqual({ error: 'unauthorized' });

        // 4. Expired OAuth token + malformed store -> 401 unauthorized (not 500)
        const resExpiredOAuth = resolveAccessToken(expiredOAuthToken, { resource, now: now + 20_000 });
        expect(resExpiredOAuth.status).toBe('unauthorized');

        // 5. Admin key + malformed store -> fully functional (200 on admin endpoint)
        const resAdmin = await app.request(`/v1/audit/events?limit=1`, {
          headers: { authorization: `Bearer ${adminKey}` },
        });
        expect(resAdmin.status).toBe(200);
      } finally {
        // Restore good data
        writeFileSync(storePath, goodData);
      }
    });

    test('6b. Fail-closed: findIdentityByToken probe throw falls through for OAuth credentials and fails closed (401)', async () => {
      const user = createIdentity({ localpart: 'probe-throw-user', scopes: ['read:messages'] })!;
      const oauthToken = 'oauth_probe_throw_token_33333';
      putAccessTokenForTests({
        token: oauthToken,
        grantId: 'grant-probe-6',
        address: user.identity.address,
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-probe', clientName: 'Client Probe' },
      });

      // Force findIdentityByToken probe to throw
      const spyProbe = spyOn(identitiesModule, 'findIdentityByToken').mockImplementation(() => {
        throw new Error('identity_store_corrupt');
      });
      // Force findIdentity in OAuth branch to also throw
      const spyFind = spyOn(identitiesModule, 'findIdentity').mockImplementation(() => {
        throw new Error('identity_store_corrupt');
      });

      try {
        const res = await app.request(`/v1/messages?address=${user.identity.address}`, {
          headers: { authorization: `Bearer ${oauthToken}` },
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      } finally {
        spyProbe.mockRestore();
        spyFind.mockRestore();
      }
    });
  });
});
