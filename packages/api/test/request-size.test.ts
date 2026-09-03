// 请求体必须在 JSON 解析之前就被限住：否则任何持有有效 Bearer key 的调用方
// 都能让进程先把整个包体读进内存，再由 zod 判它太长。
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-request-size-'));
process.env.RETENTION_DAYS = '0';

const server = (await import('../src/main.ts')).default;
const { config } = await import('../src/lib/config.ts');
const adminKey = [...config.apiKeys][0]!;

function sendRequest(text: string) {
  return server.fetch(
    new Request('http://localhost/v1/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'sender@test.example',
        to: 'recipient@example.net',
        subject: 'large',
        text,
      }),
    }),
  );
}

// 注意：这条在鉴权之前就被挡下，所以不依赖 API_KEYS 的值（config 是进程级
// 单例，同一次 bun test 里由最先 import 它的测试文件决定）。
test('超大请求体在进 JSON 解析前就被拒（413，不是 400）', async () => {
  const response = await sendRequest('x'.repeat(17 * 1024 * 1024));
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'request_too_large' });
});

test('正常大小的请求体不会被上限挡住', async () => {
  const response = await sendRequest('hello');
  expect(response.status).not.toBe(413);
});
