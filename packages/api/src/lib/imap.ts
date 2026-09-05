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
import type { AddressObject } from 'mailparser';
import { config } from './config.ts';
import {
  decodeMailCursor,
  decodeMailForwardCursor,
  encodeMailCursor,
  encodeMailForwardCursor,
  InvalidMailCursorError,
  type MailFolder,
  type MailForwardCursorPayload,
} from './mail-cursor.ts';
import {
  classifyMailSource,
  hashMailBody,
  normalizeMailbox,
  normalizeToList,
  type MailSource,
} from './mail-stamp.ts';
import { extractHttpLinks, extractOtp, htmlToText, type OtpExtraction } from './otp.ts';
import { MAX_EMAIL_HTML_LENGTH } from './sanitize-email-html.ts';
import { hasSentMessageId, normalizeMessageId } from './sent-registry.ts';
import { truncateUtf8Bytes } from './utf8-truncate.ts';
import {
  withMailserverReconnect,
  type MailserverEndpoint,
} from './mailserver-reconnect.ts';

export type { MailFolder };
export { InvalidMailCursorError } from './mail-cursor.ts';

export type { MailSource };

export interface MessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  seen: boolean;
  snippet: string;
  hasOtp: boolean;
  /** HMAC 自签 stamp 判定：通过为 internal，否则一律 external（fail-closed）。 */
  source: MailSource;
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
  /** HMAC 自签 stamp 判定：通过为 internal，否则一律 external（fail-closed）。 */
  source: MailSource;
  /** Present only for server-stamped task mail. */
  taskId?: string;
  /** Present only for server-stamped task mail. */
  taskState?: string;
}

