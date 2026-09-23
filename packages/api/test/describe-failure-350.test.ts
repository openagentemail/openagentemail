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
  redactField,
  redactSecrets,
  escapeLine,
  escapeBlock,
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
    // 判据重校（R2）：弃用 k=64 作锚（固定开销主导，全量负载下 K=100 结构性误判）。
    // 改以量级可比档 k=1024↔4096 交错采样取中位数；主判据 ×4 规模 K=12；
    // 绊线：旧病态 ~2000ms 不得复现（宽裕绝对上界兜底，非唯一判据）。
    const txt = 'ab'.repeat(4095) + 'c';
    const sec1024 = 'ab'.repeat(1024);
    const sec4096 = 'ab'.repeat(4096);
    const samples1024: number[] = [];
    const samples4096: number[] = [];
    // 交错采样：同轮交替测两档，消除全量套件下的漂移
    for (let i = 0; i < 7; i++) {
      let t0 = performance.now();
      scrubPayload(txt, [sec1024], DESCRIBE_FAILURE_STACK_MAX, 'block');
      samples1024.push(performance.now() - t0);
      t0 = performance.now();
      scrubPayload(txt, [sec4096], DESCRIBE_FAILURE_STACK_MAX, 'block');
      samples4096.push(performance.now() - t0);
    }
    const m1024 = medianMs(samples1024);
    const m4096 = medianMs(samples4096);
    // 报告档（不作比率锚）：顺带采一次 k=64，便于证据对照
    const t64 = performance.now();
    scrubPayload(txt, ['ab'.repeat(64)], DESCRIBE_FAILURE_STACK_MAX, 'block');
    const k64Once = performance.now() - t64;
    const msg =
      `k64_once=${k64Once.toFixed(2)} k1024=${m1024.toFixed(2)} k4096=${m4096.toFixed(2)} ` +
      `textLen=${txt.length} samples1024=[${samples1024.map((x) => x.toFixed(1)).join(',')}] ` +
      `samples4096=[${samples4096.map((x) => x.toFixed(1)).join(',')}]`;
    // 主判据：量级可比档 ×4（1024→4096），K=12
    expect(m4096, msg).toBeLessThanOrEqual(12 * Math.max(m1024, 1e-6));
    // 绊线：旧 Θ(n²) 病态 ~2000ms；宽裕上界兜底（非唯一判据）
    expect(m4096, msg).toBeLessThan(500);
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

  // —— R3：Codex P1 确切构造 + 差分不变量 ——————————

  test('R3 P1-1：fail 链落到已完成密钥 — babc / babcbabx（基线对照）', () => {
    // FC 亲核：基线 ec3a871f ⇒ b[redacted]c / b[redacted]c[redacted]；
    // 回归头曾漏红（babc 原文 / scrub 靠 ⑦ 降空）
    expect(redactField('babc', ['ab', 'babx'])).toBe('b[redacted]c');
    expect(redactSecrets('babc', ['ab', 'babx'])).toBe('b[redacted]c');
    expect(redactField('babcbabx', ['ab', 'babx'])).toBe('b[redacted]c[redacted]');
    expect(scrubPayload('babc', ['ab', 'babx'], 8204, 'block')).toBe('b[redacted]c');
  });

  test('R3 P1-2：尾退失配跳跃不得漏检转义真前缀', () => {
    // FC 确切构造：密钥 '\\u0001abcdefF'；mode=block；limit=26；
    // 载荷 "xxx\\x\\u0001abcQ" ⇒ 基线削成 "xxx\\x…[truncated]"（尾非转义真前缀）
    const sec = '\u0001abcdefF';
    const payload = 'xxx\\x\\u0001abcQ';
    const out = scrubPayload(payload, [sec], 26, 'block');
    expect(out, `out=${JSON.stringify(out)}`).toBe('xxx\\x…[truncated]');
    const body = out.endsWith('…[truncated]') ? out.slice(0, -'…[truncated]'.length) : out;
    const escSec = escapeBlock(sec);
    // 正文尾不得为转义钥真前缀
    for (let len = 1; len < escSec.length; len++) {
      expect(body.endsWith(escSec.slice(0, len)), `escPrefix len=${len}`).toBe(false);
    }
  });

  test('R3 差分不变量：语料上 redact/scrub ≥ 基线契约', () => {
    // 形状覆盖：重叠 / 多密钥 / 长短前缀 / 周期共振 / 单码元 / B 转义 / 截断边界
    const MARK = '…[truncated]';
    /** 输出不含任何完整密钥（原文族；忽略 [redacted] 占位内的偶然子串） */
    const noFullSecret = (out: string, secrets: string[]): void => {
      const plain = out.split('[redacted]').join('');
      for (const s of secrets) {
        if (!s) continue;
        expect(
          plain.includes(s),
          `full secret leaked: ${JSON.stringify(s)} in ${JSON.stringify(out)}`,
        ).toBe(false);
      }
    };
    /** 尾部（除固定 MARK）不构成任何密钥真前缀（原文 ∪ 转义） */
    const noTailProperPrefix = (
      out: string,
      secrets: string[],
      mode: 'line' | 'block',
    ): void => {
      const body = out.endsWith(MARK) ? out.slice(0, -MARK.length) : out;
      if (!body) return;
      const escFn = mode === 'line' ? escapeLine : escapeBlock;
      for (const s of secrets) {
        if (!s) continue;
        const esc = escFn(s);
        // 原文与转义整钥均查真前缀（单码元原文无真前缀；其转义形态仍须查）
        for (const cand of s === esc ? [s] : [s, esc]) {
          if (cand.length < 2) continue;
          const maxLen = Math.min(cand.length - 1, body.length);
          for (let len = 1; len <= maxLen; len++) {
            expect(
              body.endsWith(cand.slice(0, len)),
              `tail proper prefix len=${len} cand=${JSON.stringify(cand.slice(0, len))} bodyTail=${JSON.stringify(body.slice(-Math.min(40, body.length)))}`,
            ).toBe(false);
          }
        }
      }
    };

    type Case = {
      label: string;
      text: string;
      secrets: string[];
      mode?: 'line' | 'block';
      limit?: number;
    };
    const cases: Case[] = [
      // 重叠匹配（ORDER / foobar）
      { label: 'overlap-aaaba', text: 'aaaba', secrets: ['aa', 'aaabb'] },
      { label: 'overlap-abcxabc', text: 'abcxabc', secrets: ['abc'] },
      { label: 'overlap-foobarbar', text: 'foobarbar', secrets: ['foo', 'bar', 'foobar'] },
      // 多密钥 + fail 链完成节点（P1-1）
      { label: 'multi-babc', text: 'babc', secrets: ['ab', 'babx'] },
      { label: 'multi-babcbabx', text: 'babcbabx', secrets: ['ab', 'babx'] },
      // 长短密钥前缀关系（避免单码元与 [redacted] 子串撞车的伪阳性）
      { label: 'prefix-ab-abcd', text: 'xxabcdyy', secrets: ['ab', 'abcd'] },
      { label: 'prefix-xy-xyz', text: 'zxyxyzx', secrets: ['xy', 'xyz'] },
      // 周期共振
      { label: 'period-ab', text: 'ab'.repeat(32) + 'c', secrets: ['ab'.repeat(8)] },
      // 单码元 / B 转义形态
      { label: 'unit-lf-esc', text: 'line1\\nline2', secrets: ['\n'], mode: 'line', limit: 6002 },
      { label: 'unit-c0-esc', text: 'pre\\u0001suf', secrets: ['\u0001'], mode: 'line', limit: 6002 },
      // 截断边界（P1-2 形态）
      {
        label: 'trunc-esc-prefix',
        text: 'xxx\\x\\u0001abcQ',
        secrets: ['\u0001abcdefF'],
        mode: 'block',
        limit: 26,
      },
      {
        label: 'trunc-self-a',
        text: 'a'.repeat(40),
        secrets: ['a'.repeat(8) + 'b'],
        mode: 'block',
        limit: 26,
      },
    ];

    for (const c of cases) {
      const mode = c.mode ?? 'block';
      const limit = c.limit ?? 8204;
      const fieldOut = redactField(c.text, c.secrets);
      noFullSecret(fieldOut, c.secrets);
      const secretsOut = redactSecrets(c.text, c.secrets);
      expect(secretsOut).toBe(fieldOut);
      noFullSecret(secretsOut, c.secrets);

      const scrubbed = scrubPayload(c.text, c.secrets, limit, mode);
      noFullSecret(scrubbed, c.secrets);
      noTailProperPrefix(scrubbed, c.secrets, mode);
      // 不得靠 ⑦ 把本可保留诊断的行整段降空（P1-1 scrub 回归）
      if (c.label === 'multi-babc') {
        expect(scrubbed, 'scrub babc must keep baseline shape').toBe('b[redacted]c');
      }
    }
  });

  // —— ZCode P3-1：describeFailure join 后整串终检 ——————————

  test('P3-1 正控：join 跨字段拼出完整密钥 ⇒ 回退空串（R4 族）', () => {
    // 构造（可达）：密钥以空格开头「 b」；code=' ' 为真前缀 ⇒ 单字段尾削成 ''；
    // message='b' 自身不成完整钥；join(' ') ⇒ ' b'＝完整密钥 ⇒ 终检命中。
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
