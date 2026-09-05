/**
 * Webhook Event Sink (§11.4, §6.2, §6.3).
 *
 * Implements the process-wide EventSink interface for outbound webhooks:
 * 1. handleMail: matches recipient addresses to active webhooks and enqueues mail.received deliveries.
 * 2. handleApproval: matches reviewer address to active webhooks and enqueues approval.requested deliveries (with §6.3 trimmed fields).
 */

import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import type { FetchMessageObject } from 'imapflow';
import { config } from './config.ts';
import type {
  ApprovalRequestedEvent,
  EventSink,
  MailDispatchContext,
  MailReceivedEvent,
  SinkWatermark,
} from './event-dispatcher.ts';
import { messageRecipients } from './imap.ts';
import { extractOtp, htmlToText } from './otp.ts';
import {
  enqueueWebhookDelivery,
  formatApprovalPayload,
  formatMailPayload,
  type ApprovalEventInput,
  type MailEventInput,
  type WebhookEnvelopeBase,
} from './webhook-delivery.ts';
import {
  listWebhookSubscriptions,
  WebhookStoreCorruptError,
  type WebhookSubscription,
} from './webhook-store.ts';

function rethrowStoreCorrupt(err: unknown): never {
  if (err instanceof WebhookStoreCorruptError) {
    throw Object.assign(err, { failureKind: 'service' as const });
  }
  throw err;
}

