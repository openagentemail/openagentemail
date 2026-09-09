import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileConfig } from '../src/config.ts';
import { inspectDedupFile } from '../src/dedup.ts';
import { inspectStateWritable } from '../src/readiness.ts';
import { recordingWake } from '../src/wake.ts';
import {
  FIXTURE_SECRET,
  mailBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  writeSecretFile,
} from './helpers.ts';
import type { FileConfig } from '../src/config.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function fileBase(dir: string): FileConfig {
  const secret = writeSecretFile(dir, 'ok.whs', FIXTURE_SECRET);
  return {
    routes: {
      canary: {
        subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        domain: 'openagent.email',
        mailbox: 'alice@openagent.email',
        secretFile: secret,
        terminal: 'term_examplecanary0001',
      },
    },
  };
}

describe('R15 listen container and alertHook.url', () => {
  test('present listen must be an object; invalid host does not default', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig(base).listen).toEqual({ host: '127.0.0.1', port: 8787 });
    expect(parseFileConfig({ ...base, listen: { host: '0.0.0.0', port: 0 } }).listen).toEqual({
      host: '0.0.0.0',
      port: 0,
    });
    expect(() => parseFileConfig({ ...base, listen: '0.0.0.0' } as unknown as FileConfig)).toThrow(
      'config_invalid:listen',
    );
    expect(() => parseFileConfig({ ...base, listen: ['127.0.0.1'] } as unknown as FileConfig)).toThrow(
      'config_invalid:listen',
    );
    expect(() => parseFileConfig({ ...base, listen: null } as unknown as FileConfig)).toThrow('config_invalid:listen');
    expect(() => parseFileConfig({ ...base, listen: { host: '' } })).toThrow('config_invalid:listen.host');
    expect(() => parseFileConfig({ ...base, listen: { host: 1 } as unknown as FileConfig['listen'] })).toThrow(
      'config_invalid:listen.host',
    );
  });

  test('empty alertHook.url fails; null still disables the sink', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig({ ...base, alertHook: { url: null } }).alertHook.url).toBeNull();
    expect(() => parseFileConfig({ ...base, alertHook: { url: '' } })).toThrow('config_invalid:alertHook.url');
    expect(() => parseFileConfig({ ...base, alertHook: { url: '   ' } })).toThrow('config_invalid:alertHook.url');
  });
});

describe('R15 sticky replacement and FIFO', () => {
  test('own file in a sticky dir stays replaceable and can wake', async () => {
    const root = tempDir();
    const sticky = join(root, 'sticky');
    mkdirSync(sticky, { mode: 0o1777 });
    expect(spawnSync('chmod', ['1777', sticky]).status).toBe(0);
    const path = join(sticky, 'dedup.json');
    writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    expect(inspectStateWritable(path)).toBe(true);

    const wakes: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary', dedup: { path } }, root), {
      wake: recordingWake(wakes),
    });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(wakes).toHaveLength(1);
  });

  test('foreign-owned sticky target is skipped without root, or proved after a searchable ancestor', () => {
    const helper = fileURLToPath(new URL('./r15-sticky-replace.mjs', import.meta.url));
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20_000 });

    let ran = run(process.execPath, [helper]);
    let viaSudo = false;
    if (ran.status === 77 && `${ran.stdout}${ran.stderr}`.includes('SKIPPED:not_root')) {
      const sudoOk = run('sudo', ['-n', 'true']);
      if (sudoOk.status === 0) {
        viaSudo = true;
        ran = run('sudo', ['-n', process.execPath, helper]);
      }
    }

    const text = `${ran.stdout}${ran.stderr}`;
    if (ran.status === 77) {
      expect(text).toContain('SKIPPED:');
      expect(text).not.toContain('EXECUTED:');
      expect(text).not.toContain('PROOF:rename_denied');
      return;
    }

    expect(ran.status).toBe(0);
    expect(text).toContain('PROOF:file_readable');
    expect(text).toContain('PROOF:parent_rwx');
    expect(text).toMatch(/PROOF:rename_denied:(EPERM|EACCES)/);
    expect(text).toContain('PROOF:own_replace_ok');
    expect(text).toContain('PROOF:ready_false');
    expect(text).toContain('PROOF:zero_wake');
    expect(text).toContain('EXECUTED:uid=');
    const fixture = text.match(/^FIXTURE:(.+)$/m)?.[1];
    if (viaSudo && fixture) {
      run('sudo', ['-n', 'rm', '-rf', fixture]);
    }
  });

  test('FIFO is rejected before read; regular files still inspect', () => {
    const helper = fileURLToPath(new URL('./r15-fifo-probe.mjs', import.meta.url));
    const ran = spawnSync(process.execPath, [helper], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 2000,
    });
    expect(ran.signal).toBeNull();
    if (ran.stdout.includes('SKIPPED:mkfifo')) {
      expect(ran.stdout).toContain('SKIPPED:');
    } else {
      expect(ran.status).toBe(0);
      const report = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as {
        inspect?: { ok?: boolean; reason?: string };
        storeReason?: string;
      };
      expect(report.inspect).toEqual({ ok: false, reason: 'state_not_file' });
      expect(report.storeReason).toContain('dedup_not_file');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    writeFileSync(path, `${JSON.stringify({ records: {} })}\n`);
    expect(inspectDedupFile(path)).toEqual({ ok: true });
  });
});

