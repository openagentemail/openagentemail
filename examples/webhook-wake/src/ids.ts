/** Strict validators for route keys, seats, and signed identifiers. */

export const ROUTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SUBSCRIPTION_ID_RE = /^whk_[A-Za-z0-9-]{8,80}$/;
export const TERMINAL_RE = /^term_[A-Za-z0-9-]{8,128}$/;
export const EVENT_ID_RE = /^evt_[A-Za-z0-9-]{8,80}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
export const SECRET_RE = /^whs_[0-9a-f]{64}$/;
export const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
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
  return DOMAIN_RE.test(value);
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
