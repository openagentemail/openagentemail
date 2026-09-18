/**
 * #202 invalid_cursor 可观测性：共用 helper + 四族拒收路径负控。
 *
 * 验收：
 * ① stale（形状合法、窗外）→ 恰 1 条 info，三枚标签，日志无游标原文
 * ② 窗内 well-formed unmatched → warn 单行
 * ③ 400 响应体与既有钉测逐字一致 `{error:'invalid_cursor'}`
 * mutation：classify 把 warn 降成 info → 分级断言必红
 */

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';
process.env.TASK_SIGNING_SECRET = '01234567890123456789012345678901';
process.env.WEBHOOK_SIGNING_SECRET = '01234567890123456789012345678901';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InvalidCursorFamily,
  InvalidCursorShape,
} from '../src/lib/invalid-cursor-observability.ts';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const {
  classifyInvalidCursorLevel,
  inspectDeliveryCursor,
  inspectMailCursor,
  inspectSendCursor,
  inspectTaskCursor,
  logInvalidCursorRejection,
  logInvalidCursorRejectionFor,
  setInvalidCursorLogSinkForTests,
  INVALID_CURSOR_LOG_EVENT,
} = await import('../src/lib/invalid-cursor-observability.ts');
const {
  appendDeliveryLogRow,
  resetDeliveryLogIndexForTests,
  resetDeliveryLogIoForTests,
} = await import('../src/lib/webhook-delivery.ts');
const {
  createWebhookSubscription,
  resetWebhooksStoreForTests,
  setWebhooksFailClosedForTests,
} = await import('../src/lib/webhook-store.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const {
  MAIL_CURSOR_PREFIX,
  encodeMailCursor,
} = await import('../src/lib/mail-cursor.ts');
const {
  TASK_BOARD_CURSOR_PREFIX,
  encodeTaskBoardCursor,
} = await import('../src/lib/task-cursor.ts');
const { SEND_LOG_RETENTION_MS } = await import('../src/lib/send-log.ts');

const TEST_DATA_DIR = join(import.meta.dir, 'tmp-invalid-cursor-obs');
const originalDataDir = config.dataDir;
const adminKey = [...config.apiKeys][0] || 'test-key';

type Captured = { level: 'info' | 'warn'; line: string };

function installCapture(): Captured[] {
  const lines: Captured[] = [];
  setInvalidCursorLogSinkForTests({
    info: (msg) => lines.push({ level: 'info', line: String(msg) }),
    warn: (msg) => lines.push({ level: 'warn', line: String(msg) }),
  });
  return lines;
}

function parseLine(line: string): {
  event: string;
  family: InvalidCursorFamily;
  shape: InvalidCursorShape;
  within_retention: boolean;
} {
  return JSON.parse(line) as {
    event: string;
    family: InvalidCursorFamily;
    shape: InvalidCursorShape;
    within_retention: boolean;
  };
}

