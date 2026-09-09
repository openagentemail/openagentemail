import { afterEach, describe, expect, test } from 'bun:test';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer } from 'node:http';
import { parseFileConfig, type FileConfig } from '../src/config.ts';
import { httpProbe } from '../src/monitor.ts';
import { parseVerifiedEnvelope } from '../src/parse.ts';
import { recordingWake } from '../src/wake.ts';
import {
  mailBody,
  pingBody,
  postHook,
  startReceiver,
  tempDir,
  testConfig,
  writeSecretFile,
} from './helpers.ts';
import type { Receiver } from '../src/server.ts';
import type { WakeRequest } from '../src/types.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

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

describe('R20 httpProbe wall-clock deadline', () => {
  test('drip of incomplete headers fails within the total timeout', async () => {
    const sockets: Socket[] = [];
    const srv = createNetServer((sock) => {
      sockets.push(sock);
      sock.write('HTTP/1.1');
      const iv = setInterval(() => {
        try {
          sock.write('X');
        } catch {
          /* peer already gone */
        }
      }, 40);
      sock.on('close', () => clearInterval(iv));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const addr = srv.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const started = Date.now();
    const result = await httpProbe(`http://127.0.0.1:${addr.port}/`, 80);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false });
    expect(elapsed).toBeLessThan(500);
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  }, 2000);

  test('exact 200, error, and unsupported protocol stay the same', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const base = `http://127.0.0.1:${addr.port}`;
    expect((await httpProbe(`${base}/ok`, 300)).ok).toBe(true);
    expect((await httpProbe(`${base}/down`, 300)).ok).toBe(false);
    expect((await httpProbe('ftp://example.invalid', 100)).ok).toBe(false);
    expect((await httpProbe('file:///etc/passwd', 100)).ok).toBe(false);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });
});

describe('R20 data.object discriminator', () => {
  test('missing or mismatched object rejects signed mail and ping with zero wake', async () => {
    const bucket: WakeRequest[] = [];
    const receiver = await startReceiver(testConfig({ mode: 'canary' }), { wake: recordingWake(bucket) });
    receivers.push(receiver);

    const mailMissing = JSON.parse(mailBody()) as { data: Record<string, unknown>; id: string };
    delete mailMissing.data.object;
    mailMissing.id = 'evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const missMail = await postHook(receiver, { body: JSON.stringify(mailMissing) });
    expect(missMail.status).toBe(400);
    expect(missMail.json.reason).toBe('invalid_data_object');

    const mailWrong = mailBody({
      id: 'evt_bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      data: { object: 'approval' },
    });
    const wrongMail = await postHook(receiver, { body: mailWrong });
    expect(wrongMail.status).toBe(400);
    expect(wrongMail.json.reason).toBe('invalid_data_object');

    const pingMissing = JSON.parse(pingBody()) as { data: Record<string, unknown>; id: string };
    delete pingMissing.data.object;
    pingMissing.id = 'evt_cccccccc-dddd-eeee-ffff-000000000000';
    const missPing = await postHook(receiver, { body: JSON.stringify(pingMissing) });
    expect(missPing.status).toBe(400);
    expect(missPing.json.reason).toBe('invalid_data_object');

    const pingWrong = JSON.parse(pingBody()) as { data: Record<string, unknown>; id: string };
    pingWrong.data.object = 'mail';
    pingWrong.id = 'evt_dddddddd-eeee-ffff-0000-111111111111';
    const wrongPing = await postHook(receiver, { body: JSON.stringify(pingWrong) });
    expect(wrongPing.status).toBe(400);
    expect(wrongPing.json.reason).toBe('invalid_data_object');

    expect(bucket).toHaveLength(0);
    expect(parseVerifiedEnvelope(mailBody()).ok).toBe(true);
    expect(parseVerifiedEnvelope(pingBody()).ok).toBe(true);
  });
});

describe('R20 present canaryTerminal', () => {
  test('false, 0, empty, and whitespace fail load in observe; absent and null stay unset', () => {
    const dir = tempDir();
    const absent = parseFileConfig(fileBase(dir), { loadSecrets: false });
    expect(absent.canaryTerminal).toBeNull();

    const explicitNull = parseFileConfig({ ...fileBase(dir), canaryTerminal: null }, { loadSecrets: false });
    expect(explicitNull.canaryTerminal).toBeNull();

    const bound = parseFileConfig(
      { ...fileBase(dir), mode: 'observe', canaryTerminal: 'term_examplecanary0001' },
      { loadSecrets: false },
    );
    expect(bound.canaryTerminal).toBe('term_examplecanary0001');

    for (const value of [false, 0, '', '   '] as unknown[]) {
      expect(() =>
        parseFileConfig({ ...fileBase(dir), canaryTerminal: value as never }, { loadSecrets: false }),
      ).toThrow('config_invalid:canaryTerminal');
    }
  });
});
