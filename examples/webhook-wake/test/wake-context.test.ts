import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrcaChildEnv, createSpawnWake } from '../src/wake.ts';
import { CANARY_TERMINAL, mailBody, postHook, startReceiver, tempDir, testConfig } from './helpers.ts';
import type { Receiver } from '../src/server.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-orca-context.mjs', import.meta.url));
chmodSync(fake, 0o755);

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('runtime context handoff', () => {
  test('child env keeps HOME and drops secret-like keys', () => {
    const env = buildOrcaChildEnv(
      {
        HOME: '/home/ops',
        USER: 'ops',
        PATH: '/usr/bin',
        OPENAGENTEMAIL_API_KEY: 'oa_should_not_leak',
        WEBHOOK_SIGNING_SECRET: 'whs_should_not_leak',
        AWS_SECRET_ACCESS_KEY: 'nope',
        XDG_RUNTIME_DIR: '/run/user/1000',
      },
      { FAKE_ORCA_LOG: '/tmp/x', OPENAGENTEMAIL_API_KEY: 'still-no' },
    );
    expect(env.HOME).toBe('/home/ops');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(env.OPENAGENTEMAIL_API_KEY).toBeUndefined();
    expect(env.WEBHOOK_SIGNING_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.FAKE_ORCA_LOG).toBe('/tmp/x');
  });

  test('context-sensitive launcher fails without HOME and succeeds with HOME', async () => {
    const argv = [fake, 'terminal', 'send', '--terminal', CANARY_TERMINAL, '--enter', '--text', 'x'];
    const noHome = createSpawnWake({
      timeoutMs: 800,
      outputCapBytes: 1024,
      parentEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const missing = await noHome({ terminal: CANARY_TERMINAL, text: 'x', argv });
    expect(missing.ok).toBe(false);
    expect(missing.exitCode).toBe(3);

    const withHome = createSpawnWake({
      timeoutMs: 800,
      outputCapBytes: 1024,
      parentEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/home/ops-r1-context' },
      extraEnv: { FAKE_ORCA_REQUIRE_HOME: '/home/ops-r1-context' },
    });
    const ok = await withHome({ terminal: CANARY_TERMINAL, text: 'x', argv });
    expect(ok.ok).toBe(true);

    const dir = tempDir();
    const log = join(dir, 'ctx.jsonl');
    const required = '/home/ops-r1-context';
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fake, sendTimeoutMs: 1000 }, dir),
      {
        extraWakeEnv: {
          HOME: required,
          FAKE_ORCA_REQUIRE_HOME: required,
          FAKE_ORCA_LOG: log,
          OPENAGENTEMAIL_API_KEY: 'oa_must_not_appear',
        },
      },
    );
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    const recorded = JSON.parse(readFileSync(log, 'utf8')) as { home: string; leaked: string[]; args: string[] };
    expect(recorded.home).toBe(required);
    expect(recorded.leaked).toEqual([]);
    expect(recorded.args.includes('--interrupt')).toBe(false);
    expect(missing.argv[0]).toBe(fake);
  });
});
