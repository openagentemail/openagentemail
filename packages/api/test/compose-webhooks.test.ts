// 必须在导入 config 单例之前填齐进程环境，避免模块加载时 parseConfig 抛错。
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const { parseConfig } = await import('../src/lib/config.ts');

/** FC 安装的官方独立 Compose；测试只允许 config，禁止 up/run/start。 */
const COMPOSE_BIN = '/home/ops/materials/149/tools/docker-compose';
const REPO_DIR = join(import.meta.dir, '..', '..', '..');

/** 与 r0 / config.ts 对齐的 22 个 WEBHOOK(S) 键。 */
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

/** 合成夹具；长度断言用，测试失败信息只报长度，不打印密钥正文。 */
const SYNTH_SECRET = 'w'.repeat(32);
const SYNTH_SECRET_PREVIOUS = 'p'.repeat(32);

const VARIANTS = [
  { name: 'bundled', file: 'compose.yaml', example: '.env.example' },
  { name: 'api-only', file: 'compose.api-only.yaml', example: '.env.api-only.example' },
] as const;

/** 合成部署输入：满足两套 Compose 插值，不含生产值。 */
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

/** parseConfig 在 webhook 族全部缺席时的安全默认（对照用，不改 parser）。 */
const DEFAULT_WEBHOOK_CONFIG = parseConfig({
  DOMAIN: 'example.test',
  API_KEYS: 'admin-key',
  IMAP_USER: 'catch-all@example.test',
  IMAP_PASS: 'imap-secret',
  SMTP_USER: 'catch-all@example.test',
  SMTP_PASS: 'smtp-secret',
  TASK_SIGNING_SECRET: SYNTH_REQUIRED.TASK_SIGNING_SECRET,
}).webhooks;

type ComposeInput = {
  composeFile: string;
  /** 写入合成 --env-file / 项目 .env */
  envFile: Record<string, string>;
  /** 仅 shell 路径：注入进程环境 */
  shell?: Record<string, string>;
  /** 变异后的 Compose 文本（负回归） */
  composeText?: string;
};

/** 把 Compose JSON 环境里的 null 当成缺席，空串保留给 parser 判无效。 */
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

