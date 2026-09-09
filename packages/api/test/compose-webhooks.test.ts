// Fill process env before importing the config singleton so parseConfig does not throw.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

const { parseConfig } = await import('../src/lib/config.ts');

const REPO_DIR = join(import.meta.dir, '..', '..', '..');

/** The 22 WEBHOOK/WEBHOOKS keys from config.ts / r0. */
const WEBHOOK_KEYS = [
  'WEBHOOKS_ENABLED',
  'WEBHOOK_SIGNING_SECRET',
  'WEBHOOK_SIGNING_SECRET_PREVIOUS',
  'WEBHOOK_ALLOW_PRIVATE_TARGETS',
  'WEBHOOK_ALLOWED_PORTS',
  'WEBHOOK_MAX_SUBSCRIPTIONS',
  'WEBHOOK_MAX_PER_ADDRESS',
  'WEBHOOK_MAX_ATTEMPTS',
  'WEBHOOK_DELIVERY_TIMEOUT_MS',
  'WEBHOOK_MAX_CONCURRENT',
  'WEBHOOK_POOL_RETRY_MS',
  'WEBHOOK_PAYLOAD_MAX_BYTES',
  'WEBHOOK_APPROVAL_ARGS_MAX_BYTES',
  'WEBHOOK_APPROVAL_ARGS_MAX_DEPTH',
  'WEBHOOK_RESPONSE_MAX_BYTES',
  'WEBHOOK_TIMESTAMP_TOLERANCE_SEC',
  'WEBHOOK_DISABLE_THRESHOLD',
  'WEBHOOK_ROTATION_OVERLAP_MS',
  'WEBHOOK_LOG_RETENTION_DAYS',
  'WEBHOOK_RATE_CREATE_PER_MIN',
  'WEBHOOK_RATE_TEST_PER_MIN',
  'WEBHOOK_RATE_DELIVER_PER_MIN',
] as const;

const OPTIONAL_SECRETS = [
  'WEBHOOK_SIGNING_SECRET',
  'WEBHOOK_SIGNING_SECRET_PREVIOUS',
] as const;

/** Distinct synthetic fixtures; assertions use boolean equality so values are not printed. */
const SYNTH_SECRET = 'synth-webhook-current-secret-aaaa';
const SYNTH_SECRET_PREVIOUS = 'synth-webhook-previous-secret-bbb';

const VARIANTS = [
  { name: 'bundled', file: 'compose.yaml', example: '.env.example' },
  { name: 'api-only', file: 'compose.api-only.yaml', example: '.env.api-only.example' },
] as const;

const INPUT_MODES = ['env-file', 'shell'] as const;

/** Synthetic deployment inputs only; never read a production .env. */
const SYNTH_REQUIRED: Record<string, string> = {
  DOMAIN: 'example.test',
  API_KEYS: 'synth-api-key-not-production',
  MAIL_PASSWORD: 'synth-mail-pass-not-production',
  TASK_SIGNING_SECRET: 'synth-task-signing-secret-32char',
  NTFY_ADMIN_PASSWORD: 'synth-ntfy-admin-not-production',
  IMAP_HOST: 'imap.example.test',
  IMAP_PORT: '993',
  IMAP_TLS: 'true',
  IMAP_USER: 'catch-all@example.test',
  IMAP_PASS: 'synth-imap-pass-not-production',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'catch-all@example.test',
  SMTP_PASS: 'synth-smtp-pass-not-production',
};

const ALL_OVERRIDES: Record<string, string> = {
  WEBHOOKS_ENABLED: 'true',
  WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
  WEBHOOK_ALLOWED_PORTS: '443,8443',
  WEBHOOK_MAX_SUBSCRIPTIONS: '0',
  WEBHOOK_MAX_PER_ADDRESS: '0',
  WEBHOOK_MAX_ATTEMPTS: '1',
  WEBHOOK_DELIVERY_TIMEOUT_MS: '1000',
  WEBHOOK_MAX_CONCURRENT: '1',
  WEBHOOK_POOL_RETRY_MS: '1000',
  WEBHOOK_PAYLOAD_MAX_BYTES: '2048',
  WEBHOOK_APPROVAL_ARGS_MAX_BYTES: '0',
  WEBHOOK_APPROVAL_ARGS_MAX_DEPTH: '1',
  WEBHOOK_RESPONSE_MAX_BYTES: '1',
  WEBHOOK_TIMESTAMP_TOLERANCE_SEC: '30',
  WEBHOOK_DISABLE_THRESHOLD: '1',
  WEBHOOK_ROTATION_OVERLAP_MS: '0',
  WEBHOOK_LOG_RETENTION_DAYS: '4',
  WEBHOOK_RATE_CREATE_PER_MIN: '0',
  WEBHOOK_RATE_TEST_PER_MIN: '0',
  WEBHOOK_RATE_DELIVER_PER_MIN: '0',
};

