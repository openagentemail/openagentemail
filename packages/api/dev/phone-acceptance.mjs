// Clean-compose phone-pairing acceptance probe. Start a fresh stack first:
//
// PHONE_ACCEPTANCE_API=http://127.0.0.1:3100 \
// PHONE_ACCEPTANCE_ADMIN_KEY=... \
// PHONE_ACCEPTANCE_COMPOSE_PROJECT=oae-phone-acceptance \
// npx -y bun@1.2.21 run dev/phone-acceptance.mjs
//
// The stack should set NOTIFY_PUBLIC_URL=https://ntfy.example.com. This probe
// checks the generated base URL, makes a read-only phone account, and proves
// its two human topics cannot publish or read a private agent topic.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const api = (process.env.PHONE_ACCEPTANCE_API ?? 'http://127.0.0.1:3100').replace(/\/+$/, '');
const adminKey = process.env.PHONE_ACCEPTANCE_ADMIN_KEY;
const publicUrl = (process.env.PHONE_ACCEPTANCE_PUBLIC_URL ?? 'https://ntfy.example.com').replace(/\/+$/, '');
const ntfy = (process.env.PHONE_ACCEPTANCE_NTFY_URL ?? 'http://127.0.0.1:2586').replace(/\/+$/, '');
const composeProject = process.env.PHONE_ACCEPTANCE_COMPOSE_PROJECT;
const here = dirname(fileURLToPath(import.meta.url));
const composeFile = process.env.PHONE_ACCEPTANCE_COMPOSE_FILE ?? resolve(here, '../../../compose.yaml');

if (!adminKey) throw new Error('Set PHONE_ACCEPTANCE_ADMIN_KEY to the clean stack API_KEYS value.');
if (!composeProject) throw new Error('Set PHONE_ACCEPTANCE_COMPOSE_PROJECT to the fresh Compose project name.');

async function request(path, token, method = 'GET', body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function composeRead(path) {
  return execFileSync('docker', [
    'compose', '--project-name', composeProject, '-f', composeFile,
    'exec', '-T', 'api', 'cat', path,
  ], { encoding: 'utf8' });
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

const health = await fetch(`${api}/healthz`);
if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

const serverConfig = composeRead('/app/data/ntfy/server.yml');
if (!serverConfig.includes(`base-url: ${JSON.stringify(publicUrl)}`)) {
  throw new Error(`ntfy server.yml does not contain the expected base URL ${publicUrl}`);
}
console.log('[acceptance] server.yml has the expected public ntfy base URL');

const device = await request('/v1/notify/devices', adminKey, 'POST', { publicUrl });
if (
  device.serverUrl !== publicUrl ||
  typeof device.username !== 'string' ||
  typeof device.password !== 'string' ||
  typeof device.topics?.userAlerts !== 'string' ||
  typeof device.topics?.userLow !== 'string'
) {
  throw new Error('Device response did not contain the expected reader and two human topics.');
}

for (const topic of [device.topics.userAlerts, device.topics.userLow]) {
  const response = await fetch(`${ntfy}/${encodeURIComponent(topic)}/json?poll=1`, {
    headers: { authorization: basic(device.username, device.password) },
  });
  if (!response.ok) throw new Error(`Phone reader cannot subscribe to ${topic}: ${response.status}`);
}
console.log('[acceptance] one phone reader can subscribe to both human topics');

const publish = await fetch(`${ntfy}/`, {
  method: 'POST',
  headers: { authorization: basic(device.username, device.password), 'content-type': 'application/json' },
  body: JSON.stringify({ topic: device.topics.userAlerts, message: 'must be rejected' }),
});
if (publish.ok) throw new Error('Phone reader unexpectedly published to a human topic.');

const suffix = Date.now().toString(36);
const identity = await request('/v1/identities', adminKey, 'POST', { localpart: `phone-check-${suffix}` });
const routes = JSON.parse(composeRead('/app/data/ntfy/notifications.json'));
const agent = routes.agents?.[`phone-check-${suffix}`]?.topic;
if (typeof agent !== 'string') throw new Error('The acceptance identity did not receive a private agent topic.');
const privateRead = await fetch(`${ntfy}/${encodeURIComponent(agent)}/json?poll=1`, {
  headers: { authorization: basic(device.username, device.password) },
});
if (privateRead.ok) throw new Error('Phone reader unexpectedly read a private agent topic.');

console.log('[acceptance] phone reader cannot publish or read a private agent topic');
console.log('[acceptance] PASS public base URL -> device reader -> two human topics only');
