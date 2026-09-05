import { describe, expect, test } from 'bun:test';
import {
  MAIL_CURSOR_PREFIX,
  MAIL_FORWARD_CURSOR_PREFIX,
  InvalidMailCursorError,
  decodeMailCursor,
  decodeMailForwardCursor,
  encodeMailCursor,
  encodeMailForwardCursor,
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

  describe('forward cursor (mail-fcursor-v1)', () => {
    test('往返编码保持 folder/address/t/uid/uidValidity', () => {
      const payload = {
        folder: 'inbox' as const,
        address: 'fox@test.example',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: 17,
      };
      const token = encodeMailForwardCursor(payload, KEY);
      expect(token.startsWith(`${MAIL_FORWARD_CURSOR_PREFIX}.`)).toBe(true);
      expect(decodeMailForwardCursor(token, KEY)).toEqual(payload);
    });

    test('后向与前向游标互不通用（域隔离）', () => {
      const backwardToken = encodeMailCursor(
        { folder: 'inbox', address: 'fox@test.example', t: 1000, uid: 10 },
        KEY,
      );
      const forwardToken = encodeMailForwardCursor(
        { folder: 'inbox', address: 'fox@test.example', t: 1000, uid: 10, uidValidity: 17 },
        KEY,
      );

      // 前向解码器拒后向游标
      expect(() => decodeMailForwardCursor(backwardToken, KEY)).toThrow(
        InvalidMailCursorError,
      );
      // 后向解码器拒前向游标
      expect(() => decodeMailCursor(forwardToken, KEY)).toThrow(
        InvalidMailCursorError,
      );
    });

    test('前向游标篡改 HMAC、载荷或 key 一律失败', () => {
      const payload = {
        folder: 'inbox' as const,
        address: 'fox@test.example',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: 17,
      };
      const token = encodeMailForwardCursor(payload, KEY);
      const parts = token.split('.');

      // 坏 MAC
      expect(() => decodeMailForwardCursor(`${parts[0]}.${parts[1]}.aaaa`, KEY)).toThrow(
        InvalidMailCursorError,
      );
      // 坏 key
      expect(() => decodeMailForwardCursor(token, 'wrong-key')).toThrow(
        InvalidMailCursorError,
      );
      // 非法 token
      expect(() => decodeMailForwardCursor('not-a-token', KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(`${parts[0]}.badjson.${parts[2]}`, KEY)).toThrow(
        InvalidMailCursorError,
      );

      // 篡改载荷字段（HMAC 未重签必挂）
      const tamperPayload = (mod: Record<string, unknown>) => {
        const bodyObj = { f: 'inbox', a: 'fox@test.example', t: 100, u: 1, v: 17, ...mod };
        const body = Buffer.from(JSON.stringify(bodyObj)).toString('base64url');
        return `${parts[0]}.${body}.${parts[2]}`;
      };
      expect(() => decodeMailForwardCursor(tamperPayload({ v: 18 }), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(tamperPayload({ a: 'owl@test.example' }), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(tamperPayload({ f: 'sent' }), KEY)).toThrow(
        InvalidMailCursorError,
      );

      // 非法 uidValidity 格式（即使签名有效也要拒）
      const forgedWithBadV = (v: unknown) => {
        const body = Buffer.from(
          JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: 100, u: 1, v }),
        ).toString('base64url');
        // 构造带有该 body 的 token
        return `${MAIL_FORWARD_CURSOR_PREFIX}.${body}.invalidmac`;
      };
      expect(() => decodeMailForwardCursor(forgedWithBadV(0), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadV(-1), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadV('17'), KEY)).toThrow(
        InvalidMailCursorError,
      );
      // 非法 scanUid 格式（即使签名有效也要拒）
      const forgedWithBadS = (s: unknown) => {
        const body = Buffer.from(
          JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: 100, u: 1, v: 17, s }),
        ).toString('base64url');
        return `${MAIL_FORWARD_CURSOR_PREFIX}.${body}.invalidmac`;
      };
      expect(() => decodeMailForwardCursor(forgedWithBadS(0), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadS(-1), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadS('500'), KEY)).toThrow(
        InvalidMailCursorError,
      );
    });

    test('带 scanUid 续扫游标往返编码与防篡改', () => {
      const payload = {
        folder: 'inbox' as const,
        address: 'fox@test.example',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: 17,
        scanUid: 500,
      };
      const token = encodeMailForwardCursor(payload, KEY);
      expect(token.startsWith(`${MAIL_FORWARD_CURSOR_PREFIX}.`)).toBe(true);
      expect(decodeMailForwardCursor(token, KEY)).toEqual(payload);

      // 篡改 scanUid 签名失效拒
      const parts = token.split('.');
      const bodyObj = { f: 'inbox', a: 'fox@test.example', t: 1_752_000_000_000, u: 42, v: 17, s: 501 };
      const tamperedBody = Buffer.from(JSON.stringify(bodyObj)).toString('base64url');
      expect(() => decodeMailForwardCursor(`${parts[0]}.${tamperedBody}.${parts[2]}`, KEY)).toThrow(
        InvalidMailCursorError,
      );
    });
  });
});
