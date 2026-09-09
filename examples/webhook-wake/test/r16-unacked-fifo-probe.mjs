#!/usr/bin/env bun
/** Bounded: FIFO .unacked + injected dir_fsync must not block markUnacked. */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-unacked-fifo-'));
const path = join(dir, 'dedup.json');
writeFileSync(
  path,
  `${JSON.stringify({
    records: {
      'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555': {
        key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
        status: 'success',
        storedAtMs: 1,
        expiresAtMs: 9_999_999_999_999,
      },
    },
  })}\n`,
  { mode: 0o600 },
);
const marker = `${path}.unacked`;
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
store.injectFailure('dir_fsync');
const t1 = Date.now();
let storeReason = '';
try {
  await store.get(
    'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
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
if (
  !inspect.ok &&
  inspect.reason === 'state_unacked' &&
  storeReason.includes('dedup_unacked_not_file')
) {
  process.exit(0);
}
process.exit(1);
