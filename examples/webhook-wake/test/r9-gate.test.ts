import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { DedupStore, inspectDedupFile, isValidDedupRecord } from '../src/dedup.ts';
import { inspectReadiness } from '../src/readiness.ts';
import {
  FIXTURE_SECRET,
  mailBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  writeSecretFile,
} from './helpers.ts';
import type { FileConfig } from '../src/config.ts';
import type { Receiver } from '../src/server.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function fileBase(dir: string): FileConfig {
  const secret = writeSecretFile(dir, 'ok.whs', FIXTURE_SECRET);
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

describe('R9 absolute dedup.path', () => {
  test('relative bare and nested paths fail load; default and absolute stay valid', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig(base).dedup.path).toBe('/var/lib/webhook-wake/dedup.json');
    expect(parseFileConfig({ ...base, dedup: { path: '/tmp/webhook-wake-dedup.json' } }).dedup.path).toBe(
      '/tmp/webhook-wake-dedup.json',
    );
    expect(() => parseFileConfig({ ...base, dedup: { path: 'dedup.json' } })).toThrow('config_invalid:dedup.path');
    expect(() => parseFileConfig({ ...base, dedup: { path: 'nested/state/dedup.json' } })).toThrow(
      'config_invalid:dedup.path',
    );
    expect(() => parseFileConfig({ ...base, dedup: { path: './dedup.json' } })).toThrow('config_invalid:dedup.path');
    expect(existsSync(join(dir, 'dedup.json'))).toBe(false);
    expect(existsSync(join(dir, 'nested'))).toBe(false);
  });
});

describe('R9 fake-orca flush then exit', () => {
  test('oversized flushed stdout still submits once and duplicates', async () => {
    const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
    chmodSync(fakeOrca, 0o755);
    const dir = tempDir();
    const marker = join(dir, 'submitted');
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fakeOrca, outputCapBytes: 32, sendTimeoutMs: 2000 }, dir),
      {
        extraWakeEnv: {
          FAKE_ORCA_MODE: 'submit-then-bigout',
          FAKE_ORCA_OUT_BYTES: '80000',
          FAKE_ORCA_SUBMIT_MARKER: marker,
        },
      },
    );
    receivers.push(receiver);
    const body = mailBody();
    const first = await postHook(receiver, { body });
    expect(first.status).toBe(200);
    expect(first.json.disposition).toBe('submitted');
    expect(readFileSync(marker, 'utf8')).toContain('submitted');
    const again = await postHook(receiver, { body });
    expect(again.status).toBe(200);
    expect(again.json.disposition).toBe('duplicate');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['submitted']);
  });
});

describe('R9 hostile record-map keys', () => {
  test('__proto__ fixture cannot pollute or become a dedup hit; inspect stays fail-closed', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'dedup.json');
    const validKey = 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555';
    const valid = {
      key: validKey,
      status: 'success',
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    };
    const hostile = {
      key: '__proto__',
      status: 'success',
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
      polluted: true,
    };
    writeFileSync(
      path,
      `{"records":{"__proto__":${JSON.stringify(hostile)},${JSON.stringify(validKey)}:${JSON.stringify(valid)}}}`,
      { mode: 0o600 },
    );
    expect(isValidDedupRecord('__proto__', hostile)).toBe(false);
    expect(inspectDedupFile(path)).toEqual({ ok: false, reason: 'state_corrupt' });
    expect(inspectReadiness(testConfig({ dedup: { path } }, dir)).stateHealthy).toBe(false);

    const store = new DedupStore({ path, retentionMs: MIN_RETENTION_MS, maxRecords: 8 });
    expect(await store.get('__proto__', 1)).toBeUndefined();
    expect(await store.get(validKey, 1)).toEqual(valid);
    expect(({} as { status?: string }).status).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);

    await expect(
      store.commit(
        {
          key: '__proto__',
          status: 'success',
          storedAtMs: 2,
          expiresAtMs: 9_999_999_999_999,
        },
        2,
      ),
    ).rejects.toMatchObject({ code: 'storage_failed' });
    expect(({} as { status?: string }).status).toBeUndefined();
  });
});
