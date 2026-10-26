// 自动回复一对一冷却，以及从 send-log.jsonl 回放每小时额度。
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-cooldown-'));

const sendMail = mock(async () => ({ messageId: '<cd@test>' }));
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

const { createIdentity } = await import('../src/lib/identities.ts');
const { sendRoute } = await import('../src/routes/send.ts');
const { config } = await import('../src/lib/config.ts');
const {
  checkAndReserveAutoReplyCooldown,
  checkAutoReplyCooldown,
  finalizeAutoReplyCooldownReservation,
  recordAutoReplyCooldown,
  releaseAutoReplyCooldownReservation,
  resetAutoReplyCooldownForTests,
  setAutoReplyCooldownCapForTests,
  setAutoReplyCooldownNowForTests,
  autoReplyCooldownSizeForTests,
  rebuildAutoReplyCooldownFromRecords,
} = await import('../src/lib/auto-reply-cooldown.ts');
const {
  checkSendLimit,
  rebuildSendLimitFromRecords,
  resetRateLimits,
  sendLimitCountForTests,
} = await import('../src/lib/ratelimit.ts');
const {
  appendSendLog,
  readSendLogRecordsForReplay,
  resetSendLogForTests,
  setSendLogNowForTests,
  setSendLogPersistHookForTests,
} = await import('../src/lib/send-log.ts');
const { replaySendGuardsFromLog } = await import('../src/lib/replay-send-guards.ts');

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('auth', { kind: 'admin' });
  await next();
});
app.route('/v1/send', sendRoute);

let seq = 0;
let clock = 0;

function nid(prefix: string): string {
  seq += 1;
  const local = `${prefix}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const created = createIdentity({ localpart: local });
  if (!created) throw new Error(`identity taken: ${local}`);
  return created.identity.address;
}

function post(from: string, to: string | string[], extra: Record<string, unknown> = {}) {
  return app.request('/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject: 'hello', text: 'body', ...extra }),
  });
}

async function withConfig(
  patch: { sendRateLimit?: number; autoReplyCooldownSec?: number },
  fn: () => Promise<void>,
): Promise<void> {
  const prevLimit = config.sendRateLimit;
  const prevCooldown = config.autoReplyCooldownSec;
  Object.assign(config, patch);
  try {
    await fn();
  } finally {
    Object.assign(config, { sendRateLimit: prevLimit, autoReplyCooldownSec: prevCooldown });
  }
}

function freezeAt(ms: number): void {
  clock = ms;
  setAutoReplyCooldownNowForTests(() => clock);
}

/**
 * SMTP 停在第一次 await 上，用来把两封请求叠在占位之后、完成之前。
 * succeed / fail 只结算一次，测试收尾再调也不会把已经失败的那封改成成功。
 */
function holdSmtp() {
  let calls = 0;
  const callWaiters: Array<() => void> = [];
  let settled = false;
  let settle!: (value: { messageId: string } | Error) => void;
  const gate = new Promise<{ messageId: string } | Error>((resolve) => {
    settle = resolve;
  });
  const finish = (value: { messageId: string } | Error) => {
    if (settled) return;
    settled = true;
    settle(value);
  };
  sendMail.mockImplementation(async () => {
    calls += 1;
    for (const wake of callWaiters.splice(0)) wake();
    const outcome = await gate;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const whenCalled = (n: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP 没有进入第 ${n} 次调用`)), 1_000);
      const arm = () => {
        if (calls < n) {
          callWaiters.push(arm);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      arm();
    });
  return {
    entered: whenCalled(1),
    whenCalled,
    succeed: () => finish({ messageId: '<held@test>' }),
    fail: (err: Error) => finish(err),
  };
}

beforeEach(() => {
  resetRateLimits();
  resetAutoReplyCooldownForTests();
  setSendLogNowForTests(null);
  setSendLogPersistHookForTests(null);
  sendMail.mockClear();
  sendMail.mockImplementation(async () => ({ messageId: '<cd@test>' }));
});

