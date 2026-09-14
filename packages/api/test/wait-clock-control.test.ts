/**
 * #208：墙钟快进 + 单调钟正常时，健康一方 wait 不得早退，也不得被判 upstream_timeout_early。
 * #212：本文件不注入单调钟（仅恢复墙钟）；生产面已无 setWaitMonotonicNowForTests。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key-wait-clock';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-wait-clock-'));
process.env.UI_ENABLED = 'false';

const { afterAll, afterEach, describe, expect, mock, test } = await import('bun:test');
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
    // 首次扫描后只拨墙钟：模拟 NTP/恢复导致的前跳，单调钟继续走。
    Date.now = () => realDateNow() + 30_000;
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
const { ApiError, OpenAgentEmailClient } = await import('../src/mcp/client.ts');

const adminKey = [...config.apiKeys][0]!;
const app = createApp({ uiEnabled: false });
const realDateNow = Date.now;

afterEach(() => {
  Date.now = realDateNow;
});

afterAll(() => {
  // 回收本文件自建 DATA_DIR，避免全量跑留下 oae-wait-clock-*。
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

describe('#208 wait 单调钟不受墙钟快进误伤', () => {
  test('墙钟前跳 30s、单调钟正常：一方 wait 满时限后 408，不是 upstream_timeout_early', async () => {
    const startedMono = performance.now();
    const client = new OpenAgentEmailClient('http://localhost', adminKey, (input, init) =>
      app.request(input, init),
    );
    const err = await client.waitFor('clock-control@test.example', { timeoutSec: 1 }).catch((e) => e);
    const elapsedMono = performance.now() - startedMono;

    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) throw err;
    expect(err.status).toBe(408);
    expect(err.kind).toBe('total_deadline');
    expect(err.kind).not.toBe('upstream_timeout_early');
    expect(err.message).not.toMatch(/upstream_timeout_early/);
    // 单调钟须走满约 1s；若仍读墙钟会在首次 search 后立刻 408。
    expect(elapsedMono).toBeGreaterThanOrEqual(750);
    expect(elapsedMono).toBeLessThan(2500);
  }, 8_000);
});
