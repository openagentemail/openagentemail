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
  // DNS lookup failed; the message never left this host.
  'ENOTFOUND',
  'ENODATA',
  'EAI_AGAIN',
  // No route to the SMTP host; the message never left this host.
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
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

/**
 * 幂等专用，不改变额度/冷却退还。
 * Nodemailer 的 error.command 已是 DATA、BDAT，或更晚的正文结束（单独的 "."），
 * 说明载荷可能已经写出，中继可能收下了这封信。
 * 没有应答码时 isLocalSendFailure 仍为 true：额度与冷却照旧退还。
 * 调用方应把幂等键记成 502，而不是放开后让重试再发一封。
 */
export function isAmbiguousPostDataSendFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const command = (err as { command?: unknown }).command;
  if (typeof command !== 'string') return false;
  const word = command.trim().split(/\s+/)[0]?.toUpperCase();
  if (!word) return false;
  return word === 'DATA' || word === 'BDAT' || word === '.';
}
