/**
 * MCP→API 发送来源签头（#1 R1）。
 *
 * 公共头 X-OAE-Send-Source 不可信。内部调用用 taskSigningSecret
 * 域分离派生 HMAC，验签通过才记 source=mcp，其余一律 api。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 域分离前缀，变更规约时递增。 */
export const SEND_SOURCE_DOMAIN = 'send-source-v1';

/** 内部签头名（HTTP 传入为小写）。 */
export const SEND_SOURCE_MAC_HEADER = 'X-OAE-Send-Source-Mac';

/** 用给定密钥签 mcp 来源。不读 config，避免 stdio MCP 拉起整份 env schema。 */
export function macForMcpSendSource(secret: string): string {
  const key = createHmac('sha256', secret).update(SEND_SOURCE_DOMAIN).digest();
  return createHmac('sha256', key).update('mcp').digest('base64url');
}

/** 验签：缺/坏/长度不齐一律 false（调用方记 api）。 */
export function verifyMcpSendSourceMac(header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = macForMcpSendSource(secret);
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveSendLogSource(
  header: string | undefined,
  secret: string,
): 'api' | 'mcp' {
  return verifyMcpSendSourceMac(header, secret) ? 'mcp' : 'api';
}
