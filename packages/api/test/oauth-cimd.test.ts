/**
 * CIMD 校验器 + SSRF IP 判定单测（注入 fetcher，不起真 HTTP）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'x';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'x';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-oauth-cimd-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, test, beforeEach } = await import('bun:test');
const {
  assertClientIdHostSafe,
  clearCimdCacheForTests,
  fetchClientMetadata,
  isAllowedRedirectUri,
  isBlockedSsrfIp,
  isSsrfBlockedResolvedIp,
  matchRedirectUri,
  validateClientIdUrl,
} = await import('../src/lib/oauth-cimd.ts');

beforeEach(() => {
  clearCimdCacheForTests();
});

describe('isBlockedSsrfIp / 私网放行对照', () => {
  test('169.254.0.0/16 与 0.0.0.0/8 永拒', () => {
    expect(isBlockedSsrfIp('169.254.169.254')).toBe(true);
    expect(isBlockedSsrfIp('169.254.0.1')).toBe(true);
    expect(isBlockedSsrfIp('0.0.0.0')).toBe(true);
    expect(isBlockedSsrfIp('0.1.2.3')).toBe(true);
  });

  test('IPv4-mapped 十六进制形与 fe80 / fd00:ec2 永拒', async () => {
    const { ipv4MappedFromV6, isFe80LinkLocalIpv6, isAwsImdsIpv6 } = await import(
      '../src/lib/net.ts'
    );
    expect(ipv4MappedFromV6('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(isBlockedSsrfIp('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedSsrfIp('::ffff:169.254.169.254')).toBe(true);
    expect(isFe80LinkLocalIpv6('fe80::1')).toBe(true);
    expect(isFe80LinkLocalIpv6('febf::1')).toBe(true);
    expect(isFe80LinkLocalIpv6('fec0::1')).toBe(false);
    expect(isBlockedSsrfIp('fe80::1')).toBe(true);
    expect(isAwsImdsIpv6('fd00:ec2::254')).toBe(true);
    expect(isBlockedSsrfIp('fd00:ec2::254')).toBe(true);
  });

  test('RFC1918 / CGNAT / loopback 不在永拒清单（部署例外放行）', () => {
    expect(isBlockedSsrfIp('10.0.0.1')).toBe(false);
    expect(isBlockedSsrfIp('192.168.1.1')).toBe(false);
    expect(isBlockedSsrfIp('172.16.0.1')).toBe(false);
    expect(isBlockedSsrfIp('100.64.1.2')).toBe(false);
    expect(isBlockedSsrfIp('127.0.0.1')).toBe(false);
  });

  test('isSsrfBlockedResolvedIp：永拒仍 blocked；私网放行', () => {
    expect(isSsrfBlockedResolvedIp('169.254.169.254')).toBe(true);
    expect(isSsrfBlockedResolvedIp('0.0.0.0')).toBe(true);
    expect(isSsrfBlockedResolvedIp('10.1.2.3')).toBe(false);
    expect(isSsrfBlockedResolvedIp('127.0.0.1')).toBe(false);
    expect(isSsrfBlockedResolvedIp('8.8.8.8')).toBe(false);
  });
});

describe('validateClientIdUrl', () => {
  test('https + path 合法', () => {
    const r = validateClientIdUrl('https://client.example/oauth/client.json');
    expect(r.ok).toBe(true);
  });

  test('缺 path / 含 fragment / userinfo / query / 点段 拒', () => {
    expect(validateClientIdUrl('https://client.example/').ok).toBe(false);
    expect(validateClientIdUrl('https://client.example/a#x').ok).toBe(false);
    expect(validateClientIdUrl('https://u:p@client.example/a').ok).toBe(false);
    expect(validateClientIdUrl('https://client.example/a?x=1').ok).toBe(false);
    expect(validateClientIdUrl('https://client.example/./a').ok).toBe(false);
    expect(validateClientIdUrl('https://client.example/a/../b').ok).toBe(false);
  });

  test('loopback http 因部署例外放行', () => {
    expect(validateClientIdUrl('http://127.0.0.1:9/cimd.json').ok).toBe(true);
    expect(validateClientIdUrl('http://10.0.0.2/cimd.json').ok).toBe(true);
    expect(validateClientIdUrl('http://example.com/cimd.json').ok).toBe(false);
  });
});

describe('redirect_uri scheme 白名单', () => {
  test('https 一律放行；http loopback 放行', () => {
    expect(isAllowedRedirectUri('https://app.example/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:54321/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]/callback')).toBe(true);
  });

  test('javascript:/data:/file: 与 http 非 loopback 拒', () => {
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUri('data:text/html,hi')).toBe(false);
    expect(isAllowedRedirectUri('file:///etc/passwd')).toBe(false);
    expect(isAllowedRedirectUri('myapp://callback')).toBe(false);
    // http 仅 loopback：公网与 RFC1918 一律拒（私有 scheme 日后再开）
    expect(isAllowedRedirectUri('http://example.com/callback')).toBe(false);
    expect(isAllowedRedirectUri('http://10.0.0.1/callback')).toBe(false);
  });

  test('CIMD 文档含 javascript: redirect → 拒', async () => {
    const clientId = 'http://127.0.0.1:9/cimd.json';
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            client_id: clientId,
            client_name: 'Evil',
            redirect_uris: ['javascript:alert(document.domain)'],
            token_endpoint_auth_method: 'none',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('redirect_uri_scheme_forbidden');
  });

  test('CIMD https redirect 正常；http loopback 正常', async () => {
    const clientId = 'http://127.0.0.1:9/cimd-ok.json';
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            client_id: clientId,
            client_name: 'Ok',
            redirect_uris: [
              'https://app.example/oauth/cb',
              'http://127.0.0.1:9999/callback',
            ],
            token_endpoint_auth_method: 'none',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('matchRedirectUri RFC8252 端口放宽', () => {
  test('http + IP 字面量不同端口放行', () => {
    expect(
      matchRedirectUri('http://127.0.0.1:54321/callback', ['http://127.0.0.1/callback']),
    ).toBe(true);
  });

  test('localhost 主机名与 https 仍精确匹配端口', () => {
    expect(
      matchRedirectUri('http://localhost:9999/callback', ['http://localhost/callback']),
    ).toBe(false);
    expect(
      matchRedirectUri('https://127.0.0.1:54321/callback', ['https://127.0.0.1/callback']),
    ).toBe(false);
  });

  test('非 loopback 端口必须精确', () => {
    expect(
      matchRedirectUri('https://app.example:443/cb', ['https://app.example:8443/cb']),
    ).toBe(false);
  });

  test('javascript: 即使两侧相同也不匹配', () => {
    expect(
      matchRedirectUri('javascript:alert(1)', ['javascript:alert(1)']),
    ).toBe(false);
  });
});

describe('fetchClientMetadata（注入 fetcher）', () => {
  const clientId = 'http://127.0.0.1:9/cimd.json';

  test('200 + 合法文档', async () => {
    const doc = {
      client_id: clientId,
      client_name: 'Test Client',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    };
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(JSON.stringify(doc), {
          status: 200,
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' },
        }),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.client_name).toBe('Test Client');
  });

  test('重定向拒', async () => {
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(null, { status: 302, headers: { location: 'http://evil/' } }),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('redirect_forbidden');
  });

  test('client_id 逐字符不符拒', async () => {
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            client_id: 'http://127.0.0.1:9/OTHER.json',
            client_name: 'X',
            redirect_uris: ['http://127.0.0.1/callback'],
          }),
          { status: 200 },
        ),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('client_id_mismatch');
  });

  test('缺必填字段拒', async () => {
    const r = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(JSON.stringify({ client_id: clientId, client_name: 'X' }), {
          status: 200,
        }),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('missing_redirect_uris');
  });

  test('声明 client_secret* 仍拒；private_key_jwt 无 none 回退信号仍拒', async () => {
    const secret = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            client_id: clientId,
            client_name: 'X',
            redirect_uris: ['http://127.0.0.1/callback'],
            client_secret: 'nope',
          }),
          { status: 200 },
        ),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(secret.ok).toBe(false);

    const jwt = await fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(
          JSON.stringify({
            client_id: clientId,
            client_name: 'X',
            redirect_uris: ['http://127.0.0.1/callback'],
            token_endpoint_auth_method: 'private_key_jwt',
          }),
          { status: 200 },
        ),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(jwt.ok).toBe(false);
    if (!jwt.ok) expect(jwt.reason).toBe('auth_method_unsupported');
  });

  test('解析到 169.254 拒', async () => {
    const r = await assertClientIdHostSafe('metadata.local', async () => [
      { address: '169.254.169.254', family: 4 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ssrf_blocked_ip');
  });
});

/**
 * ChatGPT CIMD：singular 声明 private_key_jwt，但 plural 数组含 none 时可回退公共客户端。
 * 判定只看 token_endpoint_auth_methods_supported 是否为数组且含 'none'。
 */
