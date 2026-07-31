import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CLIENT_REGISTRY,
  configureClients,
  createClientContext,
  mergeCodexToml,
  mergeJsonConfig,
  mcpEntry,
} from '../src/clients.ts';
import { Reporter } from '../src/reporter.ts';

const created: string[] = [];

function sink() {
  let value = '';
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value,
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('MCP client config merge', () => {
  test('JSON merge preserves unrelated keys and overwrites only openagentemail', () => {
    const merged = JSON.parse(mergeJsonConfig(JSON.stringify({
      theme: 'dark',
      mcpServers: {
        existing: { command: 'existing' },
        openagentemail: { command: 'old' },
      },
    }), mcpEntry('http://localhost:3100', 'oa_new')));
    expect(merged.theme).toBe('dark');
    expect(merged.mcpServers.existing).toEqual({ command: 'existing' });
    expect(merged.mcpServers.openagentemail.env.OPENAGENTEMAIL_API_KEY).toBe('oa_new');
  });

  test('Codex TOML merge replaces its block and preserves every other section', () => {
    const merged = mergeCodexToml([
      'model = "gpt"',
      '',
      '[mcp_servers.openagentemail]',
      'command = "old"',
      '',
      '[mcp_servers.openagentemail.env]',
      'OPENAGENTEMAIL_API_KEY = "oa_old"',
      '',
      '[projects."/tmp"]',
      'trust_level = "trusted"',
      '',
    ].join('\n'), mcpEntry('https://mail.example', 'oa_new'));
    expect(merged).toContain('model = "gpt"');
    expect(merged).toContain('[projects."/tmp"]');
    expect(merged).toContain('OPENAGENTEMAIL_API_KEY = "oa_new"');
    expect(merged.match(/\[mcp_servers\.openagentemail\]/g)?.length).toBe(1);
    expect(merged).not.toContain('command = "old"');
    expect(merged).not.toContain('[mcp_servers.openagentemail.env]');
    expect(merged).not.toContain('oa_old');
  });

  test('Claude Code CLI writes user scope instead of the current project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-claude-cli-'));
    created.push(home);
    let invocation: { command: string; args: string[] } | undefined;
    const context = createClientContext({
      home,
      commandExists: (command) => command === 'claude',
      runCommand: (command, args) => {
        invocation = { command, args };
        return { status: 0, stderr: '' };
      },
    });
    const reporter = new Reporter(false, sink().stream, sink().stream);
    expect(await configureClients(
      ['claude-code'],
      'https://api.example',
      'oa_test',
      reporter,
      context,
    )).toEqual(['claude-code']);
    expect(invocation).toEqual({
      command: 'claude',
      args: [
        'mcp', 'add', '--scope', 'user', 'openagentemail',
        '--env', 'OPENAGENTEMAIL_API_URL=https://api.example',
        '--env', 'OPENAGENTEMAIL_API_KEY=oa_test',
        '--', 'npx', '-y', '@openagentemail/mcp',
      ],
    });
  });

  test('all seven registry entries write the expected format and back up existing files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-clients-'));
    created.push(home);
    const directories = [
      '.cursor',
      '.kimi-code',
      'Library/Application Support/Claude',
      '.codeium/windsurf',
      '.codex',
      '.gemini',
    ];
    await Promise.all(directories.map((path) => mkdir(join(home, path), { recursive: true })));
    await writeFile(join(home, '.claude.json'), '{"keep":true}\n');
    await writeFile(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"keep":{"command":"x"}}}\n');
    await writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt"\n');

    const context = createClientContext({
      home,
      platform: 'darwin',
      commandExists: () => false,
      runCommand: () => ({ status: 1, stderr: '' }),
      now: () => 12345,
    });
    const out = sink();
    const err = sink();
    const reporter = new Reporter(false, out.stream, err.stream);
    const ids = CLIENT_REGISTRY.map((client) => client.id);
    expect(await configureClients(ids, 'https://api.example', 'oa_test', reporter, context)).toEqual(ids);

    for (const client of CLIENT_REGISTRY) {
      const content = await readFile(client.configPath(context), 'utf8');
      expect(content).toContain('OPENAGENTEMAIL_API_URL');
      expect(content).toContain('oa_test');
    }
    expect(await readFile(join(home, '.cursor', 'mcp.json.bak.12345'), 'utf8')).toContain('"keep"');
    expect(await readFile(join(home, '.codex', 'config.toml.bak.12345'), 'utf8')).toContain('model');
  });

  test('bad JSON is never touched and other clients continue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-bad-json-'));
    created.push(home);
    await mkdir(join(home, '.cursor'), { recursive: true });
    await mkdir(join(home, '.kimi-code'), { recursive: true });
    const cursorPath = join(home, '.cursor', 'mcp.json');
    await writeFile(cursorPath, '{broken');

    const context = createClientContext({
      home,
      commandExists: () => false,
      runCommand: () => ({ status: 1, stderr: '' }),
    });
    const reporter = new Reporter(true, sink().stream, sink().stream);
    expect(await configureClients(
      ['cursor', 'kimi-code'],
      'http://localhost:3100',
      'oa_test',
      reporter,
      context,
    )).toEqual(['kimi-code']);
    expect(await readFile(cursorPath, 'utf8')).toBe('{broken');
    expect(reporter.warnings.some((warning) => warning.includes('invalid JSON'))).toBe(true);
  });
});
