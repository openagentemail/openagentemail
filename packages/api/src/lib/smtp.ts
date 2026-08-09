/**
 * Outbound mail via the catch-all account on docker-mailserver.
 * The envelope/login is the catch-all user; the From header is the chosen
 * identity address — docker-mailserver is configured to allow that sender
 * rewrite for the catch-all account.
 */

import nodemailer from 'nodemailer';
import { config } from './config.ts';
import { buildOutboundStampHeaders, stampDate } from './mail-stamp.ts';

export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Server-stamped protocol metadata, for example X-OA-Task headers. */
  headers?: Record<string, string>;
}

export async function sendMail(input: SendInput): Promise<{ messageId: string }> {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
    tls: {
      // The bundled mailserver starts with a self-signed cert. External public
      // mail servers should set SMTP_TLS_REJECT_UNAUTHORIZED=true.
      rejectUnauthorized: config.smtp.tlsRejectUnauthorized,
    },
  });

  // 显式 Date + 毫秒归零：发读两侧 stamp 载荷用同一 ISO 字符串。
  const date = stampDate();
  // 每封经 API 发出的信自动带内部 stamp（覆盖调用方同名头）。
  const headers = buildOutboundStampHeaders(input, date, config.taskSigningSecret);

  try {
    const info = await transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      date,
      ...(input.html ? { html: input.html } : {}),
      headers,
    });
    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
}
