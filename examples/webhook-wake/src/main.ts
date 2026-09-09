/**
 * Optional standalone webhook-wake entrypoint.
 * Secrets come from files referenced by the config; they are not CLI flags.
 */

import { resolve } from 'node:path';
import { loadConfigFile } from './config.ts';
import { logEvent } from './log.ts';
import { inspectReadiness } from './readiness.ts';
import { createReceiver, listenReceiver } from './server.ts';

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const configArg = readArg('--config') ?? process.env.WEBHOOK_WAKE_CONFIG;
if (!configArg) {
  console.error('Usage: bun src/main.ts --config /path/to/config.json');
  process.exit(2);
}
const configPath = resolve(configArg);

const config = loadConfigFile(configPath);
const ready = inspectReadiness(config);
logEvent('info', 'startup', {
  mode: config.mode,
  routeCount: config.routes.length,
  ready: ready.ready,
  warnings: ready.warnings,
});
if (!ready.ready) {
  logEvent('error', 'startup_not_ready', { warnings: ready.warnings });
}

const receiver = createReceiver(config);
const url = await listenReceiver(receiver);
logEvent('info', 'listening', { url, host: config.listen.host, port: config.listen.port });

const shutdown = async () => {
  await receiver.close();
  process.exit(0);
};
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
