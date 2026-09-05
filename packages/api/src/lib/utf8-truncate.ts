/**
 * 按字节上限截断 Buffer，且不切开 UTF-8 多字节序列。
 * 落在续字节中间时回退到该字符的 leading byte 之前，避免 U+FFFD。
 */

function utf8CharLen(lead: number): number {
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

/** 返回不超过 maxBytes 的前缀；若 buf 更短则原样返回。 */
export function truncateUtf8Bytes(buf: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // 从切点前回退过续字节，落到该字符的 leading byte 之后
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const leadIndex = end - 1;
    const need = utf8CharLen(buf[leadIndex]);
    if (leadIndex + need > maxBytes) return buf.subarray(0, leadIndex);
  }
  return buf.subarray(0, maxBytes);
}

/** Truncate to at most `maxChars` Unicode code points (`[...str]`). */
export function truncateUtf8Codepoints(str: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const units = [...str];
  if (units.length <= maxChars) return str;
  return units.slice(0, maxChars).join('');
}
