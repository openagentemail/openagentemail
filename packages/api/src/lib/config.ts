/**
 * Environment configuration, validated with zod at process start.
 * Importing this module throws on invalid/missing required env —
 * that is intentional: fail fast at boot, not on first request.
 */

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Compose `${VAR:-}` injects "" when the var is unset. Treat empty/whitespace
 * as missing so optional fields stay optional and `.default()` can apply.
 */
function emptyAsUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? undefined : value;
}

/** Only http(s) — these values feed ntfy HTTP calls and push click actions. */
const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL must use http or https' },
  );

/**
 * URL env: empty string → undefined（可选或落到 default）。
 * zod v4 的 preprocess 输入是 unknown，重载输出须写 ZodType<Out, unknown>
 * 才与实现签名兼容（v3 的 ZodType<Out> 单参写法不再够用）。
 */
function envUrl(): z.ZodType<string | undefined, unknown>;
function envUrl(fallback: string): z.ZodType<string, unknown>;
function envUrl(fallback?: string): z.ZodType<string | undefined, unknown> {
  if (fallback !== undefined) {
    return z.preprocess(emptyAsUndefined, httpUrl.default(fallback));
  }
  return z.preprocess(emptyAsUndefined, httpUrl.optional());
}

/**
 * Public dashboard origin for ntfy click actions (F80). Rejects userinfo so
 * credentials never ride the notification channel. Internal ntfy URLs keep
 * envUrl() (credentials may be required on private networks).
 * F114: query strings and fragments are rejected too — the value is attached
 * verbatim as the ntfy click field on every mail-arrival push, so a copied
 * authenticated URL (`…/ui?token=secret`) would leak the credential.
 */
function dashboardPublicUrlEnv() {
  return z.preprocess(
    emptyAsUndefined,
    httpUrl
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            return (
              url.username === '' &&
              url.password === '' &&
              url.search === '' &&
              url.hash === ''
            );
          } catch {
            return false;
          }
        },
        {
          message:
            'DASHBOARD_PUBLIC_URL must not include credentials (userinfo, query, or fragment)',
        },
      )
      .optional(),
  );
}

