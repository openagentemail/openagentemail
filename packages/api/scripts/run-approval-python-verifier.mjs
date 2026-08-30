#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./verify-approval-canonical-vectors.py', import.meta.url));
const verification = spawnSync('python3', [script], { stdio: 'inherit' });
if (verification.error?.code === 'ENOENT') {
  console.error('Python 3 is required for the approval canonical-vector verifier; install Python 3 and ensure python3 is on PATH.');
  process.exitCode = 1;
} else if (verification.error) {
  console.error(`Could not start the Python 3 approval verifier: ${verification.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = verification.status ?? 1;
}
