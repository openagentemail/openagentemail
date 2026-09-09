// Fill process env before importing the config singleton so parseConfig does not throw.
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

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
};

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeDockerComposePlugin(dockerPath: string): boolean {
  const probe = Bun.spawnSync([dockerPath, 'compose', 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return probe.exitCode === 0;
}

/**
 * Prefer OAE_COMPOSE (FC/local explicit binary). Otherwise use PATH
 * `docker-compose` or `docker compose`. Never download tools; never skip.
 */
function resolveComposeCommand(): ComposeCommand {
  const explicit = process.env.OAE_COMPOSE?.trim();
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(
        `OAE_COMPOSE=${explicit} is not an executable. Point it at a Compose ` +
          'binary (config only), or unset it to use PATH docker-compose / docker compose. ' +
          'This test does not download Compose.',
      );
    }
    return { argv: [explicit], source: `OAE_COMPOSE=${explicit}` };
  }

  const standalone = Bun.which('docker-compose');
  if (standalone) {
    return { argv: [standalone], source: `PATH docker-compose=${standalone}` };
  }

  const docker = Bun.which('docker');
  if (docker && probeDockerComposePlugin(docker)) {
    return { argv: [docker, 'compose'], source: `PATH docker compose (${docker})` };
  }

  throw new Error(
    'Docker Compose is required for #149 compose-webhooks tests but was not found. ' +
      'Set OAE_COMPOSE to a compose executable, or install `docker compose` / `docker-compose` on PATH. ' +
      'Tests invoke `config` only and never download Compose.',
  );
}

const COMPOSE = resolveComposeCommand();

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

    const args = [
      ...COMPOSE.argv.slice(1),
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

    const spawned = Bun.spawnSync([COMPOSE.argv[0]!, ...args], {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '/usr/bin',
        HOME: process.env.HOME ?? work,
        ...(input.mode === 'shell' ? webhookVars : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (spawned.exitCode !== 0) {
      const stderr = Buffer.from(spawned.stderr).toString('utf8');
      throw new Error(
        `Compose config failed (exit ${spawned.exitCode}) via ${COMPOSE.source}. ${stderr}`,
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
    expect(COMPOSE.source.includes('/home/ops/materials/') && !process.env.OAE_COMPOSE).toBe(false);
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