const envSchema = z.object({
  // HTTP port for the API service.
  PORT: z.coerce.number().int().positive().default(3100),
  // Domain identities live on (address = <localpart>@DOMAIN).
  DOMAIN: z.string().min(1),
  // Comma-separated ADMIN Bearer keys. Admin keys can manage identities and
  // act as any address; per-identity tokens (issued by POST /v1/identities)
  // are stored hashed in the identity store and scoped to one address.
  API_KEYS: z.string().min(1),

  IMAP_HOST: z.string().min(1).default('127.0.0.1'),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().min(1),
  IMAP_PASS: z.string().min(1),
  // 'true' = implicit TLS (993), 'false' = plaintext/STARTTLS (143).
  IMAP_TLS: z.enum(['true', 'false']).default('true'),
  // Keep the bundled self-signed mailserver working by default. Set true for
  // a public IMAP server with a certificate from a trusted CA.
  IMAP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('false'),

  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  // Same default as IMAP: bundled docker-mailserver starts with a self-signed
  // certificate, while external public SMTP servers should normally use true.
  SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('false'),

  // Stable private key for task-header stamps. This must outlive SMTP account
  // password rotations so old task threads remain verifiable.
  TASK_SIGNING_SECRET: z.string().min(16).optional(),

  // Comma-separated domains allowed as the `from` domain of an identity.
  // Defaults to [DOMAIN]. Sending to any recipient domain is unrestricted.
  ALLOWED_SEND_DOMAINS: z.string().optional(),

  // Directory for the identity store JSON file. Single-writer process only
  // (Compose runs one API); multi-process shared DATA_DIR is unsupported.
  DATA_DIR: z.string().default('./data'),

  // Built-in, read-only human inbox. Disable to make every /ui route 404.
  UI_ENABLED: z.enum(['true', 'false']).default('true'),

  // Notification transport. Docker Compose enables ntfy by default; keeping
  // the bare-process default off preserves the lightweight API test/runtime.
  NTFY_ENABLED: z.enum(['true', 'false']).default('false'),
  NTFY_INTERNAL_URL: envUrl('http://ntfy'),
  // Path as seen by the ntfy container. The API writes the same named volume
  // at /app/data, so this must not be derived from DATA_DIR.
  NTFY_STORAGE_DIR: z.string().min(1).default('/var/lib/openagentemail/ntfy'),
  // This can stay on a private address for server-only notifications. Phone
  // delivery needs a deliberate public HTTPS reverse proxy and full restart.
  NOTIFY_PUBLIC_URL: envUrl('http://127.0.0.1:2586'),
  // Forward unknown topics to ntfy.sh unless an operator explicitly disables
  // it with NTFY_UPSTREAM=false.
  NTFY_UPSTREAM: z.enum(['true', 'false']).default('true'),
  // Required by the Compose provisioner when notifications are enabled. Keep
  // it optional here so importing config alone never materializes a secret.
  NTFY_ADMIN_PASSWORD: z.string().min(1).optional(),
  // Only identities explicitly granted can_notify_user may spend this budget.
  NOTIFY_RATE_LIMIT: z.coerce.number().int().min(0).default(10),
  PUSH_POLICY: z.enum(['otp', 'all', 'none']).default('otp'),
  // Optional public origin of the human dashboard. When set, mail-arrival
  // ntfy pushes include a click action that opens this URL (no deep link).
  // Must not contain userinfo — credentials must not leave via ntfy (F80).
  // Query/fragment are rejected too (F114): a copied authenticated URL would
  // leak its token verbatim on every push.
  DASHBOARD_PUBLIC_URL: dashboardPublicUrlEnv(),

  // 可选：MCP RFC 9728 元数据里的对外绝对 origin（优先于请求 Host）。
  // 反向代理 / 公网暴露时应设为 https://…，避免盲信 Host 头。
  MCP_PUBLIC_URL: envUrl(),

  // MCP tools/call 分桶限量（每分钟；0 = 关闭该桶）。admin 豁免。
  // 默认：读 60 / 写 20——写更严；对照 Joe 事故下午 ~3000 次合法调用，
  // 20 写/min 仍够正常 agent，却能挡住失控循环。
  MCP_RATE_READ_PER_MIN: z.coerce.number().int().min(0).default(60),
  MCP_RATE_WRITE_PER_MIN: z.coerce.number().int().min(0).default(20),

  // 阻塞等待上限（秒）：钳 mail_wait_for / POST /v1/messages/wait 的 timeoutSec
  // 与 task_* wait 的服务端封顶。schema 仍广告 max 600（历史客户端兼容），
  // 超参静默钳到本值（不 400）。默认 60——对任意反代读超时都更安全。
  MCP_MAX_WAIT_SECONDS: z.coerce.number().int().min(1).max(600).default(60),

  // 是否信任 X-Forwarded-For 首跳作为客户端 IP。默认 false（直连部署开=自杀）。
  // 仅在确有受信反代剥离/覆写 XFF 时设 true。
  TRUST_PROXY_HEADERS: z.enum(['true', 'false']).default('false'),

  // 公网边缘姿态：true 时关闭 CIMD SSRF 私网放行（RFC1918/loopback/CGNAT/ULA 全拒）。
  // 默认 false——tailnet/loopback 部署不受影响。永拒清单始终生效。
  OAE_PUBLIC_EDGE: z.enum(['true', 'false']).default('false'),

  // 预鉴权 IP 限量（每分钟；0 = 关闭）。键 = clientIp()。
  OAUTH_RATE_PER_MIN: z.coerce.number().int().min(0).default(30),
  // 默认 120：OAuth 引导握手故意无 token 探 401 拿挑战是规范动作；
  // 共享出口 IP 下 60 偏紧，易把合法客户端打成 429。
  MCP_PREAUTH_RATE_PER_MIN: z.coerce.number().int().min(0).default(120),

  // Per-identity send rate limit (messages per rolling hour). 0 disables.
  SEND_RATE_LIMIT: z.coerce.number().int().min(0).default(20),

  // Delete messages older than this many days from the catch-all mailbox.
  // 0 disables the retention sweeper.
  RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  // How often the retention sweeper runs, in hours.
  RETENTION_CHECK_HOURS: z.coerce.number().positive().default(6),
});

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Canonical form keeps configured and request URLs comparable as origins.
 * Only drops a redundant trailing slash on the pathname — never rewrites
 * query values or fragments (e.g. `?next=/` and `#/` must survive).
 * Exported so notify device pairing uses the same normalizer as config.
 */
export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }
  // Root path serializes as "https://host/" (or with userinfo). Prefer href so
  // publisher:secret@host credentials survive; origin alone drops userinfo.
  // Only apply when search/hash are empty so those branches keep full href.
  if (url.pathname === '/' && url.search === '' && url.hash === '') {
    return url.href.replace(/\/+$/, '');
  }
  return url.href;
}

