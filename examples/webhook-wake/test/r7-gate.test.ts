import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { maxHeaderSize } from 'node:http';
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
import { httpProbe } from '../src/monitor.ts';
import { inspectReadiness } from '../src/readiness.ts';
import { recordingWake } from '../src/wake.ts';
import {
  FIXTURE_SECRET,
  mailBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
} from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { AlertEvent } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('R7 httpProbe closes status-only responses', () => {
  test('never-ending chunked 200 is closed; repeat probes stay exact-200', async () => {
    let open = 0;
    const closed: number[] = [];
    const server = createServer((req, res) => {
      open += 1;
      req.on('close', () => {
        open -= 1;
        closed.push(Date.now());
      });
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/stream' });
        res.end();
        return;
      }
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.write('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    expect((await httpProbe(`${base}/stream`, 400)).ok).toBe(true);
    expect((await httpProbe(`${base}/stream`, 400)).ok).toBe(true);
    expect((await httpProbe(`${base}/redir`, 400)).ok).toBe(false);
    await Bun.sleep(40);
    expect(open).toBe(0);
    expect(closed.length).toBeGreaterThanOrEqual(2);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('R7 timeout 503 flushes then closes', () => {
  test('slow raw socket receives 503, closes, and frees the slot', async () => {
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', maxConcurrent: 1, requestTimeoutMs: 80 }),
      { wake: recordingWake([]) },
    );
    receivers.push(receiver);
    const url = new URL(receiver.url());
    const port = Number(url.port);
    const body = mailBody();

    const slow = await new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(
          `POST /hooks/canary HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nX-OAE-Signature: t=1,v1=${'a'.repeat(64)}\r\n\r\n{`,
        );
      });
      let buf = '';
      let status = 0;
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        const match = buf.match(/^HTTP\/1\.[01] (\d{3})/);
        if (match) status = Number(match[1]);
      });
      sock.on('close', () => resolve({ status, closed: true }));
      sock.on('error', reject);
      setTimeout(() => reject(new Error('slow socket did not close')), 2000);
    });
    expect(slow.status).toBe(503);
    expect(slow.closed).toBe(true);
    const later = await postHook(receiver, { body });
    expect(later.status).toBe(200);
    expect(later.json.disposition).toBe('submitted');
  });
});

describe('R7 transport header budget', () => {
  test('config above process http.maxHeaderSize fails load; default still loads', () => {
    expect(parseFileConfig({}).maxHeaderBytes).toBe(2048);
    const over = Math.max(20_000, maxHeaderSize);
    expect(() => parseFileConfig({ maxHeaderBytes: over })).toThrow('maxHeaderBytes_exceeds_transport');
  });

  test('Bun runtime accepts a >16KiB signature only when the process header ceiling is raised', () => {
    const helper = fileURLToPath(new URL('./r7-large-header.mjs', import.meta.url));
    const denied = spawnSync(process.execPath, [helper], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr + denied.stdout).toContain('431');

    const allowed = spawnSync(process.execPath, ['--max-http-header-size=32768', helper], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain('accepted');
  });
});

describe('R7 receiver alert coalescer clock', () => {
  test('future previous stamp does not mute mapping alerts; ordinary coalesce stays bounded', async () => {
    const alerts: AlertEvent[] = [];
    let now = 100_000;
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), {
      wake: recordingWake([]),
      nowMs: () => now,
      alertCooldownMs: 10_000,
      alert: async (event) => {
        alerts.push(event);
        return { ok: true };
      },
    });
    receivers.push(receiver);
    const mismatch = { data: { address: 'eve@openagent.email', messageId: '123' } };
    expect((await postHook(receiver, { body: mailBody(mismatch), nowMs: now })).status).toBe(503);
    expect(alerts).toHaveLength(1);
    now = 1_000;
    expect((await postHook(receiver, { body: mailBody(mismatch), nowMs: now })).status).toBe(503);
    expect(alerts).toHaveLength(2);
    now = 1_500;
    expect((await postHook(receiver, { body: mailBody(mismatch), nowMs: now })).status).toBe(503);
    expect(alerts).toHaveLength(2);
    expect(receiver.metrics.alertCoalesced).toBe(1);
  });
});

