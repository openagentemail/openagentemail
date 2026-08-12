import { describe, expect, test } from 'bun:test';
import {
  MAIL_CURSOR_PREFIX,
  InvalidMailCursorError,
  decodeMailCursor,
  encodeMailCursor,
  isMailFolder,
} from '../src/lib/mail-cursor.ts';

const KEY = 'test-mail-cursor-secret';

describe('mail-cursor', () => {
  test('往返编码保持 folder/address/t/uid', () => {
    const payload = {
      folder: 'inbox' as const,
      address: 'fox@test.example',
      t: 1_752_000_000_000,
      uid: 42,
    };
    const token = encodeMailCursor(payload, KEY);
    expect(token.startsWith(`${MAIL_CURSOR_PREFIX}.`)).toBe(true);
    expect(decodeMailCursor(token, KEY)).toEqual(payload);
  });

  test('篡改 HMAC 或载荷一律失败', () => {
    const token = encodeMailCursor(
      { folder: 'sent', address: 'fox@test.example', t: 1, uid: 1 },
      KEY,
    );
    const parts = token.split('.');
    expect(() => decodeMailCursor(`${parts[0]}.${parts[1]}.aaaa`, KEY)).toThrow(
      InvalidMailCursorError,
    );
    expect(() => decodeMailCursor('not-a-token', KEY)).toThrow(InvalidMailCursorError);
    expect(() => decodeMailCursor(token, 'other-key')).toThrow(InvalidMailCursorError);
  });

  test('isMailFolder 只承认三 folder', () => {
    expect(isMailFolder('inbox')).toBe(true);
    expect(isMailFolder('sent')).toBe(true);
    expect(isMailFolder('all')).toBe(true);
    expect(isMailFolder('trash')).toBe(false);
    expect(isMailFolder('scheduled')).toBe(false);
  });
});
