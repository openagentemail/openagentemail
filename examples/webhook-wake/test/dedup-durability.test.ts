import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DedupStore, isValidDedupRecord } from '../src/dedup.ts';
import { mailBody, postHook, startReceiver, tempDir, testConfig } from './helpers.ts';
import { recordingWake } from '../src/wake.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

describe('dedup durability and validation', () => {
  test('malformed records are not successful hits and a later valid commit persists', async () => {
    const dir = tempDir();
    const path = join(dir, 'dedup.json');
    writeFileSync(
      path,
      JSON.stringify({
        records: {
          'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555': {
            status: 'yes',
            storedAtMs: 'nope',
          },
        },
      }),
    );
    expect(
      isValidDedupRecord('whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555', {
        status: 'yes',
      }),
    ).toBe(false);

    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }, dir), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(1);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, { status: string; key: string }> };
    const rec = Object.values(stored.records)[0];
    expect(rec?.status).toBe('success');
    expect(rec?.key).toContain('evt_11111111-2222-3333-4444-555555555555');
  });

  test('rename failure is retryable and does not leave a success record', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('rename');
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('dedup_rename_failed');
    const retry = await postHook(receiver, { body: mailBody() });
    expect(retry.status).toBe(200);
    expect(retry.json.disposition).toBe('submitted');
    expect(bucket).toHaveLength(2);
  });

  test('parent-dir fsync failure after rename is visible; next read may see the record', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);
    receiver.dedup.injectFailure('dir_fsync');
    const first = await postHook(receiver, { body: mailBody() });
    expect(first.status).toBe(503);
    expect(first.json.reason).toBe('dedup_dir_fsync_failed');
    const again = await postHook(receiver, { body: mailBody() });
    expect([200, 503]).toContain(again.status);
    if (again.status === 200) {
      expect(['duplicate', 'submitted']).toContain(again.json.disposition);
    }
  });

  test('first-directory fsync failure fails closed', async () => {
    const store = new DedupStore({
      path: join(tempDir(), 'nested', 'more', 'dedup.json'),
      retentionMs: 1000,
      maxRecords: 8,
    });
    store.injectFailure('mkdir_fsync');
    await expect(
      store.commit(
        { key: 'whk_x:evt_abcdefgh', status: 'success', storedAtMs: 1, expiresAtMs: 2 },
        1,
      ),
    ).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
  });
});
