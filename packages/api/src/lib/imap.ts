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
import { extractHttpLinks, extractOtp, htmlToText, type OtpExtraction } from './otp.ts';
import { MAX_EMAIL_HTML_LENGTH } from './sanitize-email-html.ts';

export interface MessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  snippet: string;
  hasOtp: boolean;
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
  links: string[];
}

export interface WaitFilters {
  fromContains?: string;
  subjectContains?: string;
}

/** 单条消息的最小统计记录：只保留统计所需的三个字段，绝不留正文/主题/发件人。 */
export interface ScanRecord {
  /** receivedAtMs(msg)，0 表示未知 */
  t: number;
  /** 是否已置 \Seen */
  s: boolean;
  /** 过滤后的收件人（小写整地址），可能被上界截断 */
  r: string[];
}

/** 一次窗口扫描的结果。`scannedAt` 不在此处 —— 由缓存层用注入时钟盖章（唯一时钟 seam）。 */
export interface MailboxScanResult {
  records: ScanRecord[];
  scanned: number;
  mailboxTotal: number;
  truncated: boolean;
  /** 触到任一内存上界 */
  partial: boolean;
  /** 被截断规则牺牲过的**身份**地址；投机地址被丢弃时不记名，故 |incompleteFor| ≤ 身份数 */
  incompleteFor: Set<string>;
  /** 扫描时刻的身份集，用于判定"扫描后才建的身份是否可信" */
  identityAddressesAtScan: string[];
}

/** How far back listMessages scans for address matches. */
export const SCAN_BACK = 500;
/** Per-connection socket guard. */
const SOCKET_TIMEOUT_MS = 30_000;
/** 单封信保留的收件人上限。 */
export const PER_MSG_MAX = 200;
/** 一次快照里保留的地址 key 总上限。 */
export const TOTAL_KEY_MAX = 5_000;

