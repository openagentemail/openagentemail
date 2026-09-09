import { afterEach, describe, expect, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import { parseFileConfig } from '../src/config.ts';
import { httpProbe } from '../src/monitor.ts';
import {
  FIXTURE_SECRET,
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

function withSecret(dir: string, secretFile: unknown, previousSecretFile?: unknown): FileConfig {
  const base = fileBase(dir);
  return {
    ...base,
    routes: {
      canary: {
        ...base.routes!.canary!,
        secretFile: secretFile as string,
        ...(previousSecretFile !== undefined
          ? { previousSecretFile: previousSecretFile as string | null }
          : {}),
      },
    },
  };
}

describe('R11 secret path preflight', () => {
  test('missing null numeric object empty secret paths fail with or without loadSecrets', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    const missing = structuredClone(base);
    delete (missing.routes!.canary as { secretFile?: string }).secretFile;
    const bad = [missing, withSecret(dir, null), withSecret(dir, 12), withSecret(dir, { p: 1 }), withSecret(dir, '')];
    for (const raw of bad) {
      expect(() => parseFileConfig(raw)).toThrow('config_invalid:secretFile');
      expect(() => parseFileConfig(raw, { loadSecrets: false })).toThrow('config_invalid:secretFile');
    }
    expect(() => parseFileConfig(withSecret(dir, writeSecretFile(dir, 'ok.whs', FIXTURE_SECRET), ''))).toThrow(
      'config_invalid:previousSecretFile',
    );
    expect(() => parseFileConfig(withSecret(dir, writeSecretFile(dir, 'ok2.whs', FIXTURE_SECRET), 1), { loadSecrets: false })).toThrow(
      'config_invalid:previousSecretFile',
    );
  });

  test('preflight accepts a nonexistent string path without IO; real load still fails', () => {
    const dir = tempDir();
    const missing = `${dir}/does-not-exist.whs`;
    const raw = withSecret(dir, missing);
    const pre = parseFileConfig(raw, { loadSecrets: false });
    expect(pre.routes[0]?.secret).toBe('');
    expect(() => parseFileConfig(raw)).toThrow();
    const relative = withSecret(dir, 'relative-ok.whs');
    expect(parseFileConfig(relative, { loadSecrets: false }).routes[0]?.routeKey).toBe('canary');
    const withNullPrev = withSecret(dir, writeSecretFile(dir, 'cur.whs', FIXTURE_SECRET), null);
    expect(parseFileConfig(withNullPrev, { loadSecrets: false }).routes[0]?.routeKey).toBe('canary');
  });
});

describe('R11 alertHook container', () => {
  test('string array null scalar fail load; absent and object-null URL stay disabled', () => {
    const dir = tempDir();
    const base = fileBase(dir);
    expect(parseFileConfig(base).alertHook.url).toBeNull();
    expect(parseFileConfig({ ...base, alertHook: { url: null } }).alertHook.url).toBeNull();
    expect(() => parseFileConfig({ ...base, alertHook: 'http://127.0.0.1/hook' } as unknown as FileConfig)).toThrow(
      'config_invalid:alertHook',
    );
    expect(() => parseFileConfig({ ...base, alertHook: ['http://127.0.0.1/hook'] } as unknown as FileConfig)).toThrow(
      'config_invalid:alertHook',
    );
    expect(() => parseFileConfig({ ...base, alertHook: null } as unknown as FileConfig)).toThrow('config_invalid:alertHook');
    expect(() => parseFileConfig({ ...base, alertHook: 1 } as unknown as FileConfig)).toThrow('config_invalid:alertHook');
  });
});

describe('R11 IPv6 listen URL', () => {
  test('::1 bind returns a parseable bracketed URL and /health works when IPv6 exists', async () => {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        resolve(code !== 'EADDRNOTAVAIL' && code !== 'EAFNOSUPPORT');
        probe.close();
      });
      probe.listen(0, '::1', () => {
        probe.close(() => resolve(true));
      });
    });
    if (!available) {
      expect('SKIPPED:ipv6_unavailable').toContain('SKIPPED:');
      return;
    }

    const receiver = await startReceiver(testConfig({ listen: { host: '::1', port: 0 } }));
    receivers.push(receiver);
    const url = receiver.url();
    expect(url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const parsed = new URL(url);
    expect(parsed.port).toMatch(/^\d+$/);
    // Direct socket: this host's HTTP_PROXY intercepts Bun fetch/http to ::1.
    const status = await new Promise<number>((resolve, reject) => {
      const sock = createConnection({ host: '::1', port: Number(parsed.port) }, () => {
        sock.write(`GET /health HTTP/1.1\r\nHost: [::1]:${parsed.port}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
      });
      sock.on('close', () => {
        const match = buf.match(/^HTTP\/1\.\d (\d{3})/);
        resolve(match ? Number(match[1]) : 0);
      });
      sock.on('error', reject);
    });
    expect(status).toBe(200);

    const v4 = await startReceiver(testConfig({ listen: { host: '127.0.0.1', port: 0 } }));
    receivers.push(v4);
    expect(v4.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await httpProbe(`${v4.url()}/health`, 300)).ok).toBe(true);
  });
});
