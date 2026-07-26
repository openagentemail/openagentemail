/**
 * IMAP access to the single catch-all mailbox (docker-mailserver/Dovecot).
 *
 * One-shot operations open a short-lived connection per call (same
 * philosophy as the reference webmail: on the same host the handshake is
 * sub-millisecond, pooling buys nothing at this scale). `waitForMessage`
 * is the one place that holds a connection open, for IMAP IDLE.
 *
 * Messages are matched to identities by the To/Cc/Delivered-To headers:
 * every identity is just an address that lands in this one mailbox.
 */

import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, MessageEnvelopeObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.ts';
import { extractOtp, htmlToText, type OtpExtraction } from './otp.ts';

export interface MessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  snippet: string;
}

export interface MessageDetail {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
  html?: string;
  otp: OtpExtraction;
}

export interface WaitFilters {
  fromContains?: string;
  subjectContains?: string;
}

/** How far back listMessages scans for address matches. */
const SCAN_BACK = 500;
/** Per-connection socket guard. */
const SOCKET_TIMEOUT_MS = 30_000;

function connectImap(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    // docker-mailserver ships a self-signed cert by default; the api reaches it
    // over the private compose network, so skip chain verification.
    tls: { rejectUnauthorized: false },
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
  return client.connect().then(() => client);
}

/**
 * Open a fresh connection, run `fn` with INBOX locked, always tear down.
 * On error the socket is dropped synchronously — a graceful LOGOUT can
 * queue behind a stuck command and re-block the caller.
 */
