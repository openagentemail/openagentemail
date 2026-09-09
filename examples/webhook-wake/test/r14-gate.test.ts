import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { createConnection } from 'node:net';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReadiness, inspectStateWritable } from '../src/readiness.ts';
import { recordingWake } from '../src/wake.ts';
import { mailBody, postHook, startReceiver, tempDir, testConfig } from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const fakeOrca = fileURLToPath(new URL('./fixtures/fake-orca.mjs', import.meta.url));
chmodSync(fakeOrca, 0o755);

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function unfinishedGet(
  port: number,
  path: string,
): Promise<{ status: number; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 4096\r\n\r\n{`);
    });
    let buf = '';
    let status = 0;
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/^HTTP\/1\.[01] (\d{3})/);
      if (match) status = Number(match[1]);
    });
    sock.on('close', () => resolve({ status, closed: true }));
    sock.on('error', reject);
    setTimeout(() => reject(new Error(`unfinished ${path} did not close`)), 2000);
  });
}

describe('R14 health and ready unfinished bodies', () => {
  test('GET /health and /ready flush then close; ordinary health and signed wake still work', async () => {
    const wakes: WakeRequest[] = [];
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', orcaBinary: fakeOrca, requestTimeoutMs: 80 }),
      { wake: recordingWake(wakes) },
    );
    receivers.push(receiver);
    const port = Number(new URL(receiver.url()).port);

    const health = await unfinishedGet(port, '/health');
    expect(health).toEqual({ status: 200, closed: true });
    const ready = await unfinishedGet(port, '/ready');
    expect(ready.status).toBe(200);
    expect(ready.closed).toBe(true);

    const live = await fetch(`${receiver.url()}/health`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', liveness: 'ok' });

    const posted = await postHook(receiver, { body: mailBody() });
    expect(posted.status).toBe(200);
    expect(posted.json.disposition).toBe('submitted');
    expect(wakes).toHaveLength(1);
  });
});

describe('R14 dangling parent is not an absent directory', () => {
  test('dangling symlink parent is unready and canary does not wake; missing dir still creates', async () => {
    const root = tempDir();
    const dangle = join(root, 'dangle');
    symlinkSync(join(root, 'missing-target'), dangle);
    const blockedPath = join(dangle, 'dedup.json');
    expect(inspectStateWritable(blockedPath)).toBe(false);
    expect(inspectReadiness(testConfig({ dedup: { path: blockedPath } }, root)).ready).toBe(false);

    const fileParent = join(root, 'as-file');
    writeFileSync(fileParent, 'nope');
    expect(inspectStateWritable(join(fileParent, 'dedup.json'))).toBe(false);

    const wakes: WakeRequest[] = [];
    const blocked = await startReceiver(
      testConfig({ mode: 'canary', dedup: { path: blockedPath } }, root),
      { wake: recordingWake(wakes) },
    );
    receivers.push(blocked);
    const refused = await postHook(blocked, { body: mailBody() });
    expect(refused.status).toBe(503);
    expect(refused.json.reason).toBe('state_unwritable');
    expect(wakes).toHaveLength(0);

    const absentPath = join(root, 'not-created-yet', 'dedup.json');
    expect(inspectStateWritable(absentPath)).toBe(true);
    const created: WakeRequest[] = [];
    const ok = await startReceiver(
      testConfig({ mode: 'canary', dedup: { path: absentPath } }, root),
      { wake: recordingWake(created) },
    );
    receivers.push(ok);
    const submitted = await postHook(ok, { body: mailBody() });
    expect(submitted.status).toBe(200);
    expect(submitted.json.disposition).toBe('submitted');
    expect(created).toHaveLength(1);
  });
});
