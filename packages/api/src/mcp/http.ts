/**
 * 远程无状态 MCP HTTP 传输：POST /mcp + RFC 9728 Protected Resource Metadata。
 *
 * 鉴权走 resolveAccessToken（支持 admin / oa_ identity / OAuth）；SDK 的 verifyBearerToken
 * 因要求 expiresAt，与永久 oa_ 令牌不兼容，故仅复用挑战响应 / 元数据 helpers。
 *
 * P3.5 安全带（仅本 HTTP 路径；stdio 不拦——operator 本地上下文，REST ACL 兜底）：
 * 1) tools/call 进 SDK 前按 tool→tier 策略（critical 对 OAuth deny-by-default）
 * 2) per-token 读写分桶限量（admin 豁免；tools/list 免费）
 * 3) tier≥minimal 落 scrubbed 审计（含 attribution）
 */
import type { Context, Hono } from "hono";
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
import { recordAuditEvent, type AuditOutcome } from "../lib/audit.ts";
import {
  resolveAccessToken,
  type TokenAttribution,
} from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { JSON_BODY_LIMIT_BYTES } from "../lib/limits.ts";
import { getMcpLoopbackBase, runWithMcpLoopbackBase } from "../lib/mcp-loopback.ts";
import {
  clientIp,
  isPrivateOrLoopbackHost,
  isPrivateOrLoopbackHostname,
} from "../lib/net.ts";
import {
  buildAuthorizationServerMetadata,
  resolvePublicBase,
  resolveResourceUri,
} from "../lib/oauth-url.ts";
import {
  checkMcpPreauthIpRateLimit,
  checkMcpRateLimit,
} from "../lib/ratelimit.ts";
import {
  getToolTier,
  isWriteTier,
  type ToolTier,
} from "../lib/tool-tiers.ts";
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

/**
 * 401 挑战里的 resource_metadata：派单硬性路径（根 PRM，非 /mcp 后缀）。
 * 与 PRM/AS 同源：override ?? MCP_PUBLIC_URL ?? request origin（#27 技术债②）。
 */
function resourceMetadataUrl(requestOrigin: string, publicBaseUrl?: string): string {
  const base = resolvePublicBase(requestOrigin, publicBaseUrl);
  return `${base}/.well-known/oauth-protected-resource`;
}

/**
 * /mcp 预鉴权 IP 限量（仅无/坏 token → 401 挑战路径）。
 * 已鉴权请求不进此桶。超限 429 + Retry-After。
 */
