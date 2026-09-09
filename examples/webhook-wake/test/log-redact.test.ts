import { describe, expect, test } from 'bun:test';
import { redactRecord } from '../src/log.ts';

describe('log redaction', () => {
  test('whs_ values are redacted; long non-secret strings are unchanged', () => {
    const out = redactRecord({
      secret: 'whs_2b0932ba2d72c1d53d07da69a8ad7843c70f09d24800e3b3828dca20b594127b',
      note: 'x'.repeat(300),
      eventId: 'evt_11111111-2222-3333-4444-555555555555',
    });
    expect(out.secret).toBe('[redacted]');
    expect(out.note).toBe('x'.repeat(300));
    expect(out.eventId).toBe('evt_11111111-2222-3333-4444-555555555555');
    const leaked = redactRecord({ token: 'whs_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(leaked.token).toBe('whs_[redacted]');
  });
});
