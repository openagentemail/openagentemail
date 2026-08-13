/**
 * 字节模式 QR（ECC M，版本 1–20）。仅用于一次性配对 payload，零运行依赖。
 * 算法对齐 ISO/IEC 18004 与 Nayuki QR-Code-generator（MIT）的公开表。
 */

export type QrModules = {
  size: number;
  /** 行优先 0/1 字符串，长度 = size*size；1 = 黑模块。 */
  modules: string;
};

const MAX_VERSION = 20;
/** ECC-M：每块纠错码字数（下标=版本）。 */
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];
/** ECC-M：纠错块数。 */
const ECC_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** 测试缝：ISO 原始数据模块数（非功能格）。 */
export function qrNumRawDataModules(ver: number): number {
  return getNumRawDataModules(ver);
}

function getNumDataCodewords(ver: number): number {
  return Math.floor(getNumRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver]! * ECC_BLOCKS[ver]!;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = reedSolomonMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) {
      result[i]! ^= reedSolomonMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

function getAlignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10, i = 0; i < numAlign - 1; i += 1, pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/** 测试缝：ISO 表 alignment 中心坐标（含 6）。 */
export function qrAlignmentPositions(ver: number): number[] {
  return getAlignmentPositions(ver);
}

class BitBuffer {
  bits: number[] = [];
  append(val: number, len: number): void {
    for (let i = len - 1; i >= 0; i -= 1) this.bits.push((val >>> i) & 1);
  }
}

function addFinder(modules: number[][], isFunc: boolean[][], ox: number, oy: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = ox + dx;
      const y = oy + dy;
      if (x < 0 || y < 0 || x >= modules.length || y >= modules.length) continue;
      isFunc[y]![x] = true;
      const dark =
        (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
        (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      modules[y]![x] = dark ? 1 : 0;
    }
  }
}

function addAlignment(modules: number[][], isFunc: boolean[][], ox: number, oy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const x = ox + dx;
      const y = oy + dy;
      isFunc[y]![x] = true;
      modules[y]![x] = dx === -2 || dx === 2 || dy === -2 || dy === 2 || (dx === 0 && dy === 0) ? 1 : 0;
    }
  }
}

function addTiming(modules: number[][], isFunc: boolean[][]): void {
  const size = modules.length;
  for (let i = 8; i < size - 8; i += 1) {
    modules[6]![i] = i % 2 === 0 ? 1 : 0;
    modules[i]![6] = i % 2 === 0 ? 1 : 0;
    isFunc[6]![i] = true;
    isFunc[i]![6] = true;
  }
}

/**
 * ISO/IEC 18004：finder + timing 先铺，alignment 后画并覆盖 timing。
 * 只省略三个 finder 重叠角；(6,y)/(x,6) 的其余组合必须画出完整 bullseye。
 */
function placeFunctionPatterns(modules: number[][], isFunc: boolean[][], ver: number): void {
  const size = modules.length;
  addFinder(modules, isFunc, 0, 0);
  addFinder(modules, isFunc, size - 7, 0);
  addFinder(modules, isFunc, 0, size - 7);
  addTiming(modules, isFunc);
  for (const y of getAlignmentPositions(ver)) {
    for (const x of getAlignmentPositions(ver)) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
      addAlignment(modules, isFunc, x, y);
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function drawFormat(modules: number[][], isFunc: boolean[][], mask: number): void {
  // ECC-M = 00b；格式信息 BCH(15,5)
  let data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = modules.length;
  for (let i = 0; i <= 14; i += 1) {
    const bit = (bits >>> i) & 1;
    if (i < 6) {
      modules[8]![i] = bit;
      isFunc[8]![i] = true;
    } else if (i < 8) {
      modules[8]![i + 1] = bit;
      isFunc[8]![i + 1] = true;
    } else if (i < 9) {
      modules[7]![8] = bit;
      isFunc[7]![8] = true;
    } else {
      modules[14 - i]![8] = bit;
      isFunc[14 - i]![8] = true;
    }
    if (i < 8) {
      modules[size - 1 - i]![8] = bit;
      isFunc[size - 1 - i]![8] = true;
    } else {
      modules[8]![size - 15 + i] = bit;
      isFunc[8]![size - 15 + i] = true;
    }
  }
  modules[size - 8]![8] = 1;
  isFunc[size - 8]![8] = true;
}

function drawVersion(modules: number[][], isFunc: boolean[][], ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  const size = modules.length;
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a]![b] = bit;
    isFunc[a]![b] = true;
    modules[b]![a] = bit;
    isFunc[b]![a] = true;
  }
}

