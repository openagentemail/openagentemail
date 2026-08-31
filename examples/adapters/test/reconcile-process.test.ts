import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('two independent child processes reconstruct durable store/client after delayed visibility without duplicate create', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oae-process-reconcile-'));
  const directory = join(root, 'correlation');
  const serverPath = join(root, 'server.json');
  await writeFile(serverPath, JSON.stringify({ creates: 0, hidePostRestartLists: 1, task: null }), 'utf8');
  const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const fixture = join(process.cwd(), 'test/fixtures/reconcile-child.ts');
  for (const mode of ['create', 'recover']) {
    const child = spawnSync(process.execPath, [runner, fixture, mode, directory, serverPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, `${mode}: ${child.stderr}`);
  }
  const server = JSON.parse(await readFile(serverPath, 'utf8')) as { creates: number; hidePostRestartLists: number; task: { id: string } | null };
  assert.equal(server.creates, 1);
  assert.equal(server.hidePostRestartLists, 0);
  assert.equal(server.task?.id, 'task-1');
});
