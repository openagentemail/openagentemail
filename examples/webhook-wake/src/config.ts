/** Static mapping loader. Request bodies cannot choose a terminal or command. */

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isDisplayedSecret,
  isDomain,
  isMailbox,
  isRouteKey,
  isSubscriptionId,
  isTerminalHandle,
  normalizeDomain,
  normalizeMailbox,
} from './ids.ts';
import type { ReceiverConfig, ReceiverMode, RouteBinding } from './types.ts';

export const DEFAULT_BODY_LIMIT = 16 * 1024;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_RETENTION_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_MAX_RECORDS = 10_000;

export type FileRouteSpec = {
  subscriptionId: string;
  domain: string;
  mailbox: string;
  secretFile: string;
  previousSecretFile?: string | null;
  terminal: string;
  active?: unknown;
  stale?: unknown;
};

export type FileConfig = {
  listen?: { host?: string; port?: number };
  /** Absent defaults to observe. A present invalid value fails load. */
  mode?: string;
  canaryTerminal?: string | null;
  orcaBinary?: string;
  bodyLimitBytes?: number;
  timestampToleranceSec?: number;
  maxV1Signatures?: number;
  maxHeaderBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrent?: number;
  sendTimeoutMs?: number;
  outputCapBytes?: number;
  wakeHistoryLimit?: number;
  dedup?: { path?: string; retentionMs?: number; maxRecords?: number };
  alertHook?: { url?: string | null; timeoutMs?: number };
  /** Named object only. Arrays become index keys and are rejected at load. */
  routes?: Record<string, FileRouteSpec>;
};

function assertSecretFileMode(path: string, mode: number): void {
  // Linux (and other POSIX) deployment: group/other bits must be off.
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return;
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`secret_insecure_mode:${path}`);
  }
}

function readSecretFile(path: string): string {
  const resolved = resolve(path);
  const nofollow = constants.O_NOFOLLOW;
  const flags = typeof nofollow === 'number' ? constants.O_RDONLY | nofollow : constants.O_RDONLY;
  let fd: number;
  try {
    fd = openSync(resolved, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EPERM') {
      throw new Error(`secret_symlink:${path}`);
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`secret_not_file:${path}`);
    }
    assertSecretFileMode(path, st.mode);
    const value = readFileSync(fd, 'utf8').trim();
    if (!isDisplayedSecret(value)) {
      throw new Error('secret_format_invalid');
    }
    return value;
  } finally {
    closeSync(fd);
  }
}

function requireRouteMap(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config_invalid:routes');
  }
  return value as Record<string, unknown>;
}

function requireRouteSpec(value: unknown, routeKey: string): FileRouteSpec {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`config_invalid:route:${routeKey}`);
  }
  return value as FileRouteSpec;
}

function optionalPositiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`config_invalid:${field}`);
  }
  return value;
}

/** Zero is valid (history off, ephemeral listen port). */
function optionalNonNegInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`config_invalid:${field}`);
  }
  return value;
}

function optionalPort(value: unknown, fallback: number): number {
  const port = optionalNonNegInt(value, 'listen.port', fallback);
  if (port > 65535) {
    throw new Error('config_invalid:listen.port');
  }
  return port;
}

function optionalRetentionMs(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_RETENTION_MS) {
    throw new Error('config_invalid:dedup.retentionMs');
  }
  return value;
}

export function canaryTerminalBound(routes: RouteBinding[], canaryTerminal: string | null): boolean {
  if (!canaryTerminal) return false;
  return routes.some((r) => r.terminal === canaryTerminal && r.active && !r.stale);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`config_invalid:${field}`);
  }
  return value.trim();
}

export function loadSecretFiles(spec: FileRouteSpec): { secret: string; previousSecret?: string } {
  const secret = readSecretFile(spec.secretFile);
  const previous =
    spec.previousSecretFile && spec.previousSecretFile.trim()
      ? readSecretFile(spec.previousSecretFile)
      : undefined;
  return { secret, previousSecret: previous };
}