async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connectImap();
  let failed = false;
  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    lock.release();
    if (failed) {
      try {
        client.close();
      } catch {
        /* already dead */
      }
    } else {
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

function formatAddresses(list?: MessageEnvelopeObject['from']): string {
  if (!list || list.length === 0) return '';
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

function envelopeHasAddress(
  list: MessageEnvelopeObject['from'],
  needle: string,
): boolean {
  return (list ?? []).some((a) => (a.address ?? '').toLowerCase() === needle);
}

/** Does this message belong to the identity `address`? */
function messageMatchesAddress(msg: FetchMessageObject, address: string): boolean {
  const needle = address.toLowerCase();
  const env = msg.envelope;
  if (!env) return false;
  return (
    envelopeHasAddress(env.to, needle) ||
    envelopeHasAddress(env.cc, needle) ||
    envelopeHasAddress(env.bcc, needle) ||
    (msg.headers?.toString('utf8').toLowerCase().includes(needle) ?? false)
  );
}

function makeSnippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function parseSource(source: Buffer) {
  return simpleParser(source);
}

function toDetail(uid: number, parsed: Awaited<ReturnType<typeof parseSource>>): MessageDetail {
  const text = (parsed.text ?? '').trim() || (parsed.html ? htmlToText(parsed.html) : '');
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const toText = Array.isArray(parsed.to)
    ? parsed.to.map((a) => a.text).join(', ')
    : (parsed.to?.text ?? '');
  return {
    id: String(uid),
    from: parsed.from?.text ?? '',
    to: toText,
    subject: parsed.subject ?? '',
    date: (parsed.date ?? new Date(0)).toISOString(),
    text,
    ...(html ? { html } : {}),
    otp: extractOtp(text, html),
  };
}

/**
 * List newest-first message summaries for `address`, up to `limit`.
 * Two passes: envelopes+Delivered-To for the last SCAN_BACK messages to
 * find matches cheaply, then full source for the (≤ limit) matches to
 * build snippets.
 */
async function listMessagesWith(
  client: ImapFlow,
  address: string,
  limit: number,
): Promise<MessageSummary[]> {
  const uids = await client.search({ all: true }, { uid: true });
  if (!uids || uids.length === 0) return [];

  const recent = uids.slice(-SCAN_BACK);
  const matched: FetchMessageObject[] = [];
  for await (const msg of client.fetch(
    recent,
    { envelope: true, flags: true, headers: ['delivered-to'] },
    { uid: true },
  )) {
    if (messageMatchesAddress(msg, address)) matched.push(msg);
  }

  matched.sort(
    (a, b) => (b.envelope?.date?.getTime() ?? 0) - (a.envelope?.date?.getTime() ?? 0),
  );
  const page = matched.slice(0, limit);

  const summaries: MessageSummary[] = [];
  for (const msg of page) {
    let snippet = '';
    const full = await client.fetchOne(msg.uid, { source: true }, { uid: true });
    if (full && full.source) {
      try {
        const parsed = await parseSource(full.source);
        snippet = makeSnippet(
          (parsed.text ?? '').trim() || (parsed.html ? htmlToText(parsed.html) : ''),
        );
      } catch {
        // Unparseable message: summary still returns, just without snippet.
      }
    }
    const env = msg.envelope;
    summaries.push({
      id: String(msg.uid),
      from: formatAddresses(env?.from),
      to: formatAddresses(env?.to),
      subject: env?.subject ?? '',
      date: (env?.date ?? new Date(0)).toISOString(),
      seen: msg.flags?.has('\\Seen') ?? false,
      snippet,
    });
  }
  return summaries;
}

export async function listMessages(address: string, limit = 50): Promise<MessageSummary[]> {
  return withInbox((client) => listMessagesWith(client, address, limit));
}

/** Fetch one message by UID; null if missing or not addressed to `address`. */
async function getMessageWith(
  client: ImapFlow,
  address: string,
  id: string,
): Promise<MessageDetail | null> {
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const msg = await client.fetchOne(uid, { source: true, envelope: true, headers: ['delivered-to'] }, { uid: true });
  if (!msg || !msg.source || !messageMatchesAddress(msg, address)) return null;
  const parsed = await parseSource(msg.source);
  return toDetail(msg.uid, parsed);
}

export async function getMessage(address: string, id: string): Promise<MessageDetail | null> {
  return withInbox((client) => getMessageWith(client, address, id));
}

function summaryPassesFilters(summary: MessageSummary, filters: WaitFilters): boolean {
  if (
    filters.fromContains &&
    !summary.from.toLowerCase().includes(filters.fromContains.toLowerCase())
  ) {
    return false;
  }
  if (
    filters.subjectContains &&
    !summary.subject.toLowerCase().includes(filters.subjectContains.toLowerCase())
  ) {
    return false;
  }
  return true;
}

/** Newest matching full message for the filters, or null. */
async function findMatchWith(
  client: ImapFlow,
  address: string,
  filters: WaitFilters,
): Promise<MessageDetail | null> {
  const summaries = await listMessagesWith(client, address, 20);
  for (const summary of summaries) {
    if (!summaryPassesFilters(summary, filters)) continue;
    const detail = await getMessageWith(client, address, summary.id);
    if (detail) return detail;
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a message matching `filters` to appear for `address`.
 *
 * Hybrid strategy on one long-lived connection: re-check the mailbox,
 * then race IMAP IDLE against a 3 s heartbeat — IDLE gives instant wakeup
 * when Dovecot reports new mail, the heartbeat keeps us correct on
 * servers/connections where IDLE events get lost. If the IDLE connection
 * itself fails, fall back to plain 3 s polling with one-shot connections.
 *
 * Returns the message detail, or null on timeout (route maps to 408).
 */
export async function waitForMessage(
  address: string,
  filters: WaitFilters,
  timeoutSec: number,
): Promise<MessageDetail | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  try {
    return await waitWithIdle(address, filters, deadline);
  } catch (err) {
    console.warn('[imap] IDLE wait failed, falling back to polling:', (err as Error).message);
    return waitWithPolling(address, filters, deadline);
  }
}

async function waitWithIdle(
  address: string,
  filters: WaitFilters,
  deadline: number,
): Promise<MessageDetail | null> {
  const client = await connectImap();
  const lock = await client.getMailboxLock('INBOX');
  try {
    while (Date.now() < deadline) {
      const found = await findMatchWith(client, address, filters);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await Promise.race([client.idle(), sleep(Math.min(3000, remaining))]);
      } catch {
        await sleep(Math.min(3000, deadline - Date.now()));
      }
    }
    return null;
  } finally {
    lock.release();
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    }
  }
}

async function waitWithPolling(
  address: string,
  filters: WaitFilters,
  deadline: number,
): Promise<MessageDetail | null> {
  while (Date.now() < deadline) {
    try {
      const found = await withInbox((client) => findMatchWith(client, address, filters));
      if (found) return found;
    } catch (err) {
      console.warn('[imap] poll failed:', (err as Error).message);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(3000, remaining));
  }
  return null;
}
