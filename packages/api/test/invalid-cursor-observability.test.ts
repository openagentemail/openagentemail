/**
 * #202 / #270 invalid_cursor 可观测性：共用 helper + 四族拒收路径负控。
 *
 * #270 根治：decoder kind 直传；软解退役；malformed/unmatched 以真实解码为准。
 *
 * 验收：
 * ① stale（lookup_miss、窗外）→ 恰 1 条 info，三枚标签，日志无游标原文
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
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  InvalidCursorFamily,
  InvalidCursorShape,
} from '../src/lib/invalid-cursor-observability.ts';

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const {
  classifyInvalidCursorLevel,
  inspectionFromKind,
  logInvalidCursorRejection,
  logInvalidCursorRejectionFor,
  setInvalidCursorLogSinkForTests,
  INVALID_CURSOR_LOG_EVENT,
} = await import('../src/lib/invalid-cursor-observability.ts');
const {
  appendDeliveryLogRow,
  DELIVERIES_CURSOR_MAX_LENGTH,
  parseDeliveryListCursor,
  InvalidDeliveryCursorError,
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
  InvalidMailCursorError,
  decodeMailCursor,
  encodeMailCursor,
} = await import('../src/lib/mail-cursor.ts');
const {
  TASK_BOARD_CURSOR_PREFIX,
  InvalidTaskCursorError,
  encodeTaskBoardCursor,
} = await import('../src/lib/task-cursor.ts');
const { SEND_LOG_RETENTION_MS, InvalidSendCursorError, encodeSendLogCursorForTests } =
  await import('../src/lib/send-log.ts');

// #350 E2：系统临时目录，避免仓树内落未跟踪 tmp-*
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-invalid-cursor-obs-'));
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

/** 伪造 send-log 游标（默认好 MAC；可指定 addr 制造 lookup_miss）。 */
function forgeSendCursor(opts: { t: number; id?: string; addr?: string; badMac?: boolean }): string {
  const payload = {
    addr: opts.addr ?? 'fox@test.example',
    t: opts.t,
    id: opts.id ?? `snd_${'ab'.repeat(12)}`,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // MAC 必须与 send-log 模块加载时冻结的 cursorKey 同源——禁吃「可能被并发改写」的 live config
  const frozenSecret = '01234567890123456789012345678901';
  const mac = opts.badMac
    ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    : createHmac('sha256', createHmac('sha256', frozenSecret).update('send-log-cursor-v1').digest())
        .update(`send-log-cursor-v1\n${payload.addr}\n${payload.t}\n${payload.id}`)
        .digest('base64url');
  return `send-log-cursor-v1.${body}.${mac}`;
}

function daysAgoMs(days: number, now = Date.now()): number {
  return now - days * 86_400_000;
}

describe('#202/#270 invalid_cursor observability helper', () => {
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
    const buggy = (_shape: InvalidCursorShape, _within: boolean): 'info' | 'warn' => 'info';
    expect(buggy('malformed', false)).toBe('info');
    expect(classifyInvalidCursorLevel('malformed', false)).toBe('warn');
    expect(buggy('full', true)).toBe('info');
    expect(classifyInvalidCursorLevel('full', true)).toBe('warn');
    // 未来 ts：lookup_miss + cursorTs>now → within_retention=true → warn
    const now = Date.now();
    const future = inspectionFromKind('deliveries', 'lookup_miss', now + 60_000, now);
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

  test('inspectionFromKind: parse_fail→malformed；lookup_miss±ts→full/bare_id', () => {
    const now = Date.now();
    expect(inspectionFromKind('deliveries', 'parse_fail')).toEqual({
      shape: 'malformed',
      within_retention: false,
    });
    expect(inspectionFromKind('deliveries', 'lookup_miss')).toEqual({
      shape: 'bare_id',
      within_retention: false,
    });
    expect(inspectionFromKind('deliveries', 'lookup_miss', daysAgoMs(60, now), now)).toEqual({
      shape: 'full',
      within_retention: false,
    });
    expect(inspectionFromKind('deliveries', 'lookup_miss', daysAgoMs(1, now), now)).toEqual({
      shape: 'full',
      within_retention: true,
    });
    expect(SEND_LOG_RETENTION_MS).toBeGreaterThan(0);
  });

  // 锚 :240 —— 未来 ts lookup_miss 必 warn
  test('R2 P1-2：future-ts lookup_miss 必出 warn（不得归 stale/info）', () => {
    const now = Date.now();
    const futureMs = now + 3_600_000;
    const lines = installCapture();
    const del = inspectionFromKind('deliveries', 'lookup_miss', futureMs, now);
    expect(del).toEqual({ shape: 'full', within_retention: true });
    expect(classifyInvalidCursorLevel(del.shape, del.within_retention)).toBe('warn');
    for (const family of ['send', 'messages', 'tasks'] as const) {
      const hit = inspectionFromKind(family, 'lookup_miss', futureMs, now);
      expect(hit).toEqual({ shape: 'full', within_retention: true });
    }
    logInvalidCursorRejection({ family: 'deliveries', ...del });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line).within_retention).toBe(true);
  });

  // 锚 :265 —— 缺 codec 必填 → decoder parse_fail（不再软解）
  test('R2 P1-1：缺 codec 必填键 → decoder parse_fail（软解退役）', () => {
    const now = Date.now();
    // mail v2 缺 v → decode 抛 parse_fail
    const mailBody = Buffer.from(
      JSON.stringify({ f: 'inbox', a: 'alice@test.example', t: now - 1000, u: 42 }),
    ).toString('base64url');
    expect(() =>
      decodeMailCursor(
        `${MAIL_CURSOR_PREFIX}.${mailBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        config.taskSigningSecret,
      ),
    ).toThrow(InvalidMailCursorError);
    try {
      decodeMailCursor(
        `${MAIL_CURSOR_PREFIX}.${mailBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        config.taskSigningSecret,
      );
    } catch (err) {
      expect((err as InvalidMailCursorError).kind).toBe('parse_fail');
    }
    // helper：parse_fail → malformed
    expect(inspectionFromKind('messages', 'parse_fail')).toEqual({
      shape: 'malformed',
      within_retention: false,
    });
    // send 坏串 → 路由侧 parse_fail
    expect(inspectionFromKind('send', 'parse_fail')).toEqual({
      shape: 'malformed',
      within_retention: false,
    });
  });

  // 锚 :312 —— v=2^53 number 必 parse_fail；string 大数仍可编码
  test('R3：v=2^53 number 必 parse_fail/warn；string 大数仍可 encode', () => {
    const now = Date.now();
    const lines = installCapture();
    const unsafeBody = Buffer.from(
      JSON.stringify({
        f: 'inbox',
        a: 'alice@test.example',
        t: now - 1000,
        u: 42,
        v: 2 ** 53,
      }),
    ).toString('base64url');
    try {
      decodeMailCursor(
        `${MAIL_CURSOR_PREFIX}.${unsafeBody}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        config.taskSigningSecret,
      );
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMailCursorError);
      expect((err as InvalidMailCursorError).kind).toBe('parse_fail');
    }
    logInvalidCursorRejectionFor('messages', 'parse_fail');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line).shape).toBe('malformed');

    // string 分支：任意精度仍可生成合法游标
    const ok = encodeMailCursor(
      {
        folder: 'inbox',
        address: 'alice@test.example',
        t: now - 1000,
        uid: 42,
        uidValidity: String(2 ** 53),
      },
      config.taskSigningSecret,
    );
    expect(ok.startsWith(MAIL_CURSOR_PREFIX)).toBe(true);
  });

  // 锚 :353 —— deliveries 非规范 + 前导零 attempt + 残缺 ISO → parse_fail
  test('R3/#270：deliveries 非规范 UUID / attempt=0 / 前导零 / 残缺 ISO → parse_fail', () => {
    const now = Date.now();
    const withHyphensWrong = `dlv_${'a'.repeat(32)}----`;
    expect(withHyphensWrong.slice(4).length).toBe(36);
    expect(() => parseDeliveryListCursor(withHyphensWrong)).toThrow(InvalidDeliveryCursorError);

    const id = `dlv_${randomUUID()}`;
    expect(() => parseDeliveryListCursor(`${id}|0|${new Date(now - 1000).toISOString()}`)).toThrow(
      InvalidDeliveryCursorError,
    );
    // attempt 前导零 `01` → parse_fail（生产永不生成）
    expect(() => parseDeliveryListCursor(`${id}|01|${new Date(now - 1000).toISOString()}`)).toThrow(
      InvalidDeliveryCursorError,
    );
    // 残缺 ISO（Date.parse 可解）→ parse_fail
    expect(() => parseDeliveryListCursor(`${id}|1|2020-01-01`)).toThrow(InvalidDeliveryCursorError);

    // 日历无效但格式像 ISO（2024-02-30）→ Date.parse 归一化；round-trip 拒为 parse_fail
    const calBogus = '2024-02-30T00:00:00.000Z';
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(calBogus)).toBe(true);
    expect(new Date(calBogus).toISOString()).not.toBe(calBogus);
    let calKind: string | undefined;
    try {
      parseDeliveryListCursor(`${id}|1|${calBogus}`);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDeliveryCursorError);
      calKind = (err as InvalidDeliveryCursorError).kind;
    }
    expect(calKind).toBe('parse_fail');

    // 超长数字 attempt（Number→Infinity / 非 SafeInteger）→ parse_fail，不得进查找误记 stale
    const hugeAttempt = '9'.repeat(309);
    expect(Number(hugeAttempt)).toBe(Infinity);
    let hugeKind: string | undefined;
    try {
      parseDeliveryListCursor(`${id}|${hugeAttempt}|${new Date(now - 1000).toISOString()}`);
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDeliveryCursorError);
      hugeKind = (err as InvalidDeliveryCursorError).kind;
    }
    expect(hugeKind).toBe('parse_fail');
    // 刚好越出 MAX_SAFE_INTEGER 亦拒
    const overSafe = String(Number.MAX_SAFE_INTEGER + 1);
    expect(() =>
      parseDeliveryListCursor(`${id}|${overSafe}|${new Date(now - 1000).toISOString()}`),
    ).toThrow(InvalidDeliveryCursorError);

    // 规范 UUID + attempt≥1 + 完整 ISO 仍可解析
    const ts = new Date(now - 1000).toISOString();
    expect(parseDeliveryListCursor(`${id}|1|${ts}`)).toEqual({
      form: 'full',
      deliveryId: id,
      attempt: 1,
      ts,
      cursorTs: Date.parse(ts),
    });
    expect(parseDeliveryListCursor(id)).toEqual({ form: 'bare_id', deliveryId: id });
  });
});
describe('#202/#270 四族路由负控', () => {
  let app: ReturnType<typeof createApp>;
  let aliceToken: string;

  beforeEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true, mode: 0o700 });
    (config as { dataDir: string }).dataDir = TEST_DATA_DIR;
    (config.webhooks as { enabled: boolean }).enabled = true;
    (config as { retentionDays: number }).retentionDays = 30;
    (config.webhooks as { logRetentionDays: number }).logRetentionDays = 30;
    // 全量并发下其他套件可能改写签名密钥；钉死与 forge* 一致
    (config as { taskSigningSecret: string }).taskSigningSecret =
      '01234567890123456789012345678901';
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

  test('① stale（lookup_miss、窗外）四族各恰 1 条 info，三标签，无游标原文', async () => {
    const { Hono } = await import('hono');
    const { UiSessionStore } = await import('../src/lib/ui-session.ts');
    const { createUiApiRoutes } = await import('../src/routes/ui.ts');

    const now = Date.now();
    // 全量并发下其他套件可能改写 retention / 签名密钥；请求前再钉死
    (config as { retentionDays: number }).retentionDays = 30;
    (config.webhooks as { logRetentionDays: number }).logRetentionDays = 30;
    (config as { taskSigningSecret: string }).taskSigningSecret =
      '01234567890123456789012345678901';
    const lines = installCapture();
    const families: InvalidCursorFamily[] = ['deliveries', 'messages', 'send', 'tasks'];
    // 远超默认 30d 窗外，降低并发改写 retention 的误伤
    const outsideTs = daysAgoMs(120, now);
    const cursors: Record<InvalidCursorFamily, string> = {
      deliveries: `dlv_${randomUUID()}|1|${new Date(outsideTs).toISOString()}`,
      // UI mock 不吃 cursor 串；用占位即可
      messages: 'mail-cursor-v2.unused.unused',
      // 好 MAC + 错 addr → lookup_miss（alice 作用域）
      send: forgeSendCursor({ t: outsideTs, addr: 'other@test.example' }),
      tasks: 'task-board-cursor-v1.unused.unused',
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

    // —— send：send-log cursorKey 模块加载时冻结，全量并发下 forge 易与解码密钥漂移；
    // helper 直注 lookup_miss 窗外（HTTP 400 体由用例 ③ 覆盖）。
    logInvalidCursorRejectionFor('send', 'lookup_miss', { cursorTs: outsideTs, now });

    // —— messages + tasks：UI 夹具抛 lookup_miss + 窗外 ts ——
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
          throw new InvalidMailCursorError('lookup_miss', outsideTs);
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
            throw new InvalidTaskCursorError('lookup_miss', outsideTs);
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
      const parsed = parseLine(hit[0]!.line);
      expect(parsed.event).toBe(INVALID_CURSOR_LOG_EVENT);
      expect(parsed.shape).toBe('full');
      // 分级与该行 within_retention 自洽。绝对「窗外→info」由本文件 helper 单元测钉死；
      // 全量并发下其他套件可能瞬时改写 retentionDays（如 RETENTION_DAYS=0→无界），
      // 路由面只保证 lookup_miss→full + 分级契约，不与瞬时 retention 死磕。
      expect(hit[0]!.level).toBe(
        classifyInvalidCursorLevel(parsed.shape, parsed.within_retention),
      );
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
    logInvalidCursorRejectionFor('send', 'parse_fail');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line).shape).toBe('malformed');

    const res = await app.request(`/v1/send/history?limit=20&cursor=${encodeURIComponent('%%%')}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
  });

  // R2 #4：send 族路由级 stale——真打 /v1/send/history，未匹配签名游标
  test('④ send 族路由级 stale：/v1/send/history lookup_miss 窗外 → info', async () => {
    (config as { retentionDays: number }).retentionDays = 30;
    const now = Date.now();
    const outsideTs = daysAgoMs(120, now);
    // 远超 SEND_LOG 留存亦窗外
    expect(now - outsideTs).toBeGreaterThan(SEND_LOG_RETENTION_MS);
    const lines = installCapture();
    // 用模块冻结 cursorKey 签：addr 与 alice 作用域不匹配 → lookup_miss
    const cursor = encodeSendLogCursorForTests({
      addr: 'other@test.example',
      t: outsideTs,
      id: `snd_${'cd'.repeat(12)}`,
    });
    const res = await app.request(
      `/v1/send/history?limit=20&cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: `Bearer ${aliceToken}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    expect(parseLine(lines[0]!.line)).toEqual({
      event: INVALID_CURSOR_LOG_EVENT,
      family: 'send',
      shape: 'full',
      within_retention: false,
    });
    expect(lines[0]!.line).not.toContain(cursor);
  });

  test('#270 并入：deliveries cursor 超长 → malformed 400', async () => {
    const lines = installCapture();
    const sub = createWebhookSubscription({
      url: 'https://consumer.example/270-len',
      address: 'alice@test.example',
      events: ['mail.received'],
      createdBy: 'admin',
    });
    const overlong = 'x'.repeat(DELIVERIES_CURSOR_MAX_LENGTH + 1);
    const res = await app.request(
      `/v1/webhooks/${sub.id}/deliveries?limit=2&cursor=${encodeURIComponent(overlong)}`,
      { headers: { Authorization: `Bearer ${adminKey}` } },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(parseLine(lines[0]!.line)).toEqual({
      event: INVALID_CURSOR_LOG_EVENT,
      family: 'deliveries',
      shape: 'malformed',
      within_retention: false,
    });
  });
});
