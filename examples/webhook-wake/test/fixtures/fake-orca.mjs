#!/usr/bin/env node
/**
 * Fake Orca binary for argv-boundary tests. Records argv; never talks to a seat.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const logPath = process.env.FAKE_ORCA_LOG;
const mode = process.env.FAKE_ORCA_MODE || 'ok';
const record = {
  argv0: process.argv[0],
  script: process.argv[1],
  args: process.argv.slice(2),
};

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

if (mode === 'hang') {
  setInterval(() => {}, 1 << 30);
} else if (mode === 'fail') {
  process.exit(2);
} else if (mode === 'bigout' || mode === 'submit-then-bigout') {
  const marker = process.env.FAKE_ORCA_SUBMIT_MARKER;
  if (marker) writeFileSync(marker, 'submitted\n');
  const n = Number(process.env.FAKE_ORCA_OUT_BYTES || 100000);
  process.stdout.write('x'.repeat(n));
  process.stderr.write('y'.repeat(Math.min(n, 4096)));
  process.exit(0);
} else if (mode === 'hang-tree') {
  const marker = process.env.FAKE_ORCA_GRANDCHILD_MARKER;
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
    env: process.env,
  });
  if (marker && grandchild.pid) {
    writeFileSync(marker, `${grandchild.pid}\n`);
  }
  setInterval(() => {}, 1 << 30);
} else if (mode === 'slow') {
  const delay = Number(process.env.FAKE_ORCA_DELAY_MS || 3000);
  setTimeout(() => process.exit(0), delay);
} else {
  process.stdout.write('{"accepted":true}\n');
  process.exit(0);
}
