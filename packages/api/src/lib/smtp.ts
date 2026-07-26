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
      // docker-mailserver ships with a self-signed cert by default; the
      // SMTP hop is usually container-to-container on the same host.
      rejectUnauthorized: false,
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
