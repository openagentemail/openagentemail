#!/usr/bin/env bun
/** Bounded: inspect/read a FIFO without blocking the suite. */

import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-fifo-'));
const fifo = join(dir, 'dedup.json');
const made = spawnSync('mkfifo', ['-m', '0644', fifo], { encoding: 'utf8' });
if (made.status !== 0) {
  process.stdout.write('SKIPPED:mkfifo\n');
  process.exit(0);
}

const t0 = Date.now();
const inspect = inspectDedupFile(fifo);
if (Date.now() - t0 > 400) {
  process.stderr.write('HUNG:inspect\n');
  process.exit(3);
}

const store = new DedupStore({ path: fifo, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
const t1 = Date.now();
let storeReason = '';
try {
  await store.get('k', 1);
  storeReason = 'unexpected_ok';
} catch (err) {
  storeReason = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'error';
}
if (Date.now() - t1 > 400) {
  process.stderr.write('HUNG:store\n');
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({ inspect, storeReason, ms: Date.now() - t0 })}\n`);
if (!inspect.ok && inspect.reason === 'state_not_file' && storeReason.includes('dedup_not_file')) {
  process.exit(0);
}
process.exit(1);
