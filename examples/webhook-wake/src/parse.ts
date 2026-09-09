/** JSON interpretation happens only after the raw-byte signature check. */

import { isEventId, isMailbox, isSafeMessageId, normalizeDomain, normalizeMailbox } from './ids.ts';

export type EnvelopeBase = {
  id: string;
  type: string;
  payloadVersion: string;
  createdAt: string;
  domain: string;
  data: Record<string, unknown> | undefined;
};

export type ParseFail = { ok: false; reason: string };
export type ParseOk = { ok: true; envelope: EnvelopeBase };

export function parseVerifiedEnvelope(rawBody: Buffer | string): ParseOk | ParseFail {
  let parsed: unknown;
  try {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !isEventId(obj.id)) {
    return { ok: false, reason: 'invalid_event_id' };
  }
  if (typeof obj.type !== 'string' || obj.type.length === 0 || obj.type.length > 64) {
    return { ok: false, reason: 'invalid_type' };
  }
  if (obj.payloadVersion !== 'v1') {
    return { ok: false, reason: 'invalid_payload_version' };
  }
  if (typeof obj.createdAt !== 'string' || obj.createdAt.length < 10 || obj.createdAt.length > 64) {
    return { ok: false, reason: 'invalid_created_at' };
  }
  if (typeof obj.domain !== 'string') {
    return { ok: false, reason: 'invalid_domain' };
  }
  const data =
    obj.data === undefined || obj.data === null
      ? undefined
      : typeof obj.data === 'object' && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>)
        : undefined;
  if (obj.data !== undefined && data === undefined) {
    return { ok: false, reason: 'invalid_data' };
  }
  return {
    ok: true,
    envelope: {
      id: obj.id,
      type: obj.type,
      payloadVersion: 'v1',
      createdAt: obj.createdAt,
      domain: normalizeDomain(obj.domain),
      data,
    },
  };
}

export function readMailAddress(data: Record<string, unknown> | undefined): string | null {
  if (!data || typeof data.address !== 'string') return null;
  const address = normalizeMailbox(data.address);
  return isMailbox(address) ? address : null;
}

export function readMailMessageId(data: Record<string, unknown> | undefined): string | null {
  if (!data || data.messageId == null) return null;
  const value = String(data.messageId);
  return isSafeMessageId(value) ? value : null;
}
