/**
 * #242 ApiError B1（可选对象参数）回归：message / status / 各字段语义逐字不变。
 * 覆盖原「三连 undefined 占位」与 tools 按序复制两处脆弱点。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-api-error-b1';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-api-error-b1-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, test } = await import('bun:test');
const { McpServer } = await import('@modelcontextprotocol/server');
const { ApiError, OpenAgentEmailClient } = await import('../src/mcp/client.ts');
const { registerOpenAgentEmailTools } = await import('../src/mcp/tools.ts');

const B = 'bravo@test.example';

describe('#242 ApiError B1 字段与文案逐字回归', () => {
  test('502 通用路径：原三连 undefined 占位 → bodyError/errorBody/taskId 语义不变', async () => {
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const body = { error: 'smtp_error', taskId, created: true };
    const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
      new Response(JSON.stringify(body), { status: 502 }));
    let err: unknown;
    try {
      await client.createTask(B, 'x', 'y', true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const api = err as InstanceType<typeof ApiError>;
    // message / status 逐字
    expect(api.status).toBe(502);
    expect(api.message).toBe('API error 502: smtp_error');
    // 原位置跳过的 timeoutSec/kind/waitHeaderSec 仍为 undefined
    expect(api.timeoutSec).toBeUndefined();
    expect(api.kind).toBeUndefined();
    expect(api.waitHeaderSec).toBeUndefined();
    expect(api.bodyError).toBe('smtp_error');
    expect(api.errorBody).toEqual(body);
    expect(api.taskId).toBe(taskId);
  });

  test('408 malformed：timeoutSec/kind/waitHeaderSec/bodyError 语义不变', async () => {
    // 走 createTask → request 的 408 分支（与 wait 共用同一映射器）
    const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
      new Response(JSON.stringify({ error: 'not_timeout', timeoutSec: 12 }), {
        status: 408,
        headers: { 'X-OAE-Wait-Timeout-Sec': '12' },
      }));
    let err: unknown;
    try {
      await client.createTask(B, 'x', 'y', false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const api = err as InstanceType<typeof ApiError>;
    expect(api.status).toBe(408);
    expect(api.message).toBe('Upstream 408 malformed (kind=upstream_408_malformed).');
    expect(api.timeoutSec).toBe(12);
    expect(api.kind).toBe('upstream_408_malformed');
    expect(api.waitHeaderSec).toBe(12);
    expect(api.bodyError).toBe('not_timeout');
  });

  test('408 upstream_timeout：文案与四字段不变', async () => {
    const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
      new Response(JSON.stringify({ error: 'timeout', timeoutSec: 30 }), {
        status: 408,
        headers: { 'X-OAE-Wait-Timeout-Sec': '30' },
      }));
    let err: unknown;
    try {
      await client.createTask(B, 'x', 'y', false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const api = err as InstanceType<typeof ApiError>;
    expect(api.status).toBe(408);
    expect(api.message).toBe('Timeout: no matching message arrived in time.');
    expect(api.timeoutSec).toBe(30);
    expect(api.kind).toBe('upstream_timeout');
    expect(api.waitHeaderSec).toBe(30);
    expect(api.bodyError).toBe('timeout');
  });

  test('401/403/404 message 文案逐字不变', async () => {
    const cases: Array<{ status: number; body: unknown; message: string }> = [
      {
        status: 401,
        body: { error: 'unauthorized' },
        message:
          'Unauthorized (401). Check OPENAGENTEMAIL_API_KEY — it must be an identity token (oa_…) or one of the admin API_KEYS configured on the server.',
      },
      {
        status: 403,
        body: { error: 'nope' },
        message: 'Forbidden (403): nope.',
      },
      {
        status: 404,
        body: { error: 'missing' },
        message:
          'Not found (404): missing. Verify the address/id — list identities with mail_list_identities and messages with mail_list_messages.',
      },
    ];
    for (const c of cases) {
      const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
        new Response(JSON.stringify(c.body), { status: c.status }));
      let err: unknown;
      try {
        await client.listIdentities();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ApiError);
      const api = err as InstanceType<typeof ApiError>;
      expect(api.status).toBe(c.status);
      expect(api.message).toBe(c.message);
    }
  });

  test('total_deadline：原位置跳过 timeoutSec → B1 省略字段，kind 钉死', () => {
    // 直接构造等价形态（waitFor 总截止路径）；验证选项对象与原 undefined 占位等价
    const err = new ApiError(
      408,
      'Timeout: no matching message arrived within 120s (observed per-call clamp 60s, 3 polls).',
      { kind: 'total_deadline' },
    );
    expect(err.status).toBe(408);
    expect(err.message).toBe(
      'Timeout: no matching message arrived within 120s (observed per-call clamp 60s, 3 polls).',
    );
    expect(err.timeoutSec).toBeUndefined();
    expect(err.kind).toBe('total_deadline');
    expect(err.waitHeaderSec).toBeUndefined();
    expect(err.bodyError).toBeUndefined();
    expect(err.errorBody).toBeUndefined();
    expect(err.taskId).toBeUndefined();
  });

  test('task_create 重包装：8 字段透传 + message 追加口径逐字', async () => {
    const taskId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const client = new OpenAgentEmailClient('http://test.invalid', 'tok', async () =>
      new Response(JSON.stringify({
        error: 'lease_journal_not_bootstrapped', taskId, created: true,
      }), { status: 503 }));
    const server = new McpServer({ name: 'api-error-b1', version: '0.0.0' });
    registerOpenAgentEmailTools(server, client);
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{
        isError?: boolean; content?: Array<{ text?: string }>;
      }> }>;
    })._registeredTools.task_create;
    const result = await tool.handler({
      to: B, subject: 'x', body: 'y', wait: true,
    });
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    // 包装后文案：原 API error 前缀 + taskId 安全重试口径
    expect(text).toContain('API error 503: lease_journal_not_bootstrapped');
    expect(text).toContain(`taskId=${taskId}`);
    expect(text).toMatch(/Task already created — use task_get or task_list to check status; do not call task_create again/);
  });

  test('上游 early：message/kind/字段语义不变（直接构造对齐原调用）', () => {
    const err = new ApiError(408, 'Upstream timeout early (kind=upstream_timeout_early).', {
      timeoutSec: 5,
      kind: 'upstream_timeout_early',
      waitHeaderSec: 5,
      bodyError: 'timeout',
    });
    expect(err.status).toBe(408);
    expect(err.message).toBe('Upstream timeout early (kind=upstream_timeout_early).');
    expect(err.timeoutSec).toBe(5);
    expect(err.kind).toBe('upstream_timeout_early');
    expect(err.waitHeaderSec).toBe(5);
    expect(err.bodyError).toBe('timeout');
  });
});
