/**
 * Webhook 签名与密钥派生机制 (RFC-0001 §7, §12.1, §12.2)
 *
 * 规范：
 * - 派生密钥：HMAC-SHA256(rootSecret, "webhook-signing-v1\n" + webhookId + "\n" + epoch) (32 字节)
 * - 展示密钥：displayedSecret = "whs_" + lowerCaseHex(endpointKey) (68 字符)
 * - 签名密钥：signingKey = utf8Bytes(displayedSecret) (68 字节，whs_ 为密钥本体一部分)
 * - 签名串：signedPayload = t + "." + rawRequestBody
 * - 签名计算：lower-case hex HMAC-SHA256(signingKey, signedPayload)
 * - 头部格式：X-OAE-Signature: t=<unix-seconds>,v1=<hex>[,v1=<hex>]
 * - 轮换重叠：overlapUntil 内发射 (epoch, epoch - 1) 双签
 * - 根密钥重叠：WEBHOOK_SIGNING_SECRET_PREVIOUS 配置时发射旧根签名
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';

export type DerivedWebhookKey = {
  rawKey: Buffer;
  displayedSecret: string;
  signingKey: Buffer;
  secretPrefix: string;
};

/**
 * 依据 rootSecret + webhookId + epoch 确定性派生端点签名密钥（§12.1）。
 * 显示形式 whs_<64-hex> 本身即为 HMAC 签名的 ASCII 密钥。
 */
export function deriveWebhookKey(
  rootSecret: string,
  webhookId: string,
  epoch: number,
): DerivedWebhookKey {
  if (!rootSecret || rootSecret.length < 32) {
    throw new Error('webhook signing root secret must be at least 32 characters');
  }
  const derivationMessage = `webhook-signing-v1\n${webhookId}\n${epoch}`;
  const rawKey = createHmac('sha256', rootSecret)
    .update(derivationMessage, 'utf8')
    .digest();
  const hex = rawKey.toString('hex');
  const displayedSecret = `whs_${hex}`;
  const signingKey = Buffer.from(displayedSecret, 'utf8');
  const secretPrefix = `${displayedSecret.slice(0, 8)}…`;

  return {
    rawKey,
    displayedSecret,
    signingKey,
    secretPrefix,
  };
}

export function getWebhookSigningRoot(cfg = config): string {
  return cfg.webhooks.signingSecret ?? cfg.taskSigningSecret;
}

export type BuildSignatureOptions = {
  rootSecret?: string;
  webhookId: string;
  epoch: number;
  rawBody: string | Buffer;
  timestampSec?: number;
  overlapUntil?: string | null;
  previousRootSecret?: string;
  nowMs?: number;
};

export type BuildSignatureResult = {
  headerValue: string;
  timestampSec: number;
  primarySignature: string;
  signatures: string[];
};

/**
 * 构造 X-OAE-Signature 头部值（含轮换重叠双签支持，§7.2, §12.2）。
 */
export function buildWebhookSignatureHeader(
  options: BuildSignatureOptions,
): BuildSignatureResult {
  const root = options.rootSecret ?? getWebhookSigningRoot();
  const nowMs = options.nowMs ?? Date.now();
  const t = options.timestampSec ?? Math.floor(nowMs / 1000);
  const rawBodyStr =
    typeof options.rawBody === 'string'
      ? options.rawBody
      : options.rawBody.toString('utf8');
  const signedPayload = `${t}.${rawBodyStr}`;

  // 1. 主签名 (当前 epoch)
  const primaryDerived = deriveWebhookKey(root, options.webhookId, options.epoch);
  const primarySig = createHmac('sha256', primaryDerived.signingKey)
    .update(signedPayload, 'utf8')
    .digest('hex');

  const signatures: string[] = [primarySig];

  // 2. Epoch 轮换重叠签名 (§12.2)
  if (
    options.overlapUntil &&
    options.epoch > 0 &&
    nowMs < new Date(options.overlapUntil).getTime()
  ) {
    const prevDerived = deriveWebhookKey(root, options.webhookId, options.epoch - 1);
    const prevSig = createHmac('sha256', prevDerived.signingKey)
      .update(signedPayload, 'utf8')
      .digest('hex');
    signatures.push(prevSig);
  }

  // 3. 根密钥轮换重叠签名 (§12.2)
  const prevRoot = options.previousRootSecret ?? config.webhooks.signingSecretPrevious;
  if (prevRoot) {
    const prevRootDerived = deriveWebhookKey(prevRoot, options.webhookId, options.epoch);
    const prevRootSig = createHmac('sha256', prevRootDerived.signingKey)
      .update(signedPayload, 'utf8')
      .digest('hex');
    signatures.push(prevRootSig);
  }

  const headerValue = `t=${t},${signatures.map((s) => `v1=${s}`).join(',')}`;

  return {
    headerValue,
    timestampSec: t,
    primarySignature: primarySig,
    signatures,
  };
}

export type VerifySignatureOptions = {
  signatureHeader: string | null | undefined;
  rawBody: string | Buffer;
  secret: string; // "whs_<64hex>"
  nowMs?: number;
  toleranceSec?: number;
};

export type VerifySignatureResult = {
  valid: boolean;
  reason?:
    | 'missing_header'
    | 'invalid_header'
    | 'timestamp_out_of_range'
    | 'signature_mismatch';
};

/**
 * 校验 X-OAE-Signature 头部（标准实现，供测试与消费方对照，§7.3）。
 */
export function verifyWebhookSignature(
  options: VerifySignatureOptions,
): VerifySignatureResult {
  const { signatureHeader, rawBody, secret } = options;
  if (!signatureHeader || !signatureHeader.trim()) {
    return { valid: false, reason: 'missing_header' };
  }

  const parts = signatureHeader.split(',');
  let t: number | undefined;
  const v1Sigs: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx);
    const v = trimmed.slice(eqIdx + 1);
    if (k === 't') {
      const parsedT = Number.parseInt(v, 10);
      if (Number.isFinite(parsedT) && parsedT >= 0) {
        t = parsedT;
      }
    } else if (k === 'v1') {
      v1Sigs.push(v);
    }
    // 未知键忽略（向后兼容，例如未来 v2=）
  }

  if (t === undefined || v1Sigs.length === 0) {
    return { valid: false, reason: 'invalid_header' };
  }

  const nowMs = options.nowMs ?? Date.now();
  const toleranceSec = options.toleranceSec ?? config.webhooks.timestampToleranceSec;
  const nowSec = Math.floor(nowMs / 1000);

  if (Math.abs(nowSec - t) > toleranceSec) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  const rawBodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const signedPayload = `${t}.${rawBodyStr}`;
  const signingKeyBuf = Buffer.from(secret, 'utf8');
  const expectedSigHex = createHmac('sha256', signingKeyBuf)
    .update(signedPayload, 'utf8')
    .digest('hex');
  const expectedSigBuf = Buffer.from(expectedSigHex, 'utf8');

  for (const sig of v1Sigs) {
    const candidateBuf = Buffer.from(sig, 'utf8');
    if (
      candidateBuf.length === expectedSigBuf.length &&
      timingSafeEqual(candidateBuf, expectedSigBuf)
    ) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'signature_mismatch' };
}
