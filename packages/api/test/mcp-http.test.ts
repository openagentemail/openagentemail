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

const { describe, expect, test: bunTest, mock, spyOn } = await import('bun:test');
// #357 R1：合法大件 mail_send 须 SMTP 成功才能断到 queued（与 send.test 同款 mock）
const sendMailMock = mock(async () => ({ messageId: '<sdk21-r1@test.example>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail: sendMailMock }));
const { createApp } = await import('../src/app.ts');
const { ApiError, OpenAgentEmailClient } = await import('../src/mcp/client.ts');
// #355-B：直测误包守卫。导出仅供该测试，生产调用点仍传 raw shape。
const { asStrictInput } = await import('../src/mcp/tools.ts');
const { z } = await import('zod');
const { createIdentity, findIdentity } = await import('../src/lib/identities.ts');
const {
  acquireWaitSlot,
  releaseWaitSlot,
  listMessagesCallerKey,
  listMessagesHasBucketForTests,
  markSeenHasBucketForTests,
} = await import('../src/lib/ratelimit.ts');
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
const {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} = await import('@modelcontextprotocol/server');
const { putAccessTokenForTests, resetOAuthStoreCacheForTests } = await import(
  '../src/lib/oauth-store.ts'
);
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
      // 根 README 现改为工具参考链接；完整签名落在 packages/mcp/README.md
      rootCreate: rootReadme.includes('(packages/mcp/README.md#tools)'),
      // 目标侧：mcp README 须保留能生成 #tools 锚点的标题（防指向漂、目标删）
      toolsAnchor: /^##\s+Tools\s*$/m.test(packageReadme),
      packageCreate: packageReadme.includes('task_create(to, subject, body?, kind?, approval?, wait?, parentTaskId?)'),
      listChildren: rootReadme.includes('(packages/mcp/README.md#tools)')
        && packageReadme.includes('task_list_children(parentTaskId, limit?, cursor?)'),
      typedApproval: /approval.*action.*expiresAt|kind.*approval/s.test(docs),
      decide: docs.includes('task_decide'),
      securityToolCount: /25\s+tools/i.test(security),
      readChildren: /read[^\n]*task_list_children|task_list_children[^\n]*read/i.test(security),
      containedDecision: /contained[^\n]*task_decide|task_decide[^\n]*contained/i.test(security),
    }).toEqual({
      rootCreate: true,
      toolsAnchor: true,
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
      // 根 README 只保留工具参考链接；租约签名在 MCP README
      rootSignatures: rootReadme.includes('(packages/mcp/README.md#tools)'),
      packageSignatures: signatures.every((signature) => packageReadme.includes(signature)),
      optInDefaultDisabled: /TASK_LEASES_ENABLED[\s\S]{0,160}(default|默认)[\s\S]{0,80}(false|关闭)|(?:default|默认)[\s\S]{0,80}(false|关闭)[\s\S]{0,160}TASK_LEASES_ENABLED/i.test(docs),
      // #251 保密句迁到 MCP README 并改为 "opaque bearer is never listed..."；保留原 leaseToken 邻近断言并兼容新文案
      bearerSecrecy: /leaseToken[\s\S]{0,160}(never|only|仅|不)[\s\S]{0,160}(bearer|token)|(?:bearer|token)[\s\S]{0,160}(never|only|仅|不)[\s\S]{0,160}leaseToken|opaque\s+bearer[\s\S]{0,80}never[\s\S]{0,80}(listed|rendered|logged)/i.test(docs),
      securityTwentyFiveTools: /25\s+tools/i.test(security),
      securityContainedLeases: ['task_claim', 'task_renew', 'task_release'].every((tool) => new RegExp(`contained[^\\n]*${tool}|${tool}[^\\n]*contained`, 'i').test(security)),
    }).toEqual({
      rootSignatures: true,
      packageSignatures: true,
      optInDefaultDisabled: true,
      bearerSecrecy: true,
      securityTwentyFiveTools: true,
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
      'mail_webhook_create',
      'mail_webhook_delete',
      'mail_webhook_disable',
      'mail_webhook_list',
      'mail_webhook_test',
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
    expect(body.result?.tools?.length).toBe(25);
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
    const prevNtfy = config.ntfy.enabled;
    const prevHadLocalhost = config.allDomains.has('localhost');
    const prevHadDotted = config.allDomains.has('example.com.');
    (config.ntfy as { enabled: boolean }).enabled = false;
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
      (config.ntfy as { enabled: boolean }).enabled = prevNtfy;
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

  test('#75 tools/list 广播 task 层含可选 expiryProjection，且 additionalProperties=false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; outputSchema?: JsonSchema }> };
    };
    for (const name of ['task_list', 'task_get'] as const) {
      const tool = body.result?.tools?.find((t) => t.name === name);
      expect(tool, `missing tool ${name}`).toBeTruthy();
      const root = tool?.outputSchema as JsonSchema;
      const taskSchema = name === 'task_list' ? root.properties?.tasks?.items ?? {} : root;
      expect(taskSchema.additionalProperties).toBe(false);
      expect(taskSchema.properties).toHaveProperty('expiryProjection');
    }
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
      listChildren: async (query, viewer) => {
        listChildrenCalls += 1;
        seen = { query, viewer };
        // parent ACL 只由这一次 listChildren 裁定，不再先读 getForAuthorization。
        if (rejectParent) throw new Error('forbidden');
        return { children: [child], nextCursor: 'opaque-next' };
      },
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
    expect(deniedText).not.toContain('zod'); expect(deniedText).not.toContain('schema'); expect(deniedText).not.toContain('stack'); expect(listChildrenCalls).toBe(2);
    for (const [id, invalidParent] of [
      [882, '018f8d1d-4d7e-7b0a-8000-000000000000'],
      [883, '018f8d1d-4d7e-8b0a-8000-000000000000'],
    ] as const) {
      const invalid = await call({ parentTaskId: invalidParent, limit: 20 }, id);
      expect(invalid.status).toBe(200);
      expect((await readMcpJson(invalid) as { result?: { isError?: boolean } }).result?.isError).toBe(true);
      expect(listChildrenCalls).toBe(2);
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


/** #324：mail_send inputSchema.strict()——未知键工具报错且不发信 */
describe('MCP mail_send 未知键拒绝（#324）', () => {
  test('tools/list 广告 mail_send additionalProperties:false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { additionalProperties?: boolean } }> };
    };
    const tool = body.result?.tools?.find((t) => t.name === 'mail_send');
    expect(tool, 'missing mail_send').toBeTruthy();
    expect(tool?.inputSchema?.additionalProperties).toBe(false);
  });

  test('mail_send 带 attachments → 工具报错且信件不发出', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp-strict-att' })!;
    const res = await mcpRequest(token, 'tools/call', {
      name: 'mail_send',
      arguments: {
        from: identity.address,
        to: 'recipient@example.net',
        subject: 'hello',
        text: 'body',
        attachments: [{ filename: 'a.txt', content: 'aGVsbG8=', encoding: 'base64' }],
      },
    });
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
    };
    const text = JSON.stringify(body);
    // SDK 校验失败：JSON-RPC error 或 isError；绝非 queued 成功
    expect(body.error || body.result?.isError).toBeTruthy();
    expect(body.result?.structuredContent?.queued).toBeUndefined();
    expect(text).not.toContain('"queued":true');
    // 须为输入校验失败，而非静默剥键后走到 SMTP
    expect(text).not.toMatch(/smtp_error/i);
    expect(/unrecognized|invalid (input|argument)|-32602|attachments/i.test(text)).toBe(true);
  });
});

