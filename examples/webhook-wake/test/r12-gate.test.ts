import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFileConfig } from '../src/config.ts';
import { probeRequestHostname } from '../src/monitor.ts';
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

function unfinishedReject(
  port: number,
  request: string,
): Promise<{ status: number; closed: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(request);
    });
    let buf = '';
    let status = 0;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      if (match) status = Number(match[1]);
    });
    sock.on('close', () => {
      const reason = buf.match(/"reason":"([^"]+)"/)?.[1];
      resolve({ status, closed: true, reason });
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error(`unfinished socket did not close: ${request.slice(0, 48)}`)), 2000);
  });
}

function unfinishedPost(path: string, extraHeaders = ''): string {
  return `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n${extraHeaders}\r\n{`;
}

describe('R12 early-reject unfinished Content-Length', () => {
  test('each pre-body reject preserves status, closes, and leaves valid signed traffic working', async () => {
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', maxConcurrent: 1, maxHeaderBytes: 256, requestTimeoutMs: 80 }),
      { wake: recordingWake([]) },
    );
    receivers.push(receiver);
    const port = Number(new URL(receiver.url()).port);
    const oversize = `X-OAE-Signature: t=1,v1=${'a'.repeat(300)}\r\n`;

    const unknownKey = await unfinishedReject(port, unfinishedPost('/hooks/@bad'));
    expect(unknownKey).toEqual({ status: 404, closed: true, reason: 'unknown_route' });

    const unknownMap = await unfinishedReject(port, unfinishedPost('/hooks/nope'));
    expect(unknownMap).toEqual({ status: 404, closed: true, reason: 'unknown_route' });

    const oversizeHeader = await unfinishedReject(port, unfinishedPost('/hooks/canary', oversize));
    expect(oversizeHeader).toEqual({ status: 401, closed: true, reason: 'invalid_header' });

    const badEncoding = await unfinishedReject(port, unfinishedPost('/hooks/%'));
    expect(badEncoding).toEqual({ status: 400, closed: true, reason: 'bad_route_encoding' });

    const notFound = await unfinishedReject(port, unfinishedPost('/other'));
    expect(notFound).toEqual({ status: 404, closed: true, reason: 'not_found' });

    const wrongMethod = await unfinishedReject(
      port,
      `GET /hooks/canary HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4096\r\n\r\n{`,
    );
    expect(wrongMethod).toEqual({ status: 404, closed: true, reason: 'not_found' });

    const holder = createConnection({ host: '127.0.0.1', port }, () => {
      holder.write(
        unfinishedPost('/hooks/canary', `X-OAE-Signature: t=1,v1=${'a'.repeat(64)}\r\n`),
      );
    });
    await Bun.sleep(20);
    const busy = await unfinishedReject(port, unfinishedPost('/hooks/canary'));
    expect(busy).toEqual({ status: 503, closed: true, reason: 'max_concurrent' });
    await new Promise<void>((resolve) => {
      holder.on('close', () => resolve());
      setTimeout(() => {
        holder.destroy();
        resolve();
      }, 2000);
    });

    const later = await postHook(receiver, { body: mailBody() });
    expect(later.status).toBe(200);
    expect(later.json.disposition).toBe('submitted');
  });
});

describe('R12 dedup container and file path', () => {
  test('present null array scalar string fail; absent and object keep defaults', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig(base).dedup.path).toBe('/var/lib/webhook-wake/dedup.json');
    expect(parseFileConfig({ ...base, dedup: {} }).dedup.path).toBe('/var/lib/webhook-wake/dedup.json');
    expect(() => parseFileConfig({ ...base, dedup: null } as unknown as FileConfig)).toThrow('config_invalid:dedup');
    expect(() => parseFileConfig({ ...base, dedup: ['/tmp/x.json'] } as unknown as FileConfig)).toThrow(
      'config_invalid:dedup',
    );
    expect(() => parseFileConfig({ ...base, dedup: 1 } as unknown as FileConfig)).toThrow('config_invalid:dedup');
    expect(() => parseFileConfig({ ...base, dedup: '/tmp/wrong.json' } as unknown as FileConfig)).toThrow(
      'config_invalid:dedup',
    );
    expect(existsSync(join(dir, 'dedup.json'))).toBe(false);
  });

  test('trailing separator and root-as-file fail load with no store I/O', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig({ ...base, dedup: { path: '/tmp/webhook-wake-dedup.json' } }).dedup.path).toBe(
      '/tmp/webhook-wake-dedup.json',
    );
    expect(() => parseFileConfig({ ...base, dedup: { path: '/tmp/x.json/' } })).toThrow('config_invalid:dedup.path');
    expect(() => parseFileConfig({ ...base, dedup: { path: '/' } })).toThrow('config_invalid:dedup.path');
    expect(() => parseFileConfig({ ...base, dedup: { path: '/tmp/' } })).toThrow('config_invalid:dedup.path');
    expect(existsSync(join(dir, 'dedup.json'))).toBe(false);
    expect(existsSync('/tmp/x.json')).toBe(false);
  });
});

