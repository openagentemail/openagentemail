import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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

const RECORD = {
  key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
  status: 'success' as const,
  storedAtMs: 1,
  expiresAtMs: 9_999_999_999_999,
};

describe('R18 pre-wake dirsync', () => {
  test('FIFO and corrupt .dirsync 503 with zero wake; valid marker still recovers', async () => {
    const helper = fileURLToPath(new URL('./r18-dirsync-fifo-get-probe.mjs', import.meta.url));
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
        inspect?: { reason?: string };
        storeReason?: string;
      };
      expect(report.inspect?.reason).toBe('state_dirsync_not_file');
      expect(report.storeReason).toContain('dedup_dirsync_not_file');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    writeFileSync(`${path}.dirsync`, '', { mode: 0o600 });
    const wakes: WakeRequest[] = [];
    const bad = await startReceiver(testConfig({ mode: 'canary', dedup: { path } }, dir), {
      wake: recordingWake(wakes),
    });
    receivers.push(bad);
    const first = await postHook(bad, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('dedup_mkdir_fsync_failed');
    expect(wakes).toHaveLength(0);
    const retry = await postHook(bad, { body: mailBody() });
    expect(retry.status).toBe(503);
    expect(wakes).toHaveLength(0);
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_dirsync_corrupt' });

    writeFileSync(`${path}.dirsync`, `${dir}\n`, { mode: 0o600 });
    const recovered: WakeRequest[] = [];
    const ok = await startReceiver(testConfig({ mode: 'canary', dedup: { path } }, dir), {
      wake: recordingWake(recovered),
    });
    receivers.push(ok);
    const posted = await postHook(ok, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(recovered).toHaveLength(1);
    expect(existsSync(`${path}.dirsync`)).toBe(false);
  });
});

describe('R18 bounded temp basename', () => {
  test('240-byte ASCII and multibyte dest names commit without ENAMETOOLONG after wake', async () => {
    const asciiDir = tempDir();
    const asciiName = 'a'.repeat(240);
    expect(Buffer.byteLength(asciiName, 'utf8')).toBe(240);
    const asciiPath = join(asciiDir, asciiName);
    const store = new DedupStore({ path: asciiPath, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    await store.commit(RECORD, 1);
    expect(inspectDedupFile(asciiPath).ok).toBe(true);

    const mbDir = tempDir();
    const mbName = '中'.repeat(80);
    expect(Buffer.byteLength(mbName, 'utf8')).toBe(240);
    const mbPath = join(mbDir, mbName);
    const mbStore = new DedupStore({ path: mbPath, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    await mbStore.commit({ ...RECORD, storedAtMs: 2 }, 2);
    expect(inspectDedupFile(mbPath).ok).toBe(true);

    const liveDir = tempDir();
    const livePath = join(liveDir, 'b'.repeat(240));
    const wakes: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary', dedup: { path: livePath } }, liveDir), {
      wake: recordingWake(wakes),
    });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(wakes).toHaveLength(1);
    expect(inspectDedupFile(livePath).ok).toBe(true);
  });
});
