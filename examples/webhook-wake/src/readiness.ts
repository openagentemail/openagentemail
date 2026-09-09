/** Readiness is not liveness: mappings and state must be visible. */

import { accessSync, constants, lstatSync, statSync } from 'node:fs';
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

/**
 * Sticky parents allow directory writes but can deny replacing another UID's file.
 * Missing targets stay allowed. Not a complete TOCTOU defense.
 */
function canReplaceDedupTarget(dedupPath: string): boolean {
  let target;
  try {
    target = lstatSync(dedupPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let parent;
  try {
    parent = statSync(dirname(dedupPath));
  } catch {
    return false;
  }
  if ((parent.mode & 0o1000) === 0) return true;
  if (typeof process.getuid !== 'function') return true;
  const uid = process.getuid();
  if (uid === 0) return true;
  return target.uid === uid || parent.uid === uid;
}

function isDirWith(dir: string, mode: number): boolean {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    accessSync(dir, mode);
    return true;
  } catch {
    return false;
  }
}

/** lstat: missing vs directory vs existing non-dir / dangling symlink. */
function pathKind(path: string): 'dir' | 'missing' | 'blocked' {
  try {
    const link = lstatSync(path);
    if (link.isSymbolicLink()) {
      try {
        return statSync(path).isDirectory() ? 'dir' : 'blocked';
      } catch {
        return 'blocked';
      }
    }
    return link.isDirectory() ? 'dir' : 'blocked';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'blocked';
  }
}

/**
 * Read-only. Mirrors commit: the creation dir needs read+write+search
 * (create + fsync), and every further ancestor needs read+search (fsync walk).
 * Existing non-directories and dangling symlinks are not “absent dirs”.
 * This is not a claim of complete concurrent filesystem-attack prevention.
 */
export function inspectStateWritable(dedupPath: string): boolean {
  const stateDir = dirname(dedupPath);
  let creationDir: string | null = null;
  let cursor = stateDir;
  for (;;) {
    const kind = pathKind(cursor);
    if (kind === 'blocked') return false;
    if (kind === 'dir') {
      creationDir = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  if (!creationDir || !isDirWith(creationDir, constants.R_OK | constants.W_OK | constants.X_OK)) {
    return false;
  }
  if (!canReplaceDedupTarget(dedupPath)) {
    return false;
  }
  cursor = dirname(creationDir);
  for (;;) {
    if (!isDirWith(cursor, constants.R_OK | constants.X_OK)) return false;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return true;
}

export function inspectReadiness(config: ReceiverConfig): ReadyReport {
  const warnings: string[] = [];
  const stateWritable = inspectStateWritable(config.dedup.path);
  if (!stateWritable) {
    warnings.push('state_unwritable');
  }
  const store = inspectDedupFile(config.dedup.path, {
    maxRecords: config.dedup.maxRecords,
    nowMs: Date.now(),
  });
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
