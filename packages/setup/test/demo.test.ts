import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/args.ts';
import { createClientContext } from '../src/clients.ts';
import { createDemoRuntime, demoDirectory, runDemo } from '../src/demo.ts';
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

function reporter() {
  const stream = { write() { return true; } };
  return new Reporter(false, stream, stream);
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('demo recovery', () => {
  test('teardown removes an incomplete clone without invoking Compose', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-demo-teardown-'));
    created.push(home);
    const directory = demoDirectory(home);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'partial-clone'), 'incomplete');
    const commands: string[] = [];

    await runDemo(
      parseArgs(['demo', '--teardown', '--yes']),
      noPrompts,
      reporter(),
      createDemoRuntime({
        home,
        statePath: join(home, 'state.json'),
        run(command, args) {
          commands.push([command, ...args].join(' '));
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
    );

    expect(existsSync(directory)).toBe(false);
    expect(commands.some((command) => command.includes(' down '))).toBe(false);
  });

  test('recreate supplies a missing env before Compose teardown and starts cleanly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oae-demo-recreate-'));
    created.push(home);
    const directory = demoDirectory(home);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'compose.yaml'), 'services: {}\n');
    let healthChecks = 0;
    let sawEnvDuringDown = false;
    const commands: string[] = [];
    const prompts: PromptAdapter = {
      ...noPrompts,
      async select() { return 'recreate'; },
    };

    const result = await runDemo(
      parseArgs(['demo', '--clients', 'none']),
      prompts,
      reporter(),
      createDemoRuntime({
        home,
        statePath: join(home, 'state.json'),
        clientContext: createClientContext({ home, commandExists: () => false }),
        portAvailable: async () => true,
        sleep: async () => {},
        fetcher: async (input, init) => {
          if (String(input).endsWith('/healthz')) {
            healthChecks += 1;
            return healthChecks === 1
              ? new Response('{}', { status: 503 })
              : new Response('{"ok":true}');
          }
          if (init?.method === 'POST') {
            return new Response('{"address":"demo@demo.local","token":"oa_demo"}', { status: 201 });
          }
          return new Response('{}', { status: 404 });
        },
        run(command, args, cwd) {
          commands.push([command, ...args].join(' '));
          if (command === 'docker' && args.includes('down')) {
            sawEnvDuringDown = existsSync(join(cwd!, '.env'));
          }
          if (command === 'git') {
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'compose.yaml'), 'services: {}\n');
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
    );

    expect(sawEnvDuringDown).toBe(true);
    expect(commands.some((command) => command.includes(' down -v'))).toBe(true);
    expect(commands.some((command) => command.includes(' up -d'))).toBe(true);
    expect(result.address).toBe('demo@demo.local');
  });
});
