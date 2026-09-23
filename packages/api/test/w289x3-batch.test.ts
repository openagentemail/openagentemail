/**
 * 合批 #289 + #290 + #302 聚焦验收。
 * - #289：details 白名单正/负例 + 拒绝点日志字段（reason 不回显 URL 子串）
 * - #290：ping 熔断对齐主路径（audit + 无 attempt-2 + webhook_disabled）
 * - #302：approval payload foldedRaw 直过生产解析 + 垃圾负控
 */
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const {
  deliveryLimiter,
  deliveryQueue,
  executeWebhookTestProbe,
  readAllDeliveryLogRows,
  resetDeliveryLogIndexForTests,
  resetDeliveryLogIoForTests,
  setWebhookDnsLookupForTests,
  WEBHOOK_URL_REJECT_DETAILS_WHITELIST,
  isWebhookUrlRejectDetailsWhitelisted,
  webhookUrlRejectionResponseBody,
} = await import('../src/lib/webhook-delivery.ts');
const {
  createWebhookSubscription,
  getWebhookSubscription,
  resetWebhooksStoreForTests,
  setWebhooksFailClosedForTests,
  updateWebhookSubscription,
} = await import('../src/lib/webhook-store.ts');
const { createIdentity, deleteIdentity } = await import('../src/lib/identities.ts');
const { readAuditEvents, recordAuditEvent } = await import('../src/lib/audit.ts');
const {
  encodeStampedApprovalRequestForTests,
  encodeStampedApprovalDecisionForTests,
  approvalActionDigest,
  parseStampedTaskMessageForTests,
} = await import('../src/lib/tasks-internal.ts');
const { findIdentity } = await import('../src/lib/identities.ts');

// #350 E2：系统临时目录，避免仓树内落未跟踪 tmp-*
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-w289x3-batch-'));
const originalDataDir = config.dataDir;
let app: ReturnType<typeof createApp>;
const adminKey = [...config.apiKeys][0] || 'test-key';

function setupWebhookDir(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as any).dataDir = TEST_DATA_DIR;
  (config.webhooks as any).enabled = true;
  (config as any).taskSigningSecret = '01234567890123456789012345678901';
  (config.webhooks as any).signingSecret = '01234567890123456789012345678901';
  config.apiKeys.add('test-key');
  (config.webhooks as any).allowPrivateTargets = false;
  (config.webhooks as any).rateCreatePerMin = 60;
  (config.webhooks as any).rateTestPerMin = 60;
  (config.webhooks as any).maxSubscriptions = 16;
  (config.webhooks as any).maxPerAddress = 8;
  (config.webhooks as any).disableThreshold = 10;
  deliveryLimiter.reset();
  deliveryQueue.cancelAll();
  resetDeliveryLogIndexForTests();
  resetDeliveryLogIoForTests();
  resetWebhooksStoreForTests();
  setWebhooksFailClosedForTests(false);
  setWebhookDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  if (!findIdentity('alice@test.example')) {
    createIdentity({ localpart: 'alice', domain: 'test.example' });
  }
  app = createApp();
}

