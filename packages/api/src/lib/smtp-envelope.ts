/**
 * SMTP envelope and archive-result policy shared by the production send path.
 * Keep original recipient strings untouched: SMTP local-parts can be
 * case-sensitive, while domains are case-insensitive.
 */

export interface RecipientAddress {
  address: string;
}

export type RecipientDeliveryAddress = string | RecipientAddress;

export interface RecipientDeliveryResult {
  accepted?: readonly RecipientDeliveryAddress[];
  rejected?: readonly RecipientDeliveryAddress[];
}

function mailboxComparisonKey(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return address;
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

function normalizeDeliveryAddress(address: RecipientDeliveryAddress): string {
  return typeof address === 'string' ? address : address.address;
}

/** Returns an archive recipient only when it is not already an original RCPT. */
export function archiveRecipientToAppend(
  originalRecipients: readonly string[],
  archiveRecipient?: string,
): string | undefined {
  if (!archiveRecipient) return undefined;
  const archiveKey = mailboxComparisonKey(archiveRecipient);
  return originalRecipients.some((recipient) => mailboxComparisonKey(recipient) === archiveKey)
    ? undefined
    : archiveRecipient;
}

/**
 * SMTP recipients are independent of MIME headers. Original recipients remain
 * byte-for-byte and in their caller-provided order; only a new archive RCPT is
 * appended when it is not already represented by an original recipient.
 */
export function buildSmtpEnvelope(
  from: string,
  originalRecipients: readonly string[],
  archiveRecipient?: string,
) {
  const archive = archiveRecipientToAppend(originalRecipients, archiveRecipient);
  return { from, to: archive ? [...originalRecipients, archive] : [...originalRecipients] };
}

/**
 * Couples the configured archive identity used for result policy to the
 * envelope that may omit an already-present archive recipient.
 */
export function buildSmtpEnvelopePlan(
  from: string,
  originalRecipients: readonly string[],
  configuredArchive?: string,
) {
  return {
    envelope: buildSmtpEnvelope(from, originalRecipients, configuredArchive),
    archiveRecipient: configuredArchive,
  };
}

/** The API never emits a MIME Bcc header, including from internal callers. */
export function stripBccHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'bcc'),
  );
}

/**
 * Nodemailer SMTP results contain string or Address values. Any configured
 * archive rejection is fail-open after a primary acceptance; archive-only
 * acceptance must never turn total primary rejection into success.
 */
export function applyArchiveRecipientPolicy(
  result: RecipientDeliveryResult,
  originalRecipients: readonly string[],
  archiveRecipient?: string,
): void {
  if (!archiveRecipient) return;

  const original = new Set(originalRecipients.map(mailboxComparisonKey));
  const accepted = new Set((result.accepted ?? []).map(normalizeDeliveryAddress).map(mailboxComparisonKey));
  const rejected = new Set((result.rejected ?? []).map(normalizeDeliveryAddress).map(mailboxComparisonKey));
  const archive = mailboxComparisonKey(archiveRecipient);
  const acceptedOriginal = [...original].some((recipient) => accepted.has(recipient));

  if (accepted.has(archive) && !acceptedOriginal) {
    throw new Error(
      'SMTP reported archive acceptance without any accepted original recipient; send cannot be considered successful',
    );
  }

  if (rejected.has(archive) && acceptedOriginal) {
    // Do not include the archive address, message content, or SMTP response.
    console.warn('[smtp] archive recipient rejected; preserving successful send for original recipients');
  }
}
