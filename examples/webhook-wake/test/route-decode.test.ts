import { afterEach, describe, expect, test } from 'bun:test';
import { request } from 'node:http';
import { startReceiver, testConfig } from './helpers.ts';
import type { Receiver } from '../src/server.ts';

const receivers: Receiver[] = [];
afterEach(async () => {
  while (receivers.length) await receivers.pop()!.close();
});

function rawPost(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 2 },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe('malformed hook encoding', () => {
  test('POST /hooks/% is rejected and the process still answers /health', async () => {
    const receiver = await startReceiver(testConfig({ mode: 'observe' }));
    receivers.push(receiver);
    const posted = await rawPost(receiver.url(), '/hooks/%');
    expect(posted.status).toBe(400);
    expect(posted.body).toContain('bad_route_encoding');

    const health = await fetch(`${receiver.url()}/health`);
    expect(health.status).toBe(200);
    const json = (await health.json()) as { liveness: string };
    expect(json.liveness).toBe('ok');

    const again = await rawPost(receiver.url(), '/hooks/%E0%');
    expect(again.status).toBe(400);
    const health2 = await fetch(`${receiver.url()}/health`);
    expect(health2.status).toBe(200);
  });
});
