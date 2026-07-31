import {
  CLIENT_REGISTRY,
  clientById,
  configureClients,
  createClientContext,
  detectClients,
  type ClientContext,
} from './clients.ts';
import type { CliOptions } from './args.ts';
import type { Reporter } from './reporter.ts';
import { clearSetupState } from './state.ts';
import { CliError, EXIT, type CliResult, type PromptAdapter } from './types.ts';
import { verifyMcpServer } from './verify.ts';

type ConnectDependencies = {
  fetcher?: typeof fetch;
  clientContext?: ClientContext;
  verifyMcp?: (apiUrl: string, token: string) => Promise<void>;
  statePath?: string;
};

function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/+$/, '')}${path}`;
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('API URL must be a valid http:// or https:// URL', EXIT.API_UNREACHABLE);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('API URL must use http:// or https://', EXIT.API_UNREACHABLE);
  }
  return url.href.replace(/\/+$/, '');
}

export async function checkApiHealth(
  apiUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await fetcher(apiEndpoint(apiUrl, '/healthz'), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('not ok');
    const body = await response.json() as { ok?: unknown };
    if (body.ok !== true) throw new Error('unexpected response');
  } catch {
    throw new CliError(
      `Could not reach an openagent.email server at ${apiUrl}`,
      EXIT.API_UNREACHABLE,
    );
  }
}

export async function tokenKind(
  apiUrl: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<'admin' | 'identity'> {
  let response: Response;
  try {
    response = await fetcher(apiEndpoint(apiUrl, '/v1/identities'), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError(
      `Could not reach an openagent.email server at ${apiUrl}`,
      EXIT.API_UNREACHABLE,
    );
  }
  if (response.status === 401) {
    throw new CliError('The token is not valid', EXIT.TOKEN_INVALID);
  }
  if (response.status === 200) return 'admin';
  if (token.startsWith('oa_') && response.status === 403) return 'identity';
  throw new CliError('The token is not valid for this server', EXIT.TOKEN_INVALID);
}

export async function createScopedIdentity(
  apiUrl: string,
  adminKey: string,
  name: string,
  fetcher: typeof fetch,
): Promise<{ address: string; token: string }> {
  const response = await fetcher(apiEndpoint(apiUrl, '/v1/identities'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(name ? { name } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) {
    throw new CliError('The admin key is not valid', EXIT.TOKEN_INVALID);
  }
  if (!response.ok) {
    throw new CliError(`Could not create a scoped identity (HTTP ${response.status})`);
  }
  const body = await response.json() as { address?: unknown; token?: unknown };
  if (typeof body.address !== 'string' || typeof body.token !== 'string') {
    throw new CliError('The server returned an invalid identity response');
  }
  return { address: body.address, token: body.token };
}

export async function selectClientIds(
  options: CliOptions,
  prompts: PromptAdapter,
  context: ClientContext,
): Promise<string[]> {
  if (options.clients) {
    for (const id of options.clients) clientById(id);
    return options.clients;
  }
  const detected = detectClients(context);
  if (options.yes || detected.length === 0) return detected.map((client) => client.id);
  return prompts.multiselect(
    'Which MCP clients should be configured?',
    detected.map((client) => ({ value: client.id, label: client.name })),
    detected.map((client) => client.id),
  );
}

export async function runConnect(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  dependencies: ConnectDependencies = {},
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const fetcher = dependencies.fetcher ?? fetch;
  const context = dependencies.clientContext ?? createClientContext();
  if (options.yes && (!options.apiUrl || !options.token)) {
    throw new CliError('connect --yes requires --api-url and --token');
  }

  const rawApiUrl = options.apiUrl ?? await prompts.text(
    'openagent.email API URL',
    'http://localhost:3100',
    true,
  );
  const apiUrl = normalizeApiUrl(rawApiUrl);
  await checkApiHealth(apiUrl, fetcher);

  const suppliedToken = options.token ?? await prompts.password('Admin key or identity token');
  const kind = await tokenKind(apiUrl, suppliedToken, fetcher);
  let token = suppliedToken;
  let address: string | undefined;

  if (kind === 'admin') {
    reporter.info('Admin key verified. Creating a safer scoped identity token for MCP use.');
    const name = options.name ?? (options.yes
      ? 'setup-agent'
      : await prompts.text('Display name for the new identity', 'setup-agent'));
    const created = await createScopedIdentity(apiUrl, suppliedToken, name, fetcher);
    token = created.token;
    address = created.address;
    reporter.info('The admin key will not be written to any client configuration.');
  }

  const ids = await selectClientIds(options, prompts, context);
  if (ids.length === 0) {
    reporter.warn(
      `No supported MCP clients were selected. Supported ids: ${CLIENT_REGISTRY.map((client) => client.id).join(', ')}.`,
    );
  }
  const configuredClients = await configureClients(ids, apiUrl, token, reporter, context);

  if (options.verify) {
    await (dependencies.verifyMcp ?? verifyMcpServer)(apiUrl, token);
  }
  await clearSetupState(dependencies.statePath);

  reporter.info(
    configuredClients.length
      ? `Configured: ${configuredClients.join(', ')}`
      : 'No client configuration files were changed.',
  );
  reporter.info('Restart the configured clients, then send a test email to your identity.');
  return { configuredClients, ...(address ? { address } : {}) };
}