/**
 * #355-A：六个邮件工具拒绝未知键。负控必须是输入校验失败，
 * 并用身份库 / 列表限速桶 / 标已读限速桶 / 等待槽占满后的响应证明确实没进 API。
 */
describe('MCP 邮件六工具未知键拒绝（#355-A）', () => {
  const MAIL_TOOL_NAMES = [
    'mail_new_identity',
    'mail_list_identities',
    'mail_list_messages',
    'mail_read_message',
    'mail_mark_seen',
    'mail_wait_for',
  ] as const;

  function isInputRejection(text: string): boolean {
    return /unrecognized|invalid (input|argument)|-32602/i.test(text);
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>, id = 1) {
    const res = await mcpRequest(token, 'tools/call', { name, arguments: args }, id);
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
    return { body, text: JSON.stringify(body) };
  }

  /**
   * #355-A R1：监听原型上的 readMessage。finally 还原，避免后续用例吃到同一只 spy。
   * 调用记录不含 this，只有 (address, id)。
   */
  async function withReadSpy(work: (calls: () => unknown[][]) => Promise<void>): Promise<void> {
    const spy = spyOn(OpenAgentEmailClient.prototype, 'readMessage');
    try {
      await work(() => spy.mock.calls as unknown[][]);
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * 占满该身份自己的等待槽。caller 与信箱相同时槽键相同，
   * 先撞上每槽 3 个的上限；释放时只还这 3 个。
   */
  function fillOwnWaitSlots(address: string): () => void {
    for (let i = 0; i < 3; i++) {
      expect(acquireWaitSlot(address, address)).toBe(true);
    }
    return () => {
      for (let i = 0; i < 3; i++) releaseWaitSlot(address, address);
    };
  }

  test('#355-A tools/list 六工具逐一广告 additionalProperties:false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { additionalProperties?: boolean } }> };
    };
    for (const name of MAIL_TOOL_NAMES) {
      const tool = body.result?.tools?.find((item) => item.name === name);
      expect(tool, `missing ${name}`).toBeTruthy();
      expect(tool?.inputSchema?.additionalProperties, name).toBe(false);
    }
  });

  test('#355-A mail_new_identity 未知键 local_part 不创建身份', async () => {
    const localpart = 'mcp355-new-reject';
    const address = `${localpart}@test.example`;
    const { body, text } = await callTool(adminKey, 'mail_new_identity', {
      localpart,
      local_part: 'should-not-apply',
    });
    expect(body.error || body.result?.isError, text).toBeTruthy();
    expect(isInputRejection(text), text).toBe(true);
    expect(text).not.toMatch(/API error|forbidden|insufficient_scope/i);
    expect(body.result?.structuredContent?.address).toBeUndefined();
    expect(body.result?.structuredContent?.token).toBeUndefined();
    // 若静默剥键，admin 会把这个 localpart 写进身份库。
    expect(findIdentity(address)).toBeUndefined();
  });

  test('#355-A mail_list_identities 仅未知键时不返回身份列表', async () => {
    const sentinel = createIdentity({ localpart: 'mcp355-list-id-sentinel' })!;
    const { body, text } = await callTool(adminKey, 'mail_list_identities', { verbose: true });
    expect(body.error || body.result?.isError, text).toBeTruthy();
    expect(isInputRejection(text), text).toBe(true);
    expect(body.result?.structuredContent?.identities).toBeUndefined();
    // 工具若真的列出了身份，响应里一定带有刚创建的地址。
    expect(text).not.toContain(sentinel.identity.address);
  });

  test('#355-A mail_list_messages 未知键 limt 不进入列表 API', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-list-msg' })!;
    const bucket = listMessagesCallerKey({ kind: 'identity', address: identity.address });
    expect(listMessagesHasBucketForTests(bucket)).toBe(false);
    const { body, text } = await callTool(token, 'mail_list_messages', {
      address: identity.address,
      limit: 1,
      limt: 5,
    });
    expect(body.error || body.result?.isError, text).toBeTruthy();
    expect(isInputRejection(text), text).toBe(true);
    expect(body.result?.structuredContent?.messages).toBeUndefined();
    expect(text).not.toMatch(/API error|not_found|ECONNREFUSED|rate_limited/i);
    expect(listMessagesHasBucketForTests(bucket)).toBe(false);
  });

  test('#355-A R1 mail_read_message 未知键不调用 readMessage', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-read' })!;
    await withReadSpy(async (calls) => {
      const { body, text } = await callTool(token, 'mail_read_message', {
        address: identity.address,
        id: '1',
        messageId: '1',
      });
      // 未知键若被剥掉，会以合法 address/id 进入 client.readMessage。
      expect(calls()).toEqual([]);
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(body.result?.structuredContent?.text).toBeUndefined();
    });
  });

  test('#355-A mail_mark_seen 未知键 flag 不标已读', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-seen' })!;
    expect(markSeenHasBucketForTests(identity.address)).toBe(false);
    const { body, text } = await callTool(token, 'mail_mark_seen', {
      address: identity.address,
      id: '1',
      seen: true,
      flag: 'seen',
    });
    expect(body.error || body.result?.isError, text).toBeTruthy();
    expect(isInputRejection(text), text).toBe(true);
    expect(body.result?.structuredContent?.seen).toBeUndefined();
    expect(text).not.toMatch(/API error|not_found|ECONNREFUSED|rate_limited/i);
    expect(markSeenHasBucketForTests(identity.address)).toBe(false);
  });

  test('#355-A mail_wait_for 未知键 from 不占用等待', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-wait' })!;
    const release = fillOwnWaitSlots(identity.address);
    try {
      const { body, text } = await callTool(token, 'mail_wait_for', {
        address: identity.address,
        timeoutSec: 1,
        from: 'nobody@example.net',
      });
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(body.result?.structuredContent?.text).toBeUndefined();
      // 槽已满：若工具真的去等，路由会立刻 429，而不是输入校验错误。
      expect(text).not.toMatch(/too_many_waits|timeout|API error|ECONNREFUSED/i);
    } finally {
      release();
    }
  });

  test('#355-A mail_new_identity 与 mail_list_identities 合法调用仍成功', async () => {
    const created = await callTool(adminKey, 'mail_new_identity', { localpart: 'mcp355-new-ok' }, 21);
    expect(created.body.error).toBeUndefined();
    expect(created.body.result?.isError).toBeFalsy();
    expect(created.body.result?.structuredContent?.address).toBe('mcp355-new-ok@test.example');
    expect(findIdentity('mcp355-new-ok@test.example')).toBeDefined();

    const listed = await callTool(adminKey, 'mail_list_identities', {}, 22);
    expect(listed.body.error).toBeUndefined();
    expect(listed.body.result?.isError).toBeFalsy();
    const identities = listed.body.result?.structuredContent?.identities as Array<{ address?: string }> | undefined;
    expect(identities?.some((item) => item.address === 'mcp355-new-ok@test.example')).toBe(true);
  });

  test('#355-A mail_list_messages 合法入参通过校验并进入列表 API', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-list-ok' })!;
    const bucket = listMessagesCallerKey({ kind: 'identity', address: identity.address });
    const { text } = await callTool(token, 'mail_list_messages', {
      address: identity.address,
      limit: 1,
    }, 23);
    expect(isInputRejection(text)).toBe(false);
    // 列表路由在碰 IMAP 之前写 caller 桶；桶出现即表示合法入参已执行。
    expect(listMessagesHasBucketForTests(bucket)).toBe(true);
  });

  test('#355-A R1 mail_read_message 合法入参会调用 readMessage', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-read-ok' })!;
    await withReadSpy(async (calls) => {
      const { text } = await callTool(token, 'mail_read_message', {
        address: identity.address,
        id: '1',
      }, 24);
      expect(isInputRejection(text)).toBe(false);
      expect(calls()).toEqual([[identity.address, '1']]);
    });
  });

  test('#355-A mail_mark_seen 合法入参通过校验并进入标已读 API', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-seen-ok' })!;
    const { text } = await callTool(token, 'mail_mark_seen', {
      address: identity.address,
      id: '1',
      seen: false,
    }, 25);
    expect(isInputRejection(text)).toBe(false);
    expect(markSeenHasBucketForTests(identity.address)).toBe(true);
  });

  test('#355-A mail_wait_for 合法入参通过校验并进入等待 API', async () => {
    const { token, identity } = createIdentity({ localpart: 'mcp355-wait-ok' })!;
    const release = fillOwnWaitSlots(identity.address);
    try {
      const { text } = await callTool(token, 'mail_wait_for', {
        address: identity.address,
        timeoutSec: 1,
      }, 26);
      expect(isInputRejection(text)).toBe(false);
      expect(text).toMatch(/too_many_waits/);
    } finally {
      release();
    }
  });
});

