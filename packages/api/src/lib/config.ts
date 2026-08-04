/**
 * Environment configuration, validated with zod at process start.
 * Importing this module throws on invalid/missing required env —
 * that is intentional: fail fast at boot, not on first request.
 */

import { join } from 'node:path';
import { z } from 'zod';

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

  // Directory for the identity store JSON file.
  DATA_DIR: z.string().default('./data'),

  // Built-in, read-only human inbox. Disable to make every /ui route 404.
  UI_ENABLED: z.enum(['true', 'false']).default('true'),

  // Notification transport. Docker Compose enables ntfy by default; keeping
  // the bare-process default off preserves the lightweight API test/runtime.
  NTFY_ENABLED: z.enum(['true', 'false']).default('false'),
  NTFY_INTERNAL_URL: z.string().url().default('http://ntfy'),
  // Path as seen by the ntfy container. The API writes the same named volume
  // at /app/data, so this must not be derived from DATA_DIR.
  NTFY_STORAGE_DIR: z.string().min(1).default('/var/lib/openagentemail/ntfy'),
  // This can stay on a private address for server-only notifications. Phone
  // delivery needs a deliberate public HTTPS reverse proxy and full restart.
  NOTIFY_PUBLIC_URL: z.string().url().default('http://127.0.0.1:2586'),
  // Forward unknown topics to ntfy.sh unless an operator explicitly disables
  // it with NTFY_UPSTREAM=false.
  NTFY_UPSTREAM: z.enum(['true', 'false']).default('true'),
  // Required by the Compose provisioner when notifications are enabled. Keep
  // it optional here so importing config alone never materializes a secret.
  NTFY_ADMIN_PASSWORD: z.string().min(1).optional(),
  // Only identities explicitly granted can_notify_user may spend this budget.
  NOTIFY_RATE_LIMIT: z.coerce.number().int().min(0).default(10),
  PUSH_POLICY: z.enum(['otp', 'all', 'none']).default('otp'),

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

/** Canonical form keeps configured and request URLs comparable as origins. */
function normalizeUrl(value: string): string {
  return new URL(value).href.replace(/\/+$/, '');
}

/** Parse an environment object so TLS defaults and validation stay testable. */
export function parseConfig(env: NodeJS.ProcessEnv) {
  const raw = envSchema.parse(env);

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
    taskSigningSecret: raw.TASK_SIGNING_SECRET ?? raw.SMTP_PASS,
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
    sendRateLimit: raw.SEND_RATE_LIMIT,
    retentionDays: raw.RETENTION_DAYS,
    retentionCheckHours: raw.RETENTION_CHECK_HOURS,
  } as const;
}

export const config = parseConfig(process.env);
