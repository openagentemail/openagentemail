#!/usr/bin/env bun
/** Runtime probe: 17KiB signature vs process HTTP header ceiling. */

import { createConnection } from 'node:net';
import { createReceiver, listenReceiver } from '../src/server.ts';
import { buildSignatureHeader } from '../src/verify.ts';
import { FIXTURE_SECRET, mailBody, testConfig } from './helpers.ts';

const body = mailBody();
const ts = Math.floor(Date.now() / 1000);
const base = buildSignatureHeader(FIXTURE_SECRET, body, ts);
const header = `${base},x=${'a'.repeat(17000)}`;
const receiver = createReceiver(testConfig({ mode: 'canary', maxHeaderBytes: 20_000 }), {
  wake: async (req) => ({ ok: true, exitCode: 0, argv: req.argv, stdoutBytes: 0, stderrBytes: 0 }),
});
const url = await listenReceiver(receiver);
const port = Number(new URL(url).port);

const result = await new Promise((resolve) => {
  const sock = createConnection({ host: '127.0.0.1', port }, () => {
    sock.write(
      `POST /hooks/canary HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-OAE-Signature: ${header}\r\n\r\n${body}`,
    );
  });
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
  });
  sock.on('close', () => resolve(buf));
  sock.on('error', (err) => resolve(String(err)));
  setTimeout(() => resolve(buf || 'TIMEOUT'), 2000);
});

await receiver.close();
const text = String(result);
if (text.includes('HTTP/1.1 200')) {
  process.stdout.write('accepted\n');
  process.exit(0);
}
process.stderr.write(text.slice(0, 200) + '\n');
process.exit(1);