/**
 * #355-B：notify 四工具拒绝未知键。负控必须是输入校验失败，
 * 并用 client spy 证明未进入 notifyUser / notifyAgent / notificationCheck / verifyNotifications。
 * 不能用权限拒绝、非法业务字段或通知发送失败代替 strict 负控。
 */
describe('MCP notify 四工具未知键拒绝（#355-B）', () => {
  const NOTIFY_TOOL_NAMES = [
    'notify_user',
    'notify_agent',
    'notify_check',
    'notify_verify',
  ] as const;

  function isInputRejection(text: string): boolean {
    return /unrecognized|invalid (input|argument)|-32602/i.test(text);
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>, id = 1) {
    const res = await mcpRequest(token, 'tools/call', { name, arguments: args }, id);
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
    return { body, text: JSON.stringify(body) };
  }

  /**
   * #355-B R1：替换原型方法，只记参数，不透传真实通知。
   * fake 对齐 client 返回值与 outputSchema；finally 还原。
   */
  async function withNotifySpy(
    method: 'notifyUser' | 'notifyAgent' | 'notificationCheck' | 'verifyNotifications',
    work: (calls: () => unknown[][]) => Promise<void>,
  ): Promise<void> {
    const spy = spyOn(OpenAgentEmailClient.prototype, method);
    // 绑在 spy 上替换实现；拆出函数再调用会丢掉 this。
    const install = spy.mockImplementation.bind(spy) as (
      fn: (...args: unknown[]) => Promise<unknown>,
    ) => void;
    install((...args: unknown[]) => {
      if (method === 'notifyUser') {
        const title = args[0] as string;
        const level = args[2] as 'urgent' | 'normal' | 'low';
        return Promise.resolve({ target: 'user', title, level });
      }
      if (method === 'notifyAgent') {
        const name = args[0] as string;
        const title = args[1] as string;
        const level = args[3] as 'urgent' | 'normal' | 'low';
        return Promise.resolve({ target: `agent:${name}`, title, level });
      }
      if (method === 'notificationCheck') {
        return Promise.resolve([{
          id: 'ntf-355b',
          time: 1,
          title: 'wake',
          message: 'body',
          priority: 3,
          tags: ['ops'],
        }]);
      }
      return Promise.resolve({ ok: true });
    });
    try {
      await work(() => spy.mock.calls as unknown[][]);
    } finally {
      spy.mockRestore();
    }
  }

  /** 正控：非工具错误，且 structuredContent 就是 fake 流经 handler 的结果。 */
  function expectFake(
    body: { error?: unknown; result?: { isError?: boolean; structuredContent?: Record<string, unknown> } },
    expected: Record<string, unknown>,
  ) {
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toEqual(expected);
  }

  test('#355-B tools/list 四工具逐一广告 additionalProperties:false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: Array<{ name: string; inputSchema?: { additionalProperties?: boolean } }> };
    };
    for (const name of NOTIFY_TOOL_NAMES) {
      const tool = body.result?.tools?.find((item) => item.name === name);
      expect(tool, `missing ${name}`).toBeTruthy();
      expect(tool?.inputSchema?.additionalProperties, name).toBe(false);
    }
  });

  test('#355-B 误包守卫 asStrictInput 故意传入 ZodObject', () => {
    // 旧实现不抛的红证是守卫加入前对真实导出的实测，不在此复制旧函数体。
    const miswrapped = z.object({ title: z.string() });
    expect(() => asStrictInput(miswrapped as never)).toThrow(
      'asStrictInput: refusing ZodObject; pass a raw shape',
    );
  });

  test('#355-B notify_user 未知键不调用 notifyUser', async () => {
    await withNotifySpy('notifyUser', async (calls) => {
      const { body, text } = await callTool(adminKey, 'notify_user', {
        title: 'wake',
        message: 'body',
        unexpected: true,
      });
      expect(calls(), text).toEqual([]);
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(text).not.toMatch(/forbidden|can_notify_user|notifications_disabled/i);
    });
  });

  test('#355-B notify_agent 未知键不调用 notifyAgent', async () => {
    const { identity } = createIdentity({ localpart: 'mcp355b-agent-reject' })!;
    await withNotifySpy('notifyAgent', async (calls) => {
      const { body, text } = await callTool(adminKey, 'notify_agent', {
        name: identity.address,
        title: 'wake',
        message: 'body',
        unexpected: true,
      });
      expect(calls(), text).toEqual([]);
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(text).not.toMatch(/forbidden|can_notify_user|notifications_disabled|unknown_agent/i);
    });
  });

  test('#355-B notify_check 未知键不调用 notificationCheck', async () => {
    await withNotifySpy('notificationCheck', async (calls) => {
      // since 可选，无必填。负控只附一个未知键，避免用非法 since 凑拒绝。
      const { body, text } = await callTool(adminKey, 'notify_check', { unexpected: true });
      expect(calls(), text).toEqual([]);
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(text).not.toMatch(/forbidden|notifications_disabled|API error/i);
    });
  });

  test('#355-B notify_verify 仅未知键不调用 verifyNotifications', async () => {
    await withNotifySpy('verifyNotifications', async (calls) => {
      const { body, text } = await callTool(adminKey, 'notify_verify', { unexpected: true });
      expect(calls(), text).toEqual([]);
      expect(body.error || body.result?.isError, text).toBeTruthy();
      expect(isInputRejection(text), text).toBe(true);
      expect(text).not.toMatch(/forbidden|can_notify_user|notifications_disabled/i);
    });
  });

  test('#355-B notify_user 合法入参调用 notifyUser 且 level 默认 normal', async () => {
    await withNotifySpy('notifyUser', async (calls) => {
      const plain = await callTool(adminKey, 'notify_user', { title: 'wake', message: 'body' }, 41);
      expect(isInputRejection(plain.text), plain.text).toBe(false);
      expectFake(plain.body, { target: 'user', title: 'wake', level: 'normal' });
      const tagged = await callTool(adminKey, 'notify_user', {
        title: 'wake',
        message: 'body',
        level: 'urgent',
        tags: ['ops'],
      }, 42);
      expect(isInputRejection(tagged.text), tagged.text).toBe(false);
      expectFake(tagged.body, { target: 'user', title: 'wake', level: 'urgent' });
      expect(calls()).toEqual([
        ['wake', 'body', 'normal', undefined],
        ['wake', 'body', 'urgent', ['ops']],
      ]);
    });
  });

  test('#355-B notify_agent 合法全地址与裸 localpart 都进入 notifyAgent', async () => {
    const { identity } = createIdentity({ localpart: 'mcp355b-agent-ok' })!;
    await withNotifySpy('notifyAgent', async (calls) => {
      const full = await callTool(adminKey, 'notify_agent', {
        name: identity.address,
        title: 'wake',
        message: 'body',
      }, 43);
      expect(isInputRejection(full.text), full.text).toBe(false);
      expectFake(full.body, { target: `agent:${identity.address}`, title: 'wake', level: 'normal' });
      const bare = await callTool(adminKey, 'notify_agent', {
        name: 'mcp355b-agent-ok',
        title: 'wake',
        message: 'body',
      }, 44);
      expect(isInputRejection(bare.text), bare.text).toBe(false);
      expectFake(bare.body, { target: 'agent:mcp355b-agent-ok', title: 'wake', level: 'normal' });
      expect(calls()).toEqual([
        [identity.address, 'wake', 'body', 'normal', undefined],
        ['mcp355b-agent-ok', 'wake', 'body', 'normal', undefined],
      ]);
    });
  });

  test('#355-B notify_check 合法 since 调用 notificationCheck', async () => {
    await withNotifySpy('notificationCheck', async (calls) => {
      const checkOut = {
        messages: [{ id: 'ntf-355b', time: 1, title: 'wake', message: 'body', priority: 3, tags: ['ops'] }],
      };
      const filtered = await callTool(adminKey, 'notify_check', { since: '1h' }, 45);
      expect(isInputRejection(filtered.text), filtered.text).toBe(false);
      expectFake(filtered.body, checkOut);
      const empty = await callTool(adminKey, 'notify_check', {}, 46);
      expect(isInputRejection(empty.text), empty.text).toBe(false);
      expectFake(empty.body, checkOut);
      expect(calls()).toEqual([['1h'], [undefined]]);
    });
  });

  test('#355-B notify_verify 空对象调用 verifyNotifications', async () => {
    await withNotifySpy('verifyNotifications', async (calls) => {
      const verified = await callTool(adminKey, 'notify_verify', {}, 47);
      expect(isInputRejection(verified.text), verified.text).toBe(false);
      expectFake(verified.body, { ok: true });
      expect(calls()).toEqual([[]]);
    });
  });
});

