#!/usr/bin/env bun
/** Bounded: a FIFO at the legacy .tmp.<pid> path must not block commit. */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore } from '../src/dedup.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-tmp-fifo-'));
const path = join(dir, 'dedup.json');
const legacy = `${path}.tmp.${process.pid}`;
const made = spawnSync('mkfifo', ['-m', '0666', legacy], { encoding: 'utf8' });
if (made.status !== 0) {
  process.stdout.write('SKIPPED:mkfifo\n');
  process.exit(0);
}
writeFileSync(`${dir}/victim`, 'keep\n', { mode: 0o600 });

const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
const t0 = Date.now();
let storeReason = 'ok';
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
} catch (err) {
  storeReason = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'error';
}
const ms = Date.now() - t0;
if (ms > 400) {
  process.stderr.write('HUNG:store\n');
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({ storeReason, ms, legacy })}\n`);
if (storeReason === 'ok') {
  process.exit(0);
}
process.exit(1);
