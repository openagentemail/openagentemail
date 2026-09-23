/**
 * #344 对象面：describeFailureStack — 保 stack + 有界 + 脱敏 + 永不抛。
 * 设计：materials/obj-face-344/r0.md（四裁点已批）。
 */
import { describe, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// redact → config 进程级校验；须在动态 import 前写入
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-344-'));

const {
  describeFailure,
  describeFailureStack,
  escapeLine,
  escapeBlock,
  STACK_MAX,
} = await import('../src/lib/redact.ts');

/** 截断标记长度（脱敏后追加） */
const TRUNC_MARK = '…[truncated]';

describe('describeFailureStack · #344', () => {
  // ① 密钥出现在 message 与各 stack frame ⇒ 全部被红
  test('① message 与各 stack frame 中的密钥均被红', () => {
    const secret = 'frameSecretXYZ';
    const err = new Error(`top ${secret}`);
    err.stack = [
      `Error: top ${secret}`,
      `    at frameA (/app/a.ts:1:1) ${secret}`,
      `    at frameB (/app/b.ts:2:2) leak=${secret}`,
      `    at frameC (/app/c.ts:3:3)`,
    ].join('\n');
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
    expect(out.split('[redacted]').length - 1).toBeGreaterThanOrEqual(3);
    expect(out).toContain('\n');
  });

  // ② 巨大 stack ⇒ 有界（≤ STACK_MAX + 标记长度）
  test('② 巨大 stack 有界 ≤ STACK_MAX + 标记', () => {
    const err = new Error('huge');
    err.stack = 'Error: huge\n' + 'x'.repeat(STACK_MAX + 50_000);
    const out = describeFailureStack(err, []);
    expect(out.length).toBeLessThanOrEqual(STACK_MAX + TRUNC_MARK.length);
    expect(out.endsWith(TRUNC_MARK)).toBe(true);
    expect(STACK_MAX).toBe(8192);
  });

  // ③ 截断边界处半截密钥不泄（J4）
  test('③ 截断点恰落在密钥真前缀 ⇒ 输出不含该前缀', () => {
    const secret = 'secret1234567890';
    // 构造：前缀填满 STACK_MAX - 前缀长，使截断恰停在密钥真前缀「secret」
    const prefix = 's'.repeat(STACK_MAX - 6); // 6 = 'secret'.length（真前缀）
    const err = new Error('bound');
    err.stack = prefix + secret; // 总长 > STACK_MAX；有界后尾 = 'secret'
    expect(err.stack.slice(0, STACK_MAX).endsWith('secret')).toBe(true);
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain('secret');
    expect(out).not.toContain(secret.slice(0, 6));
    expect(out.endsWith(TRUNC_MARK)).toBe(true);
  });

  // ④ 病态：会抛的 stack getter / revoked Proxy ⇒ 永不抛并给哨兵
  test('④ 会抛的 stack getter / revoked Proxy ⇒ 永不抛 + 哨兵', () => {
    const boom = new Error('ok-message');
    Object.defineProperty(boom, 'stack', {
      get() {
        throw new Error('stack accessor boom');
      },
      configurable: true,
    });
    expect(() => describeFailureStack(boom, [])).not.toThrow();
    // stack 不可读 ⇒ 退化为 describeFailure（message 可用）
    expect(describeFailureStack(boom, [])).toBe('ok-message');

    const target = { message: 'x' };
    const proxy = new Proxy(target, {
      get() {
        throw new Error('revoked');
      },
      // instanceof Error 可能走 getPrototypeOf；一并炸掉
      getPrototypeOf() {
        throw new Error('revoked-proto');
      },
    });
    expect(() => describeFailureStack(proxy, [])).not.toThrow();
    const out = describeFailureStack(proxy, []);
    // 极端不可读 ⇒ [unreadable] 或类型化哨兵
    expect(out === '[unreadable]' || out.startsWith('[non-error:')).toBe(true);
  });

  // ⑤ 多行保留：\n 不被转义；\r/\t 保留字面
  test('⑤ 多行保留：\\n/\\r/\\t 字面不被转义', () => {
    const err = new Error('m');
    err.stack = 'Error: m\n\tat a\r\n\tat b\tindent';
    const out = describeFailureStack(err, []);
    expect(out).toContain('\n');
    expect(out).toContain('\r');
    expect(out).toContain('\t');
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('\\r');
    expect(out).not.toContain('\\t');
  });

  // ⑥ 非换行控制符 / DEL+C1 / LS·PS / bidi 照转义
  test('⑥ 非换行控制符 / DEL+C1 / U+2028·2029 / bidi 照转义', () => {
    const err = new Error('ctl');
    err.stack =
      'Error: ctl\n' +
      `pre\u0001mid\u007f\u009b\u2028\u2029\u202e\u2066post`;
    const out = describeFailureStack(err, []);
    expect(out).toContain('\\u0001');
    expect(out).toContain('\\u007f');
    expect(out).toContain('\\u009b');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u2066');
    // 同源：escapeBlock 与 escapeLine 对非 LF/CR/TAB 一致
    const sample = 'a\u0001b\u202Ec';
    expect(escapeBlock(sample)).toBe(escapeLine(sample).replace(/\\n/g, '\n'));
    expect(escapeBlock('a\nb\tc')).toBe('a\nb\tc');
    expect(escapeLine('a\nb\tc')).toBe('a\\nb\\tc');
  });

  // ⑦ 非 Error 输入 ⇒ 退化为 describeFailure 单行文本
  test('⑦ 非 Error 输入退化为 describeFailure 类型化哨兵', () => {
    expect(describeFailureStack(undefined, [])).toBe(describeFailure(undefined, []));
    expect(describeFailureStack(null, [])).toBe('[non-error:null]');
    expect(describeFailureStack(42, [])).toBe('[non-error:number:42]');
    expect(describeFailureStack('str', [])).toBe('[non-error:string:str]');
    expect(describeFailureStack({}, [])).toBe('[non-error:object]');
    // Error 但无 stack / 空 stack
    const empty = new Error('only-msg');
    empty.stack = '';
    expect(describeFailureStack(empty, [])).toBe(describeFailure(empty, []));
  });

  // ⑧ 六处调用点：源码必经 describeFailureStack；载荷有界+脱敏+保留换行
  test('⑧ 六处调用点载荷断言（有界 + 已脱敏 + 保留换行）', async () => {
    const srcRoot = join(import.meta.dir, '../src');
    const required = [
      { rel: 'app.ts', prefix: "'[api] unhandled error:'" },
      { rel: 'main.ts', prefix: "'[webhooks] boot reconstruction failed:'" },
      { rel: 'lib/webhook-delivery.ts', prefix: "'[webhooks] maintenance failed:'" },
      { rel: 'lib/webhook-delivery.ts', prefix: "'[webhooks] store corrupt during delivery:'" },
      { rel: 'lib/webhook-delivery.ts', prefix: "'[webhooks] executeJob failed:'" },
      { rel: 'lib/audit.ts', prefix: "'[audit] append failed:'" },
    ];
    const hits: string[] = [];
    for (const r of required) {
      const text = readFileSync(join(srcRoot, r.rel), 'utf8');
      const line = text.split('\n').find((l) => l.includes(r.prefix));
      expect(line, `missing prefix ${r.prefix} in ${r.rel}`).toBeTruthy();
      expect(line!).toMatch(/describeFailureStack\s*\(\s*err\s*\)/);
      expect(line!).not.toMatch(/,\s*err\s*\)\s*;?\s*$/);
      hits.push(`${r.rel}:${r.prefix}`);
    }
    expect(hits).toHaveLength(6);

    // 载荷属性（与调用点同一入口）
    const secret = 'callSiteSecret42';
    const err = new Error(`payload ${secret}`);
    err.stack = `Error: payload ${secret}\n    at site (/x.ts:1:1)\n    at next`;
    const payload = describeFailureStack(err, [secret]);
    expect(payload.length).toBeLessThanOrEqual(STACK_MAX + TRUNC_MARK.length);
    expect(payload).not.toContain(secret);
    expect(payload).toContain('[redacted]');
    expect(payload).toContain('\n');

    // 运行时：app.onError 实投 console.error；调用点不传 secrets ⇒ 用配置密钥
    const { config } = await import('../src/lib/config.ts');
    const cfgSecret = config.smtp.pass;
    const { createApp } = await import('../src/app.ts');
    const app = createApp();
    app.get('/__oae344_boom', () => {
      const e = new Error(`unhandled ${cfgSecret}`);
      e.stack = `Error: unhandled ${cfgSecret}\n    at boom (/t.ts:1:1)`;
      throw e;
    });
    const errors: unknown[][] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const res = await app.request('http://localhost/__oae344_boom');
      expect(res.status).toBe(500);
      const hit = errors.find(
        (a) => typeof a[0] === 'string' && String(a[0]).includes('[api] unhandled error:'),
      );
      expect(hit).toBeTruthy();
      const p = String(hit![1] ?? '');
      expect(p).not.toContain(cfgSecret);
      expect(p).toContain('[redacted]');
      expect(p).toContain('\n');
      expect(p.length).toBeLessThanOrEqual(STACK_MAX + TRUNC_MARK.length);
    } finally {
      spy.mockRestore();
    }

    // 运行时：audit append 失败 —— mock fs 写入抛错（不污染共享 DATA_DIR）
    const { recordAuditEvent } = await import('../src/lib/audit.ts');
    const boom = Object.assign(new Error('EISDIR: illegal operation on a directory'), {
      code: 'EISDIR',
    });
    boom.stack = `Error: EISDIR: illegal operation on a directory\n    at append (/fs.ts:1:1)\n    at record`;
    const writeSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw boom;
    });
    const appendSpy = spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw boom;
    });
    const auditErrors: unknown[][] = [];
    const auditSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      auditErrors.push(args);
    });
    try {
      recordAuditEvent({
        event: 'test.344',
        outcome: 'error',
      });
      const hit = auditErrors.find(
        (a) => typeof a[0] === 'string' && String(a[0]).includes('[audit] append failed:'),
      );
      expect(hit).toBeTruthy();
      const p = String(hit![1] ?? '');
      expect(p).not.toContain('\\n'); // 换行保留字面
      expect(p).toContain('\n');
      expect(p.length).toBeLessThanOrEqual(STACK_MAX + TRUNC_MARK.length);
      expect(p).toContain('EISDIR');
    } finally {
      auditSpy.mockRestore();
      writeSpy.mockRestore();
      appendSpy.mockRestore();
    }
  });

  // ⑨ 零豁免断言（跨卡联动；与 describe-failure-342 J8 同口径复核）
  test('⑨ I6/J8 零豁免：字符串面与对象面均无裸用', () => {
    const srcRoot = join(import.meta.dir, '../src');
    const files: string[] = [];
    function walk(dir: string) {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith('.ts')) files.push(p);
      }
    }
    walk(srcRoot);

    const bareHits: string[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const loc = `${rel}:${idx + 1}`;
        if (
          /console\.(warn|error|log)\(/.test(line) &&
          /(err as Error\)?\.message|err instanceof Error \? err\.message|String\(err\))/.test(line)
        ) {
          bareHits.push(loc);
        }
        if (
          /console\.(warn|error|log)\(/.test(line) &&
          /,\s*err\s*\)/.test(line) &&
          !/describeFailure(Stack)?\s*\(\s*err\s*\)/.test(line)
        ) {
          bareHits.push(loc);
        }
      });
    }
    expect(bareHits).toEqual([]);
  });
});
