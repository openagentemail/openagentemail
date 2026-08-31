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

test('R5c reconcile fixture derives a missing stamp monotonically and rejects a stale supplied stamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oae-process-stamp-')); const directory = join(root, 'correlation'); const serverPath = join(root, 'server.json'); await writeFile(serverPath, JSON.stringify({ creates: 0, hidePostRestartLists: 0, task: null }), 'utf8'); const runner = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs'); const fixture = join(process.cwd(), 'test/fixtures/reconcile-child.ts');
  const init = spawnSync(process.execPath, [runner, fixture, 'init', directory, serverPath], { encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr); const prior = JSON.parse(await readFile(join(directory, '88888888-8888-4888-8888-888888888888.json'), 'utf8')) as { updatedAt: string }; const advance = spawnSync(process.execPath, [runner, fixture, 'advance', directory, serverPath], { encoding: 'utf8' }); assert.equal(advance.status, 0, advance.stderr); const next = JSON.parse(await readFile(join(directory, '88888888-8888-4888-8888-888888888888.json'), 'utf8')) as { updatedAt: string; createAttemptedAt: string }; assert.ok(next.createAttemptedAt > prior.updatedAt); assert.equal(next.createAttemptedAt, next.updatedAt);
  const staleRoot = await mkdtemp(join(tmpdir(), 'oae-process-stale-')); const staleInit = spawnSync(process.execPath, [runner, fixture, 'init', join(staleRoot, 'correlation'), serverPath], { encoding: 'utf8' }); assert.equal(staleInit.status, 0, staleInit.stderr); const stale = spawnSync(process.execPath, [runner, fixture, 'advance', join(staleRoot, 'correlation'), serverPath, '2020-01-01T00:00:00.000Z'], { encoding: 'utf8' }); assert.notEqual(stale.status, 0);
});
