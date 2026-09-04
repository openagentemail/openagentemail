import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-delg-test';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.MCP_PUBLIC_URL = 'http://localhost';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-delg-test-'));

const { beforeEach, describe, expect, mock, test } = await import('bun:test');

let fakeMessages: any[] = [
  {
    uid: 101,
    flags: new Set(),
    envelope: {
      date: new Date('2026-09-04T00:00:00Z'),
      subject: 'Delegated message',
      from: [{ address: 'sender@example.net', name: 'Sender' }],
      to: [{ address: 'alice@test.example', name: 'Alice' }],
    },
    internalDate: new Date('2026-09-04T00:00:00Z'),
    source: Buffer.from(
      'From: sender@example.net\r\nTo: alice@test.example\r\nSubject: Delegated message\r\n\r\nDelegated body',
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
const {
  createIdentity,
  deleteIdentity,
  findIdentity,
  rotateIdentityToken,
} = await import('../src/lib/identities.ts');
const {
  createDelegation,
  getDelegation,
  listDelegations,
  hasActiveDelegation,
  findActiveDelegation,
  revokeDelegation,
  revokeDelegationsForAddress,
  revokeDelegationsOnGranteeTokenRotate,
  invalidateDelegationStoreCache,
  resetDelegationStoreForTests,
  DELEGATION_STORE_SCHEMA_VERSION,
} = await import('../src/lib/delegations.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const { putAccessTokenForTests } = await import('../src/lib/oauth-store.ts');
const { resolveResourceUri } = await import('../src/lib/oauth-url.ts');

const adminKey = [...config.apiKeys][0]!;
let app = createApp({ uiEnabled: true });

function resetIdentitiesStore(): void {
  writeFileSync(join(config.dataDir, 'identities.json'), '[]', { mode: 0o600 });
}

describe('Issue #125: Revocable mailbox delegation ACLs', () => {
  beforeEach(() => {
    resetIdentitiesStore();
    resetDelegationStoreForTests();
    resetAuditForTests();
  });

  describe('1. Store layer (delegations.json)', () => {
    test('creates delegation grant with delg_* id, lowercase normalization and tombstone semantics', () => {
      const grant = createDelegation({
        mailbox: ' Alice@Test.Example ',
        grantee: ' Bob@Test.Example ',
        createdBy: 'admin',
      });

      expect(grant.id.startsWith('delg_')).toBe(true);
      expect(grant.mailbox).toBe('alice@test.example');
      expect(grant.grantee).toBe('bob@test.example');
      expect(grant.scopes).toEqual(['read:messages']);
      expect(grant.revokedAt).toBeNull();
      expect(grant.revokedBy).toBeNull();

      const stored = getDelegation(grant.id);
      expect(stored).toBeDefined();
      expect(stored?.id).toBe(grant.id);

      const filePath = join(config.dataDir, 'delegations.json');
      expect(existsSync(filePath)).toBe(true);
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(raw.schemaVersion).toBe(DELEGATION_STORE_SCHEMA_VERSION);
      expect(raw.grants.length).toBe(1);
    });

    test('revokeDelegation is an idempotent tombstone', () => {
      const grant = createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob@test.example',
        createdBy: 'admin',
      });

      const firstRevoke = revokeDelegation(grant.id, 'admin', '2026-09-04T10:00:00.000Z');
      expect(firstRevoke).toBeDefined();
      expect(firstRevoke?.revokedAt).toBe('2026-09-04T10:00:00.000Z');
      expect(firstRevoke?.revokedBy).toBe('admin');

      // Idempotent: second revoke returns existing revokedAt/revokedBy without changing
      const secondRevoke = revokeDelegation(grant.id, 'someone-else', '2026-09-04T11:00:00.000Z');
      expect(secondRevoke?.revokedAt).toBe('2026-09-04T10:00:00.000Z');
      expect(secondRevoke?.revokedBy).toBe('admin');
    });

    test('preserves unknown fields at root and grant levels (forward compatibility)', () => {
      const filePath = join(config.dataDir, 'delegations.json');
      const customStore = {
        schemaVersion: 1,
        futureFeatureFlag: true,
        grants: [
          {
            id: 'delg_future123',
            mailbox: 'alice@test.example',
            grantee: 'bob@test.example',
            scopes: ['read:messages'],
            createdAt: '2026-09-04T00:00:00.000Z',
            createdBy: 'admin',
            revokedAt: null,
            revokedBy: null,
            futureMetadata: { note: 'keep me safe' },
          },
        ],
      };
      writeFileSync(filePath, JSON.stringify(customStore, null, 2), { mode: 0o600 });
      invalidateDelegationStoreCache();

      // Read preserved
      const grant = getDelegation('delg_future123');
      expect(grant?.id).toBe('delg_future123');
      expect((grant as any).futureMetadata).toEqual({ note: 'keep me safe' });

      // Mutate by adding new grant and verify rewrite keeps future fields
      createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'carol@test.example',
        createdBy: 'admin',
      });

      const reloaded = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(reloaded.futureFeatureFlag).toBe(true);
      const original = reloaded.grants.find((g: any) => g.id === 'delg_future123');
      expect(original.futureMetadata).toEqual({ note: 'keep me safe' });
    });

    test('corrupted store fails closed and does not overwrite damaged file', () => {
      const filePath = join(config.dataDir, 'delegations.json');
      writeFileSync(filePath, 'NOT_VALID_JSON{', { mode: 0o600 });
      invalidateDelegationStoreCache();

      expect(() => listDelegations()).toThrow('delegation_store_corrupt');

      // Verify file was NOT overwritten
      expect(readFileSync(filePath, 'utf8')).toBe('NOT_VALID_JSON{');
    });
  });

  describe('2. REST API endpoints (/v1/delegations)', () => {
    let aliceToken: string;
    let bobToken: string;
    let bobScopedToken: string;
    let carolToken: string;

    beforeEach(() => {
      const alice = createIdentity({ localpart: 'alice' })!;
      aliceToken = alice.token;
      const bob = createIdentity({ localpart: 'bob' })!;
      bobToken = bob.token;
      const bobScoped = createIdentity({ localpart: 'bob-scoped', scopes: ['read:messages'] })!;
      bobScopedToken = bobScoped.token;
      const carol = createIdentity({ localpart: 'carol' })!;
      carolToken = carol.token;
    });

    test('POST /v1/delegations authorizes admin and owner, forbids third-party and scoped tokens', async () => {
      // 1. Owner can grant
      const ownerRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'bob@test.example',
        }),
      });
      expect(ownerRes.status).toBe(201);
      const ownerBody = (await ownerRes.json()) as any;
      expect(ownerBody.id.startsWith('delg_')).toBe(true);
      expect(ownerBody.mailbox).toBe('alice@test.example');
      expect(ownerBody.grantee).toBe('bob@test.example');
      expect(ownerBody.scopes).toEqual(['read:messages']);
      expect(typeof ownerBody.createdAt).toBe('string');
      expect(Date.parse(ownerBody.createdAt)).not.toBeNaN();

      // 2. Admin can grant for any mailbox
      const adminRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'carol@test.example',
          scopes: ['read:messages'],
        }),
      });
      expect(adminRes.status).toBe(201);

      // 3. Non-owner (Carol) cannot grant for Alice
      const deniedRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${carolToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'carol@test.example',
        }),
      });
      expect(deniedRes.status).toBe(403);
      expect(await deniedRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      // 4. Scoped token cannot create delegations (not in OPERATION_POLICIES)
      const scopedRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bobScopedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mailbox: 'bob-scoped@test.example',
          grantee: 'alice@test.example',
        }),
      });
      expect(scopedRes.status).toBe(403);
      expect(await scopedRes.json()).toEqual({ error: 'forbidden: insufficient_scope' });

      // Audit assertions
      const audits = readAuditEvents();
      const grantAudit = audits.find((e) => e.event === 'delegation.grant' && e.grantee === 'bob@test.example');
      expect(grantAudit).toBeDefined();
      expect(grantAudit?.actor).toBe('alice@test.example');
      expect(grantAudit?.outcome).toBe('ok');
      expect(typeof grantAudit?.ts).toBe('string');
      expect(Math.abs(Date.now() - new Date(grantAudit?.ts!).getTime())).toBeLessThan(10000);

      const deniedAudit = audits.find((e) => e.event === 'delegation.grant.denied');
      expect(deniedAudit).toBeDefined();
      expect(deniedAudit?.actor).toBe('carol@test.example');
      expect(deniedAudit?.outcome).toBe('denied');
      expect(deniedAudit?.mailbox).toBe('alice@test.example');
      expect(typeof deniedAudit?.ts).toBe('string');
      expect(Math.abs(Date.now() - new Date(deniedAudit?.ts!).getTime())).toBeLessThan(10000);
    });

    test('Item A: POST /v1/delegations enforces server-generated ts and ignores client x-audit-ts and body ts', async () => {
      const spoofedTs = '1999-01-01T00:00:00.000Z';
      const res = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aliceToken}`,
          'Content-Type': 'application/json',
          'x-audit-ts': spoofedTs,
        },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'bob@test.example',
          ts: spoofedTs,
        }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.createdAt).not.toBe(spoofedTs);
      expect(Math.abs(Date.now() - new Date(data.createdAt).getTime())).toBeLessThan(10000);

      const audits = readAuditEvents();
      const audit = audits.find((e) => e.event === 'delegation.grant' && e.grantId === data.id);
      expect(audit).toBeDefined();
      expect(audit?.ts).not.toBe(spoofedTs);
      expect(Math.abs(Date.now() - new Date(audit?.ts!).getTime())).toBeLessThan(10000);
    });

    test('Item C: POST /v1/delegations rejects explicit empty scopes [] with 400 and defaults omitted scopes', async () => {
      // 1. Explicit empty scopes array -> 400 invalid_request
      const emptyRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'bob@test.example',
          scopes: [],
        }),
      });
      expect(emptyRes.status).toBe(400);
      const emptyJson = (await emptyRes.json()) as any;
      expect(emptyJson.error).toBe('invalid_request');
      expect(emptyJson.details).toBe('scopes cannot be empty');

      // 2. Omitted scopes -> defaults to ['read:messages'] with 201
      const defaultRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'bob@test.example',
        }),
      });
      expect(defaultRes.status).toBe(201);
      const defaultJson = (await defaultRes.json()) as any;
      expect(defaultJson.scopes).toEqual(['read:messages']);
    });

    test('Item F: POST /v1/delegations is idempotent on active grant (returns 200) and creates new after revoke', async () => {
      // 1. Initial creation -> 201 Created
      const res1 = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'alice@test.example', grantee: 'bob@test.example' }),
      });
      expect(res1.status).toBe(201);
      const grant1 = (await res1.json()) as any;
      expect(grant1.id.startsWith('delg_')).toBe(true);

      // Verify store has 1 grant and 1 audit event
      expect(listDelegations({ mailbox: 'alice@test.example' }).length).toBe(1);
      let grantAudits = readAuditEvents().filter((e) => e.event === 'delegation.grant');
      expect(grantAudits.length).toBe(1);

      // 2. Retry creation with same (mailbox, grantee) -> 200 OK with existing grant, no duplicate in store or audit
      const res2 = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'alice@test.example', grantee: 'bob@test.example' }),
      });
      expect(res2.status).toBe(200);
      const grant2 = (await res2.json()) as any;
      expect(grant2.id).toBe(grant1.id);
      expect(grant2.createdAt).toBe(grant1.createdAt);

      // Verify store STILL has only 1 grant and only 1 audit event
      expect(listDelegations({ mailbox: 'alice@test.example' }).length).toBe(1);
      grantAudits = readAuditEvents().filter((e) => e.event === 'delegation.grant');
      expect(grantAudits.length).toBe(1);

      // 3. Revoke the active grant
      const delRes = await app.request(`/v1/delegations/${grant1.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(delRes.status).toBe(200);

      // 4. Create again after revoke -> creates new active grant with 201 Created
      const res3 = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'alice@test.example', grantee: 'bob@test.example' }),
      });
      expect(res3.status).toBe(201);
      const grant3 = (await res3.json()) as any;
      expect(grant3.id).not.toBe(grant1.id);

      // Verify store now has 2 total grants (1 tombstone + 1 active)
      expect(listDelegations({ mailbox: 'alice@test.example' }).length).toBe(2);
      grantAudits = readAuditEvents().filter((e) => e.event === 'delegation.grant');
      expect(grantAudits.length).toBe(2);
    });

    test('Item E & H1: GET /v1/delegations grantee combined filtering, owner query, and Cache-Control: no-store', async () => {
      // Alice grants to Bob
      await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'alice@test.example', grantee: 'bob@test.example' }),
      });
      // Carol grants to Bob
      await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${carolToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'carol@test.example', grantee: 'bob@test.example' }),
      });
      // Alice grants to Carol
      await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: 'alice@test.example', grantee: 'carol@test.example' }),
      });

      // 1. Grantee (Bob) queries combined ?mailbox=alice@test.example&grantee=bob@test.example -> 200 with Alice's grant only
      const combinedRes = await app.request(
        '/v1/delegations?mailbox=alice@test.example&grantee=bob@test.example',
        { headers: { Authorization: `Bearer ${bobToken}` } },
      );
      expect(combinedRes.status).toBe(200);
      expect(combinedRes.headers.get('cache-control')).toBe('no-store');
      const combinedJson = (await combinedRes.json()) as any;
      expect(combinedJson.delegations.length).toBe(1);
      expect(combinedJson.delegations[0].mailbox).toBe('alice@test.example');
      expect(combinedJson.delegations[0].grantee).toBe('bob@test.example');

      // 2. Grantee (Bob) queries all incoming ?grantee=bob@test.example -> 200 with 2 grants
      const bobAllRes = await app.request('/v1/delegations?grantee=bob@test.example', {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(bobAllRes.status).toBe(200);
      const bobAllJson = (await bobAllRes.json()) as any;
      expect(bobAllJson.delegations.length).toBe(2);

      // 3. Grantee (Bob) queries ?mailbox=alice@test.example WITHOUT grantee=self -> 403 (non-disclosure)
      const bobOnlyMailboxRes = await app.request('/v1/delegations?mailbox=alice@test.example', {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(bobOnlyMailboxRes.status).toBe(403);

      // 4. Bob queries someone else's grantee filter ?grantee=carol@test.example -> 403
      const bobOtherGranteeRes = await app.request('/v1/delegations?grantee=carol@test.example', {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(bobOtherGranteeRes.status).toBe(403);

      // 5. Carol queries ?mailbox=alice@test.example&grantee=bob@test.example (neither is self) -> 403
      const carolProbeRes = await app.request(
        '/v1/delegations?mailbox=alice@test.example&grantee=bob@test.example',
        { headers: { Authorization: `Bearer ${carolToken}` } },
      );
      expect(carolProbeRes.status).toBe(403);

      // 6. Owner (Alice) queries ?mailbox=alice@test.example -> 200 (outgoing grants)
      const aliceOutRes = await app.request('/v1/delegations?mailbox=alice@test.example', {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(aliceOutRes.status).toBe(200);
      const aliceOutJson = (await aliceOutRes.json()) as any;
      expect(aliceOutJson.delegations.length).toBe(2);
    });

    test('Item D & H1: GET /v1/delegations/:id scope policy read:messages, grantee/owner authorization, Cache-Control: no-store', async () => {
      const grant = createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob-scoped@test.example',
        createdBy: 'alice@test.example',
      });

      // 1. Scoped grantee with read:messages can GET /v1/delegations/:id -> 200
      const scopedGetRes = await app.request(`/v1/delegations/${grant.id}`, {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(scopedGetRes.status).toBe(200);
      expect(scopedGetRes.headers.get('cache-control')).toBe('no-store');
      const scopedGetJson = (await scopedGetRes.json()) as any;
      expect(scopedGetJson.id).toBe(grant.id);
      expect(scopedGetJson.mailbox).toBe('alice@test.example');

      // 2. Owner can GET /v1/delegations/:id -> 200
      const ownerGetRes = await app.request(`/v1/delegations/${grant.id}`, {
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(ownerGetRes.status).toBe(200);

      // 3. Third-party (Carol) gets 403
      const thirdPartyRes = await app.request(`/v1/delegations/${grant.id}`, {
        headers: { Authorization: `Bearer ${carolToken}` },
      });
      expect(thirdPartyRes.status).toBe(403);
      expect(await thirdPartyRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      // 4. Token without read:messages scope (e.g. empty scopes []) gets 403 insufficient_scope
      const noScopeUser = createIdentity({ localpart: 'no-scope-user', scopes: [] })!;
      createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'no-scope-user@test.example',
        createdBy: 'alice@test.example',
      });
      const noScopeGrant = listDelegations({ grantee: 'no-scope-user@test.example' })[0]!;
      const noScopeRes = await app.request(`/v1/delegations/${noScopeGrant.id}`, {
        headers: { Authorization: `Bearer ${noScopeUser.token}` },
      });
      expect(noScopeRes.status).toBe(403);
      expect(await noScopeRes.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });

    test('DELETE /v1/delegations/:id authorizes owner/admin, forbids third-party, idempotent tombstone with server ts', async () => {
      const grant = createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob@test.example',
        createdBy: 'alice@test.example',
      });

      // 1. Third party (Carol) tries to revoke -> 403
      const deniedRevoke = await app.request(`/v1/delegations/${grant.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${carolToken}` },
      });
      expect(deniedRevoke.status).toBe(403);

      // 2. Owner revokes -> 200 + audit
      const okRevoke = await app.request(`/v1/delegations/${grant.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(okRevoke.status).toBe(200);
      const okJson = (await okRevoke.json()) as any;
      expect(okJson.revoked).toBe(true);
      expect(typeof okJson.revokedAt).toBe('string');
      expect(Date.parse(okJson.revokedAt)).not.toBeNaN();
      const initialRevokedAt = okJson.revokedAt;

      // 3. Repeat revoke is idempotent and returns 200 with original revokedAt
      const repeatRevoke = await app.request(`/v1/delegations/${grant.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      expect(repeatRevoke.status).toBe(200);
      const repeatJson = (await repeatRevoke.json()) as any;
      expect(repeatJson.revoked).toBe(true);
      expect(repeatJson.revokedAt).toBe(initialRevokedAt);

      // Check audit trail
      const audits = readAuditEvents();
      const deniedAudit = audits.find((e) => e.event === 'delegation.revoke' && e.outcome === 'denied');
      expect(deniedAudit).toBeDefined();
      expect(deniedAudit?.actor).toBe('carol@test.example');

      const okAudits = audits.filter((e) => e.event === 'delegation.revoke' && e.outcome === 'ok');
      expect(okAudits.length).toBeGreaterThanOrEqual(1);
      expect(okAudits.some((e) => e.actor === 'alice@test.example')).toBe(true);
    });

    test('Item G: POST and DELETE /v1/delegations reject OAuth-attributed credentials with 403', async () => {
      const resource = resolveResourceUri('http://localhost');
      const oauthToken = 'oa_oauth_token_delg_test';
      putAccessTokenForTests({
        token: oauthToken,
        grantId: 'grant-oauth-delg-1',
        address: 'alice@test.example',
        aud: resource,
        expiresAt: Date.now() + 3600_000,
        ensureGrant: { clientId: 'client-delg-1', clientName: 'Client Delg 1' },
      });

      // 1. OAuth token calling POST /v1/delegations -> 403 forbidden
      const postRes = await app.request('/v1/delegations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mailbox: 'alice@test.example',
          grantee: 'bob@test.example',
        }),
      });
      expect(postRes.status).toBe(403);
      expect(await postRes.json()).toEqual({
        error: 'forbidden: delegation management requires direct identity credentials',
      });

      // Verify audit event delegation.grant.denied was logged
      const audits = readAuditEvents();
      const grantDeniedAudit = audits.find(
        (e) => e.event === 'delegation.grant.denied' && e.grantee === 'bob@test.example',
      );
      expect(grantDeniedAudit).toBeDefined();
      expect(grantDeniedAudit?.outcome).toBe('denied');

      // 2. Direct identity token creates grant
      const validGrant = createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob@test.example',
        createdBy: 'alice@test.example',
      });

      // 3. OAuth token calling DELETE /v1/delegations/:id -> 403 forbidden
      const deleteRes = await app.request(`/v1/delegations/${validGrant.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${oauthToken}` },
      });
      expect(deleteRes.status).toBe(403);
      expect(await deleteRes.json()).toEqual({
        error: 'forbidden: delegation management requires direct identity credentials',
      });

      // Verify grant was NOT revoked
      const storedGrant = getDelegation(validGrant.id);
      expect(storedGrant?.revokedAt).toBeNull();

      // Verify audit event delegation.revoke denied was logged
      const deleteDeniedAudit = readAuditEvents().find(
        (e) => e.event === 'delegation.revoke' && e.outcome === 'denied' && e.grantId === validGrant.id,
      );
      expect(deleteDeniedAudit).toBeDefined();
    });
  });

  describe('3. Mailbox read authorization & guard rails', () => {
    let aliceToken: string;
    let bobScopedToken: string;
    let bobNoScopeToken: string;
    let grantId: string;

    beforeEach(() => {
      const alice = createIdentity({ localpart: 'alice' })!;
      aliceToken = alice.token;
      const bob = createIdentity({ localpart: 'bob', scopes: ['read:messages'] })!;
      bobScopedToken = bob.token;
      const bobNoScope = createIdentity({ localpart: 'bob-noscope', scopes: [] })!;
      bobNoScopeToken = bobNoScope.token;

      const grant = createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob@test.example',
        createdBy: 'alice@test.example',
      });
      grantId = grant.id;
    });

    test('scoped grantee can read delegated mailbox (list, get, wait)', async () => {
      // GET /v1/messages?address=alice@test.example
      const listRes = await app.request('/v1/messages?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as any;
      expect(Array.isArray(listJson.messages)).toBe(true);

      // GET /v1/messages/101?address=alice@test.example
      const getRes = await app.request('/v1/messages/101?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(getRes.status).toBe(200);

      // POST /v1/messages/wait
      const waitRes = await app.request('/v1/messages/wait', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobScopedToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'alice@test.example', timeoutSec: 1 }),
      });
      expect(waitRes.status).toBe(200);
    });

    test('scoped grantee CANNOT read non-delegated third-party mailbox (exact 403 message preserved)', async () => {
      const res = await app.request('/v1/messages?address=carol@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });
    });

    test('specification guard rail: delegate CANNOT mark seen or send', async () => {
      // POST /v1/messages/:id/seen forbidden for delegate
      const seenRes = await app.request('/v1/messages/101/seen', {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobScopedToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'alice@test.example', seen: true }),
      });
      // Scoped token rejected by scope middleware (not in OPERATION_POLICIES)
      expect(seenRes.status).toBe(403);

      // Full unscoped token who is only a read-delegate also cannot mark seen
      const fullBob = createIdentity({ localpart: 'full-bob' })!;
      createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'full-bob@test.example',
        createdBy: 'alice@test.example',
      });
      const fullSeenRes = await app.request('/v1/messages/101/seen', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fullBob.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'alice@test.example', seen: true }),
      });
      expect(fullSeenRes.status).toBe(403);
      expect(await fullSeenRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      // POST /v1/send forbidden
      const sendRes = await app.request('/v1/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fullBob.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'alice@test.example',
          to: 'recipient@example.com',
          subject: 'Test',
          text: 'Hello',
        }),
      });
      expect(sendRes.status).toBe(403);
      expect(await sendRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });
    });

    test('revocation is immediate and persists across app restarts', async () => {
      // 1. Read works initially
      const beforeRes = await app.request('/v1/messages?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(beforeRes.status).toBe(200);

      // 2. Revoke grant
      revokeDelegation(grantId, 'alice@test.example');

      // 3. Immediately 403
      const afterRes = await app.request('/v1/messages?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(afterRes.status).toBe(403);
      expect(await afterRes.json()).toEqual({
        error: 'forbidden: token is scoped to another address',
      });

      // 4. Reconstruct app instance (simulating server restart)
      invalidateDelegationStoreCache();
      const restartedApp = createApp({ uiEnabled: false });
      const restartRes = await restartedApp.request('/v1/messages?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobScopedToken}` },
      });
      expect(restartRes.status).toBe(403);
    });

    test('double constraint: credential without read:messages scope rejected even if grant exists', async () => {
      createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob-noscope@test.example',
        createdBy: 'alice@test.example',
      });

      const res = await app.request('/v1/messages?address=alice@test.example', {
        headers: { Authorization: `Bearer ${bobNoScopeToken}` },
      });
      // scopePolicyMiddleware denies 403 insufficient_scope before reaching handler
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden: insufficient_scope' });
    });
  });

  describe('4. Cascade revocation & token lifecycle', () => {
    test('grantee token rotation cascades revocation of received delegations; owner rotation does NOT', () => {
      const alice = createIdentity({ localpart: 'alice-rot' })!;
      const bob = createIdentity({ localpart: 'bob-rot', scopes: ['read:messages'] })!;

      const grant = createDelegation({
        mailbox: 'alice-rot@test.example',
        grantee: 'bob-rot@test.example',
        createdBy: 'alice-rot@test.example',
      });

      // 1. Owner rotates token -> grant stays active!
      rotateIdentityToken('alice-rot@test.example');
      const grantAfterOwnerRotate = getDelegation(grant.id);
      expect(grantAfterOwnerRotate?.revokedAt).toBeNull();

      // 2. Grantee rotates token -> grant is cascaded!
      rotateIdentityToken('bob-rot@test.example');
      const grantAfterGranteeRotate = getDelegation(grant.id);
      expect(grantAfterGranteeRotate?.revokedAt).not.toBeNull();
      expect(grantAfterGranteeRotate?.revokedBy).toBe('cascade');

      // Verify audit event emitted
      const audits = readAuditEvents();
      const cascadeAudit = audits.find(
        (e) => e.event === 'delegation.revoke.cascade' && e.grantId === grant.id,
      );
      expect(cascadeAudit).toBeDefined();
      expect(cascadeAudit?.outcome).toBe('ok');
    });

    test('identity deletion cascades revocation bidirectionally (owner granted + grantee received)', () => {
      const alice = createIdentity({ localpart: 'alice-del' })!;
      const bob = createIdentity({ localpart: 'bob-del' })!;
      const carol = createIdentity({ localpart: 'carol-del' })!;

      // Alice grants to Bob
      const g1 = createDelegation({
        mailbox: 'alice-del@test.example',
        grantee: 'bob-del@test.example',
        createdBy: 'alice-del@test.example',
      });
      // Carol grants to Alice
      const g2 = createDelegation({
        mailbox: 'carol-del@test.example',
        grantee: 'alice-del@test.example',
        createdBy: 'carol-del@test.example',
      });

      // Delete Alice -> both g1 (Alice is owner) and g2 (Alice is grantee) cascaded!
      deleteIdentity('alice-del@test.example');

      const reloadedG1 = getDelegation(g1.id);
      const reloadedG2 = getDelegation(g2.id);
      expect(reloadedG1?.revokedAt).not.toBeNull();
      expect(reloadedG2?.revokedAt).not.toBeNull();

      const audits = readAuditEvents();
      const cascades = audits.filter((e) => e.event === 'delegation.revoke.cascade');
      expect(cascades.some((c) => c.grantId === g1.id)).toBe(true);
      expect(cascades.some((c) => c.grantId === g2.id)).toBe(true);
    });

    test('Item B1: deleteIdentity fail-closed: corrupted delegations.json throws error and leaves identity intact', () => {
      const alice = createIdentity({ localpart: 'alice-fail' })!;
      createDelegation({
        mailbox: 'alice-fail@test.example',
        grantee: 'bob@test.example',
        createdBy: 'alice-fail@test.example',
      });

      // Inject failure: corrupt delegations.json
      const filePath = join(config.dataDir, 'delegations.json');
      writeFileSync(filePath, 'CORRUPTED_JSON{', { mode: 0o600 });
      invalidateDelegationStoreCache();

      // deleteIdentity must throw error and fail closed
      expect(() => deleteIdentity('alice-fail@test.example')).toThrow('delegation_store_corrupt');

      // Verify Alice is STILL present in identities.json
      const identitiesRaw = JSON.parse(readFileSync(join(config.dataDir, 'identities.json'), 'utf8'));
      const found = identitiesRaw.find((i: any) => i.address === 'alice-fail@test.example');
      expect(found).toBeDefined();
      expect(found.address).toBe('alice-fail@test.example');
    });

    test('Item B1: rotateIdentityToken fail-closed: corrupted delegations.json throws error and leaves tokenHash unchanged', () => {
      const bob = createIdentity({ localpart: 'bob-fail' })!;
      createDelegation({
        mailbox: 'alice@test.example',
        grantee: 'bob-fail@test.example',
        createdBy: 'alice@test.example',
      });

      // Record original tokenHash from identities.json
      const identitiesBefore = JSON.parse(readFileSync(join(config.dataDir, 'identities.json'), 'utf8'));
      const bobBefore = identitiesBefore.find((i: any) => i.address === 'bob-fail@test.example');
      const originalTokenHash = bobBefore.tokenHash;

      // Inject failure: corrupt delegations.json
      const filePath = join(config.dataDir, 'delegations.json');
      writeFileSync(filePath, 'CORRUPTED_JSON{', { mode: 0o600 });
      invalidateDelegationStoreCache();

      // rotateIdentityToken must throw error and fail closed
      expect(() => rotateIdentityToken('bob-fail@test.example')).toThrow('delegation_store_corrupt');

      // Verify Bob's tokenHash is UNCHANGED in identities.json
      const identitiesAfter = JSON.parse(readFileSync(join(config.dataDir, 'identities.json'), 'utf8'));
      const bobAfter = identitiesAfter.find((i: any) => i.address === 'bob-fail@test.example');
      expect(bobAfter.tokenHash).toBe(originalTokenHash);
    });
  });

  describe('5. Edge cases, normalization & UI session isolation', () => {
    test('case normalization works across API and store', async () => {
      const alice = createIdentity({ localpart: 'alice-case' })!;
      const bob = createIdentity({ localpart: 'bob-case', scopes: ['read:messages'] })!;

      // Grant created with upper/mixed case
      const res = await app.request('/v1/delegations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mailbox: 'Alice-Case@Test.Example',
          grantee: 'Bob-Case@Test.Example',
        }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.mailbox).toBe('alice-case@test.example');
      expect(data.grantee).toBe('bob-case@test.example');

      // Accessing with mixed case in query
      const readRes = await app.request('/v1/messages?address=ALICE-CASE@TEST.EXAMPLE', {
        headers: { Authorization: `Bearer ${bob.token}` },
      });
      expect(readRes.status).toBe(200);
    });

    test('UI session rejects scoped credential even if delegation grant exists', async () => {
      const alice = createIdentity({ localpart: 'alice-ui' })!;
      const bob = createIdentity({ localpart: 'bob-ui', scopes: ['read:messages'] })!;

      createDelegation({
        mailbox: 'alice-ui@test.example',
        grantee: 'bob-ui@test.example',
        createdBy: 'alice-ui@test.example',
      });

      // Try logging into UI with scoped token
      const sessionRes = await app.request('/ui/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
        },
        body: JSON.stringify({ token: bob.token }),
      });
      expect(sessionRes.status).toBe(401);
    });
  });
});