describe('#289 webhook URL reject details + log', () => {
  beforeEach(setupWebhookDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    setWebhookDnsLookupForTests(undefined);
  });

  test('whitelist constant is exactly the first 8 reasons', () => {
    expect([...WEBHOOK_URL_REJECT_DETAILS_WHITELIST]).toEqual([
      'malformed_url',
      'unsupported_protocol',
      'http_requires_private_targets',
      'userinfo_forbidden',
      'query_string_forbidden',
      'fragment_forbidden',
      'port_not_allowed',
      'ip_literal_forbidden',
    ]);
    // 排除 4 条不得进白名单
    for (const excluded of [
      'http_target_must_be_private',
      'dns_empty',
      'dns_lookup_failed',
      'ssrf_blocked_ip',
    ]) {
      expect(isWebhookUrlRejectDetailsWhitelisted(excluded)).toBe(false);
      expect(webhookUrlRejectionResponseBody('invalid_webhook_url', excluded)).toEqual({
        error: 'invalid_webhook_url',
      });
    }
  });

  test('create: whitelist reason returns details; log has kind/reason/address and no URL substring', async () => {
    const controllable = 'controllable-secret-token-289xyz';
    const badUrl = `https://user:pass@evil.example/${controllable}`;
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const res = await app.request('/v1/webhooks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: badUrl,
          address: 'alice@test.example',
          events: ['mail.received'],
          contentScope: 'metadata',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; details?: string };
      expect(body).toEqual({ error: 'invalid_webhook_url', details: 'userinfo_forbidden' });

      expect(warns.length).toBe(1);
      const log = JSON.parse(warns[0]!) as Record<string, unknown>;
      expect(log).toEqual({
        kind: 'webhook_url_rejected',
        reason: 'userinfo_forbidden',
        address: 'alice@test.example',
      });
      // 钉：可控 URL 子串不得出现在日志
      expect(warns[0]).not.toContain(controllable);
      expect(warns[0]).not.toContain(badUrl);
      expect(warns[0]).not.toContain('user:pass');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('create: query_string_forbidden details positive', async () => {
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com/hook?leak=1',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_webhook_url',
      details: 'query_string_forbidden',
    });
  });

  test('create: whitelist-out ssrf_blocked_ip has no details (byte-same coarse error)', async () => {
    setWebhookDnsLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const res = await app.request('/v1/webhooks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://metadata.internal/hook',
          address: 'alice@test.example',
          events: ['mail.received'],
          contentScope: 'metadata',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      // 白名单外：响应逐字节同现状——仅粗码、无 details
      expect(body).toEqual({ error: 'webhook_target_forbidden' });
      expect(Object.keys(body)).toEqual(['error']);

      expect(warns.length).toBe(1);
      const log = JSON.parse(warns[0]!) as Record<string, unknown>;
      expect(log.kind).toBe('webhook_url_rejected');
      expect(log.reason).toBe('ssrf_blocked_ip');
      expect(log.address).toBe('alice@test.example');
      expect(log).not.toHaveProperty('webhookId');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('update: rejection log includes webhookId; whitelist details present', async () => {
    const sub = createWebhookSubscription({
      url: 'https://example.com/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const controllable = 'update-leak-token-290abc';
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    try {
      const res = await app.request(`/v1/webhooks/${sub.id}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: `https://example.com/hook#${controllable}`,
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'invalid_webhook_url',
        details: 'fragment_forbidden',
      });
      expect(warns.length).toBe(1);
      const log = JSON.parse(warns[0]!) as Record<string, unknown>;
      expect(log).toEqual({
        kind: 'webhook_url_rejected',
        reason: 'fragment_forbidden',
        address: 'alice@test.example',
        webhookId: sub.id,
      });
      expect(warns[0]).not.toContain(controllable);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('create: dns_empty is whitelist-out — no details', async () => {
    setWebhookDnsLookupForTests(async () => []);
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://empty-dns.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_webhook_url' });
  });

  // R3 P1-1 方案 a：zod 去 .url() 后，语法坏 URL 到达 resolver → malformed_url details
  test('create+update: not-a-url → invalid_webhook_url + details malformed_url', async () => {
    const createRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'not-a-url',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
      }),
    });
    expect(createRes.status).toBe(400);
    expect(await createRes.json()).toEqual({
      error: 'invalid_webhook_url',
      details: 'malformed_url',
    });

    const sub = createWebhookSubscription({
      url: 'https://example.com/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    // 更新走 POST /v1/webhooks/:id（非 PATCH；与 RFC §10.3 一致）
    const updateRes = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(updateRes.status).toBe(400);
    expect(await updateRes.json()).toEqual({
      error: 'invalid_webhook_url',
      details: 'malformed_url',
    });
  });

  // R5：空串不得被 update truthiness 门短路成 200 no-op
  test('create+update: empty url string → invalid_webhook_url + details malformed_url', async () => {
    const createRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: '',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
      }),
    });
    expect(createRes.status).toBe(400);
    expect(await createRes.json()).toEqual({
      error: 'invalid_webhook_url',
      details: 'malformed_url',
    });

    const sub = createWebhookSubscription({
      url: 'https://example.com/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    const updateRes = await app.request(`/v1/webhooks/${sub.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: '' }),
    });
    expect(updateRes.status).toBe(400);
    expect(await updateRes.json()).toEqual({
      error: 'invalid_webhook_url',
      details: 'malformed_url',
    });
    // 空串不得写入；订阅 URL 保持原值
    expect(getWebhookSubscription(sub.id)?.url).toBe('https://example.com/hook');
  });

  // R3 反向负控：合法但不可达 URL（dns_empty）行为不变
  test('create: reachable-shape URL with empty DNS still invalid_webhook_url without details', async () => {
    setWebhookDnsLookupForTests(async () => []);
    const res = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://still-empty-dns.example/hook',
        address: 'alice@test.example',
        events: ['mail.received'],
        contentScope: 'metadata',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'invalid_webhook_url' });
    expect(Object.keys(body)).toEqual(['error']);
  });
});

