/**
 * /mcp 无状态 HTTP 传输 + RFC 9728 PRM 端点。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-mcp-http-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, test } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
// bun 共享模块注册表下 config 可能被其他测试文件先冻结；取当前进程里已生效的合法 admin 凭证，
// 勿写死 'admin-key'（冻结方 identities.test.ts 的 API_KEYS 不含该字面值）。
const { config } = await import('../src/lib/config.ts');
const {
  allowInsecureIssuerUrl,
  mcpAuthMetadataOptions,
} = await import('../src/mcp/http.ts');
const adminKey = [...config.apiKeys][0]!;

const app = createApp({ uiEnabled: false });

const MCP_ACCEPT = 'application/json, text/event-stream';

/** 解析 createMcpHandler 的 SSE 或纯 JSON 响应体。 */
async function readMcpJson(res: Response): Promise<unknown> {
  const text = await res.text();
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  if (dataLine) return JSON.parse(dataLine.slice('data: '.length));
  return JSON.parse(text);
}

/** 已鉴权的 JSON-RPC 调用。 */
function mcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
  authScheme = 'Bearer',
) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `${authScheme} ${token}`,
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

describe('MCP HTTP 鉴权与 RFC 9728', () => {
  test('无 token → 401 + WWW-Authenticate', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www.toLowerCase()).toContain('bearer');
    expect(www).toContain('resource_metadata=');
    expect(www).toContain('/.well-known/oauth-protected-resource');
  });

  test('GET /mcp → 405 且 Allow: POST（无挑战头）', async () => {
    const res = await app.request('/mcp', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  test('坏 token → 401', async () => {
    const res = await mcpRequest('oa_definitely-not-valid', 'tools/list');
    expect(res.status).toBe(401);
    const www = res.headers.get('www-authenticate') ?? '';
    expect(www.toLowerCase()).toContain('bearer');
  });

  test('小写 bearer scheme 能过鉴权（RFC 7235）', async () => {
    const res = await mcpRequest(adminKey, 'tools/list', {}, 1, 'bearer');
    expect(res.status).toBe(200);
  });

  test('GET /.well-known/oauth-protected-resource 为 RFC 9728 形状（无假 AS 端点）', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe('http://localhost/mcp');
    expect(Array.isArray(body.authorization_servers)).toBe(true);
    expect((body.authorization_servers as string[]).length).toBeGreaterThan(0);
    expect(body.scopes_supported as string[]).toContain('mcp');
    expect(body.resource_name).toBe('openagentemail');
    // PRM 不得广告尚未落地的 AS 端点字段
    expect(body.authorization_endpoint).toBeUndefined();
    expect(body.token_endpoint).toBeUndefined();
    expect(body.response_types_supported).toBeUndefined();
  });

  test('GET /.well-known/oauth-protected-resource/mcp 返回同一份 PRM', async () => {
    const root = await app.request('/.well-known/oauth-protected-resource');
    const pathAware = await app.request('/.well-known/oauth-protected-resource/mcp');
    expect(pathAware.status).toBe(200);
    expect(await pathAware.json()).toEqual(await root.json());
  });

  test('/v1 无 token 仍为旧 401 JSON（无 WWW-Authenticate 挑战）', async () => {
    const res = await app.request('/v1/identities');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(res.headers.get('www-authenticate')).toBeNull();
  });
});

describe('MCP 元数据 origin / insecure issuer', () => {
  test('公网 http origin 不放行 insecure issuer', () => {
    expect(allowInsecureIssuerUrl('http://example.com')).toBe(false);
    expect(allowInsecureIssuerUrl('http://1.2.3.4:3100')).toBe(false);
    expect(mcpAuthMetadataOptions('http://example.com').dangerouslyAllowInsecureIssuerUrl).toBe(
      false,
    );
  });

  test('loopback / 私网 http 放行 insecure issuer（与 lib/net 同源）', () => {
    expect(allowInsecureIssuerUrl('http://127.0.0.1:3100')).toBe(true);
    expect(allowInsecureIssuerUrl('http://localhost:3100')).toBe(true);
    expect(allowInsecureIssuerUrl('http://10.1.2.3')).toBe(true);
    expect(allowInsecureIssuerUrl('http://192.168.1.1')).toBe(true);
    expect(allowInsecureIssuerUrl('http://172.16.0.1')).toBe(true);
    expect(allowInsecureIssuerUrl('http://100.64.1.2')).toBe(true);
    expect(allowInsecureIssuerUrl('http://[::1]/')).toBe(true);
    expect(allowInsecureIssuerUrl('http://[fd12:3456::1]')).toBe(true);
    // fe80::/10 永拒（与 IPv4 链路本地对齐），不算可放行私网
    expect(allowInsecureIssuerUrl('http://[fe80::1]/')).toBe(false);
    expect(allowInsecureIssuerUrl('https://127.0.0.1')).toBe(false);
    // 永拒段不算私网：绝不开 insecure issuer
    expect(allowInsecureIssuerUrl('http://169.254.169.254')).toBe(false);
    expect(allowInsecureIssuerUrl('http://0.0.0.0')).toBe(false);
  });

  test('MCP_PUBLIC_URL / publicBaseUrl 覆盖请求 origin', () => {
    const opts = mcpAuthMetadataOptions('http://evil.example', 'https://mail.example.com');
    expect(opts.resourceServerUrl.href).toBe('https://mail.example.com/mcp');
    expect(opts.oauthMetadata.issuer).toBe('https://mail.example.com');
    expect(opts.dangerouslyAllowInsecureIssuerUrl).toBe(false);
    // 覆盖为私网 http 时仍可开 insecure
    const priv = mcpAuthMetadataOptions('https://public.example', 'http://10.0.0.9:3100');
    expect(priv.dangerouslyAllowInsecureIssuerUrl).toBe(true);
  });
});

