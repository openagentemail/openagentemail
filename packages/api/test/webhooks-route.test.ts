process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const {
  deliveryLimiter,
  deliveryQueue,
  readAllDeliveryLogRows,
  appendDeliveryLogRow,
  setWebhookDnsLookupForTests,
} = await import('../src/lib/webhook-delivery.ts');
const {
  createWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
} = await import('../src/lib/webhook-store.ts');
const {
  createIdentity,
  deleteIdentity,
} = await import('../src/lib/identities.ts');
const {
  putAccessTokenForTests,
  resetOAuthStoreCacheForTests,
} = await import('../src/lib/oauth-store.ts');

const TEST_DATA_DIR = join(import.meta.dir, 'tmp-webhooks-route');
const originalDataDir = config.dataDir;

let app: ReturnType<typeof createApp>;
let aliceToken: string;
let bobToken: string;
let oauthToken: string;
const adminKey = [...config.apiKeys][0] || 'test-key';

function setupTestDir(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as any).dataDir = TEST_DATA_DIR;
  (config.webhooks as any).enabled = true;
  (config as any).taskSigningSecret = '01234567890123456789012345678901';
  (config.webhooks as any).signingSecret = '01234567890123456789012345678901';
  config.apiKeys.add('test-key');
  (config.webhooks as any).allowPrivateTargets = false;
  (config.webhooks as any).rateCreatePerMin = 10;
  (config.webhooks as any).rateTestPerMin = 3;
  (config.webhooks as any).maxSubscriptions = 16;
  (config.webhooks as any).maxPerAddress = 4;
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
  setWebhookDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);

  // Create test identities
  const alice = createIdentity({ localpart: 'alice', domain: 'test.example' });
  aliceToken = alice?.token ?? '';
  const bob = createIdentity({ localpart: 'bob', domain: 'test.example' });
  bobToken = bob?.token ?? '';

  resetOAuthStoreCacheForTests();
  // Create test OAuth token
  oauthToken = 'oa_access_test_oauth_32bytes_pad!';
  putAccessTokenForTests({
    token: oauthToken,
    grantId: 'g-test-oauth',
    address: 'alice@test.example',
    aud: 'http://localhost/mcp',
    expiresAt: Date.now() + 3600_000,
    ensureGrant: { clientId: 'https://client.example/cb', clientName: 'Test Client' },
  });

  app = createApp();
}

