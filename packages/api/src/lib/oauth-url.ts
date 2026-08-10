/**
 * OAuth / MCP 对外绝对 URL 的单一来源。
 * 与 #17 PRM 解析一致：显式覆盖 ?? MCP_PUBLIC_URL ?? 请求 origin，禁止第二份逻辑。
 */

import { config } from './config.ts';

/** 去掉尾斜杠的绝对 origin/base。 */
export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * 解析对外 base（issuer 与 PRM resource 的共同前缀）。
 * @param requestOrigin 当前请求的 origin
 * @param override 调用方/测试显式覆盖（优先于 MCP_PUBLIC_URL）
 */
export function resolvePublicBase(requestOrigin?: string, override?: string): string {
  if (override) return stripTrailingSlashes(override);
  const configured = config.mcpPublicUrl;
  if (configured) return stripTrailingSlashes(configured);
  if (requestOrigin) return stripTrailingSlashes(requestOrigin);
  throw new Error('oauth_public_base_unresolved');
}

/** RFC 8707 / MCP resource：`{base}/mcp`，无尾斜杠。 */
export function resolveResourceUri(requestOrigin?: string, override?: string): string {
  return `${resolvePublicBase(requestOrigin, override)}/mcp`;
}

/** AS issuer（无 path 时即 base）。 */
export function resolveIssuer(requestOrigin?: string, override?: string): string {
  return resolvePublicBase(requestOrigin, override);
}

/** 拼 RFC 8414 Authorization Server Metadata 文档。 */
export function buildAuthorizationServerMetadata(
  requestOrigin?: string,
  override?: string,
): Record<string, unknown> {
  const issuer = resolveIssuer(requestOrigin, override);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    // RFC 9207：授权响应（含错误）带 iss
    authorization_response_iss_parameter_supported: true,
    // CIMD（IANA 已注册）
    client_id_metadata_document_supported: true,
  };
}
