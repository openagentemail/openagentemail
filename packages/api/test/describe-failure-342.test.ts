/**
 * #342 B 形态：J1–J9 / 五机制 / 三反例 / 终止性 / 兼容负控 / 已声明行为差异。
 * 设计见 materials/log-face-design/design-b.md。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
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
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-342-'));

const {
  describeFailure,
  redactSecrets,
  redactField,
  streamRedact,
  escapeLine,
  ERROR_DETAIL_MAX,
  DESCRIBE_FAILURE_MAX,
} = await import('../src/lib/redact.ts');

describe('describeFailure / redactField · #342 B', () => {
  // —— 终止性 ——————————————————————————————

  test('T-term-1：602 全不匹配必须终止且输出逐字节不变', () => {
    const input = 'z'.repeat(602);
    const t0 = performance.now();
    const out = redactSecrets(input, ['ab']);
    const ms = performance.now() - t0;
    expect(out).toBe(input);
    expect(out.length).toBe(602);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
    // 耗时留件由运行侧产出；测试内仅宽松上界（CI 无本机专用路径写权）
    expect(ms).toBeLessThan(5_000);
  });

  test('T-term-2：两侧 z + 中间 ab ⇒ 恰一处 [redacted]', () => {
    const input = `${'z'.repeat(300)}ab${'z'.repeat(300)}`;
    const out = redactSecrets(input, ['ab']);
    expect(out).toBe(`${'z'.repeat(300)}[redacted]${'z'.repeat(300)}`);
    expect(out.split('[redacted]').length - 1).toBe(1);
  });

  test('T-P1-1：hold 后延长失败回落已完成匹配', () => {
    const out = redactSecrets('abx', ['ab', 'abc']);
    expect(out).toBe('[redacted]x');
    expect(out).not.toContain('ab');
  });

  // R5 P1-A：回放插队首；不得因换序泄漏密钥明文
  test('R5 P1-A：Codex 三连反例 — 不得含明文 aa，精确期望', () => {
    const secrets = ['aa', 'aaabb'];
    expect(redactSecrets('aaaba', secrets)).toBe('[redacted]ab');
    expect(redactSecrets('aaabaa', secrets)).toBe('[redacted]ab[redacted]');
    expect(redactSecrets('xaaaba', secrets)).toBe('x[redacted]ab');
    for (const s of ['aaaba', 'aaabaa', 'xaaaba'] as const) {
      expect(redactSecrets(s, secrets)).not.toContain('aa');
    }
  });

  // J5：除被红吞掉的字符外，残段相对顺序与原文一致
  test('J5：顺序保持（残段顺序＝原文去掉密钥出现后的顺序）', () => {
    const cases: Array<{ input: string; secrets: string[]; expect: string }> = [
      { input: 'hello', secrets: ['xyz'], expect: 'hello' },
      { input: 'a=secret b=secretlong', secrets: ['secret', 'secretlong'], expect: 'a=[redacted] b=[redacted]' },
      { input: 'abx', secrets: ['ab', 'abc'], expect: '[redacted]x' },
      { input: 'xaaaba', secrets: ['aa', 'aaabb'], expect: 'x[redacted]ab' },
      { input: 'plain', secrets: [], expect: 'plain' },
    ];
    for (const row of cases) {
      expect(redactSecrets(row.input, row.secrets)).toBe(row.expect);
    }
    const input = 'prefix-aa-mid-aaabb-suffix';
    const secrets = ['aa', 'aaabb'];
    const out = redactSecrets(input, secrets);
    const residual = out.split('[redacted]').join('');
    let j = 0;
    for (let i = 0; i < residual.length; i++) {
      while (j < input.length && input[j] !== residual[i]) j++;
      expect(j < input.length).toBe(true);
      j++;
    }
    expect(out).not.toContain('aa');
    expect(out).not.toContain('aaabb');
  });

  // —— J1–J9 正控 ——————————————————————————

  test('J1：独立域 — join 在脱敏之后，禁止跨字段匹配', () => {
    // 密钥 'ESE cret' 跨边界：前字段 ESE 恰为真前缀 ⇒ J4 丢弃；后字段 cret 单独不成钥
    // ⇒ 不得整行 [redacted]；亦不得因 join 后二次匹配而拼回密钥
    const err = Object.assign(new Error('cret'), { code: 'ESE' });
    const out = describeFailure(err, ['ESE cret']);
    expect(out).toBe(' cret'); // code 域被 J4 丢空后仍占位 join
    expect(out).not.toBe('[redacted]');
    expect(out).not.toContain('ESE cret');
    expect(out).not.toContain('ESE');
  });

  test('J2：逐字段先有界（超长 code/message 各自 ≤200）', () => {
    const err = Object.assign(new Error('m'.repeat(500)), {
      code: 'c'.repeat(500),
      responseCode: 550,
    });
    const out = describeFailure(err, []);
    expect(out.length).toBe(200 + 1 + String(550).length + 1 + 200);
    expect(out.startsWith('c'.repeat(200))).toBe(true);
    expect(out.endsWith('m'.repeat(200))).toBe(true);
    expect(ERROR_DETAIL_MAX).toBe(200);
  });

  test('J3：域内单趟 + 最长优先 + hold', () => {
    expect(redactField('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
    expect(redactField('abx', ['ab', 'abc'])).toBe('[redacted]x');
    expect(redactField('abcd', ['ab', 'abc'])).toBe('[redacted]d');
  });

  test('J4：域尾一律丢弃 — 永不字面倾倒待定缓冲', () => {
    // 域尾余段（Codex P1-1）：已成匹配后余部丢弃
    expect(redactField('abcxabc', ['abc', 'abcxabcq'])).toBe('[redacted]');
    expect(redactField('abcxabc', ['abc', 'abcxabcq'])).not.toContain('abc');
    // 域尾真前缀丢弃
    expect(redactField('xxsec', ['secret123'])).toBe('xx');
    expect(redactField('xxsec', ['secret123'])).not.toContain('sec');
  });

  test('J6：转义段含 bidi/格式符（脱敏之后）', () => {
    expect(escapeLine('a\u202Eb\u2066c')).toBe('a\\u202eb\\u2066c');
    expect(escapeLine('a\nb')).toBe('a\\nb');
    expect(escapeLine(`x\u2028y`)).toBe('x\\u2028y');
    expect(escapeLine(`a\u007fb`)).toBe('a\\u007fb');
    expect(escapeLine(`x\u009by`)).toBe('x\\u009by');
  });

  test('J7：永不抛（getter / revoked Proxy / 非字符串化）', () => {
    const boom = new Error('x');
    Object.defineProperty(boom, 'message', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => describeFailure(boom, [])).not.toThrow();
    expect(describeFailure(boom, [])).toBe('[unreadable]');

    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => describeFailure(proxy, [])).not.toThrow();
    // instanceof 触碰 revoked Proxy 原型链 ⇒ 落入 [unreadable]
    expect(describeFailure(proxy, [])).toBe('[unreadable]');

    const bad = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => describeFailure(bad, [])).not.toThrow();
  });

  test('J8：单点入口 + 零裸用（对象面残余仅 #347 白名单）', () => {
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

    const errorDetailHits: string[] = [];
    const bareHits: string[] = [];
    const objectBareHits: string[] = [];
    const allowed: string[] = [];

    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        const loc = `${rel}:${idx + 1}`;
        if (/\berrorDetail\s*\(/.test(line)) errorDetailHits.push(loc);
        if (/console\.warn\(\s*'\[task\] claim(-lost)? failed:'/.test(line)) {
          if (!/describeFailure\s*\(\s*err\s*\)/.test(line) || /,\s*code\s*\)/.test(line)) {
            bareHits.push(loc);
          }
        }
      });
      for (const call of extractConsoleCalls(text)) {
        if (!isObjectFaceBareArgs(call.args)) continue;
        const loc = `${rel}:${lineOf(text, call.index)}`;
        const callSrc = text.slice(call.index, call.index + 220);
        if (isObjectFaceDebtAllowed(callSrc)) allowed.push(loc);
        else objectBareHits.push(loc);
      }
    }

    expect(errorDetailHits).toEqual([]);
    expect(bareHits).toEqual([]);
    expect(objectBareHits).toEqual([]);
    expect(OBJECT_FACE_DEBT_ISSUE).toBe('#347');
    expect(allowed.length).toBeGreaterThanOrEqual(OBJECT_FACE_DEBT_NEEDLES.length);
  });

  test('J8b：禁止 escapeLine(redactSecrets(...)) 手工直连嵌套', () => {
    // 与 #342 I6/J8 同款：全仓 src 不得出现 escapeLine( 与 redactSecrets( 直接嵌套
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

    const nestedHits: string[] = [];
    // 允许跨空白/换行的直接嵌套：escapeLine( redactSecrets( ... ) )
    const nestRe = /escapeLine\s*\(\s*redactSecrets\s*\(/g;
    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const text = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = nestRe.exec(text))) {
        const line = text.slice(0, m.index).split('\n').length;
        nestedHits.push(`${rel}:${line}`);
      }
    }
    expect(nestedHits).toEqual([]);
  });

  test('J9：输出上界 ≤6002', () => {
    // 每字段 200 个单字符密钥 → 每字段 200×10；三字段+2 空格 = 6002
    const chunk = 'x'.repeat(200);
    const err = Object.assign(new Error(chunk), { code: chunk, responseCode: 99 });
    const out = describeFailure(err, ['x']);
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
    expect(DESCRIBE_FAILURE_MAX).toBe(6002);
    expect(out.length).toBeLessThanOrEqual(6002);
    // DEL 满字段：200×6×2 + 转义后的 "99" + 2 空格 仍 ≤6002
    const del = '\u007f'.repeat(200);
    const err2 = Object.assign(new Error(del), { code: del, responseCode: 550 });
    expect(describeFailure(err2, []).length).toBeLessThanOrEqual(6002);
  });

  test('I2/脱敏后不截断：短密钥替换变长仍完整保留标记', () => {
    const out = describeFailure(new Error('x'), ['x']);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('x');
    expect(out.includes('[redacted]')).toBe(true);
  });

  test('redactSecrets 为 redactField 薄包装（无第二份实现 / 不含转义）', () => {
    const samples = ['a=secret b=secretlong', 'plain', 'abx', '', 'HEAD SECRET TAIL'];
    const secrets = ['secret', 'secretlong', 'ab', 'abc', 'SECRET'];
    for (const s of samples) {
      expect(redactSecrets(s, secrets)).toBe(redactField(s, secrets));
      expect(streamRedact(s, secrets)).toBe(redactField(s, secrets));
    }
    expect(redactSecrets('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
    const withNl = 'a\nb';
    expect(redactSecrets(withNl, ['x'])).toBe('a\nb');
    expect(redactSecrets(withNl, ['x'])).toContain('\n');
    expect(redactSecrets(withNl, ['x'])).not.toContain('\\n');
    // scrubPayload 用 escapeBlock：LF 保留字面（与历史 escapeLine 单行化不同；#348 对齐）
    const viaDescribe = describeFailure(new Error('a\nb'), []);
    expect(viaDescribe).toContain('\n');
    expect(viaDescribe).not.toContain('\\n');
  });

  // —— 五机制反例 ——————————————————————————

  test('机制1：重叠密钥最长优先 + hold（含 R5 aaaba）', () => {
    expect(redactSecrets('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
    expect(redactSecrets('abx', ['ab', 'abc'])).toBe('[redacted]x');
    expect(redactSecrets('abcd', ['ab', 'abc'])).toBe('[redacted]d');
    expect(redactSecrets('aaaba', ['aa', 'aaabb'])).toBe('[redacted]ab');
    expect(redactSecrets('aaaba', ['aa', 'aaabb'])).not.toContain('aa');
  });

  test('机制2：单字段无界先截再红', () => {
    const secret = 'p@ss';
    const err = new Error(`${'z'.repeat(5000)}${secret}`);
    const t0 = performance.now();
    const out = describeFailure(err, [secret]);
    const ms = performance.now() - t0;
    expect(out.length).toBeLessThanOrEqual(DESCRIBE_FAILURE_MAX);
    expect(out).not.toContain(secret);
    expect(ms).toBeLessThan(5_000);
  });

  test('机制3：多字段拼接处半截 — B 下结构性消失（join 后不再匹配）', () => {
    // 跨边界密钥：前域真前缀 J4 丢弃 ⇒ 融合不可能（闭合论证 §三.4）
    const err = Object.assign(new Error('cret'), { code: 'ESE' });
    expect(describeFailure(err, ['ESE cret'])).toBe(' cret');
    expect(describeFailure(err, ['ESE cret'])).not.toContain('ESE');
    // 截断制造的域尾前缀由 J4 丢弃（见三反例 b）
    const code = 'x'.repeat(197) + 'secret123';
    const err2 = Object.assign(new Error('boom'), { code, responseCode: 550 });
    const out2 = describeFailure(err2, ['secret123']);
    expect(out2).not.toContain('sec');
    expect(out2).not.toContain('secret');
  });

  test('机制4：无「字段级先 scrub 再 join 后再 scrub」（R6b）— 仅逐字段完整流水线', () => {
    // join 之后不再有匹配动作；前域 HEAD 为 'HEAD TAIL' 真前缀 ⇒ J4 丢弃
    const err = Object.assign(new Error('TAIL'), { code: 'HEAD' });
    expect(describeFailure(err, ['HEAD TAIL'])).toBe(' TAIL');
    expect(describeFailure(err, ['HEAD TAIL'])).not.toBe('[redacted]');
    expect(describeFailure(err, ['HEAD TAIL'])).not.toContain('HEAD TAIL');
  });

  test('机制5：未截断字段同样走脱敏（R6c）', () => {
    const err = new Error('short secretxx');
    expect(describeFailure(err, ['secretxx'])).toBe('short [redacted]');
  });

  // —— 三条新反例回归 ————————————————————

  test('反例a：域尾余段 — abcxabc ⇒ 恰 [redacted]，不得含明文 abc', () => {
    expect(redactField('abcxabc', ['abc', 'abcxabcq'])).toBe('[redacted]');
    expect(streamRedact('abcxabc', ['abc', 'abcxabcq'])).toBe('[redacted]');
    expect(redactField('abcxabc', ['abc', 'abcxabcq'])).not.toContain('abc');
  });

  test('反例b：截断域尾前缀 — code 截断后 sec 不得进日志', () => {
    const code = 'x'.repeat(197) + 'secret123';
    const err = Object.assign(new Error('boom'), { code, responseCode: 550 });
    const out = describeFailure(err, ['secret123']);
    expect(out).not.toContain('sec');
    expect(out).not.toContain('secret123');
    // 精确：197 个 x + 空格 + 550 + 空格 + boom（sec 被 J4 丢弃）
    expect(out).toBe(`${'x'.repeat(197)} 550 boom`);
  });

  test('反例c：bidi 转义 + describeFailure 侧回归', () => {
    expect(escapeLine('a\u202Eb\u2066c')).toBe('a\\u202eb\\u2066c');
    expect(describeFailure(new Error('a\u202Eb\u2066c'), [])).toBe('a\\u202eb\\u2066c');
    expect(describeFailure(new Error('pre\u202Esecret\u2066post'), ['secret'])).toBe(
      'pre\\u202e[redacted]\\u2066post',
    );
  });

  // —— 兼容 / 已声明差异 / 哨兵 ————————————————————

  test('兼容负控：无密钥、无控制符、字段尾非真前缀 ⇒ 与历史逐字节一致', () => {
    const err = Object.assign(new Error('Mailbox unavailable'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    expect(describeFailure(err, [])).toBe('EENVELOPE 550 Mailbox unavailable');
  });

  test('已声明行为差异：字段尾恰为密钥真前缀 ⇒ 有意少若干字符（J4 直接代价，非缺陷）', () => {
    // message 以 secret123 的真前缀 "sec" 结尾 ⇒ 域尾丢弃 "sec"
    const err = new Error('auth failed: sec');
    const out = describeFailure(err, ['secret123']);
    expect(out).toBe('auth failed: ');
    expect(out).not.toContain('sec');
    // 源文本自带的无关前缀子串不在闭合范围（诚实边界）：无密钥配置时保留
    expect(describeFailure(new Error('section'), [])).toBe('section');
  });

  test('控制符转义：C0 / DEL / C1 / U+2028 在脱敏之后（LF 保留字面）', () => {
    const out = describeFailure(new Error('pre\nsecret\npost'), ['secret']);
    expect(out).not.toContain('secret');
    expect(out).toContain('[redacted]');
    // scrubPayload → escapeBlock：换行保留字面
    expect(out).toContain('\n');
    expect(out).not.toContain('\\n');
    expect(describeFailure(new Error(`pre\u007fpost`), [])).toBe('pre\\u007fpost');
    expect(describeFailure(new Error(`pre\u009bpost`), [])).toBe('pre\\u009bpost');
  });

  test('非 Error 类型化哨兵（原 errorDetail 契约）', () => {
    expect(describeFailure(undefined, [])).toBe('[non-error:undefined]');
    expect(describeFailure(null, [])).toBe('[non-error:null]');
    expect(describeFailure(42, [])).toBe('[non-error:number:42]');
    expect(describeFailure('str', [])).toBe('[non-error:string:str]');
    expect(describeFailure({}, [])).toBe('[non-error:object]');
  });

  test('[] 不脱敏；空串密钥过滤', () => {
    expect(describeFailure(new Error('keep secret'), [])).toBe('keep secret');
    expect(redactSecrets('nothing to hide', [''])).toBe('nothing to hide');
  });
});