export interface WaitFilters {
  fromContains?: string;
  subjectContains?: string;
  /** Internal task wait filter. This is not exposed by the generic mail API. */
  taskId?: string;
  /** Internal task wait filter. Matches a server-stamped X-OA-Task-State. */
  taskStates?: string[];
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

/** Source 视图字节上限：超过则截断并标 truncated（永不把整封原始信交给列表预取）。 */
export const MAX_EMAIL_SOURCE_LENGTH = 256 * 1024;

/** 游标分页列表页。nextCursor 为 null 表示没有下一页。 */
export interface MessageListPage {
  messages: MessageSummary[];
  nextCursor: string | null;
}

/** 受控 Source 载荷：UTF-8 文本 + 是否截断 + 原始字节长度。 */
export interface MessageSourcePayload {
  id: string;
  source: string;
  truncated: boolean;
  byteLength: number;
}

/** 消息代际（uidValidity）不匹配。路由折成 404 stale_message_generation。 */
export class StaleMessageGenerationError extends Error {
  readonly code = 'stale_message_generation';
  constructor() {
    super('stale_message_generation');
    this.name = 'StaleMessageGenerationError';
  }
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
type ImapClientFactory = (endpoint?: MailserverEndpoint) => ImapFlow;
type MailserverResolver = (hostname: string) => Promise<string>;

function createImapClient(endpoint: MailserverEndpoint = { host: config.imap.host }): ImapFlow {
  return new ImapFlow({
    host: endpoint.host,
    ...(endpoint.servername ? { servername: endpoint.servername } : {}),
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass },
    // The bundled mailserver starts with a self-signed cert. External public
    // mail servers should set IMAP_TLS_REJECT_UNAUTHORIZED=true.
    tls: { rejectUnauthorized: config.imap.tlsRejectUnauthorized },
    logger: false,
    socketTimeout: SOCKET_TIMEOUT_MS,
  });
}

async function connectImapClient(
  createClient: ImapClientFactory = createImapClient,
  {
    beforeConnect,
    beforeRetry,
    beforeRetryConnect,
    resolveMailserver,
    closeOnConnectError = true,
  }: {
    beforeConnect?: (client: ImapFlow) => void;
    beforeRetry?: (error: unknown) => void | Promise<void>;
    beforeRetryConnect?: () => void;
    resolveMailserver?: MailserverResolver;
    closeOnConnectError?: boolean;
  } = {},
): Promise<ImapFlow> {
  return withMailserverReconnect(
    config.imap.host,
    async (endpoint) => {
      const client = createClient(endpoint);
      beforeConnect?.(client);
      try {
        await client.connect();
        return client;
      } catch (error) {
        if (closeOnConnectError) {
          try {
            client.close();
          } catch {
            /* already dead */
          }
        }
        throw error;
      }
    },
    { beforeRetry, beforeRetryConnect, resolve: resolveMailserver },
  );
}

export async function connectImap(): Promise<ImapFlow> {
  return connectImapClient();
}

/**
 * Open a fresh connection, run `fn` with INBOX locked, always tear down.
 * On error the socket is dropped synchronously — a graceful LOGOUT can
 * queue behind a stuck command and re-block the caller.
 */
export async function withInbox<T>(
  fn: (client: ImapFlow) => Promise<T>,
  {
    createClient = createImapClient,
    error = console.error,
    resolveMailserver,
  }: { createClient?: ImapClientFactory; error?: typeof console.error; resolveMailserver?: MailserverResolver } = {},
): Promise<T> {
  let client: ImapFlow | undefined;
  let failed = false;
  const closedClients = new WeakSet<ImapFlow>();
  let connectionError: Error | undefined;
  const closeOnce = (target = client) => {
    if (!target || closedClients.has(target)) return;
    closedClients.add(target);
    try {
      target.close();
    } catch {
      /* already dead */
    }
  };
  const createTrackedClient: ImapClientFactory = (endpoint) => {
    const candidate = createClient(endpoint);
    client = candidate;
    candidate.on('error', (err) => {
      if (candidate !== client) return;
      connectionError = err instanceof Error ? err : new Error(String(err));
      failed = true;
      error('[imap] INBOX connection error; closing current operation');
      closeOnce(candidate);
    });
    return candidate;
  };
  // Keep this listener for the one-shot client's full lifetime: socket destroy
  // may emit after teardown returns. The client and closure are collected together.
  // Locking is inside the try: getMailboxLock can throw (INBOX missing, socket
  // dropped) and a connected client must never escape without being torn down.
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    client = await connectImapClient(createTrackedClient, {
      beforeRetry: () => {
        const failedClient = client;
        client = undefined;
        closeOnce(failedClient);
        connectionError = undefined;
        failed = false;
      },
      resolveMailserver,
      closeOnConnectError: false,
    });
    if (connectionError) throw connectionError;
    lock = await client.getMailboxLock('INBOX');
    if (connectionError) throw connectionError;
    result = await fn(client);
    if (connectionError) throw connectionError;
  } catch (err) {
    failed = true;
    operationFailed = true;
    operationError = err;
  } finally {
    lock?.release();
    if (failed || !client || closedClients.has(client)) {
      closeOnce();
    } else {
      try {
        await client!.logout();
      } catch {
        closeOnce();
      }
    }
  }
  if (connectionError) throw connectionError;
  if (operationFailed) throw operationError;
  return result as T;
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
  {
    createClient = createImapClient,
    error = console.error,
    resolveMailserver,
  }: { createClient?: ImapClientFactory; error?: typeof console.error; resolveMailserver?: MailserverResolver } = {},
): Promise<T> {
  // ① 连接前就已取消
  if (signal.aborted) throw new Error('scan_aborted');
  // ② 同步拿到实例引用
  let client: ImapFlow | undefined;
  const closedClients = new WeakSet<ImapFlow>();
  const closeOnce = (target = client) => {
    if (!target || closedClients.has(target)) return;
    closedClients.add(target);
    try {
      target.close();
    } catch {
      /* already dead / not connected */
    }
  };
  const onAbort = () => closeOnce();
  let failed = false;
  let connectionError: Error | undefined;
  const createTrackedClient: ImapClientFactory = (endpoint) => {
    const candidate = createClient(endpoint);
    client = candidate;
    candidate.on('error', (err) => {
      if (candidate !== client) return;
      connectionError = err instanceof Error ? err : new Error(String(err));
      failed = true;
      error('[imap] abortable INBOX connection error; closing current operation');
      closeOnce(candidate);
    });
    return candidate;
  };
  // ③ 先挂监听，再连接
  signal.addEventListener('abort', onAbort, { once: true });
  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  // Keep this listener through any late socket-destroy event. This one-shot
  // client is discarded after the call, so the client/closure cycle is collectible.
  try {
    // ④ 本阶段起，任何 stall 都会被 abort → close() 掐断
    client = await connectImapClient(createTrackedClient, {
      beforeRetry: () => {
        const failedClient = client;
        client = undefined;
        closeOnce(failedClient);
        if (signal.aborted) throw new Error('scan_aborted');
        connectionError = undefined;
        failed = false;
      },
      beforeRetryConnect: () => {
        if (signal.aborted) throw new Error('scan_aborted');
      },
      resolveMailserver,
      closeOnConnectError: false,
    });
    if (connectionError) throw connectionError;
    if (signal.aborted) throw new Error('scan_aborted');
    lock = await client.getMailboxLock('INBOX');
    if (connectionError) throw connectionError;
    result = await fn(client);
    if (connectionError) throw connectionError;
  } catch (err) {
    failed = true;
    operationFailed = true;
    operationError = err;
  } finally {
    signal.removeEventListener('abort', onAbort);
    lock?.release();
    if (!failed && client && !closedClients.has(client)) {
      try {
        await client!.logout();
      } catch {
        /* fall through to closeOnce */
      }
    }
    closeOnce();
  }
  if (connectionError) throw connectionError;
  if (operationFailed) throw operationError;
  return result as T;
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
          if (identitySet.has(address)) {
            idHits.push(address);
          } else {
            const at = address.lastIndexOf('@');
            const domain = at === -1 ? '' : address.slice(at + 1);
            if (config.allDomains.has(domain)) {
              domainOnly.push(address);
            }
          }
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
 * 信封 From 的精确邮箱集合（不含显示名）。无 envelope 一律空（fail-closed）。
 * Sent 文件夹与详情 ACL 都走这里，禁止子串匹配。
 */
export function messageSenders(msg: FetchMessageObject): Set<string> {
  const out = new Set<string>();
  const env = msg.envelope;
  if (!env) return out;
  for (const a of env.from ?? []) {
    const addr = (a.address ?? '').toLowerCase();
    if (addr) out.add(addr);
  }
  return out;
}

/** 信封 Message-ID（IMAP ENVELOPE）；缺失则 fail-closed 不当 Sent。 */
export function messageEnvelopeId(msg: FetchMessageObject): string | null {
  const raw = msg.envelope?.messageId;
  return normalizeMessageId(typeof raw === 'string' ? raw : undefined);
}

/**
 * 可信 Sent：信封 From 匹配 **且** Message-ID 在服务端出站登记表。
 * 伪造 From 的入站信永不进 Sent。
 */
export function messageIsTrustedSent(msg: FetchMessageObject, address: string): boolean {
  const addr = address.toLowerCase();
  if (!messageSenders(msg).has(addr)) return false;
  const id = messageEnvelopeId(msg);
  return id !== null && hasSentMessageId(id, addr);
}

/** 该身份是否可读这封信：Inbox（TO）或可信 Sent（FROM∧registry）。 */
export function messageAccessibleToAddress(msg: FetchMessageObject, address: string): boolean {
  const addr = address.toLowerCase();
  return messageRecipients(msg).has(addr) || messageIsTrustedSent(msg, addr);
}

/** 这封信是否属于指定 folder 集合。 */
export function messageBelongsToFolder(
  msg: FetchMessageObject,
  address: string,
  folder: MailFolder,
): boolean {
  const addr = address.toLowerCase();
  if (folder === 'inbox') return messageRecipients(msg).has(addr);
  if (folder === 'sent') return messageIsTrustedSent(msg, addr);
  return messageAccessibleToAddress(msg, addr);
}

/** newest-first：(receivedAtMs desc, uid desc)，避免同毫秒跳页/重复。 */
function compareNewestFirst(a: FetchMessageObject, b: FetchMessageObject): number {
  const dt = receivedAtMs(b) - receivedAtMs(a);
  if (dt !== 0) return dt;
  return b.uid - a.uid;
}

/** 严格小于游标键，保证下一页不重复、不跳过同毫秒条目。 */
function isAfterCursor(msg: FetchMessageObject, t: number, uid: number): boolean {
  const received = receivedAtMs(msg);
  if (received < t) return true;
  if (received > t) return false;
  return msg.uid < uid;
}

/** oldest-first：(receivedAtMs asc, uid asc)，保证前向追补顺序无损递进。 */
export function compareOldestFirst(a: FetchMessageObject, b: FetchMessageObject): number {
  const dt = receivedAtMs(a) - receivedAtMs(b);
  if (dt !== 0) return dt;
  return a.uid - b.uid;
}

/** 严格大于前向游标键，保证追补不重复、不跳过同毫秒条目。 */
export function isAfterForwardCursor(msg: FetchMessageObject, t: number, uid: number): boolean {
  const received = receivedAtMs(msg);
  if (received > t) return true;
  if (received < t) return false;
  return msg.uid > uid;
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

/** 从 mailparser 的 AddressObject（或数组）抽出邮箱列表，供 stamp 重算。 */
function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const obj of objects) {
    for (const entry of obj.value ?? []) {
      if (entry.address) out.push(entry.address);
    }
  }
  return out;
}

