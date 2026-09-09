/** Readiness is not liveness: mappings and state must be visible. */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { canaryTerminalBound } from './config.ts';
import { inspectDedupFile } from './dedup.ts';
import { isLoopbackHost } from './ids.ts';
import type { ReceiverConfig } from './types.ts';

export type MappingReport = {
  routeKey: string;
  subscriptionId: string;
  active: boolean;
  stale: boolean;
  orcaBinding: 'ok' | 'missing' | 'stale';
};

export type ReadyReport = {
  ready: boolean;
  mode: ReceiverConfig['mode'];
  liveness: 'ok';
  stateWritable: boolean;
  stateHealthy: boolean;
  orcaBinaryPresent: boolean;
  mappings: MappingReport[];
  warnings: string[];
};

/** Regular file with execute permission. Directories and non-executables fail. */
export function isRegularExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectStateWritable(dedupPath: string): boolean {
  const stateDir = dirname(dedupPath);
  try {
    accessSync(stateDir, constants.W_OK);
    return true;
  } catch {
    // Existing but unwritable directory stays unready. Fallback only if absent.
    if (existsSync(stateDir)) {
      return false;
    }
    try {
      accessSync(dirname(stateDir), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function inspectReadiness(config: ReceiverConfig): ReadyReport {
  const warnings: string[] = [];
  const stateWritable = inspectStateWritable(config.dedup.path);
  if (!stateWritable) {
    warnings.push('state_unwritable');
  }
  const store = inspectDedupFile(config.dedup.path);
  const stateHealthy = store.ok;
  if (!store.ok) {
    warnings.push(store.reason);
  }
  if (!isLoopbackHost(config.listen.host)) {
    warnings.push('listen_not_loopback');
  }

  const orcaBinaryPresent = isRegularExecutable(config.orcaBinary);
  if (config.mode === 'canary' && !orcaBinaryPresent) {
    warnings.push('orca_binary_missing');
  }

  const mappings: MappingReport[] = config.routes.map((route) => {
    let orcaBinding: MappingReport['orcaBinding'] = 'ok';
    if (!route.terminal) orcaBinding = 'missing';
    if (!route.active || route.stale) orcaBinding = 'stale';
    if (!route.active || route.stale) {
      warnings.push(`mapping_inactive_or_stale:${route.routeKey}`);
    }
    if (!route.secret) {
      warnings.push(`secret_missing:${route.routeKey}`);
      orcaBinding = 'missing';
    }
    return {
      routeKey: route.routeKey,
      subscriptionId: route.subscriptionId,
      active: route.active,
      stale: route.stale,
      orcaBinding,
    };
  });

  if (mappings.length === 0) {
    warnings.push('no_routes');
  }

  const canaryBound = canaryTerminalBound(config.routes, config.canaryTerminal);
  if (config.mode === 'canary' && !canaryBound) {
    warnings.push('canary_terminal_unbound');
  }

  const usable = mappings.some((m) => m.active && !m.stale && m.orcaBinding === 'ok');
  const ready =
    stateWritable &&
    stateHealthy &&
    usable &&
    (config.mode === 'observe' || orcaBinaryPresent) &&
    (config.mode !== 'canary' || canaryBound);

  return {
    ready,
    mode: config.mode,
    liveness: 'ok',
    stateWritable,
    stateHealthy,
    orcaBinaryPresent,
    mappings,
    warnings,
  };
}
