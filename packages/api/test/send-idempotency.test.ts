// POST /v1/send 的可选 Idempotency-Key。没有键时不占表、不写哈希。
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.SEND_RATE_LIMIT = '20';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-idem-'));

const sendMail = mock(async () => ({ messageId: '<m@test>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

const { createIdentity } = await import('../src/lib/identities.ts');
const { sendRoute } = await import('../src/routes/send.ts');
const { config } = await import('../src/lib/config.ts');
const {
  resetAutoReplyCooldownForTests,
  autoReplyCooldownSizeForTests,
} = await import('../src/lib/auto-reply-cooldown.ts');
const {
  checkSendLimit,
  resetRateLimits,
  sendLimitCountForTests,
} = await import('../src/lib/ratelimit.ts');
const {
  resetSendLogForTests,
  sendLogPathForTests,
  setSendLogNowForTests,
} = await import('../src/lib/send-log.ts');
const { replaySendGuardsFromLog } = await import('../src/lib/replay-send-guards.ts');
const {
  fingerprintSendBody,
  hashIdempotencyKey,
  parseSendIdempotencyKey,
  resetSendIdempotencyForTests,
  sendIdempotencySizeForTests,
  setSendIdempotencyCapForTests,
  setSendIdempotencyNowForTests,
} = await import('../src/lib/send-idempotency.ts');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('auth', { kind: 'admin' });
  await next();
});
app.route('/v1/send', sendRoute);

let seq = 0;

function nid(prefix: string): string {
  seq += 1;
  const created = createIdentity({ localpart: `${prefix}${seq}` });
  if (!created) throw new Error(`identity taken: ${prefix}${seq}`);
  return created.identity.address;
}

function post(
  from: string,
  opts: {
    to?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    autoReply?: boolean;
    key?: string;
    extra?: Record<string, unknown>;
  } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key !== undefined) headers['Idempotency-Key'] = opts.key;
  const payload: Record<string, unknown> = {
    from,
    to: opts.to ?? 'recipient@example.net',
    subject: opts.subject ?? 'hello',
    text: opts.text ?? 'body',
    ...(opts.extra ?? {}),
  };
  if (opts.html !== undefined) payload.html = opts.html;
  if (opts.autoReply !== undefined) payload.autoReply = opts.autoReply;
  return app.request('/v1/send', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
}

function logText(): string {
  return readFileSync(sendLogPathForTests(), 'utf8');
}

function logCount(): number {
  return logText().split('\n').filter((line) => line.trim()).length;
}

async function waitUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for SMTP');
}

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockImplementation(async () => ({ messageId: '<m@test>' }));
  resetRateLimits();
  resetAutoReplyCooldownForTests();
  resetSendIdempotencyForTests();
  resetSendLogForTests();
  setSendLogNowForTests(null);
});

describe('指纹与请求头', () => {
  test('to 收成数组且不排序，键顺序不影响指纹', () => {
    const a = fingerprintSendBody({
      from: 'A@test.example',
      to: 'b@example.net',
      subject: 's',
      text: 't',
    });
    const b = fingerprintSendBody({
      text: 't',
      subject: 's',
      to: ['b@example.net'],
      from: 'A@test.example',
    });
    const swapped = fingerprintSendBody({
      from: 'A@test.example',
      to: ['c@example.net', 'b@example.net'],
      subject: 's',
      text: 't',
    });
    const ordered = fingerprintSendBody({
      from: 'A@test.example',
      to: ['b@example.net', 'c@example.net'],
      subject: 's',
      text: 't',
    });
    expect(a).toBe(b);
    expect(swapped).not.toBe(ordered);
    // 大小写保持原样。send.ts 不改写已校验地址。
    const lower = fingerprintSendBody({
      from: 'a@test.example',
      to: ['b@example.net'],
      subject: 's',
      text: 't',
    });
    expect(lower).not.toBe(a);
  });

  test('空头与超长、控制字符', () => {
    expect(parseSendIdempotencyKey(undefined)).toEqual({ ok: true });
    expect(parseSendIdempotencyKey('   ')).toEqual({ ok: true });
    expect(parseSendIdempotencyKey('  abc  ')).toEqual({ ok: true, key: 'abc' });
    expect(parseSendIdempotencyKey('k'.repeat(128)).ok).toBe(true);
    expect(parseSendIdempotencyKey('k'.repeat(129)).ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\nkey').ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\u0000key').ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\u0001key').ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\u007fkey').ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\u0085key').ok).toBe(false);
  });
});