describe('CIMD auth_method none 回退（ChatGPT 连接器）', () => {
  const clientId = 'http://127.0.0.1:9/cimd.json';

  async function fetchDoc(body: Record<string, unknown>) {
    return fetchClientMetadata(clientId, {
      fetcher: async () =>
        new Response(JSON.stringify({ client_id: clientId, ...body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
  }

  test('private_key_jwt + plural 含 none + jwks_uri → 按 none 放行', async () => {
    const r = await fetchDoc({
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector/oauth/callback'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      jwks_uri: 'https://chatgpt.com/oauth/connector/jwks.json',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.token_endpoint_auth_method).toBe('none');
  });

  test('纯 client_secret_basic 无 none 回退信号 → 仍拒', async () => {
    const r = await fetchDoc({
      client_name: 'Basic',
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('auth_method_unsupported');
  });

  test('plural 非数组等畸形 → 仍拒', async () => {
    const notArray = await fetchDoc({
      client_name: 'Malformed',
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: 'none',
    });
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.reason).toBe('auth_method_unsupported');

    const missingNone = await fetchDoc({
      client_name: 'JwtOnly',
      redirect_uris: ['https://app.example/cb'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
    });
    expect(missingNone.ok).toBe(false);
    if (!missingNone.ok) expect(missingNone.reason).toBe('auth_method_unsupported');
  });
});
