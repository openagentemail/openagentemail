/** Strict validators for route keys, seats, and signed identifiers. */

export const ROUTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SUBSCRIPTION_ID_RE = /^whk_[A-Za-z0-9-]{8,80}$/;
export const TERMINAL_RE = /^term_[A-Za-z0-9-]{8,128}$/;
export const EVENT_ID_RE = /^evt_[A-Za-z0-9-]{8,80}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
export const SECRET_RE = /^whs_[0-9a-f]{64}$/;
/** Align with packages/api `isValidDomain` (single-label hosts such as localhost). */
export const DOMAIN_MAX_LENGTH = 253;
export const DOMAIN_LABEL_MAX_OCTETS = 63;
export const DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
export const MAILBOX_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/;
export const TIMESTAMP_RE = /^[0-9]{1,12}$/;
export const V1_HEX_RE = /^[0-9a-f]{64}$/;

const UNSAFE_IDENT = /[\s"'`$\\()<>|;#]/;

export function isRouteKey(value: string): boolean {
  return ROUTE_KEY_RE.test(value);
}

export function isSubscriptionId(value: string): boolean {
  return SUBSCRIPTION_ID_RE.test(value);
}

export function isTerminalHandle(value: string): boolean {
  return TERMINAL_RE.test(value);
}

export function isEventId(value: string): boolean {
  return EVENT_ID_RE.test(value);
}

export function isSafeMessageId(value: string): boolean {
  return MESSAGE_ID_RE.test(value) && !UNSAFE_IDENT.test(value);
}

export function isDisplayedSecret(value: string): boolean {
  return SECRET_RE.test(value);
}

export function isDomain(value: string): boolean {
  if (!value || value.length > DOMAIN_MAX_LENGTH) return false;
  return value.split('.').every(
    (label) =>
      label.length > 0 &&
      Buffer.byteLength(label, 'utf8') <= DOMAIN_LABEL_MAX_OCTETS &&
      DOMAIN_LABEL_RE.test(label),
  );
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function isMailbox(value: string): boolean {
  return MAILBOX_RE.test(value) && !UNSAFE_IDENT.test(value);
}

export function normalizeMailbox(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

/** Decode a hook path segment; malformed percent-encoding is not thrown. */
export function decodeRouteKey(raw: string): { ok: true; value: string } | { ok: false; reason: 'bad_route_encoding' } {
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    return { ok: false, reason: 'bad_route_encoding' };
  }
}
