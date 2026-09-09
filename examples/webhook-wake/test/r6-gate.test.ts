import { describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMonitorState, stepMonitor } from '../src/monitor.ts';
import { tempDir } from './helpers.ts';

describe('R6 recovery alert retry', () => {
  test('failed recovery does not stamp cooldown; next healthy tick retries', async () => {
    const alerts: string[] = [];
    const state = createMonitorState();
    let healthy = false;
    let recoverOk = false;
    const cfg = { failThreshold: 1, cooldownMs: 10_000 };
    const alert = async (event: { code: string }) => {
      alerts.push(event.code);
      if (event.code === 'health_recovered' && !recoverOk) {
        return { ok: false, reason: 'down' };
      }
      return { ok: true };
    };

    await stepMonitor({
      state,
      probe: async () => ({ ok: healthy }),
      alert,
      nowMs: 1_000,
      config: cfg,
    });
    expect(alerts).toEqual(['health_failed']);
    expect(state.alarming).toBe(true);
    expect(state.lastAlertAtMs).toBe(1_000);

    healthy = true;
    await stepMonitor({
      state,
      probe: async () => ({ ok: healthy }),
      alert,
      nowMs: 12_000,
      config: cfg,
    });
    expect(alerts).toEqual(['health_failed', 'health_recovered']);
    expect(state.pendingRecovery).toBe(true);
    expect(state.alarming).toBe(true);
    expect(state.lastAlertAtMs).toBe(1_000);
    expect(state.recoveries).toBe(0);

    recoverOk = true;
    await stepMonitor({
      state,
      probe: async () => ({ ok: healthy }),
      alert,
      nowMs: 13_000,
      config: cfg,
    });
    expect(alerts).toEqual(['health_failed', 'health_recovered', 'health_recovered']);
    expect(state.pendingRecovery).toBe(false);
    expect(state.alarming).toBe(false);
    expect(state.lastAlertAtMs).toBe(13_000);
    expect(state.recoveries).toBe(1);
  });

  test('ordinary cooldown still holds a successful recovery', async () => {
    const alerts: string[] = [];
    const state = createMonitorState();
    state.alarming = true;
    state.lastAlertAtMs = 1_000;
    await stepMonitor({
      state,
      probe: async () => ({ ok: true }),
      alert: async (event) => {
        alerts.push(event.code);
        return { ok: true };
      },
      nowMs: 2_000,
      config: { failThreshold: 1, cooldownMs: 10_000 },
    });
    expect(alerts).toHaveLength(0);
    expect(state.pendingRecovery).toBe(true);
    expect(state.lastAlertAtMs).toBe(1_000);
  });

  test('shipped monitor.sh retries recovery after a failed last_alert-less send', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-r6-');
    const curlOk = join(dir, 'curl-ok');
    const curlFail = join(dir, 'curl-fail');
    const alerts = join(dir, 'alerts.log');
    const gate = join(dir, 'recover-ok');
    const alerter = join(dir, 'alert');
    writeFileSync(curlOk, '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(
      alerter,
      `#!/bin/sh
if [ "$1" = "health_recovered" ] && [ ! -f "${gate}" ]; then
  echo "$1" >> "${alerts}"
  exit 1
fi
echo "$1" >> "${alerts}"
exit 0
`,
      { mode: 0o755 },
    );
    const state = join(dir, 'state');
    const env = {
      PATH: process.env.PATH,
      HEALTH_URL: 'https://webhook-wake.example.com/health',
      FAIL_THRESHOLD: '1',
      COOLDOWN_SEC: '300',
      ALERT_BIN: alerter,
      STATE_FILE: state,
    };
    const alarm = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlFail, NOW_SEC: '100' },
      encoding: 'utf8',
    });
    expect(alarm.status).toBe(1);
    expect(readFileSync(alerts, 'utf8')).toContain('health_failed');
    expect(readFileSync(state, 'utf8')).toContain('last_alert=100');

    const failed = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlOk, NOW_SEC: '500' },
      encoding: 'utf8',
    });
    expect(failed.status).toBe(0);
    expect(readFileSync(alerts, 'utf8').trim().split('\n')).toEqual(['health_failed', 'health_recovered']);
    expect(readFileSync(state, 'utf8')).toContain('pending_recovery=1');
    expect(readFileSync(state, 'utf8')).toContain('last_alert=100');

    writeFileSync(gate, 'ok', { mode: 0o600 });
    const retried = spawnSync('sh', [script], {
      env: { ...env, CURL_BIN: curlOk, NOW_SEC: '510' },
      encoding: 'utf8',
    });
    expect(retried.status).toBe(0);
    expect(readFileSync(alerts, 'utf8').trim().split('\n')).toEqual([
      'health_failed',
      'health_recovered',
      'health_recovered',
    ]);
    expect(readFileSync(state, 'utf8')).toContain('pending_recovery=0');
    expect(readFileSync(state, 'utf8')).toContain('last_alert=510');
  });
});
