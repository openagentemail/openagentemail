#!/usr/bin/env node
/**
 * Context-sensitive fake Orca: requires HOME (or FAKE_ORCA_REQUIRE_HOME)
 * and records whether secret-like parent keys leaked into the child.
 */

import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_ORCA_LOG;
const requiredHome = process.env.FAKE_ORCA_REQUIRE_HOME;
const leaked = Object.keys(process.env).filter((key) =>
  /API_KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION/i.test(key),
);

const record = {
  args: process.argv.slice(2),
  home: process.env.HOME ?? null,
  user: process.env.USER ?? null,
  leaked,
};

if (logPath) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

if (!process.env.HOME) {
  process.exit(3);
}
if (requiredHome && process.env.HOME !== requiredHome) {
  process.exit(4);
}
if (leaked.length > 0) {
  process.exit(5);
}
process.stdout.write('{"accepted":true}\n');
process.exit(0);