describe('POST /v1/send 自动回复冷却', () => {
  test('窗口内第二封 429，SMTP 只打一次，且没有 Retry-After 头', async () => {
    const from = nid('cdrep');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      freezeAt(1_800_000_000_000);
      expect((await post(from, 'pair@example.net', { autoReply: true })).status).toBe(200);
      sendMail.mockClear();
      const again = await post(from, 'pair@example.net', { autoReply: true });
      expect(again.status).toBe(429);
      expect(again.headers.get('Retry-After')).toBeNull();
      expect(await again.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 300 });
      expect(sendMail).not.toHaveBeenCalled();
      const page = await app.request(`/v1/send/history?address=${from}&limit=20`);
      const items = ((await page.json()) as { items: Array<{ error?: string }> }).items;
      expect(items.some((row) => row.error === 'auto_reply_cooldown')).toBe(false);
      expect(items.filter((row) => !row.error)).toHaveLength(1);
    });
  });

  test('窗口结束后可以再发，并重新起算', async () => {
    const from = nid('cdwin');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const start = 1_800_000_000_000;
      freezeAt(start);
      expect((await post(from, 'w@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 299_000);
      const still = await post(from, 'w@example.net', { autoReply: true });
      expect(still.status).toBe(429);
      expect(await still.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 1 });
      freezeAt(start + 300_000);
      sendMail.mockClear();
      expect((await post(from, 'w@example.net', { autoReply: true })).status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
      const rearmed = await post(from, 'w@example.net', { autoReply: true });
      expect(rearmed.status).toBe(429);
      expect(await rearmed.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 300 });
    });
  });

  test('普通邮件成功，且不把冷却延长', async () => {
    const from = nid('cdplain');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const start = 1_800_000_000_000;
      freezeAt(start);
      expect((await post(from, 'p@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 100_000);
      expect((await post(from, 'p@example.net')).status).toBe(200);
      expect((await post(from, 'p@example.net', { autoReply: false })).status).toBe(200);
      freezeAt(start + 300_000);
      sendMail.mockClear();
      expect((await post(from, 'p@example.net', { autoReply: true })).status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  test('换收件人或换发件身份不受影响', async () => {
    const a = nid('cda');
    const b = nid('cdb');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      expect((await post(a, 'r1@example.net', { autoReply: true })).status).toBe(200);
      expect((await post(a, 'r2@example.net', { autoReply: true })).status).toBe(200);
      expect((await post(b, 'r1@example.net', { autoReply: true })).status).toBe(200);
      const blocked = await post(a, 'r1@example.net', { autoReply: true });
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
    });
  });

  test('大小写算同一对，+tag 不算', async () => {
    const from = nid('cdcase');
    const [local, domain] = from.split('@') as [string, string];
    const mixedFrom = `${local.charAt(0).toUpperCase()}${local.slice(1)}@${domain.toUpperCase()}`;
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      expect((await post(mixedFrom, 'Recip@Example.com', { autoReply: true })).status).toBe(200);
      const folded = await post(from, 'recip@example.com', { autoReply: true });
      expect(folded.status).toBe(429);
      expect(((await folded.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      expect((await post(from, 'a+tag@example.com', { autoReply: true })).status).toBe(200);
      expect((await post(from, 'a@example.com', { autoReply: true })).status).toBe(200);
      const sameTag = await post(from, 'A+Tag@example.com', { autoReply: true });
      expect(sameTag.status).toBe(429);
      expect(((await sameTag.json()) as { error: string }).error).toBe('auto_reply_cooldown');
    });
  });

  test('多个收件人里有一个在冷却则整封 429，额度不变，retryAfter 取最大剩余', async () => {
    const from = nid('cdmulti');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const start = 1_800_000_000_000;
      freezeAt(start);
      expect((await post(from, 'a@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 200_000);
      expect((await post(from, 'b@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 250_000);
      const before = sendLimitCountForTests(from);
      sendMail.mockClear();
      const blocked = await post(
        from,
        ['a@example.net', 'b@example.net', 'fresh@example.net'],
        { autoReply: true },
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeNull();
      // a 剩 50 秒，b 剩 250 秒。
      expect(await blocked.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 250 });
      expect(sendMail).not.toHaveBeenCalled();
      expect(sendLimitCountForTests(from)).toBe(before);
    });
  });

  test('连不上 SMTP 不开始冷却；对端错误应答要开始', async () => {
    const from = nid('cdfail');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      sendMail.mockImplementation(async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNECTION' });
      });
      expect((await post(from, 'down@example.net', { autoReply: true })).status).toBe(502);
      expect((await post(from, 'down@example.net', { autoReply: true })).status).toBe(502);
      expect(sendMail).toHaveBeenCalledTimes(2);

      sendMail.mockClear();
      sendMail.mockImplementation(async () => {
        throw Object.assign(new Error('550 rejected'), { code: 'EENVELOPE', responseCode: 550 });
      });
      expect((await post(from, 'rej@example.net', { autoReply: true })).status).toBe(502);
      const cooled = await post(from, 'rej@example.net', { autoReply: true });
      expect(cooled.status).toBe(429);
      expect(((await cooled.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  test('审计追加失败时冷却仍然生效', async () => {
    const from = nid('cdlog');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      setSendLogPersistHookForTests(() => {
        throw new Error('ENOSPC');
      });
      try {
        const first = await post(from, 'disk@example.net', { autoReply: true });
        expect(first.status).toBe(200);
        sendMail.mockClear();
        const second = await post(from, 'disk@example.net', { autoReply: true });
        expect(second.status).toBe(429);
        expect(((await second.json()) as { error: string }).error).toBe('auto_reply_cooldown');
        expect(sendMail).not.toHaveBeenCalled();
      } finally {
        setSendLogPersistHookForTests(null);
      }
    });
  });

  test('AUTO_REPLY_COOLDOWN_SEC=0 不读也不写冷却表', async () => {
    const from = nid('cdzero');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const start = 1_800_000_000_000;
      freezeAt(start);
      expect((await post(from, 'z@example.net', { autoReply: true })).status).toBe(200);
      Object.assign(config, { autoReplyCooldownSec: 0 });
      freezeAt(start + 10_000);
      expect((await post(from, 'z@example.net', { autoReply: true })).status).toBe(200);
      Object.assign(config, { autoReplyCooldownSec: 300 });
      freezeAt(start + 300_000);
      expect((await post(from, 'z@example.net', { autoReply: true })).status).toBe(200);
      const blocked = await post(from, 'z@example.net', { autoReply: true });
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
    });
  });

  test('父代子发信时冷却键是子地址', async () => {
    const parent = createIdentity({ localpart: `cdp${(++seq).toString(36)}` });
    const child = createIdentity({
      localpart: `cdc${(++seq).toString(36)}`,
      parentIdentity: parent!.identity.address,
    });
    if (!parent || !child) throw new Error('parent/child identity missing');
    const parentApp = new Hono();
    parentApp.use('*', async (c, next) => {
      c.set('auth', { kind: 'identity', address: parent.identity.address });
      await next();
    });
    parentApp.route('/v1/send', sendRoute);
    const sendAs = (from: string) =>
      parentApp.request('/v1/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: 'child-pair@example.net',
          subject: 'hello',
          text: 'body',
          autoReply: true,
        }),
      });
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      expect((await sendAs(child.identity.address)).status).toBe(200);
      const blocked = await sendAs(child.identity.address.toUpperCase());
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      expect((await sendAs(parent.identity.address)).status).toBe(200);
    });
  });

  test('地址归一只做 trim 和小写', () => {
    recordAutoReplyCooldown(' Agent@X.com ', [' B+Tag@Y.com '], 300);
    expect(checkAutoReplyCooldown('agent@x.com', ['b+tag@y.com'], 300).blocked).toBe(true);
    expect(checkAutoReplyCooldown('agent@x.com', ['b@y.com'], 300).blocked).toBe(false);
    expect(checkAutoReplyCooldown('agent@x.com', ['b+tag@y.com'], 0).blocked).toBe(false);
  });

  test('过期项会丢掉；未过期项和占位在触顶时都不逐出', () => {
    const start = 1_800_000_000_000;
    freezeAt(start);
    setAutoReplyCooldownCapForTests(2);
    const first = checkAndReserveAutoReplyCooldown('s@x.com', ['a@e.com'], 10);
    const second = checkAndReserveAutoReplyCooldown('s@x.com', ['b@e.com'], 10);
    expect(first.reserved).toBe(true);
    expect(second.reserved).toBe(true);
    if (!first.reserved || !second.reserved) return;
    finalizeAutoReplyCooldownReservation(first.reservation, 10);
    finalizeAutoReplyCooldownReservation(second.reservation, 10);
    const third = checkAndReserveAutoReplyCooldown('s@x.com', ['c@e.com'], 10);
    expect(third.reserved).toBe(false);
    if (!third.reserved) expect(third.retryAfterSec).toBe(10);
    expect(autoReplyCooldownSizeForTests()).toBe(2);
    expect(checkAutoReplyCooldown('s@x.com', ['a@e.com'], 10).blocked).toBe(true);
    expect(checkAutoReplyCooldown('s@x.com', ['b@e.com'], 10).blocked).toBe(true);
    freezeAt(start + 10_000);
    expect(checkAutoReplyCooldown('s@x.com', ['a@e.com', 'b@e.com'], 10).blocked).toBe(false);
    expect(autoReplyCooldownSizeForTests()).toBe(0);
    const again = checkAndReserveAutoReplyCooldown('s@x.com', ['c@e.com'], 10);
    expect(again.reserved).toBe(true);
  });

  test('进行中的占位占满上限时不会被另一对挤掉', () => {
    const start = 1_800_000_000_000;
    freezeAt(start);
    setAutoReplyCooldownCapForTests(1);
    const pending = checkAndReserveAutoReplyCooldown('v@x.com', ['a@e.com'], 300);
    expect(pending.reserved).toBe(true);
    const extra = checkAndReserveAutoReplyCooldown('n@x.com', ['b@e.com'], 300);
    expect(extra.reserved).toBe(false);
    if (!extra.reserved) expect(extra.retryAfterSec).toBe(300);
    expect(checkAutoReplyCooldown('v@x.com', ['a@e.com'], 300).blocked).toBe(true);
    expect(autoReplyCooldownSizeForTests()).toBe(1);
    if (pending.reserved) releaseAutoReplyCooldownReservation(pending.reservation);
    expect(checkAutoReplyCooldown('v@x.com', ['a@e.com'], 300).blocked).toBe(false);
    expect(autoReplyCooldownSizeForTests()).toBe(0);
  });

  test('释放只删掉这张票，不碰之后写上的更长冷却', () => {
    const start = 1_800_000_000_000;
    freezeAt(start);
    const first = checkAndReserveAutoReplyCooldown('s@x.com', ['r@e.com'], 300);
    expect(first.reserved).toBe(true);
    if (!first.reserved) return;
    releaseAutoReplyCooldownReservation(first.reservation);
    const second = checkAndReserveAutoReplyCooldown('s@x.com', ['r@e.com'], 600);
    expect(second.reserved).toBe(true);
    if (!second.reserved) return;
    // 旧票晚到，不能把新占位清掉。
    releaseAutoReplyCooldownReservation(first.reservation);
    expect(checkAutoReplyCooldown('s@x.com', ['r@e.com'], 600).blocked).toBe(true);
    finalizeAutoReplyCooldownReservation(second.reservation, 600);
    releaseAutoReplyCooldownReservation(first.reservation);
    releaseAutoReplyCooldownReservation(second.reservation);
    const hit = checkAutoReplyCooldown('s@x.com', ['r@e.com'], 600);
    expect(hit.blocked).toBe(true);
    expect(hit.retryAfterSec).toBe(600);
  });

  test('两封并发打到同一对时只进一次 SMTP，另一封 429', async () => {
    const from = nid('cdcon');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      freezeAt(1_800_000_000_000);
      const hold = holdSmtp();
      const first = post(from, 'pair@example.net', { autoReply: true });
      try {
        await hold.entered;
        const second = await post(from, 'pair@example.net', { autoReply: true });
        expect(second.status).toBe(429);
        expect(second.headers.get('Retry-After')).toBeNull();
        expect(await second.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 300 });
        expect(sendMail).toHaveBeenCalledTimes(1);
        hold.succeed();
        expect((await first).status).toBe(200);
        expect(sendMail).toHaveBeenCalledTimes(1);
      } finally {
        hold.succeed();
        await Promise.resolve(first).catch(() => undefined);
      }
    });
  });

  test('收件人列表重叠时，没被占住的那个地址仍可发送', async () => {
    const from = nid('cdov');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const hold = holdSmtp();
      const first = post(from, ['a@example.net', 'b@example.net'], { autoReply: true });
      let onlyC: ReturnType<typeof post> | undefined;
      try {
        await hold.entered;
        const overlap = await post(from, ['b@example.net', 'c@example.net'], { autoReply: true });
        expect(overlap.status).toBe(429);
        expect(((await overlap.json()) as { error: string }).error).toBe('auto_reply_cooldown');
        expect(sendMail).toHaveBeenCalledTimes(1);
        onlyC = post(from, 'c@example.net', { autoReply: true });
        await hold.whenCalled(2);
        expect(sendMail).toHaveBeenCalledTimes(2);
        hold.succeed();
        expect((await first).status).toBe(200);
        expect((await onlyC).status).toBe(200);
      } finally {
        hold.succeed();
        await Promise.resolve(first).catch(() => undefined);
        await Promise.resolve(onlyC).catch(() => undefined);
      }
    });
  });

  test('连接失败会放开占位；进行中的那封仍挡住同一对', async () => {
    const from = nid('cdhold');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const hold = holdSmtp();
      const first = post(from, 'down@example.net', { autoReply: true });
      try {
        await hold.entered;
        const second = await post(from, 'down@example.net', { autoReply: true });
        expect(second.status).toBe(429);
        expect(((await second.json()) as { retryAfterSec: number }).retryAfterSec).toBeGreaterThanOrEqual(1);
        expect(sendMail).toHaveBeenCalledTimes(1);
        hold.fail(Object.assign(new Error('connection refused'), { code: 'ECONNECTION' }));
        expect((await first).status).toBe(502);
        expect(autoReplyCooldownSizeForTests()).toBe(0);
        sendMail.mockImplementation(async () => ({ messageId: '<cd@test>' }));
        expect((await post(from, 'down@example.net', { autoReply: true })).status).toBe(200);
        expect(sendMail).toHaveBeenCalledTimes(2);
      } finally {
        hold.succeed();
        await Promise.resolve(first).catch(() => undefined);
      }
    });
  });

  test('每小时额度拒绝会放开占位，额度恢复后同一对可以发', async () => {
    const from = nid('cdrel');
    await withConfig({ sendRateLimit: 1, autoReplyCooldownSec: 300 }, async () => {
      expect((await post(from, 'used@example.net')).status).toBe(200);
      sendMail.mockClear();
      const limited = await post(from, 'pair@example.net', { autoReply: true });
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: string }).error).toBe('rate_limited');
      expect(sendMail).not.toHaveBeenCalled();
      expect(autoReplyCooldownSizeForTests()).toBe(0);
      resetRateLimits();
      expect((await post(from, 'pair@example.net', { autoReply: true })).status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
    });
  });

  test('别的身份把表打满时，不会清掉已有冷却，也不占额度', async () => {
    const victim = nid('cdvic');
    const noisy = nid('cdnoisy');
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      const start = 1_800_000_000_000;
      setAutoReplyCooldownCapForTests(2);
      freezeAt(start);
      expect((await post(victim, 'keep@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 1_000);
      expect((await post(noisy, 'n1@example.net', { autoReply: true })).status).toBe(200);
      freezeAt(start + 2_000);
      const before = sendLimitCountForTests(noisy);
      sendMail.mockClear();
      const rejected = await post(noisy, 'n2@example.net', { autoReply: true });
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get('Retry-After')).toBeNull();
      // keep 还剩 298 秒，比 n1 更早到期。
      expect(await rejected.json()).toEqual({ error: 'auto_reply_cooldown', retryAfterSec: 298 });
      expect(sendMail).not.toHaveBeenCalled();
      expect(sendLimitCountForTests(noisy)).toBe(before);
      const still = await post(victim, 'keep@example.net', { autoReply: true });
      expect(still.status).toBe(429);
      expect(((await still.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      const noisyStill = await post(noisy, 'n1@example.net', { autoReply: true });
      expect(noisyStill.status).toBe(429);
      expect(sendMail).not.toHaveBeenCalled();
    });
  });
});

describe('启动回放', () => {
  test('最近的 queued autoReply 会拒绝；更早、失败、rate_limited、非自动回复不会', async () => {
    resetSendLogForTests();
    const from = nid('cdrv');
    const now = Date.now();
    try {
      setSendLogNowForTests(() => now - 1_000);
      await appendSendLog({
        from,
        to: ['Recent@Example.net'],
        subject: 'recent',
        result: 'queued',
        source: 'api',
        autoReply: true,
      });
      setSendLogNowForTests(() => now - 400_000);
      await appendSendLog({
        from,
        to: ['old@example.net'],
        subject: 'old',
        result: 'queued',
        source: 'api',
        autoReply: true,
      });
      setSendLogNowForTests(() => now - 1_000);
      await appendSendLog({
        from,
        to: ['failed@example.net'],
        subject: 'failed',
        result: 'failed',
        error: 'smtp_error',
        source: 'api',
        autoReply: true,
      });
      await appendSendLog({
        from,
        to: ['limited@example.net'],
        subject: 'limited',
        result: 'failed',
        error: 'rate_limited',
        source: 'api',
        autoReply: true,
      });
      await appendSendLog({
        from,
        to: ['plain@example.net'],
        subject: 'plain',
        result: 'queued',
        source: 'api',
      });
      await appendSendLog({
        from,
        to: ['a+tag@example.net'],
        subject: 'tag',
        result: 'queued',
        source: 'api',
        autoReply: true,
      });
    } finally {
      setSendLogNowForTests(null);
    }
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 300 }, async () => {
      resetAutoReplyCooldownForTests();
      rebuildAutoReplyCooldownFromRecords(readSendLogRecordsForReplay(), 300, now);
      sendMail.mockClear();
      const blocked = await post(from, 'RECENT@example.net', { autoReply: true });
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      expect(sendMail).not.toHaveBeenCalled();
      const tag = await post(from, 'A+Tag@example.net', { autoReply: true });
      expect(tag.status).toBe(429);
      expect(((await tag.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      for (const to of ['old@example.net', 'failed@example.net', 'limited@example.net', 'plain@example.net', 'a@example.net']) {
        expect((await post(from, to, { autoReply: true })).status).toBe(200);
      }
    });
  });

  test('每小时额度按日志里的 queued 回放，下一封是 rate_limited', async () => {
    resetSendLogForTests();
    const from = nid('cdhr');
    const wall = Date.now();
    await withConfig({ sendRateLimit: 1, autoReplyCooldownSec: 300 }, async () => {
      try {
        setSendLogNowForTests(() => wall - 2 * 3_600_000);
        await appendSendLog({
          from,
          to: ['old@example.net'],
          subject: 'old',
          result: 'queued',
          source: 'api',
        });
        setSendLogNowForTests(() => wall - 60_000);
        await appendSendLog({
          from,
          to: ['bad@example.net'],
          subject: 'bad',
          result: 'failed',
          error: 'smtp_error',
          source: 'api',
          autoReply: true,
        });
        await appendSendLog({
          from,
          to: ['rl@example.net'],
          subject: 'rl',
          result: 'failed',
          error: 'rate_limited',
          source: 'api',
          autoReply: true,
        });
      } finally {
        setSendLogNowForTests(null);
      }
      resetRateLimits();
      rebuildSendLimitFromRecords(readSendLogRecordsForReplay(), Date.now());
      expect(sendLimitCountForTests(from)).toBe(0);
      sendMail.mockClear();
      expect((await post(from, 'fresh@example.net')).status).toBe(200);
      expect(sendMail).toHaveBeenCalledTimes(1);
      resetRateLimits();
      rebuildSendLimitFromRecords(readSendLogRecordsForReplay(), Date.now());
      expect(sendLimitCountForTests(from)).toBe(1);
      sendMail.mockClear();
      const limited = await post(from, 'another@example.net');
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: string }).error).toBe('rate_limited');
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  test('第 21 封自动回复是 rate_limited，不是冷却', async () => {
    const from = nid('cd21');
    await withConfig({ sendRateLimit: 20, autoReplyCooldownSec: 300 }, async () => {
      sendMail.mockClear();
      for (let i = 0; i < 20; i++) {
        expect((await post(from, `r${i}@example.net`, { autoReply: true })).status).toBe(200);
      }
      const last = await post(from, 'r20@example.net', { autoReply: true });
      expect(last.status).toBe(429);
      expect(((await last.json()) as { error: string }).error).toBe('rate_limited');
      expect(sendMail).toHaveBeenCalledTimes(20);
    });
  });

  test('SEND_RATE_LIMIT=0 时回放后的额度戳不挡发信', async () => {
    const from = nid('cdunl');
    await withConfig({ sendRateLimit: 0, autoReplyCooldownSec: 300 }, async () => {
      const sentAt = new Date().toISOString();
      rebuildSendLimitFromRecords(
        Array.from({ length: 5 }, () => ({ from, result: 'queued', sentAt })),
        Date.now(),
      );
      expect((await post(from, 'u1@example.net')).status).toBe(200);
      expect((await post(from, 'u2@example.net')).status).toBe(200);
    });
  });

  test('读日志失败只告警，不清掉已经在内存里的冷却和额度', () => {
    recordAutoReplyCooldown('keep@x.com', ['keep@e.com'], 300);
    checkSendLimit('keep@x.com', 20);
    expect(checkAutoReplyCooldown('keep@x.com', ['keep@e.com'], 300).blocked).toBe(true);
    expect(sendLimitCountForTests('keep@x.com')).toBe(1);
    const seen: string[] = [];
    const errors: string[] = [];
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = (...args: unknown[]) => {
      seen.push(args.map((item) => String(item)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map((item) => String(item)).join(' '));
    };
    try {
      expect(() =>
        replaySendGuardsFromLog(Date.now(), () => {
          throw new Error('disk down');
        }),
      ).not.toThrow();
    } finally {
      console.warn = origWarn;
      console.error = origError;
    }
    expect(seen.some((line) => line.includes('send-log replay skipped'))).toBe(true);
    expect(errors).toEqual([]);
    expect(checkAutoReplyCooldown('keep@x.com', ['keep@e.com'], 300).blocked).toBe(true);
    expect(sendLimitCountForTests('keep@x.com')).toBe(1);
    expect(() => replaySendGuardsFromLog(Date.now(), () => [])).not.toThrow();
  });

  test('回放忽略未来的 sentAt，窗口边界恰好到期的不留', () => {
    const now = 1_800_000_000_000;
    freezeAt(now);
    rebuildAutoReplyCooldownFromRecords(
      [
        {
          from: 's@x.com',
          to: ['edge@e.com'],
          result: 'queued',
          sentAt: new Date(now - 300_000).toISOString(),
          autoReply: true,
        },
        {
          from: 's@x.com',
          to: ['in@e.com'],
          result: 'queued',
          sentAt: new Date(now - 300_000 + 1).toISOString(),
          autoReply: true,
        },
        {
          from: 's@x.com',
          to: ['now@e.com'],
          result: 'queued',
          sentAt: new Date(now).toISOString(),
          autoReply: true,
        },
        {
          from: 's@x.com',
          to: ['future@e.com'],
          result: 'queued',
          sentAt: new Date(now + 1).toISOString(),
          autoReply: true,
        },
      ],
      300,
      now,
    );
    expect(checkAutoReplyCooldown('s@x.com', ['edge@e.com'], 300).blocked).toBe(false);
    expect(checkAutoReplyCooldown('s@x.com', ['in@e.com'], 300).blocked).toBe(true);
    expect(checkAutoReplyCooldown('s@x.com', ['now@e.com'], 300).blocked).toBe(true);
    expect(checkAutoReplyCooldown('s@x.com', ['future@e.com'], 300).blocked).toBe(false);
    expect(autoReplyCooldownSizeForTests()).toBe(2);
  });

  test('回放超过上限时保留最晚到期的对', () => {
    const now = 1_800_000_000_000;
    freezeAt(now);
    setAutoReplyCooldownCapForTests(2);
    rebuildAutoReplyCooldownFromRecords(
      [
        {
          from: 's@x.com',
          to: ['early@e.com'],
          result: 'queued',
          sentAt: new Date(now - 250_000).toISOString(),
          autoReply: true,
        },
        {
          from: 's@x.com',
          to: ['mid@e.com'],
          result: 'queued',
          sentAt: new Date(now - 100_000).toISOString(),
          autoReply: true,
        },
        {
          from: 'other@x.com',
          to: ['late@e.com'],
          result: 'queued',
          sentAt: new Date(now - 10_000).toISOString(),
          autoReply: true,
        },
      ],
      300,
      now,
    );
    expect(autoReplyCooldownSizeForTests()).toBe(2);
    expect(checkAutoReplyCooldown('s@x.com', ['early@e.com'], 300).blocked).toBe(false);
    expect(checkAutoReplyCooldown('s@x.com', ['mid@e.com'], 300).blocked).toBe(true);
    expect(checkAutoReplyCooldown('other@x.com', ['late@e.com'], 300).blocked).toBe(true);
  });

  test('replaySendGuardsFromLog 从发送日志灌冷却和每小时额度', async () => {
    resetSendLogForTests();
    const from = nid('cdexec');
    const now = Date.now();
    try {
      setSendLogNowForTests(() => now - 30_000);
      await appendSendLog({
        from,
        to: ['replay@example.net'],
        subject: 'replay',
        result: 'queued',
        source: 'api',
        autoReply: true,
      });
    } finally {
      setSendLogNowForTests(null);
    }
    await withConfig({ sendRateLimit: 1, autoReplyCooldownSec: 300 }, async () => {
      resetRateLimits();
      resetAutoReplyCooldownForTests();
      replaySendGuardsFromLog(now);
      expect(sendLimitCountForTests(from, now)).toBe(1);
      sendMail.mockClear();
      const blocked = await post(from, 'replay@example.net', { autoReply: true });
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: string }).error).toBe('auto_reply_cooldown');
      const limited = await post(from, 'other-replay@example.net', { autoReply: true });
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: string }).error).toBe('rate_limited');
      expect(sendMail).not.toHaveBeenCalled();
    });
  });

  test('冷却关闭时回放不灌表', async () => {
    resetSendLogForTests();
    const from = nid('cdskip');
    await appendSendLog({
      from,
      to: ['skip@example.net'],
      subject: 'skip',
      result: 'queued',
      source: 'api',
      autoReply: true,
    });
    await withConfig({ sendRateLimit: 50, autoReplyCooldownSec: 0 }, async () => {
      replaySendGuardsFromLog(Date.now());
      Object.assign(config, { autoReplyCooldownSec: 300 });
      expect((await post(from, 'skip@example.net', { autoReply: true })).status).toBe(200);
    });
  });

  test('入口只在 import.meta.main 时回放一次', async () => {
    const src = await Bun.file(new URL('../src/main.ts', import.meta.url)).text();
    expect(src).toContain('if (import.meta.main)');
    expect(src).toContain('replaySendGuardsFromLog()');
  });
});

describe('文档与 compose 透传', () => {
  test('AUTO_REPLY_COOLDOWN_SEC 跟在 SEND_RATE_LIMIT 旁边', () => {
    const root = join(import.meta.dir, '../../..');
    for (const file of ['compose.yaml', 'compose.api-only.yaml']) {
      const text = readFileSync(join(root, file), 'utf8');
      expect(text).toMatch(
        /AUTO_REPLY_COOLDOWN_SEC:\s*\$\{AUTO_REPLY_COOLDOWN_SEC:-300\}/,
      );
    }
    for (const file of ['.env.example', '.env.api-only.example']) {
      expect(readFileSync(join(root, file), 'utf8')).toContain('AUTO_REPLY_COOLDOWN_SEC');
    }
    const apiDoc = readFileSync(join(root, 'docs/api.md'), 'utf8');
    expect(apiDoc).toContain('auto_reply_cooldown');
    expect(apiDoc).toContain('retryAfterSec');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('auto_reply_cooldown');
  });
});