/**
 * 按与 sendMail 相同的字段规约，从已解析邮件重算并比对 X-OA-Mail-Stamp。
 * 任何不确定（无头 / 坏头 / 字段缺失 / 正文被换）→ external。
 */
function sourceFromParsed(parsed: Awaited<ReturnType<typeof parseSource>>): MailSource {
  const stampRaw = parsed.headers.get('x-oa-mail-stamp');
  const stamp = typeof stampRaw === 'string' ? stampRaw : undefined;
  const fromAddrs = addressList(parsed.from);
  const toAddrs = addressList(parsed.to);
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  // 与 smtp.sendMail 一致：from/to 规约 + 正文摘要（防偷头换正文）。
  const fields = {
    from: fromAddrs[0] ? normalizeMailbox(fromAddrs[0]) : '',
    to: normalizeToList(toAddrs),
    subject: parsed.subject ?? '',
    dateIso: (parsed.date ?? new Date(0)).toISOString(),
    bodyHash: hashMailBody(parsed.text ?? '', html),
  };
  return classifyMailSource(stamp, fields, config.taskSigningSecret);
}

function toDetail(uid: number, parsed: Awaited<ReturnType<typeof parseSource>>): MessageDetail {
  const text = (parsed.text ?? '').trim() || (parsed.html ? htmlToText(parsed.html) : '');
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const extractableHtml =
    html && html.length <= MAX_EMAIL_HTML_LENGTH ? html : undefined;
  const toText = Array.isArray(parsed.to)
    ? parsed.to.map((a) => a.text).join(', ')
    : (parsed.to?.text ?? '');
  // OTP / links 在围栏之前提取（围栏只在 MCP 序列化层），此处不受影响。
  const otp = extractOtp(text, extractableHtml);
  const taskId = parsed.headers.get('x-oa-task');
  const taskState = parsed.headers.get('x-oa-task-state');
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
    source: sourceFromParsed(parsed),
    ...(typeof taskId === 'string' ? { taskId } : {}),
    ...(typeof taskState === 'string' ? { taskState } : {}),
  };
}

