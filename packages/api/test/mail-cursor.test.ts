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
      expect(decodeMailForwardCursor(token, KEY)).toEqual({
        ...payload,
        uidValidity: '17',
      });
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
        const bodyObj = { f: 'inbox', a: 'fox@test.example', t: 100, u: 1, v: '17', ...mod };
        const body = Buffer.from(JSON.stringify(bodyObj)).toString('base64url');
        return `${parts[0]}.${body}.${parts[2]}`;
      };
      expect(() => decodeMailForwardCursor(tamperPayload({ v: '18' }), KEY)).toThrow(
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
        return `${MAIL_FORWARD_CURSOR_PREFIX}.${body}.invalidmac`;
      };
      expect(() => decodeMailForwardCursor(forgedWithBadV(0), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadV(-1), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadV('abc'), KEY)).toThrow(
        InvalidMailCursorError,
      );
      expect(() => decodeMailForwardCursor(forgedWithBadV('0'), KEY)).toThrow(
        InvalidMailCursorError,
      );
      // 非法 scanUid 格式（即使签名有效也要拒）
      const forgedWithBadS = (s: unknown) => {
        const body = Buffer.from(
          JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: 100, u: 1, v: '17', s }),
        ).toString('base64url');
        return `${MAIL_FORWARD_CURSOR_PREFIX}.${body}.invalidmac`;
      };
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
      expect(decodeMailForwardCursor(token, KEY)).toEqual({
        ...payload,
        uidValidity: '17',
      });

      // 篡改 scanUid 签名失效拒
      const parts = token.split('.');
      const bodyObj = { f: 'inbox', a: 'fox@test.example', t: 1_752_000_000_000, u: 42, v: '17', s: 501 };
      const tamperedBody = Buffer.from(JSON.stringify(bodyObj)).toString('base64url');
      expect(() => decodeMailForwardCursor(`${parts[0]}.${tamperedBody}.${parts[2]}`, KEY)).toThrow(
        InvalidMailCursorError,
      );
    });

    test('回归测试 5 (ZCode P2-1): uidValidity > 2^53 的编解码往返一致，无 Number 精度损失', () => {
      // 9007199254740993n 是 2^53 + 1；若用 Number(9007199254740993n) 会截断为 9007199254740992
      const hugeUidValidity = 9007199254740993n;
      const payload = {
        folder: 'inbox' as const,
        address: 'fox@test.example',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: hugeUidValidity,
        scanUid: 123,
      };

      const token = encodeMailForwardCursor(payload, KEY);
      const decoded = decodeMailForwardCursor(token, KEY);

      expect(decoded.uidValidity).toBe('9007199254740993');
      expect(BigInt(decoded.uidValidity)).toBe(hugeUidValidity);
      expect(decoded.scanUid).toBe(123);
      expect(decoded.t).toBe(payload.t);
      expect(decoded.uid).toBe(payload.uid);
    });

    test('R5 CR Minor (Item C): encodeMailForwardCursor 签名前将 address 归一为小写，避免大小写混合 token 自毁', () => {
      const payload = {
        folder: 'inbox' as const,
        address: 'Fox.Agent+Tag@Test.EXAMPLE',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: '17',
        scanUid: 88,
      };

      const token = encodeMailForwardCursor(payload, KEY);
      const decoded = decodeMailForwardCursor(token, KEY);

      expect(decoded.address).toBe('fox.agent+tag@test.example');
      expect(decoded.scanUid).toBe(88);
      expect(decoded.uidValidity).toBe('17');
    });

    test('R5 ZCode P2-2 (Item E): decodeMailForwardCursor 严格校验 t 为非负整数（>=0 且 isInteger）', () => {
      const basePayload = {
        folder: 'inbox' as const,
        address: 'fox@test.example',
        t: 1_752_000_000_000,
        uid: 42,
        uidValidity: '17',
      };
      const validToken = encodeMailForwardCursor(basePayload, KEY);
      const [prefix, , sig] = validToken.split('.');

      // t = 0 合法
      const tZeroToken = encodeMailForwardCursor({ ...basePayload, t: 0 }, KEY);
      expect(decodeMailForwardCursor(tZeroToken, KEY).t).toBe(0);

      // t 为小数（非整数）拒
      const floatBody = Buffer.from(JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: 1234.56, u: 42, v: '17' })).toString('base64url');
      expect(() => decodeMailForwardCursor(`${prefix}.${floatBody}.${sig}`, KEY)).toThrow(InvalidMailCursorError);

      // t 为负数拒
      const negBody = Buffer.from(JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: -1, u: 42, v: '17' })).toString('base64url');
      expect(() => decodeMailForwardCursor(`${prefix}.${negBody}.${sig}`, KEY)).toThrow(InvalidMailCursorError);

      // t 为非数值拒
      const strBody = Buffer.from(JSON.stringify({ f: 'inbox', a: 'fox@test.example', t: '1752000000000', u: 42, v: '17' })).toString('base64url');
      expect(() => decodeMailForwardCursor(`${prefix}.${strBody}.${sig}`, KEY)).toThrow(InvalidMailCursorError);
    });
  });
});
