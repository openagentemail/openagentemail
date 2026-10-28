/**
 * restoreMcpPublicUrl 必须与 parseConfig 的 normalizeUrl 一致。
 * 查询串以 / 结尾、以及 pathname 在 ? 前带斜杠时，整段 href 去尾斜杠会分叉。
 */
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { restoreMcpPublicUrl } from './helpers/order-isolation.ts';

const { describe, expect, test } = await import('bun:test');
const { parseConfig } = await import('../src/lib/config.ts');

const requiredEnv: NodeJS.ProcessEnv = {
  DOMAIN: 'example.com',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.com',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.com',
  SMTP_PASS: 'smtp-secret',
};

describe('restoreMcpPublicUrl', () => {
  test('查询以 / 结尾、path 斜杠位于查询之前时，还原值等于 parseConfig', () => {
    const cases = [
      'https://mcp.example.com/ui?next=/',
      'https://mcp.example.com/mcp/?resource=1',
    ];
    const previous = process.env.MCP_PUBLIC_URL;
    try {
      for (const raw of cases) {
        const cfg: { mcpPublicUrl?: string } = {};
        restoreMcpPublicUrl(cfg, raw);
        expect(cfg.mcpPublicUrl).toBe(
          parseConfig({ ...requiredEnv, MCP_PUBLIC_URL: raw }).mcpPublicUrl,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.MCP_PUBLIC_URL;
      else process.env.MCP_PUBLIC_URL = previous;
    }
  });
});