/**
 * List newest-first message summaries for `address` in `folder`, up to `limit`.
 * Two passes: envelopes+Delivered-To for the last SCAN_BACK messages to
 * find matches cheaply, then full source for the (≤ limit) matches to
 * build snippets. Cursor is HMAC-bound to folder+address+(t,uid).
 */
async function listMessagesPageWith(
  client: ImapFlow,
  address: string,
  opts: { limit: number; folder: MailFolder; cursor?: string },
): Promise<MessageListPage> {
  const folder = opts.folder;
  const limit = opts.limit;
  const normalized = address.toLowerCase();
  let cursorT: number | undefined;
  let cursorUid: number | undefined;
  if (opts.cursor) {
    const cursor = decodeMailCursor(opts.cursor, config.taskSigningSecret);
    if (cursor.folder !== folder || cursor.address !== normalized) {
      throw new InvalidMailCursorError();
    }
    cursorT = cursor.t;
    cursorUid = cursor.uid;
  }

  const uids = await client.search({ all: true }, { uid: true });
  if (!uids || uids.length === 0) return { messages: [], nextCursor: null };

  const recent = uids.slice(-SCAN_BACK);
  const matched: FetchMessageObject[] = [];
  for await (const msg of client.fetch(
    recent,
    { envelope: true, flags: true, internalDate: true, headers: ['delivered-to'] },
    { uid: true },
  )) {
    if (messageBelongsToFolder(msg, normalized, folder)) matched.push(msg);
  }

  matched.sort(compareNewestFirst);
  const afterCursor =
    cursorT === undefined || cursorUid === undefined
      ? matched
      : matched.filter((msg) => isAfterCursor(msg, cursorT, cursorUid));
  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > limit;

  const summaries = await buildMessageSummaries(client, page);

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeMailCursor(
          {
            folder,
            address: normalized,
            t: receivedAtMs(last),
            uid: last.uid,
          },
          config.taskSigningSecret,
        )
      : null;
  return { messages: summaries, nextCursor };
}

async function buildMessageSummaries(
  client: ImapFlow,
  page: FetchMessageObject[],
): Promise<MessageSummary[]> {
  const summaries: MessageSummary[] = [];
  for (const msg of page) {
    let snippet = '';
    let hasOtp = false;
    // 无源码或解析失败时 fail-closed：按 external 处理。
    let source: MailSource = 'external';
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
        // list 已对命中消息做全量 parse，source 判定零额外 IMAP 成本。
        source = sourceFromParsed(parsed);
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
      source,
    });
  }
  return summaries;
}

