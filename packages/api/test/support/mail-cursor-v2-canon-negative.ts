/**
 * 真实一处改写负控：复制现行 mail-cursor.ts，只把
 * `const normalized = BigInt(value).toString();` 改成 `const normalized = value;`，
 * 再对副本跑前导零必须收成 "17"。副本应变红（exitCode 2）。
 * 禁止手写假 canonicalize 替代。
 * 禁止在 try 内 process.exit：会跳过 finally、泄漏 oae-canon-neg 临时目录。
 * 只设 exitCode，finally 删目录后再自然结束。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../src/lib/mail-cursor.ts');
const NEEDLE = 'const normalized = BigInt(value).toString();';
const REPLACEMENT = 'const normalized = value;';

let exitCode = 3;
let dir: string | undefined;
try {
  const source = readFileSync(SRC, 'utf8');
  const hits = source.split(NEEDLE).length - 1;
  if (hits !== 1) {
    console.error(`NEEDLE_COUNT_${hits}`);
    exitCode = 3;
  } else {
    const mutated = source.replace(NEEDLE, REPLACEMENT);
    if (mutated === source) {
      console.error('MUTATION_NOOP');
      exitCode = 3;
    } else {
      dir = mkdtempSync(join(tmpdir(), 'oae-canon-neg-'));
      // 先打印真实负控目录，供父断言「此路径已删」，不是只查 isolate dataDir。
      console.error(`NEG_TEMP=${dir}`);
      writeFileSync(join(dir, 'mail-cursor.ts'), mutated);
      const { canonicalizeMailUidValidity } = await import(join(dir, 'mail-cursor.ts'));
      const got = canonicalizeMailUidValidity('00017');
      if (got === '17') {
        console.error('NEGATIVE_MISS: still canonical after one-change');
        exitCode = 4;
      } else {
        console.error(`NEGATIVE_HIT: leading-zero stayed ${JSON.stringify(got)}`);
        exitCode = 2;
      }
    }
  }
} finally {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exitCode = exitCode;
