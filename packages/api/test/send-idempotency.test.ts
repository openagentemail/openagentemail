// POST /v1/send 的可选 Idempotency-Key。没有键时不占表、不写哈希。
import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
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

const identitiesMod = await import('../src/lib/identities.ts');
const { createIdentity, deleteIdentity, findIdentity } = identitiesMod;
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
  beginSendIdempotency,
  fingerprintSendBody,
  hashIdempotencyKey,
  parseSendIdempotencyKey,
  isSendIdempotencyReplayUnavailable,
  rebuildSendIdempotencyFromRecords,
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
    expect(parseSendIdempotencyKey('a b')).toEqual({ ok: true, key: 'a b' });
    expect(parseSendIdempotencyKey('café').ok).toBe(false);
    expect(parseSendIdempotencyKey('key😀').ok).toBe(false);
    expect(parseSendIdempotencyKey('bad\tkey').ok).toBe(false);
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
    // emoji 进不了 Headers。能进头的非 ASCII（é 在 Latin-1 内）仍要 400。
    const latin = await post(from, { key: 'café' });
    expect(latin.status).toBe(400);
    expect(await latin.json()).toEqual({ error: 'invalid_request' });
    const spaced = await post(from, { key: 'a b', subject: 'spaced-key' });
    expect(spaced.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(2);
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

  test('额度或冷却拒绝会把暂时逐出的已完成项放回', async () => {
    const owner = nid('owner');
    const other = nid('other');
    setSendIdempotencyCapForTests(1);
    expect((await post(owner, { key: 'keep', subject: 'keep' })).status).toBe(200);
    const limit = config.sendRateLimit;
    while (sendLimitCountForTests(other) < limit) {
      expect(checkSendLimit(other, limit).allowed).toBe(true);
    }
    const blocked = await post(other, { key: 'nope', subject: 'nope' });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toBe('rate_limited');
    const replay = await post(owner, { key: 'keep', subject: 'keep' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(sendMail).toHaveBeenCalledTimes(1);

    resetRateLimits();
    resetAutoReplyCooldownForTests();
    resetSendIdempotencyForTests();
    setSendIdempotencyCapForTests(1);
    const from = nid('coolcap');
    const to = 'evict-cool@example.net';
    expect((await post(from, { key: 'kept', to, autoReply: true, subject: 'first' })).status).toBe(200);
    const cooled = await post(from, { key: 'other', to, autoReply: true, subject: 'second' });
    expect(cooled.status).toBe(429);
    expect(((await cooled.json()) as { error: string }).error).toBe('auto_reply_cooldown');
    const cooledReplay = await post(from, { key: 'kept', to, autoReply: true, subject: 'first' });
    expect(cooledReplay.status).toBe(200);
    expect(cooledReplay.headers.get('Idempotent-Replayed')).toBe('true');
  });

  test('删除身份清掉该地址的幂等记录，其它地址的回放还在', async () => {
    const from = nid('reuse');
    const keeper = nid('keeper');
    const key = 'reuse-key';
    expect((await post(from, { key, subject: 'pred' })).status).toBe(200);
    expect((await post(keeper, { key: 'keep-key', subject: 'keep' })).status).toBe(200);
    expect(deleteIdentity(from)).toBe(true);
    sendMail.mockClear();
    const keeperReplay = await post(keeper, { key: 'keep-key', subject: 'keep' });
    expect(keeperReplay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(sendMail).not.toHaveBeenCalled();

    const localpart = from.split('@')[0] ?? '';
    expect(createIdentity({ localpart })).toBeTruthy();
    sendMail.mockClear();
    const again = await post(from, { key, subject: 'pred' });
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('重启回放不把早于当前身份 createdAt 的幂等行还给同址新身份', async () => {
    const from = nid('born');
    const key = 'born-key';
    const first = await post(from, { key, subject: 'pred' });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(deleteIdentity(from)).toBe(true);
    const localpart = from.split('@')[0] ?? '';
    // 同一毫秒内新建会和刚写上的 sentAt 相等，回放会把这一行留给新身份。
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(createIdentity({ localpart })).toBeTruthy();
    resetSendIdempotencyForTests();
    replaySendGuardsFromLog();
    sendMail.mockClear();
    const retry = await post(from, { key, subject: 'pred' });
    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(await retry.json()).not.toEqual(firstBody);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('飞行中删掉并重建身份后，完成的旧请求不把幂等记到新身份上', async () => {
    const from = nid('swap');
    const localpart = from.split('@')[0] ?? '';
    const key = 'swap-key';
    const bornAt = findIdentity(from)?.createdAt;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    sendMail.mockImplementation(async () => {
      started += 1;
      await gate;
      return { messageId: '<swap@test>' };
    });
    const first = post(from, { key, subject: 'inflight' });
    await waitUntil(() => started === 1);
    expect(deleteIdentity(from)).toBe(true);
    // 同一毫秒内新建会撞上同一个 createdAt，回放过滤看不出来。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const created = createIdentity({ localpart });
    expect(created?.identity.createdAt).toBeTruthy();
    expect(created?.identity.createdAt).not.toBe(bornAt);
    release();
    const res = await first;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: true, messageId: '<swap@test>' });
    const text = logText();
    expect(text).toContain('"subject":"inflight"');
    expect(text).not.toContain('idempotencyKeyHash');
    expect(text).not.toContain('requestHash');
    expect(text).not.toContain(hashIdempotencyKey(key));
    // 内存里也不留已完成项，否则不用重启就能回放给新身份。
    expect(sendIdempotencySizeForTests()).toBe(0);

    resetSendIdempotencyForTests();
    replaySendGuardsFromLog();
    expect(sendIdempotencySizeForTests()).toBe(0);
    sendMail.mockImplementation(async () => ({ messageId: '<swap2@test>' }));
    sendMail.mockClear();
    const again = await post(from, { key, subject: 'inflight' });
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('飞行中只删身份、完成时身份已不在，也不写幂等哈希', async () => {
    const from = nid('gone');
    const key = 'gone-key';
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    sendMail.mockImplementation(async () => {
      started += 1;
      await gate;
      return { messageId: '<gone@test>' };
    });
    const first = post(from, { key, subject: 'orphan' });
    await waitUntil(() => started === 1);
    expect(deleteIdentity(from)).toBe(true);
    release();
    const res = await first;
    expect(res.status).toBe(200);
    expect(logText()).toContain('"subject":"orphan"');
    expect(logText()).not.toContain('idempotencyKeyHash');
    expect(sendIdempotencySizeForTests()).toBe(0);
  });

  test('回放跳过早于当前身份 createdAt 的行，没有身份表时仍认窗口内的行', () => {
    const from = 'born@test.example';
    const key = 'born-key';
    const body = { from, to: 'b@example.net', subject: 's', text: 't' };
    const requestHash = fingerprintSendBody(body);
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const created = now - 60_000;
    const row = (sentAt: string, id: string) => ({
      id,
      from,
      sentAt,
      result: 'queued' as const,
      messageId: '<m@test>',
      idempotencyKeyHash: hashIdempotencyKey(key),
      requestHash,
    });
    const map = new Map([[from, created]]);
    rebuildSendIdempotencyFromRecords(
      [row(new Date(created - 1).toISOString(), 'snd_old')],
      now,
      map,
    );
    expect(beginSendIdempotency(from, key, body).outcome).toBe('reserved');

    resetSendIdempotencyForTests();
    rebuildSendIdempotencyFromRecords(
      [row(new Date(created).toISOString(), 'snd_eq')],
      now,
      map,
    );
    expect(beginSendIdempotency(from, key, body).outcome).toBe('replay');

    resetSendIdempotencyForTests();
    rebuildSendIdempotencyFromRecords(
      [row(new Date(created).toISOString(), 'snd_missing')],
      now,
      new Map(),
    );
    expect(beginSendIdempotency(from, key, body).outcome).toBe('reserved');

    resetSendIdempotencyForTests();
    rebuildSendIdempotencyFromRecords([row(new Date(created).toISOString(), 'snd_nolist')], now);
    expect(beginSendIdempotency(from, key, body).outcome).toBe('replay');
  });

  test('DATA 及更晚的断线缓存 502，更早的命令仍放开键，额度不计入', async () => {
    const from = nid('ambig');
    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('timeout after data'), { code: 'ETIMEDOUT', command: 'DATA' });
    });
    const first = await post(from, { key: 'data-key', subject: 'ambig' });
    expect(first.status).toBe(502);
    const body = await first.json();
    expect(body).toMatchObject({ error: 'smtp_error' });
    const text = logText();
    expect(text).toContain(hashIdempotencyKey('data-key'));
    expect(text).toContain('"failureKind":"local"');
    expect(text).not.toContain('"rateLimitAt"');
    expect(sendLimitCountForTests(from)).toBe(0);
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<should-not@test>' }));
    const replay = await post(from, { key: 'data-key', subject: 'ambig' });
    expect(replay.status).toBe(502);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(body);
    expect(sendMail).not.toHaveBeenCalled();

    resetRateLimits();
    resetSendIdempotencyForTests();
    replaySendGuardsFromLog();
    expect(sendLimitCountForTests(from)).toBe(0);
    const afterBoot = await post(from, { key: 'data-key', subject: 'ambig' });
    expect(afterBoot.status).toBe(502);
    expect(afterBoot.headers.get('Idempotent-Replayed')).toBe('true');
    expect(sendLimitCountForTests(from)).toBe(0);

    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('write failed'), { code: 'ECONNECTION', command: 'DATA' });
    });
    const piped = await post(from, { key: 'pipe-key', subject: 'pipe' });
    expect(piped.status).toBe(502);
    expect(logText()).toContain(hashIdempotencyKey('pipe-key'));
    sendMail.mockImplementation(async () => ({ messageId: '<pipe@test>' }));
    const pipedReplay = await post(from, { key: 'pipe-key', subject: 'pipe' });
    expect(pipedReplay.status).toBe(502);
    expect(pipedReplay.headers.get('Idempotent-Replayed')).toBe('true');

    sendMail.mockImplementation(async () => {
      throw Object.assign(new Error('timeout before data'), { code: 'ETIMEDOUT', command: 'MAIL FROM' });
    });
    const early = await post(from, { key: 'early-key', subject: 'early' });
    expect(early.status).toBe(502);
    expect(logText()).not.toContain(hashIdempotencyKey('early-key'));
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<early@test>' }));
    const earlyRetry = await post(from, { key: 'early-key', subject: 'early' });
    expect(earlyRetry.status).toBe(200);
    expect(earlyRetry.headers.get('Idempotent-Replayed')).toBeNull();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('启动时身份库读失败则跳过幂等重建，额度与冷却照常回放', async () => {
    const from = nid('idread');
    const to = 'cool-idread@example.net';
    const key = 'idread-key';
    expect((await post(from, { key, to, autoReply: true, subject: 'pred' })).status).toBe(200);
    expect(sendLimitCountForTests(from)).toBe(1);
    expect(autoReplyCooldownSizeForTests()).toBe(1);
    resetSendIdempotencyForTests();
    resetRateLimits();
    resetAutoReplyCooldownForTests();
    const spy = spyOn(identitiesMod, 'listIdentities').mockImplementation(() => {
      throw new Error('identity store unreadable');
    });
    try {
      replaySendGuardsFromLog();
      expect(sendIdempotencySizeForTests()).toBe(0);
      expect(isSendIdempotencyReplayUnavailable()).toBe(false);
      expect(sendLimitCountForTests(from)).toBe(1);
      expect(autoReplyCooldownSizeForTests()).toBe(1);
      // 冷却已经证明回放过了。清掉它，同指纹的探测请求才能走到 SMTP，而不是 429。
      resetAutoReplyCooldownForTests();
      sendMail.mockClear();
      const during = await post(from, { key, to, autoReply: true, subject: 'pred' });
      expect(during.status).toBe(200);
      expect(during.headers.get('Idempotent-Replayed')).toBeNull();
      expect(sendMail).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    // 身份库恢复后，带 createdAt 过滤的回放仍装入当前身份的行。
    resetSendIdempotencyForTests();
    resetRateLimits();
    resetAutoReplyCooldownForTests();
    replaySendGuardsFromLog();
    expect(sendIdempotencySizeForTests()).toBe(1);
    sendMail.mockClear();
    const replay = await post(from, { key, to, autoReply: true, subject: 'pred' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('发送日志回放失败时带键请求 503，不带键仍 200', async () => {
    const from = nid('replaydown');
    resetSendIdempotencyForTests();
    resetRateLimits();
    resetAutoReplyCooldownForTests();
    try {
      replaySendGuardsFromLog(Date.now(), () => {
        throw new Error('send-log unreadable');
      });
      expect(isSendIdempotencyReplayUnavailable()).toBe(true);
      sendMail.mockClear();
      const keyed = await post(from, { key: 'again', subject: 'nope', autoReply: true });
      expect(keyed.status).toBe(503);
      expect(await keyed.json()).toEqual({ error: 'idempotency_unavailable' });
      expect(sendMail).not.toHaveBeenCalled();
      expect(sendIdempotencySizeForTests()).toBe(0);
      expect(sendLimitCountForTests(from)).toBe(0);
      expect(autoReplyCooldownSizeForTests()).toBe(0);
      const plain = await post(from, { subject: 'plain' });
      expect(plain.status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
    } finally {
      resetSendIdempotencyForTests();
    }
  });

  test('SMTP 接受后身份库抛错仍完成幂等，同一键重试不再发信', async () => {
    const from = nid('postthrow');
    const key = 'post-throw';
    let smtpDone = false;
    sendMail.mockImplementation(async () => {
      smtpDone = true;
      return { messageId: '<post@test>' };
    });
    const spy = spyOn(identitiesMod, 'findIdentity').mockImplementation((address: string) => {
      // 只在 SMTP 返回后让发件身份的查找失败。收件人通知等其它查找仍走原函数。
      if (smtpDone && address.toLowerCase() === from.toLowerCase()) {
        throw new Error('identity store unreadable');
      }
      return findIdentity(address);
    });
    try {
      const first = await post(from, { key, subject: 'once' });
      expect(first.status).toBe(200);
      const body = await first.json();
      expect(body).toMatchObject({ queued: true, messageId: '<post@test>' });
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(sendIdempotencySizeForTests()).toBe(1);
      expect(logText()).toContain(hashIdempotencyKey(key));
      spy.mockRestore();
      sendMail.mockClear();
      const second = await post(from, { key, subject: 'once' });
      expect(second.status).toBe(200);
      expect(second.headers.get('Idempotent-Replayed')).toBe('true');
      expect(await second.json()).toEqual(body);
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      sendMail.mockImplementation(async () => ({ messageId: '<m@test>' }));
    }
  });
});
