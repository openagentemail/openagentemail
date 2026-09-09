import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
import { tempDir } from './helpers.ts';

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
});
