import { describe, expect, test } from 'bun:test';
import { truncateUtf8Bytes, truncateUtf8Codepoints } from '../src/lib/utf8-truncate.ts';

describe('truncateUtf8Bytes', () => {
  test('短于上限原样返回', () => {
    const buf = Buffer.from('hello');
    expect(truncateUtf8Bytes(buf, 10).equals(buf)).toBe(true);
  });

  test('ASCII 按字节切', () => {
    expect(truncateUtf8Bytes(Buffer.from('abcdef'), 3).toString('utf8')).toBe('abc');
  });

  test('切在 2 字节字符中间则丢弃该字符', () => {
    // é = c3 a9
    const buf = Buffer.from('aéB', 'utf8');
    const cut = truncateUtf8Bytes(buf, 2);
    expect(cut.toString('utf8')).toBe('a');
    expect(cut.toString('utf8').includes('\uFFFD')).toBe(false);
  });

  test('切在 3 字节字符中间则丢弃该字符', () => {
    const euro = Buffer.from('€', 'utf8');
    const buf = Buffer.concat([Buffer.from('A'), euro, Buffer.from('Z')]);
    const cut = truncateUtf8Bytes(buf, 2);
    expect(cut.toString('utf8')).toBe('A');
    expect(cut.includes(0xef) && cut.includes(0xbf)).toBe(false);
  });

  test('切在 4 字节 emoji 中间则丢弃该字符', () => {
    const buf = Buffer.from('A😀B', 'utf8');
    const cut = truncateUtf8Bytes(buf, 3);
    expect(cut.toString('utf8')).toBe('A');
  });
});

describe('truncateUtf8Codepoints', () => {
  test('counts Unicode code points, not UTF-8 bytes', () => {
    const han = '字'.repeat(10);
    expect(truncateUtf8Codepoints(han, 3)).toBe('字字字');
    expect([...truncateUtf8Codepoints(han, 3)].length).toBe(3);
  });

  test('leaves a short string unchanged', () => {
    expect(truncateUtf8Codepoints('abc', 10)).toBe('abc');
  });
});
