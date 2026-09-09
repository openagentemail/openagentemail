#!/usr/bin/env bun
/** Root-owned file in a sticky dir; drop to nobody only after ancestors are searchable. */

import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReadiness, inspectStateWritable } from '../src/readiness.ts';
import { recordingWake } from '../src/wake.ts';
import { mailBody, postHook, startReceiver, testConfig } from './helpers.ts';

const NOBODY_UID = 65534;
const NOBODY_GID = 65534;

if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  console.log('SKIPPED:not_root');
  process.exit(77);
}

const root = mkdtempSync(join(tmpdir(), 'webhook-wake-sticky-'));
// Necessary ancestor R+X so nobody can walk here. Do not add other-write.
chmodSync(root, 0o755);
const sticky = join(root, 'sticky');
mkdirSync(sticky, { mode: 0o1777 });
// Bun chmodSync drops the sticky bit; use coreutils so the fixture is actually 1777.
const chmodded = spawnSync('chmod', ['1777', sticky], { encoding: 'utf8' });
if (chmodded.status !== 0) {
  console.log('SKIPPED:chmod_sticky');
  process.exit(77);
}
const foreign = join(sticky, 'dedup.json');
writeFileSync(foreign, `${JSON.stringify({ records: {} })}\n`, { mode: 0o644 });

try {
  process.setgid(NOBODY_GID);
  process.setuid(NOBODY_UID);
} catch {
  console.log('SKIPPED:root_cannot_drop');
  process.exit(77);
}
if (process.getuid() === 0) {
  console.log('SKIPPED:still_root');
  process.exit(77);
}

accessSync(root, constants.R_OK | constants.X_OK);
accessSync(sticky, constants.R_OK | constants.W_OK | constants.X_OK);
accessSync(foreign, constants.R_OK);
const fileSt = statSync(foreign);
const dirSt = statSync(sticky);
assert.notEqual(fileSt.uid, process.getuid());
assert.equal((dirSt.mode & 0o1000) !== 0, true);
console.log('PROOF:file_readable');
console.log('PROOF:parent_rwx');
console.log(`PROOF:foreign_uid=${fileSt.uid}`);

try {
  renameSync(foreign, `${foreign}.replaced`);
  console.log('FAIL:rename_succeeded');
  process.exit(1);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
  assert.ok(code === 'EPERM' || code === 'EACCES', code);
  console.log(`PROOF:rename_denied:${code}`);
}

assert.equal(inspectStateWritable(foreign), false);
assert.equal(inspectReadiness(testConfig({ dedup: { path: foreign } }, root)).stateWritable, false);
console.log('PROOF:ready_false');

const own = join(sticky, 'own.json');
writeFileSync(own, `${JSON.stringify({ records: {} })}\n`, { mode: 0o600 });
assert.equal(statSync(own).uid, process.getuid());
assert.equal(inspectStateWritable(own), true);
renameSync(own, `${own}.tmp`);
console.log('PROOF:own_replace_ok');

const wakes = [];
const receiver = await startReceiver(testConfig({ mode: 'canary', dedup: { path: foreign } }, root), {
  wake: recordingWake(wakes),
});
const refused = await postHook(receiver, { body: mailBody() });
await receiver.close();
assert.equal(refused.status, 503);
assert.equal(refused.json.reason, 'state_unwritable');
assert.equal(wakes.length, 0);
console.log('PROOF:zero_wake');

try {
  unlinkSync(`${own}.tmp`);
} catch {
  /* best-effort */
}
console.log(`EXECUTED:uid=${process.getuid()}`);
console.log(`FIXTURE:${root}`);