describe('R12 IPv6 httpProbe', () => {
  test('strips URL brackets and probes a real ::1 receiver in a proxy-free child', () => {
    expect(probeRequestHostname('[::1]')).toBe('::1');
    expect(probeRequestHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(probeRequestHostname(new URL('http://[::1]:8787/health').hostname)).toBe('::1');

    const helper = fileURLToPath(new URL('./r12-ipv6-probe.mjs', import.meta.url));
    const env = { ...process.env };
    for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
      delete env[key];
    }
    const result = spawnSync(process.execPath, [helper], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env,
      encoding: 'utf8',
    });
    if (result.stdout.includes('SKIPPED:ipv6_unavailable')) {
      expect(result.stdout).toContain('SKIPPED:');
      return;
    }
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      healthOk?: boolean;
      redirectOk?: boolean;
      urlHostname?: string;
    };
    expect(report.healthOk).toBe(true);
    expect(report.redirectOk).toBe(false);
    expect(report.urlHostname).toBe('[::1]');
  });
});

describe('R12 monitor.sh integer preflight', () => {
  test('invalid threshold cooldown and alert timeout exit visibly; zero cooldown still works', () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-ints-');
    const curlOk = join(dir, 'curl-ok');
    const curlFail = join(dir, 'curl-fail');
    const alerts = join(dir, 'alerts.log');
    writeFileSync(curlOk, '#!/bin/sh\nprintf 200\n', { mode: 0o755 });
    writeFileSync(curlFail, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const alerter = join(dir, 'alert');
    writeFileSync(alerter, `#!/bin/sh\necho "$1" >> "${alerts}"\nexit 0\n`, { mode: 0o755 });

    const run = (extra: Record<string, string>) =>
      spawnSync('sh', [script], {
        env: {
          PATH: process.env.PATH,
          HEALTH_URL: 'https://webhook-wake.example.com/health',
          FAIL_THRESHOLD: '2',
          COOLDOWN_SEC: '0',
          ALERT_TIMEOUT_SEC: '2',
          CURL_BIN: curlFail,
          ALERT_BIN: alerter,
          STATE_FILE: join(dir, 'state'),
          ...extra,
        },
        encoding: 'utf8',
      });

    const badThreshold = run({ FAIL_THRESHOLD: '0' });
    expect(badThreshold.status).toBe(2);
    expect(badThreshold.stderr).toContain('monitor_config_invalid FAIL_THRESHOLD');

    const badWord = run({ FAIL_THRESHOLD: 'abc' });
    expect(badWord.status).toBe(2);
    expect(badWord.stderr).toContain('monitor_config_invalid FAIL_THRESHOLD');

    const badCooldown = run({ COOLDOWN_SEC: '-1' });
    expect(badCooldown.status).toBe(2);
    expect(badCooldown.stderr).toContain('monitor_config_invalid COOLDOWN_SEC');

    const badAlert = run({ ALERT_TIMEOUT_SEC: '0' });
    expect(badAlert.status).toBe(2);
    expect(badAlert.stderr).toContain('monitor_config_invalid ALERT_TIMEOUT_SEC');

    expect(existsSync(alerts)).toBe(false);

    expect(run({ FAIL_THRESHOLD: '1', COOLDOWN_SEC: '0', CURL_BIN: curlFail }).status).toBe(1);
    expect(existsSync(alerts)).toBe(true);
    expect(run({ FAIL_THRESHOLD: '1', COOLDOWN_SEC: '0', CURL_BIN: curlOk }).status).toBe(0);
  });
});
