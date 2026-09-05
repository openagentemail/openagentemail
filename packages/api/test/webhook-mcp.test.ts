process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOKS_ENABLED = 'true';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.UI_ENABLED = 'false';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const {
  deliveryLimiter,
  deliveryQueue,
  setWebhookDnsLookupForTests,
} = await import('../src/lib/webhook-delivery.ts');
const {
  createIdentity,
  deleteIdentity,
} = await import('../src/lib/identities.ts');
const {
  putAccessTokenForTests,
  resetOAuthStoreCacheForTests,
} = await import('../src/lib/oauth-store.ts');
const {
  TOOL_TIER_SPEC,
  getToolTier,
} = await import('../src/lib/tool-tiers.ts');
const { resolveResourceUri } = await import('../src/lib/oauth-url.ts');

const TEST_DATA_DIR = join(import.meta.dir, 'tmp-webhook-mcp');
const originalDataDir = config.dataDir;
const MCP_ACCEPT = 'application/json, text/event-stream';

let app: ReturnType<typeof createApp>;
let aliceToken: string;
let aliceAddress: string;
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
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
  setWebhookDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);

  const alice = createIdentity({ localpart: 'alice', domain: 'test.example' });
  aliceToken = alice?.token ?? '';
  aliceAddress = alice?.identity.address ?? 'alice@test.example';

  resetOAuthStoreCacheForTests();
  oauthToken = 'oa_access_test_oauth_32bytes_pad!';
  putAccessTokenForTests({
    token: oauthToken,
    grantId: 'g-test-oauth',
    address: aliceAddress,
    aud: resolveResourceUri('http://localhost'),
    expiresAt: Date.now() + 3600_000,
    ensureGrant: { clientId: 'https://client.example/cb', clientName: 'Test Client' },
  });

  app = createApp({ uiEnabled: false });
}

function mcpCall(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

async function readMcpJson(res: Response): Promise<any> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine) return JSON.parse(dataLine.slice('data: '.length));
  return JSON.parse(text);
}

describe('Webhook MCP Tools & Tool Tiers (§10.7, D17)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    setWebhookDnsLookupForTests(undefined);
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('TOOL_TIER_SPEC has all 5 webhook tools with ratified tiers', () => {
    expect(TOOL_TIER_SPEC.mail_webhook_list).toBe('read');
    expect(TOOL_TIER_SPEC.mail_webhook_create).toBe('critical');
    expect(TOOL_TIER_SPEC.mail_webhook_delete).toBe('minimal');
    expect(TOOL_TIER_SPEC.mail_webhook_test).toBe('contained');
    expect(TOOL_TIER_SPEC.mail_webhook_disable).toBe('minimal');

    expect(getToolTier('mail_webhook_create')).toBe('critical');
    expect(getToolTier('mail_webhook_list')).toBe('read');
  });

  test('mail_webhook_create tier critical: OAuth ticket rejected by WriteGuard (403 forbidden_tier)', async () => {
    const res = await mcpCall(oauthToken, 'mail_webhook_create', {
      url: 'https://consumer.example/hook',
      address: aliceAddress,
      events: ['mail.received'],
    });
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toBe('forbidden_tier');
    expect(body.tier).toBe('critical');
  });

  test('mail_webhook_create, list, test, disable, delete complete lifecycle via MCP', async () => {
    // 1. Create webhook subscription as Alice
    const createRes = await mcpCall(aliceToken, 'mail_webhook_create', {
      url: 'https://consumer.example/hook',
      address: aliceAddress,
      events: ['mail.received'],
      description: 'Alice mail hook',
    });
    expect(createRes.status).toBe(200);
    const createBody = await readMcpJson(createRes);
    expect(createBody.result?.isError).toBeFalsy();
    const createdData = JSON.parse(createBody.result.content[0].text);
    expect(createdData.id).toMatch(/^whk_/);
    expect(createdData.address).toBe(aliceAddress);
    expect(createdData.events).toEqual(['mail.received']);
    expect(createdData.secret).toMatch(/^whs_[a-f0-9]{64}$/);
    const webhookId = createdData.id;

    // 2. List webhooks as Alice
    const listRes = await mcpCall(aliceToken, 'mail_webhook_list', {});
    expect(listRes.status).toBe(200);
    const listBody = await readMcpJson(listRes);
    expect(listBody.result?.isError).toBeFalsy();
    const listData = JSON.parse(listBody.result.content[0].text);
    expect(Array.isArray(listData.webhooks)).toBe(true);
    expect(listData.webhooks.length).toBe(1);
    expect(listData.webhooks[0].id).toBe(webhookId);
    expect(listData.webhooks[0].secret).toBeUndefined(); // list never leaks secret

    // 3. Disable webhook
    const disableRes = await mcpCall(aliceToken, 'mail_webhook_disable', { id: webhookId });
    expect(disableRes.status).toBe(200);
    const disableBody = await readMcpJson(disableRes);
    expect(disableBody.result?.isError).toBeFalsy();
    const disableData = JSON.parse(disableBody.result.content[0].text);
    expect(disableData.state).toBe('disabled');
    expect(disableData.disabledReason).toBe('manual');

    // 4. Test webhook probe ping (disabled endpoint returns error cleanly without network call)
    const testRes = await mcpCall(aliceToken, 'mail_webhook_test', { id: webhookId });
    expect(testRes.status).toBe(200);
    const testBody = await readMcpJson(testRes);
    expect(testBody.result?.isError).toBe(true);
    expect(testBody.result?.content?.[0]?.text).toMatch(/webhook_disabled/);

    // 5. Delete webhook
    const deleteRes = await mcpCall(aliceToken, 'mail_webhook_delete', { id: webhookId });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await readMcpJson(deleteRes);
    expect(deleteBody.result?.isError).toBeFalsy();
    const deleteData = JSON.parse(deleteBody.result.content[0].text);
    expect(deleteData.ok).toBe(true);

    // 6. Verify list is now empty
    const listAfterRes = await mcpCall(aliceToken, 'mail_webhook_list', {});
    const listAfterBody = await readMcpJson(listAfterRes);
    const listAfterData = JSON.parse(listAfterBody.result.content[0].text);
    expect(listAfterData.webhooks.length).toBe(0);
  }, 20000);

  test('mail_webhook_create schema validation: rejects duplicate events and overlong description', async () => {
    // Duplicate events
    const dupRes = await mcpCall(aliceToken, 'mail_webhook_create', {
      url: 'https://consumer.example/hook',
      address: aliceAddress,
      events: ['mail.received', 'mail.received'],
    });
    expect(dupRes.status).toBe(200);
    const dupBody = await readMcpJson(dupRes);
    // MCP tool schema validation failure returns isError: true
    expect(dupBody.error || dupBody.result?.isError).toBeTruthy();

    // Overlong description
    const longDescRes = await mcpCall(aliceToken, 'mail_webhook_create', {
      url: 'https://consumer.example/hook',
      address: aliceAddress,
      events: ['mail.received'],
      description: 'x'.repeat(1001),
    });
    expect(longDescRes.status).toBe(200);
    const longDescBody = await readMcpJson(longDescRes);
    expect(longDescBody.error || longDescBody.result?.isError).toBeTruthy();
  });

  afterAll(async () => {
    (config as any).dataDir = originalDataDir;
    deliveryQueue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});
