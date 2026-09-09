import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createHttpAlert } from '../src/alert.ts';
import { MIN_RETENTION_MS, parseFileConfig } from '../src/config.ts';
import { DedupStore } from '../src/dedup.ts';
import { httpProbe } from '../src/monitor.ts';
import { recordingWake } from '../src/wake.ts';
import { buildSignatureHeader } from '../src/verify.ts';
import {
  FIXTURE_SECRET,
  mailBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  testRoute,
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

describe('R4 monitor helper exact 200', () => {
  test('httpProbe accepts only 200 and does not follow redirects', async () => {
    const hits = new Map<string, number>();
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === '/ok') {
        res.writeHead(200);
        res.end('{"status":"ok"}');
        return;
      }
      if (path === '/empty') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === '/redir') {
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      }
      if (path === '/missing') {
        res.writeHead(404);
        res.end('no');
        return;
      }
      res.writeHead(503);
      res.end('down');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    expect((await httpProbe(`${base}/ok`, 300)).ok).toBe(true);
    expect((await httpProbe(`${base}/empty`, 300)).ok).toBe(false);
    expect((await httpProbe(`${base}/redir`, 300)).ok).toBe(false);
    expect((await httpProbe(`${base}/missing`, 300)).ok).toBe(false);
    expect((await httpProbe(`${base}/down`, 300)).ok).toBe(false);
    expect(hits.get('/ok')).toBe(1);
    expect(hits.get('/redir')).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('R4 timeout releases incomplete body slots', () => {
  test('slow raw sockets time out and free maxConcurrent for a later signed request', async () => {
    const receiver = await startReceiver(
      testConfig({ mode: 'canary', maxConcurrent: 1, requestTimeoutMs: 80 }),
      { wake: recordingWake([]) },
    );
    receivers.push(receiver);
    const url = new URL(receiver.url());
    const port = Number(url.port);
    const body = mailBody();
    const ts = Math.floor(Date.now() / 1000);
    const sig = buildSignatureHeader(FIXTURE_SECRET, body, ts);

    const slow = new Promise<{ status: number }>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.write(
          `POST /hooks/canary HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nX-OAE-Signature: ${sig}\r\n\r\n{`,
        );
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        const match = buf.match(/^HTTP\/1\.[01] (\d{3})/);
        if (match) {
          sock.destroy();
          resolve({ status: Number(match[1]) });
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('slow socket produced no status')), 2000);
    });

    await Bun.sleep(20);
    const busy = await postHook(receiver, { body: mailBody({ id: 'evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }) });
    expect(busy.status).toBe(503);
    expect(busy.json.reason).toBe('max_concurrent');
    expect((await slow).status).toBe(503);
    await Bun.sleep(20);
    const later = await postHook(receiver, { body });
    expect(later.status).toBe(200);
    expect(later.json.disposition).toBe('submitted');
  });
});

describe('R4 reserved capacity across seats', () => {
  test('observe cannot consume the last slot after canary has reserved for wake', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wakes = 0;
    const receiver = await startReceiver(
      testConfig({
        mode: 'canary',
        routes: [
          testRoute(),
          testRoute({
            routeKey: 'other',
            mailbox: 'bob@openagent.email',
            terminal: 'term_examplestale00002',
            subscriptionId: 'whk_bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          }),
        ],
        dedup: { maxRecords: 1 },
      }),
      {
        wake: async (req) => {
          wakes += 1;
          await gate;
          return { ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 };
        },
      },
    );
    receivers.push(receiver);
    const canaryP = postHook(receiver, { body: mailBody() });
    const deadline = Date.now() + 1000;
    while (wakes < 1 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(wakes).toBe(1);
    const observe = await postHook(receiver, {
      routeKey: 'other',
      body: mailBody({
        id: 'evt_bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        data: { address: 'bob@openagent.email', messageId: '9' },
      }),
    });
    expect(observe.status).toBe(503);
    expect(observe.json.reason).toBe('storage_capacity');
    release();
    const canary = await canaryP;
    expect(canary.status).toBe(200);
    expect(canary.json.disposition).toBe('submitted');
    expect(wakes).toBe(1);
  });
});

describe('R4 routes object shape', () => {
  test('array null and scalar routes fail load; named object works', () => {
    const dir = tempDir();
    expect(() => parseFileConfig({ ...fileBase(dir), routes: [] as unknown as FileConfig['routes'] })).toThrow(
      'config_invalid:routes',
    );
    expect(() => parseFileConfig({ ...fileBase(dir), routes: null as unknown as FileConfig['routes'] })).toThrow(
      'config_invalid:routes',
    );
    expect(() => parseFileConfig({ ...fileBase(dir), routes: 'canary' as unknown as FileConfig['routes'] })).toThrow(
      'config_invalid:routes',
    );
    expect(() =>
      parseFileConfig({
        ...fileBase(dir),
        routes: { canary: null as unknown as NonNullable<FileConfig['routes']>[string] },
      }),
    ).toThrow('config_invalid:route:canary');
    const loaded = parseFileConfig({ ...fileBase(dir), dedup: { retentionMs: MIN_RETENTION_MS } });
    expect(loaded.routes[0]?.routeKey).toBe('canary');
  });
});

describe('R4 ancestor mkdir fsync retry', () => {
  test('failed first-create fsync resyncs the ancestor chain before ACK', async () => {
    const root = tempDir();
    const path = join(root, 'a', 'b', 'c', 'dedup.json');
    const store = new DedupStore({
      path,
      retentionMs: MIN_RETENTION_MS,
      maxRecords: 8,
    });
    const rec = {
      key: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:evt_11111111-2222-3333-4444-555555555555',
      status: 'success' as const,
      storedAtMs: 1,
      expiresAtMs: 9_999_999_999_999,
    };
    store.injectFailure('mkdir_fsync');
    await expect(store.commit(rec, 1)).rejects.toMatchObject({ code: 'dedup_mkdir_fsync_failed' });
    expect(existsSync(store.dirsyncPath())).toBe(true);
    const listed = readFileSync(store.dirsyncPath(), 'utf8');
    expect(listed).toContain(join(root, 'a'));
    expect(listed).toContain(join(root, 'a', 'b'));
    expect(listed).toContain(join(root, 'a', 'b', 'c'));
    await store.commit(rec, 1);
    expect(existsSync(store.dirsyncPath())).toBe(false);
    expect(store.mkdirSynced.some((dir) => dir.endsWith(`${join('a')}`) || dir.endsWith('/a'))).toBe(true);
    expect(store.mkdirSynced.some((dir) => dir.includes(`${join('a', 'b')}`))).toBe(true);
    expect(store.mkdirSynced.some((dir) => dir.includes(`${join('a', 'b', 'c')}`))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe('R4 alert redirect and secret nofollow', () => {
  test('http alert does not follow a 302 to a 200 page', async () => {
    let targetHits = 0;
    const server = createServer((req, res) => {
      if (req.url === '/ok') {
        targetHits += 1;
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(302, { location: '/ok' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const fn = createHttpAlert(`http://127.0.0.1:${addr.port}/alert`, 300);
    const result = await fn({ kind: 'receiver_failure', code: 'send_failed' });
    expect(result.ok).toBe(false);
    expect(targetHits).toBe(0);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test('secret symlink fails load without following', () => {
    const dir = tempDir();
    const real = writeSecretFile(dir, 'real.whs', FIXTURE_SECRET);
    const link = join(dir, 'link.whs');
    symlinkSync(real, link);
    const base = fileBase(dir);
    base.routes!.canary!.secretFile = link;
    expect(() => parseFileConfig(base)).toThrow(/secret_symlink|ELOOP/);
  });
});