/**
 * #355-C：task 九工具外层拒绝未知键。
 * 负控是输入校验失败，且对应 client 方法零调用。
 * 正控只打原型 fake，不透传真实 task 后端；finally 还原，避免套件泄漏。
 * 内层 approval 原有 strict 不算外层证据。leaseToken 省略仍是合法可选字段。
 */
describe('MCP task 九工具未知键拒绝（#355-C）', () => {
  const TASK_ID = 'f0c4a8e6-1e22-4c66-8c2f-0955a20d81bf';
  const PARENT_ID = 'a1b2c3d4-e5f6-4780-8bcd-ef1234567890';
  const FROM = 'alpha@test.example';
  const TO = 'bravo@test.example';
  const EXPIRES = '2030-08-25T00:00:00.000Z';
  const ACTION = { type: 'deployment', name: 'publish-preview', arguments: { dryRun: true } };
  const TASK_METHODS = [
    'createTask',
    'createApprovalTask',
    'listTaskChildren',
    'listTasks',
    'getTask',
    'updateTask',
    'decideTask',
    'claimTask',
    'renewTask',
    'releaseTask',
  ] as const;
  type TaskMethod = typeof TASK_METHODS[number];

  const TASK_OUTPUT_KEYS = [
    'id', 'from', 'to', 'subject', 'state', 'createdAt', 'updatedAt', 'parentTaskId',
    'messages', 'result', 'kind', 'approval', 'claimedUntil', 'leaseGeneration',
    'leaseStatus', 'expiryProjection',
  ];

  function fakeTask(patch: Record<string, unknown> = {}) {
    return {
      id: TASK_ID,
      from: FROM,
      to: TO,
      subject: 'wake',
      state: 'submitted',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      messages: [],
      ...patch,
    };
  }

  const approvalTask = () => fakeTask({
    state: 'input-required',
    kind: 'approval',
    approval: {
      action: ACTION,
      reviewer: FROM,
      expiresAt: EXPIRES,
      digest: 'a'.repeat(64),
    },
  });

  /** fake 返回值对齐 handler 入参后的 outputSchema，不访问网络。 */
  function fakeFor(method: TaskMethod): unknown {
    if (method === 'listTasks') return [fakeTask()];
    if (method === 'listTaskChildren') return { children: [fakeTask()], nextCursor: null };
    if (method === 'claimTask') {
      return {
        task: fakeTask({ state: 'working' }),
        leaseToken: 'opaque-lease',
        claimedUntil: '2026-08-24T00:05:00.000Z',
        leaseGeneration: 1,
      };
    }
    if (method === 'createApprovalTask') return approvalTask();
    if (method === 'decideTask') return fakeTask({ state: 'completed', result: { decision: 'approved' } });
    return fakeTask();
  }

  /** handler 包装后的 structuredContent。listTasks 在工具层收成 { tasks }。 */
  function structuredFor(method: TaskMethod): Record<string, unknown> {
    if (method === 'listTasks') return { tasks: fakeFor('listTasks') as unknown[] };
    return fakeFor(method) as Record<string, unknown>;
  }

  function isInputRejection(text: string): boolean {
    return /unrecognized|invalid (input|argument)|-32602/i.test(text);
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>, id = 1) {
    const res = await mcpRequest(token, 'tools/call', { name, arguments: args }, id);
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      error?: { code?: number; message?: string };
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
    };
    return { body, text: JSON.stringify(body) };
  }

  /**
   * 替换九个 task client 方法。实现不调用原函数，因此不会打到 dogfood 任务后端。
   * finally 逐个 mockRestore。
   */
  async function withTaskFakes(
    work: (calls: (method: TaskMethod) => unknown[][]) => Promise<void>,
    overrides?: Partial<Record<TaskMethod, (...args: unknown[]) => Promise<unknown>>>,
  ): Promise<void> {
    const spies = TASK_METHODS.map((method) => {
      const spy = spyOn(OpenAgentEmailClient.prototype, method);
      const install = spy.mockImplementation.bind(spy) as (
        fn: (...args: unknown[]) => Promise<unknown>,
      ) => void;
      install((...args: unknown[]) => {
        const custom = overrides?.[method];
        if (custom) return custom(...args);
        return Promise.resolve(fakeFor(method));
      });
      return [method, spy] as const;
    });
    try {
      await work((method) => {
        const found = spies.find(([name]) => name === method);
        return (found?.[1].mock.calls ?? []) as unknown[][];
      });
    } finally {
      for (const [, spy] of spies) spy.mockRestore();
    }
  }

  function expectFake(
    body: { error?: unknown; result?: { isError?: boolean; structuredContent?: Record<string, unknown> } },
    expected: Record<string, unknown>,
  ) {
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeFalsy();
    expect(body.result?.structuredContent).toEqual(expected);
  }

  async function expectUnknownKeyRejected(
    calls: (method: TaskMethod) => unknown[][],
    method: TaskMethod,
    name: string,
    args: Record<string, unknown>,
    id: number,
  ) {
    const { body, text } = await callTool(adminKey, name, args, id);
    expect(calls(method), text).toEqual([]);
    expect(body.error || body.result?.isError, text).toBeTruthy();
    expect(isInputRejection(text), text).toBe(true);
    expect(text, text).toMatch(/unexpected/);
    expect(text).not.toMatch(/API error|forbidden|task_lease_required|ECONNREFUSED|task_already_terminal/i);
    expect(body.result?.structuredContent).toBeUndefined();
  }

  test('#355-C tools/list 九工具逐一广告 additionalProperties:false', async () => {
    const res = await mcpRequest(adminKey, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: {
        tools?: Array<{
          name: string;
          inputSchema?: {
            additionalProperties?: boolean;
            required?: string[];
            properties?: Record<string, { description?: string }>;
          };
          outputSchema?: { properties?: Record<string, { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } }> };
        }>;
      };
    };
    const advertised: Array<{
      name: string;
      required: string[];
      properties: string[];
      output: string[];
      description?: [string, string];
    }> = [
      {
        name: 'task_create',
        required: ['to', 'subject'],
        properties: ['to', 'subject', 'body', 'kind', 'approval', 'wait', 'parentTaskId'],
        output: TASK_OUTPUT_KEYS,
        description: ['to', 'Managed recipient identity address'],
      },
      {
        name: 'task_list_children',
        required: ['parentTaskId'],
        properties: ['parentTaskId', 'limit', 'cursor'],
        output: ['children', 'nextCursor'],
        description: ['parentTaskId', 'Readable parent task UUID'],
      },
      {
        name: 'task_list',
        required: [],
        properties: ['state'],
        output: ['tasks'],
        description: ['state', 'Optional current state filter'],
      },
      {
        name: 'task_get',
        required: ['id'],
        properties: ['id', 'wait'],
        output: TASK_OUTPUT_KEYS,
        description: ['id', 'Task UUID from task_create or task_list'],
      },
      {
        name: 'task_update',
        required: ['id', 'state'],
        properties: ['id', 'state', 'body', 'result', 'leaseToken'],
        output: TASK_OUTPUT_KEYS,
        description: ['leaseToken', 'Optional opaque current lease token'],
      },
      {
        name: 'task_decide',
        required: ['id', 'decision'],
        properties: ['id', 'decision'],
        output: TASK_OUTPUT_KEYS,
        description: ['id', 'Approval task UUID'],
      },
      {
        name: 'task_claim',
        required: ['id'],
        properties: ['id', 'leaseSec'],
        output: ['task', 'leaseToken', 'claimedUntil', 'leaseGeneration'],
        description: ['leaseSec', 'Lease duration in seconds (30..3600; default 300)'],
      },
      {
        name: 'task_renew',
        required: ['id', 'leaseToken'],
        properties: ['id', 'leaseToken', 'leaseSec'],
        output: TASK_OUTPUT_KEYS,
        description: ['leaseToken', 'Opaque current lease token'],
      },
      {
        name: 'task_release',
        required: ['id', 'leaseToken'],
        properties: ['id', 'leaseToken', 'reason'],
        output: TASK_OUTPUT_KEYS,
        description: ['reason', 'Optional release reason'],
      },
    ];
    for (const item of advertised) {
      const tool = body.result?.tools?.find((entry) => entry.name === item.name);
      expect(tool, `missing ${item.name}`).toBeTruthy();
      expect(tool?.inputSchema?.additionalProperties, item.name).toBe(false);
      expect(tool?.inputSchema?.required ?? [], item.name).toEqual(item.required);
      expect(Object.keys(tool?.inputSchema?.properties ?? {}).sort(), item.name).toEqual([...item.properties].sort());
      expect(Object.keys(tool?.outputSchema?.properties ?? {}).sort(), item.name).toEqual([...item.output].sort());
      if (item.description) {
        const [field, text] = item.description;
        expect(tool?.inputSchema?.properties?.[field]?.description, `${item.name}.${field}`).toBe(text);
      }
      if (item.name === 'task_list') {
        const nested = tool?.outputSchema?.properties?.tasks?.items?.properties;
        expect(Object.keys(nested ?? {}).sort()).toEqual([...TASK_OUTPUT_KEYS].sort());
      }
    }
  });

  test('#355-C task_create 普通分支外层未知键不调用 createTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'createTask', 'task_create', {
        to: TO, subject: 'wake', body: 'do the work', unexpected: true,
      }, 501);
      expect(calls('createApprovalTask')).toEqual([]);
    });
  });

  test('#355-C task_create approval 分支外层未知键不调用 createApprovalTask', async () => {
    await withTaskFakes(async (calls) => {
      // 未知键在外层。approval 内层保持合法，避免把内层 strict 当成外层证据。
      await expectUnknownKeyRejected(calls, 'createApprovalTask', 'task_create', {
        to: TO,
        subject: 'wake',
        kind: 'approval',
        approval: { action: ACTION, expiresAt: EXPIRES },
        unexpected: true,
      }, 502);
      expect(calls('createTask')).toEqual([]);
    });
  });

  test('#355-C task_list_children 未知键不调用 listTaskChildren', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'listTaskChildren', 'task_list_children', {
        parentTaskId: PARENT_ID, limit: 20, unexpected: true,
      }, 503);
    });
  });

  test('#355-C task_list 仅未知键不调用 listTasks', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'listTasks', 'task_list', { unexpected: true }, 504);
    });
  });

  test('#355-C task_get 未知键不调用 getTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'getTask', 'task_get', {
        id: TASK_ID, unexpected: true,
      }, 505);
    });
  });

  test('#355-C task_update 未知键不调用 updateTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'updateTask', 'task_update', {
        id: TASK_ID, state: 'working', unexpected: true,
      }, 506);
    });
  });

  test('#355-C task_decide 未知键不调用 decideTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'decideTask', 'task_decide', {
        id: TASK_ID, decision: 'approved', unexpected: true,
      }, 507);
    });
  });

  test('#355-C task_claim 未知键不调用 claimTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'claimTask', 'task_claim', {
        id: TASK_ID, unexpected: true,
      }, 508);
    });
  });

  test('#355-C task_renew 未知键不调用 renewTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'renewTask', 'task_renew', {
        id: TASK_ID, leaseToken: 'opaque-lease', unexpected: true,
      }, 509);
    });
  });

  test('#355-C task_release 未知键不调用 releaseTask', async () => {
    await withTaskFakes(async (calls) => {
      await expectUnknownKeyRejected(calls, 'releaseTask', 'task_release', {
        id: TASK_ID, leaseToken: 'opaque-lease', unexpected: true,
      }, 510);
    });
  });

  test('#355-C task_create 普通调用保留 wait 缺省与 parentTaskId 省略/传递', async () => {
    await withTaskFakes(async (calls) => {
      const plain = await callTool(adminKey, 'task_create', {
        to: TO, subject: 'wake', body: 'do the work',
      }, 521);
      expect(isInputRejection(plain.text), plain.text).toBe(false);
      expectFake(plain.body, structuredFor('createTask'));
      const waited = await callTool(adminKey, 'task_create', {
        to: TO, subject: 'wake', body: 'do the work', wait: true, parentTaskId: PARENT_ID,
      }, 522);
      expect(isInputRejection(waited.text), waited.text).toBe(false);
      expectFake(waited.body, structuredFor('createTask'));
      expect(calls('createTask')).toEqual([
        [TO, 'wake', 'do the work', false, undefined],
        [TO, 'wake', 'do the work', true, PARENT_ID],
      ]);
      expect(calls('createApprovalTask')).toEqual([]);
    });
  });

  test('#355-C task_create approval 有/无 body，且 expiresAt 原样传递；缺 offset 不调用', async () => {
    await withTaskFakes(async (calls) => {
      const withBody = await callTool(adminKey, 'task_create', {
        to: TO,
        subject: 'wake',
        body: 'record only',
        kind: 'approval',
        approval: { action: ACTION, expiresAt: EXPIRES },
      }, 523);
      expect(isInputRejection(withBody.text), withBody.text).toBe(false);
      expectFake(withBody.body, structuredFor('createApprovalTask'));
      const noBody = await callTool(adminKey, 'task_create', {
        to: TO,
        subject: 'wake',
        kind: 'approval',
        wait: true,
        parentTaskId: PARENT_ID,
        approval: { action: ACTION, expiresAt: '2030-08-25T00:00:00.000+00:00' },
      }, 524);
      expect(isInputRejection(noBody.text), noBody.text).toBe(false);
      expectFake(noBody.body, structuredFor('createApprovalTask'));
      const missingOffset = await callTool(adminKey, 'task_create', {
        to: TO,
        subject: 'wake',
        kind: 'approval',
        approval: { action: ACTION, expiresAt: '2030-08-25T00:00:00' },
      }, 525);
      expect(calls('createApprovalTask'), missingOffset.text).toEqual([
        [TO, 'wake', ACTION, EXPIRES, 'record only', false, undefined],
        [TO, 'wake', ACTION, '2030-08-25T00:00:00.000+00:00', undefined, true, PARENT_ID],
      ]);
      expect(isInputRejection(missingOffset.text), missingOffset.text).toBe(true);
      expect(calls('createTask')).toEqual([]);
    });
  });

  test('#355-C task_create 非法分支不调用 client', async () => {
    await withTaskFakes(async (calls) => {
      const kindOnly = await callTool(adminKey, 'task_create', {
        to: TO, subject: 'wake', kind: 'approval',
      }, 526);
      const approvalOnly = await callTool(adminKey, 'task_create', {
        to: TO,
        subject: 'wake',
        body: 'do the work',
        approval: { action: ACTION, expiresAt: EXPIRES },
      }, 527);
      const noBody = await callTool(adminKey, 'task_create', {
        to: TO, subject: 'wake',
      }, 528);
      for (const item of [kindOnly, approvalOnly, noBody]) {
        expect(item.body.result?.isError, item.text).toBe(true);
        expect(item.text).toContain('approval task_create requires approval; ordinary task_create requires body');
        expect(isInputRejection(item.text)).toBe(false);
      }
      expect(calls('createTask')).toEqual([]);
      expect(calls('createApprovalTask')).toEqual([]);
    });
  });

  test('#355-C task_create 已创建后 ApiError 仍附带安全重试提示', async () => {
    await withTaskFakes(async (calls) => {
      const failed = await callTool(adminKey, 'task_create', {
        to: TO, subject: 'wake', body: 'do the work',
      }, 529);
      expect(calls('createTask')).toEqual([[TO, 'wake', 'do the work', false, undefined]]);
      expect(calls('createApprovalTask')).toEqual([]);
      expect(failed.body.result?.isError, failed.text).toBe(true);
      expect(failed.text).toContain(
        `wait_failed taskId=${TASK_ID}. Task already created — use task_get or task_list to check status; do not call task_create again.`,
      );
      expect(isInputRejection(failed.text)).toBe(false);
    }, {
      createTask: () => Promise.reject(new ApiError(502, 'wait_failed', { taskId: TASK_ID, kind: 'wait_failed' })),
    });
  });

  test('#355-C task_list_children 合法入参传给 listTaskChildren', async () => {
    await withTaskFakes(async (calls) => {
      const listed = await callTool(adminKey, 'task_list_children', {
        parentTaskId: PARENT_ID, limit: 50, cursor: 'opaque-input',
      }, 530);
      expect(isInputRejection(listed.text), listed.text).toBe(false);
      expectFake(listed.body, structuredFor('listTaskChildren'));
      expect(calls('listTaskChildren')).toEqual([[PARENT_ID, 50, 'opaque-input']]);
    });
  });

  test('#355-C task_list 空对象与 state 筛选都进入 listTasks', async () => {
    await withTaskFakes(async (calls) => {
      const all = await callTool(adminKey, 'task_list', {}, 531);
      expect(isInputRejection(all.text), all.text).toBe(false);
      expectFake(all.body, structuredFor('listTasks'));
      const filtered = await callTool(adminKey, 'task_list', { state: 'working' }, 532);
      expect(isInputRejection(filtered.text), filtered.text).toBe(false);
      expectFake(filtered.body, structuredFor('listTasks'));
      expect(calls('listTasks')).toEqual([[undefined], ['working']]);
    });
  });

  test('#355-C task_get 保留 wait 缺省 false 与显式 true', async () => {
    await withTaskFakes(async (calls) => {
      const plain = await callTool(adminKey, 'task_get', { id: TASK_ID }, 533);
      expect(isInputRejection(plain.text), plain.text).toBe(false);
      expectFake(plain.body, structuredFor('getTask'));
      const waited = await callTool(adminKey, 'task_get', { id: TASK_ID, wait: true }, 534);
      expect(isInputRejection(waited.text), waited.text).toBe(false);
      expectFake(waited.body, structuredFor('getTask'));
      expect(calls('getTask')).toEqual([[TASK_ID, false], [TASK_ID, true]]);
    });
  });

  test('#355-C task_update 传递 leaseToken，省略时不是未知键', async () => {
    await withTaskFakes(async (calls) => {
      const withToken = await callTool(adminKey, 'task_update', {
        id: TASK_ID, state: 'input-required', body: 'note', result: { ok: true }, leaseToken: 'opaque-lease',
      }, 535);
      expect(isInputRejection(withToken.text), withToken.text).toBe(false);
      expectFake(withToken.body, structuredFor('updateTask'));
      const omitted = await callTool(adminKey, 'task_update', {
        id: TASK_ID, state: 'working',
      }, 536);
      expect(isInputRejection(omitted.text), omitted.text).toBe(false);
      expectFake(omitted.body, structuredFor('updateTask'));
      expect(calls('updateTask')).toEqual([
        [TASK_ID, 'input-required', 'note', { ok: true }, 'opaque-lease'],
        [TASK_ID, 'working', undefined, undefined, undefined],
      ]);
    });
  });

  test('#355-C task_decide 合法决定进入 decideTask', async () => {
    await withTaskFakes(async (calls) => {
      const decided = await callTool(adminKey, 'task_decide', {
        id: TASK_ID, decision: 'rejected',
      }, 537);
      expect(isInputRejection(decided.text), decided.text).toBe(false);
      expectFake(decided.body, structuredFor('decideTask'));
      expect(calls('decideTask')).toEqual([[TASK_ID, 'rejected']]);
    });
  });

  test('#355-C task_claim 传递与省略 leaseSec', async () => {
    await withTaskFakes(async (calls) => {
      const claimed = await callTool(adminKey, 'task_claim', { id: TASK_ID, leaseSec: 120 }, 538);
      expect(isInputRejection(claimed.text), claimed.text).toBe(false);
      expectFake(claimed.body, structuredFor('claimTask'));
      const omitted = await callTool(adminKey, 'task_claim', { id: TASK_ID }, 539);
      expect(isInputRejection(omitted.text), omitted.text).toBe(false);
      expectFake(omitted.body, structuredFor('claimTask'));
      expect(calls('claimTask')).toEqual([[TASK_ID, 120], [TASK_ID, undefined]]);
    });
  });

  test('#355-C task_renew 必填 leaseToken，leaseSec 可省略', async () => {
    await withTaskFakes(async (calls) => {
      const renewed = await callTool(adminKey, 'task_renew', {
        id: TASK_ID, leaseToken: 'opaque-lease', leaseSec: 180,
      }, 540);
      expect(isInputRejection(renewed.text), renewed.text).toBe(false);
      expectFake(renewed.body, structuredFor('renewTask'));
      const omitted = await callTool(adminKey, 'task_renew', {
        id: TASK_ID, leaseToken: 'opaque-lease',
      }, 541);
      expect(isInputRejection(omitted.text), omitted.text).toBe(false);
      expectFake(omitted.body, structuredFor('renewTask'));
      expect(calls('renewTask')).toEqual([
        [TASK_ID, 'opaque-lease', 180],
        [TASK_ID, 'opaque-lease', undefined],
      ]);
    });
  });

  test('#355-C task_release 必填 leaseToken，reason 可省略', async () => {
    await withTaskFakes(async (calls) => {
      const released = await callTool(adminKey, 'task_release', {
        id: TASK_ID, leaseToken: 'opaque-lease', reason: 'handoff',
      }, 542);
      expect(isInputRejection(released.text), released.text).toBe(false);
      expectFake(released.body, structuredFor('releaseTask'));
      const omitted = await callTool(adminKey, 'task_release', {
        id: TASK_ID, leaseToken: 'opaque-lease',
      }, 543);
      expect(isInputRejection(omitted.text), omitted.text).toBe(false);
      expectFake(omitted.body, structuredFor('releaseTask'));
      expect(calls('releaseTask')).toEqual([
        [TASK_ID, 'opaque-lease', 'handoff'],
        [TASK_ID, 'opaque-lease', undefined],
      ]);
    });
  });
});

