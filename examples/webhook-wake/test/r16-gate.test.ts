import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_RETENTION_MS,
  PRODUCER_RETRY_HORIZON_MS,
  RETENTION_DELIVERY_MARGIN_MS,
  loadConfigFile,
  parseFileConfig,
} from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
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

function runBoundedHelper(name: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  const helper = fileURLToPath(new URL(name, import.meta.url));
  const ran = spawnSync(process.execPath, [helper], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    timeout: 2000,
  });
  return { status: ran.status, signal: ran.signal, stdout: ran.stdout };
}

describe('R16 dirsync marker FIFO', () => {
  test('FIFO .dirsync is rejected before read; regular marker still recovers', async () => {
    const ran = runBoundedHelper('./r16-dirsync-fifo-probe.mjs');
    expect(ran.signal).toBeNull();
    if (ran.stdout.includes('SKIPPED:mkfifo')) {
      expect(ran.stdout).toContain('SKIPPED:');
    } else {
      expect(ran.status).toBe(0);
      const report = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as {
        inspect?: { ok?: boolean; reason?: string };
        storeReason?: string;
      };
      expect(report.inspect).toEqual({ ok: false, reason: 'state_dirsync_not_file' });
      expect(report.storeReason).toContain('dedup_dirsync_not_file');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    writeFileSync(`${path}.dirsync`, `${dir}\n`, { mode: 0o600 });
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync' });
    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    await store.commit(
      {
        key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
        status: 'success',
        storedAtMs: 1,
        expiresAtMs: 9_999_999_999_999,
      },
      1,
    );
    expect(inspectDedupFile(path).ok).toBe(true);
    expect(existsSync(`${path}.dirsync`)).toBe(false);
  });
});

describe('R16 unacked marker FIFO', () => {
  test('FIFO .unacked plus dir_fsync fails closed; regular marker still recovers', async () => {
    const ran = runBoundedHelper('./r16-unacked-fifo-probe.mjs');
    expect(ran.signal).toBeNull();
    if (ran.stdout.includes('SKIPPED:mkfifo')) {
      expect(ran.stdout).toContain('SKIPPED:');
    } else {
      expect(ran.status).toBe(0);
      const report = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as {
        inspect?: { ok?: boolean; reason?: string };
        storeReason?: string;
      };
      expect(report.inspect).toEqual({ ok: false, reason: 'state_unacked' });
      expect(report.storeReason).toContain('dedup_unacked_not_file');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const key = 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555';
    writeFileSync(
      path,
      `${JSON.stringify({
        records: { [key]: { key, status: 'success', storedAtMs: 1, expiresAtMs: 9_999_999_999_999 } },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(`${path}.unacked`, 'unacked\n', { mode: 0o600 });
    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    store.injectFailure('dir_fsync');
    await expect(store.get(key, 1)).rejects.toMatchObject({ message: 'dedup_dir_fsync_failed' });
    expect(existsSync(`${path}.unacked`)).toBe(true);
    const hit = await store.get(key, 1);
    expect(hit?.status).toBe('success');
    expect(existsSync(`${path}.unacked`)).toBe(false);
  });
});

describe('R16 durable unacked before rename', () => {
  test('unacked persist failure withholds 2xx and does not ACK the rename', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('unacked_persist');
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('dedup_dir_fsync_failed');
    expect(first.json.disposition).not.toBe('duplicate');
    expect(existsSync(receiver.dedup.config.path)).toBe(false);
    expect(bucket).toHaveLength(1);

    const retry = await postHook(receiver, { body: mailBody() });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(2);
  });

  test('dir_fsync failure after a durable marker stays 503 across restart until parent sync', async () => {
    const bucket: WakeRequest[] = [];
    const config = testConfig({ mode: 'canary' });
    const receiver = await startReceiver(config, { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('dir_fsync');
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('dedup_dir_fsync_failed');
    expect(existsSync(receiver.dedup.unackedPath())).toBe(true);
    expect(existsSync(receiver.dedup.config.path)).toBe(true);

    await receiver.close();
    receivers.pop();

    const { createReceiver, listenReceiver } = await import('../src/server.ts');
    const restarted = createReceiver(config, { wake: recordingWake(bucket) });
    await listenReceiver(restarted);
    receivers.push(restarted);
    restarted.dedup.injectFailure('dir_fsync');
    const blocked = await postHook(restarted, { body: mailBody() });
    expect(blocked.status).toBe(503);
    expect(blocked.json.disposition).not.toBe('duplicate');
    expect(existsSync(restarted.dedup.unackedPath())).toBe(true);

    const recovered = await postHook(restarted, { body: mailBody() });
    expect(recovered.status).toBe(200);
    expect(recovered.json.disposition).toBe('duplicate');
    expect(existsSync(restarted.dedup.unackedPath())).toBe(false);
    expect(bucket).toHaveLength(1);
  });
});

describe('R16 config root shape', () => {
  test('null/array/scalar roots fail; ordinary object still loads', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    const write = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    expect(() => loadConfigFile(write('null.json', 'null'))).toThrow('config_invalid:root');
    expect(() => loadConfigFile(write('array.json', '[]'))).toThrow('config_invalid:root');
    expect(() => loadConfigFile(write('scalar.json', '1'))).toThrow('config_invalid:root');
    expect(() => parseFileConfig(null)).toThrow('config_invalid:root');
    expect(() => parseFileConfig([])).toThrow('config_invalid:root');
    expect(() => parseFileConfig('observe')).toThrow('config_invalid:root');
    const loaded = loadConfigFile(write('ok.json', JSON.stringify(base)));
    expect(loaded.routes).toHaveLength(1);
    expect(loaded.listen.host).toBe('127.0.0.1');
  });
});

describe('R16 secret FIFO', () => {
  test('secret FIFO fails closed without hanging; regular 0600 still loads', () => {
    const ran = runBoundedHelper('./r16-secret-fifo-probe.mjs');
    expect(ran.signal).toBeNull();
    if (ran.stdout.includes('SKIPPED:mkfifo')) {
      expect(ran.stdout).toContain('SKIPPED:');
    } else {
      expect(ran.status).toBe(0);
      const report = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { reason?: string };
      expect(report.reason).toContain('secret_not_file');
    }

    const dir = tempDir();
    const ok = parseFileConfig(fileBase(dir));
    expect(ok.routes[0]?.secret).toBe(FIXTURE_SECRET);
  });
});

describe('R16 retention past producer horizon', () => {
  test('minimum retention outlasts the pinned +72h attempt and still expires at the min', async () => {
    expect(MIN_RETENTION_MS).toBe(PRODUCER_RETRY_HORIZON_MS + RETENTION_DELIVERY_MARGIN_MS);
    expect(MIN_RETENTION_MS).toBeGreaterThan(PRODUCER_RETRY_HORIZON_MS);

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    const key = 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555';
    const firstAttempt = 1_700_000_000_000;
    await store.commit(
      {
        key,
        status: 'success',
        storedAtMs: firstAttempt,
        expiresAtMs: firstAttempt + MIN_RETENTION_MS,
      },
      firstAttempt,
    );
    // Producer attempt 11 is pinned at first+72h (packages/api webhook-delivery.ts).
    expect(await store.get(key, firstAttempt + PRODUCER_RETRY_HORIZON_MS)).toBeDefined();
    expect(await store.get(key, firstAttempt + PRODUCER_RETRY_HORIZON_MS + 5_000)).toBeDefined();
    expect(await store.get(key, firstAttempt + MIN_RETENTION_MS)).toBeUndefined();
  });
});
