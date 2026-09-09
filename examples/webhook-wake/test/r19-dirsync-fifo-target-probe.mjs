#!/usr/bin/env bun
/** Bounded: a regular .dirsync that names a FIFO must not block get(). */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-dirsync-target-'));
const path = join(dir, 'dedup.json');
const fifo = join(dir, 'not-a-dir');
writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
const made = spawnSync('mkfifo', ['-m', '0644', fifo], { encoding: 'utf8' });
if (made.status !== 0) {
  process.stdout.write('SKIPPED:mkfifo\n');
  process.exit(0);
}
writeFileSync(`${path}.dirsync`, `${fifo}\n`, { mode: 0o600 });

const t0 = Date.now();
const inspect = inspectDedupFile(path);
const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
let storeReason = '';
try {
  await store.get('k', 1);
  storeReason = 'unexpected_ok';
} catch (err) {
  storeReason = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'error';
}
const ms = Date.now() - t0;
if (ms > 400) {
  process.stderr.write('HUNG:get\n');
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({ inspect, storeReason, ms })}\n`);
if (
  !inspect.ok &&
  inspect.reason === 'state_dirsync' &&
  storeReason.includes('dedup_dirsync_not_dir')
) {
  process.exit(0);
}
process.exit(1);
