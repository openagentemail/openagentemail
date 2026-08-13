/**
 * QR 字节模式编码器的结构与容量测试。
 */
import { describe, expect, test } from 'bun:test';
import { encodeQrModules } from '../src/lib/qr-byte.ts';

function cell(encoded: { size: number; modules: string }, x: number, y: number): string {
  return encoded.modules.charAt(y * encoded.size + x);
}

describe('qr-byte', () => {
  test('short text is version 1 (21×21) with finder patterns', () => {
    const encoded = encodeQrModules('HELLO');
    expect(encoded.size).toBe(21);
    expect(encoded.modules.length).toBe(21 * 21);
    // 左上定位符外框全黑
    expect(cell(encoded, 0, 0)).toBe('1');
    expect(cell(encoded, 6, 0)).toBe('1');
    expect(cell(encoded, 0, 6)).toBe('1');
    expect(cell(encoded, 6, 6)).toBe('1');
    expect(cell(encoded, 2, 2)).toBe('1');
    // 分隔带为白
    expect(cell(encoded, 7, 0)).toBe('0');
    // 暗模块 (8, 4*ver+9) = (8, 13)
    expect(cell(encoded, 8, 13)).toBe('1');
  });

  test('pairing-sized JSON fits under version 20 and is deterministic', () => {
    const payload = JSON.stringify({
      serverUrl: 'https://notify.test.example',
      username: 'phone-abcdefgh',
      password: 'abcdefghijklmnopqrstuvwx',
      topics: { userAlerts: 'user-alerts-xyzxyzxyz', userLow: 'user-low-xyzxyzxyz' },
    });
    const a = encodeQrModules(payload);
    const b = encodeQrModules(payload);
    expect(a.size).toBe(b.size);
    expect(a.modules).toBe(b.modules);
    expect(a.size).toBeGreaterThanOrEqual(25);
    expect(a.size).toBeLessThanOrEqual(4 * 20 + 17);
    expect(a.modules.length).toBe(a.size * a.size);
    expect(a.modules).toMatch(/^[01]+$/);
  });
});