describe('#290 ping circuit-breaker aligns with main path', () => {
  beforeEach(setupWebhookDir);
  afterEach(() => {
    (config.webhooks as any).disableThreshold = 10;
    deliveryQueue.cancelAll();
    setWebhookDnsLookupForTests(undefined);
  });

  test('threshold trip on ping: audit webhook.disabled, permanent webhook_disabled, no attempt-2', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ping-breaker.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    // ping 仅对 enabled + retryable 计入熔断
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'enabled';
      s.consecutiveFailures = 0;
    });
    (config.webhooks as any).disableThreshold = 1;
    setWebhookDnsLookupForTests(async () => {
      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    });

    const beforeAudit = readAuditEvents({ event: 'webhook.disabled' }).length;
    const probe = await executeWebhookTestProbe(
      getWebhookSubscription(sub.id)!,
      'admin',
    );

    expect(probe.outcome).toBe('permanent');
    expect(probe.reason).toBe('webhook_disabled');

    const after = getWebhookSubscription(sub.id);
    expect(after?.state).toBe('disabled');
    expect(after?.disabledReason).toBe('threshold');

    const audits = readAuditEvents({ event: 'webhook.disabled' });
    expect(audits.length).toBe(beforeAudit + 1);
    expect(audits[audits.length - 1]).toMatchObject({
      event: 'webhook.disabled',
      outcome: 'ok',
      address: 'alice@test.example',
      webhookId: sub.id,
    });

    // 不得排 attempt-2
    expect(deliveryQueue.hasQueuedJob(sub.id)).toBe(false);
    const rows = readAllDeliveryLogRows().filter((r) => r.webhookId === sub.id);
    const attempt1 = rows.find((r) => r.attempt === 1 && r.outcome !== 'pending');
    expect(attempt1?.outcome).toBe('permanent');
    expect(attempt1?.reason).toBe('webhook_disabled');
    expect(attempt1?.nextAttemptAt).toBeNull();
    expect(rows.some((r) => r.attempt === 2)).toBe(false);
  });

  test('below threshold: retryable ping still schedules attempt-2 (no disable audit)', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ping-retry.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'enabled';
      s.consecutiveFailures = 0;
    });
    (config.webhooks as any).disableThreshold = 10;
    setWebhookDnsLookupForTests(async () => {
      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    });

    const beforeAudit = readAuditEvents({ event: 'webhook.disabled' }).length;
    const probe = await executeWebhookTestProbe(
      getWebhookSubscription(sub.id)!,
      'admin',
    );

    expect(probe.outcome).toBe('retryable');
    expect(probe.reason).toBe('dns_error');
    expect(getWebhookSubscription(sub.id)?.state).toBe('enabled');
    expect(readAuditEvents({ event: 'webhook.disabled' }).length).toBe(beforeAudit);
    expect(deliveryQueue.hasQueuedJob(sub.id)).toBe(true);

    deliveryQueue.cancelAll();
  });

  // R2 P1-2：在途探测 + 手动 disable → 不得假重复 audit / 不得 +1 计数 / 无 attempt-2
  test('in-flight ping + manual disable: exactly one disable audit, no counter bump, no attempt-2', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ping-manual-race.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'enabled';
      s.consecutiveFailures = 3; // 钉：中途 disable 后不得再 +1
    });
    (config.webhooks as any).disableThreshold = 10;

    let rejectDns!: (err: unknown) => void;
    setWebhookDnsLookupForTests(
      () =>
        new Promise((_, reject) => {
          rejectDns = reject;
        }),
    );

    // 快照仍为 enabled（与真实在途探测一致）；countsTowardCircuitBreaker 会为真
    const enabledSnapshot = getWebhookSubscription(sub.id)!;
    expect(enabledSnapshot.state).toBe('enabled');
    const probePromise = executeWebhookTestProbe(enabledSnapshot, 'admin');

    // 等探测进入 DNS 等待，再模拟手动 /disable（含恰好 1 条 audit）
    await new Promise((r) => setTimeout(r, 30));
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'disabled';
      s.disabledReason = 'manual';
    });
    recordAuditEvent({
      event: 'webhook.disabled',
      outcome: 'ok',
      address: sub.address,
      webhookId: sub.id,
    });
    const auditsAfterManual = readAuditEvents({ event: 'webhook.disabled' }).filter(
      (e) => e.webhookId === sub.id,
    );
    expect(auditsAfterManual).toHaveLength(1);

    const err: any = new Error('getaddrinfo ENOTFOUND');
    err.code = 'ENOTFOUND';
    rejectDns(err);

    const probe = await probePromise;
    expect(probe.outcome).toBe('permanent');
    expect(probe.reason).toBe('webhook_disabled');

    const after = getWebhookSubscription(sub.id)!;
    expect(after.state).toBe('disabled');
    expect(after.disabledReason).toBe('manual'); // 不得被改成 threshold
    expect(after.consecutiveFailures).toBe(3); // 不得 +1

    // audit 仍恰好 1 条（来自手动 disable），无假重复
    const audits = readAuditEvents({ event: 'webhook.disabled' }).filter(
      (e) => e.webhookId === sub.id,
    );
    expect(audits).toHaveLength(1);

    expect(deliveryQueue.hasQueuedJob(sub.id)).toBe(false);
    const rows = readAllDeliveryLogRows().filter((r) => r.webhookId === sub.id);
    expect(rows.some((r) => r.attempt === 2)).toBe(false);
  });

  // #312 硬要求③：早退漂移回归——manual-disable 竞态结算不得无语义刷 updatedAt
  test('#312 early-return：已 disabled 早退不漂移 updatedAt', async () => {
    const sub = createWebhookSubscription({
      url: 'https://ping-noop-drift.example/hook',
      address: 'alice@test.example',
      events: ['mail.received'],
      contentScope: 'metadata',
      createdBy: 'admin',
    });
    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'enabled';
      s.consecutiveFailures = 3;
    });
    (config.webhooks as any).disableThreshold = 10;

    let rejectDns!: (err: unknown) => void;
    setWebhookDnsLookupForTests(
      () =>
        new Promise((_, reject) => {
          rejectDns = reject;
        }),
    );

    const enabledSnapshot = getWebhookSubscription(sub.id)!;
    const probePromise = executeWebhookTestProbe(enabledSnapshot, 'admin');
    await new Promise((r) => setTimeout(r, 30));

    updateWebhookSubscription(sub.id, (s) => {
      s.state = 'disabled';
      s.disabledReason = 'manual';
    });
    const pinned = getWebhookSubscription(sub.id)!;
    expect(pinned.state).toBe('disabled');
    const updatedAtPinned = pinned.updatedAt;

    // 等一小会儿再放行 DNS，确保 probe 结算走早退分支
    await new Promise((r) => setTimeout(r, 10));
    const err: any = new Error('getaddrinfo ENOTFOUND');
    err.code = 'ENOTFOUND';
    rejectDns(err);

    const probe = await probePromise;
    expect(probe.outcome).toBe('permanent');
    expect(probe.reason).toBe('webhook_disabled');

    const after = getWebhookSubscription(sub.id)!;
    expect(after.state).toBe('disabled');
    expect(after.disabledReason).toBe('manual');
    expect(after.consecutiveFailures).toBe(3);
    // 早退无变更 → updatedAt 不得漂移
    expect(after.updatedAt).toBe(updatedAtPinned);
  });
});

