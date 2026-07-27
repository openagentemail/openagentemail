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
