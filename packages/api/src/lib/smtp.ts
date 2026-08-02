/**
 * Outbound mail via the catch-all account on docker-mailserver.
 * The envelope/login is the catch-all user; the From header is the chosen
 * identity address — docker-mailserver is configured to allow that sender
 * rewrite for the catch-all account.
 */

import nodemailer from 'nodemailer';
import { config } from './config.ts';

export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
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

  try {
    const info = await transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      ...(input.html ? { html: input.html } : {}),
    });
    return { messageId: info.messageId };
  } finally {
    transporter.close();
  }
}