describe('MCP HTTP 工具', () => {
  test('R9-F RED: shipped public docs describe typed approval creation, decision, and the 16-tool contained inventory', async () => {
    const [rootReadme, packageReadme, security] = await Promise.all([
      Bun.file(new URL('../../../README.md', import.meta.url)).text(),
      Bun.file(new URL('../../mcp/README.md', import.meta.url)).text(),
      Bun.file(new URL('../../../docs/security.md', import.meta.url)).text(),
    ]);
    const docs = `${rootReadme}\n${packageReadme}`;
    expect({
      existingCreate: docs.includes('task_create(to, subject, body, wait?)'),
      typedApproval: /approval.*action.*expiresAt|kind.*approval/s.test(docs),
      decide: docs.includes('task_decide'),
      securityToolCount: /16\s+tools/i.test(security),
      containedDecision: /contained[^\n]*task_decide|task_decide[^\n]*contained/i.test(security),
    }).toEqual({
      existingCreate: true,
      typedApproval: true,
      decide: true,
      securityToolCount: true,
      containedDecision: true,
    });
  });

  test('admin key：tools/list 返回全部 16 工具', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: { name: string }[] };
    };
    const names = (body.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual([
      'mail_list_identities',
      'mail_list_messages',
      'mail_mark_seen',
      'mail_new_identity',
      'mail_read_message',
      'mail_send',
      'mail_wait_for',
      'notify_agent',
      'notify_check',
      'notify_user',
      'notify_verify',
      'task_create',
      'task_decide',
      'task_get',
      'task_list',
      'task_update',
    ].sort());
  });

  test('identity token：tools/list 同样返回 16 工具', async () => {
    const { token } = createIdentity({ localpart: 'mcp-list-id' })!;
    const res = await mcpRequest(token, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: unknown[] };
    };
    expect(body.result?.tools?.length).toBe(16);
  });

  test('mail_list_identities 无状态直连：连续两请求无 session 头各自成功', async () => {
    createIdentity({ localpart: 'mcp-stateless-a' });
    const res1 = await mcpRequest(adminKey, 'tools/call', {
      name: 'mail_list_identities',
      arguments: {},
    }, 10);
    const res2 = await mcpRequest(adminKey, 'tools/call', {
      name: 'mail_list_identities',
      arguments: {},
    }, 11);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.headers.get('mcp-session-id')).toBeNull();
    expect(res2.headers.get('mcp-session-id')).toBeNull();

    const b1 = (await readMcpJson(res1)) as {
      result?: { structuredContent?: { identities?: { address: string }[] }; isError?: boolean };
    };
    const b2 = (await readMcpJson(res2)) as {
      result?: { structuredContent?: { identities?: { address: string }[] }; isError?: boolean };
    };
    expect(b1.result?.isError).toBeFalsy();
    expect(b2.result?.isError).toBeFalsy();
    const addrs1 = b1.result?.structuredContent?.identities?.map((i) => i.address) ?? [];
    expect(addrs1).toContain('mcp-stateless-a@test.example');
    const addrs2 = b2.result?.structuredContent?.identities?.map((i) => i.address) ?? [];
    expect(addrs2).toContain('mcp-stateless-a@test.example');
  });

  test('identity token 读他人地址 → 被拒（scope 继承）', async () => {
    const a = createIdentity({ localpart: 'mcp-scope-a' })!;
    createIdentity({ localpart: 'mcp-scope-b' });
    const res = await mcpRequest(a.token, 'tools/call', {
      name: 'mail_list_messages',
      arguments: { address: 'mcp-scope-b@test.example' },
    });
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? '';
    expect(text.toLowerCase()).toMatch(/forbidden|403|scoped/);
  });
});

