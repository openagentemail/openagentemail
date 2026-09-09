/** Readiness is not liveness: mappings and state must be visible. */

import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
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
  orcaBinaryPresent: boolean;
  mappings: MappingReport[];
  warnings: string[];
};

export function inspectReadiness(config: ReceiverConfig): ReadyReport {
  const warnings: string[] = [];
  let stateWritable = true;
  try {
    accessSync(dirname(config.dedup.path), constants.W_OK);
  } catch {
    stateWritable = existsSync(dirname(config.dedup.path)) === false ? false : false;
    try {
      // Directory may not exist yet; create-on-write is allowed if the parent is writable.
      accessSync(dirname(dirname(config.dedup.path)), constants.W_OK);
      stateWritable = true;
    } catch {
      stateWritable = false;
    }
  }

  const orcaBinaryPresent = isAbsolute(config.orcaBinary) && existsSync(config.orcaBinary);
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

  const usable = mappings.some((m) => m.active && !m.stale && m.orcaBinding === 'ok');
  const ready =
    stateWritable &&
    usable &&
    (config.mode === 'observe' || orcaBinaryPresent) &&
    (config.mode !== 'canary' || Boolean(config.canaryTerminal));

  return {
    ready,
    mode: config.mode,
    liveness: 'ok',
    stateWritable,
    orcaBinaryPresent,
    mappings,
    warnings,
  };
}
