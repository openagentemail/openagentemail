#!/usr/bin/env bun
/** Bounded: open a secret FIFO without blocking the suite. */

import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFileConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'webhook-wake-secret-fifo-'));
const fifo = join(dir, 'secret.whs');
const made = spawnSync('mkfifo', ['-m', '0600', fifo], { encoding: 'utf8' });
if (made.status !== 0) {
  process.stdout.write('SKIPPED:mkfifo\n');
  process.exit(0);
}

const t0 = Date.now();
let reason = '';
try {
  parseFileConfig({
    routes: {
      canary: {
        subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        domain: 'openagent.email',
        mailbox: 'alice@openagent.email',
        secretFile: fifo,
        terminal: 'term_examplecanary0001',
      },
    },
  });
  reason = 'unexpected_ok';
} catch (err) {
  reason = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'error';
}
const ms = Date.now() - t0;
if (ms > 400) {
  process.stderr.write('HUNG:secret\n');
  process.exit(3);
}

process.stdout.write(`${JSON.stringify({ reason, ms })}\n`);
if (reason.includes('secret_not_file')) {
  process.exit(0);
}
process.exit(1);
