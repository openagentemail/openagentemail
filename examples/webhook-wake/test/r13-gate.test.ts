import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.ts';

const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
const huge = '9'.repeat(30);
/** Ten-digit Unix seconds under 2^31−1 so POSIX [ stays portable. */
const epoch = '1700000000';
const epochLater = '1700000400';

function prep(prefix: string) {
  chmodSync(script, 0o755);
  const dir = tempDir(prefix);
  const curlOk = join(dir, 'curl-ok');
  const curlFail = join(dir, 'curl-fail');
  const alerts = join(dir, 'alerts.log');
  writeFileSync(curlOk, '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
  writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const alerter = join(dir, 'alert');
  writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });
  const state = join(dir, 'state');
  return { dir, curlOk, curlFail, alerts, alerter, state };
}

function run(
  ctx: ReturnType<typeof prep>,
  extra: Record<string, string>,
) {
  return spawnSync('sh', [script], {
    env: {
      PATH: process.env.PATH,
      HEALTH_URL: 'https://webhook-wake.example.com/health',
      FAIL_THRESHOLD: '2',
      COOLDOWN_SEC: '300',
      ALERT_TIMEOUT_SEC: '2',
      CURL_BIN: ctx.curlFail,
      ALERT_BIN: ctx.alerter,
      STATE_FILE: ctx.state,
      NOW_SEC: '100',
      ...extra,
    },
    encoding: 'utf8',
  });
}

describe('R13 persisted monitor integers', () => {
  test('huge all-digit consecutive and last_alert fail visibly without alerting', () => {
    const ctx = prep('monitor-state-overflow-');
    writeFileSync(
      ctx.state,
      `consecutive=${huge}\nalarming=0\npending_recovery=0\nlast_alert=0\n`,
      { mode: 0o600 },
    );
    const badCount = run(ctx, {});
    expect(badCount.status).toBe(2);
    expect(badCount.stderr).toContain('monitor_config_invalid_state consecutive');
    expect(existsSync(ctx.alerts)).toBe(false);

    writeFileSync(
      ctx.state,
      `consecutive=0\nalarming=1\npending_recovery=0\nlast_alert=${huge}\n`,
      { mode: 0o600 },
    );
    const badStamp = run(ctx, { FAIL_THRESHOLD: '1' });
    expect(badStamp.status).toBe(2);
    expect(badStamp.stderr).toContain('monitor_config_invalid_state last_alert');
    expect(existsSync(ctx.alerts)).toBe(false);
  });

  test('ten-digit epoch cooldown works; NOW_SEC overflow is rejected', () => {
    const ctx = prep('monitor-epoch-');
    writeFileSync(
      ctx.state,
      `consecutive=0\nalarming=1\npending_recovery=0\nlast_alert=${epoch}\n`,
      { mode: 0o600 },
    );
    const cooled = run(ctx, { CURL_BIN: ctx.curlOk, NOW_SEC: '1700000100', COOLDOWN_SEC: '300' });
    expect(cooled.status).toBe(0);
    expect(readFileSync(ctx.state, 'utf8')).toContain('pending_recovery=1');
    expect(existsSync(ctx.alerts) ? readFileSync(ctx.alerts, 'utf8') : '').not.toContain('health_recovered');

    const recovered = run(ctx, { CURL_BIN: ctx.curlOk, NOW_SEC: epochLater, COOLDOWN_SEC: '300' });
    expect(recovered.status).toBe(0);
    expect(readFileSync(ctx.alerts, 'utf8')).toContain('health_recovered');
    expect(readFileSync(ctx.state, 'utf8')).toContain(`last_alert=${epochLater}`);

    const overflowNow = run(ctx, { NOW_SEC: huge });
    expect(overflowNow.status).toBe(2);
    expect(overflowNow.stderr).toContain('monitor_config_invalid NOW_SEC');
  });

  test('valid boundaries increment consecutive safely and still alert', () => {
    const ctx = prep('monitor-count-');
    mkdirSync(join(ctx.dir, 'protected'), { recursive: true });
    writeFileSync(
      ctx.state,
      'consecutive=0\nalarming=0\npending_recovery=0\nlast_alert=0\n',
      { mode: 0o600 },
    );
    expect(run(ctx, { FAIL_THRESHOLD: '2', NOW_SEC: '100' }).status).toBe(1);
    expect(readFileSync(ctx.state, 'utf8')).toContain('consecutive=1');
    expect(existsSync(ctx.alerts)).toBe(false);

    expect(run(ctx, { FAIL_THRESHOLD: '2', NOW_SEC: '101' }).status).toBe(1);
    expect(readFileSync(ctx.state, 'utf8')).toMatch(/consecutive=2/);
    expect(readFileSync(ctx.alerts, 'utf8')).toContain('health_failed');
    expect(readFileSync(ctx.state, 'utf8')).toContain('last_alert=101');
  });
});
