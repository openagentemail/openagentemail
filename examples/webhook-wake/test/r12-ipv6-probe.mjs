#!/usr/bin/env bun
/** Child-only: probe a real ::1 receiver without inherited HTTP proxy. */

import { createServer } from 'node:http';
import { httpProbe } from '../src/monitor.ts';
import { createReceiver, listenReceiver } from '../src/server.ts';
import { testConfig } from './helpers.ts';

const available = await new Promise((resolve) => {
  const probe = createServer();
  probe.once('error', (err) => {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : '';
    resolve(code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT');
    probe.close();
  });
  probe.listen(0, '::1', () => {
    probe.close(() => resolve(true));
  });
});

if (!available) {
  process.stdout.write('SKIPPED:ipv6_unavailable\n');
  process.exit(0);
}

const receiver = createReceiver(testConfig({ listen: { host: '::1', port: 0 } }));
const url = await listenReceiver(receiver);
const parsed = new URL(`${url}/health`);
const health = await httpProbe(`${url}/health`, 500);

const redir = createServer((_req, res) => {
  res.writeHead(302, { location: '/health' });
  res.end();
});
await new Promise((resolve, reject) => {
  redir.once('error', reject);
  redir.listen(0, '::1', resolve);
});
const redirAddr = redir.address();
if (!redirAddr || typeof redirAddr === 'string') {
  await receiver.close();
  process.stderr.write('no redir addr\n');
  process.exit(1);
}
const redirected = await httpProbe(`http://[::1]:${redirAddr.port}/`, 400);
await new Promise((resolve) => redir.close(resolve));
await receiver.close();

const report = {
  healthOk: health.ok,
  redirectOk: redirected.ok,
  urlHostname: parsed.hostname,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (health.ok && redirected.ok === false && parsed.hostname === '[::1]') {
  process.exit(0);
}
process.exit(1);
