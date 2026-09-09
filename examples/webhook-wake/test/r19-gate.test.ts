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

describe('R19 dirsync component types', () => {
  test('FIFO or regular-file components 503 with zero wake; directories recover', async () => {
    const helper = fileURLToPath(new URL('./r19-dirsync-fifo-target-probe.mjs', import.meta.url));
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
      expect(report.storeReason).toContain('dedup_dirsync_not_dir');
    }

    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    const fileTarget = join(dir, 'as-file');
    writeFileSync(fileTarget, 'not-a-dir\n', { mode: 0o600 });
    writeFileSync(`${path}.dirsync`, `${fileTarget}\n`, { mode: 0o600 });
    const fileWakes: WakeRequest[] = [];
    const fileRecv = await startReceiver(testConfig({ mode: 'canary', dedup: { path } }, dir), {
      wake: recordingWake(fileWakes),
    });
    receivers.push(fileRecv);
    const fileFirst = await postHook(fileRecv, { body: mailBody() });
    expect(fileFirst.status).toBe(503);
    expect(fileFirst.json.reason).toBe('dedup_mkdir_fsync_failed');
    expect(fileWakes).toHaveLength(0);
    const fileRetry = await postHook(fileRecv, { body: mailBody() });
    expect(fileRetry.status).toBe(503);
    expect(fileWakes).toHaveLength(0);

    const fifoDir = tempDir();
    const fifoPath = join(fifoDir, 'dedup.json');
    writeFileSync(fifoPath, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    const fifo = join(fifoDir, 'pipe');
    const mk = spawnSync('mkfifo', ['-m', '0644', fifo], { encoding: 'utf8' });
    if (mk.status === 0) {
      writeFileSync(`${fifoPath}.dirsync`, `${fifo}\n`, { mode: 0o600 });
      const fifoWakes: WakeRequest[] = [];
      const fifoRecv = await startReceiver(testConfig({ mode: 'canary', dedup: { path: fifoPath } }, fifoDir), {
        wake: recordingWake(fifoWakes),
      });
      receivers.push(fifoRecv);
      const fifoFirst = await postHook(fifoRecv, { body: mailBody() });
      expect(fifoFirst.status).toBe(503);
      expect(fifoWakes).toHaveLength(0);
      const fifoRetry = await postHook(fifoRecv, { body: mailBody() });
      expect(fifoRetry.status).toBe(503);
      expect(fifoWakes).toHaveLength(0);
    }

    const okDir = tempDir();
    const okPath = join(okDir, 'dedup.json');
    writeFileSync(okPath, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
    writeFileSync(`${okPath}.dirsync`, `${okDir}\n`, { mode: 0o600 });
    const okWakes: WakeRequest[] = [];
    const okRecv = await startReceiver(testConfig({ mode: 'canary', dedup: { path: okPath } }, okDir), {
      wake: recordingWake(okWakes),
    });
    receivers.push(okRecv);
    const posted = await postHook(okRecv, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(okWakes).toHaveLength(1);
    expect(existsSync(`${okPath}.dirsync`)).toBe(false);
  });

  test('missing recorded component is skipped; remaining directory still recovers', async () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    const missing = join(dir, 'gone');
    writeFileSync(`${path}.dirsync`, `${missing}\n${dir}\n`, { mode: 0o600 });
    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    await store.commit(RECORD, 1);
    expect(inspectDedupFile(path).ok).toBe(true);
    expect(existsSync(`${path}.dirsync`)).toBe(false);
  });
});