describe('R15 leading-zero monitor integers', () => {
  test('/bin/sh rejects 08/09 and still accepts decimal timestamps', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-octal-');
    const curlFail = join(dir, 'curl-fail');
    const curlOk = join(dir, 'curl-ok');
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(curlOk, '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
    const alerts = join(dir, 'alerts.log');
    const alerter = join(dir, 'alert');
    writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });
    const state = join(dir, 'state');

    const run = (extra: Record<string, string>) =>
      spawnSync('/bin/sh', [script], {
        env: {
          PATH: process.env.PATH,
          HEALTH_URL: 'https://webhook-wake.example.com/health',
          FAIL_THRESHOLD: '1',
          COOLDOWN_SEC: '300',
          ALERT_TIMEOUT_SEC: '2',
          CURL_BIN: curlFail,
          ALERT_BIN: alerter,
          STATE_FILE: state,
          NOW_SEC: '100',
          ...extra,
        },
        encoding: 'utf8',
      });

    writeFileSync(state, 'consecutive=08\nalarming=0\npending_recovery=0\nlast_alert=0\n');
    const badCount = run({});
    expect(badCount.status).toBe(2);
    expect(badCount.stderr).toContain('monitor_config_invalid_state consecutive');

    writeFileSync(state, 'consecutive=0\nalarming=1\npending_recovery=0\nlast_alert=09\n');
    const badStamp = run({});
    expect(badStamp.status).toBe(2);
    expect(badStamp.stderr).toContain('monitor_config_invalid_state last_alert');

    writeFileSync(state, 'consecutive=0\nalarming=0\npending_recovery=0\nlast_alert=0\n');
    const badNow = run({ NOW_SEC: '08' });
    expect(badNow.status).toBe(2);
    expect(badNow.stderr).toContain('monitor_config_invalid NOW_SEC');

    const badEnv = run({ FAIL_THRESHOLD: '08' });
    expect(badEnv.status).toBe(2);
    expect(badEnv.stderr).toContain('monitor_config_invalid FAIL_THRESHOLD');

    writeFileSync(state, 'consecutive=0\nalarming=1\npending_recovery=0\nlast_alert=1700000000\n');
    const cooled = run({ CURL_BIN: curlOk, NOW_SEC: '1700000100', COOLDOWN_SEC: '300' });
    expect(cooled.status).toBe(0);
    expect(cooled.stderr).not.toContain('monitor_config_invalid');
  });
});