/** 只构造，不连接 —— 让取消监听能在 connect() 之前就拿到实例引用。 */
function createImapClient(): ImapFlow {
  return new ImapFlow({
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
}

export async function connectImap(): Promise<ImapFlow> {
  const client = createImapClient();
  await client.connect();
  return client;
}

/**
 * Open a fresh connection, run `fn` with INBOX locked, always tear down.
 * On error the socket is dropped synchronously — a graceful LOGOUT can
 * queue behind a stuck command and re-block the caller.
 */
async function withInbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connectImap();
  let failed = false;
  // Locking is inside the try: getMailboxLock can throw (INBOX missing, socket
  // dropped) and a connected client must never escape without being torn down.
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  try {
    lock = await client.getMailboxLock('INBOX');
    return await fn(client);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    lock?.release();
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

/**
 * 与 `withInbox` 同构，但受 `AbortSignal` 管辖，且**连接阶段也在管辖内**。
 *
 * 连接被拆成"同步构造 + 异步 connect"，取消监听在 `connect()` 之前就挂好：
 * 否则 DNS/TCP/TLS/LOGIN 卡住时无从取消，上层的扫描截止时间形同虚设，只能
 * 干等 30 s socket 超时。`closeOnce` 让 abort 路径与 finally 收尾共用一次
 * `close()`，因此"恰好关一次"是可断言的契约。
 */
export async function withInboxAbortable<T>(
  signal: AbortSignal,
  fn: (client: ImapFlow) => Promise<T>,
  { createClient = createImapClient }: { createClient?: () => ImapFlow } = {},
): Promise<T> {
  // ① 连接前就已取消
  if (signal.aborted) throw new Error('scan_aborted');
  // ② 同步拿到实例引用
  const client = createClient();
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    try {
      client.close();
    } catch {
      /* already dead / not connected */
    }
  };
  const onAbort = () => closeOnce();
  // ③ 先挂监听，再连接
  signal.addEventListener('abort', onAbort, { once: true });
  let failed = false;
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  try {
    // ④ 本阶段起，任何 stall 都会被 abort → close() 掐断
    await client.connect();
    if (signal.aborted) throw new Error('scan_aborted');
    lock = await client.getMailboxLock('INBOX');
    return await fn(client);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    lock?.release();
    if (!failed && !closed) {
      try {
        await client.logout();
      } catch {
        /* fall through to closeOnce */
      }
    }
    closeOnce();
  }
}

/**
 * 一次窗口扫描：SEARCH 全部 UID，取最新 `SCAN_BACK` 条的信封/标记/收件头，
 * 折成 per-UID 的最小记录。当前身份优先保留，被牺牲的身份逐个记名。
 */
export async function scanMailboxWindow(opts: {
  signal: AbortSignal;
  identityAddresses: string[];
  perMessageMax?: number;
  totalKeyMax?: number;
  createClient?: () => ImapFlow;
}): Promise<MailboxScanResult> {
  const perMessageMax = opts.perMessageMax ?? PER_MSG_MAX;
  const totalKeyMax = opts.totalKeyMax ?? TOTAL_KEY_MAX;
  const identitySet = new Set(opts.identityAddresses.map((a) => a.toLowerCase()));
  const domainSuffix = `@${config.domain}`;

  return withInboxAbortable(
    opts.signal,
    async (client) => {
      const found = await client.search({ all: true }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      const mailboxTotal = uids.length;
      const identityAddressesAtScan = [...identitySet];
      if (mailboxTotal === 0) {
        return {
          records: [],
          scanned: 0,
          mailboxTotal: 0,
          truncated: false,
          partial: false,
          incompleteFor: new Set<string>(),
          identityAddressesAtScan,
        };
      }

      const recent = uids.slice(-SCAN_BACK);
      const records: ScanRecord[] = [];
      // keys 只为全局上限计数
      const keys = new Set<string>();
      const incompleteFor = new Set<string>();
      let partial = false;

      // ⓪ 全局身份预留：身份集先于任何消息装进 keys，投机地址只能占剩余预算，
      //    身份永不被先到的投机地址跨消息挤掉。
      for (const address of identitySet) {
        if (keys.size < totalKeyMax) keys.add(address);
        else {
          incompleteFor.add(address);
          partial = true;
        }
      }

      for await (const msg of client.fetch(
        recent,
        { envelope: true, flags: true, internalDate: true, headers: ['delivered-to'] },
        { uid: true },
      )) {
        // ① 先过滤：只留"可能是身份"的地址
        const idHits: string[] = [];
        const domainOnly: string[] = [];
        for (const address of messageRecipients(msg)) {
          if (identitySet.has(address)) idHits.push(address);
          else if (address.endsWith(domainSuffix)) domainOnly.push(address);
        }

        // ② 单封上限：身份先进，剩余预算才给投机地址
        const kept: string[] = [];
        for (const address of idHits) {
          if (kept.length < perMessageMax) kept.push(address);
          else {
            incompleteFor.add(address);
            partial = true;
          }
        }
        for (const address of domainOnly) {
          if (kept.length < perMessageMax) kept.push(address);
          // 投机地址被丢弃只置 partial，不记名（保证 incompleteFor 有界）
          else partial = true;
        }

        // ③ 全局 key 上限：身份已在 ⓪ 预留，撞顶的只能是投机地址
        const final: string[] = [];
        for (const address of kept) {
          if (keys.has(address) || keys.size < totalKeyMax) {
            keys.add(address);
            final.push(address);
          } else {
            // 身份分支理论不可达，防御性记名
            if (identitySet.has(address)) incompleteFor.add(address);
            partial = true;
          }
        }

        records.push({
          t: receivedAtMs(msg),
          s: msg.flags?.has('\\Seen') ?? false,
          r: final,
        });
      }

      return {
        records,
        scanned: records.length,
        mailboxTotal,
        truncated: mailboxTotal > records.length,
        partial,
        incompleteFor,
        identityAddressesAtScan,
      };
    },
    opts.createClient ? { createClient: opts.createClient } : {},
  );
}

function formatAddresses(list?: MessageEnvelopeObject['from']): string {
  if (!list || list.length === 0) return '';
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .join(', ');
}

/**
 * Header fields that actually say "this message was delivered to X".
 * Anything else (Subject, X-*, ...) may quote an address without the message
 * belonging to it, so it must never grant read access. Only `delivered-to` is
 * fetched today; the rest are here so that widening the fetch later cannot
 * silently widen the trust boundary.
 */
const RECIPIENT_HEADERS = new Set([
  'delivered-to',
  'x-original-to',
  'envelope-to',
  'x-forwarded-to',
  'to',
  'cc',
  'bcc',
]);

const ADDRESS_RE = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+$/;

/** Drop RFC 5322 comments — an address inside `(...)` is not a recipient. */
function stripComments(value: string): string {
  let out = value;
  // Bounded loop so nested comments can't spin on pathological input.
  for (let depth = 0; depth < 8 && out.includes('('); depth++) {
    const next = out.replace(/\([^()]*\)/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * One address-list entry -> the mailbox it denotes, or undefined.
 * For `Name <mailbox>` only the angle-bracketed mailbox counts: a display
 * name may itself look like an address (`"victim@d" <other@d>`) and must not
 * be treated as a recipient.
 */
function parseRecipient(item: string): string | undefined {
  const angle = /<([^<>]*)>/.exec(item);
  const candidate = (angle ? angle[1] : item).trim().replace(/^[;,\s]+|[;,\s]+$/g, '');
  return ADDRESS_RE.test(candidate) ? candidate.toLowerCase() : undefined;
}

/** Every address the fetched recipient headers say this message went to. */
function headerRecipients(headers?: Buffer): Set<string> {
  const found = new Set<string>();
  if (!headers) return found;
  // Unfold continuation lines (leading whitespace) back onto their header.
  const unfolded = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    if (!RECIPIENT_HEADERS.has(line.slice(0, sep).trim().toLowerCase())) continue;
    for (const item of stripComments(line.slice(sep + 1)).split(',')) {
      const address = parseRecipient(item);
      if (address) found.add(address);
    }
  }
  return found;
}

/**
 * Does this message belong to the identity `address`?
 *
 * Matching is EXACT on whole mailboxes, never a substring: every identity
 * shares one catch-all mailbox, so this comparison is the only boundary
 * between identities. A substring test would let `k7d2@d` read mail for
 * `fox-k7d2@d`, and `ent@d` read the whole mailbox (Postfix stamps every
 * delivery with `Delivered-To: agent@d`).
 */
export function messageMatchesAddress(msg: FetchMessageObject, address: string): boolean {
  return messageRecipients(msg).has(address.toLowerCase());
}

/**
 * 这条消息按可信收件人头都投给了谁。无 envelope 一律空集合（保留 fail-closed）。
 *
 * 这里**没有任何上限或域名过滤** —— 它是授权与统计共用的唯一原语，一旦在此
 * 截断，`listMessages` / `getMessage` 的读权限边界就会跟着变窄。上界只存在于
 * `scanMailboxWindow` 的快照构建里。
 */
export function messageRecipients(msg: FetchMessageObject): Set<string> {
  const out = new Set<string>();
  const env = msg.envelope;
  // 与旧实现的 `if (!env) return false` 等价：没有信封就不承认任何收件人。
  if (!env) return out;
  for (const list of [env.to, env.cc, env.bcc]) {
    for (const a of list ?? []) {
      const addr = (a.address ?? '').toLowerCase();
      if (addr) out.add(addr);
    }
  }
  for (const addr of headerRecipients(msg.headers)) out.add(addr);
  return out;
}

/**
 * When the server actually received the message. The envelope Date is written
 * by the sender and can be anything (spam routinely carries far-future
 * dates), so INTERNALDATE wins — otherwise one forged header pins a message
 * to the top of the list and shadows the real mail from `wait_for`.
 */
export function receivedAtMs(msg: FetchMessageObject): number {
  // imapflow hands back a Date normally, a string on some servers.
  const toMs = (value?: string | Date): number | undefined => {
    if (!value) return undefined;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  };
  return toMs(msg.internalDate) ?? toMs(msg.envelope?.date) ?? 0;
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
  const extractableHtml =
    html && html.length <= MAX_EMAIL_HTML_LENGTH ? html : undefined;
  const toText = Array.isArray(parsed.to)
    ? parsed.to.map((a) => a.text).join(', ')
    : (parsed.to?.text ?? '');
  const otp = extractOtp(text, extractableHtml);
  return {
    id: String(uid),
    from: parsed.from?.text ?? '',
    to: toText,
    subject: parsed.subject ?? '',
    date: (parsed.date ?? new Date(0)).toISOString(),
    text,
    ...(html ? { html } : {}),
    otp,
    links: extractHttpLinks(text, extractableHtml),
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
    { envelope: true, flags: true, internalDate: true, headers: ['delivered-to'] },
    { uid: true },
  )) {
    if (messageMatchesAddress(msg, address)) matched.push(msg);
  }

  matched.sort((a, b) => receivedAtMs(b) - receivedAtMs(a));
  const page = matched.slice(0, limit);

  const summaries: MessageSummary[] = [];
  for (const msg of page) {
    let snippet = '';
    let hasOtp = false;
    const full = await client.fetchOne(msg.uid, { source: true }, { uid: true });
    if (full && full.source) {
      try {
        const parsed = await parseSource(full.source);
        const text =
          (parsed.text ?? '').trim() || (parsed.html ? htmlToText(parsed.html) : '');
        const html = typeof parsed.html === 'string' ? parsed.html : undefined;
        snippet = makeSnippet(text);
        const otp = extractOtp(text, html);
        hasOtp = otp.codes.length > 0 || otp.links.length > 0;
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
      hasOtp,
    });
  }
  return summaries;
}

export async function listMessages(address: string, limit = 50): Promise<MessageSummary[]> {
  return withInbox((client) => listMessagesWith(client, address, limit));
}

/**
 * Permanently delete every message with an internal date before `cutoff`
 * from the catch-all mailbox. Used by the retention sweeper; identity
 * scoping is irrelevant here — retention applies to the whole mailbox.
 * Returns the number of messages deleted.
 */
export async function deleteMessagesBefore(cutoff: Date): Promise<number> {
  return withInbox(async (client) => {
    const uids = await client.search({ before: cutoff }, { uid: true });
    if (!uids || uids.length === 0) return 0;
    // messageDelete flags \Deleted AND expunges in one go (imapflow default).
    await client.messageDelete(uids, { uid: true });
    return uids.length;
  });
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
  let failed = false;
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  try {
    lock = await client.getMailboxLock('INBOX');
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
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    lock?.release();
    if (failed) {
      // Same reasoning as withInbox: on the error path drop the socket
      // instead of waiting on a LOGOUT that may queue behind a stuck command.
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
