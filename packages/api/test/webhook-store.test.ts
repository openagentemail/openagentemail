process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { config } = await import('../src/lib/config.ts');
const {
  cascadeDeleteWebhooksForAddress,
  checkSubscriptionLimits,
  compactIdempotencyKeys,
  deleteWebhook,
  findCreateIdempotency,
  findRotateIdempotency,
  getWebhook,
  listWebhooks,
  readStore,
  resetWebhooksStoreForTests,
  saveCreateIdempotency,
  saveRotateIdempotency,
  saveWebhook,
  setWebhooksFailClosedForTests,
  webhookStoreHasForbiddenSecretKey,
  WebhookForbiddenSecretError,
  WebhookStoreCorruptError,
  WEBHOOK_STORE_FILE,
} = await import('../src/lib/webhook-store.ts');

describe('webhook-store storage conventions (§10.5, §14 item 5)', () => {
  beforeEach(() => {
    resetWebhooksStoreForTests();
  });

  afterEach(() => {
    resetWebhooksStoreForTests();
  });

  test('creates 0600 file in 0700 dir, stores and retrieves subscriptions', () => {
    const whk = {
      id: 'whk_test_1',
      url: 'https://example.com/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata' as const,
      description: 'my webhook',
      state: 'unverified' as const,
      disabledReason: null,
      secretPrefix: 'whs_1234…',
      epoch: 0,
      overlapUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rotatedAt: null,
      consecutiveFailures: 0,
      privateTargetGranted: false,
      createdBy: 'alice@test.example',
    };

    saveWebhook(whk);

    const storeFile = join(config.dataDir, WEBHOOK_STORE_FILE);
    expect(existsSync(storeFile)).toBe(true);
    const stats = statSync(storeFile);
    expect((stats.mode & 0o777)).toBe(0o600);

    const loaded = getWebhook('whk_test_1');
    expect(loaded).toBeDefined();
    expect(loaded?.url).toBe('https://example.com/hook');
    expect(loaded?.address).toBe('alice@test.example');

    // List by address
    expect(listWebhooks('alice@test.example').length).toBe(1);
    expect(listWebhooks('bob@test.example').length).toBe(0);
    expect(listWebhooks().length).toBe(1);

    // Delete
    const deleted = deleteWebhook('whk_test_1');
    expect(deleted?.id).toBe('whk_test_1');
    expect(getWebhook('whk_test_1')).toBeUndefined();
  });

  test('FORBIDDEN_SECRET_KEYS guard: refuses persisting secret, signingSecret, previousSecret', () => {
    expect(webhookStoreHasForbiddenSecretKey({ secret: 'plain' })).toBe(true);
    expect(webhookStoreHasForbiddenSecretKey({ signingSecret: 'plain' })).toBe(true);
    expect(webhookStoreHasForbiddenSecretKey({ previousSecret: 'plain' })).toBe(true);
    expect(webhookStoreHasForbiddenSecretKey({ token: 'plain' })).toBe(true);
    expect(webhookStoreHasForbiddenSecretKey({ password: 'plain' })).toBe(true);
    // Values containing secret strings are not blocked: only keys
    expect(webhookStoreHasForbiddenSecretKey({ description: 'contains secret keyword' })).toBe(false);

    // Attempting to write a store with a forbidden key throws WebhookForbiddenSecretError
    expect(() => {
      const whk = {
        id: 'whk_bad',
        url: 'https://example.com/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata' as const,
        description: 'bad',
        state: 'unverified' as const,
        disabledReason: null,
        secretPrefix: 'whs_…',
        epoch: 0,
        overlapUntil: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rotatedAt: null,
        consecutiveFailures: 0,
        privateTargetGranted: false,
        createdBy: 'admin',
        secret: 'should-not-be-persisted',
      } as any;
      saveWebhook(whk);
    }).toThrow(WebhookForbiddenSecretError);
  });

  test('corrupt store file fails closed', () => {
    const storeFile = join(config.dataDir, WEBHOOK_STORE_FILE);
    writeFileSync(storeFile, 'INVALID JSON CONTENT', { mode: 0o600 });

    expect(() => readStore()).toThrow(WebhookStoreCorruptError);
    // Subsequent calls are also blocked by the fail-closed latch
    expect(() => listWebhooks()).toThrow(WebhookStoreCorruptError);
  });

  test('cascadeDeleteWebhooksForAddress: removes all subscriptions for that address and keeps others', () => {
    saveWebhook({
      id: 'whk_alice_1',
      url: 'https://example.com/1',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      description: '',
      state: 'enabled',
      disabledReason: null,
      secretPrefix: 'whs_…',
      epoch: 0,
      overlapUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rotatedAt: null,
      consecutiveFailures: 0,
      privateTargetGranted: false,
      createdBy: 'alice@test.example',
    });

    saveWebhook({
      id: 'whk_alice_2',
      url: 'https://example.com/2',
      address: 'alice@test.example',
      events: ['approval.requested'],
      contentScope: 'metadata',
      description: '',
      state: 'enabled',
      disabledReason: null,
      secretPrefix: 'whs_…',
      epoch: 0,
      overlapUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rotatedAt: null,
      consecutiveFailures: 0,
      privateTargetGranted: false,
      createdBy: 'alice@test.example',
    });

    saveWebhook({
      id: 'whk_bob_1',
      url: 'https://example.com/bob',
      address: 'bob@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      description: '',
      state: 'enabled',
      disabledReason: null,
      secretPrefix: 'whs_…',
      epoch: 0,
      overlapUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rotatedAt: null,
      consecutiveFailures: 0,
      privateTargetGranted: false,
      createdBy: 'bob@test.example',
    });

    expect(listWebhooks().length).toBe(3);

    const removed = cascadeDeleteWebhooksForAddress('alice@test.example');
    expect(removed.length).toBe(2);
    expect(removed.map((r) => r.id).sort()).toEqual(['whk_alice_1', 'whk_alice_2']);

    const remaining = listWebhooks();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe('whk_bob_1');
  });

  test('idempotency keys: saving, lookup, and retention compaction', () => {
    saveCreateIdempotency({
      key: 'idem-create-1',
      address: 'alice@test.example',
      webhookId: 'whk_created_1',
      responseBody: { id: 'whk_created_1', secret: null },
      createdAt: new Date().toISOString(),
    });

    const found = findCreateIdempotency('idem-create-1', 'alice@test.example');
    expect(found).toBeDefined();
    expect(found?.webhookId).toBe('whk_created_1');

    saveRotateIdempotency({
      key: 'idem-rot-1',
      webhookId: 'whk_created_1',
      epoch: 1,
      responseBody: { epoch: 1, secret: null },
      createdAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(), // 35 days ago
    });

    // Compacting with 30-day retention drops the 35-day-old rotate record
    compactIdempotencyKeys(30);
    expect(findRotateIdempotency('whk_created_1', 'idem-rot-1')).toBeUndefined();
    expect(findCreateIdempotency('idem-create-1', 'alice@test.example')).toBeDefined();
  });

  test('checkSubscriptionLimits: limits instance-wide and per-address subscriptions', () => {
    expect(checkSubscriptionLimits('alice@test.example', 16, 4).allowed).toBe(true);

    for (let i = 0; i < 4; i++) {
      saveWebhook({
        id: `whk_cap_${i}`,
        url: `https://example.com/${i}`,
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
        description: '',
        state: 'enabled',
        disabledReason: null,
        secretPrefix: 'whs_…',
        epoch: 0,
        overlapUntil: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rotatedAt: null,
        consecutiveFailures: 0,
        privateTargetGranted: false,
        createdBy: 'alice@test.example',
      });
    }

    // Per-address limit reached
    const checkAddress = checkSubscriptionLimits('alice@test.example', 16, 4);
    expect(checkAddress.allowed).toBe(false);
    expect(checkAddress.reason).toBe('address_limit');

    // Bob is still allowed under per-address
    expect(checkSubscriptionLimits('bob@test.example', 16, 4).allowed).toBe(true);

    // Global limit
    expect(checkSubscriptionLimits('bob@test.example', 4, 4).allowed).toBe(false);
    expect(checkSubscriptionLimits('bob@test.example', 4, 4).reason).toBe('instance_limit');
  });
});
