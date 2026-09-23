/**
 * #344/#348 对象面：describeFailureStack — 保 stack + 有界 + 脱敏 + 永不抛。
 * 统一走 scrubPayload（LIMIT=8204）；R4 空串兜底。
 */
import { afterAll, describe, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractConsoleCalls,
  isObjectFaceBareArgs,
  isObjectFaceDebtAllowed,
  lineOf,
  OBJECT_FACE_DEBT_ISSUE,
  OBJECT_FACE_DEBT_NEEDLES,
} from './support/log-face-scan.ts';

// redact → config 进程级校验；须在动态 import 前写入
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
const DATA_DIR_344 = mkdtempSync(join(tmpdir(), 'oae-344-'));
process.env.DATA_DIR = DATA_DIR_344;

const {
  describeFailure,
  describeFailureStack,
  escapeLine,
  escapeBlock,
  STACK_MAX,
  DESCRIBE_FAILURE_STACK_MAX,
} = await import('../src/lib/redact.ts');

/** 截断标记（与实现同源） */
const TRUNC_MARK = '…[truncated]';

afterAll(() => {
  try {
    rmSync(DATA_DIR_344, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('describeFailureStack · #344/#348', () => {
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

  test('② 巨大 stack 有界 ≤ DESCRIBE_FAILURE_STACK_MAX(8204)', () => {
    const err = new Error('huge');
    err.stack = 'Error: huge\n' + 'x'.repeat(STACK_MAX + 50_000);
    const out = describeFailureStack(err, []);
    expect(DESCRIBE_FAILURE_STACK_MAX).toBe(8204);
    expect(STACK_MAX).toBe(8192);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('②b：C0 转义膨胀（\\x01×8192）⇒ 输出 ≤ 8204', () => {
    const err = new Error('esc');
    err.stack = '\x01'.repeat(STACK_MAX);
    const out = describeFailureStack(err, []);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    expect(out).not.toMatch(/\\u[0-9a-fA-F]{0,3}$/);
  });

  test('②c：单字符密钥脱敏膨胀（z×8192）⇒ 输出 ≤ 8204', () => {
    const err = new Error('red');
    err.stack = 'z'.repeat(STACK_MAX);
    const out = describeFailureStack(err, ['z']);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    expect(out).not.toContain('z');
    expect(out).toContain('[redacted]');
  });

  test('②d：口令字面 \\u0001 + 源含真实 \\x01 ⇒ 输出不得含口令', () => {
    const secret = '\\u0001';
    const err = new Error('esc-gen');
    err.stack = 'boom ' + '\u0001' + ' tail';
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('②e：截断后尾部不得以 secr 结尾', () => {
    const err = new Error('bound');
    err.stack = '\x01'.repeat(1364) + 'aaaa' + 'secrX';
    const out = describeFailureStack(err, ['secret']);
    expect(out.endsWith('secr')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('②f：口令＝标记原文 + 触发截断 ⇒ 输出不得含该口令', () => {
    const secret = TRUNC_MARK;
    const err = new Error('mark-as-secret');
    err.stack = 'x'.repeat(STACK_MAX + 100);
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('②g：口令 \\u0001 + 无 stack 回退（空/缺/抛）⇒ 输出不得含口令', () => {
    const secret = '\\u0001';
    const msg = 'boom ' + '\u0001' + ' tail';

    const empty = new Error(msg);
    empty.stack = '';
    const outEmpty = describeFailureStack(empty, [secret]);
    expect(outEmpty).not.toContain(secret);

    const noStack = new Error(msg);
    Object.defineProperty(noStack, 'stack', { value: undefined, configurable: true });
    const outNoStack = describeFailureStack(noStack, [secret]);
    expect(outNoStack).not.toContain(secret);

    const boom = new Error(msg);
    Object.defineProperty(boom, 'stack', {
      get() {
        throw new Error('stack boom');
      },
      configurable: true,
    });
    const outThrow = describeFailureStack(boom, [secret]);
    expect(outThrow).not.toContain(secret);
    expect(outThrow.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('②h：不变量（上界 / 无完整密钥 / 尾非真前缀）', () => {
    const secrets = ['secret', TRUNC_MARK, '\\u0001'];
    const cases: Array<{ stack?: string; msg?: string; clearStack?: 'empty' | 'throw' }> = [
      { stack: 'aaaa secrX' },
      { stack: '\x01'.repeat(1364) + 'aaaa' + 'secrX' },
      { stack: '\x01'.repeat(STACK_MAX) },
      { stack: 'z'.repeat(STACK_MAX) },
      { stack: 'boom ' + '\u0001' + ' tail' },
      { stack: 'x'.repeat(STACK_MAX + 50) },
      { msg: 'boom ' + '\u0001' + ' tail', clearStack: 'empty' },
      { msg: 'boom ' + '\u0001' + ' tail', clearStack: 'throw' },
    ];
    for (const c of cases) {
      const err = new Error(c.msg ?? 'inv');
      if (c.clearStack === 'empty') err.stack = '';
      else if (c.clearStack === 'throw') {
        Object.defineProperty(err, 'stack', {
          get() {
            throw new Error('no');
          },
          configurable: true,
        });
      } else if (c.stack !== undefined) err.stack = c.stack;

      const out = describeFailureStack(err, secrets);
      expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
      for (const s of secrets) {
        if (s.length > 0) expect(out).not.toContain(s);
      }
      for (const s of secrets) {
        if (s.length < 2) continue;
        for (let len = 1; len < s.length; len++) {
          expect(out.endsWith(s.slice(0, len))).toBe(false);
        }
      }
    }
  });

  test('③ 截断点恰落在密钥真前缀 ⇒ 输出不含该前缀', () => {
    const secret = 'secret1234567890';
    const prefix = 's'.repeat(STACK_MAX - 6);
    const err = new Error('bound');
    err.stack = prefix + secret;
    expect(err.stack.slice(0, STACK_MAX).endsWith('secret')).toBe(true);
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain('secret');
    expect(out).not.toContain(secret.slice(0, 6));
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  test('④ 会抛的 stack getter / revoked Proxy ⇒ 永不抛 + 哨兵', () => {
    const boom = new Error('ok-message');
    Object.defineProperty(boom, 'stack', {
      get() {
        throw new Error('stack accessor boom');
      },
      configurable: true,
    });
    expect(() => describeFailureStack(boom, [])).not.toThrow();
    expect(describeFailureStack(boom, [])).toBe('ok-message');

    const target = { message: 'x' };
    const proxy = new Proxy(target, {
      get() {
        throw new Error('revoked');
      },
      getPrototypeOf() {
        throw new Error('revoked-proto');
      },
    });
    expect(() => describeFailureStack(proxy, [])).not.toThrow();
    const out = describeFailureStack(proxy, []);
    expect(out === '[unreadable]' || out.startsWith('[non-error:') || out === '').toBe(true);
  });

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

  test('⑥ 非换行控制符 / DEL+C1 / U+2028·2029 / bidi 照转义', () => {
    const err = new Error('ctl');
    err.stack =
      'Error: ctl\n' + `pre\u0001mid\u007f\u009b\u2028\u2029\u202e\u2066post`;
    const out = describeFailureStack(err, []);
    expect(out).toContain('\\u0001');
    expect(out).toContain('\\u007f');
    expect(out).toContain('\\u009b');
    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).toContain('\\u202e');
    expect(out).toContain('\\u2066');
    const sample = 'a\u0001b\u202Ec';
    expect(escapeBlock(sample)).toBe(escapeLine(sample).replace(/\\n/g, '\n'));
    expect(escapeBlock('a\nb\tc')).toBe('a\nb\tc');
    expect(escapeLine('a\nb\tc')).toBe('a\\nb\\tc');
  });

  test('⑦ 非 Error 输入退化为 describeFailure 类型化哨兵', () => {
    expect(describeFailureStack(undefined, [])).toBe(describeFailure(undefined, []));
    expect(describeFailureStack(null, [])).toBe('[non-error:null]');
    expect(describeFailureStack(42, [])).toBe('[non-error:number:42]');
    expect(describeFailureStack('str', [])).toBe('[non-error:string:str]');
    expect(describeFailureStack({}, [])).toBe('[non-error:object]');
    const empty = new Error('only-msg');
    empty.stack = '';
    expect(describeFailureStack(empty, [])).toBe(describeFailure(empty, []));
  });

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
      expect(line).toBeTruthy();
      expect(line!).toMatch(/describeFailureStack\s*\(\s*err\s*\)/);
      expect(line!).not.toMatch(/,\s*err\s*\)\s*;?\s*$/);
      hits.push(`${r.rel}:${r.prefix}`);
    }
    expect(hits).toHaveLength(6);

    const secret = 'callSiteSecret42';
    const err = new Error(`payload ${secret}`);
    err.stack = `Error: payload ${secret}\n    at site (/x.ts:1:1)\n    at next`;
    const payload = describeFailureStack(err, [secret]);
    expect(payload.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    expect(payload).not.toContain(secret);
    expect(payload).toContain('[redacted]');
    expect(payload).toContain('\n');

    const { config } = await import('../src/lib/config.ts');
    const cfgSecret = config.smtp.pass;
    const { createApp } = await import('../src/app.ts');
    const app = createApp();
    app.get('/__oae348_boom', () => {
      const e = new Error(`unhandled ${cfgSecret}`);
      e.stack = `Error: unhandled ${cfgSecret}\n    at boom (/t.ts:1:1)`;
      throw e;
    });
    const errors: unknown[][] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      const res = await app.request('http://localhost/__oae348_boom');
      expect(res.status).toBe(500);
      const hit = errors.find(
        (a) => typeof a[0] === 'string' && String(a[0]).includes('[api] unhandled error:'),
      );
      expect(hit).toBeTruthy();
      const p = String(hit![1] ?? '');
      expect(p).not.toContain(cfgSecret);
      expect(p).toContain('[redacted]');
      expect(p).toContain('\n');
      expect(p.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    } finally {
      spy.mockRestore();
    }

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
        event: 'test.348',
        outcome: 'error',
      });
      const hit = auditErrors.find(
        (a) => typeof a[0] === 'string' && String(a[0]).includes('[audit] append failed:'),
      );
      expect(hit).toBeTruthy();
      const p = String(hit![1] ?? '');
      expect(p).not.toContain('\\n');
      expect(p).toContain('\n');
      expect(p.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
      expect(p).toContain('EISDIR');
    } finally {
      auditSpy.mockRestore();
      writeSpy.mockRestore();
      appendSpy.mockRestore();
    }
  });

  test('⑨ I6/J8：对象面残余仅 #347 白名单', () => {
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

    const objectBareHits: string[] = [];
    const allowed: string[] = [];
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const text = readFileSync(file, 'utf8');
      for (const call of extractConsoleCalls(text)) {
        if (!isObjectFaceBareArgs(call.args)) continue;
        const loc = `${rel}:${lineOf(text, call.index)}`;
        const callSrc = text.slice(call.index, call.index + 220);
        if (isObjectFaceDebtAllowed(callSrc)) allowed.push(loc);
        else objectBareHits.push(loc);
      }
    }
    expect(objectBareHits).toEqual([]);
    expect(OBJECT_FACE_DEBT_ISSUE).toBe('#347');
    expect(allowed.length).toBeGreaterThanOrEqual(OBJECT_FACE_DEBT_NEEDLES.length);
  });
});
