// 可选 inReplyTo / references。假 stream transport，不连真实 SMTP。
// mock.module 是进程级的。别的文件会先 mock smtp.ts，只 mock nodemailer 时路由根本走不到这里。
// 和 send.test.ts 一样替换 smtp.sendMail；查询串再加载真实 sendMail，头仍由 nodemailer 序列化。
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.SEND_RATE_LIMIT = '100';
process.env.TASK_SIGNING_SECRET = 'threading-stamp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-thread-'));

type CapturedMail = {
  subject?: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
};

let smtpCalls = 0;
let lastMime = '';
let lastOpts: CapturedMail | null = null;

// 查询串绕过本文件以及更早文件对 nodemailer 的 mock，拿到真正的 createTransport。
const { default: nodemailerReal } = await import('nodemailer?send-threading-real' as 'nodemailer');
const realCreate = nodemailerReal.createTransport.bind(nodemailerReal);
mock.module('nodemailer', () => ({
  default: {
    createTransport() {
      const transport = realCreate({ streamTransport: true, buffer: true, newline: 'unix' });
      const send = transport.sendMail.bind(transport);
      transport.sendMail = (async (opts: CapturedMail) => {
        lastOpts = opts;
        const info = await send(opts);
        const message = (info as { message?: Uint8Array }).message;
        lastMime = Buffer.from(message ?? []).toString('utf8');
        return info;
      }) as typeof transport.sendMail;
      return transport;
    },
  },
}));

// 查询串绕过 smtp mock，真实 sendMail 会走到上面的流式替身。
const { sendMail: realSendMail } = await import(
  '../src/lib/smtp.ts?send-threading-real' as '../src/lib/smtp.ts',
);
const sendMail = mock(async (input: Parameters<typeof realSendMail>[0]) => {
  smtpCalls += 1;
  return realSendMail(input);
});
mock.module('../src/lib/smtp.ts', () => ({ sendMail }));

const { createIdentity } = await import('../src/lib/identities.ts');
const { sendRoute } = await import('../src/routes/send.ts');
const { config } = await import('../src/lib/config.ts');
const { resetRateLimits } = await import('../src/lib/ratelimit.ts');
const { resetAutoReplyCooldownForTests } = await import('../src/lib/auto-reply-cooldown.ts');

// 全套件里 config 由最先 import 的文件冻住，SEND_RATE_LIMIT 可能是 1。
// 本文件的用例会连发两封，测完把原值还回去。
const sendRateLimitBeforeFile = config.sendRateLimit;
Object.assign(config, { sendRateLimit: 100 });
afterAll(() => {
  Object.assign(config, { sendRateLimit: sendRateLimitBeforeFile });
});

const FROM = 'thread@test.example';
createIdentity({ localpart: 'thread' });

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('auth', { kind: 'admin' });
  await next();
});
app.route('/v1/send', sendRoute);

/**
 * 长度恰好为 n 的尖括号 msg-id。
 * tag 写进左侧，用来在 8000 字符拼接里做出互不相同、且各自不超过 250 的 id。
 */
function msgIdOfLength(n: number, tag = 0): string {
  const inner = n - 2;
  const rightLen = Math.max(1, Math.floor((inner - 1) / 2));
  const leftLen = inner - 1 - rightLen;
  const mark = tag.toString(36);
  if (leftLen < mark.length || rightLen < 1) throw new Error(`msg-id 长度 ${n} 放不下标记`);
  return `<${mark}${'a'.repeat(leftLen - mark.length)}@${'b'.repeat(rightLen)}>`;
}

/** 若干条合法 msg-id，单条不超过 250，空格拼接后长度恰好为 total。 */
function referencesJoiningTo(total: number): string[] {
  const ids: string[] = [];
  let left = total;
  let tag = 0;
  while (left > 0) {
    const moreAfter = left > 250;
    // 后面还有一条时，留出一个空格和最短 id `<a@b>`（5）。
    const len = moreAfter ? Math.min(250, left - 1 - 5) : left;
    if (len < 5 || len > 250) throw new Error(`无法填满 ${total}，剩下 ${left}`);
    ids.push(msgIdOfLength(len, tag));
    left -= len;
    tag += 1;
    if (left > 0) left -= 1;
  }
  return ids;
}

function post(extra: Record<string, unknown> = {}, subject = 'hello') {
  return app.request('/v1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: 'recipient@example.net',
      subject,
      text: 'body',
      ...extra,
    }),
  });
}

/** 取出某一头及其折叠续行。没有该头时返回 undefined。 */
function headerBlock(mime: string, name: string): string[] | undefined {
  const lines = mime.split(/\r?\n/);
  const prefix = `${name.toLowerCase()}:`;
  const start = lines.findIndex((line) => line.toLowerCase().startsWith(prefix));
  if (start < 0) return undefined;
  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) break;
    if (/^[ \t]/.test(line)) {
      block.push(line);
      continue;
    }
    break;
  }
  return block;
}