export function parseFileConfig(raw: FileConfig, options?: { loadSecrets?: boolean }): ReceiverConfig {
  if (raw.mode !== undefined && raw.mode !== 'observe' && raw.mode !== 'canary') {
    throw new Error('config_invalid:mode');
  }
  const mode: ReceiverMode = raw.mode === 'canary' ? 'canary' : 'observe';
  const routesIn = requireRouteMap(raw.routes);
  const routes: RouteBinding[] = [];

  for (const [routeKey, rawSpec] of Object.entries(routesIn)) {
    const spec = requireRouteSpec(rawSpec, routeKey);
    if (!isRouteKey(routeKey)) {
      throw new Error(`config_invalid_route_key:${routeKey}`);
    }
    const subscriptionId = requireString(spec.subscriptionId, 'subscriptionId');
    const domain = normalizeDomain(requireString(spec.domain, 'domain'));
    const mailbox = normalizeMailbox(requireString(spec.mailbox, 'mailbox'));
    const terminal = requireString(spec.terminal, 'terminal');
    if (!isSubscriptionId(subscriptionId)) throw new Error('config_invalid:subscriptionId');
    if (!isDomain(domain)) throw new Error('config_invalid:domain');
    if (!isMailbox(mailbox)) throw new Error('config_invalid:mailbox');
    if (!isTerminalHandle(terminal)) throw new Error('config_invalid:terminal');
    if (spec.active !== undefined && typeof spec.active !== 'boolean') {
      throw new Error('config_invalid:active');
    }
    if (spec.stale !== undefined && typeof spec.stale !== 'boolean') {
      throw new Error('config_invalid:stale');
    }

    let secret = '';
    let previousSecret: string | undefined;
    if (options?.loadSecrets !== false) {
      const loaded = loadSecretFiles(spec);
      secret = loaded.secret;
      previousSecret = loaded.previousSecret;
    }

    routes.push({
      routeKey,
      subscriptionId,
      domain,
      mailbox,
      secret,
      previousSecret,
      terminal,
      active: spec.active !== false,
      stale: spec.stale === true,
    });
  }

  const canaryTerminal = raw.canaryTerminal ? raw.canaryTerminal.trim() : null;
  if (canaryTerminal && !isTerminalHandle(canaryTerminal)) {
    throw new Error('config_invalid:canaryTerminal');
  }
  if (mode === 'canary' && !canaryTerminal) {
    throw new Error('config_invalid:canary_requires_terminal');
  }
  if (mode === 'canary' && !canaryTerminalBound(routes, canaryTerminal)) {
    throw new Error('config_invalid:canary_terminal_unbound');
  }

  const alertUrl = raw.alertHook?.url ?? null;
  if (alertUrl != null && typeof alertUrl !== 'string') {
    throw new Error('config_invalid:alertHook.url');
  }

  return {
    listen: {
      host: typeof raw.listen?.host === 'string' && raw.listen.host.trim() ? raw.listen.host : '127.0.0.1',
      port: optionalPort(raw.listen?.port, 8787),
    },
    mode,
    canaryTerminal,
    orcaBinary: raw.orcaBinary ?? '/usr/local/bin/orca',
    bodyLimitBytes: optionalPositiveInt(raw.bodyLimitBytes, 'bodyLimitBytes', DEFAULT_BODY_LIMIT),
    timestampToleranceSec: optionalPositiveInt(raw.timestampToleranceSec, 'timestampToleranceSec', 300),
    maxV1Signatures: optionalPositiveInt(raw.maxV1Signatures, 'maxV1Signatures', 8),
    maxHeaderBytes: optionalPositiveInt(raw.maxHeaderBytes, 'maxHeaderBytes', 2048),
    requestTimeoutMs: optionalPositiveInt(raw.requestTimeoutMs, 'requestTimeoutMs', 10_000),
    maxConcurrent: optionalPositiveInt(raw.maxConcurrent, 'maxConcurrent', 16),
    sendTimeoutMs: optionalPositiveInt(raw.sendTimeoutMs, 'sendTimeoutMs', 8_000),
    outputCapBytes: optionalPositiveInt(raw.outputCapBytes, 'outputCapBytes', 4096),
    wakeHistoryLimit: optionalNonNegInt(raw.wakeHistoryLimit, 'wakeHistoryLimit', 0),
    dedup: {
      path: raw.dedup?.path ?? '/var/lib/webhook-wake/dedup.json',
      retentionMs: optionalRetentionMs(raw.dedup?.retentionMs, DEFAULT_RETENTION_MS),
      maxRecords: optionalPositiveInt(raw.dedup?.maxRecords, 'dedup.maxRecords', DEFAULT_MAX_RECORDS),
    },
    alertHook: {
      url: alertUrl,
      timeoutMs: optionalPositiveInt(raw.alertHook?.timeoutMs, 'alertHook.timeoutMs', 2000),
    },
    routes,
  };
}

export function loadConfigFile(path: string): ReceiverConfig {
  if (!existsSync(path)) {
    throw new Error(`config_missing:${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
  return parseFileConfig(parsed, { loadSecrets: true });
}

export function findRoute(config: ReceiverConfig, routeKey: string): RouteBinding | undefined {
  return config.routes.find((r) => r.routeKey === routeKey);
}
