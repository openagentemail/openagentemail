import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import type { CliOptions } from './args.ts';
import {
  configureClients,
  createClientContext,
  type ClientContext,
} from './clients.ts';
import { createScopedIdentity, selectClientIds } from './connect.ts';
import type { Reporter } from './reporter.ts';
import { clearSetupState } from './state.ts';
import { CliError, EXIT, type CliResult, type PromptAdapter } from './types.ts';
import { verifyMcpServer } from './verify.ts';

export const DEMO_COMPOSE_PROJECT = 'openagentemail-demo';
export const DEMO_COMPOSE_OVERRIDE = 'compose.demo.yaml';

const DEMO_COMPOSE_OVERRIDE_CONTENT = `services:
  provision:
    container_name: openagent-demo-provision
  mailserver:
    container_name: openagent-demo-mailserver
  ntfy-provision:
    container_name: openagent-demo-ntfy-provision
  ntfy:
    container_name: openagent-demo-ntfy
  api:
    container_name: openagent-demo-api
`;

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type DemoRuntime = {
  home: string;
  fetcher: typeof fetch;
  clientContext: ClientContext;
  run(command: string, args: string[], cwd?: string): CommandResult;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  randomHex(bytes: number): string;
  portAvailable(port: number): Promise<boolean>;
  verifyMcp(apiUrl: string, token: string): Promise<void>;
  statePath?: string;
};

