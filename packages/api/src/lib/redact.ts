/**
 * Diagnostics for the server log.
 *
 * Errors from the mail stack can carry the server's own responses, adapter
 * context and — depending on the adapter — the credentials it was configured
 * with. Those belong in the operator's log, never in an API response, and the
 * configured passwords should not be in either.
 */

import { config } from './config.ts';

function configuredSecrets(): string[] {
  return [config.smtp.pass, config.imap.pass];
}

/** Replace secrets with a marker. Defaults to the configured mail passwords. */
export function redactSecrets(text: string, secrets: string[] = configuredSecrets()): string {
  let out = text;
  for (const secret of secrets) {
    // Very short values would match everywhere and turn the log to noise.
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * One-line description of a failure: SMTP/adapter code, response code and
 * message, with configured secrets scrubbed.
 */
export function describeFailure(err: unknown, secrets?: string[]): string {
  const e = (err ?? {}) as { message?: unknown; code?: unknown; responseCode?: unknown };
  const parts = [
    typeof e.code === 'string' ? e.code : undefined,
    typeof e.responseCode === 'number' ? String(e.responseCode) : undefined,
    typeof e.message === 'string' && e.message ? e.message : undefined,
  ].filter((part): part is string => Boolean(part));
  const line = parts.length > 0 ? parts.join(' ') : String(err);
  return secrets ? redactSecrets(line, secrets) : redactSecrets(line);
}
