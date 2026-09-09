/** Portable DAC cases. Drop to nobody when started as root; never skip UID 1000. */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DedupStore, inspectDedupFile } from '../src/dedup.ts';
import { inspectReadiness, inspectStateWritable } from '../src/readiness.ts';
import { MIN_RETENTION_MS } from '../src/config.ts';
import { testConfig } from './helpers.ts';

const NOBODY_UID = 65534;
const NOBODY_GID = 65534;

function dropIfRoot() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    console.log('SKIPPED:uid_unavailable');
    process.exit(77);
  }
  if (process.getuid() === 0) {
    try {
      process.setgid(NOBODY_GID);
      process.setuid(NOBODY_UID);
    } catch {
      console.log('SKIPPED:root_cannot_drop');
      process.exit(77);
    }
  }
  if (process.getuid() === 0) {
    console.log('SKIPPED:still_root');
    process.exit(77);
  }
}

const rec = {
  key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
  status: 'success',
  storedAtMs: 1,
  expiresAtMs: 9_999_999_999_999,
};

async function durability() {
  const root = mkdtempSync(join(tmpdir(), 'webhook-wake-r8-'));
  const wall = join(root, 'wall');
  mkdirSync(wall, { mode: 0o700 });
  chmodSync(wall, 0o300);
  const path = join(wall, 'new', 'dedup.json');
  const cfg = { path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 };
  const syncedBlocked = [];
  try {
    const blocked = new DedupStore(cfg, { onDirFsync: (dir) => syncedBlocked.push(dir) });
    await assert.rejects(() => blocked.commit(rec, 1), { code: 'dedup_mkdir_fsync_failed' });
    assert.equal(existsSync(path), false);
    assert.equal(await blocked.get(rec.key, 1), undefined);
    assert.equal(syncedBlocked.includes(wall), false);
    assert.equal(inspectDedupFile(path).ok, false);

    chmodSync(wall, 0o700);
    const synced = [];
    const retry = new DedupStore(cfg, { onDirFsync: (dir) => synced.push(dir) });
    await retry.commit(rec, 1);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(retry.dirsyncPath()), false);
    assert.equal(synced.some((dir) => dir === join(wall, 'new')), true);
    assert.equal(synced.some((dir) => dir === wall), true);
    assert.equal((await retry.get(rec.key, 1))?.status, 'success');
  } finally {
    try {
      chmodSync(wall, 0o700);
    } catch {
      /* cleanup */
    }
  }
}

function readiness() {
  const root = mkdtempSync(join(tmpdir(), 'webhook-wake-r8rdy-'));
  const ok = join(root, 'ok');
  mkdirSync(ok, { mode: 0o700 });
  assert.equal(inspectStateWritable(join(ok, 'dedup.json')), true);
  assert.equal(inspectReadiness(testConfig({ dedup: { path: join(ok, 'dedup.json') } }, ok)).stateWritable, true);

  const state0500 = join(root, 'state500');
  mkdirSync(state0500, { mode: 0o700 });
  chmodSync(state0500, 0o500);
  try {
    assert.equal(inspectStateWritable(join(state0500, 'dedup.json')), false);
    assert.equal(inspectReadiness(testConfig({ dedup: { path: join(state0500, 'dedup.json') } }, root)).stateWritable, false);
  } finally {
    chmodSync(state0500, 0o700);
  }

  const state0300 = join(root, 'state300');
  mkdirSync(state0300, { mode: 0o700 });
  chmodSync(state0300, 0o300);
  try {
    assert.equal(inspectStateWritable(join(state0300, 'dedup.json')), false);
    assert.equal(inspectReadiness(testConfig({ dedup: { path: join(state0300, 'dedup.json') } }, root)).ready, false);
  } finally {
    chmodSync(state0300, 0o700);
  }

  const wall = join(root, 'wall');
  mkdirSync(wall, { mode: 0o700 });
  chmodSync(wall, 0o300);
  try {
    assert.equal(inspectStateWritable(join(wall, 'new', 'dedup.json')), false);
    assert.equal(
      inspectReadiness(testConfig({ dedup: { path: join(wall, 'new', 'dedup.json') } }, root)).stateWritable,
      false,
    );
  } finally {
    chmodSync(wall, 0o700);
  }
}

const mode = process.argv[2] ?? 'all';
dropIfRoot();
if (mode === 'durability' || mode === 'all') {
  await durability();
}
if (mode === 'readiness' || mode === 'all') {
  readiness();
}
console.log(`EXECUTED:uid=${process.getuid()} mode=${mode}`);