function penalty(modules: number[][]): number {
  const size = modules.length;
  let score = 0;
  for (let y = 0; y < size; y += 1) {
    let run = 0;
    let color = -1;
    for (let x = 0; x < size; x += 1) {
      if (modules[y]![x] === color) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        color = modules[y]![x]!;
        run = 1;
      }
    }
  }
  for (let x = 0; x < size; x += 1) {
    let run = 0;
    let color = -1;
    for (let y = 0; y < size; y += 1) {
      if (modules[y]![x] === color) {
        run += 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        color = modules[y]![x]!;
        run = 1;
      }
    }
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = modules[y]![x]!;
      if (v === modules[y]![x + 1] && v === modules[y + 1]![x] && v === modules[y + 1]![x + 1]) score += 3;
    }
  }
  const finder = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const finderRev = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (row: number[], start: number, pat: number[]) => {
    for (let i = 0; i < pat.length; i += 1) if (row[start + i] !== pat[i]) return false;
    return true;
  };
  for (let y = 0; y < size; y += 1) {
    const row = modules[y]!;
    for (let x = 0; x <= size - 11; x += 1) {
      if (match(row, x, finder) || match(row, x, finderRev)) score += 40;
    }
  }
  for (let x = 0; x < size; x += 1) {
    const col = modules.map((row) => row[x]!);
    for (let y = 0; y <= size - 11; y += 1) {
      if (match(col, y, finder) || match(col, y, finderRev)) score += 40;
    }
  }
  let dark = 0;
  for (const row of modules) for (const cell of row) dark += cell;
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += k * 10;
  return score;
}

/** ISO/IEC 18004 ECC-M 分块计划（测试与交织共用）。 */
export type QrRsPlan = {
  ver: number;
  numBlocks: number;
  eccPerBlock: number;
  dataCodewords: number;
  rawCodewords: number;
  numShortBlocks: number;
  shortDataLen: number;
  longDataLen: number;
};

export function qrRsPlan(ver: number): QrRsPlan {
  const numBlocks = ECC_BLOCKS[ver]!;
  const eccPerBlock = ECC_PER_BLOCK[ver]!;
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
  const dataCodewords = rawCodewords - eccPerBlock * numBlocks;
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortDataLen = Math.floor(dataCodewords / numBlocks);
  return {
    ver,
    numBlocks,
    eccPerBlock,
    dataCodewords,
    rawCodewords,
    numShortBlocks,
    shortDataLen,
    longDataLen: shortDataLen + (numShortBlocks === numBlocks ? 0 : 1),
  };
}

/**
 * ISO/IEC 18004 8.6：先按列跨 block 轮转 data（短块缺席位置跳过），
 * 全部 data 吐完后再按列跨 block 轮转 ECC。不得把短块 ECC 与长块尾部 data 编进同一列。
 */
export function addEccAndInterleave(ver: number, data: number[]): number[] {
  const plan = qrRsPlan(ver);
  if (data.length !== plan.dataCodewords) {
    throw new Error('qr_data_length');
  }
  const divisor = reedSolomonDivisor(plan.eccPerBlock);
  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let i = 0;
  for (let b = 0; b < plan.numBlocks; b += 1) {
    const len = plan.shortDataLen + (b < plan.numShortBlocks ? 0 : 1);
    const block = data.slice(i, i + len);
    i += len;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }
  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let j = 0; j < maxData; j += 1) {
    for (const block of dataBlocks) {
      if (j < block.length) result.push(block[j]!);
    }
  }
  for (let j = 0; j < plan.eccPerBlock; j += 1) {
    for (const block of eccBlocks) {
      result.push(block[j]!);
    }
  }
  return result;
}

