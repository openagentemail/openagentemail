import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignatureHeader, hmacV1Hex, verifyWebhookSignature } from '../src/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '../../../packages/api/test/fixtures/webhook-signature-vectors.v1.json',
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  format: string;
  version: number;
  vectors: Array<{
    id: string;
    displayedSecret: string;
    previousDisplayedSecret?: string;
    timestampSec: number;
    rawBody: string;
    expectedHeader: string;
  }>;
};

describe('independent signature vectors', () => {
  test('public v1 fixture verifies, including rotation overlap', () => {
    expect(fixture.format).toBe('openagentemail.webhook-signature-vectors');
    expect(fixture.version).toBe(1);
    expect(fixture.vectors.length).toBe(4);

    for (const vector of fixture.vectors) {
      const secrets = [vector.displayedSecret];
      if (vector.previousDisplayedSecret) secrets.push(vector.previousDisplayedSecret);
      const result = verifyWebhookSignature({
        signatureHeader: vector.expectedHeader,
        rawBody: vector.rawBody,
        secrets,
        nowMs: vector.timestampSec * 1000,
        toleranceSec: 300,
      });
      expect(result.valid).toBe(true);
    }
  });

  test('raw-byte mutation fails closed', () => {
    const vector = fixture.vectors[0];
    const mutated = `${vector.rawBody.slice(0, -2)}X${vector.rawBody.slice(-1)}`;
    const result = verifyWebhookSignature({
      signatureHeader: vector.expectedHeader,
      rawBody: mutated,
      secrets: [vector.displayedSecret],
      nowMs: vector.timestampSec * 1000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  test('wrong secret and missing whs_ prefix fail', () => {
    const vector = fixture.vectors[0];
    const wrong = verifyWebhookSignature({
      signatureHeader: vector.expectedHeader,
      rawBody: vector.rawBody,
      secrets: [vector.displayedSecret.replace('2b09', 'ffff')],
      nowMs: vector.timestampSec * 1000,
    });
    expect(wrong.valid).toBe(false);

    const decodedHex = vector.displayedSecret.slice(4);
    const noPrefix = verifyWebhookSignature({
      signatureHeader: vector.expectedHeader,
      rawBody: vector.rawBody,
      secrets: [decodedHex],
      nowMs: vector.timestampSec * 1000,
    });
    expect(noPrefix.valid).toBe(false);
  });

  test('stale and future timestamps are rejected', () => {
    const vector = fixture.vectors[0];
    const stale = verifyWebhookSignature({
      signatureHeader: vector.expectedHeader,
      rawBody: vector.rawBody,
      secrets: [vector.displayedSecret],
      nowMs: (vector.timestampSec + 301) * 1000,
    });
    expect(stale.valid).toBe(false);
    expect(stale.reason).toBe('timestamp_out_of_range');

    const future = verifyWebhookSignature({
      signatureHeader: vector.expectedHeader,
      rawBody: vector.rawBody,
      secrets: [vector.displayedSecret],
      nowMs: (vector.timestampSec - 301) * 1000,
    });
    expect(future.valid).toBe(false);
    expect(future.reason).toBe('timestamp_out_of_range');
  });

  test('strict timestamp grammar rejects floats and junk', () => {
    const secret = fixture.vectors[0].displayedSecret;
    const body = fixture.vectors[0].rawBody;
    const now = fixture.vectors[0].timestampSec;
    const hex = hmacV1Hex(secret, now, body);
    expect(
      verifyWebhookSignature({
        signatureHeader: `t=${now}.5,v1=${hex}`,
        rawBody: body,
        secrets: [secret],
        nowMs: now * 1000,
      }).valid,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        signatureHeader: `t=${now}abc,v1=${hex}`,
        rawBody: body,
        secrets: [secret],
        nowMs: now * 1000,
      }).valid,
    ).toBe(false);
  });

  test('rotation: any bounded v1 candidate may match current or previous secret', () => {
    const overlap = fixture.vectors.find((v) => v.id === 'overlap-rotation-v1');
    expect(overlap).toBeDefined();
    const currentOnly = verifyWebhookSignature({
      signatureHeader: overlap!.expectedHeader,
      rawBody: overlap!.rawBody,
      secrets: [overlap!.displayedSecret],
      nowMs: overlap!.timestampSec * 1000,
    });
    expect(currentOnly.valid).toBe(true);
    const previousOnly = verifyWebhookSignature({
      signatureHeader: overlap!.expectedHeader,
      rawBody: overlap!.rawBody,
      secrets: [overlap!.previousDisplayedSecret!],
      nowMs: overlap!.timestampSec * 1000,
    });
    expect(previousOnly.valid).toBe(true);
  });

  test('U+FFFD body must not verify after substitution with byte 0xFF', () => {
    const secret = fixture.vectors[0].displayedSecret;
    const timestampSec = fixture.vectors[0].timestampSec;
    const withReplacement = Buffer.from(
      '{"id":"evt_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","type":"webhook.ping","payloadVersion":"v1","createdAt":"2026-09-03T12:20:00.000Z","domain":"openagent.email","note":"\uFFFD"}',
      'utf8',
    );
    const fffd = Buffer.from([0xef, 0xbf, 0xbd]);
    const idx = withReplacement.indexOf(fffd);
    expect(idx).toBeGreaterThan(-1);

    const header = buildSignatureHeader(secret, withReplacement, timestampSec);
    expect(
      verifyWebhookSignature({
        signatureHeader: header,
        rawBody: withReplacement,
        secrets: [secret],
        nowMs: timestampSec * 1000,
      }).valid,
    ).toBe(true);

    const mutated = Buffer.concat([
      withReplacement.subarray(0, idx),
      Buffer.from([0xff]),
      withReplacement.subarray(idx + fffd.length),
    ]);
    expect(mutated.equals(withReplacement)).toBe(false);
    // The buggy decode-then-re-encode path would map 0xFF back to U+FFFD.
    expect(Buffer.from(mutated.toString('utf8'), 'utf8').equals(withReplacement)).toBe(true);
    const swapped = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: mutated,
      secrets: [secret],
      nowMs: timestampSec * 1000,
    });
    expect(swapped.valid).toBe(false);
    expect(swapped.reason).toBe('signature_mismatch');
  });

  test('too many v1 candidates is invalid, not verified', () => {
    const vector = fixture.vectors[0];
    const extras = Array.from({ length: 9 }, () => 'ab'.repeat(32));
    const header = buildSignatureHeader(vector.displayedSecret, vector.rawBody, vector.timestampSec, extras);
    const result = verifyWebhookSignature({
      signatureHeader: header,
      rawBody: vector.rawBody,
      secrets: [vector.displayedSecret],
      nowMs: vector.timestampSec * 1000,
      maxV1: 8,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid_header');
  });
});