describe('#302 approval payload MIME folding', () => {
  const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const FROM = 'req-302@test.example';
  const TO = 'rev-302@test.example';
  const EXPIRES = '2026-09-21T00:00:00.000Z';

  // R6：必须改 config.dataDir（非仅 process.env）——config 模块导入时已钉死路径
  let prevDataDir = '';
  let tmpDir = '';

  beforeEach(() => {
    prevDataDir = config.dataDir;
    tmpDir = mkdtempSync(join(tmpdir(), 'oae-302-'));
    (config as any).dataDir = tmpDir;
    for (const localpart of ['req-302', 'rev-302']) {
      if (!findIdentity(`${localpart}@test.example`)) {
        createIdentity({ localpart, domain: 'test.example', issueToken: false });
      }
    }
  });

  afterEach(() => {
    (config as any).dataDir = prevDataDir;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  test('foldedRaw Approval-Payload survives production parse (strip + strict round-trip)', async () => {
    const source = encodeStampedApprovalRequestForTests({
      id: ID,
      from: FROM,
      to: TO,
      subject: 'Fold approval',
      body: 'please review',
      action: { type: 'change', name: 'review', arguments: { note: 'ok' } },
      expiresAt: EXPIRES,
    });
    const match = source.match(/^X-OA-Task-Approval-Payload:\s*(.+)$/m);
    expect(match?.[1]).toBeTruthy();
    const payloadValue = match![1]!;

    // 显式折行：每 40 字符插入 CRLF+WSP（模拟 MIME 中介）
    const fold = (value: string, every: number): string => {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i += every) parts.push(value.slice(i, i + every));
      return ['X-OA-Task-Approval-Payload:', ...parts.map((p) => ` ${p}`)].join('\r\n');
    };
    const foldedHeader = fold(payloadValue, 40);
    const foldedRaw = source.replace(/^X-OA-Task-Approval-Payload:\s*.+$/m, foldedHeader);

    const parsed = await parseStampedTaskMessageForTests({
      id: ID,
      uid: 1,
      source: foldedRaw,
      internalDate: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.approval).toMatchObject({ type: 'request' });
    expect(parsed?.state).toBe('input-required');
  });

  test('garbage non-whitespace (!!!!) still rejected after strip', async () => {
    const source = encodeStampedApprovalRequestForTests({
      id: ID,
      from: FROM,
      to: TO,
      subject: 'Garbage approval',
      body: 'please review',
      action: { type: 'change', name: 'review', arguments: {} },
      expiresAt: EXPIRES,
    });
    // 折行垃圾：strip 后仍是 !!!! —— 非 base64url
    const garbageFolded = 'X-OA-Task-Approval-Payload:\r\n !!!!\r\n !!!!';
    const bad = source.replace(/^X-OA-Task-Approval-Payload:\s*.+$/m, garbageFolded);
    const parsed = await parseStampedTaskMessageForTests({
      id: ID,
      uid: 1,
      source: bad,
      internalDate: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed).toBeNull();
  });
});

/** #313：显式 MIME 折行——每 every 字符插入 CRLF+WSP */
function foldHeaderValue313(name: string, value: string, every: number): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += every) parts.push(value.slice(i, i + every));
  return [`${name}:`, ...parts.map((p) => ` ${p}`)].join('\r\n');
}

describe('#313 approval digest MIME folding', () => {
  const ID = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  const FROM = 'req-313@test.example';
  const TO = 'rev-313@test.example';
  const EXPIRES = '2026-09-21T00:00:00.000Z';
  const ACTION = { type: 'change', name: 'review', arguments: { note: '313' } };

  let prevDataDir = '';
  let tmpDir = '';

  beforeEach(() => {
    prevDataDir = config.dataDir;
    tmpDir = mkdtempSync(join(tmpdir(), 'oae-313-'));
    (config as any).dataDir = tmpDir;
    for (const localpart of ['req-313', 'rev-313']) {
      if (!findIdentity(`${localpart}@test.example`)) {
        createIdentity({ localpart, domain: 'test.example', issueToken: false });
      }
    }
  });

  afterEach(() => {
    (config as any).dataDir = prevDataDir;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  // #313 T5：多续行折 digest → 解析成功（打中 :1186 regex / :1190 payload 比较 / :1211 snapshot）
  test('#313 T5 multi-continuation folded Approval-Digest survives production parse', async () => {
    const source = encodeStampedApprovalRequestForTests({
      id: ID, from: FROM, to: TO, subject: 'Fold digest T5',
      body: 'please review', action: ACTION, expiresAt: EXPIRES,
    });
    const match = source.match(/^X-OA-Task-Approval-Digest:\s*(.+)$/m);
    expect(match?.[1]).toBeTruthy();
    const digestValue = match![1]!;
    expect(digestValue).toMatch(/^[a-f0-9]{64}$/);
    // two-cont-40：64 hex 按 40 切 → 2 续行 → mailparser 留空白 → 修前 regex FAIL
    const foldedRaw = source.replace(
      /^X-OA-Task-Approval-Digest:\s*.+$/m,
      foldHeaderValue313('X-OA-Task-Approval-Digest', digestValue, 40),
    );
    const parsed = await parseStampedTaskMessageForTests({
      id: ID, uid: 1, source: foldedRaw, internalDate: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.approval).toMatchObject({ type: 'request' });
    expect(parsed?.state).toBe('input-required');
    // 断言 digest 还原为原 hex（打中 :1211 snapshot.digest === compact）
    expect((parsed?.approval as { snapshot?: { digest?: string } })?.snapshot?.digest).toBe(digestValue);
  });

  // #313 T5 决策路径：打中 :1225 resultDecision 比较 + :1230 digest 赋值
  test('#313 T5b multi-continuation folded digest on decision path', async () => {
    const digest = approvalActionDigest(ACTION);
    const source = encodeStampedApprovalDecisionForTests({
      id: ID, from: TO, to: FROM, subject: 'Fold digest decision',
      digest, decision: 'approved', decidedAt: '2026-09-21T00:01:00.000Z',
    });
    const foldedRaw = source.replace(
      /^X-OA-Task-Approval-Digest:\s*.+$/m,
      foldHeaderValue313('X-OA-Task-Approval-Digest', digest, 40),
    );
    const parsed = await parseStampedTaskMessageForTests({
      id: ID, uid: 2, source: foldedRaw, internalDate: '2026-09-21T00:01:00.000Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.approval).toMatchObject({ type: 'decision', digest, decision: 'approved' });
  });

  // #313 T5c 过期路径：打中 resultExpiry.digest 比较 + expired digest 赋值
  test('#313 T5c multi-continuation folded digest on expired path', async () => {
    const { createHmac: hmac } = await import('node:crypto');
    const digest = approvalActionDigest(ACTION);
    const expiredAt = '2026-09-21T00:02:00.000Z';
    // canonicalJson 按 key 排序：digest / event / expiredAt
    const canonical = `{"digest":"${digest}","event":"expired","expiredAt":"${expiredAt}"}`;
    const stamp = hmac('sha256', config.taskSigningSecret)
      .update(`approval-event-v1\n${ID}\nfailed\n${FROM.toLowerCase()}\n${TO.toLowerCase()}\n${canonical}`)
      .digest('base64url');
    const payloadHeader = Buffer.from(canonical, 'utf8').toString('base64url');
    const resultJson = JSON.stringify(
      { decision: 'expired', digest, expiredAt },
      null,
      2,
    );
    const source = [
      `From: ${FROM}`,
      `To: ${TO}`,
      `Subject: Fold digest expired`,
      `X-OA-Task: ${ID}`,
      `X-OA-Task-State: failed`,
      `X-OA-Task-Approval-Event: expired`,
      `X-OA-Task-Approval-Digest: ${digest}`,
      `X-OA-Task-Approval-Payload: ${payloadHeader}`,
      `X-OA-Task-Stamp: ${stamp}`,
      '',
      `<!-- openagent.email task result -->\n\`\`\`json\n${resultJson}\n\`\`\``,
    ].join('\r\n');
    const foldedRaw = source.replace(
      /^X-OA-Task-Approval-Digest:\s*.+$/m,
      foldHeaderValue313('X-OA-Task-Approval-Digest', digest, 40),
    );
    const parsed = await parseStampedTaskMessageForTests({
      id: ID, uid: 3, source: foldedRaw, internalDate: expiredAt,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.approval).toMatchObject({ type: 'expired', digest });
  });

  // #313 T6 负控：折行垃圾 digest → 拒
  test('#313 T6 multi-continuation folded garbage digest still rejected', async () => {
    const source = encodeStampedApprovalRequestForTests({
      id: ID, from: FROM, to: TO, subject: 'Garbage digest T6',
      body: 'please review', action: ACTION, expiresAt: EXPIRES,
    });
    const garbage = foldHeaderValue313('X-OA-Task-Approval-Digest', '!!!!not-a-digest!!!!not-a-digest!!!!not-a-digest!!!!', 20);
    const bad = source.replace(/^X-OA-Task-Approval-Digest:\s*.+$/m, garbage);
    const parsed = await parseStampedTaskMessageForTests({
      id: ID, uid: 1, source: bad, internalDate: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed).toBeNull();
  });
});

afterAll(async () => {
  (config.webhooks as any).enabled = false;
  setWebhookDnsLookupForTests(undefined);
  deliveryQueue.cancelAll();
  // R7（方案 b）：文件清理全部钉在 TEST_DATA_DIR——resetWebhooksStoreForTests 会 unlink
  // webhooks.json{,.tmp,.failclosed}；deleteIdentity 写 identities.json。
  // 内存 failClosed 重置仍经 reset 无条件执行；filtered 跑 #302 不触碰真实 store。
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as any).dataDir = TEST_DATA_DIR;
  resetWebhooksStoreForTests();
  try {
    deleteIdentity('alice@test.example');
  } catch {
    /* ignore */
  }
  (config as any).dataDir = originalDataDir;
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