/** 供测试校验：对 data 块再算一次 RS remainder。 */
export function qrRsRemainder(data: number[], eccLen: number): number[] {
  return reedSolomonRemainder(data, reedSolomonDivisor(eccLen));
}

function drawData(modules: number[][], isFunc: boolean[][], data: number[]): void {
  const size = modules.length;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunc[y]![x]) continue;
        let dark = 0;
        if (bit < data.length * 8) {
          dark = (data[bit >>> 3]! >>> (7 - (bit & 7))) & 1;
          bit += 1;
        }
        modules[y]![x] = dark;
      }
    }
  }
}

function applyMask(modules: number[][], isFunc: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunc[y]![x] && maskBit(mask, x, y)) modules[y]![x]! ^= 1;
    }
  }
}

function encodeBytes(data: Uint8Array): { ver: number; codewords: number[] } {
  let ver = 1;
  for (; ver <= MAX_VERSION; ver += 1) {
    const ccBits = ver <= 9 ? 8 : 16;
    const capacity = getNumDataCodewords(ver) * 8;
    const need = 4 + ccBits + data.length * 8;
    if (need <= capacity) break;
  }
  if (ver > MAX_VERSION) throw new Error('qr_payload_too_long');
  const bb = new BitBuffer();
  bb.append(0b0100, 4);
  bb.append(data.length, ver <= 9 ? 8 : 16);
  for (const b of data) bb.append(b, 8);
  const capacity = getNumDataCodewords(ver) * 8;
  const term = Math.min(4, capacity - bb.bits.length);
  bb.append(0, term);
  while (bb.bits.length % 8 !== 0) bb.append(0, 1);
  const padBytes = [0xec, 0x11];
  let pad = 0;
  while (bb.bits.length < capacity) {
    bb.append(padBytes[pad % 2]!, 8);
    pad += 1;
  }
  const codewords: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j += 1) v = (v << 1) | bb.bits[i + j]!;
    codewords.push(v);
  }
  return { ver, codewords: addEccAndInterleave(ver, codewords) };
}

/** 测试缝：返回选定版本与交织后的 codeword 流（含 ECC）。 */
export function encodeQrCodewords(text: string): { ver: number; codewords: number[] } {
  return encodeBytes(new TextEncoder().encode(text));
}

function buildModules(ver: number, codewords: number[]): number[][] {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const isFunc = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  placeFunctionPatterns(modules, isFunc, ver);
  drawFormat(modules, isFunc, 0);
  drawVersion(modules, isFunc, ver);
  drawData(modules, isFunc, codewords);
  let bestMask = 0;
  let bestScore = Infinity;
  const clone = () => modules.map((row) => row.slice());
  const funcClone = isFunc.map((row) => row.slice());
  for (let mask = 0; mask < 8; mask += 1) {
    const trial = clone();
    const func = funcClone.map((row) => row.slice());
    applyMask(trial, func, mask);
    drawFormat(trial, func, mask);
    const score = penalty(trial);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
    }
  }
  applyMask(modules, isFunc, bestMask);
  drawFormat(modules, isFunc, bestMask);
  return modules;
}

/** 测试缝：只铺功能模块（无 data/mask），供 v7+ 位图断言。 */
export function encodeQrFunctionGrid(ver: number): {
  size: number;
  modules: string;
  isFunc: boolean[][];
} {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const isFunc = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  placeFunctionPatterns(modules, isFunc, ver);
  drawFormat(modules, isFunc, 0);
  drawVersion(modules, isFunc, ver);
  return {
    size,
    modules: modules.map((row) => row.join('')).join(''),
    isFunc,
  };
}

/** 把 UTF-8 文本编成 QR 模块图（ECC M）。 */
export function encodeQrModules(text: string): QrModules {
  const bytes = new TextEncoder().encode(text);
  const { ver, codewords } = encodeBytes(bytes);
  const grid = buildModules(ver, codewords);
  return {
    size: grid.length,
    modules: grid.map((row) => row.join('')).join(''),
  };
}
