import { describe, expect, test } from 'bun:test';
import { parseVerifiedEnvelope } from '../src/parse.ts';
import { pingBody } from './helpers.ts';

function envelope(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'webhook.ping',
    payloadVersion: 'v1',
    createdAt: '2026-09-03T12:20:00.000Z',
    domain: 'openagent.email',
    data: { object: 'webhook', webhookId: 'whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', trigger: 'test' },
    ...overrides,
  });
}

describe('envelope data object (RFC-0001 §6.1)', () => {
  test('object data is accepted; null, missing, and non-object are invalid_data', () => {
    expect(parseVerifiedEnvelope(pingBody()).ok).toBe(true);
    expect(parseVerifiedEnvelope(envelope({ data: { object: 'webhook' } })).ok).toBe(true);

    const missing = JSON.parse(envelope({})) as Record<string, unknown>;
    delete missing.data;
    expect(parseVerifiedEnvelope(JSON.stringify(missing))).toEqual({ ok: false, reason: 'invalid_data' });

    expect(parseVerifiedEnvelope(envelope({ data: null }))).toEqual({ ok: false, reason: 'invalid_data' });
    expect(parseVerifiedEnvelope(envelope({ data: 'x' }))).toEqual({ ok: false, reason: 'invalid_data' });
    expect(parseVerifiedEnvelope(envelope({ data: [1] }))).toEqual({ ok: false, reason: 'invalid_data' });
  });

  test('mail without an address is not a successful parse-to-ack path', () => {
    const parsed = parseVerifiedEnvelope(
      envelope({
        type: 'mail.received',
        data: { object: 'mail' },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.envelope.data.address).toBeUndefined();
    }
  });
});