describe('R7 dirsync durability and missing marker', () => {
  test('persist and ancestor stages fail closed; new instance recovers without a marker', async () => {
    const root = tempDir();
    const path = join(root, 'a', 'b', 'dedup.json');
    const cfg = { path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 };
    const rec = {
      key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
      status: 'success' as const,
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    };
    const persist = new DedupStore(cfg);
    persist.injectFailure('dirsync_persist');
    await expect(persist.commit(rec, 1)).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
    expect(existsSync(path)).toBe(false);

    const first = new DedupStore(cfg);
    first.injectFailure('mkdir_fsync');
    await expect(first.commit(rec, 1)).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
    if (existsSync(first.dirsyncPath())) unlinkSync(first.dirsyncPath());

    const synced: string[] = [];
    const restarted = new DedupStore(cfg, { onDirFsync: (dir) => synced.push(dir) });
    await restarted.commit(rec, 1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(restarted.dirsyncPath())).toBe(false);
    expect(synced.some((dir) => dir === join(root, 'a'))).toBe(true);
    expect(synced.some((dir) => dir === join(root, 'a', 'b'))).toBe(true);
  });

  test('0300 parent EACCES fails closed via portable non-root helper', () => {
    const helper = fileURLToPath(new URL('./r8-nonroot-cases.mjs', import.meta.url));
    const ran = spawnSync(process.execPath, [helper, 'durability'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (ran.status === 77) {
      expect(ran.stdout).toContain('SKIPPED:');
      return;
    }
    expect(ran.status).toBe(0);
    expect(ran.stderr + ran.stdout).toContain('EXECUTED:uid=');
  });

  test('truncated dirsync marker stays fail-closed and is not rewritten shorter', async () => {
    const root = tempDir();
    const path = join(root, 'a', 'b', 'dedup.json');
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    const marker = `${path}.dirsync`;
    const invalid = 'relative/shortened-chain\n';
    writeFileSync(marker, '');
    const cfg = { path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 };
    const rec = {
      key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
      status: 'success' as const,
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    };
    const store = new DedupStore(cfg);
    await expect(store.commit(rec, 1)).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync_corrupt' });

    writeFileSync(marker, invalid);
    await expect(new DedupStore(cfg).commit(rec, 1)).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe(invalid);
  });
});

describe('R7 readiness capacity', () => {
  test('full live store is unready; expired records do not consume capacity', () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const live = {
      key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
      status: 'success',
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    };
    const expired = { ...live, key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', expiresAtMs: 1 };
    writeFileSync(path, JSON.stringify({ records: { [live.key]: live } }), { mode: 0o600 });
    expect(inspectDedupFile(path, { maxRecords: 1, nowMs: 100 })).toEqual({ ok: false, reason: 'state_capacity' });
    expect(inspectReadiness(testConfig({ dedup: { path, maxRecords: 1 } }, dir)).stateHealthy).toBe(false);
    writeFileSync(path, JSON.stringify({ records: { [expired.key]: expired } }), { mode: 0o600 });
    expect(inspectDedupFile(path, { maxRecords: 1, nowMs: 100 }).ok).toBe(true);
    expect(inspectReadiness(testConfig({ dedup: { path, maxRecords: 1 } }, dir)).stateHealthy).toBe(true);
    writeFileSync(path, JSON.stringify({ records: {} }), { mode: 0o600 });
    expect(inspectDedupFile(path, { maxRecords: 1, nowMs: 100 }).ok).toBe(true);
  });
});

describe('R7 child output drain', () => {
  test('oversized stdout after a submit marker still commits once', async () => {
    const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
    chmodSync(fakeOrca, 0o755);
    const dir = tempDir();
    const marker = join(dir, 'submitted');
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fakeOrca, outputCapBytes: 32, sendTimeoutMs: 2000 }, dir),
      {
        extraWakeEnv: {
          FAKE_ORCA_MODE: 'submit-then-bigout',
          FAKE_ORCA_OUT_BYTES: '80000',
          FAKE_ORCA_SUBMIT_MARKER: marker,
        },
      },
    );
    receivers.push(receiver);
    const body = mailBody();
    const first = await postHook(receiver, { body });
    expect(first.status).toBe(200);
    expect(first.json.disposition).toBe('submitted');
    expect(readFileSync(marker, 'utf8')).toContain('submitted');
    const again = await postHook(receiver, { body });
    expect(again.status).toBe(200);
    expect(again.json.disposition).toBe('duplicate');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['submitted']);
  });
});
