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
import { resolveToken } from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { JSON_BODY_LIMIT_BYTES } from "../lib/limits.ts";
import { OpenAgentEmailClient, type FetchLike } from "./client.ts";
import { registerOpenAgentEmailTools } from "./tools.ts";

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
 * 判断 hostname 是否为 loopback / RFC1918 / CGNAT / ULA。
 * 用于限制 dangerouslyAllowInsecureIssuerUrl，公网 http 一律不放行。
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.+)\]$/, "$1").toLowerCase();
  if (host === "localhost" || host === "::1") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }

  // IPv6 ULA fd00::/8（首 hextet 以 fd 开头）
  if (host.includes(":")) {
    const first = host.split(":").find((p) => p.length > 0) ?? "";
    return first.startsWith("fd");
  }
  return false;
}

/** http + 私网/loopback 才允许 insecure issuer；公网 http / https 都不开危险开关。 */
export function allowInsecureIssuerUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:") return false;
    return isPrivateOrLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 拼 RFC 9728 Protected Resource Metadata 选项。
 * - base：优先 MCP_PUBLIC_URL / publicBaseUrl，否则回落请求 origin
 * - oauthMetadata 仅含 issuer（authorization_servers 由此派生）；authorize/token 等 AS
 *   端点属 P3，现在广告出去是撒谎，故不放进元数据
 */
export function mcpAuthMetadataOptions(
  requestOrigin: string,
  publicBaseUrl?: string,
): AuthMetadataOptions {
  const base = (publicBaseUrl ?? requestOrigin).replace(/\/+$/, "");
  // SDK 校验 OAuthMetadata 时 issuer 即可；其余 AS 字段等 P3 真 AS 落地再填。
  const oauthMetadata = { issuer: base } as OAuthMetadata;
  return {
    oauthMetadata,
    resourceServerUrl: new URL(`${base}/mcp`),
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
  const publicBase = options.publicBaseUrl ?? config.mcpPublicUrl;
  const base = mcpAuthMetadataOptions(requestOrigin, publicBase);
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
    const auth = resolveToken(token);
    if (!auth) {
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "invalid token"),
        challengeOpts,
      );
    }
    // createMcpHandler 不校验 expiresAt；此处只传透 token 给工具工厂。
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
