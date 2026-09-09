import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
import { recordingWake } from '../src/wake.ts';
import { mailBody, postHook, startReceiver, tempDir, testConfig } from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function exclusiveTemps(dir: string, destName: string): string[] {
  const escaped = destName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return readdirSync(dir).filter((name) => new RegExp(`^${escaped}\\.tmp\\.[0-9a-f]{32}$`).test(name));
}

const RECORD = {
  key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
  status: 'success' as const,
  storedAtMs: 1,
  expiresAtMs: 9_999_999_999_999,
};

describe('R17 exclusive dedup temp', () => {
  test('legacy .tmp.<pid> FIFO does not block; preexisting file and symlink are not reused', async () => {
    const helper = fileURLToPath(new URL('./r17-legacy-tmp-fifo-probe.mjs', import.meta.url));
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
      const report = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}') as { storeReason?: string };
      expect(report.storeReason).toBe('ok');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const legacy = `${path}.tmp.${process.pid}`;
    writeFileSync(legacy, 'foreign-precreate\n', { mode: 0o666 });
    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    await store.commit(RECORD, 1);
    expect(inspectDedupFile(path).ok).toBe(true);
    expect(readFileSync(legacy, 'utf8')).toBe('foreign-precreate\n');

    const victim = join(dir, 'victim.json');
    writeFileSync(victim, 'do-not-overwrite\n', { mode: 0o600 });
    unlinkSync(legacy);
    symlinkSync(victim, legacy);
    await store.commit({ ...RECORD, storedAtMs: 2, expiresAtMs: 9_999_999_999_998 }, 2);
    expect(readFileSync(victim, 'utf8')).toBe('do-not-overwrite\n');
    expect(existsSync(legacy)).toBe(true);
    expect(inspectDedupFile(path).ok).toBe(true);
  });

  test('injected short write either finishes the payload or fails without ACK', async () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const destName = basename(path);
    const complete = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    complete.injectFailure('write_short');
    await complete.commit(RECORD, 1);
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { records: Record<string, { key: string }> };
    expect(parsed.records[RECORD.key]?.key).toBe(RECORD.key);
    expect(raw.startsWith('{')).toBe(true);
    expect(raw.endsWith('}')).toBe(true);
    expect(exclusiveTemps(dir, destName)).toEqual([]);

    const stalled = join(dir, 'stall.json');
    const zero = new DedupStore({ path: stalled, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    zero.injectFailure('write_zero');
    await expect(zero.commit(RECORD, 1)).rejects.toMatchObject({ message: 'dedup_write_short' });
    expect(existsSync(stalled)).toBe(false);
    expect(exclusiveTemps(dir, basename(stalled))).toEqual([]);

    const mixed = join(dir, 'mixed.json');
    const partial = new DedupStore({ path: mixed, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    partial.injectFailure('write_short');
    partial.injectFailure('write_zero');
    await expect(partial.commit(RECORD, 1)).rejects.toMatchObject({ message: 'dedup_write_short' });
    expect(existsSync(mixed)).toBe(false);
    expect(exclusiveTemps(dir, basename(mixed))).toEqual([]);

    const ioPath = join(dir, 'io.json');
    const io = new DedupStore({ path: ioPath, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    io.injectFailure('write_io');
    await expect(io.commit(RECORD, 1)).rejects.toMatchObject({ message: 'dedup_write_failed' });
    expect(existsSync(ioPath)).toBe(false);
    expect(exclusiveTemps(dir, basename(ioPath))).toEqual([]);
  });

  test('zero-progress write is 503 and stays retryable', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('write_zero');
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('storage_failed');
    expect(first.json.disposition).not.toBe('duplicate');
    expect(existsSync(receiver.dedup.config.path)).toBe(false);
    expect(exclusiveTemps(dirname(receiver.dedup.config.path), basename(receiver.dedup.config.path))).toEqual([]);

    const retry = await postHook(receiver, { body: mailBody() });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(2);
  });
});
