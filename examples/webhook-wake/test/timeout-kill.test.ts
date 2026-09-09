import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { CANARY_TERMINAL, mailBody, postHook, startReceiver, tempDir, testConfig } from './helpers.ts';
import { createSpawnWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';

const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
chmodSync(fakeOrca, 0o755);
const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('timeout, kill, and fake argv boundary', () => {
  test('hanging fake orca is SIGKILL-ed and remains retryable', async () => {
    const dir = tempDir();
    const log = join(dir, 'argv.jsonl');
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fakeOrca, sendTimeoutMs: 150 }, dir),
      {
        extraWakeEnv: { FAKE_ORCA_LOG: log, FAKE_ORCA_MODE: 'hang' },
      },
    );
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(posted.json.reason).toBe('timeout_killed');
    expect(receiver.metrics.timeoutKill).toBe(1);
    expect(receiver.metrics.submitted).toBe(0);
  });

  test('successful fake orca records fixed argv without a shell', async () => {
    const dir = tempDir();
    const log = join(dir, 'argv.jsonl');
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fakeOrca, sendTimeoutMs: 1000 }, dir),
      { extraWakeEnv: { FAKE_ORCA_LOG: log, FAKE_ORCA_MODE: 'ok' } },
    );
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    const recorded = JSON.parse(readFileSync(log, 'utf8')) as { args: string[] };
    expect(recorded.args[0]).toBe('terminal');
    expect(recorded.args[1]).toBe('send');
    expect(recorded.args).toContain('--terminal');
    expect(recorded.args).toContain(CANARY_TERMINAL);
    expect(recorded.args).toContain('--enter');
    expect(recorded.args).toContain('--text');
    expect(recorded.args.includes('--interrupt')).toBe(false);
    expect(recorded.args.join(' ')).not.toContain('should-never-reach-argv');
  });

  test('spawn wake helper itself kills a hang and caps output', async () => {
    const hang = createSpawnWake({
      timeoutMs: 120,
      outputCapBytes: 64,
      extraEnv: { FAKE_ORCA_MODE: 'hang' },
    });
    const hung = await hang({
      terminal: CANARY_TERMINAL,
      text: 'x',
      argv: [fakeOrca, 'terminal', 'send', '--terminal', CANARY_TERMINAL, '--enter', '--text', 'x'],
    });
    expect(hung.ok).toBe(false);
    expect(hung.reason).toBe('timeout_killed');

    const bulky = createSpawnWake({
      timeoutMs: 1000,
      outputCapBytes: 32,
      extraEnv: { FAKE_ORCA_MODE: 'bigout', FAKE_ORCA_OUT_BYTES: '200000' },
    });
    const big = await bulky({
      terminal: CANARY_TERMINAL,
      text: 'x',
      argv: [fakeOrca, 'terminal', 'send', '--terminal', CANARY_TERMINAL, '--enter', '--text', 'x'],
    });
    expect(big.ok).toBe(true);
    expect(big.stdoutBytes).toBeLessThanOrEqual(32);
  });

  test('timeout kills the spawned job including a hanging grandchild, not this process', async () => {
    const dir = tempDir();
    const marker = join(dir, 'grandchild.pid');
    const hang = createSpawnWake({
      timeoutMs: 200,
      outputCapBytes: 64,
      extraEnv: { FAKE_ORCA_MODE: 'hang-tree', FAKE_ORCA_GRANDCHILD_MARKER: marker },
    });
    const self = process.pid;
    const hung = await hang({
      terminal: CANARY_TERMINAL,
      text: 'x',
      argv: [fakeOrca, 'terminal', 'send', '--terminal', CANARY_TERMINAL, '--enter', '--text', 'x'],
    });
    expect(hung.ok).toBe(false);
    expect(hung.reason).toBe('timeout_killed');
    expect(process.pid).toBe(self);
    expect(existsSync(marker)).toBe(true);
    const gcPid = Number(readFileSync(marker, 'utf8').trim());
    expect(gcPid).toBeGreaterThan(1);
    expect(gcPid).not.toBe(self);
    await Bun.sleep(100);
    expect(() => process.kill(gcPid, 0)).toThrow();
  });
});

