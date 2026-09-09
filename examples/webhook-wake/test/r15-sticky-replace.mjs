#!/usr/bin/env bun
/** Root creates a foreign-owned file in a sticky dir, then drops to nobody. */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const sticky = join(root, 'sticky');
mkdirSync(sticky, { mode: 0o1777 });
chmodSync(sticky, 0o1777);
const path = join(sticky, 'dedup.json');
writeFileSync(path, `${JSON.stringify({ records: {} })}\n`, { mode: 0o644 });

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

assert.equal(inspectStateWritable(path), false);
assert.equal(inspectReadiness(testConfig({ dedup: { path } }, root)).stateWritable, false);

const wakes = [];
const receiver = await startReceiver(testConfig({ mode: 'canary', dedup: { path } }, root), {
  wake: recordingWake(wakes),
});
const refused = await postHook(receiver, { body: mailBody() });
await receiver.close();
assert.equal(refused.status, 503);
assert.equal(refused.json.reason, 'state_unwritable');
assert.equal(wakes.length, 0);
console.log(`EXECUTED:uid=${process.getuid()}`);
