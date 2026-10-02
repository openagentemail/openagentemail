// 发信错误处理：对外只给稳定错误码，对内保留（脱敏后的）诊断。
import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.SEND_RATE_LIMIT = '1';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-send-'));

/** 当前这封信的 SMTP 失败原因，由各用例设置。 */
let smtpFailure: unknown = new Error('boom');

const sendMail = mock(async () => {
  throw smtpFailure;
});
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

const { createIdentity } = await import('../src/lib/identities.ts');
const { sendRoute } = await import('../src/routes/send.ts');
const { describeFailure, redactSecrets } = await import('../src/lib/redact.ts');
const { isLocalSendFailure } = await import('../src/lib/sendfailure.ts');
const { checkSendLimit, resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { config } = await import('../src/lib/config.ts');
const { hasSentMessageId, resetSentRegistryForTests, setSentRegistryPersistHookForTests } =
  await import('../src/lib/sent-registry.ts');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('auth', { kind: 'admin' });
  await next();
});
app.route('/v1/send', sendRoute);

function post(from: string) {
  return app.request('/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: 'recipient@example.net', subject: 'hello', text: 'body' }),
  });
}

describe('SMTP 错误脱敏', () => {
  test('响应里只有稳定错误码，没有服务端内幕', async () => {
    createIdentity({ localpart: 'smtp-errors' });
    smtpFailure = new Error('authentication failed with password smtp-secret');

    const response = await post('smtp-errors@test.example');
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: 'smtp_error' });
    expect(JSON.parse(body).id).toMatch(/^snd_/);
    expect(body).not.toContain('smtp-secret');
    expect(body).not.toContain('authentication failed');
  });

  test('服务端诊断保留原因，但抹掉密码', () => {
    // 显式传密码列表：config 是进程级单例，同一次 bun test 里由最先 import
    // 它的测试文件决定，不能依赖本文件设的环境变量。
    const text = describeFailure(new Error('535 auth failed with password smtp-secret'), [
      'smtp-secret',
    ]);
    expect(text).toContain('535 auth failed');
    expect(text).not.toContain('smtp-secret');
    expect(text).toContain('[redacted]');
  });

  test('诊断带上 SMTP 应答码和错误码，方便自托管排障', () => {
    const err = Object.assign(new Error('Mailbox unavailable'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    // 显式传密码列表：config 单例里的密码由最先 import 它的测试文件决定，
    // 而现在任意长度的密码都会被脱敏（连 1 个字符的也算），不指定就会误伤。
    const text = describeFailure(err, ['zzz-not-in-this-message']);
    expect(text).toContain('EENVELOPE');
    expect(text).toContain('550');
    expect(text).toContain('Mailbox unavailable');
  });

  // config 允许 API_KEYS/邮箱密码短到 1 个字符（zod 是 min(1)），"太短就不脱敏"
  // 等于给最弱的那类口令开了个后门：它会原样落进服务端日志。
  test('再短的配置密码也要脱敏', () => {
    expect(describeFailure(new Error('535 auth failed with password abc'), ['abc'])).not.toContain(
      'abc',
    );
    expect(describeFailure(new Error('535 auth failed with password abc'), ['abc'])).toContain(
      '[redacted]',
    );
    expect(redactSecrets('login failed for pw x', ['x'])).not.toContain(' x');
    expect(redactSecrets('login failed for pw ab', ['ab'])).toBe('login failed for pw [redacted]');
  });

  test('空密码不会把整段文本切碎', () => {
    expect(redactSecrets('nothing to hide', [''])).toBe('nothing to hide');
    expect(redactSecrets('nothing to hide', ['', 'hide'])).toBe('nothing to [redacted]');
  });

  test('多个密码同时脱敏，长的优先，避免互相截断', () => {
    expect(redactSecrets('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
  });

  test('redactSecrets 对非字符串输入和空密码不炸', () => {
    expect(redactSecrets('', ['smtp-secret'])).toBe('');
    expect(redactSecrets('keep me', ['x'])).toBe('keep me');
    // #342：非 Error 改类型化哨兵（原 String(err)）；仍须含原文字面量且永不抛
    expect(describeFailure('plain string failure', [])).toContain('plain string failure');
    expect(describeFailure('plain string failure', [])).toContain('non-error:string');
    expect(describeFailure(undefined, [])).toBe('[non-error:undefined]');
  });
});

// 失败的发信要不要退还限流额度，取决于这封信到底走到哪一步了：
// 对端（或本机邮局）已经应答过 = 信真的打出去过，照常计数；
// 连都没连上 = 本机故障，不该扣用户的配额。
describe('发信失败后的配额处理', () => {
  test('对端拒收（有 SMTP 应答码）不算本机故障', () => {
    expect(isLocalSendFailure(Object.assign(new Error('rejected'), {
      code: 'EENVELOPE',
      responseCode: 550,
    }))).toBe(false);
    expect(isLocalSendFailure(Object.assign(new Error('greylisted'), { responseCode: 450 }))).toBe(false);
  });

  test('连不上/认证失败这类本机故障才退还', () => {
    expect(isLocalSendFailure(Object.assign(new Error('no route'), { code: 'ECONNECTION' }))).toBe(true);
    expect(isLocalSendFailure(Object.assign(new Error('bad creds'), { code: 'EAUTH' }))).toBe(true);
  });

  test('认不出来的错误按"已消耗"处理（宁可严，不给绕过面）', () => {
    expect(isLocalSendFailure(new Error('mystery'))).toBe(false);
    expect(isLocalSendFailure(undefined)).toBe(false);
    expect(isLocalSendFailure({ code: 42 })).toBe(false);
  });

  test('对端拒收照常计数：限额用完后必须 429，不能无限重试', async () => {
    expect(config.sendRateLimit).toBeGreaterThan(0);
    createIdentity({ localpart: 'quota-remote' });
    resetRateLimits();
    smtpFailure = Object.assign(new Error('550 recipient rejected'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });

    for (let i = 0; i < config.sendRateLimit; i++) {
      expect((await post('quota-remote@test.example')).status).toBe(502);
    }
    expect((await post('quota-remote@test.example')).status).toBe(429);
  });

  test('本机故障退还额度：配额没被吃掉', async () => {
    createIdentity({ localpart: 'quota-local' });
    resetRateLimits();
    smtpFailure = Object.assign(new Error('connection refused'), { code: 'ECONNECTION' });

    expect((await post('quota-local@test.example')).status).toBe(502);
    // 桶应该是空的：limit=1 的探测仍然放行。
    expect(checkSendLimit('quota-local@test.example', 1).allowed).toBe(true);
  });
});

describe('出站登记 sent registry', () => {
  test('/v1/send 成功后把 message-id 写入 registry', async () => {
    resetSentRegistryForTests();
    resetRateLimits();
    createIdentity({ localpart: 'sent-reg' });
    sendMail.mockImplementation(async () => ({ messageId: '<outbound-reg@test.example>' }));
    const response = await post('sent-reg@test.example');
    expect(response.status).toBe(200);
    expect(hasSentMessageId('outbound-reg@test.example', 'sent-reg@test.example')).toBe(true);
    sendMail.mockImplementation(async () => {
      throw smtpFailure;
    });
  });

  test('registry 写失败时 /v1/send 仍 200 且不重复投递', async () => {
    resetSentRegistryForTests();
    resetRateLimits();
    createIdentity({ localpart: 'sent-nospace' });
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<diskfull-reg@test.example>' }));
    setSentRegistryPersistHookForTests(() => {
      throw new Error('ENOSPC');
    });
    const response = await post('sent-nospace@test.example');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      queued: true,
      messageId: '<diskfull-reg@test.example>',
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    setSentRegistryPersistHookForTests(null);
    sendMail.mockImplementation(async () => {
      throw smtpFailure;
    });
  });
});

/** #324：sendSchema.strict()——未知键显式 400，合法五键行为不变 */
describe('POST /v1/send 未知键拒绝（#324）', () => {
  /** 断言 400 invalid_request 且 details 含 unrecognized_keys 点名给定键 */
  function expectUnrecognizedKeys(
    body: { error?: string; details?: Array<{ code?: string; keys?: string[] }> },
    key: string,
  ) {
    expect(body.error).toBe('invalid_request');
    const issue = body.details?.find((d) => d.code === 'unrecognized_keys');
    expect(issue).toBeTruthy();
    expect(issue?.keys).toContain(key);
  }

  test('attachments（Base64 content 形态）→ 400 unrecognized_keys', async () => {
    createIdentity({ localpart: 'strict-att-b64' });
    resetRateLimits();
    sendMail.mockClear();
    const response = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'strict-att-b64@test.example',
        to: 'recipient@example.net',
        subject: 'hello',
        text: 'body',
        attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', encoding: 'base64' }],
      }),
    });
    expect(response.status).toBe(400);
    expectUnrecognizedKeys(await response.json(), 'attachments');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('attachments（url 形态）→ 400 unrecognized_keys', async () => {
    createIdentity({ localpart: 'strict-att-url' });
    resetRateLimits();
    sendMail.mockClear();
    const response = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'strict-att-url@test.example',
        to: 'recipient@example.net',
        subject: 'hello',
        text: 'body',
        attachments: [{ filename: 'a.txt', url: 'https://example.com/a.txt' }],
      }),
    });
    expect(response.status).toBe(400);
    expectUnrecognizedKeys(await response.json(), 'attachments');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('拼错字段 subjct → 400 unrecognized_keys（同族）', async () => {
    createIdentity({ localpart: 'strict-typo' });
    resetRateLimits();
    sendMail.mockClear();
    const response = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'strict-typo@test.example',
        to: 'recipient@example.net',
        subjct: 'hello',
        text: 'body',
      }),
    });
    expect(response.status).toBe(400);
    expectUnrecognizedKeys(await response.json(), 'subjct');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('合法五键件 → 200 queued 行为不变', async () => {
    resetSentRegistryForTests();
    resetRateLimits();
    createIdentity({ localpart: 'strict-ok' });
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<strict-ok@test.example>' }));
    const response = await app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'strict-ok@test.example',
        to: 'recipient@example.net',
        subject: 'hello',
        text: 'body',
        html: '<p>body</p>',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      queued: true,
      messageId: '<strict-ok@test.example>',
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    sendMail.mockImplementation(async () => {
      throw smtpFailure;
    });
  });
});

