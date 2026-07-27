/**
 * Did a send fail before it ever reached the mail server?
 *
 * Used to decide whether the send rate-limit slot is given back. Refunding
 * every failure would gut the limit: a leaked token spraying to addresses
 * that get rejected would never be throttled, and rejected deliveries are the
 * ones that damage the IP's reputation. Refunding nothing is unfair to the
 * user when our own mail server is simply down.
 */

/** nodemailer/adapter codes that mean the message never left this host. */
const LOCAL_FAILURE_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EDNS',
  'ESOCKET',
  'ETIMEDOUT',
  'EAUTH',
]);

export function isLocalSendFailure(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  // Any SMTP response code means the server saw the attempt: count it.
  if (typeof e.responseCode === 'number') return false;
  // Unrecognised failures count too — an unknown error must not become a way
  // to send without spending quota.
  return typeof e.code === 'string' && LOCAL_FAILURE_CODES.has(e.code);
}
