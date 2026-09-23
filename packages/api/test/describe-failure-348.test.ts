/**
 * #348：发射路径收敛 — 9 实例逐条 + 4 不变量 + grep 禁手工直连。
 * 设计：/home/ops/materials/log-face-r5/design.md
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-348-'));

const {
  describeFailure,
  describeFailureStack,
  scrubPayload,
  scrubLinePayload,
  scrubBlockPayload,
  redactSecrets,
  streamRedact,
  containsAnySecret,
  trimTrailingSecretPrefix,
  DESCRIBE_FAILURE_MAX,
  DESCRIBE_FAILURE_STACK_MAX,
  STACK_MAX,
} = await import('../src/lib/redact.ts');

const TRUNC_MARK = '…[truncated]';

/** 尾部是否构成任一密钥真前缀 */
function hasProperPrefixTail(text: string, secrets: string[]): boolean {
  for (const s of secrets) {
    if (!s || s.length < 2) continue;
    for (let len = 1; len < s.length; len++) {
      if (text.endsWith(s.slice(0, len))) return true;
    }
  }
  return false;
}

describe('scrubPayload · #348 九实例 + 不变量', () => {
  // ① ORDER：整行替换后再削尾 — 尾部回退在只删不增阶段
  test('① ORDER：redactSecrets(aaaba, [aa,aaabb]) 不含明文 aa', () => {
    const out = redactSecrets('aaaba', ['aa', 'aaabb']);
    expect(out).not.toContain('aa');
    expect(out).toBe('[redacted]ab');
  });

  // ② SUFFIX-REMATCH：余段重喂
  test('② SUFFIX-REMATCH：streamRedact(abcxabc) 恰为 [redacted]', () => {
    const out = streamRedact('abcxabc', ['abc', 'abcxabcq']);
    expect(out).toBe('[redacted]');
    expect(out).not.toContain('abc');
  });

  // ③ FIELD-BOUNDARY：字段边界半分
  test('③ FIELD-BOUNDARY：code 截断后 sec 不进日志', () => {
    const code = 'x'.repeat(197) + 'secret123';
    const err = Object.assign(new Error('boom'), { code, responseCode: 550 });
    const out = describeFailure(err, ['secret123']);
    expect(out).not.toContain('sec');
    expect(out).not.toContain('secret123');
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
  });

  // ④⑥⑧ 转义生成密钥：口令 '\\u0001' + 真实 U+0001
  test('④ 字符串面 describeFailure：口令 \\u0001 + 真实 U+0001 ⇒ 不含口令', () => {
    const secret = '\\u0001';
    const err = new Error('boom ' + '\u0001' + ' tail');
    const out = describeFailure(err, [secret]);
    expect(out).not.toContain(secret);
  });

  test('⑥ 对象面 stack 为空：口令 \\u0001 ⇒ 不含口令', () => {
    const secret = '\\u0001';
    const err = new Error('boom ' + '\u0001' + ' tail');
    err.stack = '';
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
  });

  test('⑧ 对象面 stack getter 抛：口令 \\u0001 ⇒ 不含口令', () => {
    const secret = '\\u0001';
    const err = new Error('boom ' + '\u0001' + ' tail');
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('stack boom');
      },
      configurable: true,
    });
    expect(() => describeFailureStack(err, [secret])).not.toThrow();
    expect(describeFailureStack(err, [secret])).not.toContain(secret);
  });

  // ⑤ 标记等于密钥
  test('⑤ 口令＝…[truncated] + 触发截断 ⇒ 不含该口令', () => {
    const secret = TRUNC_MARK;
    const err = new Error('mark');
    err.stack = 'x'.repeat(STACK_MAX + 100);
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
  });

  // ⑦ 盘文本路径：默认 line 模式（磁盘行 → 单行转义防日志注入）
  test('⑦ 盘文本路径 scrubPayload：含 U+0001 行 ⇒ 不含 \\u0001 口令；line 转义；有界', () => {
    const secret = '\\u0001';
    const diskLine = 'bad-json ' + '\u0001' + ' more\nstill';
    const out = scrubPayload(diskLine.slice(0, 100), [secret], DESCRIBE_FAILURE_MAX);
    expect(out).not.toContain(secret);
    expect(out).toContain('\\n'); // 默认 line：真实换行转义
    expect(out).not.toContain('\n');
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
  });

  // ⑨ 替换产物拼回密钥 → R4 空串兜底
  test('⑨ 替换产物拼回：foobarbar + [foo,[redacted]bar] ⇒ 不含 [redacted]bar', () => {
    const secrets = ['foo', '[redacted]bar'];
    const err = new Error('x');
    err.stack = 'foobarbar';
    const out = describeFailureStack(err, secrets);
    expect(out).not.toContain('[redacted]bar');
    // R4：若仍含完整密钥则兜底空串
    if (containsAnySecret(out, secrets)) {
      expect(out).toBe('');
    }
  });

  // Codex P2：截断点落在 \uXXXX 内不得留孤立反斜杠
  test('Codex P2：截断点落在 \\uXXXX 内 ⇒ 不得留孤立反斜杠', () => {
    const err = new Error('p2');
    err.stack = 'x' + '\x01'.repeat(STACK_MAX - 1);
    const out = describeFailureStack(err, []);
    expect(out).not.toMatch(/\\u[0-9a-fA-F]{0,3}$/);
    expect(out.endsWith('\\')).toBe(false);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  // —— 4 不变量 ——————————————————————————

  test('不变量：|输出|≤LIMIT / 无完整密钥 / 尾非真前缀 / 永不抛', () => {
    const secrets = ['secret123', TRUNC_MARK, '\\u0001', 'foo', '[redacted]bar'];
    const cases: Array<() => string> = [
      () => describeFailure(Object.assign(new Error('boom'), { code: 'x'.repeat(197) + 'secret123', responseCode: 550 }), ['secret123']),
      () => {
        const e = new Error('boom ' + '\u0001');
        e.stack = 's'.repeat(STACK_MAX + 10);
        return describeFailureStack(e, secrets);
      },
      () => scrubPayload('line ' + '\u0001' + ' end', ['\\u0001'], DESCRIBE_FAILURE_MAX),
      () => {
        const e = new Error('foobarbar');
        e.stack = 'foobarbar';
        return describeFailureStack(e, ['foo', '[redacted]bar']);
      },
      () => {
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        return describeFailure(proxy, secrets);
      },
      () => {
        const boom = new Error('m');
        Object.defineProperty(boom, 'stack', {
          get() {
            throw new Error('no');
          },
        });
        return describeFailureStack(boom, secrets);
      },
    ];

    for (const run of cases) {
      expect(run).not.toThrow();
      const out = run();
      expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
      for (const s of secrets) {
        if (s) expect(out).not.toContain(s);
      }
      expect(hasProperPrefixTail(out, secrets)).toBe(false);
      expect(trimTrailingSecretPrefix(out, secrets)).toBe(out);
    }

    // 字符串面上界特钉
    const strOut = describeFailure(new Error('z'.repeat(500)), ['z']);
    expect(strOut.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
  });

  test('grep：禁止 escapeLine(redactSecrets(...)) 直接嵌套', () => {
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
    const hits: string[] = [];
    const nestRe = /escapeLine\s*\(\s*redactSecrets\s*\(/g;
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = nestRe.exec(text))) {
        hits.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('盘文本调用点写法：webhook-delivery 走 scrubPayload + describeFailureStack', () => {
    const text = readFileSync(
      join(import.meta.dir, '../src/lib/webhook-delivery.ts'),
      'utf8',
    );
    expect(text).toMatch(/scrubPayload\s*\(\s*(line|trimmed)\.slice\s*\(\s*0\s*,\s*100\s*\)\s*\)/);
    expect(text).toMatch(/corrupted delivery log line[\s\S]{0,200}describeFailureStack\s*\(\s*err\s*\)/);
    expect(text).not.toMatch(/escapeLine\s*\(\s*redactSecrets\s*\(/);
  });

  // FC R1 P1：膨胀输入双/三字段 —— 输入远超 200，join 仍 ≤6002
  test('FC P1：NUL×1000 双字段 + 密钥 0 ⇒ 长度 ≤6002', () => {
    const nul = '\u0000'.repeat(1000);
    const err = Object.assign(new Error(nul), { code: nul });
    const out = describeFailure(err, ['0']);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
    expect(out.length).toBeLessThanOrEqual(6002);
  });

  test('FC P1：NUL×1000 三字段（code+responseCode+message）+ 密钥 0 ⇒ ≤6002', () => {
    const nul = '\u0000'.repeat(1000);
    const err = Object.assign(new Error(nul), { code: nul, responseCode: 550 });
    const out = describeFailure(err, ['0']);
    expect(out.length).toBeLessThanOrEqual(6002);
  });

  // FC R1 P2：9000 字符 stack 必须以 …[truncated] 结尾且 ≤8204；⑤ 标记=密钥仍被吞
  test('FC P2：stack×9000 ⇒ 尾部为截断标记且 ≤8204', () => {
    const err = new Error('mark-retain');
    err.stack = 'x'.repeat(9000);
    const out = describeFailureStack(err, []);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    expect(out.endsWith(TRUNC_MARK)).toBe(true);
  });

  test('FC P2：标记=密钥场景仍被吞（⑤ 保持）', () => {
    const secret = TRUNC_MARK;
    const err = new Error('mark-as-secret');
    err.stack = 'x'.repeat(9000);
    const out = describeFailureStack(err, [secret]);
    expect(out).not.toContain(secret);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
  });

  // FC R2：钉死 8193–8204 无膨胀窗口 —— 输入 > STACK_MAX 必须有标记
  test('FC R2：x×8193/8196/8200/8204 ⇒ 必须含截断标记', () => {
    for (const n of [8193, 8196, 8200, 8204] as const) {
      const err = new Error(`win-${n}`);
      err.stack = 'x'.repeat(n);
      const out = describeFailureStack(err, []);
      expect(out).toContain(TRUNC_MARK);
      expect(out.endsWith(TRUNC_MARK)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);
    }
  });

  test('FC R2：x×8192（未截断）⇒ 不得出现截断标记', () => {
    const err = new Error('exact-stack-max');
    err.stack = 'x'.repeat(STACK_MAX);
    const out = describeFailureStack(err, []);
    expect(out).not.toContain(TRUNC_MARK);
    expect(out.length).toBe(STACK_MAX);
  });

  test('FC R2：膨胀路径回归 —— NUL×8192 与 x×9000 仍含标记', () => {
    const nulErr = new Error('nul-exp');
    nulErr.stack = '\u0000'.repeat(STACK_MAX);
    const nulOut = describeFailureStack(nulErr, []);
    expect(nulOut).toContain(TRUNC_MARK);
    expect(nulOut.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_STACK_MAX);

    const big = new Error('x9k');
    big.stack = 'x'.repeat(9000);
    const bigOut = describeFailureStack(big, []);
    expect(bigOut).toContain(TRUNC_MARK);
    expect(bigOut.endsWith(TRUNC_MARK)).toBe(true);
  });

  // FC R3：串面单行不变量 + 对象面保换行 + 模式显式
  test('FC R3：串面 describeFailure 单行 —— 真实 \\n 转义为 \\\\n', () => {
    const out = describeFailure(new Error('line1\nline2'), []);
    expect(out).not.toContain('\n');
    expect(out).toContain('\\n');
    expect(out).toBe('line1\\nline2');
  });

  test('FC R3：对象面 describeFailureStack 仍保留真实换行', () => {
    const err = new Error('m');
    err.stack = 'Error: m\n    at frame (/x.ts:1:1)\n    at next';
    const out = describeFailureStack(err, []);
    expect(out).toContain('\n');
    expect(out).not.toContain('\\n');
  });

  test('FC R3：模式显式 —— scrubLinePayload vs scrubBlockPayload 换行行为分叉', () => {
    const sample = 'a\nb\tc';
    const lineOut = scrubLinePayload(sample, [], DESCRIBE_FAILURE_MAX);
    const blockOut = scrubBlockPayload(sample, [], DESCRIBE_FAILURE_STACK_MAX);
    expect(lineOut).toBe('a\\nb\\tc');
    expect(lineOut).not.toContain('\n');
    expect(lineOut).not.toContain('\t');
    expect(blockOut).toBe('a\nb\tc');
    expect(blockOut).toContain('\n');
    expect(blockOut).toContain('\t');
    // 入口分别走对应封装
    expect(describeFailure(new Error(sample), [])).toBe(lineOut);
    const err = new Error('x');
    err.stack = sample;
    expect(describeFailureStack(err, [])).toBe(blockOut);
  });
});
