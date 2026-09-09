/** Static mapping loader. Request bodies cannot choose a terminal or command. */

import { existsSync, readFileSync, statSync } from 'node:fs';
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
export const DEFAULT_MAX_RECORDS = 10_000;

export type FileRouteSpec = {
  subscriptionId: string;
  domain: string;
  mailbox: string;
  secretFile: string;
  previousSecretFile?: string | null;
  terminal: string;
  active?: boolean;
  stale?: boolean;
};

export type FileConfig = {
  listen?: { host?: string; port?: number };
  mode?: ReceiverMode;
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
  dedup?: { path?: string; retentionMs?: number; maxRecords?: number };
  alertHook?: { url?: string | null; timeoutMs?: number };
  routes?: Record<string, FileRouteSpec>;
};

function readSecretFile(path: string): string {
  const resolved = resolve(path);
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new Error(`secret_not_file:${path}`);
  }
  const value = readFileSync(resolved, 'utf8').trim();
  if (!isDisplayedSecret(value)) {
    throw new Error('secret_format_invalid');
  }
  return value;
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
  const mode: ReceiverMode = raw.mode === 'canary' ? 'canary' : 'observe';
  const routesIn = raw.routes ?? {};
  const routes: RouteBinding[] = [];

  for (const [routeKey, spec] of Object.entries(routesIn)) {
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

  return {
    listen: {
      host: raw.listen?.host ?? '127.0.0.1',
      port: raw.listen?.port ?? 8787,
    },
    mode,
    canaryTerminal,
    orcaBinary: raw.orcaBinary ?? '/usr/local/bin/orca',
    bodyLimitBytes: raw.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
    timestampToleranceSec: raw.timestampToleranceSec ?? 300,
    maxV1Signatures: raw.maxV1Signatures ?? 8,
    maxHeaderBytes: raw.maxHeaderBytes ?? 2048,
    requestTimeoutMs: raw.requestTimeoutMs ?? 10_000,
    maxConcurrent: raw.maxConcurrent ?? 16,
    sendTimeoutMs: raw.sendTimeoutMs ?? 8_000,
    outputCapBytes: raw.outputCapBytes ?? 4096,
    dedup: {
      path: raw.dedup?.path ?? '/var/lib/webhook-wake/dedup.json',
      retentionMs: raw.dedup?.retentionMs ?? DEFAULT_RETENTION_MS,
      maxRecords: raw.dedup?.maxRecords ?? DEFAULT_MAX_RECORDS,
    },
    alertHook: {
      url: raw.alertHook?.url ?? null,
      timeoutMs: raw.alertHook?.timeoutMs ?? 2000,
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