/** 按 RFC 5322 展开：去掉 CRLF 后紧跟的折行，保留那个空白。 */
function unfold(block: string[]): string {
  return block.join('\n').replace(/\r?\n([ \t])/g, '$1');
}

beforeEach(() => {
  resetRateLimits();
  resetAutoReplyCooldownForTests();
  Object.assign(config, { sendRateLimit: 100 });
  smtpCalls = 0;
  lastMime = '';
  lastOpts = null;
});

describe('POST /v1/send 线程头', () => {
  test('省略 inReplyTo 与 references 时不写这两条头，主题不变', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { queued?: boolean; messageId?: string };
    expect(body.queued).toBe(true);
    expect(body.messageId).toMatch(/^<[^<>\s]+@[^<>\s]+>$/);
    expect(smtpCalls).toBe(1);
    expect(lastOpts?.subject).toBe('hello');
    expect(lastOpts?.inReplyTo).toBeUndefined();
    expect(lastOpts?.references).toBeUndefined();
    expect(headerBlock(lastMime, 'in-reply-to')).toBeUndefined();
    expect(headerBlock(lastMime, 'references')).toBeUndefined();
    expect(unfold(headerBlock(lastMime, 'subject')!)).toBe('Subject: hello');
    expect(lastMime).not.toContain('Subject: Re:');

    const page = await app.request(`/v1/send/history?address=${FROM}&limit=20`);
    const items = ((await page.json()) as { items: Array<Record<string, unknown>> }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      expect(row).not.toHaveProperty('inReplyTo');
      expect(row).not.toHaveProperty('references');
    }
  });

  test('只给 inReplyTo 时两条头都是这一条，且不自动加 Re:', async () => {
    const inReplyTo = '<parent-01@example.com>';
    const response = await post({ inReplyTo }, 'keep-subject');
    expect(response.status).toBe(200);
    expect(smtpCalls).toBe(1);
    expect(lastOpts?.subject).toBe('keep-subject');
    expect(lastOpts?.inReplyTo).toBe(inReplyTo);
    expect(lastOpts?.references).toEqual([inReplyTo]);
    expect(lastOpts?.headers?.['Auto-Submitted']).toBeUndefined();
    expect(unfold(headerBlock(lastMime, 'in-reply-to')!)).toBe(`In-Reply-To: ${inReplyTo}`);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${inReplyTo}`);
    expect(lastMime).not.toContain('<<');
    expect(unfold(headerBlock(lastMime, 'subject')!)).toBe('Subject: keep-subject');
    expect(headerBlock(lastMime, 'auto-submitted')).toBeUndefined();
  });

  test('references 去重保序，inReplyTo 不是最后一项时追加到末尾', async () => {
    const a = '<a@example.com>';
    const b = '<b@example.com>';
    const c = '<c@example.com>';
    const response = await post({ inReplyTo: c, references: [a, b, a] });
    expect(response.status).toBe(200);
    expect(lastOpts?.references).toEqual([a, b, c]);
    expect(unfold(headerBlock(lastMime, 'in-reply-to')!)).toBe(`In-Reply-To: ${c}`);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${a} ${b} ${c}`);
    expect(lastMime).not.toContain('<<');
  });

  test('inReplyTo 已在末尾则不重复；出现在中间则再追加一次', async () => {
    const a = '<a@example.com>';
    const c = '<c@example.com>';
    expect((await post({ inReplyTo: c, references: [a, c, c] })).status).toBe(200);
    expect(lastOpts?.references).toEqual([a, c]);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${a} ${c}`);

    smtpCalls = 0;
    expect((await post({ inReplyTo: c, references: [c, a] })).status).toBe(200);
    expect(lastOpts?.references).toEqual([c, a, c]);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${c} ${a} ${c}`);
  });

  test('长 References 按空白折行，展开后仍是单层尖括号', async () => {
    const inReplyTo = '<parent-fold@example.com>';
    const references = Array.from({ length: 30 }, (_, i) => `<ref-${String(i).padStart(2, '0')}@example.com>`);
    const expected = [...references, inReplyTo];
    expect((await post({ inReplyTo, references })).status).toBe(200);
    expect(lastOpts?.references).toEqual(expected);
    const block = headerBlock(lastMime, 'references')!;
    expect(block.length).toBeGreaterThan(1);
    for (const line of block.slice(1)) expect(line).toMatch(/^[ \t]/);
    for (const line of block) expect(line.length).toBeLessThanOrEqual(998);
    expect(unfold(block)).toBe(`References: ${expected.join(' ')}`);
    expect(unfold(block)).not.toContain('<<');
  });

  test('点分原子和字面量右侧可以通过，并原样写入头', async () => {
    const inReplyTo = '<left@[127.0.0.1]>';
    const earlier = '<a.b+tag@ex-ample.com>';
    expect((await post({ inReplyTo, references: [earlier] })).status).toBe(200);
    expect(smtpCalls).toBe(1);
    expect(lastOpts?.inReplyTo).toBe(inReplyTo);
    expect(lastOpts?.references).toEqual([earlier, inReplyTo]);
    expect(unfold(headerBlock(lastMime, 'in-reply-to')!)).toBe(`In-Reply-To: ${inReplyTo}`);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${earlier} ${inReplyTo}`);
    expect(lastMime).not.toContain('<<');
  });

  test('250 字符的 msg-id 不会被多包一层尖括号', async () => {
    const inReplyTo = msgIdOfLength(250);
    expect(inReplyTo).toHaveLength(250);
    expect((await post({ inReplyTo })).status).toBe(200);
    expect(lastOpts?.inReplyTo).toBe(inReplyTo);
    expect(unfold(headerBlock(lastMime, 'in-reply-to')!)).toBe(`In-Reply-To: ${inReplyTo}`);
    expect(unfold(headerBlock(lastMime, 'references')!)).toBe(`References: ${inReplyTo}`);
  });

  test('拼接长度恰好 8000 可以发送', async () => {
    const references = referencesJoiningTo(8000);
    expect(references.join(' ')).toHaveLength(8000);
    expect(references.every((id) => id.length <= 250)).toBe(true);
    const inReplyTo = '<tail@example.com>';
    expect((await post({ inReplyTo, references })).status).toBe(200);
    expect(lastOpts?.references).toEqual([...references, inReplyTo]);
  });

  test('非法格式是 400 invalid_request，并且不打 SMTP', async () => {
    const longId = msgIdOfLength(251);
    expect(longId).toHaveLength(251);
    const tooWide = referencesJoiningTo(8001);
    expect(tooWide.join(' ').length).toBe(8001);
    expect(tooWide.every((id) => id.length <= 250)).toBe(true);
    const tooMany = Array.from({ length: 51 }, (_, i) => `<n${i}@example.com>`);
    const cases: Array<Record<string, unknown>> = [
      { inReplyTo: 'parent@example.com' },
      { inReplyTo: '<paren t@example.com>' },
      { inReplyTo: ' <parent@example.com>' },
      { inReplyTo: '<parent@example.com>\r\nBcc: evil@example.net' },
      { inReplyTo: '<a@b@example.com>' },
      { inReplyTo: '<a,b@example.com>' },
      { inReplyTo: '<"ab"@example.com>' },
      { inReplyTo: '<a\\b@example.com>' },
      { inReplyTo: '<a..b@example.com>' },
      { inReplyTo: '<.a@example.com>' },
      { inReplyTo: '<a.@example.com>' },
      { inReplyTo: '<a@.example.com>' },
      { inReplyTo: '<a@example.com.>' },
      { inReplyTo: longId },
      { inReplyTo: '<a@b\u0001c.com>' },
      { inReplyTo: '<a@例子.com>' },
      { inReplyTo: '<ok@example.com>', references: tooMany },
      { inReplyTo: '<ok@example.com>', references: tooWide },
      { inReplyTo: '<ok@example.com>', references: [] },
      { references: ['<only-refs@example.com>'] },
      { headers: { 'In-Reply-To': '<x@example.com>' } },
    ];
    for (const extra of cases) {
      smtpCalls = 0;
      const response = await post(extra);
      expect(response.status, JSON.stringify(extra)).toBe(400);
      const body = (await response.json()) as { error?: string; details?: unknown[] };
      expect(body.error).toBe('invalid_request');
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details!.length).toBeGreaterThan(0);
      expect(smtpCalls).toBe(0);
    }
  });

  test('线程参数不进入冷却，也不绕过冷却或每小时额度', async () => {
    const inReplyTo = '<cool@example.com>';
    expect((await post({ inReplyTo })).status).toBe(200);
    expect((await post({ inReplyTo })).status).toBe(200);
    expect(smtpCalls).toBe(2);

    expect((await post({ autoReply: true, inReplyTo })).status).toBe(200);
    expect(lastOpts?.inReplyTo).toBe(inReplyTo);
    expect(lastOpts?.headers?.['Auto-Submitted']).toBe('auto-replied');
    expect(unfold(headerBlock(lastMime, 'auto-submitted')!)).toBe('Auto-Submitted: auto-replied');
    expect(unfold(headerBlock(lastMime, 'in-reply-to')!)).toBe(`In-Reply-To: ${inReplyTo}`);

    const cooled = await post({ autoReply: true, inReplyTo: '<other@example.com>' });
    expect(cooled.status).toBe(429);
    expect(((await cooled.json()) as { error?: string }).error).toBe('auto_reply_cooldown');
    expect(smtpCalls).toBe(3);

    const prev = config.sendRateLimit;
    Object.assign(config, { sendRateLimit: 1 });
    try {
      resetRateLimits();
      resetAutoReplyCooldownForTests();
      smtpCalls = 0;
      expect((await post({ inReplyTo })).status).toBe(200);
      const limited = await post({ inReplyTo });
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error?: string }).error).toBe('rate_limited');
      expect(smtpCalls).toBe(1);
    } finally {
      Object.assign(config, { sendRateLimit: prev });
    }
  });
});
