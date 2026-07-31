import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './types.ts';
import type { Reporter } from './reporter.ts';

export type McpEntry = {
  command: string;
  args: string[];
  env: {
    OPENAGENTEMAIL_API_URL: string;
    OPENAGENTEMAIL_API_KEY: string;
  };
};

export type ClientContext = {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  commandExists(command: string): boolean;
  runCommand(command: string, args: string[]): { status: number | null; stderr: string };
  now(): number;
};

type ClientDefinition = {
  id: string;
  name: string;
  configPath(context: ClientContext): string;
  detect(context: ClientContext): boolean;
  merge(content: string, entry: McpEntry): string;
};

function defaultCommandExists(command: string): boolean {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(finder, [command], { stdio: 'ignore' }).status === 0;
}

export function createClientContext(overrides: Partial<ClientContext> = {}): ClientContext {
  return {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    commandExists: defaultCommandExists,
    runCommand(command, args) {
      const result = spawnSync(command, args, { encoding: 'utf8' });
      return { status: result.status, stderr: result.stderr || '' };
    },
    now: Date.now,
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function mergeJsonConfig(content: string, entry: McpEntry): string {
  const parsed: unknown = content.trim() ? JSON.parse(content) : {};
  if (!isRecord(parsed)) throw new Error('configuration root must be a JSON object');
  const existingServers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
  return `${JSON.stringify({
    ...parsed,
    mcpServers: {
      ...existingServers,
      openagentemail: entry,
    },
  }, null, 2)}\n`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function mergeCodexToml(content: string, entry: McpEntry): string {
  const block = [
    '[mcp_servers.openagentemail]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
    `env = { OPENAGENTEMAIL_API_URL = ${tomlString(entry.env.OPENAGENTEMAIL_API_URL)}, OPENAGENTEMAIL_API_KEY = ${tomlString(entry.env.OPENAGENTEMAIL_API_KEY)} }`,
  ].join('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*\[/.test(line)) {
      skipping = /^\s*\[mcp_servers\.openagentemail(?:\.[^\]]+)?\]\s*$/.test(line);
    }
    if (!skipping) kept.push(line);
  }
  const prefix = kept.join('\n').trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${block}\n`;
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

function jsonClient(
  id: string,
  name: string,
  configPath: (context: ClientContext) => string,
  detectPath?: (context: ClientContext) => string,
): ClientDefinition {
  return {
    id,
    name,
    configPath,
    detect(context) {
      return pathExists(detectPath ? detectPath(context) : dirname(configPath(context)));
    },
    merge: mergeJsonConfig,
  };
}

export const CLIENT_REGISTRY: ClientDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    configPath: (context) => join(context.home, '.claude.json'),
    detect: (context) =>
      context.commandExists('claude') || pathExists(join(context.home, '.claude.json')),
    merge: mergeJsonConfig,
  },
  jsonClient(
    'cursor',
    'Cursor',
    (context) => join(context.home, '.cursor', 'mcp.json'),
  ),
  jsonClient(
    'kimi-code',
    'Kimi Code',
    (context) => join(context.home, '.kimi-code', 'mcp.json'),
  ),
  jsonClient(
    'claude-desktop',
    'Claude Desktop',
    (context) => {
      if (context.platform === 'darwin') {
        return join(
          context.home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        );
      }
      if (context.platform === 'win32') {
        return join(
          context.env.APPDATA || join(context.home, 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json',
        );
      }
      return join(context.home, '.config', 'Claude', 'claude_desktop_config.json');
    },
  ),
  jsonClient(
    'windsurf',
    'Windsurf',
    (context) => join(context.home, '.codeium', 'windsurf', 'mcp_config.json'),
  ),
  {
    id: 'codex',
    name: 'Codex CLI',
    configPath: (context) => join(context.home, '.codex', 'config.toml'),
    detect: (context) => pathExists(join(context.home, '.codex')),
    merge: mergeCodexToml,
  },
  jsonClient(
    'gemini',
    'Gemini CLI',
    (context) => join(context.home, '.gemini', 'settings.json'),
  ),
];

export function mcpEntry(apiUrl: string, token: string): McpEntry {
  return {
    command: 'npx',
    args: ['-y', '@openagentemail/mcp'],
    env: {
      OPENAGENTEMAIL_API_URL: apiUrl,
      OPENAGENTEMAIL_API_KEY: token,
    },
  };
}

export function detectClients(context = createClientContext()): ClientDefinition[] {
  return CLIENT_REGISTRY.filter((client) => client.detect(context));
}

export function clientById(id: string): ClientDefinition {
  const client = CLIENT_REGISTRY.find((candidate) => candidate.id === id);
  if (!client) throw new CliError(`Unknown MCP client: ${id}`);
  return client;
}

async function writeClientConfig(
  client: ClientDefinition,
  entry: McpEntry,
  context: ClientContext,
): Promise<string | null> {
  const path = client.configPath(context);
  const parent = dirname(path);
  if (!pathExists(parent)) return null;

  let content = '';
  let existed = false;
  try {
    const info = await stat(path);
    existed = info.isFile();
    if (existed) content = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const merged = client.merge(content, entry);
  if (existed) {
    await copyFile(path, `${path}.bak.${context.now()}`);
  } else {
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, merged, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

export async function configureClients(
  ids: string[],
  apiUrl: string,
  token: string,
  reporter: Reporter,
  context = createClientContext(),
): Promise<string[]> {
  const configured: string[] = [];
  const entry = mcpEntry(apiUrl, token);

  for (const id of ids) {
    const client = clientById(id);
    if (!client.detect(context)) {
      reporter.warn(`${client.name} was not detected; skipped.`);
      continue;
    }

    if (client.id === 'claude-code' && context.commandExists('claude')) {
      const result = context.runCommand('claude', [
        'mcp',
        'add',
        '--scope',
        'user',
        'openagentemail',
        '--env',
        `OPENAGENTEMAIL_API_URL=${apiUrl}`,
        '--env',
        `OPENAGENTEMAIL_API_KEY=${token}`,
        '--',
        'npx',
        '-y',
        '@openagentemail/mcp',
      ]);
      if (result.status === 0) {
        configured.push(client.id);
        continue;
      }
      reporter.warn('Claude Code CLI setup failed; trying its JSON config instead.');
    }

    try {
      const path = await writeClientConfig(client, entry, context);
      if (!path) {
        reporter.warn(`${client.name} config directory does not exist; skipped.`);
        continue;
      }
      configured.push(client.id);
    } catch (error) {
      const reason = error instanceof SyntaxError
        ? 'contains invalid JSON'
        : error instanceof Error
          ? error.message
          : String(error);
      reporter.warn(`${client.name} config was not changed: ${reason}.`);
    }
  }

  return configured;
}
