/**
 * OAuth PKCE：本 AS 只实现 S256（OAuth 2.1 / MCP 强制面）。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** 校验 code_verifier 是否匹配授权时存下的 S256 challenge。 */
export function verifyS256CodeChallenge(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  // RFC 7636：verifier 长度 43–128
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeChallenge, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 生成测试用 S256 challenge。 */
export function s256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}
