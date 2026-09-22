/**
 * #244：POST /v1/messages/:id/seen 每-caller 轻量限速。
 * 三态：合规突发全过 / 超限 429 / reset* 恢复；默认档 ≥300/5min 必须放行。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-seen-rate-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-seen-rate-'));
process.env.MCP_PUBLIC_URL = 'http://localhost';

const { beforeEach, describe, expect, mock, test } = await import('bun:test');

let fakeMessages: any[] = [];
let flagsCalls: { op: 'add' | 'remove'; uid: number; flags: string[] }[] = [];

class FakeImapFlow extends EventEmitter {
  get mailbox() {
    return { uidValidity: 17n };
  }
  async connect() {}
  async getMailboxLock() {
    return { release() {} };
  }
  async search() {
    return fakeMessages.map((m) => m.uid);
  }
  async *fetch(uids?: number[]) {
    if (Array.isArray(uids)) {
      const set = new Set(uids);
      yield* fakeMessages.filter((m) => set.has(m.uid));
    } else {
      yield* fakeMessages;
    }
  }
  async fetchOne(uid: number) {
    const message = fakeMessages.find((c) => c.uid === uid);
    if (!message) return false;
    return {
      ...message,
      source:
        message.source ??
        Buffer.from(
          `From: sender@example.net\r\nTo: owner@test.example\r\nSubject: hi\r\n\r\n<body>hi</body>`,
        ),
    };
  }
  async messageFlagsAdd(uid: number, flags: string[]) {
    flagsCalls.push({ op: 'add', uid, flags: [...flags] });
  }
  async messageFlagsRemove(uid: number, flags: string[]) {
    flagsCalls.push({ op: 'remove', uid, flags: [...flags] });
  }
  async logout() {}
  close() {}
}

mock.module('imapflow', () => ({ ImapFlow: FakeImapFlow }));

const { createApp } = await import('../src/app.ts');
const { readAuditEvents, resetAuditForTests } = await import('../src/lib/audit.ts');
const { createIdentity } = await import('../src/lib/identities.ts');
const {
  checkMarkSeenLimit,
  DEFAULT_MARK_SEEN_RATE_LIMIT,
  DEFAULT_MARK_SEEN_RATE_WINDOW_MS,
  parsePositiveIntEnv,
  resetMarkSeenLimits,
  resetRateLimits,
  resolveMarkSeenRateLimit,
  resolveMarkSeenRateWindowMs,
} = await import('../src/lib/ratelimit.ts');

const app = createApp();

function makeInboxMsg(uid: number, address: string) {
  return {
    uid,
    flags: new Set<string>(),
    envelope: {
      date: new Date('2026-09-01T12:00:00.000Z'),
      subject: `Msg ${uid}`,
      from: [{ address: 'sender@example.net', name: 'Sender' }],
      to: [{ address, name: 'Owner' }],
    },
    internalDate: new Date('2026-09-01T12:00:00.000Z'),
    headers: Buffer.from(`Delivered-To: ${address}\r\n`),
    source: Buffer.from(
      `From: sender@example.net\r\nTo: ${address}\r\nSubject: Msg ${uid}\r\n\r\nbody`,
    ),
  };
}

beforeEach(() => {
  resetAuditForTests();
  resetMarkSeenLimits();
  flagsCalls = [];
  fakeMessages = [];
});

describe('#244 mark-seen env fail-safe', () => {
  test('缺失/非法回落安全默认（不得 0 或无限）', () => {
    expect(parsePositiveIntEnv(undefined, 300)).toBe(300);
    expect(parsePositiveIntEnv('', 300)).toBe(300);
    expect(parsePositiveIntEnv('0', 300)).toBe(300);
    expect(parsePositiveIntEnv('-1', 300)).toBe(300);
    expect(parsePositiveIntEnv('abc', 300)).toBe(300);
    expect(parsePositiveIntEnv('1.5', 300)).toBe(300);
    expect(parsePositiveIntEnv('400', 300)).toBe(400);

    expect(resolveMarkSeenRateLimit({})).toBe(DEFAULT_MARK_SEEN_RATE_LIMIT);
    expect(resolveMarkSeenRateLimit({ MARK_SEEN_RATE_LIMIT: '0' })).toBe(
      DEFAULT_MARK_SEEN_RATE_LIMIT,
    );
    expect(resolveMarkSeenRateLimit({ MARK_SEEN_RATE_LIMIT: 'nope' })).toBe(
      DEFAULT_MARK_SEEN_RATE_LIMIT,
    );
    expect(resolveMarkSeenRateWindowMs({})).toBe(DEFAULT_MARK_SEEN_RATE_WINDOW_MS);
    expect(resolveMarkSeenRateWindowMs({ MARK_SEEN_RATE_WINDOW_MS: '-5' })).toBe(
      DEFAULT_MARK_SEEN_RATE_WINDOW_MS,
    );
  });

  test('checkMarkSeenLimit 误传 limit=0 仍回落默认而非放行无限', () => {
    resetMarkSeenLimits();
    const now = 1_000_000;
    // 若按 send 族 limit≤0=无限，下面会全过；此处必须在默认 300 处封顶
    for (let i = 0; i < DEFAULT_MARK_SEEN_RATE_LIMIT; i++) {
      expect(checkMarkSeenLimit('a@x.com', 0, 60_000, now).allowed).toBe(true);
    }
    expect(checkMarkSeenLimit('a@x.com', 0, 60_000, now).allowed).toBe(false);
  });
});

describe('#244 mark-seen 默认档 ≥300/5min 必须放行', () => {
  test('同一 caller 默认窗口内 300 次全部 allowed（硬要求 1）', () => {
    resetMarkSeenLimits();
    const now = 5_000_000;
    const limit = resolveMarkSeenRateLimit({});
    const windowMs = resolveMarkSeenRateWindowMs({});
    expect(limit).toBe(300);
    expect(windowMs).toBe(300_000);

    let allowed = 0;
    for (let i = 0; i < 300; i++) {
      const r = checkMarkSeenLimit('catchup@test.example', limit, windowMs, now);
      if (r.allowed) allowed++;
    }
    expect(allowed).toBe(300);
    // 第 301 次才拒
    expect(checkMarkSeenLimit('catchup@test.example', limit, windowMs, now).allowed).toBe(
      false,
    );
  });
});

describe('#244 mark-seen 路由三态', () => {
  test('合规突发：200 次/窗口内全 200（低 limit 测路由契约）', async () => {
    const created = createIdentity({ localpart: 'seen-burst' })!;
    const address = created.identity.address;
    fakeMessages = [makeInboxMsg(1, address)];

    // 用显式低桶仍测「突发全过」：先 reset，再经 check 灌；路由读进程默认 300。
    // 路由侧验收：连续 200 次成功（默认 300 档下必过）。
    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await app.request('/v1/messages/1/seen', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${created.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ address, seen: true }),
      });
      statuses.push(res.status);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(statuses).toHaveLength(200);
  });

  test('超限 → 429 + Retry-After + {error:rate_limited,retryAfterSec}；成功路径审计/IMAP 不变', async () => {
    const created = createIdentity({ localpart: 'seen-rl' })!;
    const address = created.identity.address;
    fakeMessages = [makeInboxMsg(2, address)];

    // 预填桶至默认上限，使下一次路由必 429（不改成功路径字节）
    const now = Date.now();
    for (let i = 0; i < DEFAULT_MARK_SEEN_RATE_LIMIT; i++) {
      expect(
        checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now).allowed,
      ).toBe(true);
    }

    const flagsBefore = flagsCalls.length;
    const auditsBefore = readAuditEvents({ event: 'message.mark_seen', limit: 500 }).length;

    const res = await app.request('/v1/messages/2/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address, seen: true }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retryAfterSec).toBe('number');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(Number(res.headers.get('Retry-After'))).toBe(body.retryAfterSec);

    // 429 不得写 IMAP flags、不得落 mark_seen 审计
    expect(flagsCalls.length).toBe(flagsBefore);
    expect(readAuditEvents({ event: 'message.mark_seen', limit: 500 }).length).toBe(
      auditsBefore,
    );
  });

  test('resetMarkSeenLimits / resetRateLimits 后恢复放行', async () => {
    const created = createIdentity({ localpart: 'seen-reset' })!;
    const address = created.identity.address;
    fakeMessages = [makeInboxMsg(3, address)];

    const now = Date.now();
    for (let i = 0; i < DEFAULT_MARK_SEEN_RATE_LIMIT; i++) {
      checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now);
    }
    expect(
      checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now).allowed,
    ).toBe(false);

    resetMarkSeenLimits();
    expect(
      checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now).allowed,
    ).toBe(true);

    // 再灌满后经 resetRateLimits（公共 reset 须清 mark-seen 桶）恢复
    for (let i = 0; i < DEFAULT_MARK_SEEN_RATE_LIMIT; i++) {
      checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now);
    }
    expect(
      checkMarkSeenLimit(address, DEFAULT_MARK_SEEN_RATE_LIMIT, 300_000, now).allowed,
    ).toBe(false);
    resetRateLimits();

    const res = await app.request('/v1/messages/3/seen', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address, seen: false }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '3', seen: false });
    expect(flagsCalls.some((c) => c.op === 'remove' && c.uid === 3)).toBe(true);
    const rows = readAuditEvents({ event: 'message.mark_seen', limit: 5 });
    expect(rows.some((r) => r.messageId === '3' && r.seen === 'false')).toBe(true);
  });
});
