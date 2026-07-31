import { describe, expect, test } from 'bun:test';
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