/**
 * 广播契约：客户端 ajv 用 tools/list 的 JSON Schema（additionalProperties:false）
 * 校验 structuredContent，这才是生产 -32602 的来源。服务端 zod 默认非严格，
 * 多余键只剥不抛，所以 POST /mcp tools/call 测不到本 bug。
 */
describe('MCP task_list/task_get 广播 outputSchema 契约', () => {
  type JsonSchema = {
    additionalProperties?: boolean;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
  };

  function messageItemSchema(toolName: 'task_list' | 'task_get', outputSchema: unknown): JsonSchema {
    const root = outputSchema as JsonSchema;
    if (toolName === 'task_list') {
      return root.properties?.tasks?.items?.properties?.messages?.items ?? {};
    }
    return root.properties?.messages?.items ?? {};
  }

  test('tools/list 广播的 message 层含 kind 与 idempotencyKey，且 additionalProperties=false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; outputSchema?: unknown }> };
    };
    for (const name of ['task_list', 'task_get'] as const) {
      const tool = body.result?.tools?.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeTruthy();
      const item = messageItemSchema(name, tool?.outputSchema);
      expect(item.additionalProperties).toBe(false);
      expect(item.properties).toHaveProperty('kind');
      expect(item.properties).toHaveProperty('idempotencyKey');
    }
  });

  test('approval create/decide and task output schemas are broadcast with typed approval fields', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    const body = (await readMcpJson(res)) as { result?: { tools?: Array<{ name: string; inputSchema?: JsonSchema; outputSchema?: JsonSchema }> } };
    const tools = body.result?.tools ?? [];
    const create = tools.find((tool) => tool.name === 'task_create');
    const decide = tools.find((tool) => tool.name === 'task_decide');
    const get = tools.find((tool) => tool.name === 'task_get');
    expect(create?.inputSchema?.properties).toHaveProperty('kind');
    expect(create?.inputSchema?.properties).toHaveProperty('approval');
    expect(decide?.inputSchema?.properties).toHaveProperty('decision');
    expect(get?.outputSchema?.properties).toHaveProperty('kind');
    expect(get?.outputSchema?.properties).toHaveProperty('approval');
  });
});

/**
 * handler 未剥催办字段：注入含 kind/idempotencyKey 的真实形状，经 /mcp→/v1
 * 回环仍出现在 structuredContent。这证明对外语义保留，但不能当 -32602 回归网
 *（服务端 zod 非严格，修前也会绿）。
 */