function rejectIfMcpPreauthRateLimited(c: Context): Response | null {
  const limit = config.mcpPreauthRatePerMin;
  if (limit <= 0) return null;
  const rl = checkMcpPreauthIpRateLimit(clientIp(c), limit);
  if (rl.allowed) return null;
  c.header("Retry-After", String(Math.max(1, rl.retryAfterSec)));
  return c.json({ error: "rate_limited" }, 429);
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

/** 从 attribution 拼审计行可选字段（scrubbed：无 token）。 */
function attributionFields(attr: TokenAttribution): {
  clientId?: string;
  grantId?: string;
  address?: string;
} {
  if (attr.kind === "admin") {
    return { address: "admin" };
  }
  if (attr.kind === "identity") {
    return { address: attr.address };
  }
  return {
    clientId: attr.clientId,
    grantId: attr.grantId,
    address: attr.address,
  };
}

/**
 * 限量键：OAuth→grantId（base64url **原样**，大小写敏感）；
 * oa_→address（小写化）；admin 不进限量。
 */
function rateLimitKey(attr: TokenAttribution): string | null {
  if (attr.kind === "admin") return null;
  if (attr.kind === "oauth") return attr.grantId;
  return attr.address.toLowerCase();
}

type JsonRpcCall = {
  method?: string;
  params?: { name?: string; arguments?: unknown };
  id?: unknown;
};

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
  // baseUrl 取自 ALS 中的公共 origin（外部请求 / MCP_PUBLIC_URL），禁止 mcp.internal。
  const mcpHandler = createMcpHandler(
    (ctx) => {
      const token = ctx.authInfo?.token;
      if (!token) {
        throw new Error("mcp factory invoked without authInfo.token");
      }
      // 工厂在 runWithMcpLoopbackBase 内调用；构造时读 ALS 公共 base
      const publicBase = getMcpLoopbackBase();
      if (!publicBase) {
        throw new Error("mcp factory: missing loopback public base");
      }
      const client = new OpenAgentEmailClient(publicBase, token, options.apiFetch);
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
    const challengeOpts = {
      resourceMetadataUrl: resourceMetadataUrl(origin, options.publicBaseUrl),
    };
    const token = bearerToken(c.req.header("authorization"));
    if (!token) {
      const limited = rejectIfMcpPreauthRateLimited(c);
      if (limited) return limited;
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "missing bearer token"),
        challengeOpts,
      );
    }
    const resource = resolveResourceUri(origin, options.publicBaseUrl);
    const publicBase = resolvePublicBase(origin, options.publicBaseUrl);
    const resolved = resolveAccessToken(token, { resource });
    if (resolved.status === "forbidden_audience") {
      // aud 不符 → 403（任务书负例）；其余无效/过期仍 401 + 挑战
      return c.json({ error: "invalid_audience" }, 403);
    }
    if (resolved.status !== "ok") {
      const limited = rejectIfMcpPreauthRateLimited(c);
      if (limited) return limited;
      return bearerAuthChallengeResponse(
        new OAuthError(OAuthErrorCode.InvalidToken, "invalid token"),
        challengeOpts,
      );
    }
    const auth = resolved.auth;
    const attribution = resolved.attribution;

    // 读体一次再建 Request，供 tier/限量预检（body 只能消费一次）
    const bodyText = await c.req.raw.text();
    let rpc: JsonRpcCall | undefined;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      // WriteGuard 安全带只认单对象 tools/call；JSON-RPC batch 数组会绕过
      // tier/限量/审计——显式拒绝，并计入写桶 + 落 mcp.batch_rejected（防垃圾洪峰白送）。
      if (Array.isArray(parsed)) {
        const fields = attributionFields(attribution);
        const rlKey = rateLimitKey(attribution);
        if (rlKey !== null) {
          const rl = checkMcpRateLimit(
            rlKey,
            "write",
            config.mcpRateWritePerMin,
          );
          if (!rl.allowed) {
            recordAuditEvent({
              event: "mcp.batch_rejected",
              ...fields,
              outcome: "rate_limited",
            });
            c.header("Retry-After", String(Math.max(1, rl.retryAfterSec)));
            return c.json({ error: "rate_limited", bucket: "write" }, 429);
          }
        }
        recordAuditEvent({
          event: "mcp.batch_rejected",
          ...fields,
          outcome: "denied",
        });
        return c.json(
          {
            error: "batch_not_supported",
            error_description: "JSON-RPC batch is not allowed on /mcp",
          },
          400,
        );
      }
      if (parsed && typeof parsed === "object") {
        rpc = parsed as JsonRpcCall;
      }
    } catch {
      // 畸形体交给 SDK 处理（刻意：precheck 只优化合法 JSON；正式拒绝方是 SDK）
    }

    if (rpc?.method === "tools/call") {
      // 审计只存截断后的工具名（防客户端塞超长串）；查找仍用原文
      const rawToolName =
        typeof rpc.params?.name === "string" ? rpc.params.name : undefined;
      const toolName = rawToolName;
      const toolForAudit =
        rawToolName !== undefined ? rawToolName.slice(0, 128) : undefined;
      const started = Date.now();
      const fields = attributionFields(attribution);

      if (!toolName) {
        // 无名调用：先计写桶再拒绝（灭免费审计写）
        const rlKeyMissing = rateLimitKey(attribution);
        if (rlKeyMissing !== null) {
          const rl = checkMcpRateLimit(
            rlKeyMissing,
            "write",
            config.mcpRateWritePerMin,
          );
          if (!rl.allowed) {
            recordAuditEvent({
              event: "mcp.tools.call",
              ...fields,
              outcome: "rate_limited",
              durationMs: Date.now() - started,
            });
            c.header("Retry-After", String(Math.max(1, rl.retryAfterSec)));
            return c.json({ error: "rate_limited", bucket: "write" }, 429);
          }
        }
        recordAuditEvent({
          event: "mcp.tools.call",
          ...fields,
          outcome: "denied",
          durationMs: Date.now() - started,
        });
        return c.json({ error: "tool_required" }, 400);
      }

      const tier: ToolTier | undefined = getToolTier(toolName);

      // per-token 限量**先于**策略拒绝审计：critical/未知工具 403 也耗配额，
      // 避免非 admin 反复打拒绝路径白写 audit 且永不计桶。
      const rlKey = rateLimitKey(attribution);
      if (rlKey !== null) {
        // 未知工具按写桶计（探测）；已知则按 read/write 分桶
        const bucket = tier === "read" ? "read" : "write";
        const limit =
          bucket === "read" ? config.mcpRateReadPerMin : config.mcpRateWritePerMin;
        const rl = checkMcpRateLimit(rlKey, bucket, limit);
        if (!rl.allowed) {
          recordAuditEvent({
            event: "mcp.tools.call",
            ...fields,
            tool: toolForAudit,
            ...(tier ? { tier } : {}),
            outcome: "rate_limited",
            durationMs: Date.now() - started,
          });
          c.header("Retry-After", String(Math.max(1, rl.retryAfterSec)));
          return c.json({ error: "rate_limited", bucket }, 429);
        }
      }

      // 未声明 tier → default deny（与注册即报错互补）
      if (!tier) {
        recordAuditEvent({
          event: "mcp.tools.call",
          ...fields,
          tool: toolForAudit,
          outcome: "denied",
          durationMs: Date.now() - started,
        });
        return c.json({ error: "forbidden_tier", tool: toolForAudit }, 403);
      }

      // critical：OAuth 票 deny-by-default（网页 Agent 永不许建身份/发验证）
      // oa_ 继续进 SDK→REST scope（already admin-only 的自然 403）；admin 全通
      if (tier === "critical" && attribution.kind === "oauth") {
        recordAuditEvent({
          event: "mcp.tools.call",
          ...fields,
          tool: toolForAudit,
          tier,
          outcome: "denied",
          durationMs: Date.now() - started,
        });
        return c.json(
          { error: "forbidden_tier", tool: toolForAudit, tier: "critical" },
          403,
        );
      }

      const sdkRequest = new Request(c.req.raw.url, {
        method: "POST",
        headers: c.req.raw.headers,
        body: bodyText,
      });

      const response = await runWithMcpLoopbackBase(publicBase, () =>
        mcpHandler.fetch(sdkRequest, {
          authInfo: {
            token,
            clientId: auth.kind === "admin" ? "admin" : auth.address,
            scopes: ["mcp"],
          },
        }),
      );

      // 仅写调用落审计（tier ≥ minimal）；绝不记录 params
      // outcome：HTTP≥400 → error；200 含 JSON-RPC isError 仍记 ok（归因/量级用途，非业务成功语义）
      if (isWriteTier(tier)) {
        const outcome: AuditOutcome =
          response.status >= 400 ? "error" : "ok";
        recordAuditEvent({
          event: "mcp.tools.call",
          ...fields,
          tool: toolForAudit,
          tier,
          outcome,
          durationMs: Date.now() - started,
        });
      }

      return response;
    }

    // tools/list 及其他方法：免费，不审计写调用
    const sdkRequest = new Request(c.req.raw.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: bodyText,
    });
    // 整段工具调度包在公共 base ALS 内，使 /v1 的 c.req.url.origin ≡ aud 推导源
    return runWithMcpLoopbackBase(publicBase, () =>
      mcpHandler.fetch(sdkRequest, {
        authInfo: {
          token,
          clientId: auth.kind === "admin" ? "admin" : auth.address,
          scopes: ["mcp"],
        },
      }),
    );
  });
  app.all("/mcp", (c) => {
    c.header("Allow", "POST");
    return c.body(null, 405);
  });
}
