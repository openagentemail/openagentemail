/** Fixed neutral wake text. Never interpolates subject, body, from, or URLs. */

import { isEventId, isSafeMessageId } from './ids.ts';

export function buildNeutralWakeText(options: {
  mailbox: string;
  eventId: string;
  messageId?: string | null;
}): string {
  if (!isEventId(options.eventId)) {
    throw new Error('invalid_event_id');
  }
  const parts = [
    `New-mail notification for mailbox ${options.mailbox}.`,
    `Event ${options.eventId}.`,
  ];
  if (options.messageId && isSafeMessageId(options.messageId)) {
    parts.push(`Message ${options.messageId}.`);
  }
  parts.push('Please read your own mailbox.');
  return parts.join(' ');
}

export function buildOrcaArgv(options: {
  orcaBinary: string;
  terminal: string;
  text: string;
}): string[] {
  return [
    options.orcaBinary,
    'terminal',
    'send',
    '--terminal',
    options.terminal,
    '--enter',
    '--text',
    options.text,
  ];
}