function defaultRun(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function defaultPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export function createDemoRuntime(overrides: Partial<DemoRuntime> = {}): DemoRuntime {
  return {
    home: homedir(),
    fetcher: fetch,
    clientContext: createClientContext(),
    run: defaultRun,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: Date.now,
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    portAvailable: defaultPortAvailable,
    verifyMcp: verifyMcpServer,
    ...overrides,
  };
}

export function demoDirectory(home = homedir()): string {
  return join(home, '.local', 'share', 'openagentemail', 'demo');
}

export function demoComposeArgs(...command: string[]): string[] {
  return [
    'compose',
    '-p',
    DEMO_COMPOSE_PROJECT,
    '-f',
    'compose.yaml',
    '-f',
    DEMO_COMPOSE_OVERRIDE,
    ...command,
  ];
}

export function assertDockerAvailable(runtime: Pick<DemoRuntime, 'run'>): void {
  if (runtime.run('docker', ['--version']).status !== 0 ||
      runtime.run('docker', ['compose', 'version']).status !== 0) {
    throw new CliError(
      'Docker with the Compose plugin is required. Install it from https://docs.docker.com/get-docker/.',
      EXIT.DOCKER_MISSING,
    );
  }
}

function runOrThrow(
  runtime: DemoRuntime,
  command: string,
  args: string[],
  cwd: string | undefined,
  description: string,
): CommandResult {
  const result = runtime.run(command, args, cwd);
  if (result.status !== 0) {
    throw new CliError(`${description} failed.`);
  }
  return result;
}

async function writeDemoEnv(path: string, runtime: DemoRuntime): Promise<void> {
  const content = [
    'DOMAIN=demo.local',
    `API_KEYS=${runtime.randomHex(32)}`,
    `MAIL_PASSWORD=${runtime.randomHex(24)}`,
    `NTFY_ADMIN_PASSWORD=${runtime.randomHex(24)}`,
    'ENABLE_FAIL2BAN=0',
    '',
  ].join('\n');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

async function writeDemoComposeOverride(directory: string): Promise<void> {
  const path = join(directory, DEMO_COMPOSE_OVERRIDE);
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, DEMO_COMPOSE_OVERRIDE_CONTENT, { mode: 0o600 });
  await rename(tmp, path);
}

export function envValue(content: string, name: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return undefined;
}

async function healthReady(fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher('http://127.0.0.1:3100/healthz', {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    return ((await response.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export async function waitForDemoHealth(
  runtime: Pick<DemoRuntime, 'fetcher' | 'sleep' | 'now'>,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = runtime.now() + timeoutMs;
  while (runtime.now() < deadline) {
    if (await healthReady(runtime.fetcher)) return;
    await runtime.sleep(2_000);
  }
  throw new CliError(
    'The local demo did not become ready within 180 seconds. Run docker compose logs in the demo directory.',
    EXIT.DEMO_TIMEOUT,
  );
}

async function teardownDemo(directory: string, runtime: DemoRuntime): Promise<void> {
  if (!existsSync(directory)) return;
  if (!existsSync(join(directory, 'compose.yaml'))) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const envPath = join(directory, '.env');
  if (!existsSync(envPath)) await writeDemoEnv(envPath, runtime);
  await writeDemoComposeOverride(directory);
  runOrThrow(
    runtime,
    'docker',
    demoComposeArgs('down', '-v'),
    directory,
    'Docker Compose teardown',
  );
  await rm(directory, { recursive: true, force: true });
}

async function prepareDemoDirectory(
  directory: string,
  options: CliOptions,
  prompts: PromptAdapter,
  runtime: DemoRuntime,
): Promise<void> {
  if (existsSync(directory)) {
    const choice = options.yes
      ? 'reuse'
      : await prompts.select('A local demo already exists. What should happen?', [
          { value: 'reuse', label: 'Reuse it' },
          { value: 'recreate', label: 'Recreate it from scratch' },
          { value: 'exit', label: 'Exit' },
        ], 'reuse');
    if (choice === 'exit') throw new CliError('Setup cancelled');
    if (choice === 'reuse') return;
    await teardownDemo(directory, runtime);
  }

  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  runOrThrow(
    runtime,
    'git',
    ['clone', '--depth', '1', 'https://github.com/openagentemail/openagentemail.git', directory],
    undefined,
    'Source download',
  );
  await writeDemoEnv(join(directory, '.env'), runtime);
}

export async function runDemo(
  options: CliOptions,
  prompts: PromptAdapter,
  reporter: Reporter,
  suppliedRuntime?: DemoRuntime,
): Promise<Omit<CliResult, 'ok' | 'warnings'>> {
  const runtime = suppliedRuntime ?? createDemoRuntime();
  assertDockerAvailable(runtime);
  const directory = demoDirectory(runtime.home);
  const existedBefore = existsSync(directory);

  if (options.teardown) {
    await teardownDemo(directory, runtime);
    await clearSetupState(runtime.statePath);
    reporter.info('Local demo removed.');
    return { configuredClients: [] };
  }

  await prepareDemoDirectory(directory, options, prompts, runtime);
  await writeDemoComposeOverride(directory);
  const envPath = join(directory, '.env');
  if (!existsSync(envPath)) await writeDemoEnv(envPath, runtime);

  const alreadyReady = existedBefore && await healthReady(runtime.fetcher);
  if (!alreadyReady) {
    if (!(await runtime.portAvailable(3100))) {
      throw new CliError('Port 3100 is already in use. Stop that service, then retry the demo.');
    }
    reporter.info('Starting the local demo. The first Docker image download can take a few minutes.');
    runOrThrow(runtime, 'docker', demoComposeArgs('up', '-d'), directory, 'Docker Compose startup');
    await waitForDemoHealth(runtime);
  }

  const env = await readFile(envPath, 'utf8');
  const adminKey = envValue(env, 'API_KEYS');
  if (!adminKey) throw new CliError('The demo .env file is missing API_KEYS');
  const created = await createScopedIdentity(
    'http://localhost:3100',
    adminKey,
    'demo-agent',
    runtime.fetcher,
  );
  const ids = await selectClientIds(options, prompts, runtime.clientContext);
  const configuredClients = await configureClients(
    ids,
    'http://localhost:3100',
    created.token,
    reporter,
    runtime.clientContext,
  );
  if (options.verify) {
    await runtime.verifyMcp('http://localhost:3100', created.token);
  }
  await clearSetupState(runtime.statePath);

  reporter.info('Dashboard: http://localhost:3100/ui');
  reporter.info(`The admin key is stored in ${envPath}.`);
  reporter.info(
    'This local demo cannot receive real internet email. Deploy to a VPS when you are ready: https://openagent.email/docs/quickstart',
  );
  return { configuredClients, address: created.address };
}