/** 仅调用官方二进制的 config；参数硬编码，避免误跑 daemon 操作。 */
function renderApiServiceEnv(input: ComposeInput): Record<string, string> {
  const work = mkdtempSync(join(tmpdir(), 'oae-149-compose-'));
  try {
    writeEnvFile(join(work, '.env'), input.envFile);
    const composePath = input.composeText
      ? join(work, 'compose.yaml')
      : input.composeFile;
    if (input.composeText) writeFileSync(composePath, input.composeText);

    const args = [
      '-f',
      composePath,
      '--project-directory',
      work,
      '--env-file',
      join(work, '.env'),
      'config',
      '--format',
      'json',
    ];
    expect(args).toContain('config');
    expect(args).not.toContain('up');
    expect(args).not.toContain('run');
    expect(args).not.toContain('start');

    const spawned = Bun.spawnSync([COMPOSE_BIN, ...args], {
      cwd: work,
      env: {
        PATH: process.env.PATH ?? '/usr/bin',
        HOME: process.env.HOME ?? work,
        ...input.shell,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(spawned.exitCode).toBe(0);
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

function secretPresent(serviceEnv: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(serviceEnv, key);
}

describe('#149 Compose webhook environment', () => {
  test('official Compose binary is v5.5.1 and only used for config', () => {
    const version = Bun.spawnSync([COMPOSE_BIN, 'version'], { stdout: 'pipe' });
    expect(version.exitCode).toBe(0);
    expect(Buffer.from(version.stdout).toString('utf8')).toContain('v5.5.1');
  });

  test('example env files document all 22 keys and keep optional secrets commented', () => {
    for (const variant of VARIANTS) {
      const example = readFileSync(join(REPO_DIR, variant.example), 'utf8');
      for (const key of WEBHOOK_KEYS) {
        expect(example.includes(key)).toBe(true);
      }
      expect(example).toMatch(/^WEBHOOKS_ENABLED=false$/m);
      // 可选密钥只能以注释出现，禁止发明默认值
      expect(example).toMatch(/^# WEBHOOK_SIGNING_SECRET=$/m);
      expect(example).toMatch(/^# WEBHOOK_SIGNING_SECRET_PREVIOUS=$/m);
      expect(example).not.toMatch(/^WEBHOOK_SIGNING_SECRET=/m);
      expect(example).not.toMatch(/^WEBHOOK_SIGNING_SECRET_PREVIOUS=/m);
    }
  });

  for (const variant of VARIANTS) {
    const composeFile = join(REPO_DIR, variant.file);

    test(`${variant.name}: unset webhook env keeps parseConfig defaults and valid boot`, () => {
      const serviceEnv = renderApiServiceEnv({
        composeFile,
        envFile: SYNTH_REQUIRED,
      });
      expect(serviceEnv.WEBHOOKS_ENABLED).toBe('false');
      expect(serviceEnv.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe('false');
      expect(serviceEnv.OAE_PUBLIC_EDGE).toBe('false');
      for (const key of OPTIONAL_SECRETS) {
        expect(secretPresent(serviceEnv, key)).toBe(false);
      }
      const config = parseConfig(serviceEnv);
      expectWebhookDefaults(config.webhooks);
    });

    test(`${variant.name}: env-file WEBHOOKS_ENABLED=true reaches parser`, () => {
      const serviceEnv = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, WEBHOOKS_ENABLED: 'true' },
      });
      expect(serviceEnv.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(serviceEnv).webhooks.enabled).toBe(true);
    });

    test(`${variant.name}: shell WEBHOOKS_ENABLED=true reaches parser`, () => {
      const serviceEnv = renderApiServiceEnv({
        composeFile,
        envFile: SYNTH_REQUIRED,
        shell: { WEBHOOKS_ENABLED: 'true' },
      });
      expect(serviceEnv.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(serviceEnv).webhooks.enabled).toBe(true);
    });

    test(`${variant.name}: every webhook override including zeros and port CSV`, () => {
      const overrides: Record<string, string> = {
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
      const serviceEnv = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, ...overrides },
      });
      for (const [key, value] of Object.entries(overrides)) {
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
    });

    test(`${variant.name}: optional signing secrets absent / valid / invalid`, () => {
      const absent = renderApiServiceEnv({
        composeFile,
        envFile: SYNTH_REQUIRED,
      });
      expect(secretPresent(absent, 'WEBHOOK_SIGNING_SECRET')).toBe(false);
      expect(secretPresent(absent, 'WEBHOOK_SIGNING_SECRET_PREVIOUS')).toBe(false);
      const absentConfig = parseConfig(absent);
      expect(absentConfig.webhooks.signingSecret).toBeUndefined();
      expect(absentConfig.webhooks.signingSecretPrevious).toBeUndefined();
      expect(absentConfig.webhooks.enabled).toBe(false);

      const valid = renderApiServiceEnv({
        composeFile,
        envFile: {
          ...SYNTH_REQUIRED,
          WEBHOOK_SIGNING_SECRET: SYNTH_SECRET,
          WEBHOOK_SIGNING_SECRET_PREVIOUS: SYNTH_SECRET_PREVIOUS,
        },
      });
      expect(valid.WEBHOOK_SIGNING_SECRET?.length).toBe(32);
      expect(valid.WEBHOOK_SIGNING_SECRET_PREVIOUS?.length).toBe(32);
      const validConfig = parseConfig(valid);
      expect(validConfig.webhooks.signingSecret?.length).toBe(32);
      expect(validConfig.webhooks.signingSecretPrevious?.length).toBe(32);

      const empty = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, WEBHOOK_SIGNING_SECRET: '' },
      });
      expect(empty.WEBHOOK_SIGNING_SECRET).toBe('');
      expect(() => parseConfig(empty)).toThrow();

      const short = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, WEBHOOK_SIGNING_SECRET_PREVIOUS: 'too-short' },
      });
      expect(short.WEBHOOK_SIGNING_SECRET_PREVIOUS?.length).toBeLessThan(32);
      expect(() => parseConfig(short)).toThrow();
    });

    test(`${variant.name}: OAE_PUBLIC_EDGE=true forces private targets false`, () => {
      const serviceEnv = renderApiServiceEnv({
        composeFile,
        envFile: {
          ...SYNTH_REQUIRED,
          OAE_PUBLIC_EDGE: 'true',
          WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
        },
      });
      // Compose 仍原样传递请求值；生效 false 来自既有 parseConfig 优先级
      expect(serviceEnv.OAE_PUBLIC_EDGE).toBe('true');
      expect(serviceEnv.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe('true');
      expect(parseConfig(serviceEnv).webhooks.allowPrivateTargets).toBe(false);
    });

    test(`${variant.name}: removing WEBHOOKS_ENABLED wiring drops the override`, () => {
      const live = readFileSync(composeFile, 'utf8');
      expect(live).toMatch(/^\s+WEBHOOKS_ENABLED:\s*\$\{WEBHOOKS_ENABLED:-false\}\s*$/m);

      const enabled = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, WEBHOOKS_ENABLED: 'true' },
      });
      expect(enabled.WEBHOOKS_ENABLED).toBe('true');
      expect(parseConfig(enabled).webhooks.enabled).toBe(true);

      const mutated = live.replace(/^\s+WEBHOOKS_ENABLED:\s*\$\{WEBHOOKS_ENABLED:-false\}\s*$/m, '');
      const stripped = renderApiServiceEnv({
        composeFile,
        envFile: { ...SYNTH_REQUIRED, WEBHOOKS_ENABLED: 'true' },
        composeText: mutated,
      });
      expect(secretPresent(stripped, 'WEBHOOKS_ENABLED')).toBe(false);
      expect(parseConfig(stripped).webhooks.enabled).toBe(false);
    });
  }
});
