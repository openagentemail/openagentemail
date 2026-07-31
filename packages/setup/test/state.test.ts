import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearSetupState,
  readSetupState,
  setupStatePath,
  writeSetupState,
} from '../src/state.ts';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('setup state', () => {
  test('uses XDG_CONFIG_HOME when present', () => {
    expect(setupStatePath({ XDG_CONFIG_HOME: '/tmp/custom' }, '/home/test')).toBe(
      '/tmp/custom/openagentemail/setup-state.json',
    );
  });

  test('writes atomically, reads valid state, and never stores tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oae-state-'));
    created.push(root);
    const path = join(root, 'config', 'setup-state.json');
    await writeSetupState({ stage: 'recommendations', apiUrl: 'http://localhost:3100' }, path);

    const state = await readSetupState(path);
    expect(state?.stage).toBe('recommendations');
    expect(state?.apiUrl).toBe('http://localhost:3100');
    expect(state?.updatedAt).toBeTruthy();
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain('token');
    expect((await readdir(join(root, 'config'))).filter((name) => name.includes('.tmp.'))).toEqual([]);

    await clearSetupState(path);
    expect(await readSetupState(path)).toBeNull();
  });

  test('invalid or missing state is treated as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oae-state-invalid-'));
    created.push(root);
    expect(await readSetupState(join(root, 'missing.json'))).toBeNull();
  });
});