/** parseConfig defaults when the webhook family is absent (parser unchanged). */
const DEFAULT_WEBHOOK_CONFIG = parseConfig({
  DOMAIN: 'example.test',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.test',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.test',
  SMTP_PASS: 'smtp-secret',
  TASK_SIGNING_SECRET: SYNTH_REQUIRED.TASK_SIGNING_SECRET,
}).webhooks;

type InputMode = (typeof INPUT_MODES)[number];

type ComposeCommand = {
  argv: string[];
  source: string;
};

type ComposeInput = {
  composeFile: string;
  mode: InputMode;
  /** Webhook-family (and public-edge) overrides for the mode under test. */
  webhookVars?: Record<string, string>;
  /** Mutated Compose text for the deletion negative control. */
  composeText?: string;
  /** Override the selected CLI (A/B/C compatibility tests). */
  compose?: ComposeCommand;
  /** CLI discovery env for probe/render; defaults to PATH/HOME/DOCKER_CONFIG only. */
  discovery?: Record<string, string>;
  /** Per-spawn bound for hanging-fixture tests; default is COMPOSE_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
};

/** Probe/render bounds live in spawnSync. Outer `timeout 180` is only a safety net. */
const COMPOSE_PROBE_TIMEOUT_MS = 15_000;
const COMPOSE_RENDER_TIMEOUT_MS = 30_000;
const COMPOSE_HANG_TIMEOUT_MS = 400;
const BACKEND_PATH_HELPER = 'oae-149-backend-helper';

/** Only PATH/HOME/DOCKER_CONFIG for CLI discovery. Never copy production env or read Docker auth. */
function cliDiscoveryEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: from.PATH ?? '/usr/bin:/bin',
    HOME: from.HOME ?? tmpdir(),
  };
  if (from.DOCKER_CONFIG) env.DOCKER_CONFIG = from.DOCKER_CONFIG;
  return env;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichOnPath(name: string, pathVar: string): string | undefined {
  for (const dir of pathVar.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded Compose spawn. `timeout` + SIGKILL is the implementation (Bun 1.2.21+).
 * Do not rely on timer callbacks around spawnSync; those cannot interrupt it.
 */
function spawnComposeSync(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) {
  return Bun.spawnSync(argv, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: options.timeoutMs,
    killSignal: 'SIGKILL',
  });
}

/** Probe `config --format json` only, with an actual subprocess timeout. Never download tools. */
function probeJsonConfig(
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number = COMPOSE_PROBE_TIMEOUT_MS,
): boolean {
  const work = mkdtempSync(join(tmpdir(), 'oae-149-probe-'));
  try {
    writeFileSync(join(work, 'compose.yaml'), 'services:\n  probe:\n    image: alpine\n');
    const spawned = spawnComposeSync(
      [...argv, '-f', join(work, 'compose.yaml'), 'config', '--format', 'json'],
      { cwd: work, env, timeoutMs },
    );
    if (spawned.exitedDueToTimeout || spawned.exitCode !== 0) return false;
    JSON.parse(Buffer.from(spawned.stdout).toString('utf8'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Prefer OAE_COMPOSE (resolved to an absolute path). Otherwise use PATH
 * `docker-compose` or `docker compose` after a JSON-config capability probe.
 * Incompatible PATH standalone falls through; incompatible explicit override fails.
 */
function resolveComposeCommand(
  from: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  timeoutMs: number = COMPOSE_PROBE_TIMEOUT_MS,
): ComposeCommand {
  const discovery = cliDiscoveryEnv(from);
  const explicit = from.OAE_COMPOSE?.trim();
  if (explicit) {
    const absolute = isAbsolute(explicit) ? resolve(explicit) : resolve(cwd, explicit);
    if (!isExecutableFile(absolute)) {
      throw new Error(
        `OAE_COMPOSE=${explicit} is not an executable (resolved ${absolute}). ` +
          'Point it at a Compose binary (config only), or unset it to use PATH ' +
          'docker-compose / docker compose. This test does not download Compose.',
      );
    }
    const command: ComposeCommand = { argv: [absolute], source: `OAE_COMPOSE=${absolute}` };
    if (!probeJsonConfig(command.argv, discovery, timeoutMs)) {
      throw new Error(
        `OAE_COMPOSE=${explicit} (resolved ${absolute}) does not support Compose JSON config. ` +
          'Point it at a compatible compose executable. Tests do not silently substitute another binary.',
      );
    }
    return command;
  }

  const standalone = whichOnPath('docker-compose', discovery.PATH);
  if (standalone && probeJsonConfig([standalone], discovery, timeoutMs)) {
    return { argv: [standalone], source: `PATH docker-compose=${standalone}` };
  }

  const docker = whichOnPath('docker', discovery.PATH);
  if (docker && probeJsonConfig([docker, 'compose'], discovery, timeoutMs)) {
    return { argv: [docker, 'compose'], source: `PATH docker compose (${docker})` };
  }

  throw new Error(
    'Docker Compose is required for #149 compose-webhooks tests but was not found. ' +
      'Set OAE_COMPOSE to a compose executable that supports `config --format json`, ' +
      'or install `docker compose` / `docker-compose` on PATH. ' +
      'Tests invoke `config` only and never download Compose.',
  );
}

const COMPOSE = resolveComposeCommand();

/** Helper lives only on the selected-backend PATH; A/B fixture PATH does not include it. */
const BACKEND_HELPER_DIR = mkdtempSync(join(tmpdir(), 'oae-149-backend-path-'));
writeExecutable(join(BACKEND_HELPER_DIR, BACKEND_PATH_HELPER), '#!/bin/sh\nexit 0\n');

/**
 * Discovery env that selected the module-level backend. A/B launchers validate
 * fixture inputs first, then restore PATH/HOME/DOCKER_CONFIG before exec.
 * Originally absent DOCKER_CONFIG is unset; never invented.
 */
const BACKEND_DISCOVERY = (() => {
  const env = cliDiscoveryEnv();
  env.PATH = `${BACKEND_HELPER_DIR}:${env.PATH}`;
  return env;
})();

afterAll(() => {
  rmSync(BACKEND_HELPER_DIR, { recursive: true, force: true });
});

/** Restore selected-backend discovery, require the PATH helper, then exec real Compose. */
function selectedBackendHandoffScript(): string {
  const restoreDockerConfig = BACKEND_DISCOVERY.DOCKER_CONFIG
    ? `export DOCKER_CONFIG=${shQuote(BACKEND_DISCOVERY.DOCKER_CONFIG)}`
    : 'unset DOCKER_CONFIG';
  return [
    `export PATH=${shQuote(BACKEND_DISCOVERY.PATH)}`,
    `export HOME=${shQuote(BACKEND_DISCOVERY.HOME)}`,
    restoreDockerConfig,
    `command -v ${BACKEND_PATH_HELPER} >/dev/null 2>&1 || { echo "missing backend PATH helper" >&2; exit 1; }`,
    `exec ${COMPOSE.argv.map(shQuote).join(' ')} "$@"`,
  ].join('\n');
}

/** Drop JSON-null keys (unset pass-through); keep empty strings for the parser. */
function omitNullEnv(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

function writeEnvFile(path: string, vars: Record<string, string>): void {
  const body = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
}

function secretPresent(serviceEnv: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(serviceEnv, key);
}

/**
 * Render the API service environment with official `config` only.
 * Interpolation uses explicit `--env-file synth.env`, not default-project `.env`
 * resolution. A required-only `.env` is written so bundled `env_file: .env`
 * services can still parse; it never carries webhook overrides.
 */
function renderApiServiceEnv(input: ComposeInput): Record<string, string> {
  const work = mkdtempSync(join(tmpdir(), 'oae-149-compose-'));
  try {
    const webhookVars = input.webhookVars ?? {};
    const synthPath = join(work, 'synth.env');
    const envFileVars =
      input.mode === 'env-file' ? { ...SYNTH_REQUIRED, ...webhookVars } : { ...SYNTH_REQUIRED };
    writeEnvFile(synthPath, envFileVars);
    writeEnvFile(join(work, '.env'), SYNTH_REQUIRED);

    const composePath = input.composeText ? join(work, 'compose.yaml') : input.composeFile;
    if (input.composeText) writeFileSync(composePath, input.composeText);

    const command = input.compose ?? COMPOSE;
    const args = [
      ...command.argv.slice(1),
      '-f',
      composePath,
      '--project-directory',
      work,
      '--env-file',
      synthPath,
      'config',
      '--format',
      'json',
    ];
    expect(args).toContain('config');
    expect(args).not.toContain('up');
    expect(args).not.toContain('run');
    expect(args).not.toContain('start');

    const timeoutMs = input.timeoutMs ?? COMPOSE_RENDER_TIMEOUT_MS;
    const spawned = spawnComposeSync([command.argv[0]!, ...args], {
      cwd: work,
      env: {
        ...(input.discovery ?? cliDiscoveryEnv()),
        ...(input.mode === 'shell' ? webhookVars : {}),
      },
      timeoutMs,
    });
    if (spawned.exitedDueToTimeout) {
      throw new Error(
        `Compose config timed out after ${timeoutMs}ms via ${command.source}. ` +
          'The subprocess was terminated. Tests do not hang on a stuck CLI.',
      );
    }
    if (spawned.exitCode !== 0) {
      const stderr = Buffer.from(spawned.stderr).toString('utf8');
      throw new Error(
        `Compose config failed (exit ${spawned.exitCode}) via ${command.source}. ${stderr}`,
      );
    }
    const parsed = JSON.parse(Buffer.from(spawned.stdout).toString('utf8')) as {
      services?: { api?: { environment?: Record<string, unknown> } };
    };
    const environment = parsed.services?.api?.environment;
    expect(environment && typeof environment === 'object').toBe(true);
    return omitNullEnv(environment ?? {});
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function expectWebhookDefaults(config: ReturnType<typeof parseConfig>['webhooks']): void {
  expect(config.enabled).toBe(DEFAULT_WEBHOOK_CONFIG.enabled);
  expect(config.signingSecret).toBeUndefined();
  expect(config.signingSecretPrevious).toBeUndefined();
  expect(config.allowPrivateTargets).toBe(DEFAULT_WEBHOOK_CONFIG.allowPrivateTargets);
  expect(config.allowedPorts).toEqual(DEFAULT_WEBHOOK_CONFIG.allowedPorts);
  expect(config.maxSubscriptions).toBe(DEFAULT_WEBHOOK_CONFIG.maxSubscriptions);
  expect(config.maxPerAddress).toBe(DEFAULT_WEBHOOK_CONFIG.maxPerAddress);
  expect(config.maxAttempts).toBe(DEFAULT_WEBHOOK_CONFIG.maxAttempts);
  expect(config.deliveryTimeoutMs).toBe(DEFAULT_WEBHOOK_CONFIG.deliveryTimeoutMs);
  expect(config.maxConcurrent).toBe(DEFAULT_WEBHOOK_CONFIG.maxConcurrent);
  expect(config.poolRetryMs).toBe(DEFAULT_WEBHOOK_CONFIG.poolRetryMs);
  expect(config.payloadMaxBytes).toBe(DEFAULT_WEBHOOK_CONFIG.payloadMaxBytes);
  expect(config.approvalArgsMaxBytes).toBe(DEFAULT_WEBHOOK_CONFIG.approvalArgsMaxBytes);
  expect(config.approvalArgsMaxDepth).toBe(DEFAULT_WEBHOOK_CONFIG.approvalArgsMaxDepth);
  expect(config.responseMaxBytes).toBe(DEFAULT_WEBHOOK_CONFIG.responseMaxBytes);
  expect(config.timestampToleranceSec).toBe(DEFAULT_WEBHOOK_CONFIG.timestampToleranceSec);
  expect(config.disableThreshold).toBe(DEFAULT_WEBHOOK_CONFIG.disableThreshold);
  expect(config.rotationOverlapMs).toBe(DEFAULT_WEBHOOK_CONFIG.rotationOverlapMs);
  expect(config.logRetentionDays).toBe(DEFAULT_WEBHOOK_CONFIG.logRetentionDays);
  expect(config.rateCreatePerMin).toBe(DEFAULT_WEBHOOK_CONFIG.rateCreatePerMin);
  expect(config.rateTestPerMin).toBe(DEFAULT_WEBHOOK_CONFIG.rateTestPerMin);
  expect(config.rateDeliverPerMin).toBe(DEFAULT_WEBHOOK_CONFIG.rateDeliverPerMin);
}

function expectAllOverrides(serviceEnv: Record<string, string>): void {
  for (const [key, value] of Object.entries(ALL_OVERRIDES)) {
    expect(serviceEnv[key]).toBe(value);
  }
  const webhooks = parseConfig(serviceEnv).webhooks;
  expect(webhooks.enabled).toBe(true);
  expect(webhooks.allowPrivateTargets).toBe(true);
  expect(webhooks.allowedPorts).toEqual([443, 8443]);
  expect(webhooks.maxSubscriptions).toBe(0);
  expect(webhooks.maxPerAddress).toBe(0);
  expect(webhooks.maxAttempts).toBe(1);
  expect(webhooks.deliveryTimeoutMs).toBe(1000);
  expect(webhooks.maxConcurrent).toBe(1);
  expect(webhooks.poolRetryMs).toBe(1000);
  expect(webhooks.payloadMaxBytes).toBe(2048);
  expect(webhooks.approvalArgsMaxBytes).toBe(0);
  expect(webhooks.approvalArgsMaxDepth).toBe(1);
  expect(webhooks.responseMaxBytes).toBe(1);
  expect(webhooks.timestampToleranceSec).toBe(30);
  expect(webhooks.disableThreshold).toBe(1);
  expect(webhooks.rotationOverlapMs).toBe(0);
  expect(webhooks.logRetentionDays).toBe(4);
  expect(webhooks.rateCreatePerMin).toBe(0);
  expect(webhooks.rateTestPerMin).toBe(0);
  expect(webhooks.rateDeliverPerMin).toBe(0);
}

describe('#149 Compose webhook environment', () => {
  test('selects OAE_COMPOSE or PATH Compose and invokes config only', () => {
    expect(COMPOSE.argv.length > 0).toBe(true);
    expect(COMPOSE.source.includes('OAE_COMPOSE') || COMPOSE.source.includes('PATH')).toBe(true);
  });

  test('example env files document all 22 keys and keep optional secrets commented', () => {
    for (const variant of VARIANTS) {
      const example = readFileSync(join(REPO_DIR, variant.example), 'utf8');
      for (const key of WEBHOOK_KEYS) {
        expect(example.includes(key)).toBe(true);
      }
      expect(example).toMatch(/^WEBHOOKS_ENABLED=false$/m);
      expect(example).toMatch(/^# WEBHOOK_SIGNING_SECRET=$/m);
      expect(example).toMatch(/^# WEBHOOK_SIGNING_SECRET_PREVIOUS=$/m);
      expect(example).not.toMatch(/^WEBHOOK_SIGNING_SECRET=/m);
      expect(example).not.toMatch(/^WEBHOOK_SIGNING_SECRET_PREVIOUS=/m);
      expect(example).not.toContain('标注 min 0');
      expect(example.includes('同名已导出的 shell 变量优先于 env-file')).toBe(true);
      expect(example.includes('MAX_ATTEMPTS<=11')).toBe(true);
      expect(example.includes('JSON_BODY_LIMIT_BYTES')).toBe(true);
      expect(example.includes('Docker Compose v2+')).toBe(true);
    }
  });

  for (const variant of VARIANTS) {
    const composeFile = join(REPO_DIR, variant.file);

    for (const mode of INPUT_MODES) {
      const label = `${variant.name} ${mode}`;

      test(`${label}: unset webhook env keeps parseConfig defaults and valid boot`, () => {
        const serviceEnv = renderApiServiceEnv({ composeFile, mode });
        expect(serviceEnv.WEBHOOKS_ENABLED).toBe('false');
        expect(serviceEnv.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe('false');
        expect(serviceEnv.OAE_PUBLIC_EDGE).toBe('false');
        for (const key of OPTIONAL_SECRETS) {
          expect(secretPresent(serviceEnv, key)).toBe(false);
        }
        expectWebhookDefaults(parseConfig(serviceEnv).webhooks);
      });

      test(`${label}: WEBHOOKS_ENABLED=true reaches parser`, () => {
        const serviceEnv = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: { WEBHOOKS_ENABLED: 'true' },
        });
        expect(serviceEnv.WEBHOOKS_ENABLED).toBe('true');
        expect(parseConfig(serviceEnv).webhooks.enabled).toBe(true);
      });

      test(`${label}: every webhook override including zeros and port CSV`, () => {
        expectAllOverrides(renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: ALL_OVERRIDES,
        }));
      });

      test(`${label}: optional secrets absent / valid / empty / short`, () => {
        const absent = renderApiServiceEnv({ composeFile, mode });
        expect(secretPresent(absent, 'WEBHOOK_SIGNING_SECRET')).toBe(false);
        expect(secretPresent(absent, 'WEBHOOK_SIGNING_SECRET_PREVIOUS')).toBe(false);
        const absentConfig = parseConfig(absent);
        expect(absentConfig.webhooks.signingSecret).toBeUndefined();
        expect(absentConfig.webhooks.signingSecretPrevious).toBeUndefined();
        expect(absentConfig.webhooks.enabled).toBe(false);

        const valid = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: {
            WEBHOOK_SIGNING_SECRET: SYNTH_SECRET,
            WEBHOOK_SIGNING_SECRET_PREVIOUS: SYNTH_SECRET_PREVIOUS,
          },
        });
        const validConfig = parseConfig(valid);
        expect(validConfig.webhooks.signingSecret === SYNTH_SECRET).toBe(true);
        expect(validConfig.webhooks.signingSecretPrevious === SYNTH_SECRET_PREVIOUS).toBe(true);
        expect(validConfig.webhooks.signingSecret === SYNTH_SECRET_PREVIOUS).toBe(false);
        expect(validConfig.webhooks.signingSecretPrevious === SYNTH_SECRET).toBe(false);

        const emptyCurrent = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: { WEBHOOK_SIGNING_SECRET: '' },
        });
        expect(emptyCurrent.WEBHOOK_SIGNING_SECRET).toBe('');
        expect(() => parseConfig(emptyCurrent)).toThrow();

        const emptyPrevious = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: { WEBHOOK_SIGNING_SECRET_PREVIOUS: '' },
        });
        expect(emptyPrevious.WEBHOOK_SIGNING_SECRET_PREVIOUS).toBe('');
        expect(() => parseConfig(emptyPrevious)).toThrow();

        const shortCurrent = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: { WEBHOOK_SIGNING_SECRET: 'too-short' },
        });
        expect((shortCurrent.WEBHOOK_SIGNING_SECRET?.length ?? 0) < 32).toBe(true);
        expect(() => parseConfig(shortCurrent)).toThrow();

        const shortPrevious = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: { WEBHOOK_SIGNING_SECRET_PREVIOUS: 'too-short' },
        });
        expect((shortPrevious.WEBHOOK_SIGNING_SECRET_PREVIOUS?.length ?? 0) < 32).toBe(true);
        expect(() => parseConfig(shortPrevious)).toThrow();
      });

      test(`${label}: OAE_PUBLIC_EDGE=true forces private targets false`, () => {
        const serviceEnv = renderApiServiceEnv({
          composeFile,
          mode,
          webhookVars: {
            OAE_PUBLIC_EDGE: 'true',
            WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
          },
        });
        // Compose still forwards the requested value; parseConfig forces false.
        expect(serviceEnv.OAE_PUBLIC_EDGE).toBe('true');
        expect(serviceEnv.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe('true');
        expect(parseConfig(serviceEnv).webhooks.allowPrivateTargets).toBe(false);
      });
    }

    test(`${variant.name}: removing WEBHOOKS_ENABLED wiring drops the override`, () => {
      const live = readFileSync(composeFile, 'utf8');
      expect(live).toMatch(/^\s+WEBHOOKS_ENABLED:\s*\$\{WEBHOOKS_ENABLED:-false\}\s*$/m);

      const enabled = renderApiServiceEnv({
        composeFile,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
      });
      expect(enabled.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(enabled).webhooks.enabled).toBe(true);

      const mutated = live.replace(/^\s+WEBHOOKS_ENABLED:\s*\$\{WEBHOOKS_ENABLED:-false\}\s*$/m, '');
      const stripped = renderApiServiceEnv({
        composeFile,
        mode: 'shell',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        composeText: mutated,
      });
      expect(secretPresent(stripped, 'WEBHOOKS_ENABLED')).toBe(false);
      expect(parseConfig(stripped).webhooks.enabled).toBe(false);
    });
  }
});

