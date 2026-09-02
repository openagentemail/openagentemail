process.env.DOMAIN = 'test.example';
process.env.API_KEYS = 'admin-key';
process.env.IMAP_USER = 'agent@test.example';
process.env.IMAP_PASS = 'imap-secret';
process.env.SMTP_USER = 'agent@test.example';
process.env.SMTP_PASS = 'smtp-secret';

import { describe, expect, test } from 'bun:test';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import {
  buildOutboundStampHeaders,
  classifyMailSource,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  stampDate,
} from '../src/lib/mail-stamp.ts';
const {
  applyArchiveRecipientPolicy,
  buildSmtpEnvelope,
  stripBccHeaders,
} = await import('../src/lib/smtp.ts');

describe('automatic compliance BCC envelope', () => {
  test('adds one archive RCPT to single and multi-recipient envelopes', () => {
    expect(buildSmtpEnvelope('sender@test.example', ['one@example.net'], 'archive@example.net')).toEqual({
      from: 'sender@test.example',
      to: ['one@example.net', 'archive@example.net'],
    });
    expect(
      buildSmtpEnvelope(
        'sender@test.example',
        ['first@example.net', 'second@example.net'],
        'archive@example.net',
      ),
    ).toEqual({
      from: 'sender@test.example',
      to: ['first@example.net', 'second@example.net', 'archive@example.net'],
    });
  });

  test('deduplicates envelope RCPT case-insensitively while preserving original order', () => {
    expect(
      buildSmtpEnvelope(
        'sender@test.example',
        ['First@example.net', 'first@EXAMPLE.net', 'alias+legal@example.net'],
        'FIRST@example.net',
      ).to,
    ).toEqual(['First@example.net', 'alias+legal@example.net']);
  });

  test('keeps alias-shaped visible recipients untouched and serializes no archive/Bcc MIME header', async () => {
    const visible = ['team+legal@example.net', 'person@example.net'];
    const archive = 'archive@example.net';
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    const info = await transport.sendMail({
      from: 'sender@test.example',
      to: visible,
      subject: 'compliance check',
      text: 'body',
      headers: stripBccHeaders({ Bcc: archive, 'X-Archive-Test': 'present' }),
      envelope: buildSmtpEnvelope('sender@test.example', visible, archive),
    });
    const mime = (info.message as Buffer).toString('utf8');
    const parsed = await simpleParser(info.message as Buffer);

    expect(info.envelope.to).toEqual(['team+legal@example.net', 'person@example.net', archive]);
    const parsedTo = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [];
    expect(parsedTo.flatMap(({ value }) => value.map(({ address }) => address))).toEqual(visible);
    expect(mime).not.toMatch(/^bcc:/im);
    expect(mime).not.toContain(archive);
  });

  test('warns and stays successful only when the archive alone is rejected', () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(() =>
        applyArchiveRecipientPolicy(
          { accepted: ['one@example.net'], rejected: ['archive@example.net'] },
          ['one@example.net'],
          'archive@example.net',
        ),
      ).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      ['[smtp] archive recipient rejected; preserving successful send for original recipients'],
    ]);
  });

  test('does not let archive-only acceptance mask total primary rejection', () => {
    expect(() =>
      applyArchiveRecipientPolicy(
        { accepted: ['archive@example.net'], rejected: ['one@example.net'] },
        ['one@example.net'],
        'archive@example.net',
      ),
    ).toThrow('SMTP rejected all original recipients; archive acceptance does not make send successful');
  });

  test('a controlled archive does not change internal stamping for all-local visible recipients', () => {
    const original = ['recipient@test.example'];
    const text = 'trusted body';
    const date = stampDate(new Date('2026-09-01T00:00:00Z'));
    const headers = buildOutboundStampHeaders(
      { from: 'sender@test.example', to: original, subject: 'trusted', text },
      date,
      'archive-stamp-test-key',
      'test.example',
    );

    expect(buildSmtpEnvelope('sender@test.example', original, 'archive@example.net').to).toEqual([
      'recipient@test.example',
      'archive@example.net',
    ]);
    expect(
      classifyMailSource(
        headers['X-OA-Mail-Stamp'],
        {
          from: normalizeMailbox('sender@test.example'),
          to: normalizeToList(original),
          subject: 'trusted',
          dateIso: date.toISOString(),
          bodyHash: hashMailBody(text),
        },
        'archive-stamp-test-key',
      ),
    ).toBe('internal');
  });
});
