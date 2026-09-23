/**
 * #340 R6：describeFailure 本体永不抛。
 * - 病态输入 ⇒ `[unreadable]` 且不抛
 * - 正常输入与改前逐字节一致（负控；send.test.ts「SMTP 错误脱敏」既有用例亦覆盖脱敏面）
 */
process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';
process.env.DATA_DIR = '/tmp/oae-describe-failure-r6';
process.env.NODE_ENV = 'test';

const { describe, expect, test } = await import('bun:test');
const { describeFailure } = await import('../src/lib/redact.ts');

describe('describeFailure · 永不抛（#340 R6）', () => {
  test('会抛 message getter ⇒ [unreadable] 且不抛', () => {
    const err = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('boom-message');
      },
    });
    expect(() => describeFailure(err)).not.toThrow();
    expect(describeFailure(err)).toBe('[unreadable]');
  });

  test('会抛 code getter ⇒ [unreadable] 且不抛', () => {
    const err = Object.defineProperty({ message: 'ok' }, 'code', {
      get() {
        throw new Error('boom-code');
      },
    });
    expect(() => describeFailure(err)).not.toThrow();
    expect(describeFailure(err)).toBe('[unreadable]');
  });

  test('revoked Proxy ⇒ [unreadable] 且不抛', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => describeFailure(proxy)).not.toThrow();
    expect(describeFailure(proxy)).toBe('[unreadable]');
  });

  test('不可字符串化对象（toString 抛）⇒ [unreadable] 且不抛', () => {
    const err = {
      toString() {
        throw new Error('no-string');
      },
      [Symbol.toPrimitive]() {
        throw new Error('no-primitive');
      },
    };
    expect(() => describeFailure(err)).not.toThrow();
    expect(describeFailure(err)).toBe('[unreadable]');
  });
});

describe('describeFailure · 正常输入逐字节不变（负控）', () => {
  // 空 secrets：避免 config 单例口令误伤字面量（同 send.test.ts 口径）
  const none: string[] = [];

  test('{code,responseCode,message} 全有 ⇒ 拼一行', () => {
    const err = Object.assign(new Error('Mailbox unavailable'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    expect(describeFailure(err, none)).toBe('EENVELOPE 550 Mailbox unavailable');
  });

  test('只有 message ⇒ 原文', () => {
    expect(describeFailure(new Error('only-msg'), none)).toBe('only-msg');
  });

  test('非对象值（裸字符串）⇒ String(err)', () => {
    expect(describeFailure('plain string failure', none)).toBe('plain string failure');
  });
});
