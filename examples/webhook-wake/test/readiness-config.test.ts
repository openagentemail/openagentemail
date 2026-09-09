import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { inspectReadiness, isRegularExecutable } from '../src/readiness.ts';
import { mailBody, postHook, startReceiver, tempDir, testConfig, testRoute, writeSecretFile } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { FileConfig } from '../src/config.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
chmodSync(fakeOrca, 0o755);

function fileBase(dir: string): FileConfig {
  const secret = writeSecretFile(dir, 'ok.whs', 'whs_2b0932ba2d72c1d53d07da69a8ad7843c70f09d24800e3b3828dca20b594127b');
  return {
    routes: {
      canary: {
        subscriptionId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        domain: 'openagent.email',
        mailbox: 'alice@openagent.email',
        secretFile: secret,
        terminal: 'term_examplecanary0001',
      },
    },
  };
}

describe('readiness and config load', () => {
  test('absent mode defaults to observe; invalid present mode fails load', () => {
    const dir = tempDir();
    const absent = parseFileConfig(fileBase(dir));
    expect(absent.mode).toBe('observe');
    expect(() => parseFileConfig({ ...fileBase(dir), mode: 'canry' })).toThrow('config_invalid:mode');
  });

  test('canary terminal must match an active non-stale route', () => {
    const dir = tempDir();
    expect(() =>
      parseFileConfig({
        ...fileBase(dir),
        mode: 'canary',
        canaryTerminal: 'term_typooooooooooo01',
      }),
    ).toThrow('config_invalid:canary_terminal_unbound');

    const ok = parseFileConfig({
      ...fileBase(dir),
      mode: 'canary',
      canaryTerminal: 'term_examplecanary0001',
    });
    expect(ok.canaryTerminal).toBe('term_examplecanary0001');
  });

  test('unbound canary does not record would_wake that would suppress later sends', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(
      testConfig({
        mode: 'canary',
        canaryTerminal: 'term_typooooooooooo01',
        routes: [testRoute()],
      }),
      { wake: recordingWake(bucket) },
    );
    receivers.push(receiver);
    const ready = await fetch(`${receiver.url()}/ready`);
    expect(ready.status).toBe(503);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(503);
    expect(posted.json.reason).toBe('canary_terminal_unbound');
    expect(bucket).toHaveLength(0);
    expect(await receiver.dedup.count(Date.now())).toBe(0);
  });

  test('orca path must be a regular executable; a directory is not ready', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'orca-dir'));
    expect(isRegularExecutable(join(dir, 'orca-dir'))).toBe(false);
    expect(isRegularExecutable(fakeOrca)).toBe(true);
    const report = inspectReadiness(
      testConfig({ mode: 'canary', orcaBinary: join(dir, 'orca-dir') }, dir),
    );
    expect(report.orcaBinaryPresent).toBe(false);
    expect(report.ready).toBe(false);
  });

  test('existing unwritable state stays unready; missing dir may fall back', () => {
    const root = mkdtempSync(join(tmpdir(), 'webhook-wake-state-'));
    const missing = inspectReadiness(
      testConfig({ dedup: { path: join(root, 'not-created-yet', 'dedup.json') } }),
    );
    expect(missing.stateWritable).toBe(true);

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const helper = fileURLToPath(new URL('./r8-nonroot-cases.mjs', import.meta.url));
      const ran = spawnSync(process.execPath, [helper, 'readiness'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
      });
      const text = `${ran.stdout}${ran.stderr}`;
      if (ran.status === 77) {
        expect(text).toContain('SKIPPED:');
        return;
      }
      expect(ran.status).toBe(0);
      expect(text).toContain('EXECUTED:uid=');
      return;
    }

    const existing = join(root, 'exists');
    mkdirSync(existing, { mode: 0o500 });
    chmodSync(existing, 0o500);
    const blocked = inspectReadiness(testConfig({ dedup: { path: join(existing, 'dedup.json') } }));
    expect(blocked.stateWritable).toBe(false);
    expect(blocked.ready).toBe(false);
    chmodSync(existing, 0o700);
  });

  test('numeric bounds: zero-valid fields accepted; positive fields reject 0; retention honors 72h', () => {
    const dir = tempDir();
    const zeroHistory = parseFileConfig({ ...fileBase(dir), wakeHistoryLimit: 0, listen: { port: 0 } });
    expect(zeroHistory.wakeHistoryLimit).toBe(0);
    expect(zeroHistory.listen.port).toBe(0);
    expect(() => parseFileConfig({ ...fileBase(dir), maxConcurrent: 0 })).toThrow('config_invalid:maxConcurrent');
    expect(() => parseFileConfig({ ...fileBase(dir), sendTimeoutMs: 0 })).toThrow('config_invalid:sendTimeoutMs');
    expect(() => parseFileConfig({ ...fileBase(dir), maxConcurrent: '8' as unknown as number })).toThrow(
      'config_invalid:maxConcurrent',
    );
    expect(() =>
      parseFileConfig({ ...fileBase(dir), dedup: { retentionMs: MIN_RETENTION_MS - 1 } }),
    ).toThrow('config_invalid:dedup.retentionMs');
    const ok = parseFileConfig({ ...fileBase(dir), dedup: { retentionMs: MIN_RETENTION_MS } });
    expect(ok.dedup.retentionMs).toBe(MIN_RETENTION_MS);
  });

  test('linux secret files with group/other bits fail closed', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    const path = writeSecretFile(dir, 'wide.whs', 'whs_2b0932ba2d72c1d53d07da69a8ad7843c70f09d24800e3b3828dca20b594127b');
    chmodSync(path, 0o644);
    base.routes!.canary!.secretFile = path;
    expect(() => parseFileConfig(base)).toThrow('secret_insecure_mode');
  });
});
