/**
 * QR 字节模式：形状之外必须抓住 ISO 交织错误。
 *
 * 旧实现把 data+ECC 拼进同一数组再按列轮转，短块的 ECC 会插进长块
 * 尚未吐完的 data 之间。本文件用「规范期望序列」和「旧错误算法负例」
 * 对照，再用独立 de-interleave + RS remainder 证明可解。
 */
import { describe, expect, test } from 'bun:test';
import {
  addEccAndInterleave,
  encodeQrCodewords,
  encodeQrFunctionGrid,
  encodeQrModules,
  qrAlignmentPositions,
  qrRsPlan,
  qrRsRemainder,
} from '../src/lib/qr-byte.ts';

function cell(encoded: { size: number; modules: string }, x: number, y: number): string {
  return encoded.modules.charAt(y * encoded.size + x);
}

function splitDataBlocks(plan: ReturnType<typeof qrRsPlan>, data: number[]): number[][] {
  const blocks: number[][] = [];
  let i = 0;
  for (let b = 0; b < plan.numBlocks; b += 1) {
    const len = plan.shortDataLen + (b < plan.numShortBlocks ? 0 : 1);
    blocks.push(data.slice(i, i + len));
    i += len;
  }
  return blocks;
}

/** ISO：data 按列跨 block，短块缺席跳过。故意不调用生产交织函数。 */
function expectedDataInterleave(plan: ReturnType<typeof qrRsPlan>, data: number[]): number[] {
  const blocks = splitDataBlocks(plan, data);
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.length));
  for (let j = 0; j < maxData; j += 1) {
    for (const block of blocks) {
      if (j < block.length) out.push(block[j]!);
    }
  }
  return out;
}

/** Codex P1 指出的错误算法：data+ECC 拼块后再整列轮转。 */
function buggyConcatThenColumn(dataBlocks: number[][], eccBlocks: number[][]): number[] {
  const blocks = dataBlocks.map((data, i) => data.concat(eccBlocks[i]!));
  const out: number[] = [];
  const maxLen = Math.max(...blocks.map((block) => block.length));
  for (let j = 0; j < maxLen; j += 1) {
    for (const block of blocks) {
      if (j < block.length) out.push(block[j]!);
    }
  }
  return out;
}

/** 独立于编码器的 ISO de-interleave（先 data 列，再 ECC 列）。 */
function deinterleaveIso(plan: ReturnType<typeof qrRsPlan>, interleaved: number[]) {
  const dataLens = Array.from(
    { length: plan.numBlocks },
    (_, b) => plan.shortDataLen + (b < plan.numShortBlocks ? 0 : 1),
  );
  const dataBlocks = dataLens.map(() => [] as number[]);
  const eccBlocks = Array.from({ length: plan.numBlocks }, () => [] as number[]);
  let i = 0;
  const maxData = Math.max(...dataLens);
  for (let j = 0; j < maxData; j += 1) {
    for (let b = 0; b < plan.numBlocks; b += 1) {
      if (j < dataLens[b]!) dataBlocks[b]!.push(interleaved[i++]!);
    }
  }
  for (let j = 0; j < plan.eccPerBlock; j += 1) {
    for (let b = 0; b < plan.numBlocks; b += 1) {
      eccBlocks[b]!.push(interleaved[i++]!);
    }
  }
  expect(i).toBe(interleaved.length);
  expect(i).toBe(plan.rawCodewords);
  return { dataBlocks, eccBlocks };
}

