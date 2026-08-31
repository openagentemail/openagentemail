import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorrelationSafetyError } from '../src/correlation-store.js';
import { FixtureJsonStore } from '../src/fixture-store.js';

test('R5c shared R2/R3 fixture store rejects corrupt/symlink/mode/race targets without replacing victim bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fixture-store-')); const store = new FixtureJsonStore<{ value: number }>(directory, 'oae-task.json'); await store.save({ value: 1 }); assert.deepEqual(await store.load(), { value: 1 }); const target = join(directory, 'oae-task.json');
  await writeFile(target, '{broken', { mode: 0o600 }); await assert.rejects(() => store.load(), CorrelationSafetyError); await writeFile(target, JSON.stringify({ value: 1 }), { mode: 0o600 }); await chmod(target, 0o644); await assert.rejects(() => store.save({ value: 2 }), CorrelationSafetyError); await chmod(target, 0o600);
  const victim = join(directory, 'victim.json'); await writeFile(victim, 'preserve', { mode: 0o600 }); await rename(target, join(directory, 'original.json')); await symlink(victim, target); await assert.rejects(() => store.load(), CorrelationSafetyError); assert.equal(await readFile(victim, 'utf8'), 'preserve');
  const raceDirectory = await mkdtemp(join(tmpdir(), 'fixture-store-race-')); const raceTarget = join(raceDirectory, 'oae-task.json'); await new FixtureJsonStore<{ value: number }>(raceDirectory, 'oae-task.json').save({ value: 1 }); const attacker = join(raceDirectory, 'attacker.json'); await writeFile(attacker, 'attacker-bytes', { mode: 0o600 }); const race = new FixtureJsonStore<{ value: number }>(raceDirectory, 'oae-task.json', { beforeRename: async () => { await rename(attacker, raceTarget); } }); await assert.rejects(() => race.save({ value: 2 }), CorrelationSafetyError); assert.equal(await readFile(raceTarget, 'utf8'), 'attacker-bytes');
});
