import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.ts';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';
import { createMonitorState, httpProbe, stepMonitor } from '../src/monitor.ts';
import { createHttpAlert } from '../src/alert.ts';
import type { Receiver } from '../src/server.ts';
import type { AlertEvent } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('monitor outage and alert-path failure', () => {
  test('two probe failures raise an alarm; recovery is announced; cooldown suppresses duplicates', async () => {
    const alerts: AlertEvent[] = [];
    const state = createMonitorState();
    let healthy = false;
    const probe = async () => ({ ok: healthy });
    const alert = async (event: AlertEvent) => {
      alerts.push(event);
      return { ok: true };
    };

    await stepMonitor({ state, probe, alert, nowMs: 1_000, config: { failThreshold: 2, cooldownMs: 10_000 } });
    expect(alerts).toHaveLength(0);
    await stepMonitor({ state, probe, alert, nowMs: 2_000, config: { failThreshold: 2, cooldownMs: 10_000 } });
    expect(alerts).toEqual([{ kind: 'monitor_failure', code: 'health_failed' }]);

    await stepMonitor({ state, probe, alert, nowMs: 3_000, config: { failThreshold: 2, cooldownMs: 10_000 } });
    expect(alerts).toHaveLength(1);

    healthy = true;
    await stepMonitor({ state, probe, alert, nowMs: 20_000, config: { failThreshold: 2, cooldownMs: 10_000 } });
    expect(alerts.at(-1)).toEqual({ kind: 'monitor_recovery', code: 'health_recovered' });
    expect(state.recoveries).toBe(1);
  });

  test('helper keeps pending recovery across cooldown and emits on a later tick', async () => {
    const alerts: AlertEvent[] = [];
    const state = createMonitorState();
    let healthy = false;
    const probe = async () => ({ ok: healthy });
    const alert = async (event: AlertEvent) => {
      alerts.push(event);
      return { ok: true };
    };
    const cfg = { failThreshold: 2, cooldownMs: 10_000 };
    await stepMonitor({ state, probe, alert, nowMs: 1_000, config: cfg });
    await stepMonitor({ state, probe, alert, nowMs: 2_000, config: cfg });
    expect(state.alarming).toBe(true);
    healthy = true;
    await stepMonitor({ state, probe, alert, nowMs: 3_000, config: cfg });
    expect(alerts.filter((a) => a.kind === 'monitor_recovery')).toHaveLength(0);
    expect(state.pendingRecovery).toBe(true);
    expect(state.alarming).toBe(true);
    await stepMonitor({ state, probe, alert, nowMs: 13_000, config: cfg });
    expect(alerts.at(-1)).toEqual({ kind: 'monitor_recovery', code: 'health_recovered' });
    expect(state.pendingRecovery).toBe(false);
    expect(state.alarming).toBe(false);
  });

  test('alert-path failure is counted and visible', async () => {
    const state = createMonitorState();
    const alert = async () => ({ ok: false, reason: 'down' });
    await stepMonitor({
      state,
      probe: async () => ({ ok: false }),
      alert,
      nowMs: 1,
      config: { failThreshold: 1, cooldownMs: 0 },
    });
    expect(state.alertFailures).toBeGreaterThan(0);
    expect(state.alarms).toBe(0);
  });

  test('http probe against a stopped receiver fails; receiver alert hook failure increments counter', async () => {
    const hook = createServer((req, res) => {
      res.writeHead(500);
      res.end('no');
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const addr = hook.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const alertUrl = `http://127.0.0.1:${addr.port}/alert`;

    const receiver = await startReceiver(
      {
        ...testConfig({ mode: 'canary' }),
        alertHook: { url: alertUrl, timeoutMs: 200 },
      },
      {
        wake: async (req) => ({
          ok: false,
          reason: 'nonzero_exit',
          exitCode: 2,
          argv: req.argv,
          stdoutBytes: 0,
          stderrBytes: 0,
        }),
      },
    );
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(receiver.metrics.alertFailed).toBeGreaterThan(0);

    const healthUrl = `${receiver.url()}/health`;
    const live = await httpProbe(healthUrl, 200);
    expect(live.ok).toBe(true);
    await receiver.close();
    receivers.pop();
    const dead = await httpProbe(healthUrl, 200);
    expect(dead.ok).toBe(false);

    await new Promise<void>((resolve, reject) => hook.close((err) => (err ? reject(err) : resolve())));
  });

  test('templates/monitor.sh alarms after two failures and records alert-cmd failure', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-sh-');
    const curlOk = join(dir, 'curl-ok');
    const curlFail = join(dir, 'curl-fail');
    const alerts = join(dir, 'alerts.log');
    writeFileSync(curlOk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const alerter = join(dir, 'alert');
    writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });
    const failAlerter = join(dir, 'alert-fail');
    writeFileSync(failAlerter, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const state = join(dir, 'state');

    const run = (curl: string, alertBin: string, extra: Record<string, string> = {}) =>
      spawnSync('sh', [script], {
        env: {
          PATH: process.env.PATH,
          HEALTH_URL: 'https://webhook-wake.example.com/health',
          FAIL_THRESHOLD: '2',
          COOLDOWN_SEC: '0',
          CURL_BIN: curl,
          ALERT_BIN: alertBin,
          STATE_FILE: state,
          ...extra,
        },
        encoding: 'utf8',
      });

    expect(run(curlFail, alerter).status).toBe(1);
    expect(run(curlFail, alerter).status).toBe(1);
    const logged = readFileSync(alerts, 'utf8').trim().split('\n');
    expect(logged).toContain('health_failed');
    expect(run(curlOk, alerter).status).toBe(0);
    const after = readFileSync(alerts, 'utf8');
    expect(after).toContain('health_recovered');

    mkdirSync(join(dir, 'empty'), { recursive: true });
    const state2 = join(dir, 'state2');
    const failed = spawnSync('sh', [script], {
      env: {
        PATH: process.env.PATH,
        HEALTH_URL: 'https://webhook-wake.example.com/health',
        FAIL_THRESHOLD: '1',
        COOLDOWN_SEC: '0',
        CURL_BIN: curlFail,
        ALERT_BIN: failAlerter,
        STATE_FILE: state2,
      },
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('monitor_alert_failed');
  });

  test('shipped monitor.sh persists state across separate runs and emits delayed recovery', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-persist-');
    const curlOk = join(dir, 'curl-ok');
    const curlFail = join(dir, 'curl-fail');
    const alerts = join(dir, 'alerts.log');
    writeFileSync(curlOk, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const alerter = join(dir, 'alert');
    writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });
    const state = join(dir, 'protected', 'state');

    const run = (curl: string, now: string, cooldown = '300') =>
      spawnSync('sh', [script], {
        env: {
          PATH: process.env.PATH,
          HEALTH_URL: 'https://webhook-wake.example.com/health',
          FAIL_THRESHOLD: '2',
          COOLDOWN_SEC: cooldown,
          CURL_BIN: curl,
          ALERT_BIN: alerter,
          STATE_FILE: state,
          NOW_SEC: now,
        },
        encoding: 'utf8',
      });

    expect(run(curlFail, '100').status).toBe(1);
    expect(run(curlFail, '100').status).toBe(1);
    expect(readFileSync(alerts, 'utf8')).toContain('health_failed');
    expect(readFileSync(state, 'utf8')).toContain('alarming=1');

    const quick = run(curlOk, '101');
    expect(quick.status).toBe(0);
    expect(readFileSync(state, 'utf8')).toContain('pending_recovery=1');
    expect(readFileSync(alerts, 'utf8')).not.toContain('health_recovered');

    expect(run(curlOk, '500').status).toBe(0);
    expect(readFileSync(alerts, 'utf8')).toContain('health_recovered');
    expect(readFileSync(state, 'utf8')).toContain('pending_recovery=0');
  });

  test('alert binary timeout is visible and does not take a shell string', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-timeout-');
    const curlFail = join(dir, 'curl-fail');
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const hang = join(dir, 'hang');
    writeFileSync(hang, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
    const started = Date.now();
    const hung = spawnSync('sh', [script], {
      env: {
        PATH: process.env.PATH,
        HEALTH_URL: 'https://webhook-wake.example.com/health',
        FAIL_THRESHOLD: '1',
        COOLDOWN_SEC: '0',
        CURL_BIN: curlFail,
        ALERT_BIN: hang,
        ALERT_TIMEOUT_SEC: '1',
        STATE_FILE: join(dir, 'state'),
      },
      encoding: 'utf8',
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(hung.status).toBe(1);
    expect(hung.stderr).toContain('monitor_alert_failed');

    const relative = spawnSync('sh', [script], {
      env: {
        PATH: process.env.PATH,
        HEALTH_URL: 'https://webhook-wake.example.com/health',
        FAIL_THRESHOLD: '1',
        COOLDOWN_SEC: '0',
        CURL_BIN: curlFail,
        ALERT_BIN: 'not-absolute',
        STATE_FILE: join(dir, 'state2'),
      },
      encoding: 'utf8',
    });
    expect(relative.stderr).toContain('invalid_bin');
  });

  test('createHttpAlert times out without interpolating caller text', async () => {
    const hanging = createServer(() => {
      /* ignore */
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const addr = hanging.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const fn = createHttpAlert(`http://127.0.0.1:${addr.port}/x`, 50);
    const result = await fn({ kind: 'receiver_failure', code: 'send_failed' });
    expect(result.ok).toBe(false);
    await new Promise<void>((resolve, reject) => hanging.close((err) => (err ? reject(err) : resolve())));
  });
});
