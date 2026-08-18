import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { CliError, EXIT } from './types.ts';
import { packageVersion } from './version.ts';

type SpawnMcp = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;

const REQUIRED_TOOL_NAMES = [
  'mail_list_identities',
  'mail_list_messages',
  'mail_read_message',
  'mail_send',
  'mail_mark_seen',
] as const;

export function validateToolList(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('MCP tools/list returned an invalid response', EXIT.MCP_VERIFY_FAILED);
  }
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new CliError(
      'MCP tools/list returned an empty or invalid tools array',
      EXIT.MCP_VERIFY_FAILED,
    );
  }
  const names = new Set<string>();
  for (const tool of tools) {
    const name = tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined;
    if (typeof name !== 'string' || name.length === 0) {
      throw new CliError('MCP tools/list returned an invalid tool entry', EXIT.MCP_VERIFY_FAILED);
    }
    names.add(name);
  }
  const missing = REQUIRED_TOOL_NAMES.filter((name) => !names.has(name));
  if (missing.length) {
    throw new CliError(
      `MCP verification is missing required tools: ${missing.join(', ')}`,
      EXIT.MCP_VERIFY_FAILED,
    );
  }
}

export async function verifyMcpServer(
  apiUrl: string,
  token: string,
  spawnMcp: SpawnMcp = spawn as SpawnMcp,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnMcp('npx', ['-y', '@openagentemail/mcp'], {
      env: {
        ...process.env,
        OPENAGENTEMAIL_API_URL: apiUrl,
        OPENAGENTEMAIL_API_KEY: token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let buffer = '';
    let stderr = '';

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new CliError('MCP verification timed out', EXIT.MCP_VERIFY_FAILED));
    }, 30_000);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 4_096) stderr = stderr.slice(-4_096);
    });
    child.on('error', () => {
      finish(new CliError('Could not start the MCP server', EXIT.MCP_VERIFY_FAILED));
    });
    child.on('exit', (code) => {
      if (!settled) {
        finish(new CliError(
          `MCP server exited before verification${code === null ? '' : ` (${code})`}${stderr ? ': see stderr for details' : ''}`,
          EXIT.MCP_VERIFY_FAILED,
        ));
      }
    });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          })}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          })}\n`);
        }
        if (message.id === 2) {
          try {
            validateToolList(message.result);
            finish();
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: '@openagentemail/setup', version: packageVersion.version },
      },
    })}\n`);
  });
}
