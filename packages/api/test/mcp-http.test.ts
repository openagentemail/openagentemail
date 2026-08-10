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
  test('admin key：tools/list 返回全部 15 工具', async () => {
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
      'task_get',
      'task_list',
      'task_update',
    ].sort());
  });

  test('identity token：tools/list 同样返回 15 工具', async () => {
    const { token } = createIdentity({ localpart: 'mcp-list-id' })!;
    const res = await mcpRequest(token, 'tools/list');
    expect(res.status).toBe(200);
    const body = (await readMcpJson(res)) as {
      result?: { tools?: unknown[] };
    };
    expect(body.result?.tools?.length).toBe(15);
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