describe('POST /v1/send Idempotency-Key', () => {
  test('没有键时重复发送仍各打一次 SMTP', async () => {
    const from = nid('plain');
    const first = await post(from);
    const second = await post(from, { subject: 'hello' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    expect(second.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(logText()).not.toContain('idempotencyKeyHash');
    expect(sendIdempotencySizeForTests()).toBe(0);
  });

  test('空白头当没有键', async () => {
    const from = nid('blank');
    expect((await post(from, { key: '   ' })).status).toBe(200);
    expect((await post(from, { key: '' })).status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test('相同键和 body 回放原响应，只发一封', async () => {
    const from = nid('replay');
    const first = await post(from, { key: 'same-key' });
    expect(first.status).toBe(200);
    const body = await first.json();
    const lines = logCount();
    sendMail.mockClear();
    const second = await post(from, { key: '  same-key  ' });
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(body);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logCount()).toBe(lines);
  });

  test('单项 to 和等长数组指纹相同，顺序不同则 422', async () => {
    const from = nid('order');
    const first = await post(from, { key: 'ord', to: 'a@example.net' });
    expect(first.status).toBe(200);
    const replay = await post(from, { key: 'ord', to: ['a@example.net'] });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    const swapped = await post(from, {
      key: 'ord-2',
      to: ['a@example.net', 'b@example.net'],
    });
    expect(swapped.status).toBe(200);
    const reversed = await post(from, {
      key: 'ord-2',
      to: ['b@example.net', 'a@example.net'],
    });
    expect(reversed.status).toBe(422);
    expect(await reversed.json()).toEqual({ error: 'idempotency_key_reused' });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test('同一键换正文返回 422，且不再发信', async () => {
    const from = nid('reuse');
    expect((await post(from, { key: 'k', subject: 'one' })).status).toBe(200);
    const other = await post(from, { key: 'k', subject: 'two' });
    expect(other.status).toBe(422);
    expect(await other.json()).toEqual({ error: 'idempotency_key_reused' });
    expect(other.headers.get('Retry-After')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
    const again = await post(from, { key: 'k', subject: 'one' });
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
  });

  test('并发重复只发一封，另一封 409', async () => {
    const from = nid('race');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    sendMail.mockImplementation(async () => {
      started += 1;
      await gate;
      return { messageId: '<race@test>' };
    });
    try {
      const first = post(from, { key: 'race-key' });
      await waitUntil(() => started === 1);
      const second = await post(from, { key: 'race-key' });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'idempotency_in_flight', retryAfterSec: 1 });
      expect(second.headers.get('Retry-After')).toBeNull();
      expect(second.headers.get('Idempotent-Replayed')).toBeNull();
      expect(started).toBe(1);
      const other = await post(from, { key: 'race-key', subject: 'nope' });
      expect(other.status).toBe(422);
      expect(await other.json()).toEqual({ error: 'idempotency_key_reused' });
      expect(started).toBe(1);
      release();
      const opened = await first;
      expect(opened.status).toBe(200);
      expect(started).toBe(1);
    } finally {
      release();
    }
  });

  test('并发重复的第一封成功后，后续请求回放', async () => {
    const from = nid('race2');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    sendMail.mockImplementation(async () => {
      started += 1;
      await gate;
      return { messageId: '<race2@test>' };
    });
    const first = post(from, { key: 'race2' });
    let opened: Response;
    try {
      await waitUntil(() => started === 1);
      const inflight = await post(from, { key: 'race2' });
      expect(inflight.status).toBe(409);
      release();
      opened = await first;
    } finally {
      release();
    }
    expect(opened.status).toBe(200);
    const body = await opened.json();
    sendMail.mockClear();
    const replay = await post(from, { key: 'race2' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(body);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('不同身份的同一个键互不影响', async () => {
    const a = nid('ida');
    const b = nid('idb');
    // mock 的声明是无参函数。运行时 sendMail 仍会收到 from，这里只为类型对齐。
    sendMail.mockImplementation((async (input: { from: string }) => ({
      messageId: `<${input.from}>`,
    })) as () => Promise<{ messageId: string }>);
    const first = await post(a, { key: 'shared', subject: 's', text: 't' });
    const second = await post(b, { key: 'shared', subject: 's', text: 't' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const bodyA = await first.json();
    const bodyB = await second.json();
    expect(bodyA).not.toEqual(bodyB);
    expect(sendMail).toHaveBeenCalledTimes(2);
    const replayA = await post(a, { key: 'shared', subject: 's', text: 't' });
    const replayB = await post(b, { key: 'shared', subject: 's', text: 't' });
    expect(replayA.headers.get('Idempotent-Replayed')).toBe('true');
    expect(replayB.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replayA.json()).toEqual(bodyA);
    expect(await replayB.json()).toEqual(bodyB);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test('回放不占每小时额度', async () => {
    expect(config.sendRateLimit).toBeGreaterThan(0);
    const from = nid('quota');
    const limit = config.sendRateLimit;
    while (sendLimitCountForTests(from) < limit - 1) {
      expect(checkSendLimit(from, limit).allowed).toBe(true);
    }
    const first = await post(from, { key: 'quota-key' });
    expect(first.status).toBe(200);
    expect(sendLimitCountForTests(from)).toBe(limit);
    const replay = await post(from, { key: 'quota-key' });
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(sendLimitCountForTests(from)).toBe(limit);
    const blocked = await post(from, { subject: 'another' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: 'rate_limited' });
  });

  test('额度拒绝放开键，重置额度后可以再发', async () => {
    const from = nid('rel');
    const limit = config.sendRateLimit;
    while (sendLimitCountForTests(from) < limit) {
      expect(checkSendLimit(from, limit).allowed).toBe(true);
    }
    const blocked = await post(from, { key: 'rel-key', subject: 'later' });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toBe('rate_limited');
    resetRateLimits();
    sendMail.mockClear();
    const retry = await post(from, { key: 'rel-key', subject: 'later' });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('回放不碰自动回复冷却', async () => {
    const from = nid('cool');
    const to = 'cool-to@example.net';
    const first = await post(from, { key: 'cool-key', to, autoReply: true });
    expect(first.status).toBe(200);
    const size = autoReplyCooldownSizeForTests();
    expect(size).toBeGreaterThan(0);
    const replay = await post(from, { key: 'cool-key', to, autoReply: true });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(autoReplyCooldownSizeForTests()).toBe(size);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const again = await post(from, { to, autoReply: true, subject: 'other' });
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: 'auto_reply_cooldown' });
  });

  test('冷却拒绝放开键，冷却清空后可以再发', async () => {
    const from = nid('coolrel');
    const to = 'cool-rel@example.net';
    expect((await post(from, { to, autoReply: true })).status).toBe(200);
    const blocked = await post(from, { key: 'cool-rel', to, autoReply: true, subject: 'x' });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
    resetAutoReplyCooldownForTests();
    sendMail.mockClear();
    const retry = await post(from, { key: 'cool-rel', to, autoReply: true, subject: 'x' });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('连接类失败放开键，对端应答的失败被缓存', async () => {
    const from = nid('fail');
    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNECTION' });
    });
    const local = await post(from, { key: 'local-key' });
    expect(local.status).toBe(502);
    expect(local.headers.get('Idempotent-Replayed')).toBeNull();
    const localBody = (await local.json()) as { id?: string };
    expect(logText()).not.toContain(hashIdempotencyKey('local-key'));
    sendMail.mockImplementation(async () => ({ messageId: '<after-local@test>' }));
    const retried = await post(from, { key: 'local-key' });
    expect(retried.status).toBe(200);
    expect(retried.headers.get('Idempotent-Replayed')).toBeNull();

    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('550 rejected'), { responseCode: 550 });
    });
    const remote = await post(from, { key: 'smtp-key', subject: 'remote' });
    expect(remote.status).toBe(502);
    const remoteBody = await remote.json();
    expect(remoteBody).toMatchObject({ error: 'smtp_error' });
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<should-not@test>' }));
    const cached = await post(from, { key: 'smtp-key', subject: 'remote' });
    expect(cached.status).toBe(502);
    expect(cached.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await cached.json()).toEqual(remoteBody);
    expect(sendMail).not.toHaveBeenCalled();
    expect(localBody.id).toMatch(/^snd_/);
  });

  test('重启后从 send-log 回放，过期和未来的行忽略，原始键不落盘', async () => {
    const from = nid('boot');
    const key = 'Idem-Key/Not-Hex!';
    const first = await post(from, { key, subject: 'boot' });
    expect(first.status).toBe(200);
    const body = await first.json();
    const text = logText();
    expect(text).not.toContain(key);
    expect(text).toContain(hashIdempotencyKey(key));
    expect(text).toContain('"requestHash"');
    resetSendIdempotencyForTests();
    replaySendGuardsFromLog();
    sendMail.mockClear();
    const replay = await post(from, { key, subject: 'boot' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(body);
    expect(sendMail).not.toHaveBeenCalled();

    const expiredFrom = nid('old');
    setSendLogNowForTests(() => Date.now() - 25 * 60 * 60 * 1000);
    expect((await post(expiredFrom, { key: 'old-key' })).status).toBe(200);
    resetSendIdempotencyForTests();
    setSendLogNowForTests(null);
    replaySendGuardsFromLog();
    sendMail.mockClear();
    const expiredRetry = await post(expiredFrom, { key: 'old-key' });
    expect(expiredRetry.status).toBe(200);
    expect(expiredRetry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);

    const futureFrom = nid('future');
    setSendLogNowForTests(() => Date.now() + 60 * 60 * 1000);
    expect((await post(futureFrom, { key: 'future-key' })).status).toBe(200);
    resetSendIdempotencyForTests();
    setSendLogNowForTests(null);
    replaySendGuardsFromLog();
    sendMail.mockClear();
    const futureRetry = await post(futureFrom, { key: 'future-key' });
    expect(futureRetry.status).toBe(200);
    expect(futureRetry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('对端应答的失败重启后仍回放 502', async () => {
    const from = nid('boot502');
    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('550 rejected'), { responseCode: 550 });
    });
    const first = await post(from, { key: 'boot-502' });
    expect(first.status).toBe(502);
    const body = await first.json();
    resetSendIdempotencyForTests();
    replaySendGuardsFromLog();
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<nope@test>' }));
    const replay = await post(from, { key: 'boot-502' });
    expect(replay.status).toBe(502);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(body);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('非法头 400，body 里的键仍被 strict 拒绝', async () => {
    const from = nid('bad');
    sendMail.mockClear();
    const long = await post(from, { key: 'k'.repeat(129) });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: 'invalid_request' });
    // NUL 会被 Request 自己拒绝。这里用仍能进到路由的控制字符。
    const control = await post(from, { key: 'ok\u0001no' });
    expect(control.status).toBe(400);
    expect(await control.json()).toEqual({ error: 'invalid_request' });
    const inBody = await post(from, { extra: { idempotencyKey: 'nope' } });
    expect(inBody.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
    const ok = await post(from, { key: 'k'.repeat(128) });
    expect(ok.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('未知身份不占位', async () => {
    const missing = await post('missing-idem@test.example', { key: 'ghost' });
    expect(missing.status).toBe(403);
    expect(sendIdempotencySizeForTests()).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('进行中占满时 429，完成后逐出最老的已完成项', async () => {
    const from = nid('cap');
    setSendIdempotencyCapForTests(1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    sendMail.mockImplementation(async () => {
      started += 1;
      await gate;
      return { messageId: '<cap@test>' };
    });
    try {
      const first = post(from, { key: 'in-flight' });
      await waitUntil(() => started === 1);
      const full = await post(from, { key: 'other-key', subject: 'x' });
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ error: 'idempotency_table_full', retryAfterSec: 1 });
      expect(full.headers.get('Retry-After')).toBeNull();
      expect(started).toBe(1);
      release();
      expect((await first).status).toBe(200);
    } finally {
      release();
    }

    // 上一段留下的已完成项用的是真实时间。清掉再测逐出，避免时钟回拨把新项当成最老。
    resetSendIdempotencyForTests();
    resetRateLimits();
    setSendIdempotencyCapForTests(2);
    const t0 = 1_700_000_000_000;
    setSendIdempotencyNowForTests(() => t0);
    expect((await post(from, { key: 'old', subject: 'old' })).status).toBe(200);
    setSendIdempotencyNowForTests(() => t0 + 1000);
    expect((await post(from, { key: 'mid', subject: 'mid' })).status).toBe(200);
    setSendIdempotencyNowForTests(() => t0 + 2000);
    expect((await post(from, { key: 'new', subject: 'new' })).status).toBe(200);
    const mid = await post(from, { key: 'mid', subject: 'mid' });
    expect(mid.headers.get('Idempotent-Replayed')).toBe('true');
    const old = await post(from, { key: 'old', subject: 'old' });
    expect(old.status).toBe(200);
    expect(old.headers.get('Idempotent-Replayed')).toBeNull();
  });
});
