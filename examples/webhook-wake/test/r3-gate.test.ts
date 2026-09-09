import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { inspectDedupFile } from '../src/dedup.ts';
import { isDomain, isLoopbackHost, isMailbox } from '../src/ids.ts';
import { inspectReadiness } from '../src/readiness.ts';
import { recordingWake } from '../src/wake.ts';
import {
  FIXTURE_SECRET,
  mailBody,
  pingBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  testRoute,
  writeSecretFile,
} from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { AlertEvent, WakeRequest } from '../src/types.ts';
import type { FileConfig } from '../src/config.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function fileBase(dir: string, domain = 'openagent.email'): FileConfig {
  const secret = writeSecretFile(dir, 'ok.whs', FIXTURE_SECRET);
  return {
    routes: {
      canary: {
        subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        domain,
        mailbox: 'alice@openagent.email',
        secretFile: secret,
        terminal: 'term_examplecanary0001',
      },
    },
  };
}

describe('R3 ping binding', () => {
  test('correct ping stays ping_ok; wrong webhookId or domain fails without wake', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const ok = await postHook(receiver, { body: pingBody() });
    expect(ok.status).toBe(200);
    expect(ok.json.disposition).toBe('ping_ok');

    const wrongId = await postHook(receiver, {
      body: pingBody().replace('whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'whk_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    });
    expect(wrongId.status).toBe(400);
    expect(wrongId.json.reason).toBe('ping_binding_mismatch');

    const wrongDomain = await postHook(receiver, {
      body: JSON.stringify({
        ...JSON.parse(pingBody()),
        domain: 'evil.example',
        id: 'evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    });
    expect(wrongDomain.status).toBe(400);
    expect(wrongDomain.json.reason).toBe('ping_binding_mismatch');

    const missingId = JSON.parse(pingBody()) as { data: Record<string, unknown>; id: string };
    delete missingId.data.webhookId;
    missingId.id = 'evt_bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const missing = await postHook(receiver, { body: JSON.stringify(missingId) });
    expect(missing.status).toBe(400);
    expect(missing.json.reason).toBe('ping_binding_mismatch');
    expect(bucket).toHaveLength(0);
    expect(receiver.metrics.ping).toBe(1);
    expect(receiver.metrics.submitted).toBe(0);
  });
});

describe('R3 readiness store inspect', () => {
  test('corrupt or unacked durable state is unready and is not rewritten', async () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const corruptBody = '{not-json';
    writeFileSync(path, corruptBody, { mode: 0o600 });
    const corrupt = inspectReadiness(testConfig({ dedup: { path } }, dir));
    expect(corrupt.stateHealthy).toBe(false);
    expect(corrupt.ready).toBe(false);
    expect(corrupt.warnings).toContain('state_corrupt');
    expect(inspectDedupFile(path).ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(corruptBody);
    expect(existsSync(`${path}.unacked`)).toBe(false);

    const good = join(dir, 'ok.json');
    const goodBody = JSON.stringify({ records: {} });
    writeFileSync(good, goodBody, { mode: 0o600 });
    writeFileSync(`${good}.unacked`, 'unacked\n', { mode: 0o600 });
    const pending = inspectReadiness(testConfig({ dedup: { path: good } }, dir));
    expect(pending.ready).toBe(false);
    expect(pending.warnings).toContain('state_unacked');
    expect(inspectDedupFile(good)).toEqual({ ok: false, reason: 'state_unacked' });
    expect(readFileSync(good, 'utf8')).toBe(goodBody);
    expect(readFileSync(`${good}.unacked`, 'utf8')).toBe('unacked\n');
  });
});

describe('R3 producer-compatible domains', () => {
  test('localhost is accepted; mailbox rules stay strict', () => {
    expect(isDomain('localhost')).toBe(true);
    expect(isDomain('openagent.email')).toBe(true);
    expect(isDomain('')).toBe(false);
    expect(isDomain('a..b')).toBe(false);
    expect(isDomain('-bad.example')).toBe(false);
    expect(isDomain('a'.repeat(64))).toBe(false);
    expect(isMailbox('alice@localhost')).toBe(true);
    const dir = tempDir();
    const loaded = parseFileConfig({ ...fileBase(dir, 'localhost'), dedup: { retentionMs: MIN_RETENTION_MS } });
    expect(loaded.routes[0]?.domain).toBe('localhost');
  });
});

describe('R3 monitor exact HTTP 200', () => {
  test('shipped monitor.sh treats 200 as ok and 302/404/503 as failure', async () => {
    const script = fileURLToPath(new URL('../templates/monitor.sh', import.meta.url));
    chmodSync(script, 0o755);
    const dir = tempDir('monitor-http-');
    const statuses = new Map<string, number>([
      ['/ok', 200],
      ['/redir', 302],
      ['/missing', 404],
      ['/down', 503],
    ]);
    const server = createServer((req, res) => {
      const status = statuses.get(req.url ?? '') ?? 500;
      if (status === 302) {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      res.writeHead(status);
      res.end(status === 200 ? '{"status":"ok"}' : 'no');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    // spawn (not spawnSync): the in-process HTTP server must keep serving.
    const run = (path: string) =>
      new Promise<{ status: number | null }>((resolve, reject) => {
        const child = spawn('sh', [script], {
          env: {
            PATH: process.env.PATH,
            HEALTH_URL: `${base}${path}`,
            FAIL_THRESHOLD: '1',
            COOLDOWN_SEC: '0',
            STATE_FILE: join(dir, `state-${path.slice(1)}`),
          },
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status }));
      });
    expect((await run('/ok')).status).toBe(0);
    expect((await run('/redir')).status).toBe(1);
    expect((await run('/missing')).status).toBe(1);
    expect((await run('/down')).status).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('R3 boolean route flags', () => {
  test('string true/false fail load; absent defaults do not wake a disabled canary', () => {
    const dir = tempDir();
    expect(() =>
      parseFileConfig({
        ...fileBase(dir),
        routes: { canary: { ...fileBase(dir).routes!.canary!, active: 'false' } },
      }),
    ).toThrow('config_invalid:active');
    expect(() =>
      parseFileConfig({
        ...fileBase(dir),
        routes: { canary: { ...fileBase(dir).routes!.canary!, stale: 'true' } },
      }),
    ).toThrow('config_invalid:stale');
    const absent = parseFileConfig(fileBase(dir));
    expect(absent.routes[0]?.active).toBe(true);
    expect(absent.routes[0]?.stale).toBe(false);
  });

  test('boolean active false does not wake canary', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', routes: [testRoute({ active: false })] }),
      { wake: recordingWake(bucket) },
    );
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(posted.json.reason).toBe('stale_mapping');
    expect(bucket).toHaveLength(0);
    expect(receiver.metrics.submitted).toBe(0);
  });
});

describe('R3 documented 404/401 distinction', () => {
  test('unknown route is 404 and known unsigned route is 401; neither wakes', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const unknown = await postHook(receiver, { routeKey: 'nope', body: mailBody() });
    expect(unknown.status).toBe(404);
    const unsigned = await fetch(`${receiver.url()}/hooks/canary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mailBody(),
    });
    expect(unsigned.status).toBe(401);
    expect(bucket).toHaveLength(0);
  });
});

describe('R3 alert coalescing and timeout response', () => {
  test('repeated signed mapping failures alert once and stay 503', async () => {
    const alerts: AlertEvent[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), {
      wake: recordingWake([]),
      alert: async (event) => {
        alerts.push(event);
        return { ok: true };
      },
      alertCooldownMs: 60_000,
    });
    receivers.push(receiver);
    for (let i = 0; i < 4; i += 1) {
      const posted = await postHook(receiver, {
        body: mailBody({ data: { address: 'eve@openagent.email', messageId: '123' } }),
      });
      expect(posted.status).toBe(503);
    }
    expect(alerts).toHaveLength(1);
    expect(receiver.metrics.alertCoalesced).toBe(3);
  });

  test('request timeout writes 503 once; later completion does not throw and retry works', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receiver = await startReceiver(testConfig({ mode: 'canary', requestTimeoutMs: 40 }), {
      wake: async (req) => {
        await gate;
        return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
      },
    });
    receivers.push(receiver);
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('request_timeout');
    release();
    await Bun.sleep(30);
    const retry = await postHook(receiver, { body: mailBody({ id: 'evt_22222222-3333-4444-5555-666666666666' }) });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
  });
});

describe('R3 non-loopback warning', () => {
  test('non-loopback bind is warned without secrets', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    const report = inspectReadiness(testConfig({ listen: { host: '0.0.0.0', port: 0 } }));
    expect(report.warnings).toContain('listen_not_loopback');
    expect(JSON.stringify(report)).not.toMatch(/whs_/);
  });
});
