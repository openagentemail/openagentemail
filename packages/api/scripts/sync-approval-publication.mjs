#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const canonicalRecipe = resolve(repositoryRoot, 'docs/approval-digest.md');
const canonicalVectors = resolve(repositoryRoot, 'packages/api/test/fixtures/approval-canonical-vectors.v1.json');
const packageRecipe = resolve(repositoryRoot, 'packages/mcp/approval-digest.md');
const packageVectors = resolve(repositoryRoot, 'packages/mcp/approval-canonical-vectors.v1.json');
const sourceVectorLink = '[`packages/api/test/fixtures/approval-canonical-vectors.v1.json`](../packages/api/test/fixtures/approval-canonical-vectors.v1.json)';
const packageVectorLink = '[`approval-canonical-vectors.v1.json`](./approval-canonical-vectors.v1.json)';

function packageRecipeFrom(canonical) {
  const occurrences = canonical.split(sourceVectorLink).length - 1;
  if (occurrences !== 1) {
    throw new Error(`canonical recipe must contain exactly one publishable vector link; found ${occurrences}`);
  }
  return canonical.split(sourceVectorLink).join(packageVectorLink);
}

const mode = process.argv[2];
if (process.argv.length !== 3 || !['--check', '--write'].includes(mode)) {
  throw new Error('usage: sync-approval-publication.mjs --check|--write');
}
const check = mode === '--check';

const canonical = await readFile(canonicalRecipe, 'utf8');
const vectors = await readFile(canonicalVectors, 'utf8');
const outputs = [
  [packageRecipe, packageRecipeFrom(canonical)],
  [packageVectors, vectors],
];

let stale = false;
for (const [path, expected] of outputs) {
  let actual = '';
  try { actual = await readFile(path, 'utf8'); } catch (_error) { stale = true; }
  if (actual !== expected) {
    stale = true;
    if (check) console.error(`stale generated approval publication artifact: ${path}`);
    else await writeFile(path, expected, 'utf8');
  }
}
if (check && stale) process.exitCode = 1;
else console.log(check ? 'approval publication artifacts are current' : 'approval publication artifacts generated');
