/**
 * R8 服务端 wait 超时契约：408 体/头相等，且等于实际等待的整数秒。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-contract';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-wait-contract-'));
process.env.UI_ENABLED = 'false';

const { describe, expect, mock, test } = await import('bun:test');
const { EventEmitter } = await import('node:events');

class QuietImap extends EventEmitter {
  get mailbox() {
    return { uidValidity: 17n };
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async idle() {
    await new Promise((r) => setTimeout(r, 20));
  }
  async search() {
    return [];
  }
  async *fetch() {}
  async fetchOne() {
    return false;
  }
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: QuietImap }));

const { createApp } = await import('../src/app.ts');
const { config } = await import('../src/lib/config.ts');
const { readFileSync } = await import('node:fs');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: false });

describe('#206 R8 wait timeout contract', () => {
  test('12 408 体 timeoutSec 与头相等，且等于实际等待的整数秒', async () => {
    const started = Date.now();
    const res = await app.request(
      new Request('http://localhost/v1/messages/wait', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address: 'contract@test.example', timeoutSec: 1 }),
      }),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(408);
    const body = (await res.json()) as { error: string; timeoutSec: number };
    const header = Number(res.headers.get('X-OAE-Wait-Timeout-Sec'));
    expect(body.error).toBe('timeout');
    expect(Number.isInteger(body.timeoutSec)).toBe(true);
    expect(body.timeoutSec).toBeGreaterThanOrEqual(1);
    expect(header).toBe(body.timeoutSec);
    expect(elapsed).toBeGreaterThanOrEqual(body.timeoutSec * 1000 - 250);
    expect(elapsed).toBeLessThan(body.timeoutSec * 1000 + 1500);
  });

  test('10 capacity checkout persist-credentials=false', () => {
    const yml = readFileSync(join(import.meta.dir, '../../../.github/workflows/ci.yml'), 'utf8');
    const capacity = yml.split('\n  capacity:')[1] ?? '';
    expect(capacity).toContain('persist-credentials: false');
    const testJob = yml.split('\n  test:')[1]?.split('\n  capacity:')[0] ?? '';
    expect(testJob).not.toContain('persist-credentials: false');
  });
});
