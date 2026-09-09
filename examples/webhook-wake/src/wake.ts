/**
 * Fixed-argv Orca send. Never uses a shell. Timeout kills the child.
 * A zero exit records transport submission, not agent consumption.
 */

import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { WakeFn, WakeRequest, WakeResult } from './types.ts';

export type SpawnWakeOptions = {
  timeoutMs: number;
  outputCapBytes: number;
  extraEnv?: Record<string, string>;
};

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

      let child;
      try {
        child = spawn(binary, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ...(options.extraEnv ?? {}),
          },
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
        child.kill('SIGKILL');
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
