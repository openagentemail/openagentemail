/**
 * R6：Claude 卡 shell history 面——config 命令零凭证（$OAE_TOKEN），
 * 其余自动卡仍可含 token。抽出真实 connectAgentDefinitions 做负控。
 */
import { describe, expect, test } from 'bun:test';

const { CONNECT_PAGE_JS } = await import('../src/ui/client/pages/connect.ts');

function extractConnectAgentDefinitions(): string {
  const start = CONNECT_PAGE_JS.indexOf('function connectAgentDefinitions(');
  const end = CONNECT_PAGE_JS.indexOf('function redactConnectText(');
  if (start < 0 || end <= start) throw new Error('connectAgentDefinitions slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

function extractShellSingleQuote(): string {
  const start = CONNECT_PAGE_JS.indexOf('function shellSingleQuote(');
  const end = CONNECT_PAGE_JS.indexOf('function jsonConfig(');
  if (start < 0 || end <= start) throw new Error('shellSingleQuote slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

function extractJsonConfig(): string {
  const start = CONNECT_PAGE_JS.indexOf('function jsonConfig(');
  const end = CONNECT_PAGE_JS.indexOf('function connectAgentDefinitions(');
  if (start < 0 || end <= start) throw new Error('jsonConfig slice missing');
  return CONNECT_PAGE_JS.slice(start, end);
}

type AgentDef = {
  name: string;
  manual?: boolean;
  config: string;
  prompt: string;
};

function definitionsFor(endpoint: string, token: string): AgentDef[] {
  const box: { defs?: AgentDef[] } = {};
  new Function(
    'box',
    'endpoint',
    'token',
    `
      ${extractShellSingleQuote()}
      ${extractJsonConfig()}
      ${extractConnectAgentDefinitions()}
      box.defs = connectAgentDefinitions(endpoint, token);
    `,
  )(box, endpoint, token);
  return box.defs!;
}

describe('Connect Claude card shell-history guard (R6)', () => {
  const token = 'oa_claude-history-secret';
  const endpoint = 'https://mail.example/mcp';

  test('Claude config references $OAE_TOKEN and never embeds the real token', () => {
    const defs = definitionsFor(endpoint, token);
    const claude = defs.find((d) => d.name === 'Claude Code');
    expect(claude).toBeDefined();
    expect(claude!.manual).toBeFalsy();

    // 负控：命令本体零凭证
    expect(claude!.config).toContain('$OAE_TOKEN');
    expect(claude!.config).toContain("'Authorization: Bearer '");
    expect(claude!.config).toContain('claude mcp add');
    expect(claude!.config).not.toContain(token);
    expect(claude!.config).not.toContain('Bearer ' + token);
    expect(claude!.config).toContain(endpoint);

    // prompt：read -s 进 OAE_TOKEN，再跑命令
    expect(claude!.prompt).toContain('read -s OAE_TOKEN');
    expect(claude!.prompt).toContain('$OAE_TOKEN');
    expect(claude!.prompt).not.toContain(token);
  });

  test('other six cards are unchanged in credential shape (auto still embed token)', () => {
    const defs = definitionsFor(endpoint, token);
    expect(defs).toHaveLength(7);

    const kimi = defs.find((d) => d.name === 'Kimi Code')!;
    const codex = defs.find((d) => d.name === 'Codex')!;
    const cursor = defs.find((d) => d.name === 'Cursor')!;
    const zcode = defs.find((d) => d.name === 'ZCode')!;
    const chatgpt = defs.find((d) => d.name === 'ChatGPT')!;
    const grok = defs.find((d) => d.name === 'Grok')!;

    // 其余四张自动卡写入面仍含 token（本单只动 Claude）
    for (const card of [kimi, codex, cursor, zcode]) {
      expect(card.config).toContain(token);
      expect(card.manual).toBeFalsy();
    }

    // manual 卡不动
    expect(chatgpt.manual).toBe(true);
    expect(grok.manual).toBe(true);
    expect(chatgpt.config).not.toContain(token);
    expect(grok.config).not.toContain(token);
    expect(chatgpt.prompt).toContain('ChatGPT Settings > Connectors');
    expect(grok.prompt).toContain('Grok settings');
  });
});
