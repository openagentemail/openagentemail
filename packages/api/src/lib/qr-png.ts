/**
 * 把 QR 模块图渲成带 quiet zone 的 PNG（真扫码验证用）。
 */
import { deflateSync } from 'node:zlib';

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, 'ascii');
  const crcBuf = Buffer.concat([header.subarray(4, 8), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([header, data, crc]);
}

/** ISO quiet zone 4 模块；scale 为每模块像素。 */
export function qrModulesToPng(
  size: number,
  modules: string,
  options: { scale?: number; quiet?: number } = {},
): Buffer {
  if (modules.length !== size * size) throw new Error('qr_png_size');
  const scale = options.scale ?? 8;
  const quiet = options.quiet ?? 4;
  const dim = (size + quiet * 2) * scale;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const rows: Buffer[] = [];
  for (let py = 0; py < dim; py += 1) {
    const row = Buffer.alloc(1 + dim, 255);
    row[0] = 0;
    const my = Math.floor(py / scale) - quiet;
    if (my >= 0 && my < size) {
      for (let px = 0; px < dim; px += 1) {
        const mx = Math.floor(px / scale) - quiet;
        if (mx >= 0 && mx < size && modules.charAt(my * size + mx) === '1') row[1 + px] = 0;
      }
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