/**
 * #357：MCP SDK 2.1.0 边界钉版（断言以实测落）。未采用 scopeChallenge（tier 等价）；DPoP 未验证·未启用。
 */
describe('MCP SDK 2.1.0 边界（#357）', () => {
  const MiB = 1024 * 1024;
  const post = (token: string, body: string, extra: Record<string, string> = {}) =>
    app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: MCP_ACCEPT,
        ...extra,
      },
      body,
    });

  test('a: body >16MiB → request_too_large；CJK ~6MB 合法件 → queued', async () => {
    // 过限腿：命中我方 Hono bodyLimit（与 /v1 同形）；SDK 层 413 因 maxRequestBodySize=16MiB 不可达
    const overBody = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list',
      params: { pad: 'x'.repeat(16 * MiB + 1) },
    });
    expect(Buffer.byteLength(overBody)).toBeGreaterThan(16 * MiB);
    const over = await post(adminKey, overBody);
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: 'request_too_large' });

    // 合法大件腿：CJK 多字节（每字 3B）×2×~1M 字符 ≈ 6MB，落 (4MiB,16MiB]——证两门分裂已消
    sendMailMock.mockImplementation(async () => ({ messageId: '<sdk21-r2@test.example>' }));
    const { token, identity } = createIdentity({ localpart: 'sdk21-big' })!;
    const underBody = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'mail_send',
        arguments: {
          from: identity.address, to: 'sink@example.net', subject: 'big',
          text: '測'.repeat(999_999),
          html: 'あ'.repeat(999_999),
        },
      },
    });
    const underBytes = Buffer.byteLength(underBody);
    expect(underBytes).toBeGreaterThan(4 * MiB);
    expect(underBytes).toBeLessThanOrEqual(16 * MiB);
    const under = await post(token, underBody);
    expect(under.status).toBe(200);
    const underJson = (await readMcpJson(under)) as {
      error?: unknown;
      result?: { isError?: boolean; structuredContent?: { queued?: boolean } };
    };
    expect(underJson.error).toBeUndefined();
    expect(underJson.result?.isError).toBeFalsy();
    expect(underJson.result?.structuredContent?.queued).toBe(true);
  });

  test('b: modern-envelope 缺头/不一致头 → 400（实测 -32020）', async () => {
    const modernBody = JSON.stringify({
      jsonrpc: '2.0', id: 10, method: 'tools/list',
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'sdk21-hdr', version: '0.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    });
    const missing = await post(adminKey, modernBody);
    expect(missing.status).toBe(400);
    const missingJson = (await missing.json()) as { error?: { code?: number; message?: string } };
    expect(missingJson.error?.code).toBe(-32020);
    expect(missingJson.error?.message).toMatch(/MCP-Protocol-Version|absent|disagree/i);

    const mismatch = await post(adminKey, modernBody, { 'mcp-protocol-version': '2025-06-18' });
    expect(mismatch.status).toBe(400);
    const mismatchJson = (await mismatch.json()) as { error?: { code?: number; message?: string } };
    expect(mismatchJson.error?.code).toBe(-32020);
    expect(mismatchJson.error?.message).toMatch(/disagree|2026-07-28|2025-06-18/);
  });

  test('c: batch 数组仍 batch_not_supported（先行于 SDK cap 100）', async () => {
    const res = await post(
      adminKey,
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }]),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('batch_not_supported');
  });

  test('e: OAuth aud 不符 403 / critical 工具 OAuth 403 不变', async () => {
    // 声明：未采用 SDK scopeChallenge；critical→OAuth 403 由自有 tier 层等价覆盖
    resetOAuthStoreCacheForTests();
    const { identity } = createIdentity({ localpart: 'sdk21-oauth' })!;
    const badAud = 'sdk21-bad-aud-token-32bytes-pad!!';
    putAccessTokenForTests({
      token: badAud, grantId: 'g-sdk21-bad-aud', address: identity.address,
      aud: 'http://evil.example/mcp', expiresAt: Date.now() + 3_600_000,
      ensureGrant: { clientId: 'https://c.example', clientName: 'c' },
    });
    const audRes = await mcpRequest(badAud, 'tools/list');
    expect(audRes.status).toBe(403);
    expect(((await audRes.json()) as { error: string }).error).toBe('invalid_audience');

    const oauthTok = 'sdk21-good-aud-token-32bytes-pad!';
    putAccessTokenForTests({
      token: oauthTok, grantId: 'g-sdk21-good-aud', address: identity.address,
      aud: 'http://localhost/mcp', expiresAt: Date.now() + 3_600_000,
      ensureGrant: { clientId: 'https://c.example', clientName: 'c' },
    });
    const crit = await mcpRequest(oauthTok, 'tools/call', {
      name: 'mail_new_identity', arguments: { localpart: 'sdk21-deny' },
    });
    expect(crit.status).toBe(403);
    const critBody = (await crit.json()) as { error: string; tier?: string };
    expect(critBody.error).toBe('forbidden_tier');
    expect(critBody.tier).toBe('critical');
  });
});
