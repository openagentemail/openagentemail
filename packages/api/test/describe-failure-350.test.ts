/**
 * #350：scrubPayload 余债收口 — A 失败链线性化 / B 单码元转义钥 / 不误伤。
 * 行为回归沿用 #348 套件；本文件补性能伸缩性与 B 面逐条。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'oae-350-'));

const {
  scrubPayload,
  describeFailure,
  DESCRIBE_FAILURE_STACK_MAX,
} = await import('../src/lib/redact.ts');

/** 取中位数（毫秒） */
function medianMs(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('scrubPayload · #350 A/B', () => {
  // —— A：病态失败回放线性化（伸缩性判据，禁绝对墙钟）———————

  test('A1：口令 a×L+b + 正文全 a；L=256/1024/4096 近线性（中位数伸缩）', () => {
    // 构造：secret='a'×L+'b'；text='a'×8192；mode=block；limit=8204
    const n = 8192;
    const run = (L: number, rounds = 5): { med: number; samples: number[]; outLen: number } => {
      const sec = 'a'.repeat(L) + 'b';
      const txt = 'a'.repeat(n);
      const samples: number[] = [];
      let outLen = -1;
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        const out = scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
        samples.push(performance.now() - t0);
        if (i === 0) outLen = out.length;
      }
      return { med: medianMs(samples), samples, outLen };
    };
    const r256 = run(256);
    const r1024 = run(1024);
    const r4096 = run(4096);
    const msg =
      `L256 med=${r256.med.toFixed(2)} samples=[${r256.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r256.outLen}; ` +
      `L1024 med=${r1024.med.toFixed(2)} samples=[${r1024.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r1024.outLen}; ` +
      `L4096 med=${r4096.med.toFixed(2)} samples=[${r4096.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r4096.outLen}`;
    expect(r4096.med, msg).toBeLessThanOrEqual(20 * Math.max(r256.med, 1e-6));
    expect(r1024.med, msg).toBeLessThanOrEqual(12 * Math.max(r256.med, 1e-6));
  });

  test('A1-period：密钥 ab×k × 文本 ab×4095+c（ZCode/FC 周期共振精确构造）', () => {
    // 构造：secret='ab'×k；text='ab'×4095+'c'（len=8191）；mode=block；limit=8204
    const txt = 'ab'.repeat(4095) + 'c';
    const run = (k: number, rounds = 5): number => {
      const sec = 'ab'.repeat(k);
      const samples: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
        samples.push(performance.now() - t0);
      }
      return medianMs(samples);
    };
    const m64 = run(64);
    const m1024 = run(1024);
    const m4096 = run(4096);
    const msg = `k64=${m64.toFixed(2)} k1024=${m1024.toFixed(2)} k4096=${m4096.toFixed(2)} textLen=${txt.length}`;
    // 主判据：1024→4096（×4），K=12；k=64 过短易被固定开销主导，只留原始耗时
    expect(m4096, msg).toBeLessThanOrEqual(12 * Math.max(m1024, 1e-6));
    // 辅判据：64→4096 不得呈 Θ(n²)（原 ~2000ms）；宽裕 K=100 覆盖 O(|s|) 建 trie
    expect(m4096, msg).toBeLessThanOrEqual(100 * Math.max(m64, 1e-6));
  });

  test('A1-period-n：固定密钥 ab×4096 × 文本 ab×reps+c 伸缩', () => {
    // 构造：secret='ab'×4096；text='ab'×reps+'c'；reps∈{256,1024,4095}
    const sec = 'ab'.repeat(4096);
    const run = (reps: number, rounds = 5): number => {
      const txt = 'ab'.repeat(reps) + 'c';
      const samples: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
        samples.push(performance.now() - t0);
      }
      return medianMs(samples);
    };
    const m256 = run(256);
    const m1024 = run(1024);
    const m4095 = run(4095);
    const msg = `reps256=${m256.toFixed(2)} reps1024=${m1024.toFixed(2)} reps4095=${m4095.toFixed(2)}`;
    // 文本规模约 16×（513→8191）；K=20
    expect(m4095, msg).toBeLessThanOrEqual(20 * Math.max(m256, 1e-6));
  });

  test('A3-tail-leg：a+b×(L−1) / a+c×(L−1) × 文本 a×8192', () => {
    // 构造：secret='a'+'b'×(L-1) 或 'a'+'c'×(L-1)；text='a'×8192；mode=block；limit=8204
    const txt = 'a'.repeat(8192);
    const run = (filler: string, L: number, rounds = 5): number => {
      const sec = 'a' + filler.repeat(L - 1);
      const samples: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
        samples.push(performance.now() - t0);
      }
      return medianMs(samples);
    };
    const b1024 = run('b', 1024);
    const b4096 = run('b', 4096);
    const b8192 = run('b', 8192);
    const c1024 = run('c', 1024);
    const c8192 = run('c', 8192);
    const msg =
      `a+b:1024=${b1024.toFixed(2)} 4096=${b4096.toFixed(2)} 8192=${b8192.toFixed(2)}; ` +
      `a+c:1024=${c1024.toFixed(2)} 8192=${c8192.toFixed(2)}`;
    // L×8；K=20
    expect(b8192, msg).toBeLessThanOrEqual(20 * Math.max(b1024, 1e-6));
    expect(c8192, msg).toBeLessThanOrEqual(20 * Math.max(c1024, 1e-6));
  });

  test('A3：尾部全 a（自重叠口令）— 输出与耗时；R9 尾前缀不变量', () => {
    const L = 1024;
    const sec = 'a'.repeat(L) + 'b';
    const txt = 'a'.repeat(4096);
    const t0 = performance.now();
    const out = scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
    const ms = performance.now() - t0;
    expect(out, `ms=${ms.toFixed(2)} out=${JSON.stringify(out.slice(0, 40))}`).toBe('');
    const tShort0 = performance.now();
    scrubPayload('a'.repeat(512), [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
    const msShort = performance.now() - tShort0;
    expect(ms, `ms=${ms.toFixed(2)} msShort=${msShort.toFixed(2)}`).toBeLessThanOrEqual(
      20 * Math.max(msShort, 1e-6),
    );
  });

  // —— B：单码元密钥的转义形态被红 + 不误伤 ——————————————

  test('B：换行口令 — 字面 \\n 被红', () => {
    const text = 'line1' + '\\' + 'nline2';
    const out = scrubPayload(text, ['\n'], 6002, 'line');
    expect(out, `out=${JSON.stringify(out)}`).not.toContain('\\n');
    expect(out).toContain('[redacted]');
  });

  test('B：\\r / \\t 口令 — 字面转义形态被红', () => {
    expect(scrubPayload('a\\rb', ['\r'], 6002, 'line')).not.toContain('\\r');
    expect(scrubPayload('a\\tb', ['\t'], 6002, 'line')).not.toContain('\\t');
  });

  test('B：单 C0（U+0001）— 字面 \\u0001 被红', () => {
    const out = scrubPayload('pre\\u0001suf', ['\u0001'], 6002, 'line');
    expect(out).not.toContain('\\u0001');
    expect(out).toContain('[redacted]');
  });

  test('B：单 C1（DEL U+007F）— 字面 \\u007f 被红', () => {
    const out = scrubPayload('x\\u007fy', ['\u007f'], 6002, 'line');
    expect(out.toLowerCase()).not.toContain('\\u007f');
    expect(out).toContain('[redacted]');
  });

  test('B：单 bidi（U+202A）— 字面 \\u202a 被红', () => {
    const out = scrubPayload('x\\u202ay', ['\u202a'], 6002, 'line');
    expect(out.toLowerCase()).not.toContain('\\u202a');
    expect(out).toContain('[redacted]');
  });

  test('B：U+2028 / U+2029 — 字面转义被红', () => {
    expect(scrubPayload('a\\u2028b', ['\u2028'], 6002, 'line').toLowerCase()).not.toContain(
      '\\u2028',
    );
    expect(scrubPayload('a\\u2029b', ['\u2029'], 6002, 'line').toLowerCase()).not.toContain(
      '\\u2029',
    );
  });

  test('B 不误伤：口令=换行时，尾部普通词不得被削', () => {
    // 正文以普通词结尾（非转义真前缀）⇒ 保留
    const out = scrubPayload('hello world', ['\n'], 6002, 'line');
    expect(out).toBe('hello world');
    // 尾部普通字符
    const out2 = describeFailure(new Error('ok-tail-z'), ['\n']);
    expect(out2.endsWith('z')).toBe(true);
    expect(out2).toContain('ok-tail-z');
  });

  test('B 副作用：口令=换行时尾部孤立 \\ 可被削（有意；转义真前缀）', () => {
    // esc('\\n') 的真前缀为 '\' —— 尾部单反斜杠按裁点③有意削掉
    const out = scrubPayload('body\\', ['\n'], 6002, 'line');
    expect(out.endsWith('\\')).toBe(false);
    expect(out).toBe('body');
  });

  // —— ZCode P3-1：describeFailure join 后整串终检 ——————————

  test('P3-1 正控：join 跨字段拼出完整密钥 ⇒ 回退空串（R4 族）', () => {
    // 构造（可达）：密钥以空格开头「 b」；code=' ' 为真前缀 ⇒ 单字段尾削成 ''；
    // message='b' 自身不成完整钥；join(' ') ⇒ ' b'＝完整密钥 ⇒ 终检命中。
    // （经典「ESE cret」在 R2 尾削下 join 结果为「 cret」≠密钥，故另选此前缀形态。）
    const secret = ' b';
    const err = Object.assign(new Error('b'), { code: ' ' });
    const out = describeFailure(err, [secret]);
    expect(out, `out=${JSON.stringify(out)}`).toBe('');
    expect(out).not.toContain(secret);
  });

  test('P3-1 负控：正常三字段不得被误回退', () => {
    const err = Object.assign(new Error('boom-message-ok'), {
      code: 'ECONNRESET',
      responseCode: 550,
    });
    const out = describeFailure(err, ['unrelated-secret-xyz']);
    expect(out).toContain('ECONNRESET');
    expect(out).toContain('550');
    expect(out).toContain('boom-message-ok');
    expect(out).not.toBe('');
    expect(out).not.toBe('[unreadable]');
  });

  test('P3-1 负控：长 message 有界且不误回退', () => {
    const err = Object.assign(new Error('m'.repeat(500)), {
      code: 'c'.repeat(50),
      responseCode: 421,
    });
    const out = describeFailure(err, ['no-match-secret']);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('');
    expect(out).toContain('421');
    expect(out.length).toBeLessThanOrEqual(6002);
  });
});