function decodeByteMode(dataCodewords: number[], ver: number): string {
  const bits: number[] = [];
  for (const word of dataCodewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1);
  }
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bits[p++]!;
    return v;
  };
  expect(take(4)).toBe(0b0100);
  const len = take(ver <= 9 ? 8 : 16);
  const bytes: number[] = [];
  for (let i = 0; i < len; i += 1) bytes.push(take(8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const PAIRING_JSON = JSON.stringify({
  serverUrl: 'https://notify.test.example',
  username: 'phone-abcdefgh',
  password: 'abcdefghijklmnopqrstuvwx',
  topics: { userAlerts: 'user-alerts-xyzxyzxyz', userLow: 'user-low-xyzxyzxyz' },
});

describe('qr-byte', () => {
  test('short text is version 1 (21×21) with finder patterns', () => {
    const encoded = encodeQrModules('HELLO');
    expect(encoded.size).toBe(21);
    expect(encoded.modules.length).toBe(21 * 21);
    expect(cell(encoded, 0, 0)).toBe('1');
    expect(cell(encoded, 6, 0)).toBe('1');
    expect(cell(encoded, 0, 6)).toBe('1');
    expect(cell(encoded, 6, 6)).toBe('1');
    expect(cell(encoded, 2, 2)).toBe('1');
    expect(cell(encoded, 7, 0)).toBe('0');
    expect(cell(encoded, 8, 13)).toBe('1');
  });

  test('pairing-sized JSON fits under version 20 and is deterministic', () => {
    const a = encodeQrModules(PAIRING_JSON);
    const b = encodeQrModules(PAIRING_JSON);
    expect(a.size).toBe(b.size);
    expect(a.modules).toBe(b.modules);
    expect(a.size).toBeGreaterThanOrEqual(25);
    expect(a.size).toBeLessThanOrEqual(4 * 20 + 17);
    expect(a.modules.length).toBe(a.size * a.size);
    expect(a.modules).toMatch(/^[01]+$/);
  });

  test('version 9 ECC-M has unequal-length data blocks matching ISO tables', () => {
    const plan = qrRsPlan(9);
    expect(plan.numBlocks).toBe(5);
    expect(plan.eccPerBlock).toBe(22);
    expect(plan.rawCodewords).toBe(292);
    expect(plan.dataCodewords).toBe(182);
    expect(plan.numShortBlocks).toBe(3);
    expect(plan.shortDataLen).toBe(36);
    expect(plan.longDataLen).toBe(37);
    expect(plan.numShortBlocks * plan.shortDataLen + (plan.numBlocks - plan.numShortBlocks) * plan.longDataLen).toBe(
      plan.dataCodewords,
    );
    expect(plan.dataCodewords + plan.numBlocks * plan.eccPerBlock).toBe(plan.rawCodewords);
  });

  test('unequal-block interleave emits all data columns before any ECC (catches concat-then-column)', () => {
    const plan = qrRsPlan(9);
    expect(plan.shortDataLen).not.toBe(plan.longDataLen);
    const data = Array.from({ length: plan.dataCodewords }, (_, i) => i % 256);
    const interleaved = addEccAndInterleave(9, data);
    expect(interleaved).toHaveLength(plan.rawCodewords);

    const expectedData = expectedDataInterleave(plan, data);
    expect(interleaved.slice(0, plan.dataCodewords)).toEqual(expectedData);

    const dataBlocks = splitDataBlocks(plan, data);
    const eccBlocks = dataBlocks.map((block) => qrRsRemainder(block, plan.eccPerBlock));
    const buggy = buggyConcatThenColumn(dataBlocks, eccBlocks);
    expect(buggy).toHaveLength(plan.rawCodewords);
    expect(interleaved).not.toEqual(buggy);
    // 旧算法在短块 data 用尽后立刻吐 ECC，该位置规范应仍是长块 data。
    const firstEccInBuggy = plan.shortDataLen;
    expect(buggy[firstEccInBuggy * plan.numBlocks]).toEqual(eccBlocks[0]![0]);
    expect(interleaved[firstEccInBuggy * plan.numBlocks]).not.toEqual(eccBlocks[0]![0]);
  });

  test('ISO de-interleave plus RS remainder recovers pairing payload (version near 9)', () => {
    const encoded = encodeQrCodewords(PAIRING_JSON);
    const ver = encoded.ver;
    expect(ver).toBeGreaterThanOrEqual(8);
    expect(ver).toBeLessThanOrEqual(12);
    const plan = qrRsPlan(ver);
    expect(plan.numBlocks).toBeGreaterThan(1);
    expect(encoded.codewords).toHaveLength(plan.rawCodewords);

    const { dataBlocks, eccBlocks } = deinterleaveIso(plan, encoded.codewords);
    expect(dataBlocks.map((block) => block.length)).toEqual(
      Array.from({ length: plan.numBlocks }, (_, b) => plan.shortDataLen + (b < plan.numShortBlocks ? 0 : 1)),
    );
    expect(eccBlocks.every((block) => block.length === plan.eccPerBlock)).toBe(true);

    for (let b = 0; b < plan.numBlocks; b += 1) {
      expect(qrRsRemainder(dataBlocks[b]!, plan.eccPerBlock)).toEqual(eccBlocks[b]!);
    }

    const recovered = dataBlocks.flat();
    expect(decodeByteMode(recovered, ver)).toBe(PAIRING_JSON);
  });

  test('alignment bullseye overwrites timing except the three finder corners', () => {
    const ALIGN = [
      [1, 1, 1, 1, 1],
      [1, 0, 0, 0, 1],
      [1, 0, 1, 0, 1],
      [1, 0, 0, 0, 1],
      [1, 1, 1, 1, 1],
    ];
    const isAlignAt = (grid: { size: number; modules: string }, cx: number, cy: number): boolean => {
      if (cx < 2 || cy < 2 || cx > grid.size - 3 || cy > grid.size - 3) return false;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const got = grid.modules.charAt((cy + dy) * grid.size + (cx + dx));
          if (got !== String(ALIGN[dy + 2]![dx + 2])) return false;
        }
      }
      return true;
    };
    const isFinderCorner = (x: number, y: number, size: number): boolean =>
      (x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6);

    const assertLayout = (ver: number, grid: { size: number; modules: string; isFunc?: boolean[][] }) => {
      const size = grid.size;
      expect(size).toBe(ver * 4 + 17);
      const positions = qrAlignmentPositions(ver);
      expect(positions[0]).toBe(6);
      expect(positions[positions.length - 1]).toBe(size - 7);

      for (const y of positions) {
        for (const x of positions) {
          if (isFinderCorner(x, y, size)) expect(isAlignAt(grid, x, y)).toBe(false);
          else expect(isAlignAt(grid, x, y)).toBe(true);
        }
      }

      for (let i = 8; i < size - 8; i += 1) {
        const rowCovered = positions.some(
          (p) => !isFinderCorner(p, 6, size) && Math.abs(i - p) <= 2,
        );
        const colCovered = positions.some(
          (p) => !isFinderCorner(6, p, size) && Math.abs(i - p) <= 2,
        );
        if (!rowCovered) expect(cell(grid, i, 6)).toBe(i % 2 === 0 ? '1' : '0');
        if (!colCovered) expect(cell(grid, 6, i)).toBe(i % 2 === 0 ? '1' : '0');
        if (grid.isFunc) {
          expect(grid.isFunc[6]![i]).toBe(true);
          expect(grid.isFunc[i]![6]).toBe(true);
        }
      }

      if (grid.isFunc) {
        expect(grid.isFunc[size - 9]![7]).toBe(false);
        expect(grid.isFunc[7]![size - 9]).toBe(false);
      }
    };

    assertLayout(2, encodeQrFunctionGrid(2));
    expect(qrAlignmentPositions(2)).toEqual([6, 18]);
    expect(qrAlignmentPositions(7)).toContain(22);
    expect(qrAlignmentPositions(10)).toContain(28);
    for (const ver of [7, 10, 14]) {
      assertLayout(ver, encodeQrFunctionGrid(ver));
    }
    const pairing = encodeQrModules(PAIRING_JSON);
    const pairingVer = (pairing.size - 17) / 4;
    expect(pairingVer).toBeGreaterThanOrEqual(7);
    assertLayout(pairingVer, pairing);
  });
});