/**
 * 前向 since 查询：从指定前向游标之后 oldest-first 遍历邮件（保证无损追补）。
 * 载荷绑定 uidValidity，当前代际不匹配则 fail-closed 抛 InvalidMailCursorError。
 */
async function listMessagesSinceWith(
  client: ImapFlow,
  address: string,
  sinceCursor: string,
  opts: { limit: number; folder?: MailFolder },
): Promise<MessageListPage> {
  const folder = opts.folder ?? 'inbox';
  const limit = opts.limit;
  const normalized = address.toLowerCase();

  const cursor = decodeMailForwardCursor(sinceCursor, config.taskSigningSecret);
  if (cursor.folder !== folder || cursor.address !== normalized) {
    throw new InvalidMailCursorError();
  }

  const currentUidValidity = client.mailbox ? client.mailbox.uidValidity : undefined;
  if (
    currentUidValidity === undefined ||
    BigInt(cursor.uidValidity) !== BigInt(currentUidValidity)
  ) {
    throw new InvalidMailCursorError();
  }

  const uids = await client.search({ all: true }, { uid: true });
  if (!uids || uids.length === 0) return { messages: [], nextCursor: null };

  const candidateUids = uids.filter((u) => u > cursor.uid).sort((a, b) => a - b);
  if (candidateUids.length === 0) return { messages: [], nextCursor: null };

  const matched: FetchMessageObject[] = [];
  let chunkStart = 0;
  while (chunkStart < candidateUids.length && matched.length <= limit) {
    const chunk = candidateUids.slice(chunkStart, chunkStart + SCAN_BACK);
    chunkStart += SCAN_BACK;
    for await (const msg of client.fetch(
      chunk,
      { envelope: true, flags: true, internalDate: true, headers: ['delivered-to'] },
      { uid: true },
    )) {
      if (
        messageBelongsToFolder(msg, normalized, folder) &&
        isAfterForwardCursor(msg, cursor.t, cursor.uid)
      ) {
        matched.push(msg);
      }
    }
  }

  matched.sort(compareOldestFirst);
  const page = matched.slice(0, limit);
  const hasMore = matched.length > limit;

  const summaries = await buildMessageSummaries(client, page);

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeMailForwardCursor(
          {
            folder,
            address: normalized,
            t: receivedAtMs(last),
            uid: last.uid,
            uidValidity: Number(currentUidValidity),
          },
          config.taskSigningSecret,
        )
      : null;

  return { messages: summaries, nextCursor };
}

export async function listMessagesPage(
  address: string,
  opts: { limit?: number; folder?: MailFolder; cursor?: string; since?: string } = {},
): Promise<MessageListPage> {
  if (opts.since) {
    return listMessagesSince(address, opts.since, opts.limit, opts.folder);
  }
  return withInbox((client) =>
    listMessagesPageWith(client, address, {
      limit: opts.limit ?? 50,
      folder: opts.folder ?? 'inbox',
      cursor: opts.cursor,
    }),
  );
}

/** 前向 since 查询对外接口：从指定游标向后 oldest-first 追补。 */
export async function listMessagesSince(
  address: string,
  sinceCursor: string,
  limit = 50,
  folder: MailFolder = 'inbox',
): Promise<MessageListPage> {
  return withInbox((client) =>
    listMessagesSinceWith(client, address, sinceCursor, { limit, folder }),
  );
}

/** v1/MCP 契约：Inbox（TO 匹配）最近 N 条，不含游标。 */
export async function listMessages(address: string, limit = 50): Promise<MessageSummary[]> {
  const page = await listMessagesPage(address, { limit, folder: 'inbox' });
  return page.messages;
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
    const deletable: number[] = [];
    // Task threads are durable state. Retention may delete ordinary mail in
    // the shared catch-all mailbox, but must never silently remove a message
    // carrying the task thread key.
    for await (const message of client.fetch(
      uids,
      { headers: ['x-oa-task'] },
      { uid: true },
    )) {
      const taskHeader = message.headers
        ?.toString('utf8')
        .replace(/\r?\n[ \t]+/g, ' ')
        .match(/^x-oa-task\s*:/im);
      if (!taskHeader) deletable.push(message.uid);
    }
    if (deletable.length === 0) return 0;
    // messageDelete flags \Deleted AND expunges in one go (imapflow default).
    await client.messageDelete(deletable, { uid: true });
    return deletable.length;
  });
}

