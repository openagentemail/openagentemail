/**
 * Pinned Fetcher + SSRF 收紧测试矩阵（RFC-0001 §14 item 2, §15 PR 1, D16, Q21=A）。
 *
 * 覆盖：
 * 1. SSRF 永拒范围（0.0.0.0/8, 169.254/16, fe80::/10, fd00:ec2::/16, ::, ff00::/8, Class E 240.0.0.0/4）
 * 2. IPv4-mapped IPv6（点分、十六进制、0: 前缀）
 * 3. NAT64 (64:ff9b::/96) 提取式评估（Unsafe 拒、公网放、私网按 publicEdge）
 * 4. 6to4 (2002::/16) 提取式评估（Unsafe 拒、公网放、私网按 publicEdge）
 * 5. Teredo (2001:0000::/32) 提取式评估（server/client 分别判定、client 按 XOR 取反）
 * 6. 十进制/八进制/十六进制/单整数 IPv4 变体
 * 7. DNS lookup 注入钉死与 DNS rebinding 防御（TOCTOU 消除）
 * 8. 3xx 重定向拒绝上移（redirect_forbidden 内置）
 * 9. publicEdge 组合双向
 * 10. 绝对墙钟死线（slowloris 与 TCP tarpit 截断）与 maxBytes 响应限流
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-pinned-fetch-'));
process.env.UI_ENABLED = 'false';

import http from 'node:http';
import net from 'node:net';
const { describe, expect, test } = await import('bun:test');

const {
  isBlockedSsrfIp,
  isSsrfBlockedResolvedIp,
  isPrivateOrLoopbackHostname,
  extractEmbeddedIpv4s,
} = await import('../src/lib/net.ts');
const {
  pinnedFetch,
} = await import('../src/lib/pinned-fetch.ts');
type DnsLookup = import('../src/lib/pinned-fetch.ts').DnsLookup;

describe('SSRF 策略纯函数：永拒与公私网判定', () => {
  test('永拒段：0.0.0.0/8 与 169.254.0.0/16', () => {
    expect(isBlockedSsrfIp('0.0.0.0')).toBe(true);
    expect(isBlockedSsrfIp('0.1.2.3')).toBe(true);
    expect(isBlockedSsrfIp('169.254.0.1')).toBe(true);
    expect(isBlockedSsrfIp('169.254.169.254')).toBe(true);

    expect(isSsrfBlockedResolvedIp('0.0.0.0')).toBe(true);
    expect(isSsrfBlockedResolvedIp('169.254.169.254')).toBe(true);
  });

  test('永拒段：fe80::/10 链路本地与 fd00:ec2::/16 AWS IMDS', () => {
    expect(isBlockedSsrfIp('fe80::1')).toBe(true);
    expect(isBlockedSsrfIp('febf::ffff')).toBe(true);
    expect(isBlockedSsrfIp('fd00:ec2::254')).toBe(true);
    expect(isBlockedSsrfIp('fd00:ec2::1')).toBe(true);

    expect(isSsrfBlockedResolvedIp('fe80::1')).toBe(true);
    expect(isSsrfBlockedResolvedIp('fd00:ec2::254')).toBe(true);
  });

  test('永拒段：:: 未指定地址、ff00::/8 组播与 240.0.0.0/4 Class E 保留地址', () => {
    expect(isSsrfBlockedResolvedIp('::')).toBe(true);
    expect(isSsrfBlockedResolvedIp('ff02::1')).toBe(true);
    expect(isSsrfBlockedResolvedIp('ff05::2')).toBe(true);
    expect(isSsrfBlockedResolvedIp('240.0.0.1')).toBe(true);
    expect(isSsrfBlockedResolvedIp('255.255.255.255')).toBe(true);
  });

  test('IPv4-mapped IPv6：各种格式映射提取', () => {
    expect(isBlockedSsrfIp('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedSsrfIp('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedSsrfIp('::ffff:0:169.254.169.254')).toBe(true);

    // 公网 IPv4-mapped 放行
    expect(isBlockedSsrfIp('::ffff:93.184.216.34')).toBe(false);
    expect(isBlockedSsrfIp('::ffff:5db8:d822')).toBe(false);
    expect(isSsrfBlockedResolvedIp('::ffff:93.184.216.34')).toBe(false);

    // 私网 IPv4-mapped 受 publicEdge 约束
    expect(isSsrfBlockedResolvedIp('::ffff:192.168.1.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('::ffff:192.168.1.1', { publicEdge: true })).toBe(true);
  });

  test('NAT64 (64:ff9b::/96) 提取式判定（Q21=A）：Unsafe 拒、公网放、私网受控', () => {
    // 提取验证
    expect(extractEmbeddedIpv4s('64:ff9b::a9fe:a9fe')).toEqual(['169.254.169.254']);
    expect(extractEmbeddedIpv4s('64:ff9b::5db8:d822')).toEqual(['93.184.216.34']);
    expect(extractEmbeddedIpv4s('64:ff9b::169.254.169.254')).toEqual(['169.254.169.254']);

    // 邮件 #1355 / 任务卡首要判据：64:ff9b::a9fe:a9fe 必须拒、64:ff9b::5db8:d822 必须放
    expect(isBlockedSsrfIp('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isSsrfBlockedResolvedIp('64:ff9b::a9fe:a9fe')).toBe(true);

    expect(isBlockedSsrfIp('64:ff9b::5db8:d822')).toBe(false);
    expect(isSsrfBlockedResolvedIp('64:ff9b::5db8:d822')).toBe(false);

    // 点分形式
    expect(isBlockedSsrfIp('64:ff9b::169.254.169.254')).toBe(true);
    expect(isBlockedSsrfIp('64:ff9b::93.184.216.34')).toBe(false);
    expect(isSsrfBlockedResolvedIp('64:ff9b::93.184.216.34')).toBe(false);

    // 0.0.0.0 内嵌必须拒
    expect(isBlockedSsrfIp('64:ff9b::0.0.0.0')).toBe(true);

    // 私网内嵌受 publicEdge 约束
    expect(isBlockedSsrfIp('64:ff9b::10.0.0.1')).toBe(false);
    expect(isSsrfBlockedResolvedIp('64:ff9b::10.0.0.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('64:ff9b::10.0.0.1', { publicEdge: true })).toBe(true);

    expect(isSsrfBlockedResolvedIp('64:ff9b::127.0.0.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('64:ff9b::127.0.0.1', { publicEdge: true })).toBe(true);
  });

  test('6to4 (2002::/16) 提取式判定（Q21=A）：Unsafe 拒、公网放、私网受控', () => {
    // 2002:WWXX:YYZZ:: 提取 bits 16..47
    expect(extractEmbeddedIpv4s('2002:a9fe:a9fe::')).toEqual(['169.254.169.254']);
    expect(extractEmbeddedIpv4s('2002:a9fe:a9fe::1')).toEqual(['169.254.169.254']);
    expect(extractEmbeddedIpv4s('2002:5db8:d822::')).toEqual(['93.184.216.34']);

    expect(isBlockedSsrfIp('2002:a9fe:a9fe::')).toBe(true);
    expect(isBlockedSsrfIp('2002:a9fe:a9fe::1')).toBe(true);
    expect(isSsrfBlockedResolvedIp('2002:a9fe:a9fe::1')).toBe(true);

    // 公网 6to4 放行
    expect(isBlockedSsrfIp('2002:5db8:d822::')).toBe(false);
    expect(isBlockedSsrfIp('2002:5db8:d822::1')).toBe(false);
    expect(isSsrfBlockedResolvedIp('2002:5db8:d822::1')).toBe(false);

    // 私网 6to4
    expect(isBlockedSsrfIp('2002:0a00:0001::')).toBe(false);
    expect(isSsrfBlockedResolvedIp('2002:0a00:0001::', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('2002:0a00:0001::', { publicEdge: true })).toBe(true);
  });

  test('Teredo (2001:0000::/32) 提取式判定（Q21=A）：server 与 client 双向判定', () => {
    // Server unsafe (hextets 2-3 为 169.254.169.254 = a9fe:a9fe)
    expect(isBlockedSsrfIp('2001:0000:a9fe:a9fe:8000:63bf:3fff:fdd2')).toBe(true);
    expect(isSsrfBlockedResolvedIp('2001:0000:a9fe:a9fe:8000:63bf:3fff:fdd2')).toBe(true);

    // Client unsafe (hextets 6-7 取反后为 169.254.169.254 -> 5601:5601)
    expect(isBlockedSsrfIp('2001:0000:5db8:d822:8000:63bf:5601:5601')).toBe(true);
    expect(isSsrfBlockedResolvedIp('2001:0000:5db8:d822:8000:63bf:5601:5601')).toBe(true);

    // Server & Client 均为公网
    // 0808:0808 = 8.8.8.8; a247:27dd 取反为 5db8:d822 = 93.184.216.34
    const teredoPublic = '2001:0000:0808:0808:8000:63bf:a247:27dd';
    expect(extractEmbeddedIpv4s(teredoPublic)).toEqual(['8.8.8.8', '93.184.216.34']);
    expect(isBlockedSsrfIp(teredoPublic)).toBe(false);
    expect(isSsrfBlockedResolvedIp(teredoPublic)).toBe(false);

    // Client 为私网 10.0.0.1 (取反后为 f5ff:fffe)
    const teredoPrivateClient = '2001:0000:5db8:d822:8000:63bf:f5ff:fffe';
    expect(extractEmbeddedIpv4s(teredoPrivateClient)).toContain('10.0.0.1');
    expect(isBlockedSsrfIp(teredoPrivateClient)).toBe(false);
    expect(isSsrfBlockedResolvedIp(teredoPrivateClient, { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp(teredoPrivateClient, { publicEdge: true })).toBe(true);
  });

  test('十进制/八进制/十六进制 IPv4 变形解析', () => {
    // 169.254.169.254 变体
    expect(isBlockedSsrfIp('2852039166')).toBe(true);
    expect(isBlockedSsrfIp('0xa9fea9fe')).toBe(true);
    expect(isBlockedSsrfIp('0251.0376.0251.0376')).toBe(true);
    expect(isSsrfBlockedResolvedIp('2852039166')).toBe(true);
    expect(isSsrfBlockedResolvedIp('0xa9fea9fe')).toBe(true);

    // 127.0.0.1 变体
    expect(isBlockedSsrfIp('2130706433')).toBe(false);
    expect(isBlockedSsrfIp('0x7f000001')).toBe(false);
    expect(isBlockedSsrfIp('0177.0.0.1')).toBe(false);
    expect(isBlockedSsrfIp('0x7f.0.0.1')).toBe(false);

    expect(isSsrfBlockedResolvedIp('2130706433', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('2130706433', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('0177.0.0.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('0177.0.0.1', { publicEdge: true })).toBe(true);
    expect(isSsrfBlockedResolvedIp('0x7f.0.0.1', { publicEdge: false })).toBe(false);
    expect(isSsrfBlockedResolvedIp('0x7f.0.0.1', { publicEdge: true })).toBe(true);

    // 公网变体 (93.184.216.34)
    expect(isBlockedSsrfIp('1567610914')).toBe(false);
    expect(isSsrfBlockedResolvedIp('1567610914')).toBe(false);
  });

  test('isPrivateOrLoopbackHostname 对嵌入 IPv4 与变体的支持', () => {
    expect(isPrivateOrLoopbackHostname('localhost')).toBe(true);
    expect(isPrivateOrLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHostname('0177.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHostname('2130706433')).toBe(true);
    expect(isPrivateOrLoopbackHostname('[64:ff9b::127.0.0.1]')).toBe(true);
    expect(isPrivateOrLoopbackHostname('[64:ff9b::10.0.0.1]')).toBe(true);

    // 永拒与公网地址不是合法的私网放行主机名
    expect(isPrivateOrLoopbackHostname('169.254.169.254')).toBe(false);
    expect(isPrivateOrLoopbackHostname('2852039166')).toBe(false);
    expect(isPrivateOrLoopbackHostname('[64:ff9b::a9fe:a9fe]')).toBe(false);
    expect(isPrivateOrLoopbackHostname('[64:ff9b::5db8:d822]')).toBe(false);
    expect(isPrivateOrLoopbackHostname('example.com')).toBe(false);
  });
});

describe('pinnedFetch: 传输层核心防护与行为', () => {
  test('IP 字面量在发起连接前预检拦截', async () => {
    // 169.254
    await expect(pinnedFetch('http://169.254.169.254/')).rejects.toThrow('ssrf_blocked_ip');
    // IPv4-mapped
    await expect(pinnedFetch('http://[::ffff:169.254.169.254]/')).rejects.toThrow('ssrf_blocked_ip');
    // NAT64 unsafe
    await expect(pinnedFetch('http://[64:ff9b::a9fe:a9fe]/')).rejects.toThrow('ssrf_blocked_ip');
    // 6to4 unsafe
    await expect(pinnedFetch('http://[2002:a9fe:a9fe::1]/')).rejects.toThrow('ssrf_blocked_ip');
    // 整数 / 十六进制形 IPv4
    await expect(pinnedFetch('http://2852039166/')).rejects.toThrow('ssrf_blocked_ip');
    await expect(pinnedFetch('http://0xa9fea9fe/')).rejects.toThrow('ssrf_blocked_ip');
    // 不支持的协议
    await expect(pinnedFetch('ftp://127.0.0.1/')).rejects.toThrow('unsupported_protocol');
  });

  test('DNS rebinding 防御：连接期 lookup 钩子钉死，消灭 TOCTOU', async () => {
    // 模拟 DNS 返回 169.254.169.254
    const unsafeLookup: DnsLookup = async () => [
      { address: '169.254.169.254', family: 4 },
    ];
    await expect(
      pinnedFetch('http://safe.example.com/api', { dnsLookup: unsafeLookup }),
    ).rejects.toThrow('ssrf_blocked_ip');

    // 模拟 DNS 返回 NAT64 unsafe
    const nat64UnsafeLookup: DnsLookup = async () => [
      { address: '64:ff9b::a9fe:a9fe', family: 6 },
    ];
    await expect(
      pinnedFetch('http://safe.example.com/api', { dnsLookup: nat64UnsafeLookup }),
    ).rejects.toThrow('ssrf_blocked_ip');

    // 多 A/AAAA 记录，只要包含一条 blocked IP 即拒绝
    const dualStackRebind: DnsLookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    await expect(
      pinnedFetch('http://safe.example.com/api', { dnsLookup: dualStackRebind }),
    ).rejects.toThrow('ssrf_blocked_ip');

    // DNS 无结果
    const emptyLookup: DnsLookup = async () => [];
    await expect(
      pinnedFetch('http://safe.example.com/api', { dnsLookup: emptyLookup }),
    ).rejects.toThrow('dns_empty');
  });

  test('redirect 拒绝上移：3xx 响应内置失败且不跟随（RFC-0001 §9.1/§9.4）', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(302, {
        Location: 'http://127.0.0.1:9999/other',
        'Content-Type': 'text/plain',
      });
      res.end('redirecting');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      await expect(
        pinnedFetch(`http://test-server.example:${port}/target`, {
          dnsLookup,
          ssrfOptions: { publicEdge: false },
        }),
      ).rejects.toThrow('redirect_forbidden');
    } finally {
      server.close();
    }
  });

  test('maxBytes 字节上限截断：超出抛 response_too_large', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // 发送 4KB 数据
      res.end('x'.repeat(4096));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];

      // 限制 1024 字节：失败
      await expect(
        pinnedFetch(`http://test-server.example:${port}/doc`, {
          dnsLookup,
          maxBytes: 1024,
          ssrfOptions: { publicEdge: false },
        }),
      ).rejects.toThrow('response_too_large');

      // 限制 8192 字节：成功
      const res = await pinnedFetch(`http://test-server.example:${port}/doc`, {
        dnsLookup,
        maxBytes: 8192,
        ssrfOptions: { publicEdge: false },
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBe(4096);
    } finally {
      server.close();
    }
  });

  test('绝对墙钟死线（RFC-0001 §9.7）：slowloris 慢滴响应独立于空闲超时销毁', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first');
      // 每 20ms 发送一次数据，导致 socket 从不处于空闲状态
      const interval = setInterval(() => {
        try {
          res.write(' chunk');
        } catch {
          clearInterval(interval);
        }
      }, 20);
      req.on('close', () => {
        clearInterval(interval);
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const startedAt = Date.now();

      // timeoutMs（空闲超时）设为 500ms（若仅靠空闲超时则绝不会触发）
      // deadlineMs 设为 60ms：绝对死线到期必须销毁
      await expect(
        pinnedFetch(`http://test-server.example:${port}/slow`, {
          dnsLookup,
          timeoutMs: 500,
          deadlineMs: 60,
          ssrfOptions: { publicEdge: false },
        }),
      ).rejects.toThrow('deadline_exceeded');

      const elapsed = Date.now() - startedAt;
      // 保证在死线附近被杀，而非等待 500ms
      expect(elapsed).toBeLessThan(400);
    } finally {
      server.close();
    }
  });

  test('绝对墙钟死线（RFC-0001 §9.7）：TCP tarpit 接受握手但不发数据时到期销毁', async () => {
    const tarpitServer = net.createServer((socket) => {
      // 接受 TCP 连接但不写入任何响应
    });

    await new Promise<void>((resolve) => tarpitServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (tarpitServer.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const startedAt = Date.now();

      await expect(
        pinnedFetch(`http://tarpit.example:${port}/trap`, {
          dnsLookup,
          timeoutMs: 500,
          deadlineMs: 60,
          ssrfOptions: { publicEdge: false },
        }),
      ).rejects.toThrow('deadline_exceeded');

      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(400);
    } finally {
      tarpitServer.close();
    }
  });

  test('正常成功请求：透传请求头与响应体', async () => {
    const server = http.createServer((req, res) => {
      const customHeader = req.headers['x-custom-test'];
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Echo-Custom': String(customHeader),
      });
      res.end(JSON.stringify({ status: 'ok', received: customHeader }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const res = await pinnedFetch(`http://server.example:${port}/api/hello`, {
        dnsLookup,
        headers: {
          'x-custom-test': 'my-secret-val',
        },
        timeoutMs: 5000,
        deadlineMs: 5000,
        maxBytes: 1024,
        ssrfOptions: { publicEdge: false },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-echo-custom')).toBe('my-secret-val');
      const body = await res.json();
      expect(body).toEqual({ status: 'ok', received: 'my-secret-val' });
    } finally {
      server.close();
    }
  });

  test('HTTP 204 No Content：正确构建 null body 响应而不抛出 TypeError', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(204, { 'X-Status-Note': 'no-content-ack' });
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const res = await pinnedFetch(`http://server.example:${port}/webhook/ack`, {
        dnsLookup,
        timeoutMs: 2000,
        deadlineMs: 2000,
        ssrfOptions: { publicEdge: false },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('x-status-note')).toBe('no-content-ack');
      const text = await res.text();
      expect(text).toBe('');
    } finally {
      server.close();
    }
  });

  test('publicEdge: true 端到端防护：字面量与 DNS 解析私网均被拒绝', async () => {
    // 1. IP 字面量私网地址被前置检查拒绝
    await expect(
      pinnedFetch('http://127.0.0.1:8080/hook', {
        ssrfOptions: { publicEdge: true },
      }),
    ).rejects.toThrow('ssrf_blocked_ip');

    // 2. DNS 解析到私网地址被 lookup hook 拒绝
    const dnsLookup: DnsLookup = async () => [{ address: '10.0.0.1', family: 4 }];
    await expect(
      pinnedFetch('http://internal.service:8080/hook', {
        dnsLookup,
        ssrfOptions: { publicEdge: true },
      }),
    ).rejects.toThrow('ssrf_blocked_ip');
  });

  test('AbortController signal 支持与监听器注销', async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('done');
      }, 200);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const dnsLookup: DnsLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      const ac = new AbortController();

      const fetchPromise = pinnedFetch(`http://abort.example:${port}/long`, {
        dnsLookup,
        signal: ac.signal,
        ssrfOptions: { publicEdge: false },
      });

      setTimeout(() => ac.abort(), 30);
      await expect(fetchPromise).rejects.toThrow('aborted');
    } finally {
      server.close();
    }
  });
});
