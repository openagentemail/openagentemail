/** Structured logs with a hard denylist for secrets and mail contents. */

const REDACT_KEYS = new Set([
  'secret',
  'previoussecret',
  'signature',
  'rawbody',
  'payload',
  'body',
  'subject',
  'from',
  'sender',
  'text',
  'html',
  'authorization',
  'x-oae-signature',
]);

function redactValue(key: string, value: unknown): unknown {
  if (REDACT_KEYS.has(key.toLowerCase())) {
    return '[redacted]';
  }
  if (typeof value === 'string' && (value.startsWith('whs_') || value.length > 256)) {
    if (value.startsWith('whs_')) return 'whs_[redacted]';
  }
  return value;
}

export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redactRecord(fields),
  });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
