#!/usr/bin/env bun
/** Bounded: inspect/read a .dirsync FIFO without blocking the suite. */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-dirsync-fifo-'));
const path = join(dir, 'dedup.json');
writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
const marker = `${path}.dirsync`;
const made = spawnSync('mkfifo', ['-m', '0644', marker], { encoding: 'utf8' });
if (made.status !== 0) {
  process.stdout.write('SKIPPED:mkfifo\n');
  process.exit(0);
}

const t0 = Date.now();
const inspect = inspectDedupFile(path);
if (Date.now() - t0 > 400) {
  process.stderr.write('HUNG:inspect\n');
  process.exit(3);
}

const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
const t1 = Date.now();
let storeReason = '';
try {
  await store.commit(
    {
      key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
      status: 'success',
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    },
    1,
  );
  storeReason = 'unexpected_ok';
} catch (err) {
  storeReason = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'error';
}
if (Date.now() - t1 > 400) {
  process.stderr.write('HUNG:store\n');
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({ inspect, storeReason, ms: Date.now() - t0 })}\n`);
if (!inspect.ok && inspect.reason === 'state_dirsync_not_file' && storeReason.includes('dedup_dirsync_not_file')) {
  process.exit(0);
}
process.exit(1);