/** Parse an environment object so TLS defaults and validation stay testable. */
export function parseConfig(env: NodeJS.ProcessEnv) {
  const raw = envSchema.parse(env);
  const taskSigningSecret = raw.TASK_SIGNING_SECRET ?? raw.SMTP_PASS;

  return {
    port: raw.PORT,
    domain: raw.DOMAIN.toLowerCase(),
    apiKeys: new Set(splitCsv(raw.API_KEYS)),
    imap: {
      host: raw.IMAP_HOST,
      port: raw.IMAP_PORT,
      user: raw.IMAP_USER,
      pass: raw.IMAP_PASS,
      secure: raw.IMAP_TLS === 'true',
      tlsRejectUnauthorized: raw.IMAP_TLS_REJECT_UNAUTHORIZED === 'true',
    },
    smtp: {
      host: raw.SMTP_HOST,
      port: raw.SMTP_PORT,
      user: raw.SMTP_USER,
      pass: raw.SMTP_PASS,
      tlsRejectUnauthorized: raw.SMTP_TLS_REJECT_UNAUTHORIZED === 'true',
    },
    // The fallback supports an upgrade where the new variable has not reached
    // a bare-process config yet. Both Compose variants require the dedicated
    // secret, which is the supported v0.4 deployment path.
    taskSigningSecret,
    // 通知游标与 task/mail 游标域分离；不新增 env。旧 notify 游标失效可接受。
    notifyCursorSecret: createHmac('sha256', taskSigningSecret)
      .update('notify-cursor-v1')
      .digest(),
    allowedSendDomains: raw.ALLOWED_SEND_DOMAINS
      ? splitCsv(raw.ALLOWED_SEND_DOMAINS).map((d) => d.toLowerCase())
      : [raw.DOMAIN.toLowerCase()],
    dataDir: raw.DATA_DIR,
    uiEnabled: raw.UI_ENABLED === 'true',
    ntfy: {
      enabled: raw.NTFY_ENABLED === 'true',
      internalUrl: normalizeUrl(raw.NTFY_INTERNAL_URL),
      storageDir: raw.NTFY_STORAGE_DIR,
      publicUrl: normalizeUrl(raw.NOTIFY_PUBLIC_URL),
      upstreamEnabled: raw.NTFY_UPSTREAM === 'true',
      adminPassword: raw.NTFY_ADMIN_PASSWORD,
      configPath: join(raw.DATA_DIR, 'ntfy', 'server.yml'),
      pushPolicy: raw.PUSH_POLICY,
      notifyRateLimit: raw.NOTIFY_RATE_LIMIT,
    },
    dashboardPublicUrl: raw.DASHBOARD_PUBLIC_URL
      ? normalizeUrl(raw.DASHBOARD_PUBLIC_URL)
      : undefined,
    mcpPublicUrl: raw.MCP_PUBLIC_URL ? normalizeUrl(raw.MCP_PUBLIC_URL) : undefined,
    mcpRateReadPerMin: raw.MCP_RATE_READ_PER_MIN,
    mcpRateWritePerMin: raw.MCP_RATE_WRITE_PER_MIN,
    mcpMaxWaitSeconds: raw.MCP_MAX_WAIT_SECONDS,
    trustProxyHeaders: raw.TRUST_PROXY_HEADERS === 'true',
    oaePublicEdge: raw.OAE_PUBLIC_EDGE === 'true',
    oauthRatePerMin: raw.OAUTH_RATE_PER_MIN,
    mcpPreauthRatePerMin: raw.MCP_PREAUTH_RATE_PER_MIN,
    sendRateLimit: raw.SEND_RATE_LIMIT,
    retentionDays: raw.RETENTION_DAYS,
    retentionCheckHours: raw.RETENTION_CHECK_HOURS,
  } as const;
}

export const config = parseConfig(process.env);

/**
 * 将请求的等待秒数静默钳到 MCP_MAX_WAIT_SECONDS（1..上限）。
 * 不抛 400——历史客户端按文档传 600 仍须可用。
 * @param cap 可选覆盖（测试用）；默认读进程 config
 */
export function clampWaitSeconds(requested: number, cap = config.mcpMaxWaitSeconds): number {
  if (!Number.isFinite(requested)) return cap;
  return Math.min(Math.max(1, Math.trunc(requested)), cap);
}
