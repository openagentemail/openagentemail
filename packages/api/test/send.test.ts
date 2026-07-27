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
    expect(JSON.parse(body)).toEqual({ error: 'smtp_error' });
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
    const text = describeFailure(err);
    expect(text).toContain('EENVELOPE');
    expect(text).toContain('550');
    expect(text).toContain('Mailbox unavailable');
  });

  test('redactSecrets 对非字符串输入和空密码不炸', () => {
    expect(redactSecrets('', ['smtp-secret'])).toBe('');
    expect(redactSecrets('keep me', ['x'])).toBe('keep me');
    expect(describeFailure('plain string failure')).toContain('plain string failure');
    expect(describeFailure(undefined)).toBeTypeOf('string');
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