export function createWebhookSink(watermark: SinkWatermark = {}): EventSink {
  return {
    id: 'webhook',
    isEnabled: () => config.webhooks.enabled,
    watermark,

    async handleApproval(event: ApprovalRequestedEvent): Promise<void> {
      if (!config.webhooks.enabled) return;

      const task = event.task;
      if (!task || task.kind !== 'approval' || !task.approval) return;

      const reviewer = task.approval.reviewer;
      if (!reviewer) return;

      let allSubs: WebhookSubscription[];
      try {
        allSubs = listWebhookSubscriptions();
      } catch (err) {
        rethrowStoreCorrupt(err);
      }
      const matchedSubs = allSubs.filter(
        (sub) =>
          sub.state !== 'disabled' &&
          sub.events.includes('approval.requested') &&
          sub.address === reviewer,
      );

      if (matchedSubs.length === 0) return;

      const eventCreatedAt = new Date().toISOString();
      const createdAtMs = new Date(task.createdAt).getTime();
      const expiresAtMs = new Date(task.approval.expiresAt).getTime();
      const rawExpiresInSec = Math.floor((expiresAtMs - createdAtMs) / 1000);
      const expiresInSec = rawExpiresInSec > 0 ? rawExpiresInSec : null;

      const input: ApprovalEventInput = {
        taskId: task.id,
        taskState: 'input-required',
        from: task.from,
        to: task.to,
        reviewer,
        subject: task.subject,
        createdAt: task.createdAt,
        expiresAt: task.approval.expiresAt,
        expiresInSec,
        digest: task.approval.digest,
        actionType: task.approval.action.type,
        actionName: task.approval.action.name,
        actionArguments: task.approval.action.arguments,
      };

      const eventId = `evt_${randomUUID()}`;
      for (const sub of matchedSubs) {
        const envelope: WebhookEnvelopeBase = {
          id: eventId,
          type: 'approval.requested',
          payloadVersion: 'v1',
          createdAt: eventCreatedAt,
          domain: config.domain,
        };

        enqueueWebhookDelivery({
          subscription: sub,
          eventId,
          type: 'approval.requested',
          payloadBuilder: (currentSub) => formatApprovalPayload(currentSub, envelope, input),
          address: sub.address,
          taskId: task.id,
          taskCreatedAt: task.createdAt,
          expiresInSec,
          eventCreatedAt,
        });
      }
    },

    async handleMail(event: MailReceivedEvent, context?: MailDispatchContext): Promise<void> {
      if (!config.webhooks.enabled) return;

      const message = event.message;
      const uid = message.uid;
      const uidValidity =
        event.uidValidity !== undefined && event.uidValidity !== null
          ? Number(event.uidValidity)
          : null;
      const recipients = messageRecipients(message as FetchMessageObject);
      if (recipients.size === 0) return;

      let allSubs: WebhookSubscription[];
      try {
        allSubs = listWebhookSubscriptions();
      } catch (err) {
        rethrowStoreCorrupt(err);
      }
      const activeMailSubs = allSubs.filter(
        (s) => s.state !== 'disabled' && s.events.includes('mail.received'),
      );
      if (activeMailSubs.length === 0) return;

      // Group active subscriptions by matching recipient address
      const matchedByRecipient = new Map<string, WebhookSubscription[]>();
      for (const recipient of recipients) {
        const subsForRecipient = activeMailSubs.filter((s) => s.address === recipient);
        if (subsForRecipient.length > 0) {
          matchedByRecipient.set(recipient, subsForRecipient);
        }
      }

      if (matchedByRecipient.size === 0) return;

      // Parse message content once for all recipient deliveries
      const envelopeDate = message.envelope?.date;
      const receivedAt = (
        message.internalDate instanceof Date
          ? message.internalDate
          : message.internalDate
            ? new Date(message.internalDate)
            : envelopeDate instanceof Date
              ? envelopeDate
              : new Date()
      ).toISOString();

      const unread = !message.flags?.has('\\Seen');
      const sizeBytes = message.source ? message.source.length : 0;

      let subject = typeof message.envelope?.subject === 'string' ? message.envelope.subject : '';
      let fromAddress =
        (message.envelope?.from as Array<{ address?: string | null }> | undefined)?.[0]?.address ??
        'unknown@domain';
      let fromName =
        (message.envelope?.from as Array<{ name?: string | null }> | undefined)?.[0]?.name ??
        undefined;
      let toAddresses: string[] = (
        message.envelope?.to as Array<{ address?: string | null }> | undefined
      )
        ?.map((t) => t.address ?? '')
        .filter(Boolean) ?? [];
      let ccAddresses: string[] = (
        message.envelope?.cc as Array<{ address?: string | null }> | undefined
      )
        ?.map((c) => c.address ?? '')
        .filter(Boolean) ?? [];
      let rfc822MessageId: string | null = null;
      if (message.envelope?.messageId) {
        rfc822MessageId = Array.isArray(message.envelope.messageId)
          ? message.envelope.messageId[0] ?? null
          : String(message.envelope.messageId);
      }

      let text = '';
      let securityCodes: string[] = [];
      let links: string[] = [];
      let hasAttachments = false;

      if (message.source) {
        try {
          const parsed = await simpleParser(message.source);
          if (typeof parsed.subject === 'string') subject = parsed.subject;
          if (parsed.from?.value?.[0]?.address) {
            fromAddress = parsed.from.value[0].address;
            fromName = parsed.from.value[0].name || undefined;
          }
          if (parsed.to) {
            const list = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
            const addrs = list.flatMap((t) => t.value.map((v) => v.address || '')).filter(Boolean);
            if (addrs.length > 0) toAddresses = addrs;
          }
          if (parsed.cc) {
            const list = Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc];
            const addrs = list.flatMap((c) => c.value.map((v) => v.address || '')).filter(Boolean);
            if (addrs.length > 0) ccAddresses = addrs;
          }
          if (parsed.messageId) {
            rfc822MessageId = parsed.messageId;
          }

          const parsedText = (parsed.text ?? '').trim();
          const htmlText = parsed.html ? htmlToText(parsed.html) : '';
          text = parsedText || htmlText;

          const otp = extractOtp(text, parsed.html || undefined);
          securityCodes = otp.codes;
          links = otp.links;

          hasAttachments = (parsed.attachments?.length ?? 0) > 0;
        } catch {
          // Parsing failure: proceed with envelope metadata
        }
      }

      // Item 5: rfc822MessageId <= 512 bytes, overlong treated as null
      let boundedRfc822MessageId: string | null = null;
      if (rfc822MessageId) {
        const trimmed = String(rfc822MessageId).trim();
        if (Buffer.byteLength(trimmed, 'utf8') <= 512) {
          boundedRfc822MessageId = trimmed;
        }
      }

      const eventCreatedAt = new Date().toISOString();

      for (const [recipient, subs] of matchedByRecipient.entries()) {
        const input: MailEventInput = {
          address: recipient,
          messageId: String(uid),
          uid,
          uidValidity,
          receivedAt,
          from: {
            address: fromAddress,
            name: fromName,
          },
          to: toAddresses.length > 0 ? toAddresses : [recipient],
          cc: ccAddresses,
          subject,
          sizeBytes,
          hasAttachments,
          unread,
          containsSecurityCode: securityCodes.length > 0,
          containsLink: links.length > 0,
          textPreview: text,
          securityCodes,
          links,
        };

        const eventId = `evt_${randomUUID()}`;
        for (const sub of subs) {
          const envelope: WebhookEnvelopeBase = {
            id: eventId,
            type: 'mail.received',
            payloadVersion: 'v1',
            createdAt: eventCreatedAt,
            domain: config.domain,
          };

          enqueueWebhookDelivery({
            subscription: sub,
            eventId,
            type: 'mail.received',
            payloadBuilder: (currentSub) => formatMailPayload(currentSub, envelope, input),
            address: recipient,
            messageId: String(uid),
            uidValidity,
            rfc822MessageId: boundedRfc822MessageId,
            eventCreatedAt,
          });
        }
      }
    },
  };
}
