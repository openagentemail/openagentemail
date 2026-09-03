/**
 * /mcp 无状态 HTTP 传输 + RFC 9728 PRM 端点。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-mcp-http-'));
process.env.UI_ENABLED = 'false';
process.env.TASK_LEASES_ENABLED = 'true';

const { describe, expect, test: bunTest } = await import('bun:test');
const { createApp } = await import('../src/app.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const { setTaskNowForTests } = await import('./support/task-test-seams.ts');
const { withTaskLeasesEnabledForTests } = await import('./support/task-lease-seams.ts');
const test = (name: string, work: () => void | Promise<void>) => bunTest(name, () => withTaskLeasesEnabledForTests(true, work));
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
  test('published MCP README bundles and links the canonical approval recipe and vectors', async () => {
    const [packageReadme, packageJson] = await Promise.all([
      Bun.file(new URL('../../mcp/README.md', import.meta.url)).text(),
      Bun.file(new URL('../../mcp/package.json', import.meta.url)).json() as Promise<{ files: string[] }>,
    ]);
    const check = Bun.spawnSync({
      cmd: ['node', fileURLToPath(new URL('../scripts/sync-approval-publication.mjs', import.meta.url)), '--check'],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(packageReadme).toContain('[recipe](./approval-digest.md)');
    expect(packageReadme).toContain('[public vectors](./approval-canonical-vectors.v1.json)');
    expect(packageJson.files).toEqual([
      'dist', 'README.md', 'approval-digest.md', 'approval-canonical-vectors.v1.json',
    ]);
    expect(check.exitCode).toBe(0);
  });

  test('R9-F RED: shipped public docs describe typed approval creation, children listing, decision, and the 20-tool inventory', async () => {
    const [rootReadme, packageReadme, security] = await Promise.all([
      Bun.file(new URL('../../../README.md', import.meta.url)).text(),
      Bun.file(new URL('../../mcp/README.md', import.meta.url)).text(),
      Bun.file(new URL('../../../docs/security.md', import.meta.url)).text(),
    ]);
    const docs = `${rootReadme}\n${packageReadme}`;
    expect({
      rootCreate: rootReadme.includes('task_create(to, subject, body?, kind?, approval?, wait?, parentTaskId?)'),
      packageCreate: packageReadme.includes('task_create(to, subject, body, wait?, parentTaskId?)')
        && packageReadme.includes('task_create(to, subject, kind: "approval", approval: { action, expiresAt }, body?, wait?, parentTaskId?)'),
      listChildren: [rootReadme, packageReadme].every((readme) => readme.includes('task_list_children(parentTaskId, limit?, cursor?)')),
      typedApproval: /approval.*action.*expiresAt|kind.*approval/s.test(docs),
      decide: docs.includes('task_decide'),
      securityToolCount: /20\s+tools/i.test(security),
      readChildren: /read[^\n]*task_list_children|task_list_children[^\n]*read/i.test(security),
      containedDecision: /contained[^\n]*task_decide|task_decide[^\n]*contained/i.test(security),
    }).toEqual({
      rootCreate: true,
      packageCreate: true,
      listChildren: true,
      typedApproval: true,
      decide: true,
      securityToolCount: true,
      readChildren: true,
      containedDecision: true,
    });
  });

  test('R9 RED: shipped MCP docs and security inventory describe all lease surfaces', async () => {
    const [rootReadme, packageReadme, security] = await Promise.all([
      Bun.file(new URL('../../../README.md', import.meta.url)).text(),
      Bun.file(new URL('../../mcp/README.md', import.meta.url)).text(),
      Bun.file(new URL('../../../docs/security.md', import.meta.url)).text(),
    ]);
    const signatures = ['task_claim(id, leaseSec?)', 'task_renew(id, leaseToken, leaseSec?)', 'task_release(id, leaseToken, reason?)'];
    const docs = `${rootReadme}\n${packageReadme}`;
    expect({
      rootSignatures: signatures.every((signature) => rootReadme.includes(signature)),
      packageSignatures: signatures.every((signature) => packageReadme.includes(signature)),
      optInDefaultDisabled: /TASK_LEASES_ENABLED[\s\S]{0,160}(default|默认)[\s\S]{0,80}(false|关闭)|(?:default|默认)[\s\S]{0,80}(false|关闭)[\s\S]{0,160}TASK_LEASES_ENABLED/i.test(docs),
      bearerSecrecy: /leaseToken[\s\S]{0,160}(never|only|仅|不)[\s\S]{0,160}(bearer|token)|(?:bearer|token)[\s\S]{0,160}(never|only|仅|不)[\s\S]{0,160}leaseToken/i.test(docs),
      securityTwentyTools: /20\s+tools/i.test(security),
      securityContainedLeases: ['task_claim', 'task_renew', 'task_release'].every((tool) => new RegExp(`contained[^\\n]*${tool}|${tool}[^\\n]*contained`, 'i').test(security)),
    }).toEqual({
      rootSignatures: true,
      packageSignatures: true,
      optInDefaultDisabled: true,
      bearerSecrecy: true,
      securityTwentyTools: true,
      securityContainedLeases: true,
    });
  });

  test('#56 RED：admin key tools/list 返回任务租约的 19 工具', async () => {
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
      'task_list_children',
      'task_decide',
      'task_get',
      'task_list',
      'task_update',
      'task_claim',
      'task_renew',
      'task_release',
    ].sort());
  });

  test('#56 RED：admin key tools/list 广播 claim 的 input/output schema', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> }; outputSchema?: { properties?: Record<string, unknown> } }> };
    };
    const claim = body.result?.tools?.find((tool) => tool.name === 'task_claim') as {
      inputSchema?: { properties?: Record<string, unknown> };
      outputSchema?: { properties?: Record<string, unknown> };
    } | undefined;
    // This runs independently of the inventory assertion above, while making
    // an absent tool a named schema-contract RED rather than a TypeError.
    if (!claim) {
      expect(claim, '#56 task_claim must be registered before its schema can be broadcast').toBeDefined();
      return;
    }
    expect(claim?.inputSchema?.properties).toHaveProperty('leaseSec');
    expect(claim?.outputSchema?.properties).toHaveProperty('leaseToken');
    expect(claim?.outputSchema?.properties).toHaveProperty('claimedUntil');
    expect(claim?.outputSchema?.properties).toHaveProperty('leaseGeneration');
    expect(claim?.outputSchema?.properties).not.toHaveProperty('leaseTokenHash');
  });

  test('#56 R15: tools/list describes lease eligibility and current-token requirements', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    };
    const description = (name: string) => body.result?.tools?.find((tool) => tool.name === name)?.description ?? '';
    expect({
      claimSubmittedInitial: /submitted task/i.test(description('task_claim')),
      claimAuthenticatedReceiptReclaim: /authenticated expired or released lease receipt/i.test(description('task_claim')),
      renewCurrentActiveOpaqueToken: /current active opaque lease token/i.test(description('task_renew')),
      releaseCurrentActiveOpaqueToken: /current active opaque lease token/i.test(description('task_release')),
    }).toEqual({
      claimSubmittedInitial: true,
      claimAuthenticatedReceiptReclaim: true,
      renewCurrentActiveOpaqueToken: true,
      releaseCurrentActiveOpaqueToken: true,
    });
  });

  test('#56/#58：identity token tools/list returns the full tool inventory', async () => {
    const { token } = createIdentity({ localpart: 'mcp-list-id' })!;
    const res = await mcpRequest(token, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: unknown[] };
    };
    expect(body.result?.tools?.length).toBe(20);
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

  test('MCP create/read roundtrip for bot@localhost and bot@example.com. succeeds', async () => {
    const prevHadLocalhost = config.allDomains.has('localhost');
    const prevHadDotted = config.allDomains.has('example.com.');
    (config.allDomains as Set<string>).add('localhost');
    (config.allDomains as Set<string>).add('example.com.');
    try {
      // 1. Create bot@localhost via MCP
      const resLocal = await mcpRequest(adminKey, 'tools/call', {
        name: 'mail_new_identity',
        arguments: { localpart: 'bot-lh', domain: 'localhost' },
      });
      expect(resLocal.status).toBe(200);
      const bLocal = (await readMcpJson(resLocal)) as {
        result?: { structuredContent?: { address: string }; isError?: boolean };
      };
      expect(bLocal.result?.isError).toBeFalsy();
      expect(bLocal.result?.structuredContent?.address).toBe('bot-lh@localhost');

      // 2. Create bot@example.com. via MCP
      const resDotted = await mcpRequest(adminKey, 'tools/call', {
        name: 'mail_new_identity',
        arguments: { localpart: 'bot-dot', domain: 'example.com.' },
      });
      expect(resDotted.status).toBe(200);
      const bDotted = (await readMcpJson(resDotted)) as {
        result?: { structuredContent?: { address: string }; isError?: boolean };
      };
      expect(bDotted.result?.isError).toBeFalsy();
      expect(bDotted.result?.structuredContent?.address).toBe('bot-dot@example.com.');

      // 3. Read identities via MCP and verify both are present
      const resList = await mcpRequest(adminKey, 'tools/call', {
        name: 'mail_list_identities',
        arguments: {},
      });
      expect(resList.status).toBe(200);
      const bList = (await readMcpJson(resList)) as {
        result?: { structuredContent?: { identities?: { address: string }[] }; isError?: boolean };
      };
      expect(bList.result?.isError).toBeFalsy();
      const addresses = bList.result?.structuredContent?.identities?.map((i) => i.address) ?? [];
      expect(addresses).toContain('bot-lh@localhost');
      expect(addresses).toContain('bot-dot@example.com.');
    } finally {
      if (!prevHadLocalhost) (config.allDomains as Set<string>).delete('localhost');
      if (!prevHadDotted) (config.allDomains as Set<string>).delete('example.com.');
    }
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
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [], parentTaskId: 'dc1b2c3d-e5f6-4780-8bcd-ef1234567890',
    };
    const action = { type: 'deployment', name: 'publish-preview', arguments: { dryRun: true } };
    const approval = {
      id: 'bc1b2c3d-e5f6-4780-8bcd-ef1234567890', from: requester.identity.address, to: reviewer.identity.address,
      subject: 'Approval handler task', state: 'input-required' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
      kind: 'approval' as const, parentTaskId: 'dc1b2c3d-e5f6-4780-8bcd-ef1234567890',
      approval: { action, reviewer: reviewer.identity.address, expiresAt: '2030-08-25T00:00:00.000Z', digest: 'a'.repeat(64) },
    };
    const calls: { ordinary?: unknown; approval?: unknown; decide?: unknown } = {};
    const parentId = 'dc1b2c3d-e5f6-4780-8bcd-ef1234567890';
    const parent = { ...ordinary, id: parentId, subject: 'durable parent' };
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
        list: unused, listBoard: unused, getForAuthorization: async (id) => id === parentId ? parent : id === approval.id ? approval : ordinary, get: async (id) => id === approval.id ? approval : null,
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
      to: reviewer.identity.address, subject: ordinary.subject, body: 'ordinary body', parentTaskId: parentId,
    }, 801);
    const approvalResponse = await call(requester.token, 'task_create', {
      to: reviewer.identity.address, subject: approval.subject, body: 'record only', kind: 'approval',
      approval: { action, expiresAt: approval.approval.expiresAt }, parentTaskId: parentId,
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
      ordinary: { from: requester.identity.address, to: reviewer.identity.address, subject: ordinary.subject, body: 'ordinary body', parentTaskId: parentId },
      approval: {
        from: requester.identity.address, to: reviewer.identity.address, subject: approval.subject, body: 'record only',
        action, expiresAt: '2030-08-25T00:00:00.000Z', parentTaskId: parentId,
      },
      // The handler received no `from`; the REST identity binding supplied it.
      decide: { id: approval.id, from: reviewer.identity.address, decision: 'approved' },
    });
    const acceptedCalls = structuredClone(calls);
    for (const [id, invalidParent] of [
      [804, '018f8d1d-4d7e-7b0a-8000-000000000000'],
      [805, '018f8d1d-4d7e-8b0a-8000-000000000000'],
    ] as const) {
      const invalid = await call(requester.token, 'task_create', {
        to: reviewer.identity.address, subject: ordinary.subject, body: 'ordinary body', parentTaskId: invalidParent,
      }, id);
      expect(invalid.status).toBe(200);
      expect((await readMcpJson(invalid) as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(calls).toEqual(acceptedCalls);
    }
  });

  test('R3 task_list_children forwards the scoped cursor request through production MCP transport', async () => {
    const requester = createIdentity({ localpart: `r3-children-${crypto.randomUUID().slice(0, 8)}` })!;
    const recipient = createIdentity({ localpart: `r3-child-recipient-${crypto.randomUUID().slice(0, 8)}` })!;
    const parentId = 'ec1b2c3d-e5f6-4780-8bcd-ef1234567890';
    const childId = 'fc1b2c3d-e5f6-4780-8bcd-ef1234567890';
    const parent = { id: parentId, from: requester.identity.address, to: recipient.identity.address, subject: 'parent', state: 'submitted' as const, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [] };
    const child = { ...parent, id: childId, subject: 'child', parentTaskId: parentId };
    let seen: unknown; let rejectParent = false; let listChildrenCalls = 0;
    const hiddenParent = { ...parent, from: 'hidden@test.example', to: 'also-hidden@test.example' };
    const unused = async () => { throw new Error('unused R3 child handler fixture'); };
    const handlerApp = createApp({ uiEnabled: false, taskService: {
      create: unused, list: unused, listBoard: unused, get: async (id) => id === parentId ? parent : null,
      getForAuthorization: async (id) => id === parentId ? (rejectParent ? hiddenParent : parent) : null,
      listChildren: async (query, viewer) => { listChildrenCalls += 1; seen = { query, viewer }; return { children: [child], nextCursor: 'opaque-next' }; },
      update: unused, reply: unused, remind: unused, close: unused, waitForTerminal: unused,
    } });
    const call = (args: Record<string, unknown>, id: number) => handlerApp.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${requester.token}`, 'content-type': 'application/json', accept: MCP_ACCEPT }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'task_list_children', arguments: args } }) });
    const response = await call({ parentTaskId: parentId, limit: 50, cursor: 'opaque-input' }, 880);
    expect(response.status).toBe(200); const body = await readMcpJson(response) as any;
    expect(body.result?.isError).toBeFalsy(); expect(body.result?.structuredContent).toEqual({ children: [child], nextCursor: 'opaque-next' });
    expect(seen).toEqual({ query: { parentTaskId: parentId, limit: 50, cursor: 'opaque-input' }, viewer: { kind: 'identity', address: requester.identity.address } });
    rejectParent = true;
    const denied = await call({ parentTaskId: parentId, limit: 20 }, 881);
    expect(denied.status).toBe(200); const deniedBody = await readMcpJson(denied) as any;
    const deniedText = JSON.stringify(deniedBody);
    expect(deniedBody.result?.isError).toBe(true); expect(deniedBody.result?.structuredContent).toBeUndefined();
    expect(deniedText).toContain('Forbidden (403): forbidden: task participant required');
    expect(deniedText).not.toContain('zod'); expect(deniedText).not.toContain('schema'); expect(deniedText).not.toContain('stack'); expect(listChildrenCalls).toBe(1);
    for (const [id, invalidParent] of [
      [882, '018f8d1d-4d7e-7b0a-8000-000000000000'],
      [883, '018f8d1d-4d7e-8b0a-8000-000000000000'],
    ] as const) {
      const invalid = await call({ parentTaskId: invalidParent, limit: 20 }, id);
      expect(invalid.status).toBe(200);
      expect((await readMcpJson(invalid) as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(listChildrenCalls).toBe(1);
    }
  });

  test('R9 proof: real HTTP MCP lease calls bind identity, validate schema, and redact renew/release', async () => {
    const recipient = createIdentity({ localpart: `r9-lease-${crypto.randomUUID().slice(0, 8)}` })!;
    const id = 'c1c2c3c4-c5c6-47c8-89ca-cbcccccccccc';
    const verifier = 'r9-mcp-verifier-never-public';
    const bearer = 'r9-mcp-bearer-opaque';
    const claimedUntil = '2026-08-24T00:05:00.000Z';
    const renewedUntil = '2026-08-24T00:06:00.000Z';
    setTaskNowForTests(() => Date.parse('2026-08-24T00:04:59.999Z'));
    try {
    const base = {
      id, from: 'origin@test.example', to: recipient.identity.address, subject: 'MCP lease proof', state: 'working' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
    };
    const calls: { claim?: unknown; renew?: unknown; release?: unknown } = {};
    const unused = async () => { throw new Error('unused in R9 lease fixture'); };
    const handlerApp = createApp({
      uiEnabled: false,
      taskService: {
        create: unused, list: unused, listBoard: unused, get: async () => base,
        update: unused, reply: unused, remind: unused, close: unused, waitForTerminal: unused,
        claim: async (input) => {
          calls.claim = input;
          return {
            task: { ...base, lease: { leaseGeneration: 1, claimedUntil, tokenVerifier: verifier } },
            leaseToken: bearer,
            claimedUntil,
            leaseGeneration: 1,
          };
        },
        renew: async (input) => {
          calls.renew = input;
          return { ...base, lease: { leaseGeneration: 1, claimedUntil: renewedUntil, tokenVerifier: verifier } };
        },
        release: async (input) => {
          calls.release = input;
          return { ...base, releasedLease: { leaseGeneration: 1, tokenVerifier: verifier, reason: input.reason ?? '' } };
        },
      },
    });
    const call = (name: string, args: Record<string, unknown>, requestId: number) => handlerApp.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${recipient.token}`, 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const invalid = await call('task_claim', { id, leaseSec: 29 }, 901);
    const callsBeforeValid = { ...calls };
    const claim = await call('task_claim', { id, leaseSec: 120 }, 902);
    const renew = await call('task_renew', { id, leaseToken: bearer, leaseSec: 180 }, 903);
    const release = await call('task_release', { id, leaseToken: bearer, reason: 'handoff' }, 904);
    const [invalidBody, claimBody, renewBody, releaseBody] = await Promise.all([invalid, claim, renew, release].map(readMcpJson)) as Array<{
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    }>;
    const claimContent = claimBody.result?.structuredContent;
    const renewContent = renewBody.result?.structuredContent;
    const releaseContent = releaseBody.result?.structuredContent;
    expect({
      statuses: [invalid.status, claim.status, renew.status, release.status],
      invalidStoppedBeforeCallback: invalidBody.result?.isError === true && Object.keys(callsBeforeValid).length === 0,
      callbacks: calls,
      successfulSchemas: [claimBody, renewBody, releaseBody].every((body) => !body.result?.isError),
      claimBearerOnly: claimContent?.leaseToken === bearer
        && !JSON.stringify({ renewContent, releaseContent }).includes(bearer),
      privateVerifierAbsent: !JSON.stringify({ claimContent, renewContent, releaseContent }).includes(verifier),
      publicTiming: {
        claim: [claimContent?.claimedUntil, claimContent?.leaseGeneration],
        renewTask: [renewContent?.claimedUntil, renewContent?.leaseGeneration],
        releaseTask: [releaseContent?.claimedUntil, releaseContent?.leaseGeneration],
      },
    }).toEqual({
      statuses: [200, 200, 200, 200],
      invalidStoppedBeforeCallback: true,
      callbacks: {
        claim: { id, from: recipient.identity.address, leaseSec: 120 },
        renew: { id, from: recipient.identity.address, leaseToken: bearer, leaseSec: 180 },
        release: { id, from: recipient.identity.address, leaseToken: bearer, reason: 'handoff' },
      },
      successfulSchemas: true,
      claimBearerOnly: true,
      privateVerifierAbsent: true,
      publicTiming: {
        claim: [claimedUntil, 1],
        renewTask: [renewedUntil, 1],
        releaseTask: [undefined, undefined],
      },
    });
    } finally {
      setTaskNowForTests(null);
    }
  });

  test('R12 RED: real HTTP MCP task_update propagates an optional lease token without returning it', async () => {
    const identity = createIdentity({ localpart: `r12-update-${crypto.randomUUID().slice(0, 8)}` })!;
    const id = 'd1d2d3d4-d5d6-47d8-89ca-dbdddddddddd';
    const leaseToken = 'r12-opaque-lease-token-never-returned';
    const base = {
      id, from: 'origin@test.example', to: identity.identity.address, subject: 'MCP update lease proof', state: 'working' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
    };
    const updates: unknown[] = [];
    const unused = async () => { throw new Error('unused in R12 update fixture'); };
    const handlerApp = createApp({
      uiEnabled: false,
      taskService: {
        create: unused, list: unused, listBoard: unused, get: async () => base,
        update: async (input) => {
          updates.push(input);
          return { ...base, state: input.state };
        },
        reply: unused, remind: unused, close: unused, waitForTerminal: unused,
      },
    });
    const call = (args: Record<string, unknown>, requestId: number) => handlerApp.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'task_update', arguments: args } }),
    });
    const withToken = await call({ id, state: 'input-required', leaseToken }, 1201);
    const withTokenBody = await readMcpJson(withToken) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    const omittedToken = await call({ id, state: 'working' }, 1202);
    const omittedTokenBody = await readMcpJson(omittedToken) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    expect({
      statuses: [withToken.status, omittedToken.status],
      successfulSchemas: [withTokenBody, omittedTokenBody].every((body) => !body.result?.isError),
      updates,
      resultTokenFree: !JSON.stringify({ withTokenBody, omittedTokenBody }).includes(leaseToken),
    }).toEqual({
      statuses: [200, 200],
      successfulSchemas: true,
      updates: [
        { id, from: identity.identity.address, state: 'input-required', leaseToken },
        { id, from: identity.identity.address, state: 'working' },
      ],
      resultTokenFree: true,
    });
  });

  test('#79 real HTTP MCP relays task_lease_required as an opaque 409 tool error', async () => {
    const identity = createIdentity({ localpart: `r79-update-${crypto.randomUUID().slice(0, 8)}` })!;
    const id = 'e1e2e3e4-e5e6-47e8-89ca-ebdddddddddd';
    const supplied = 'r79-wrong-opaque-bearer';
    const base = {
      id, from: 'origin@test.example', to: identity.identity.address, subject: 'MCP dual-track proof', state: 'working' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
    };
    const updates: Array<{ id: string; from: string; state: string; leaseToken?: string }> = [];
    const unused = async () => { throw new Error('unused in R79 MCP fixture'); };
    const handlerApp = createApp({
      uiEnabled: false,
      taskService: {
        create: unused, list: unused, listBoard: unused, get: async () => base,
        update: async (input) => {
          updates.push(input);
          throw new Error('task_lease_required');
        },
        reply: unused, remind: unused, close: unused, waitForTerminal: unused,
      },
    });
    const call = (leaseToken: string, requestId: number) => handlerApp.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'task_update', arguments: { id, state: 'input-required', leaseToken } } }),
    });
    const [response, emptyResponse] = await Promise.all([call(supplied, 1301), call('', 1302)]);
    const [body, emptyBody] = await Promise.all([response, emptyResponse].map(readMcpJson)) as Array<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }>;
    const wrongText = JSON.stringify(body);
    const emptyText = JSON.stringify(emptyBody);
    const privateAuthorityPattern = /tokenVerifier|firstClaimedAt|generationClaimedAt/;
    expect({
      wrong: {
        status: response.status,
        toolError: body.result?.isError,
        code: wrongText.includes('task_lease_required'),
        statusText: wrongText.includes('409'),
        bearerAbsent: !wrongText.includes(supplied),
        privateAuthorityAbsent: !privateAuthorityPattern.test(wrongText),
      },
      empty: {
        status: emptyResponse.status,
        toolError: emptyBody.result?.isError,
        code: emptyText.includes('task_lease_required'),
        statusText: emptyText.includes('409'),
        inputValidationAbsent: !/input validation|invalid (input|argument)|-32602/i.test(emptyText),
        privateAuthorityAbsent: !privateAuthorityPattern.test(emptyText),
      },
      updates: updates
        .map((input) => ({ id: input.id, from: input.from, state: input.state, leaseToken: input.leaseToken }))
        .sort((left, right) => (left.leaseToken ?? '').localeCompare(right.leaseToken ?? '')),
    }).toEqual({
      wrong: { status: 200, toolError: true, code: true, statusText: true, bearerAbsent: true, privateAuthorityAbsent: true },
      empty: { status: 200, toolError: true, code: true, statusText: true, inputValidationAbsent: true, privateAuthorityAbsent: true },
      updates: [
        { id, from: identity.identity.address, state: 'input-required', leaseToken: '' },
        { id, from: identity.identity.address, state: 'input-required', leaseToken: supplied },
      ],
    });
  });

  test('#79 MCP forwards an oversized supplied update bearer to the shared lease fence', async () => {
    const identity = createIdentity({ localpart: `r14-update-${crypto.randomUUID().slice(0, 8)}` })!;
    const id = 'e1e2e3e4-e5e6-47e8-89ca-ebeeeeeeeeee';
    const supplied = `wrong-${'x'.repeat(16_384)}`;
    const base = {
      id, from: 'origin@test.example', to: identity.identity.address, subject: 'MCP envelope bearer proof', state: 'working' as const,
      createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', messages: [],
      lease: { claimedUntil: '2026-08-24T01:00:00.000Z', leaseGeneration: 1, tokenVerifier: 'private-verifier' },
    };
    const updates: Array<{ leaseToken?: string }> = [];
    const unused = async () => { throw new Error('unused in R14 MCP fixture'); };
    const handlerApp = createApp({
      uiEnabled: false,
      taskService: {
        create: unused, list: unused, listBoard: unused, get: async () => base,
        update: async (input) => {
          updates.push(input);
          throw new Error('task_lease_required');
        },
        reply: unused, remind: unused, close: unused, waitForTerminal: unused,
      },
    });
    const response = await handlerApp.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1401, method: 'tools/call', params: { name: 'task_update', arguments: { id, state: 'input-required', leaseToken: supplied } } }),
    });
    const body = await readMcpJson(response) as { result?: { isError?: boolean } };
    const text = JSON.stringify(body);

    expect({
      status: response.status,
      toolError: body.result?.isError,
      code: text.includes('task_lease_required'),
      statusText: text.includes('409'),
      inputValidationAbsent: !/input validation|invalid (input|argument)|-32602/i.test(text),
      forwarded: updates[0]?.leaseToken === supplied,
      bearerAbsent: !text.includes(supplied),
    }).toEqual({
      status: 200,
      toolError: true,
      code: true,
      statusText: true,
      inputValidationAbsent: true,
      forwarded: true,
      bearerAbsent: true,
    });
  });
});