describe('#149 Compose CLI compatibility A/B/C', () => {
  const apiOnly = join(REPO_DIR, 'compose.api-only.yaml');
  const backendHandoff = selectedBackendHandoffScript();

  test('A: incompatible PATH docker-compose falls through; explicit override fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-a-'));
    try {
      const legacyDir = join(root, 'legacy');
      const altDir = join(root, 'alt');
      mkdirSync(legacyDir);
      mkdirSync(altDir);
      writeExecutable(
        join(legacyDir, 'docker-compose'),
        '#!/bin/sh\necho "legacy compose lacks JSON config" >&2\nexit 1\n',
      );
      writeExecutable(
        join(altDir, 'docker'),
        [
          '#!/bin/sh',
          'if [ "$1" != "compose" ]; then echo "not compose" >&2; exit 1; fi',
          'shift',
          backendHandoff,
          '',
        ].join('\n'),
      );

      const path = `${legacyDir}:${altDir}:/usr/bin:/bin`;
      const selected = resolveComposeCommand({ PATH: path, HOME: root });
      expect(selected.source.includes('docker compose')).toBe(true);
      expect(selected.argv[0] === join(altDir, 'docker')).toBe(true);

      const rendered = renderApiServiceEnv({
        composeFile: apiOnly,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        compose: selected,
      });
      expect(rendered.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(rendered).webhooks.enabled).toBe(true);

      let explicitError = '';
      try {
        resolveComposeCommand({
          PATH: path,
          HOME: root,
          OAE_COMPOSE: join(legacyDir, 'docker-compose'),
        });
      } catch (error) {
        explicitError = error instanceof Error ? error.message : String(error);
      }
      expect(explicitError.includes('does not support Compose JSON config')).toBe(true);
      expect(explicitError.includes('do not silently substitute')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('B: DOCKER_CONFIG discovery reaches probe and render; fixture is not real Compose', () => {
    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-b-'));
    try {
      const dockerConfig = join(root, 'docker-config');
      mkdirSync(dockerConfig);
      const docker = join(root, 'docker');
      writeExecutable(
        docker,
        [
          '#!/bin/sh',
          '# Hermetic launcher: require forwarded DOCKER_CONFIG path only; never read its contents.',
          `if [ "$DOCKER_CONFIG" != ${shQuote(dockerConfig)} ]; then`,
          '  echo "missing discovery DOCKER_CONFIG" >&2',
          '  exit 1',
          'fi',
          'if [ "$1" != "compose" ]; then echo "not compose" >&2; exit 1; fi',
          'shift',
          // Restore selected-backend discovery after the fixture assertion.
          backendHandoff,
          '',
        ].join('\n'),
      );

      const discovery = { PATH: `${root}:/usr/bin:/bin`, HOME: root, DOCKER_CONFIG: dockerConfig };
      const selected = resolveComposeCommand(discovery);
      expect(selected.argv[0] === docker).toBe(true);

      const rendered = renderApiServiceEnv({
        composeFile: apiOnly,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        compose: selected,
        discovery,
      });
      expect(rendered.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(rendered).webhooks.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('C: relative and absolute OAE_COMPOSE resolve to the same rendering', () => {
    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-c-'));
    try {
      const relativeName = 'rel-compose';
      writeExecutable(join(root, relativeName), `#!/bin/sh\n${backendHandoff}\n`);
      const viaRel = resolveComposeCommand({ ...process.env, OAE_COMPOSE: `./${relativeName}` }, root);
      const viaAbs = resolveComposeCommand(
        { ...process.env, OAE_COMPOSE: join(root, relativeName) },
        root,
      );
      expect(isAbsolute(viaRel.argv[0]!)).toBe(true);
      expect(viaRel.argv[0] === viaAbs.argv[0]).toBe(true);

      const fromRel = renderApiServiceEnv({
        composeFile: apiOnly,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        compose: viaRel,
      });
      const fromAbs = renderApiServiceEnv({
        composeFile: apiOnly,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        compose: viaAbs,
      });
      expect(fromRel.WEBHOOKS_ENABLED === fromAbs.WEBHOOKS_ENABLED).toBe(true);
      expect(parseConfig(fromRel).webhooks.enabled).toBe(true);
      expect(parseConfig(fromAbs).webhooks.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('A/B handoff restores original PATH helper without bypassing B discovery', () => {
    expect(backendHandoff.includes(`export PATH=${shQuote(BACKEND_DISCOVERY.PATH)}`)).toBe(true);
    expect(BACKEND_DISCOVERY.PATH.includes(BACKEND_HELPER_DIR)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-path-'));
    try {
      const dockerConfig = join(root, 'docker-config');
      mkdirSync(dockerConfig);
      const docker = join(root, 'docker');
      writeExecutable(
        docker,
        [
          '#!/bin/sh',
          `if [ "$DOCKER_CONFIG" != ${shQuote(dockerConfig)} ]; then`,
          '  echo "missing discovery DOCKER_CONFIG" >&2',
          '  exit 1',
          'fi',
          `if command -v ${BACKEND_PATH_HELPER} >/dev/null 2>&1; then`,
          '  echo "helper leaked onto fixture PATH" >&2',
          '  exit 1',
          'fi',
          'if [ "$1" != "compose" ]; then echo "not compose" >&2; exit 1; fi',
          'shift',
          backendHandoff,
          '',
        ].join('\n'),
      );

      const discovery = { PATH: `${root}:/usr/bin:/bin`, HOME: root, DOCKER_CONFIG: dockerConfig };
      expect(discovery.PATH.includes(BACKEND_HELPER_DIR)).toBe(false);
      const selected = resolveComposeCommand(discovery);
      expect(selected.argv[0] === docker).toBe(true);

      const rendered = renderApiServiceEnv({
        composeFile: apiOnly,
        mode: 'env-file',
        webhookVars: { WEBHOOKS_ENABLED: 'true' },
        compose: selected,
        discovery,
      });
      expect(rendered.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(rendered).webhooks.enabled).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hanging probe times out, falls through or fails explicitly, and kills the child', () => {
    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-hang-probe-'));
    try {
      const hangDir = join(root, 'hang');
      const altDir = join(root, 'alt');
      mkdirSync(hangDir);
      mkdirSync(altDir);
      const hangCompose = join(hangDir, 'docker-compose');
      writeExecutable(hangCompose, '#!/bin/sh\nexec /bin/sleep 1111\n');
      writeExecutable(
        join(altDir, 'docker'),
        [
          '#!/bin/sh',
          'if [ "$1" != "compose" ]; then echo "not compose" >&2; exit 1; fi',
          'shift',
          backendHandoff,
          '',
        ].join('\n'),
      );

      const hangStarted = Date.now();
      const hangProbe = spawnComposeSync([hangCompose, 'config', '--format', 'json'], {
        cwd: root,
        env: cliDiscoveryEnv({ PATH: hangDir, HOME: root }),
        timeoutMs: COMPOSE_HANG_TIMEOUT_MS,
      });
      expect(Date.now() - hangStarted < COMPOSE_HANG_TIMEOUT_MS + 1500).toBe(true);
      expect(hangProbe.exitedDueToTimeout === true).toBe(true);
      expect(processExists(hangProbe.pid)).toBe(false);

      const pathStarted = Date.now();
      const selected = resolveComposeCommand(
        { PATH: `${hangDir}:${altDir}:/usr/bin:/bin`, HOME: root },
        root,
        COMPOSE_HANG_TIMEOUT_MS,
      );
      expect(Date.now() - pathStarted < COMPOSE_HANG_TIMEOUT_MS + 2000).toBe(true);
      expect(selected.source.includes('docker compose')).toBe(true);
      expect(selected.argv[0] === join(altDir, 'docker')).toBe(true);

      const explicitStarted = Date.now();
      let explicitError = '';
      try {
        resolveComposeCommand(
          { PATH: `${hangDir}:/usr/bin:/bin`, HOME: root, OAE_COMPOSE: hangCompose },
          root,
          COMPOSE_HANG_TIMEOUT_MS,
        );
      } catch (error) {
        explicitError = error instanceof Error ? error.message : String(error);
      }
      expect(Date.now() - explicitStarted < COMPOSE_HANG_TIMEOUT_MS + 2000).toBe(true);
      expect(explicitError.includes('does not support Compose JSON config')).toBe(true);
      expect(explicitError.includes('do not silently substitute')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hanging render times out with an explicit error and kills the child', () => {
    const root = mkdtempSync(join(tmpdir(), 'oae-149-cli-hang-render-'));
    try {
      const hang = join(root, 'hang-compose');
      writeExecutable(hang, '#!/bin/sh\nexec /bin/sleep 1111\n');

      const hangStarted = Date.now();
      const hangRender = spawnComposeSync([hang, 'config', '--format', 'json'], {
        cwd: root,
        env: cliDiscoveryEnv({ PATH: root, HOME: root }),
        timeoutMs: COMPOSE_HANG_TIMEOUT_MS,
      });
      expect(Date.now() - hangStarted < COMPOSE_HANG_TIMEOUT_MS + 1500).toBe(true);
      expect(hangRender.exitedDueToTimeout === true).toBe(true);
      expect(processExists(hangRender.pid)).toBe(false);

      const renderStarted = Date.now();
      let renderError = '';
      try {
        renderApiServiceEnv({
          composeFile: apiOnly,
          mode: 'env-file',
          webhookVars: { WEBHOOKS_ENABLED: 'true' },
          compose: { argv: [hang], source: 'hanging-render' },
          timeoutMs: COMPOSE_HANG_TIMEOUT_MS,
        });
      } catch (error) {
        renderError = error instanceof Error ? error.message : String(error);
      }
      expect(Date.now() - renderStarted < COMPOSE_HANG_TIMEOUT_MS + 2000).toBe(true);
      expect(renderError.includes('timed out')).toBe(true);
      expect(renderError.includes('terminated')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
