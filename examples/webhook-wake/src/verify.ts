/**
 * Independent HMAC-SHA256 verifier for X-OAE-Signature.
 *
 * Matches RFC-0001 / packages/api webhook-signing.ts:
 *   signingKey = UTF-8 bytes of the displayed whs_ secret (prefix included)
 *   signedPayload = <unix-seconds> + "." + original raw body bytes as UTF-8 text
 *   v1 = lowercase hex HMAC-SHA256
 *
 * This receiver is stricter on header grammar than the API helper: timestamp
 * must be an integer token, each v1 must be 64 lowercase hex chars, and the
 * number of v1 candidates is bounded.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { TIMESTAMP_RE, V1_HEX_RE } from './ids.ts';
import type { VerifyResult } from './types.ts';

export const DEFAULT_TOLERANCE_SEC = 300;
export const DEFAULT_MAX_V1 = 8;

export type ParseSignatureHeaderResult =
  | { ok: true; timestampSec: number; v1: string[] }
  | { ok: false; reason: 'missing_header' | 'invalid_header' };

export function parseSignatureHeader(
  header: string | null | undefined,
  maxV1 = DEFAULT_MAX_V1,
): ParseSignatureHeaderResult {
  if (header == null || !header.trim()) {
    return { ok: false, reason: 'missing_header' };
  }
  if (header.length > 2048) {
    return { ok: false, reason: 'invalid_header' };
  }

  let timestampSec: number | undefined;
  const v1: string[] = [];

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      return { ok: false, reason: 'invalid_header' };
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === 't') {
      if (!TIMESTAMP_RE.test(value)) {
        return { ok: false, reason: 'invalid_header' };
      }
      timestampSec = Number.parseInt(value, 10);
    } else if (key === 'v1') {
      if (!V1_HEX_RE.test(value)) {
        return { ok: false, reason: 'invalid_header' };
      }
      v1.push(value);
      if (v1.length > maxV1) {
        return { ok: false, reason: 'invalid_header' };
      }
    }
    // Unknown keys are ignored for forward compatibility (for example v2=).
  }

  if (timestampSec === undefined || v1.length === 0) {
    return { ok: false, reason: 'invalid_header' };
  }
  return { ok: true, timestampSec, v1 };
}

export function hmacV1Hex(secret: string, timestampSec: number, rawBody: string | Buffer): string {
  const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${timestampSec}.${raw}`;
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(signedPayload, 'utf8').digest('hex');
}

export function buildSignatureHeader(
  secret: string,
  rawBody: string | Buffer,
  timestampSec: number,
  extraV1: string[] = [],
): string {
  const primary = hmacV1Hex(secret, timestampSec, rawBody);
  const v1s = [primary, ...extraV1];
  return `t=${timestampSec},${v1s.map((v) => `v1=${v}`).join(',')}`;
}

function anyV1Matches(expectedHex: string, candidates: string[]): boolean {
  const expected = Buffer.from(expectedHex, 'utf8');
  let matched = false;
  for (const candidate of candidates) {
    const buf = Buffer.from(candidate, 'utf8');
    if (buf.length === expected.length && timingSafeEqual(buf, expected)) {
      matched = true;
    }
  }
  return matched;
}

export function verifyWebhookSignature(options: {
  signatureHeader: string | null | undefined;
  rawBody: string | Buffer;
  secrets: string[];
  nowMs?: number;
  toleranceSec?: number;
  maxV1?: number;
}): VerifyResult {
  const parsed = parseSignatureHeader(options.signatureHeader, options.maxV1 ?? DEFAULT_MAX_V1);
  if (!parsed.ok) {
    return { valid: false, reason: parsed.reason };
  }

  const nowMs = options.nowMs ?? Date.now();
  const toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - parsed.timestampSec) > toleranceSec) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  const secrets = options.secrets.filter((s) => typeof s === 'string' && s.length > 0);
  if (secrets.length === 0) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  for (const secret of secrets) {
    const expected = hmacV1Hex(secret, parsed.timestampSec, options.rawBody);
    if (anyV1Matches(expected, parsed.v1)) {
      return { valid: true, timestampSec: parsed.timestampSec };
    }
  }
  return { valid: false, reason: 'signature_mismatch' };
}
