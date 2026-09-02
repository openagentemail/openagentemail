/**
 * Outbound mail via the catch-all account on docker-mailserver.
 * The envelope/login is the catch-all user; the From header is the chosen
 * identity address — docker-mailserver is configured to allow that sender
 * rewrite for the catch-all account.
 */

import nodemailer from 'nodemailer';
import { config } from './config.ts';
import { buildOutboundStampHeaders, stampDate } from './mail-stamp.ts';
import { htmlToText } from './otp.ts';
import { recordSentMessageIdAfterSend } from './sent-registry.ts';
import {
  applyArchiveRecipientPolicy,
  archiveRecipientToAppend,
  buildSmtpEnvelope,
  stripBccHeaders,
} from './smtp-envelope.ts';
import {
  withMailserverReconnect,
  type MailserverEndpoint,
} from './mailserver-reconnect.ts';

export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Server-stamped protocol metadata, for example X-OA-Task headers. */
  headers?: Record<string, string>;
}

/**
 * HTML-only 发信：空 text + 非空 html 时用同一套 htmlToText 填 text。
 * 否则 nodemailer 省略空 text 段，mailparser 又从 html 自推 text，bodyHash 对不上。
 */
export function coerceOutboundText(text: string, html?: string): string {
  if (text.trim() || !html) return text;
  return htmlToText(html);
}

// Retain these module exports for callers that imported the initial #72 seam.
export {
  applyArchiveRecipientPolicy,
  archiveRecipientToAppend,
  buildSmtpEnvelope,
  stripBccHeaders,
} from './smtp-envelope.ts';

function createSmtpTransport(endpoint: MailserverEndpoint) {
  return nodemailer.createTransport({
    host: endpoint.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: {
      // The bundled mailserver starts with a self-signed cert. External public
      // mail servers should set SMTP_TLS_REJECT_UNAUTHORIZED=true.
      rejectUnauthorized: config.smtp.tlsRejectUnauthorized,
      // A retry dials a freshly resolved IP only once, while TLS still verifies
      // the configured hostname instead of treating that container IP as identity.
      ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    },
  });
}

export async function sendMail(input: SendInput): Promise<{ messageId: string }> {
  // 显式 Date + 毫秒归零：发读两侧 stamp 载荷用同一 ISO 字符串。
  const date = stampDate();
  const text = coerceOutboundText(input.text, input.html);
  const outbound = { ...input, text };
  // 仅当全部 To 均在本域时写 stamp（防 HMAC 预言机随外发信泄漏）。
  const headers = stripBccHeaders(
    buildOutboundStampHeaders(outbound, date, config.taskSigningSecret, config.domain),
  );
  const archiveRecipient = archiveRecipientToAppend(input.to, config.alwaysBcc);
  const envelope = buildSmtpEnvelope(input.from, input.to, archiveRecipient);

  return withMailserverReconnect(config.smtp.host, async (endpoint) => {
    const transporter = createSmtpTransport(endpoint);
    try {
      const info = await transporter.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text,
        date,
        ...(input.html ? { html: input.html } : {}),
        headers,
        envelope,
      });
      applyArchiveRecipientPolicy(info, input.to, archiveRecipient);
      // 服务端真正出站成功才登记。登记失败不得否决这次投递（否则 502 重试会重复外发）。
      recordSentMessageIdAfterSend(info.messageId, input.from);
      return { messageId: info.messageId };
    } finally {
      transporter.close();
    }
  });
}
