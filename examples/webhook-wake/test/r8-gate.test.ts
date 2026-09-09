import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpAlert } from '../src/alert.ts';
import { inspectReadiness, inspectStateWritable } from '../src/readiness.ts';
import { tempDir, testConfig } from './helpers.ts';

function dacAvailable(): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== 0;
}

function runNonrootHelper(mode: string): { status: number | null; text: string } {
  const helper = fileURLToPath(new URL('./r8-nonroot-cases.mjs', import.meta.url));
  const ran = spawnSync(process.execPath, [helper, mode], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: ran.status, text: `${ran.stdout}${ran.stderr}` };
}

describe('R8 portable 0300 privilege precondition', () => {
  test('durability helper executes as a non-root uid or names the skip', () => {
    const ran = runNonrootHelper('durability');
    if (ran.status === 77) {
      expect(ran.text).toContain('SKIPPED:');
      return;
    }
    expect(ran.status).toBe(0);
    expect(ran.text).toContain('EXECUTED:uid=');
  });
});

describe('R8 readiness ancestor read+write+search', () => {
  test('0300 state and ancestor are unready before wake; readable chain stays ready', () => {
    if (!dacAvailable()) {
      const ran = runNonrootHelper('readiness');
      if (ran.status === 77) {
        expect(ran.text).toContain('SKIPPED:');
        return;
      }
      expect(ran.status).toBe(0);
      expect(ran.text).toContain('EXECUTED:uid=');
      return;
    }

    const root = tempDir();
    const ok = join(root, 'ok');
    mkdirSync(ok, { mode: 0o700 });
    const okPath = join(ok, 'dedup.json');
    expect(inspectStateWritable(okPath)).toBe(true);
    const readyOk = inspectReadiness(testConfig({ dedup: { path: okPath } }, ok));
    expect(readyOk.stateWritable).toBe(true);
    expect(readyOk.ready).toBe(true);

    const state0300 = join(root, 'state300');
    mkdirSync(state0300, { mode: 0o700 });
    chmodSync(state0300, 0o300);
    try {
      const path = join(state0300, 'dedup.json');
      expect(inspectStateWritable(path)).toBe(false);
      const report = inspectReadiness(testConfig({ dedup: { path } }, root));
      expect(report.stateWritable).toBe(false);
      expect(report.ready).toBe(false);
      expect(report.warnings).toContain('state_unwritable');
    } finally {
      chmodSync(state0300, 0o700);
    }

    const wall = join(root, 'wall');
    mkdirSync(wall, { mode: 0o700 });
    chmodSync(wall, 0o300);
    try {
      const nested = join(wall, 'new', 'dedup.json');
      expect(inspectStateWritable(nested)).toBe(false);
      const report = inspectReadiness(testConfig({ dedup: { path: nested } }, root));
      expect(report.stateWritable).toBe(false);
      expect(report.ready).toBe(false);
    } finally {
      chmodSync(wall, 0o700);
    }
  });
});

describe('R8 createHttpAlert closes response bodies', () => {
  const receivers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (receivers.length) await receivers.pop()!.close();
  });

  test('endless chunked 200 and 500 close sockets; exact 200, redirect, and timeout stay', async () => {
    let open = 0;
    const server = createServer((req, res) => {
      open += 1;
      req.on('close', () => {
        open -= 1;
      });
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
      if (req.url === '/fail') {
        res.writeHead(500, { 'transfer-encoding': 'chunked' });
        res.write('no');
        return;
      }
      if (req.url === '/hang') {
        return;
      }
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receivers.push({
      close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    const event = { kind: 'receiver_failure' as const, code: 'send_failed' as const };

    const stream = createHttpAlert(`${base}/stream`, 400);
    expect((await stream(event)).ok).toBe(true);
    expect((await stream(event)).ok).toBe(true);
    const fail = createHttpAlert(`${base}/fail`, 400);
    expect((await fail(event)).ok).toBe(false);
    expect((await fail(event)).reason).toBe('alert_http_status');
    await Bun.sleep(40);
    expect(open).toBe(0);

    expect((await createHttpAlert(`${base}/ok`, 400)(event)).ok).toBe(true);
    expect((await createHttpAlert(`${base}/redir`, 400)(event)).ok).toBe(false);
    const hung = await createHttpAlert(`${base}/hang`, 80)(event);
    expect(hung.ok).toBe(false);
    expect(hung.reason).toBe('alert_transport');
    await Bun.sleep(40);
    expect(open).toBe(0);
  });
});
