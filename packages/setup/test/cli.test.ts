import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/args.ts';
import { runCli } from '../src/main.ts';

function sink() {
  let value = '';
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value,
  };
}

describe('CLI contract', () => {
  test('built CLI runs through an npx-style binary symlink', async () => {
    const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const directory = await mkdtemp(join(tmpdir(), 'oae-setup-bin-'));
    try {
      const build = spawnSync(process.execPath, [
        'build',
        'src/main.ts',
        '--target',
        'node',
        '--outfile',
        'dist/main.js',
      ], {
        cwd: packageDirectory,
        encoding: 'utf8',
      });
      expect(build.status).toBe(0);

      const binary = join(directory, 'openagentemail-setup');
      await symlink(join(packageDirectory, 'dist', 'main.js'), binary);
      const result = spawnSync('node', [binary, '--version'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
      expect(result.stderr).toBe('');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test('parses documented non-interactive flags and explicit no-client mode', () => {
    expect(parseArgs([
      'connect', '--api-url', 'https://api.example', '--token', 'secret',
      '--clients', 'none', '--yes', '--json', '--verify', '--no-fetch',
    ])).toMatchObject({
      command: 'connect',
      apiUrl: 'https://api.example',
      token: 'secret',
      clients: [],
      yes: true,
      json: true,
      verify: true,
      noFetch: true,
    });
  });

  test('--json emits one valid JSON object and never echoes argument tokens on failure', async () => {
    const stdout = sink();
    const stderr = sink();
    const token = 'must-never-be-printed';
    const code = await runCli([
      'connect', '--api-url', 'not-a-url', '--token', token, '--yes', '--json',
    ], { stdout: stdout.stream, stderr: stderr.stream });
    expect(code).toBe(2);
    const lines = stdout.value().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, configuredClients: [] });
    expect(stdout.value()).not.toContain(token);
    expect(stderr.value()).not.toContain(token);
  });
});