describe('MCP task_list/task_get outputSchema 覆盖催办字段', () => {
  const from = 'alpha@test.example';
  const to = 'bravo@test.example';
  const reminderTask = {
    id: 'a1b2c3d4-e5f6-4780-8bcd-ef1234567890',
    from,
    to,
    subject: 'Need a nudge',
    state: 'working' as const,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:10:00.000Z',
    messages: [
      {
        id: '1',
        from,
        to,
        subject: 'Need a nudge',
        date: '2026-08-18T00:00:00.000Z',
        state: 'submitted' as const,
        body: 'Please look.',
      },
      {
        id: '2',
        from: to,
        to: from,
        subject: 'Need a nudge',
        date: '2026-08-18T00:05:00.000Z',
        state: 'working' as const,
        body: 'On it.',
        kind: 'state' as const,
      },
      {
        id: '3',
        from,
        to,
        subject: 'Need a nudge',
        date: '2026-08-18T00:10:00.000Z',
        state: 'working' as const,
        body: 'Any update?',
        kind: 'reminder' as const,
        idempotencyKey: 'nudge-1',
      },
    ],
  };
  const submittedTask = {
    id: 'b2c3d4e5-f6a7-4890-9cde-f12345678901',
    from,
    to,
    subject: 'No reminder yet',
    state: 'submitted' as const,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    messages: [
      {
        id: '1',
        from,
        to,
        subject: 'No reminder yet',
        date: '2026-08-18T00:00:00.000Z',
        state: 'submitted' as const,
        body: 'Just filed.',
      },
    ],
  };

  const unused = async () => {
    throw new Error('unused in outputSchema fixture');
  };
  const fixtureApp = createApp({
    uiEnabled: false,
    taskService: {
      create: unused,
      list: async (state) => {
        const all = [reminderTask, submittedTask];
        return state ? all.filter((task) => task.state === state) : all;
      },
      listBoard: unused,
      get: async (id) => (id === reminderTask.id ? reminderTask : null),
      update: unused,
      reply: unused,
      remind: unused,
      close: unused,
      waitForTerminal: unused,
    },
  });

  function fixtureMcp(method: string, params: Record<string, unknown> = {}, id = 1) {
    return fixtureApp.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminKey}`,
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  }

  test('无参 task_list：含 reminder+idempotencyKey 的消息通过出口校验', async () => {
    const res = await fixtureMcp('tools/call', { name: 'task_list', arguments: {} });
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: {
        isError?: boolean;
        structuredContent?: {
          tasks?: Array<{
            id: string;
            messages: Array<{ kind?: string; idempotencyKey?: string }>;
          }>;
        };
      };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    const tasks = body.result?.structuredContent?.tasks ?? [];
    expect(tasks.map((t) => t.id)).toEqual([reminderTask.id, submittedTask.id]);
    const reminder = tasks[0]?.messages.find((m) => m.kind === 'reminder');
    expect(reminder?.idempotencyKey).toBe('nudge-1');
  });

  test('带 state 筛选的 task_list 仍正常', async () => {
    const res = await fixtureMcp('tools/call', {
      name: 'task_list',
      arguments: { state: 'submitted' },
    });
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number };
      result?: { isError?: boolean; structuredContent?: { tasks?: { id: string }[] } };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent?.tasks?.map((t) => t.id)).toEqual([submittedTask.id]);
  });

  test('task_get 同源 schema：催办消息不触发 -32602', async () => {
    const res = await fixtureMcp('tools/call', {
      name: 'task_get',
      arguments: { id: reminderTask.id },
    });
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: {
        isError?: boolean;
        structuredContent?: { messages?: Array<{ kind?: string; idempotencyKey?: string }> };
      };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    const reminder = body.result?.structuredContent?.messages?.find((m) => m.kind === 'reminder');
    expect(reminder?.idempotencyKey).toBe('nudge-1');
  });
});

describe('MCP registered task handlers execute through the production HTTP transport', () => {
  test('ordinary/approval create and contained decide preserve their distinct REST contracts', async () => {
    const requester = createIdentity({ localpart: `r3b-requester-${crypto.randomUUID().slice(0, 8)}` })!;
    const reviewer = createIdentity({ localpart: `r3b-reviewer-${crypto.randomUUID().slice(0, 8)}` })!;
    const ordinary = {
      id: 'ac1b2c3d-e5f6-4780-8bcd-ef1234567890', from: requester.identity.address, to: reviewer.identity.address,
      subject: 'Ordinary handler task', state: 'submitted' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
    };
    const action = { type: 'deployment', name: 'publish-preview', arguments: { dryRun: true } };
    const approval = {
      id: 'bc1b2c3d-e5f6-4780-8bcd-ef1234567890', from: requester.identity.address, to: reviewer.identity.address,
      subject: 'Approval handler task', state: 'input-required' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
      kind: 'approval' as const,
      approval: { action, reviewer: reviewer.identity.address, expiresAt: '2030-08-25T00:00:00.000Z', digest: 'a'.repeat(64) },
    };
    const calls: { ordinary?: unknown; approval?: unknown; decide?: unknown } = {};
    const unused = async () => { throw new Error('unused in MCP handler fixture'); };
    const handlerApp = createApp({
      uiEnabled: false,
      taskService: {
        create: async (input) => { calls.ordinary = input; return ordinary; },
        createApproval: async (input) => { calls.approval = input; return approval; },
        decideApproval: async (input) => {
          calls.decide = input;
          return { ...approval, state: 'completed' as const, result: { decision: input.decision } };
        },
        list: unused, listBoard: unused, get: async (id) => id === approval.id ? approval : null,
        update: unused, reply: unused, remind: unused, close: unused, waitForTerminal: unused,
      },
    });
    const call = (token: string, name: string, args: Record<string, unknown>, id: number) =>
      handlerApp.request('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: MCP_ACCEPT },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
      });

    const ordinaryResponse = await call(requester.token, 'task_create', {
      to: reviewer.identity.address, subject: ordinary.subject, body: 'ordinary body',
    }, 801);
    const approvalResponse = await call(requester.token, 'task_create', {
      to: reviewer.identity.address, subject: approval.subject, body: 'record only', kind: 'approval',
      approval: { action, expiresAt: approval.approval.expiresAt },
    }, 802);
    const decideResponse = await call(reviewer.token, 'task_decide', {
      id: approval.id, decision: 'approved',
    }, 803);
    for (const response of [ordinaryResponse, approvalResponse, decideResponse]) {
      expect(response.status).toBe(200);
      const body = (await readMcpJson(response)) as { result?: { isError?: boolean } };
      expect(body.result?.isError, JSON.stringify(body)).toBeFalsy();
    }
    expect(calls).toEqual({
      ordinary: { from: requester.identity.address, to: reviewer.identity.address, subject: ordinary.subject, body: 'ordinary body' },
      approval: {
        from: requester.identity.address, to: reviewer.identity.address, subject: approval.subject, body: 'record only',
        action, expiresAt: '2030-08-25T00:00:00.000Z',
      },
      // The handler received no `from`; the REST identity binding supplied it.
      decide: { id: approval.id, from: reviewer.identity.address, decision: 'approved' },
    });
  });
});
