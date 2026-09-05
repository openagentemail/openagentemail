process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'test-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'test-only';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'test-only';

import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/webhook-signature-vectors.v1.json';

const {
  buildWebhookSignatureHeader,
  deriveWebhookKey,
  verifyWebhookSignature,
} = await import('../src/lib/webhook-signing.ts');

describe('webhook signing and verification (§7, §12.1, §12.2, §14 item 1)', () => {
  test('matches public v1 vectors fixture with JS production implementation', () => {
    expect(fixture.format).toBe('openagentemail.webhook-signature-vectors');
    expect(fixture.version).toBe(1);
    expect(fixture.vectors.length).toBe(4);

    for (const v of fixture.vectors) {
      const derived = deriveWebhookKey(v.rootSecret, v.webhookId, v.epoch);
      expect(derived.displayedSecret).toBe(v.displayedSecret);

      const headerResult = buildWebhookSignatureHeader({
        rootSecret: v.rootSecret,
        webhookId: v.webhookId,
        epoch: v.epoch,
        rawBody: v.rawBody,
        timestampSec: v.timestampSec,
        overlapUntil: 'previousEpoch' in v ? '2026-09-04T12:30:00.000Z' : null,
        nowMs: v.timestampSec * 1000,
      });

      expect(headerResult.headerValue).toBe(v.expectedHeader);

      // Verify with verifyWebhookSignature
      const verifyRes = verifyWebhookSignature({
        signatureHeader: headerResult.headerValue,
        rawBody: v.rawBody,
        secret: v.displayedSecret,
        nowMs: v.timestampSec * 1000,
        toleranceSec: 300,
      });
      expect(verifyRes.valid).toBe(true);

      // If overlap vector, previous displayedSecret should also verify
      if ('previousDisplayedSecret' in v) {
        const verifyPrev = verifyWebhookSignature({
          signatureHeader: headerResult.headerValue,
          rawBody: v.rawBody,
          secret: v.previousDisplayedSecret as string,
          nowMs: v.timestampSec * 1000,
          toleranceSec: 300,
        });
        expect(verifyPrev.valid).toBe(true);
      }
    }
  });

  test('key derivation: distinct webhookId produces distinct keys, distinct epoch produces distinct keys', () => {
    const root = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const whk1 = 'whk_11111111-1111-1111-1111-111111111111';
    const whk2 = 'whk_22222222-2222-2222-2222-222222222222';

    const k1_e0 = deriveWebhookKey(root, whk1, 0);
    const k1_e1 = deriveWebhookKey(root, whk1, 1);
    const k2_e0 = deriveWebhookKey(root, whk2, 0);

    expect(k1_e0.displayedSecret).toStartWith('whs_');
    expect(k1_e0.displayedSecret.length).toBe(68);
    expect(k1_e0.secretPrefix).toBe(k1_e0.displayedSecret.slice(0, 8) + '…');

    expect(k1_e0.displayedSecret).not.toBe(k1_e1.displayedSecret);
    expect(k1_e0.displayedSecret).not.toBe(k2_e0.displayedSecret);
  });

  test('verification rejects tampered body, wrong secret, and expired timestamp', () => {
    const root = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const whk = 'whk_11111111-1111-1111-1111-111111111111';
    const derived = deriveWebhookKey(root, whk, 0);
    const body = '{"hello":"world"}';
    const nowSec = 1725366000;

    const { headerValue } = buildWebhookSignatureHeader({
      rootSecret: root,
      webhookId: whk,
      epoch: 0,
      rawBody: body,
      timestampSec: nowSec,
      nowMs: nowSec * 1000,
    });

    // 1. Tampered body
    const badBodyRes = verifyWebhookSignature({
      signatureHeader: headerValue,
      rawBody: '{"hello":"tampered"}',
      secret: derived.displayedSecret,
      nowMs: nowSec * 1000,
      toleranceSec: 300,
    });
    expect(badBodyRes.valid).toBe(false);
    expect(badBodyRes.reason).toBe('signature_mismatch');

    // 2. Wrong secret
    const wrongSecret = deriveWebhookKey(root, 'whk_other', 0).displayedSecret;
    const badSecretRes = verifyWebhookSignature({
      signatureHeader: headerValue,
      rawBody: body,
      secret: wrongSecret,
      nowMs: nowSec * 1000,
      toleranceSec: 300,
    });
    expect(badSecretRes.valid).toBe(false);
    expect(badSecretRes.reason).toBe('signature_mismatch');

    // 3. Expired timestamp (> 300s)
    const expiredRes = verifyWebhookSignature({
      signatureHeader: headerValue,
      rawBody: body,
      secret: derived.displayedSecret,
      nowMs: (nowSec + 301) * 1000,
      toleranceSec: 300,
    });
    expect(expiredRes.valid).toBe(false);
    expect(expiredRes.reason).toBe('timestamp_out_of_range');

    // Within tolerance (exact boundary: 300s)
    const exactBoundaryRes = verifyWebhookSignature({
      signatureHeader: headerValue,
      rawBody: body,
      secret: derived.displayedSecret,
      nowMs: (nowSec + 300) * 1000,
      toleranceSec: 300,
    });
    expect(exactBoundaryRes.valid).toBe(true);

    // 4. Missing / malformed header
    expect(
      verifyWebhookSignature({
        signatureHeader: '',
        rawBody: body,
        secret: derived.displayedSecret,
      }).valid,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        signatureHeader: 'invalid-header',
        rawBody: body,
        secret: derived.displayedSecret,
      }).valid,
    ).toBe(false);
  });

  test('root rotation overlap emits both new and previous root signatures', () => {
    const newRoot = 'newrootsecret012345678901234567890123456789012345';
    const oldRoot = 'oldrootsecret012345678901234567890123456789012345';
    const whk = 'whk_rot_test';
    const body = '{"event":"root_rotation"}';
    const t = 1725366000;

    const newKey = deriveWebhookKey(newRoot, whk, 0);
    const oldKey = deriveWebhookKey(oldRoot, whk, 0);

    const { headerValue, signatures } = buildWebhookSignatureHeader({
      rootSecret: newRoot,
      webhookId: whk,
      epoch: 0,
      rawBody: body,
      timestampSec: t,
      previousRootSecret: oldRoot,
      nowMs: t * 1000,
    });

    expect(signatures.length).toBe(2);
    // Both new and old root keys verify
    expect(
      verifyWebhookSignature({
        signatureHeader: headerValue,
        rawBody: body,
        secret: newKey.displayedSecret,
        nowMs: t * 1000,
      }).valid,
    ).toBe(true);

    expect(
      verifyWebhookSignature({
        signatureHeader: headerValue,
        rawBody: body,
        secret: oldKey.displayedSecret,
        nowMs: t * 1000,
      }).valid,
    ).toBe(true);
  });
});
