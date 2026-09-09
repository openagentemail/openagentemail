/**
 * Fixed-argv Orca send. Never uses a shell. Timeout kills the spawned job
 * (process group on POSIX), never the ambient runtime.
 * A zero exit records transport submission, not agent consumption.
 *
 * The child inherits a runtime-context allowlist (HOME / XDG / USER) so a
 * colocated Orca install can resolve its files. Secrets and API credentials
 * are never copied from the parent environment.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { WakeFn, WakeRequest, WakeResult } from './types.ts';

export type SpawnWakeOptions = {
  timeoutMs: number;
  outputCapBytes: number;
  extraEnv?: Record<string, string>;
  /** Test-only parent snapshot; production uses process.env. */
  parentEnv?: NodeJS.ProcessEnv;
};

/** Runtime keys a local Orca binary may need. Not secrets or API tokens. */
export const ORCA_RUNTIME_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'ORCA_HOME',
] as const;

const SECRETISH_KEY = /^(.*(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIAL).*|API_KEY|AUTHORIZATION|AWS_SECRET_ACCESS_KEY|SSH_AUTH_SOCK|OPENAGENTEMAIL_API_KEY)$/i;

export function isDeniedChildEnvKey(key: string): boolean {
  return SECRETISH_KEY.test(key);
}

export function buildOrcaChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  extra?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ORCA_RUNTIME_ENV_KEYS) {
    const value = parent[key];
    if (typeof value === 'string' && value.length > 0 && !isDeniedChildEnvKey(key)) {
      env[key] = value;
    }
  }
  if (!env.PATH) {
    env.PATH = '/usr/bin:/bin';
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (isDeniedChildEnvKey(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

/** SIGKILL the spawned job's process group only. Never pid 1 or this process. */
export function killSpawnedJob(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 1 && pid !== process.pid) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Group may already be gone; fall through to the direct child.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

function takeCapped(stream: NodeJS.ReadableStream | null, cap: number): { bytes: number; overflow: boolean } {
  const state = { bytes: 0, overflow: false };
  if (!stream) return state;
  stream.on('data', (chunk: Buffer) => {
    state.bytes += chunk.length;
    if (state.bytes > cap) {
      state.overflow = true;
      if (typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function') {
        (stream as { destroy: () => void }).destroy();
      }
    }
  });
  return state;
}

export function createSpawnWake(options: SpawnWakeOptions): WakeFn {
  return (req: WakeRequest) =>
    new Promise<WakeResult>((resolve) => {
      const binary = req.argv[0];
      const args = req.argv.slice(1);
      if (!binary || !isAbsolute(binary)) {
        resolve({
          ok: false,
          reason: 'spawn_error',
          exitCode: null,
          argv: req.argv,
          stdoutBytes: 0,
          stderrBytes: 0,
        });
        return;
      }

      let settled = false;
      const finish = (result: WakeResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = spawn(binary, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildOrcaChildEnv(options.parentEnv ?? process.env, options.extraEnv),
          detached: true,
        });
      } catch {
        finish({
          ok: false,
          reason: 'spawn_error',
          exitCode: null,
          argv: req.argv,
          stdoutBytes: 0,
          stderrBytes: 0,
        });
        return;
      }

      const stdout = takeCapped(child.stdout, options.outputCapBytes);
      const stderr = takeCapped(child.stderr, options.outputCapBytes);

      const timer = setTimeout(() => {
        killSpawnedJob(child);
        finish({
          ok: false,
          reason: 'timeout_killed',
          exitCode: null,
          argv: req.argv,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
        });
      }, options.timeoutMs);

      child.on('error', () => {
        clearTimeout(timer);
        finish({
          ok: false,
          reason: 'spawn_error',
          exitCode: null,
          argv: req.argv,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
        });
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (stdout.overflow || stderr.overflow) {
          finish({
            ok: code === 0,
            reason: 'output_capped',
            exitCode: code,
            argv: req.argv,
            stdoutBytes: stdout.bytes,
            stderrBytes: stderr.bytes,
          });
          return;
        }
        finish({
          ok: code === 0,
          reason: code === 0 ? undefined : 'nonzero_exit',
          exitCode: code,
          argv: req.argv,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
        });
      });
    });
}

export function recordingWake(bucket: WakeRequest[]): WakeFn {
  return async (req) => {
    bucket.push(req);
    return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
  };
}
