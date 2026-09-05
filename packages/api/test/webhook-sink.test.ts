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

const { config } = await import('../src/lib/config.ts');
const { createWebhookSink } = await import('../src/lib/webhook-sink.ts');
const {
  deliveryQueue,
  readAllDeliveryLogRows,
} = await import('../src/lib/webhook-delivery.ts');
const {
  createWebhookSubscription,
  setWebhooksFailClosedForTests,
} = await import('../src/lib/webhook-store.ts');
const { isSinkServiceFailure } = await import('../src/lib/event-dispatcher.ts');
import type { ApprovalTask } from '../src/lib/tasks-internal.ts';
import type { MailReceivedEvent } from '../src/lib/event-dispatcher.ts';

const TEST_DATA_DIR = join(import.meta.dir, 'tmp-webhook-sink');
const originalDataDir = config.dataDir;

function setupTestDir(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
  (config as any).dataDir = TEST_DATA_DIR;
  (config.webhooks as any).enabled = true;
  (config as any).taskSigningSecret = '01234567890123456789012345678901';
  (config.webhooks as any).signingSecret = '01234567890123456789012345678901';
  setWebhooksFailClosedForTests(false);
  deliveryQueue.cancelAll();
}

describe('webhook-sink: Dispatcher Sink Wiring (§11.4, §6.2, §6.3, Item 9)', () => {
  beforeEach(setupTestDir);
  afterEach(() => {
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('handleApproval enqueues delivery for matching reviewer and trims task to §6.3 schema', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      events: ['approval.requested'],
      contentScope: 'preview',
      address: 'reviewer@test.example',
    });

    const sink = createWebhookSink();
    expect(sink.isEnabled()).toBe(true);

    const taskCreatedAt = '2026-09-05T00:00:00.000Z';
    const expiresAt = '2026-09-06T00:00:00.000Z'; // 86400s later
    const task: ApprovalTask = {
      id: '3f8a1c62-9d4e-4b07-a5f1-6c2e8d904b73',
      kind: 'approval',
      state: 'input-required',
      from: 'initiator@test.example',
      to: 'reviewer@test.example',
      subject: 'Please approve wire transfer',
      messages: [],
      createdAt: taskCreatedAt,
      updatedAt: taskCreatedAt,
      approval: {
        reviewer: 'reviewer@test.example',
        expiresAt,
        digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        action: {
          type: 'wire',
          name: 'send_funds',
          arguments: { amount: 1000, recipient: 'vendor' },
        },
      },
    };

    await sink.handleApproval!({
      type: 'approval.requested',
      task,
    });

    const rows = readAllDeliveryLogRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.webhookId).toBe(sub.id);
    expect(row.type).toBe('approval.requested');
    expect(row.taskId).toBe(task.id);
    expect(row.taskCreatedAt).toBe(taskCreatedAt);
    expect(row.expiresInSec).toBe(86400);
    expect(row.outcome).toBe('pending');
  });

  test('handleMail matches recipient and enqueues delivery with flags and internalDate', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      events: ['mail.received'],
      contentScope: 'preview',
      address: 'agent@test.example',
    });

    const sink = createWebhookSink();
    const internalDate = new Date('2026-09-05T01:23:45.000Z');

    const rawMime =
      'From: Sender <sender@external.example>\r\n' +
      'To: agent@test.example\r\n' +
      'Subject: Verify your login\r\n' +
      'Message-ID: <msg-123@external.example>\r\n' +
      'Content-Type: text/plain\r\n' +
      '\r\n' +
      'Your OTP code is: 987654. Click: https://external.example/verify\r\n';

    const mailEvent: MailReceivedEvent = {
      type: 'mail.received',
      message: {
        uid: 101,
        internalDate,
        flags: new Set(), // unread
        envelope: {
          from: [{ name: 'Sender', address: 'sender@external.example' }],
          to: [{ address: 'agent@test.example' }],
          subject: 'Verify your login',
          messageId: '<msg-123@external.example>',
        },
        source: Buffer.from(rawMime, 'utf8'),
      },
      uidValidity: 42n,
    };

    await sink.handleMail!(mailEvent);

    const rows = readAllDeliveryLogRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.webhookId).toBe(sub.id);
    expect(row.type).toBe('mail.received');
    expect(row.messageId).toBe('101');
    expect(row.uidValidity).toBe(42);
    expect(row.rfc822MessageId).toBe('<msg-123@external.example>');
    expect(row.outcome).toBe('pending');
  });

  test('R7: handleMail wraps store-corrupt as a service failure', async () => {
    const sink = createWebhookSink();
    setWebhooksFailClosedForTests(true);
    const mailEvent: MailReceivedEvent = {
      type: 'mail.received',
      message: {
        uid: 202,
        internalDate: new Date(),
        flags: new Set(),
        envelope: {
          from: [{ address: 'sender@external.example' }],
          to: [{ address: 'agent@test.example' }],
          subject: 'x',
        },
        source: Buffer.from('From: sender@external.example\r\nTo: agent@test.example\r\n\r\nbody\r\n'),
      },
    };
    try {
      await sink.handleMail!(mailEvent);
      expect().fail('should have thrown');
    } catch (err) {
      expect(isSinkServiceFailure(err)).toBe(true);
      expect((err as { failureKind?: string }).failureKind).toBe('service');
    } finally {
      setWebhooksFailClosedForTests(false);
    }
  });

  test('handleMail treats overlong rfc822MessageId (>512 bytes) as null (Item 5)', async () => {
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/hook',
      events: ['mail.received'],
      contentScope: 'metadata',
      address: 'agent@test.example',
    });

    const sink = createWebhookSink();
    const overlongId = '<' + 'x'.repeat(600) + '@example.com>';

    const mailEvent: MailReceivedEvent = {
      type: 'mail.received',
      message: {
        uid: 102,
        internalDate: new Date(),
        flags: new Set(['\\Seen']),
        envelope: {
          from: [{ address: 'sender@example.com' }],
          to: [{ address: 'agent@test.example' }],
          subject: 'Overlong test',
          messageId: overlongId,
        },
      },
      uidValidity: 1n,
    };

    await sink.handleMail!(mailEvent);

    const rows = readAllDeliveryLogRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.rfc822MessageId).toBeNull();
  });

  afterAll(async () => {
    (config as any).dataDir = originalDataDir;
    (config.webhooks as any).enabled = false;
    delete process.env.WEBHOOKS_ENABLED;
    deliveryQueue.cancelAll();
    await new Promise((r) => setTimeout(r, 50));
    deliveryQueue.cancelAll();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });
});