/** #363-A：可选 autoReply。仅 true 进入 sendMail；不开放 headers。 */
describe('POST /v1/send autoReply（#363-A）', () => {
  function send(from: string, extra: Record<string, unknown> = {}) {
    return app.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: 'recipient@example.net',
        subject: 'hello',
        text: 'body',
        ...extra,
      }),
    });
  }

  test('省略与 false 不带标记；true 只传 autoReply 且响应仍含审计 id', async () => {
    createIdentity({ localpart: 'ar-ok' });
    sendMail.mockImplementation(async () => ({ messageId: '<ar-ok@test.example>' }) as never);
    for (const extra of [{}, { autoReply: false }]) {
      resetRateLimits();
      sendMail.mockClear();
      const response = await send('ar-ok@test.example', extra);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { id?: string };
      expect(body).toMatchObject({ queued: true, messageId: '<ar-ok@test.example>' });
      expect(body.id).toMatch(/^snd_/);
      expect(body).not.toHaveProperty('autoReply');
      const arg = (sendMail.mock.calls as unknown as Array<[{ autoReply?: boolean; headers?: unknown }]>)[0]?.[0];
      expect(arg?.autoReply).toBeUndefined();
      expect(arg?.headers).toBeUndefined();
    }
    resetRateLimits();
    sendMail.mockClear();
    const marked = await send('ar-ok@test.example', { autoReply: true });
    expect(marked.status).toBe(200);
    const markedBody = (await marked.json()) as { id?: string };
    expect(markedBody).toMatchObject({ queued: true, messageId: '<ar-ok@test.example>' });
    expect(markedBody.id).toMatch(/^snd_/);
    const arg = (sendMail.mock.calls as unknown as Array<[{ autoReply?: boolean; headers?: unknown }]>)[0]?.[0];
    expect(arg).toMatchObject({ autoReply: true });
    expect(arg?.headers).toBeUndefined();
    sendMail.mockImplementation(async () => {
      throw smtpFailure;
    });
  });

  test('autoReply 不绕过限速或未知身份：超额 429 且不再发信', async () => {
    expect(config.sendRateLimit).toBeGreaterThan(0);
    createIdentity({ localpart: 'ar-limit' });
    resetRateLimits();
    sendMail.mockClear();
    sendMail.mockImplementation(async () => ({ messageId: '<ar-limit@test.example>' }) as never);
    for (let i = 0; i < config.sendRateLimit; i++) {
      expect((await send('ar-limit@test.example', { autoReply: true })).status).toBe(200);
    }
    const limited = await send('ar-limit@test.example', { autoReply: true });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error?: string }).error).toBe('rate_limited');
    expect(sendMail).toHaveBeenCalledTimes(config.sendRateLimit);
    sendMail.mockClear();
    const missing = await send('missing-ar@test.example', { autoReply: true });
    expect(missing.status).toBe(403);
    expect(sendMail).not.toHaveBeenCalled();
    sendMail.mockImplementation(async () => {
      throw smtpFailure;
    });
  });

  test('字符串、headers 与未知键 400 且不发信', async () => {
    createIdentity({ localpart: 'ar-bad' });
    resetRateLimits();
    sendMail.mockClear();
    const cases: Array<{ extra: Record<string, unknown>; key: string }> = [
      { extra: { autoReply: 'true' }, key: 'autoReply' },
      { extra: { autoReply: 1 }, key: 'autoReply' },
      { extra: { headers: { 'Auto-Submitted': 'auto-replied' } }, key: 'headers' },
      { extra: { autoSubmitted: 'no' }, key: 'autoSubmitted' },
    ];
    for (const { extra, key } of cases) {
      const response = await send('ar-bad@test.example', extra);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error?: string;
        details?: Array<{ code?: string; keys?: string[]; path?: string[] }>;
      };
      expect(body.error).toBe('invalid_request');
      const issue = body.details?.find(
        (item: { code?: string; keys?: string[]; path?: string[] }) =>
          item.keys?.includes(key) || item.path?.includes(key),
      );
      expect(issue).toBeTruthy();
    }
    expect(sendMail).not.toHaveBeenCalled();
  });
});
