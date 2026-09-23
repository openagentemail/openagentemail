/**
 * #342 日志面唯一入口：I1–I7 / 五机制 / 终止性 / 兼容负控。
 * 设计见 issue #342 / log-face-design（R3–R5）。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// redact → config 进程级校验；须在动态 import 前写入（勿用 ??=，避免空串占位）
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-342-'));

const { describeFailure, redactSecrets, streamRedact, escapeLine, ERROR_DETAIL_MAX } = await import(
  '../src/lib/redact.ts'
);

describe('describeFailure / streamRedact · #342', () => {
  // —— 终止性 ——————————————————————————————

  test('T-term-1：602 全不匹配必须终止且输出逐字节不变', () => {
    const input = 'z'.repeat(602);
    const t0 = performance.now();
    const out = redactSecrets(input, ['ab']);
    const ms = performance.now() - t0;
    expect(out).toBe(input);
    expect(out.length).toBe(602);
    expect(out.length).toBeLessThanOrEqual(6020);
    // 耗时留件由运行侧产出；测试内仅宽松上界（CI 无 /home/ops 写权）
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

  // I7：除被红吞掉的字符外，残段相对顺序与原文一致
  test('I7：顺序保持（残段顺序＝原文去掉密钥出现后的顺序）', () => {
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
    // 属性：输出去掉 [redacted] 后，是原文删去若干互不重叠子串后的子序列
    const input = 'prefix-aa-mid-aaabb-suffix';
    const secrets = ['aa', 'aaabb'];
    const out = redactSecrets(input, secrets);
    const residual = out.split('[redacted]').join('');
    // residual 须为 input 的子序列（相对顺序）
    let j = 0;
    for (let i = 0; i < residual.length; i++) {
      while (j < input.length && input[j] !== residual[i]) j++;
      expect(j < input.length).toBe(true);
      j++;
    }
    expect(out).not.toContain('aa');
    expect(out).not.toContain('aaabb');
  });

  // —— I1–I6 正控 ——————————————————————————

  test('I1：逐字段先有界（超长 code/message 各自 ≤200）', () => {
    const err = Object.assign(new Error('m'.repeat(500)), {
      code: 'c'.repeat(500),
      responseCode: 550,
    });
    const out = describeFailure(err, []);
    // 转义后仍按字段截断前的码元计：三字段+空格，无 C0 时长度 = 200+1+3+1+200
    expect(out.length).toBe(200 + 1 + String(550).length + 1 + 200);
    expect(out.startsWith('c'.repeat(200))).toBe(true);
    expect(out.endsWith('m'.repeat(200))).toBe(true);
  });

  test('I2：脱敏结果不被再截断（短密钥替换变长仍完整保留标记）', () => {
    const out = describeFailure(new Error('x'), ['x']);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('x');
    // 标记完整，无被 slice 砍半
    expect(out.includes('[redacte')).toBe(true);
    expect(out.includes('[redacted]')).toBe(true);
  });

  test('I3：redactSecrets 为 streamRedact 薄包装（无第二份实现 / 不含转义）', () => {
    // 正控：与 streamRedact 逐字节等价（含空串与含密钥样本）
    const samples = ['a=secret b=secretlong', 'plain', 'abx', '', 'HEAD SECRET TAIL'];
    const secrets = ['secret', 'secretlong', 'ab', 'abc', 'SECRET'];
    for (const s of samples) {
      expect(redactSecrets(s, secrets)).toBe(streamRedact(s, secrets));
    }
    expect(redactSecrets('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
    // 负控：不含单行转义 —— 原始换行须保留；describeFailure 同行须已转义
    const withNl = 'a\nb';
    expect(redactSecrets(withNl, ['x'])).toBe('a\nb');
    expect(redactSecrets(withNl, ['x'])).toContain('\n');
    expect(redactSecrets(withNl, ['x'])).not.toContain('\\n');
    const viaDescribe = describeFailure(new Error('a\nb'), []);
    expect(viaDescribe).toContain('\\n');
    expect(viaDescribe).not.toContain('\n');
  });

  test('I4：跨字段拼接处半截由整行流式匹配', () => {
    // 密钥含空格 ⇒ 跨 code/message 边界的拼接串可被整行一次红掉
    const err = Object.assign(new Error('cret'), { code: 'ESE' });
    expect(describeFailure(err, ['ESE cret'])).toBe('[redacted]');
    expect(redactSecrets('HEAD SECRET TAIL', ['SECRET'])).toBe('HEAD [redacted] TAIL');
  });

  test('I5：永不抛（getter / revoked Proxy / 非字符串化）', () => {
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
    expect(describeFailure(proxy, [])).toBe('[unreadable]');

    const bad = {
      toString() {
        throw new Error('nope');
      },
    };
    expect(() => describeFailure(bad, [])).not.toThrow();
  });

  test('I6：字符串面无裸 errorDetail / 裸 String(err) 日志；对象面 6 处豁免 #344', () => {
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

    // 对象面 6 处：console.error(..., err) 整对象 —— 记债 #344，本卡精确豁免
    const objectFaceExempt = new Set([
      'app.ts:178',
      'main.ts:53',
      'webhook-delivery.ts:1232',
      'webhook-delivery.ts:2160',
      'webhook-delivery.ts:2162',
      'audit.ts:223',
    ]);

    const errorDetailHits: string[] = [];
    const bareHits: string[] = [];

    for (const file of files) {
      const rel = file.slice(srcRoot.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const loc = `${rel}:${idx + 1}`;
        const baseLoc = `${rel.split('/').pop()}:${idx + 1}`;
        if (/\berrorDetail\s*\(/.test(line)) errorDetailHits.push(loc);
        // 裸：err.message / String(err) 进入 console.* 同一行（粗检）
        if (
          /console\.(warn|error|log)\(/.test(line) &&
          /(err as Error\)?\.message|err instanceof Error \? err\.message|String\(err\))/.test(line)
        ) {
          if (!objectFaceExempt.has(baseLoc)) bareHits.push(loc);
        }
        // R4 微扩②：claim / claim-lost 兜底 warn 必须走 describeFailure，禁止打 code 原文
        if (/console\.warn\(\s*'\[task\] claim(-lost)? failed:'/.test(line)) {
          if (!/describeFailure\s*\(\s*err\s*\)/.test(line) || /,\s*code\s*\)/.test(line)) {
            bareHits.push(loc);
          }
        }
      });
    }

    expect(errorDetailHits).toEqual([]);
    expect(bareHits).toEqual([]);
  });

  // —— 五机制反例 ——————————————————————————

  test('机制1：重叠密钥最长优先 + hold 延长失败', () => {
    expect(redactSecrets('a=secret b=secretlong', ['secret', 'secretlong'])).toBe(
      'a=[redacted] b=[redacted]',
    );
    expect(redactSecrets('abx', ['ab', 'abc'])).toBe('[redacted]x');
    expect(redactSecrets('abcd', ['ab', 'abc'])).toBe('[redacted]d');
  });

  test('机制2：单字段无界先截再红', () => {
    const secret = 'p@ss';
    const err = new Error(`${'z'.repeat(5000)}${secret}`);
    const t0 = performance.now();
    const out = describeFailure(err, [secret]);
    const ms = performance.now() - t0;
    expect(out.length).toBeLessThanOrEqual(6020);
    expect(out).not.toContain(secret);
    // 截断后可能不含完整密钥 → 仍不得抛、须有界
    expect(ms).toBeLessThan(5_000);
    expect(ERROR_DETAIL_MAX).toBe(200);
  });

  test('机制3：多字段拼接后半截由整行流式处理', () => {
    const err = Object.assign(new Error('cret'), { code: 'ESE' });
    // "ESE cret" — 若密钥为 "ESE cret"
    expect(describeFailure(err, ['ESE cret'])).toBe('[redacted]');
  });

  test('机制4：无字段级先 scrub（R6b）——只 join 后单趟', () => {
    // 若字段级先 scrub，截断 code 后再 join 会另生边界；此处整行一次红
    const err = Object.assign(new Error('TAIL'), { code: 'HEAD' });
    expect(describeFailure(err, ['HEAD TAIL'])).toBe('[redacted]');
  });

  test('机制5：未截断字段同样走脱敏（R6c）', () => {
    const err = new Error('short secretxx');
    expect(describeFailure(err, ['secretxx'])).toBe('short [redacted]');
  });

  // —— 兼容 / 转义 / 哨兵 ————————————————————

  test('兼容负控：无密钥时三字段输出与历史 join 逐字节一致', () => {
    const err = Object.assign(new Error('Mailbox unavailable'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    expect(describeFailure(err, [])).toBe('EENVELOPE 550 Mailbox unavailable');
  });

  test('单行化：C0 / U+2028 转义在脱敏之后', () => {
    expect(escapeLine('a\nb')).toBe('a\\nb');
    expect(escapeLine(`x\u2028y`)).toBe('x\\u2028y');
    // 密钥含换行：先红再转义，不得因先转义而漏红
    const out = describeFailure(new Error('pre\nsecret\npost'), ['secret']);
    expect(out).not.toContain('secret');
    expect(out).toContain('[redacted]');
    expect(out).toContain('\\n');
  });

  // R4 微扩①：DEL + C1（含 CSI U+009B）；上界仍 ≤6020
  test('单行化：DEL(U+007F) 与 C1(U+009B) 转义为 \\uXXXX', () => {
    expect(escapeLine(`a\u007fb`)).toBe('a\\u007fb');
    expect(escapeLine(`x\u009by`)).toBe('x\\u009by');
    expect(describeFailure(new Error(`pre\u007fpost`), [])).toBe('pre\\u007fpost');
    expect(describeFailure(new Error(`pre\u009bpost`), [])).toBe('pre\\u009bpost');
  });

  test('单行化：含 DEL/C1 的满字段输出仍 ≤6020', () => {
    // 每字段 200 个 DEL → 转义后每字段 200*6；三字段+2 空格 ≈ 3602 ≤ 6020
    const chunk = '\u007f'.repeat(200);
    const err = Object.assign(new Error(chunk), { code: chunk, responseCode: 550 });
    const out = describeFailure(err, []);
    expect(out.length).toBeLessThanOrEqual(6020);
    expect(out).toContain('\\u007f');
    expect(out).not.toContain('\u007f');
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
