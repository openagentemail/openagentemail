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
    // 留原始耗时到断言消息（必测留件）
    const msg =
      `L256 med=${r256.med.toFixed(2)} samples=[${r256.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r256.outLen}; ` +
      `L1024 med=${r1024.med.toFixed(2)} samples=[${r1024.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r1024.outLen}; ` +
      `L4096 med=${r4096.med.toFixed(2)} samples=[${r4096.samples.map((x) => x.toFixed(1)).join(',')}] outLen=${r4096.outLen}`;
    // 伸缩性：L 放大 16×（256→4096）时耗时不得按 Θ(n·L) 放大；宽裕倍数 K=20
    // （线性下期望 ~16× 量级以内；Θ(n·L) 回潮会远超）
    expect(r4096.med, msg).toBeLessThanOrEqual(20 * Math.max(r256.med, 1e-6));
    // 1024/256=4；宽裕 K=12
    expect(r1024.med, msg).toBeLessThanOrEqual(12 * Math.max(r256.med, 1e-6));
  });

  test('A1b：共振形态 ab×N 正文/口令 — 1024→4096 伸缩性', () => {
    const run = (rep: number, rounds = 5): number => {
      const sec = 'ab'.repeat(rep);
      const txt = 'ab'.repeat(rep);
      const samples: number[] = [];
      for (let i = 0; i < rounds; i++) {
        const t0 = performance.now();
        scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
        samples.push(performance.now() - t0);
      }
      return medianMs(samples);
    };
    const med1k = run(1024);
    const med4k = run(4096);
    const msg = `ab×4096 med=${med4k.toFixed(2)} ab×1024 med=${med1k.toFixed(2)}`;
    // 规模比 4；宽裕 K=12（抓 Θ(n·L) 回潮）
    expect(med4k, msg).toBeLessThanOrEqual(12 * Math.max(med1k, 1e-6));
  });

  test('A3：尾部全 a — 输出与耗时；R9 尾前缀不变量', () => {
    const L = 1024;
    const sec = 'a'.repeat(L) + 'b';
    const txt = 'a'.repeat(4096);
    const t0 = performance.now();
    const out = scrubPayload(txt, [sec], DESCRIBE_FAILURE_STACK_MAX, 'block');
    const ms = performance.now() - t0;
    // 尾退削掉真前缀 ⇒ 全 a 被削空（与探针债1 行为一致）
    expect(out, `ms=${ms.toFixed(2)} out=${JSON.stringify(out.slice(0, 40))}`).toBe('');
    // 短对照伸缩：n=512 vs n=4096，宽裕 K=20
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
});