/** 伪造 send-log 游标：可刻意坏 MAC，body 仍可供软解析。 */
function forgeSendCursor(opts: { t: number; id?: string; addr?: string; badMac?: boolean }): string {
  const payload = {
    addr: opts.addr ?? 'fox@test.example',
    t: opts.t,
    id: opts.id ?? `snd_${'ab'.repeat(12)}`,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = opts.badMac
    ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    : createHmac('sha256', createHmac('sha256', config.taskSigningSecret).update('send-log-cursor-v1').digest())
        .update(`send-log-cursor-v1\n${payload.addr}\n${payload.t}\n${payload.id}`)
        .digest('base64url');
  return `send-log-cursor-v1.${body}.${mac}`;
}

/** 伪造 mail-cursor-v2：坏 MAC，软解析仍可读 t。 */
function forgeMailCursor(opts: { t: number; badMac?: boolean }): string {
  if (!opts.badMac) {
    return encodeMailCursor(
      {
        folder: 'inbox',
        address: 'alice@test.example',
        t: opts.t,
        uid: 42,
        uidValidity: '17',
      },
      config.taskSigningSecret,
    );
  }
  const body = Buffer.from(
    JSON.stringify({ f: 'inbox', a: 'alice@test.example', t: opts.t, u: 42, v: '17' }),
  ).toString('base64url');
  return `${MAIL_CURSOR_PREFIX}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
}

/** 伪造 task-board 游标：坏 MAC。 */
function forgeTaskCursor(opts: { t: number; badMac?: boolean }): string {
  if (!opts.badMac) {
    return encodeTaskBoardCursor({ fp: 'all|7d|admin', t: opts.t, id: randomUUID() });
  }
  const payload = { fp: 'all|7d|admin', t: opts.t, id: randomUUID() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${TASK_BOARD_CURSOR_PREFIX}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
}

function daysAgoMs(days: number, now = Date.now()): number {
  return now - days * 86_400_000;
}

describe('#202 invalid_cursor observability helper', () => {
  afterEach(() => {
    setInvalidCursorLogSinkForTests(undefined);
  });

  test('classify: stale=info；anomaly=warn（malformed 或窗内 well-formed）', () => {
    expect(classifyInvalidCursorLevel('full', false)).toBe('info');
    expect(classifyInvalidCursorLevel('bare_id', false)).toBe('info');
    expect(classifyInvalidCursorLevel('full', true)).toBe('warn');
    expect(classifyInvalidCursorLevel('bare_id', true)).toBe('warn');
    expect(classifyInvalidCursorLevel('malformed', false)).toBe('warn');
    expect(classifyInvalidCursorLevel('malformed', true)).toBe('warn');
  });

  test('mutation 负控：若把 warn 路径误降为 info，分级契约必红', () => {
    // 模拟错误实现：一律 info。真实 classify 对 anomaly（含未来 ts→within_retention）必须 warn。
    const buggy = (_shape: InvalidCursorShape, _within: boolean): 'info' | 'warn' => 'info';
    expect(buggy('malformed', false)).toBe('info');
    expect(classifyInvalidCursorLevel('malformed', false)).toBe('warn');
    expect(buggy('full', true)).toBe('info');
    expect(classifyInvalidCursorLevel('full', true)).toBe('warn');
    // R2 P1-2：未来 ts 经 inspect 得 within_retention=true，误降 info 必与真实分级冲突
    const now = Date.now();
    const future = inspectDeliveryCursor(
      `dlv_${randomUUID()}|1|${new Date(now + 60_000).toISOString()}`,
      now,
    );
    expect(future).toEqual({ shape: 'full', within_retention: true });
    expect(buggy(future.shape, future.within_retention)).toBe('info');
    expect(classifyInvalidCursorLevel(future.shape, future.within_retention)).toBe('warn');
  });

  test('log 单行恰三枚标签，永不回写游标原文', () => {
    const lines = installCapture();
    const canary = `dlv_${randomUUID()}|1|${new Date().toISOString()}`;
    logInvalidCursorRejection({
      family: 'deliveries',
      shape: 'full',
      within_retention: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    const parsed = parseLine(lines[0]!.line);
    expect(parsed).toEqual({
      event: INVALID_CURSOR_LOG_EVENT,
      family: 'deliveries',
      shape: 'full',
      within_retention: false,
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'event',
      'family',
      'shape',
      'within_retention',
    ]);
    expect(lines[0]!.line).not.toContain(canary);
    expect(lines[0]!.line).not.toContain('dlv_');
  });

  test('inspectDeliveryCursor: full / bare_id / malformed + 盘留存窗', () => {
    const now = Date.now();
    const id = `dlv_${randomUUID()}`;
    const outside = inspectDeliveryCursor(
      `${id}|1|${new Date(daysAgoMs(60, now)).toISOString()}`,
      now,
    );
    expect(outside).toEqual({ shape: 'full', within_retention: false });
    const inside = inspectDeliveryCursor(
      `${id}|2|${new Date(daysAgoMs(1, now)).toISOString()}`,
      now,
    );
    expect(inside).toEqual({ shape: 'full', within_retention: true });
    expect(inspectDeliveryCursor(id, now)).toEqual({ shape: 'bare_id', within_retention: false });
    expect(inspectDeliveryCursor('not-a-cursor', now)).toEqual({
      shape: 'malformed',
      within_retention: false,
    });
  });

  test('inspectSend/Mail/Task: 窗外 full→stale；窗内 full→anomaly 输入', () => {
    const now = Date.now();
    const sendOut = inspectSendCursor(forgeSendCursor({ t: daysAgoMs(60, now), badMac: true }), now);
    expect(sendOut).toEqual({ shape: 'full', within_retention: false });
    const sendIn = inspectSendCursor(forgeSendCursor({ t: daysAgoMs(1, now), badMac: true }), now);
    expect(sendIn).toEqual({ shape: 'full', within_retention: true });
    expect(SEND_LOG_RETENTION_MS).toBeGreaterThan(0);

    const mailOut = inspectMailCursor(forgeMailCursor({ t: daysAgoMs(60, now), badMac: true }), now);
    expect(mailOut).toEqual({ shape: 'full', within_retention: false });
    const mailIn = inspectMailCursor(forgeMailCursor({ t: daysAgoMs(1, now), badMac: true }), now);
    expect(mailIn).toEqual({ shape: 'full', within_retention: true });

    const taskOut = inspectTaskCursor(forgeTaskCursor({ t: daysAgoMs(60, now), badMac: true }), now);
    expect(taskOut).toEqual({ shape: 'full', within_retention: false });
    const taskIn = inspectTaskCursor(forgeTaskCursor({ t: daysAgoMs(1, now), badMac: true }), now);
    expect(taskIn).toEqual({ shape: 'full', within_retention: true });
  });

  test('R2 P1-2：future-ts full 游标必出 warn（不得归 stale/info）', () => {
    const now = Date.now();
    const futureMs = now + 3_600_000;
    const lines = installCapture();

    const del = inspectDeliveryCursor(
      `dlv_${randomUUID()}|1|${new Date(futureMs).toISOString()}`,
      now,
    );
    expect(del).toEqual({ shape: 'full', within_retention: true });
    expect(classifyInvalidCursorLevel(del.shape, del.within_retention)).toBe('warn');

    const send = inspectSendCursor(forgeSendCursor({ t: futureMs, badMac: true }), now);
    expect(send).toEqual({ shape: 'full', within_retention: true });
    const mail = inspectMailCursor(forgeMailCursor({ t: futureMs, badMac: true }), now);
    expect(mail).toEqual({ shape: 'full', within_retention: true });
    const task = inspectTaskCursor(forgeTaskCursor({ t: futureMs, badMac: true }), now);
    expect(task).toEqual({ shape: 'full', within_retention: true });

    logInvalidCursorRejection({ family: 'deliveries', ...del });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line).within_retention).toBe(true);
  });

  test('R2 P1-1：缺 codec 必填键 → malformed（不拒多余键）', () => {
    const now = Date.now();
    // mail v2 缺 v
    const mailBody = Buffer.from(
      JSON.stringify({ f: 'inbox', a: 'alice@test.example', t: now - 1000, u: 42 }),
    ).toString('base64url');
    expect(
      inspectMailCursor(`${MAIL_CURSOR_PREFIX}.${mailBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, now),
    ).toEqual({ shape: 'malformed', within_retention: false });

    // mail 多余键仍 full（不 strict）
    const mailExtra = Buffer.from(
      JSON.stringify({
        f: 'inbox',
        a: 'alice@test.example',
        t: now - 1000,
        u: 42,
        v: '17',
        extra: 'ignored',
      }),
    ).toString('base64url');
    expect(
      inspectMailCursor(
        `${MAIL_CURSOR_PREFIX}.${mailExtra}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        now,
      ),
    ).toEqual({ shape: 'full', within_retention: true });

    // send 缺 id
    const sendBody = Buffer.from(
      JSON.stringify({ addr: 'fox@test.example', t: now - 1000 }),
    ).toString('base64url');
    expect(inspectSendCursor(`send-log-cursor-v1.${sendBody}.AAA`, now)).toEqual({
      shape: 'malformed',
      within_retention: false,
    });

    // tasks 缺 fp
    const taskBody = Buffer.from(
      JSON.stringify({ t: now - 1000, id: randomUUID() }),
    ).toString('base64url');
    expect(inspectTaskCursor(`${TASK_BOARD_CURSOR_PREFIX}.${taskBody}.AAA`, now)).toEqual({
      shape: 'malformed',
      within_retention: false,
    });
  });

  test('R3：v=2^53 number 必 malformed/warn；string 大数仍 full', () => {
    const now = Date.now();
    const lines = installCapture();
    // number 2^53 超 safe integer → malformed（对齐 canonicalizeMailUidValidity）
    const unsafeBody = Buffer.from(
      JSON.stringify({
        f: 'inbox',
        a: 'alice@test.example',
        t: now - 1000,
        u: 42,
        v: 2 ** 53,
      }),
    ).toString('base64url');
    const unsafe = inspectMailCursor(
      `${MAIL_CURSOR_PREFIX}.${unsafeBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      now,
    );
    expect(unsafe).toEqual({ shape: 'malformed', within_retention: false });
    expect(classifyInvalidCursorLevel(unsafe.shape, unsafe.within_retention)).toBe('warn');
    logInvalidCursorRejection({ family: 'messages', ...unsafe });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');

    // string 分支：任意精度数字串仍收（BigInt）
    const bigStrBody = Buffer.from(
      JSON.stringify({
        f: 'inbox',
        a: 'alice@test.example',
        t: now - 1000,
        u: 42,
        v: String(2 ** 53),
      }),
    ).toString('base64url');
    expect(
      inspectMailCursor(
        `${MAIL_CURSOR_PREFIX}.${bigStrBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        now,
      ),
    ).toEqual({ shape: 'full', within_retention: true });
  });

  test('R3：deliveries 非规范 UUID / attempt=0 → malformed', () => {
    const now = Date.now();
    // dlv_ + 36 字符含连字符但非 8-4-4-4-12 固定位 → malformed
    const withHyphensWrong = `dlv_${'a'.repeat(32)}----`; // 32 hex + 4 hyphens = 36，位宽不对
    expect(withHyphensWrong.slice(4).length).toBe(36);
    expect(inspectDeliveryCursor(withHyphensWrong, now)).toEqual({
      shape: 'malformed',
      within_retention: false,
    });

    // attempt=0 必 malformed
    const id = `dlv_${randomUUID()}`;
    expect(
      inspectDeliveryCursor(`${id}|0|${new Date(now - 1000).toISOString()}`, now),
    ).toEqual({ shape: 'malformed', within_retention: false });

    // 规范 UUID + attempt≥1 仍 full
    expect(
      inspectDeliveryCursor(`${id}|1|${new Date(now - 1000).toISOString()}`, now),
    ).toEqual({ shape: 'full', within_retention: true });
  });
});

/** 前向 since 游标（REST messages 用 mail-fcursor-v1）。 */
function forgeForwardMailCursor(opts: { t: number }): string {
  const body = Buffer.from(
    JSON.stringify({ f: 'inbox', a: 'alice@test.example', t: opts.t, u: 42, v: '17' }),
  ).toString('base64url');
  return `mail-fcursor-v1.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
}

describe('#202 四族路由负控', () => {
  let app: ReturnType<typeof createApp>;
  let aliceToken: string;

  beforeEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
    (config as { dataDir: string }).dataDir = TEST_DATA_DIR;
    (config.webhooks as { enabled: boolean }).enabled = true;
    (config as { retentionDays: number }).retentionDays = 30;
    (config.webhooks as { logRetentionDays: number }).logRetentionDays = 30;
    config.apiKeys.add('test-key');
    resetDeliveryLogIndexForTests();
    resetDeliveryLogIoForTests();
    resetWebhooksStoreForTests();
    setWebhooksFailClosedForTests(false);
    const alice = createIdentity({ localpart: 'alice', domain: 'test.example' });
    aliceToken = alice?.token ?? '';
    app = createApp();
  });

  afterEach(() => {
    setInvalidCursorLogSinkForTests(undefined);
    (config as { dataDir: string }).dataDir = originalDataDir;
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  test('① stale（形状合法、窗外）四族各恰 1 条 info，三标签，无游标原文', async () => {
    const { Hono } = await import('hono');
    const { UiSessionStore } = await import('../src/lib/ui-session.ts');
    const { createUiApiRoutes } = await import('../src/routes/ui.ts');
    const { InvalidTaskCursorError } = await import('../src/lib/task-cursor.ts');
    const { InvalidMailCursorError } = await import('../src/lib/mail-cursor.ts');

    const now = Date.now();
    const lines = installCapture();
    const families: InvalidCursorFamily[] = ['deliveries', 'messages', 'send', 'tasks'];
    const cursors: Record<InvalidCursorFamily, string> = {
      deliveries: `dlv_${randomUUID()}|1|${new Date(daysAgoMs(60, now)).toISOString()}`,
      messages: forgeForwardMailCursor({ t: daysAgoMs(60, now) }),
      send: forgeSendCursor({ t: daysAgoMs(60, now), badMac: true }),
      tasks: forgeTaskCursor({ t: daysAgoMs(60, now), badMac: true }),
    };

    // —— deliveries（v1）——
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/202-stale',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'admin',
    });
    const ts = new Date().toISOString();
    appendDeliveryLogRow({
      ts,
      webhookId: sub.id,
      eventId: 'evt_202_1',
      runId: 'run_0',
      deliveryId: `dlv_${randomUUID()}`,
      type: 'mail.received',
      address: sub.address,
      messageId: '1',
      uidValidity: 1,
      rfc822MessageId: null,
      taskId: null,
      taskCreatedAt: null,
      expiresInSec: null,
      eventCreatedAt: ts,
      attempt: 1,
      outcome: 'success',
      status: 200,
      durationMs: 8,
      sensitive: false,
      replay: false,
      nextAttemptAt: null,
      reason: null,
    });
    resetDeliveryLogIndexForTests();

    const delRes = await app.request(
      `/v1/webhooks/${sub.id}/deliveries?limit=2&cursor=${encodeURIComponent(cursors.deliveries)}`,
      { headers: { Authorization: `Bearer ${adminKey}` } },
    );
    expect(delRes.status).toBe(400);
    expect(await delRes.json()).toEqual({ error: 'invalid_cursor' });

    // —— send（v1）——
    const sendRes = await app.request(
      `/v1/send/history?limit=20&cursor=${encodeURIComponent(cursors.send)}`,
      { headers: { Authorization: `Bearer ${aliceToken}` } },
    );
    expect(sendRes.status).toBe(400);
    expect(await sendRes.json()).toEqual({ error: 'invalid_cursor' });

    // —— messages + tasks：UI 会话路由（避免全栈 Origin/IMAP）——
    const store = new UiSessionStore({
      resolveToken: (token) => (token === 'ok' ? { kind: 'admin' } : null),
    });
    const created = store.create('ok', '127.0.0.1');
    if (!created.ok) throw new Error('test session was not created');
    const cookie = `oae_ui=${created.sid}`;
    const ui = new Hono();
    ui.route(
      '/ui/api',
      createUiApiRoutes(store, {
        listIdentities: () => [],
        listMessages: async () => {
          throw new InvalidMailCursorError();
        },
        setMessageSeen: async () => true,
        getMailboxScan: async () => ({
          kind: 'ready' as const,
          now: Date.now(),
          snapshot: null,
          cached: false,
          revalidating: false,
          refreshError: false,
        }),
        getMessage: async () => null,
        setPushContentTier: () => null,
        taskService: {
          listBoard: async () => {
            throw new InvalidTaskCursorError();
          },
        } as never,
      }),
    );

    const msgRes = await ui.request(
      `/ui/api/messages?address=alice@test.example&limit=20&cursor=${encodeURIComponent(cursors.messages)}`,
      { headers: { cookie } },
    );
    expect(msgRes.status).toBe(400);
    expect(await msgRes.json()).toEqual({ error: 'invalid_cursor' });

    const taskRes = await ui.request(
      `/ui/api/tasks?status=all&period=7d&limit=20&cursor=${encodeURIComponent(cursors.tasks)}`,
      { headers: { cookie } },
    );
    expect(taskRes.status).toBe(400);
    expect(await taskRes.json()).toEqual({ error: 'invalid_cursor' });

    expect(lines).toHaveLength(4);
    for (const family of families) {
      const hit = lines.filter((l) => parseLine(l.line).family === family);
      expect(hit).toHaveLength(1);
      expect(hit[0]!.level).toBe('info');
      const parsed = parseLine(hit[0]!.line);
      expect(parsed.event).toBe(INVALID_CURSOR_LOG_EVENT);
      expect(parsed.shape).toBe('full');
      expect(parsed.within_retention).toBe(false);
      expect(Object.keys(parsed).sort()).toEqual([
        'event',
        'family',
        'shape',
        'within_retention',
      ]);
      expect(hit[0]!.line).not.toContain(cursors[family]);
    }
  });

  test('② 窗内 well-formed unmatched → warn 单行（deliveries 代表）', async () => {
    const now = Date.now();
    const lines = installCapture();
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/202-anomaly',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'admin',
    });
    const cursor = `dlv_${randomUUID()}|1|${new Date(daysAgoMs(1, now)).toISOString()}`;
    const res = await app.request(
      `/v1/webhooks/${sub.id}/deliveries?limit=2&cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: `Bearer ${adminKey}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    const parsed = parseLine(lines[0]!.line);
    expect(parsed).toEqual({
      event: INVALID_CURSOR_LOG_EVENT,
      family: 'deliveries',
      shape: 'full',
      within_retention: true,
    });
    expect(lines[0]!.line).not.toContain(cursor);
  });

  test('③ malformed → warn；400 体仍逐字 invalid_cursor', async () => {
    const lines = installCapture();
    logInvalidCursorRejectionFor('send', '%%%not-a-cursor%%%');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line).shape).toBe('malformed');

    const res = await app.request(`/v1/send/history?limit=20&cursor=${encodeURIComponent('%%%')}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
  });
});
