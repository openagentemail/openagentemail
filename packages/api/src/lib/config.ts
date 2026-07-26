/**
 * Environment configuration, validated with zod at process start.
 * Importing this module throws on invalid/missing required env —
 * that is intentional: fail fast at boot, not on first request.
 */

import { z } from 'zod';

const envSchema = z.object({
  // HTTP port for the API service.
  PORT: z.coerce.number().int().positive().default(3100),
  // Domain identities live on (address = <localpart>@DOMAIN).
  DOMAIN: z.string().min(1),
  // Comma-separated list of valid Bearer keys.
  API_KEYS: z.string().min(1),

  IMAP_HOST: z.string().min(1).default('127.0.0.1'),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().min(1),
  IMAP_PASS: z.string().min(1),
  // 'true' = implicit TLS (993), 'false' = plaintext/STARTTLS (143).
  IMAP_TLS: z.enum(['true', 'false']).default('true'),

  SMTP_HOST: z.string().min(1).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),

  // Comma-separated domains allowed as the `from` domain of an identity.
  // Defaults to [DOMAIN]. Sending to any recipient domain is unrestricted.
  ALLOWED_SEND_DOMAINS: z.string().optional(),

  // Directory for the identity store JSON file.
  DATA_DIR: z.string().default('./data'),
});

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const raw = envSchema.parse(process.env);

export const config = {
  port: raw.PORT,
  domain: raw.DOMAIN.toLowerCase(),
  apiKeys: new Set(splitCsv(raw.API_KEYS)),
  imap: {
    host: raw.IMAP_HOST,
    port: raw.IMAP_PORT,
    user: raw.IMAP_USER,
    pass: raw.IMAP_PASS,
    secure: raw.IMAP_TLS === 'true',
  },
  smtp: {
    host: raw.SMTP_HOST,
    port: raw.SMTP_PORT,
    user: raw.SMTP_USER,
    pass: raw.SMTP_PASS,
  },
  allowedSendDomains: raw.ALLOWED_SEND_DOMAINS
    ? splitCsv(raw.ALLOWED_SEND_DOMAINS).map((d) => d.toLowerCase())
    : [raw.DOMAIN.toLowerCase()],
  dataDir: raw.DATA_DIR,
} as const;
