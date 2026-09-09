import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createMonitorState, httpProbe, stepMonitor } from '../src/monitor.ts';
import { createSpawnWake, killSpawnedJob } from '../src/wake.ts';
import { CANARY_TERMINAL } from './helpers.ts';
import type { AlertEvent } from '../src/types.ts';

describe('R10 httpProbe unsupported protocol', () => {
  test('ftp, file, other schemes, and malformed URLs are {ok:false} without throw', async () => {
    await expect(httpProbe('ftp://example.invalid', 100)).resolves.toEqual({ ok: false });
    await expect(httpProbe('file:///etc/passwd', 100)).resolves.toEqual({ ok: false });
    await expect(httpProbe('mailto:ops@example.invalid', 100)).resolves.toEqual({ ok: false });
    await expect(httpProbe('not a url', 100)).resolves.toEqual({ ok: false });
  });

  test('stepMonitor treats ftp probe as a failed probe and alerts at threshold', async () => {
    const alerts: AlertEvent[] = [];
    const state = createMonitorState();
    const probe = () => httpProbe('ftp://example.invalid', 100);
    const alert = async (event: AlertEvent) => {
      alerts.push(event);
      return { ok: true };
    };
    const cfg = { failThreshold: 2, cooldownMs: 10_000 };
    await expect(stepMonitor({ state, probe, alert, nowMs: 1_000, config: cfg })).resolves.toBe(state);
    expect(state.consecutiveFailures).toBe(1);
    expect(alerts).toHaveLength(0);
    await expect(stepMonitor({ state, probe, alert, nowMs: 2_000, config: cfg })).resolves.toBe(state);
    expect(state.consecutiveFailures).toBe(2);
    expect(alerts).toEqual([{ kind: 'monitor_failure', code: 'health_failed' }]);
  });

  test('exact 200, redirect, and timeout stay the same', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      if (req.url === '/hang') {
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    expect((await httpProbe(`${base}/ok`, 300)).ok).toBe(true);
    expect((await httpProbe(`${base}/redir`, 300)).ok).toBe(false);
    expect((await httpProbe(`${base}/hang`, 80)).ok).toBe(false);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('R10 killSpawnedJob known-exit guard', () => {
  test('does not signal a child the runtime already marked exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    expect(child.exitCode).toBe(0);
    const signaled: Array<number | string> = [];
    const original = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      signaled.push(pid);
      return original(pid, signal);
    }) as typeof process.kill;
    try {
      expect(() => killSpawnedJob(child)).not.toThrow();
      expect(signaled).toEqual([]);
    } finally {
      process.kill = original;
    }
  });

  test('timeout still SIGKILLs an active hang tree', async () => {
    const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
    chmodSync(fakeOrca, 0o755);
    const hang = createSpawnWake({
      timeoutMs: 120,
      outputCapBytes: 64,
      extraEnv: { FAKE_ORCA_MODE: 'hang' },
    });
    const hung = await hang({
      terminal: CANARY_TERMINAL,
      text: 'x',
      argv: [fakeOrca, 'terminal', 'send', '--terminal', CANARY_TERMINAL, '--enter', '--text', 'x'],
    });
    expect(hung.ok).toBe(false);
    expect(hung.reason).toBe('timeout_killed');
  });
});
