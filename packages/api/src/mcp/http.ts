/**
 * 远程无状态 MCP HTTP 传输：POST /mcp + RFC 9728 Protected Resource Metadata。
 *
 * 鉴权走 resolveToken（支持 admin / oa_ identity）；SDK 的 verifyBearerToken
 * 因要求 expiresAt，与永久 oa_ 令牌不兼容，故仅复用挑战响应 / 元数据 helpers。
 */
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  type AuthMetadataOptions,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { resolveAccessToken } from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { JSON_BODY_LIMIT_BYTES } from "../lib/limits.ts";
import { isPrivateOrLoopbackHost, isPrivateOrLoopbackHostname } from "../lib/net.ts";
import {
  buildAuthorizationServerMetadata,
  resolvePublicBase,
  resolveResourceUri,
} from "../lib/oauth-url.ts";
import { OpenAgentEmailClient, type FetchLike } from "./client.ts";
import { registerOpenAgentEmailTools } from "./tools.ts";

/** 兼容旧导出名：实现已迁至 lib/net.ts（唯一共享）。 */
export { isPrivateOrLoopbackHost };

/** MCP 服务实现标识（HTTP 面；stdio 包用自己的 package.json version）。 */
const MCP_SERVER_INFO = { name: "openagentemail", version: "0.5.0" } as const;

export type McpHttpOptions = {
  /** 工具回呼 REST 的 fetch；默认应注入 app.fetch（进程内）。 */
  apiFetch: FetchLike;
  /** 可选覆盖元数据里的 resource 绝对 URL（测试用）。 */
  resourceServerUrl?: URL;
  /** 测试可注入；默认读 config.mcpPublicUrl。 */
  publicBaseUrl?: string;
};

/**
 * RFC 7235：Authorization scheme 大小写不敏感；只接受 bearer。
 * 形如 `Bearer <token>` / `bearer <token>` / `BEARER <token>`。
 */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const trimmed = authorization.trim();
  const sp = trimmed.search(/\s/);
  if (sp <= 0) return undefined;
  const scheme = trimmed.slice(0, sp);
  if (scheme.toLowerCase() !== "bearer") return undefined;
  const token = trimmed.slice(sp).trim();
  return token || undefined;
}

/**
 * http + 可放行私网/loopback 才允许 insecure issuer。
 * 永拒段（169.254 / 0.0.0.0，含 v4-mapped）不算私网——与 CIMD SSRF 同一套 lib/net。
 */
export function allowInsecureIssuerUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:") return false;
    // isPrivateOrLoopbackHostname 已排除 169.254/0.0.0.0（含 v4-mapped）
    return isPrivateOrLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 拼 RFC 9728 Protected Resource Metadata 选项。
 * - base：优先 MCP_PUBLIC_URL / publicBaseUrl，否则回落请求 origin（与 oauth-url 同源）
 * - oauthMetadata 填真 AS 元数据（P3）；PRM.authorization_servers 由 issuer 派生
 */
export function mcpAuthMetadataOptions(
  requestOrigin: string,
  publicBaseUrl?: string,
): AuthMetadataOptions {
  // 单一来源：override(publicBaseUrl) ?? MCP_PUBLIC_URL ?? requestOrigin
  const base = resolvePublicBase(requestOrigin, publicBaseUrl);
  const oauthMetadata = buildAuthorizationServerMetadata(
    requestOrigin,
    publicBaseUrl,
  ) as OAuthMetadata;
  return {
    oauthMetadata,
    resourceServerUrl: new URL(resolveResourceUri(requestOrigin, publicBaseUrl)),
    resourceName: "openagentemail",
    scopesSupported: ["mcp"],
    dangerouslyAllowInsecureIssuerUrl: allowInsecureIssuerUrl(base),
  };
}

/** 401 挑战里的 resource_metadata：派单硬性路径（根 PRM，非 /mcp 后缀）。 */
function resourceMetadataUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
}

/** 共用：拼 PRM JSON 响应体。 */
function protectedResourceMetadata(
  requestOrigin: string,
  options: McpHttpOptions,
): ReturnType<typeof buildOAuthProtectedResourceMetadata> {
  // publicBaseUrl 仅测试注入；生产走 config.mcpPublicUrl（在 resolvePublicBase 内）
  const base = mcpAuthMetadataOptions(requestOrigin, options.publicBaseUrl);
  const metaOpts: AuthMetadataOptions = options.resourceServerUrl
    ? { ...base, resourceServerUrl: options.resourceServerUrl }
    : base;
  return buildOAuthProtectedResourceMetadata(metaOpts);
}

/**
 * 在主 Hono app 上注册 MCP 相关路由（直接挂在父 app，避免与
 * `app.route('/.well-known', agentCardRoute)` 前缀抢路由）。
 */
export function registerMcpHttpRoutes(app: Hono, options: McpHttpOptions): void {
  // 派单硬性路径 + RFC 9728 §3.1 path-aware 变体（resource=…/mcp）
  const servePrm = (c: { req: { url: string }; json: (body: unknown) => Response }) =>
    c.json(protectedResourceMetadata(new URL(c.req.url).origin, options));
  app.get("/.well-known/oauth-protected-resource", (c) => servePrm(c));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => servePrm(c));

  // 先限体再鉴权/进 SDK，与 /v1/* 同一防护姿态。
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: JSON_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );

  // 无状态：每请求新 McpServer；token 经 authInfo 传入工厂。
  const mcpHandler = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      if (!token) {
        throw new Error("mcp factory invoked without authInfo.token");
      }
      const client = new OpenAgentEmailClient(
        "http://mcp.internal",
        token,
        options.apiFetch,
      );
      const server = new McpServer(MCP_SERVER_INFO);
      registerOpenAgentEmailTools(server, client);
      return server;
    },
    {
      legacy: "stateless",
      // 工具调用无中途通知需求；json 模式便于测试与网关。
      responseMode: "json",
    },
  );

  // 仅 POST 进入 MCP；其他方法 405（无 WWW-Authenticate 挑战）。
  app.post("/mcp", async (c) => {
    const origin = new URL(c.req.url).origin;
    const challengeOpts = { resourceMetadataUrl: resourceMetadataUrl(origin) };
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "missing bearer token"),
        challengeOpts,
      );
    }
    const resource = resolveResourceUri(origin, options.publicBaseUrl);
    const resolved = resolveAccessToken(token, { resource });
    if (resolved.status === "forbidden_audience") {
      // aud 不符 → 403（任务书负例）；其余无效/过期仍 401 + 挑战
      return c.json({ error: "invalid_audience" }, 403);
    }
    if (resolved.status !== "ok") {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "invalid token"),
        challengeOpts,
      );
    }
    const auth = resolved.auth;
    // createMcpHandler 不校验 expiresAt；OAuth 票的过期已在 resolveAccessToken 强制。
    return mcpHandler.fetch(c.req.raw, {
      authInfo: {
        token,
        clientId: auth.kind === "admin" ? "admin" : auth.address,
        scopes: ["mcp"],
      },
    });
  });
  app.all("/mcp", (c) => {
    c.header("Allow", "POST");
    return c.body(null, 405);
  });
}