/** Fetch one message by UID; null if missing or not readable by `address`. */
async function getMessageWith(
  client: ImapFlow,
  address: string,
  id: string,
  opts?: { uidValidity?: number },
): Promise<MessageDetail | null> {
  const currentUidValidity = client.mailbox ? client.mailbox.uidValidity : undefined;
  if (opts?.uidValidity !== undefined) {
    if (
      currentUidValidity === undefined ||
      BigInt(opts.uidValidity) !== BigInt(currentUidValidity)
    ) {
      throw new StaleMessageGenerationError();
    }
  }
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const msg = await client.fetchOne(uid, { source: true, envelope: true, headers: ['delivered-to'] }, { uid: true });
  if (!msg || !msg.source || !messageAccessibleToAddress(msg, address)) return null;
  const parsed = await parseSource(msg.source);
  return toDetail(msg.uid, parsed);
}

export async function getMessage(
  address: string,
  id: string,
  opts?: { uidValidity?: number },
): Promise<MessageDetail | null> {
  return withInbox((client) => getMessageWith(client, address, id, opts));
}

/**
 * 受控 Source：同详情 ACL，按字节上限截断。列表路径不得调用本函数。
 */
async function getMessageSourceWith(
  client: ImapFlow,
  address: string,
  id: string,
): Promise<MessageSourcePayload | null> {
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const msg = await client.fetchOne(
    uid,
    { source: true, envelope: true, headers: ['delivered-to'] },
    { uid: true },
  );
  if (!msg || !msg.source || !messageAccessibleToAddress(msg, address)) return null;
  const buf = Buffer.isBuffer(msg.source) ? msg.source : Buffer.from(msg.source);
  const truncated = buf.length > MAX_EMAIL_SOURCE_LENGTH;
  const slice = truncated ? truncateUtf8Bytes(buf, MAX_EMAIL_SOURCE_LENGTH) : buf;
  return {
    id: String(msg.uid),
    source: slice.toString('utf8'),
    truncated,
    byteLength: buf.length,
  };
}

export async function getMessageSource(
  address: string,
  id: string,
): Promise<MessageSourcePayload | null> {
  return withInbox((client) => getMessageSourceWith(client, address, id));
}

/**
 * Set or clear the \Seen flag on one message. The same address-matching rule
 * as reads applies first, so an identity token can only flag mail it can read
 * (TO，或 FROM∧出站登记)。Returns false when the message does not exist or is not
 * accessible to `address` (routes map that to 404, same as reads).
 */
export async function setMessageSeen(
  address: string,
  id: string,
  seen: boolean,
): Promise<boolean> {
  return withInbox(async (client) => {
    const uid = Number(id);
    if (!Number.isInteger(uid) || uid <= 0) return false;
    const msg = await client.fetchOne(
      uid,
      { envelope: true, headers: ['delivered-to'] },
      { uid: true },
    );
    if (!msg || !messageAccessibleToAddress(msg, address)) return false;
    if (seen) await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
    return true;
  });
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

function detailPassesFilters(detail: MessageDetail, filters: WaitFilters): boolean {
  if (filters.taskId && detail.taskId !== filters.taskId) return false;
  if (filters.taskStates && !filters.taskStates.includes(detail.taskState ?? '')) return false;
  return true;
}

/** Newest matching full message for the filters, or null. */
async function findMatchWith(
  client: ImapFlow,
  address: string,
  filters: WaitFilters,
): Promise<MessageDetail | null> {
  // Task waits must not be limited by the ordinary newest-20 mailbox view:
  // a busy identity can receive many unrelated messages while a task runs.
  if (filters.taskId) {
    const uids = await client.search({ header: { 'x-oa-task': filters.taskId } }, { uid: true });
    for (const uid of (Array.isArray(uids) ? [...uids] : []).reverse()) {
      const detail = await getMessageWith(client, address, String(uid));
      if (detail && detailPassesFilters(detail, filters)) return detail;
    }
    return null;
  }
  const page = await listMessagesPageWith(client, address, {
    limit: 20,
    folder: 'inbox',
  });
  for (const summary of page.messages) {
    if (!summaryPassesFilters(summary, filters)) continue;
    const detail = await getMessageWith(client, address, summary.id);
    if (detail && detailPassesFilters(detail, filters)) return detail;
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
