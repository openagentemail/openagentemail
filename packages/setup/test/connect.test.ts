import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from '../src/args.ts';
import { createClientContext } from '../src/clients.ts';
import { runConnect } from '../src/connect.ts';
import { Reporter } from '../src/reporter.ts';
import type { PromptAdapter } from '../src/types.ts';

const created: string[] = [];
const noPrompts: PromptAdapter = {
  intro() {},
  outro() {},
  async confirm() { throw new Error('unexpected prompt'); },
  async select() { throw new Error('unexpected prompt'); },
  async multiselect() { throw new Error('unexpected prompt'); },
  async text() { throw new Error('unexpected prompt'); },
  async password() { throw new Error('unexpected prompt'); },
};

function sink() {
  let value = '';
  return {
    stream: { write(chunk: string | Uint8Array) { value += String(chunk); return true; } },
    value: () => value,
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('non-interactive connect', () => {
  test('admin key creates a scoped identity and only the scoped token is persisted', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-connect-'));
    created.push(home);
    await mkdir(join(home, '.cursor'), { recursive: true });
    const statePath = join(home, 'state.json');
    const options = parseArgs([
      'connect',
      '--api-url', 'http://localhost:3100',
      '--token', 'oa_admin_secret',
      '--clients', 'cursor',
      '--yes',
      '--json',
    ]);
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/healthz')) return new Response('{"ok":true}');
      if (url.endsWith('/v1/identities') && init?.method === 'POST') {
        return new Response('{"address":"fox@test.example","token":"oa_scoped"}', { status: 201 });
      }
      return new Response('{"identities":[]}', { status: 200 });
    };
    const stdout = sink();
    const stderr = sink();
    const reporter = new Reporter(true, stdout.stream, stderr.stream);
    const result = await runConnect(options, noPrompts, reporter, {
      fetcher,
      statePath,
      clientContext: createClientContext({
        home,
        commandExists: () => false,
        runCommand: () => ({ status: 1, stderr: '' }),
      }),
    });

    expect(result.address).toBe('fox@test.example');
    expect(result.configuredClients).toEqual(['cursor']);
    expect(requests).toContain('POST http://localhost:3100/v1/identities');
    const config = await readFile(join(home, '.cursor', 'mcp.json'), 'utf8');
    expect(config).toContain('oa_scoped');
    expect(config).not.toContain('oa_admin_secret');
    expect(stdout.value()).not.toContain('oa_admin_secret');
    expect(stderr.value()).not.toContain('oa_admin_secret');
  });

  test('identity token is accepted on the authenticated 403 boundary without creating another identity', async () => {
    const options = parseArgs([
      'connect',
      '--api-url', 'http://localhost:3100',
      '--token', 'oa_identity',
      '--clients', 'none',
      '--yes',
      '--json',
    ]);
    let posts = 0;
    const result = await runConnect(options, noPrompts, new Reporter(true, sink().stream, sink().stream), {
      statePath: join(tmpdir(), `missing-state-${Date.now()}.json`),
      fetcher: async (input, init) => {
        if (String(input).endsWith('/healthz')) return new Response('{"ok":true}');
        if (init?.method === 'POST') posts += 1;
        return new Response('{"error":"forbidden"}', { status: 403 });
      },
      clientContext: createClientContext({
        home: join(tmpdir(), 'not-a-client-home'),
        commandExists: () => false,
      }),
    });
    expect(posts).toBe(0);
    expect(result.configuredClients).toEqual([]);
  });
});