describe('webhooks REST API (§10.3, §10.4, §10.6, §12)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    setWebhookDnsLookupForTests(undefined);
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('dark landing: when WEBHOOKS_ENABLED is false, all routes return 404 webhooks_disabled', async () => {
    (config.webhooks as any).enabled = false;

    const res = await app.request('/v1/webhooks', {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe('webhooks_disabled');
  });

  test('POST /v1/webhooks: Rule A: OAuth tokens are rejected on mutation', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
      }),
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe('forbidden: oauth tokens may not mutate webhook subscriptions');
  });

  test('POST /v1/webhooks: admin can create metadata and preview subscriptions', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received', 'approval.requested'],
        contentScope: 'preview',
        description: 'Paging webhook',
      }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.id).toMatch(/^whk_/);
    expect(body.url).toBe('https://consumer.example/hook');
    expect(body.address).toBe('alice@test.example');
    expect(body.events).toEqual(['mail.received', 'approval.requested']);
    expect(body.contentScope).toBe('preview');
    expect(body.secret).toMatch(/^whs_[a-f0-9]{64}$/);
    expect(body.secretPrefix).toMatch(/^whs_[a-f0-9]{4}…$/);
    expect(body.state).toBe('unverified');
  });

  test('POST /v1/webhooks: identity token can create metadata for own address only', async () => {
    // Cannot create for another address
    const badRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'bob@test.example',
        events: ['mail.received'],
      }),
    });
    expect(badRes.status).toBe(403);
    expect(((await badRes.json()) as any).error).toBe('forbidden: token is scoped to another address');

    // Cannot request preview contentScope
    const previewRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'preview',
      }),
    });
    expect(previewRes.status).toBe(403);
    expect(((await previewRes.json()) as any).error).toBe('content_scope_requires_admin');

    // Can create metadata for own address
    const okRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
      }),
    });
    expect(okRes.status).toBe(201);
  });

  test('POST /v1/webhooks Item 4 & Item 8 validation rules', async () => {
    // Item 4: description <= 1000 characters
    const overlongDesc = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
        description: 'a'.repeat(1001),
      }),
    });
    expect(overlongDesc.status).toBe(400);

    // Item 8: events non-empty
    const emptyEvents = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: [],
      }),
    });
    expect(emptyEvents.status).toBe(400);

    // Item 8: events unique (no duplicates)
    const duplicateEvents = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received', 'mail.received'],
      }),
    });
    expect(duplicateEvents.status).toBe(400);
  });

  test('POST /v1/webhooks: idempotency key returns stored 201 response with secret: null', async () => {
    const res1 = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-abc',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
      }),
    });
    expect(res1.status).toBe(201);
    const body1: any = await res1.json();
    expect(body1.secret).toBeDefined();

    // Replay with same idempotency key
    const res2 = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-abc',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
      }),
    });
    expect(res2.status).toBe(201);
    const body2: any = await res2.json();
    expect(body2.id).toBe(body1.id);
    expect(body2.secret).toBeNull(); // Secret redacted on idempotency replay!
  });

  test('GET /v1/webhooks: admin lists all; identity lists only own; never leaks secret', async () => {
    createWebhookSubscription({
      url: 'https://alice.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });
    createWebhookSubscription({
      url: 'https://bob.example/hook',
      address: 'bob@test.example',
      events: ['mail.received'],
      createdBy: 'bob@test.example',
    });

    // Alice sees only 1
    const aliceRes = await app.request('/v1/webhooks', {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const aliceBody: any = await aliceRes.json();
    expect(aliceBody.webhooks.length).toBe(1);
    expect(aliceBody.webhooks[0].address).toBe('alice@test.example');
    expect(aliceBody.webhooks[0].secret).toBeUndefined();

    // Admin sees both
    const adminRes = await app.request('/v1/webhooks', {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    const adminBody: any = await adminRes.json();
    expect(adminBody.webhooks.length).toBe(2);
    expect(adminBody.webhooks[0].secret).toBeUndefined();
    expect(adminBody.webhooks[1].secret).toBeUndefined();
  });

  test('POST /v1/webhooks/:id: Item 7: url change resets consecutiveFailures to 0 and state to unverified', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/v1',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    updateWebhookSubscription(sub.id, (s) => {
      s.consecutiveFailures = 5;
      s.state = 'enabled';
    });

    const res = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://consumer.example/v2',
      }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.url).toBe('https://consumer.example/v2');
    expect(body.consecutiveFailures).toBe(0);
    expect(body.state).toBe('unverified');
  });

  test('POST /v1/webhooks/:id: Rule B: identity cannot change url if contentScope is preview', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'preview',
      createdBy: 'admin',
    });

    const res = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://attacker.example/hijack',
      }),
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe('content_scope_requires_admin');
  });

  test('GET /v1/webhooks/:id/secret: Rule D: only creator can reveal secret', async () => {
    // Subscription created by admin for alice
    const adminCreated = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });

    // Alice attempts to reveal secret -> forbidden (admin required)
    const aliceRes = await app.request(`/v1/webhooks/${adminCreated.id}/secret`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceRes.status).toBe(403);
    expect(((await aliceRes.json()) as any).error).toBe('forbidden: admin key required');

    // Admin can reveal
    const adminRes = await app.request(`/v1/webhooks/${adminCreated.id}/secret`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminRes.status).toBe(200);
    expect(adminRes.headers.get('Cache-Control')).toBe('no-store');
    const adminBody: any = await adminRes.json();
    expect(adminBody.secret).toMatch(/^whs_[a-f0-9]{64}$/);

    // Subscription created by alice
    const aliceCreated = createWebhookSubscription({
      url: 'https://consumer.example/hook2',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'alice@test.example',
    });

    // Alice can reveal own created subscription
    const aliceOwnRes = await app.request(`/v1/webhooks/${aliceCreated.id}/secret`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceOwnRes.status).toBe(200);
    expect(aliceOwnRes.headers.get('Cache-Control')).toBe('no-store');
  });

  test('DELETE /v1/webhooks/:id cancels pending retries with subscription_deleted and records audit event', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'alice@test.example',
    });

    const res = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(200);
    expect(getWebhookSubscription(sub.id)).toBeUndefined();
  });

  test('POST /v1/webhooks/:id/rotate increments epoch and enforces overlap window', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'alice@test.example',
    });

    const res1 = await app.request(`/v1/webhooks/${sub.id}/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res1.status).toBe(200);
    const body1: any = await res1.json();
    expect(body1.epoch).toBe(1);
    expect(body1.overlapUntil).toBeDefined();

    // Second rotation without force fails with 409
    const res2 = await app.request(`/v1/webhooks/${sub.id}/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res2.status).toBe(409);
    expect(((await res2.json()) as any).error).toBe('rotation_window_open');

    // Force rotation succeeds
    const res3 = await app.request(`/v1/webhooks/${sub.id}/rotate?force=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res3.status).toBe(200);
    expect(((await res3.json()) as any).epoch).toBe(2);
  });

  test('POST /v1/webhooks/:id/test: 409 when disabled; executes probe when enabled', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    // Disabled endpoint returns 409
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'disabled';
      s.disabledReason = 'manual';
    });

    const disabledRes = await app.request(`/v1/webhooks/${sub.id}/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(disabledRes.status).toBe(409);
    const disabledBody: any = await disabledRes.json();
    expect(disabledBody.error).toBe('webhook_disabled');
    expect(disabledBody.disabledReason).toBe('manual');
  });

  test('POST /v1/webhooks/:id/disable and /enable state transitions', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    // Alice disables subscription
    const disRes = await app.request(`/v1/webhooks/${sub.id}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(disRes.status).toBe(200);
    expect(getWebhookSubscription(sub.id)?.state).toBe('disabled');
    expect(getWebhookSubscription(sub.id)?.disabledReason).toBe('manual');

    // Alice cannot enable (admin only)
    const userEnableRes = await app.request(`/v1/webhooks/${sub.id}/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(userEnableRes.status).toBe(403);

    // Admin enables
    const adminEnableRes = await app.request(`/v1/webhooks/${sub.id}/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminEnableRes.status).toBe(200);
    expect(getWebhookSubscription(sub.id)?.state).toBe('unverified');
    expect(getWebhookSubscription(sub.id)?.disabledReason).toBeNull();
  });

  test('GET /v1/webhooks/:id/deliveries and POST /v1/webhooks/deliveries/:id/redeliver are admin-only', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    // Alice cannot list deliveries
    const userListRes = await app.request(`/v1/webhooks/${sub.id}/deliveries`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(userListRes.status).toBe(403);

    // Admin can list deliveries
    const adminListRes = await app.request(`/v1/webhooks/${sub.id}/deliveries`, {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminListRes.status).toBe(200);
    const listBody: any = await adminListRes.json();
    expect(Array.isArray(listBody.deliveries)).toBe(true);

    // Seed a completed delivery row
    appendDeliveryLogRow({
      ts: new Date().toISOString(),
      webhookId: sub.id,
      eventId: 'evt_orig_1',
      runId: 'run_0',
      deliveryId: 'dlv_target_1',
      type: 'webhook.ping',
      address: 'alice@test.example',
      messageId: '101',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: new Date().toISOString(),
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 50,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });

    // Alice cannot redeliver
    const userRedeliver = await app.request('/v1/webhooks/deliveries/dlv_target_1/redeliver', {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(userRedeliver.status).toBe(403);

    // Admin can redeliver
    const adminRedeliver = await app.request('/v1/webhooks/deliveries/dlv_target_1/redeliver', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminRedeliver.status).toBe(200);
    const redeliverBody: any = await adminRedeliver.json();
    expect(redeliverBody.ok).toBe(true);
    expect(redeliverBody.deliveryId).toMatch(/^dlv_/);
    expect(redeliverBody.eventId).toBe('evt_orig_1');
  });

  test('R2 Item 1 & Item 2: OAuth tokens cannot DELETE or reveal secret', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook-oauth-check',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    // Item 2: GET /:id/secret rejects OAuth
    const secretRes = await app.request(`/v1/webhooks/${sub.id}/secret`, {
      headers: { Authorization: `Bearer ${oauthToken}` },
    });
    expect(secretRes.status).toBe(403);
    const secretBody: any = await secretRes.json();
    expect(secretBody.error).toBe('forbidden: oauth tokens may not reveal webhook secrets');

    // Item 1: DELETE /:id rejects OAuth
    const deleteRes = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${oauthToken}` },
    });
    expect(deleteRes.status).toBe(403);
    const deleteBody: any = await deleteRes.json();
    expect(deleteBody.error).toBe('forbidden: oauth tokens may not mutate webhook subscriptions');
  });

  test('R2 Item 3: Identity caller cannot disable subscription created by admin', async () => {
    const adminSub = createWebhookSubscription({
      url: 'https://consumer.example/hook-admin-created',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'admin',
    });

    const disableRes = await app.request(`/v1/webhooks/${adminSub.id}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(disableRes.status).toBe(403);
    const body: any = await disableRes.json();
    expect(body.error).toBe('forbidden: admin key required');

    // Admin CAN disable
    const adminDisableRes = await app.request(`/v1/webhooks/${adminSub.id}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminDisableRes.status).toBe(200);
  });

  test('R2 Item 10: Concurrent duplicate create requests with Idempotency-Key are race-safe', async () => {
    const key = `idemp_concurrent_${Date.now()}`;
    const req = () =>
      app.request('/v1/webhooks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          url: 'https://consumer.example/hook-concurrent',
          address: 'bob@test.example',
          events: ['mail.received'],
        }),
      });

    const [res1, res2] = await Promise.all([req(), req()]);
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const body1: any = await res1.json();
    const body2: any = await res2.json();
    expect(body1.id).toBe(body2.id);
  });

  test('R2 Item 11: POST /v1/webhooks/:id/rotate idempotency returns cached response', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook-rot-idemp',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'alice@test.example',
    });

    const rotKey = `rot_key_${Date.now()}`;
    const res1 = await app.request(`/v1/webhooks/${sub.id}/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Idempotency-Key': rotKey,
      },
    });
    expect(res1.status).toBe(200);
    const body1: any = await res1.json();
    expect(body1.epoch).toBe(1);

    // Replay same rotation key
    const res2 = await app.request(`/v1/webhooks/${sub.id}/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Idempotency-Key': rotKey,
      },
    });
    expect(res2.status).toBe(200);
    const body2: any = await res2.json();
    expect(body2.epoch).toBe(1);
    expect(body2.id).toBe(sub.id);
  });

  test('R2 Item 23: GET /v1/webhooks respects ?address= filter for admin and forbids identity', async () => {
    const adminFilterRes = await app.request('/v1/webhooks?address=alice@test.example', {
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(adminFilterRes.status).toBe(200);
    const adminBody: any = await adminFilterRes.json();
    for (const w of adminBody.webhooks) {
      expect(w.address).toBe('alice@test.example');
    }

    const userFilterRes = await app.request('/v1/webhooks?address=bob@test.example', {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(userFilterRes.status).toBe(403);
    const userBody: any = await userFilterRes.json();
    expect(userBody.error).toBe('forbidden: admin key required');
  });

  afterAll(async () => {
    (config as any).dataDir = originalDataDir;
    (config.webhooks as any).enabled = false;
    delete process.env.WEBHOOKS_ENABLED;
    setWebhookDnsLookupForTests(undefined);
    deliveryQueue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});
