/**
 * POST /v1/send 的可选幂等键。
 *
 * 键按发件身份分开。身份与 checkSendLimit / findIdentity 一样，整段小写。
 * 同一键换一个身份互不影响。内存和 send-log 都不存原始键，只存 sha256。
 *
 * 占位在同一次同步调用里完成，后面的 await（冷却日志、SMTP）插不进第二封。
 * 已完成且指纹相同、仍在保留期内：调用方回放当时的状态码和 JSON。
 * 指纹不同（已完成或仍在发送）：拒绝复用。同一指纹仍在发送：409，不发第二封。
 *
 * 记成已完成的只有两类：200，以及 SMTP 对端已经应答的 502。
 * 冷却、额度和其他 4xx/429，以及从未到达 SMTP 的连接类失败，都放开这把键，
 * 调用方可以原样重试。这些响应不缓存。
 *
 * 保留 24 小时。表满 10000 时先丢掉过期的已完成项，再逐出最老的已完成项。
 * 进行中的占位不逐出。全是占位时拒绝新键。
 * 重启只从发送日志重建已完成项：窗口内的 queued，以及 failureKind 为 smtp_response。
 * sentAt 在未来的行忽略。没有哈希字段的旧行忽略。
 */

import { createHash } from 'node:crypto';

/** 已完成项保留多久。重启回放用同一个窗口。 */
export const SEND_IDEMPOTENCY_TTL_SEC = 86_400;
/** 内存表上限。进行中的占位也算。 */
export const SEND_IDEMPOTENCY_MAX_ENTRIES = 10_000;
/** 与 webhooks 的 Idempotency-Key 上限相同。 */
const IDEMPOTENCY_KEY_MAX = 128;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SendIdempotencyReservation = {
  id: number;
  scopeId: string;
  /** 原始键的 sha256，十六进制。给发送日志用，不是原始键。 */
  keyHash: string;
  /** 校验后 body 的指纹。 */
  requestHash: string;
};

export type CachedSendStatus = 200 | 502;

export type SendIdempotencyBegin =
  | { outcome: 'skip' }
  | { outcome: 'replay'; status: CachedSendStatus; body: Record<string, unknown> }
  | { outcome: 'reused' }
  | { outcome: 'in_flight' }
  | { outcome: 'table_full' }
  | { outcome: 'reserved'; reservation: SendIdempotencyReservation };

type InFlightSlot = {
  state: 'in_flight';
  requestHash: string;
  reservationId: number;
  reservedAt: number;
};

type CompletedSlot = {
  state: 'completed';
  requestHash: string;
  status: CachedSendStatus;
  body: Record<string, unknown>;
  completedAt: number;
  seq: number;
};

type Slot = InFlightSlot | CompletedSlot;

const table = new Map<string, Slot>();
let nowFn: () => number = () => Date.now();
let maxEntries = SEND_IDEMPOTENCY_MAX_ENTRIES;
let nextReservationId = 1;
let nextSeq = 1;

/** 与每小时额度、身份查找相同：整段小写。不 trim，校验后的邮箱没有首尾空白。 */
export function normalizeSendIdentity(from: string): string {
  return from.toLowerCase();
}

/** 原始键的 sha256。调用方传入的必须已经是 trim 之后的键。 */
export function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function isIdempotencySha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * 规范 JSON：对象键排序，数组保持原顺序。
 * to 收成数组。send.ts 的 recipientsOf 不排序，也不改地址大小写，这里同样不改。
 * 未知的未来字段只要出现在校验结果里就会算进去。
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = sortKeysDeep(src[key]);
    }
    return out;
  }
  return value;
}

/** 校验后整个 body 的 sha256。没有幂等键时不要调用，避免白哈希大正文。 */
export function fingerprintSendBody(parsed: object): string {
  const src = parsed as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    if (value === undefined) continue;
    if (key === 'to') {
      const list = Array.isArray(value) ? value : [value];
      normalized.to = list.slice();
      continue;
    }
    normalized[key] = value;
  }
  const canonical = JSON.stringify(sortKeysDeep(normalized));
  return createHash('sha256').update(canonical).digest('hex');
}

function ttlMs(): number {
  return SEND_IDEMPOTENCY_TTL_SEC * 1000;
}

function scopeIdFor(from: string, keyHash: string): string {
  return `${normalizeSendIdentity(from)}\n${keyHash}`;
}

function cloneBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

/** 200 回放体。有审计 id 才带 id，与路由当时返回的形状一致。 */
export function queuedSendResponse(messageId: string, id?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { queued: true, messageId };
  if (id) body.id = id;
  return body;
}

/** 对端已应答的 502 回放体。错误码固定为 smtp_error。 */
export function smtpErrorSendResponse(id?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { error: 'smtp_error' };
  if (id) body.id = id;
  return body;
}

/**
 * 与 routes/webhooks.ts parseIdempotencyKey 相同：缺省、trim 后为空都当没有键。
 * 超过 128 个字符，或含 ASCII 控制字符（含 DEL）以及 C1 控制字符，拒绝。
 */
export function parseSendIdempotencyKey(
  raw: string | undefined,
): { ok: true; key?: string } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const key = raw.trim();
  if (!key) return { ok: true };
  if (key.length > IDEMPOTENCY_KEY_MAX) return { ok: false };
  if (hasDisallowedKeyChar(key)) return { ok: false };
  return { ok: true, key };
}

function hasDisallowedKeyChar(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    // C0、DEL，以及 C1。可打印 ASCII 和其它非控制字符放行。
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

function dropExpired(now: number): void {
  const limit = ttlMs();
  for (const [key, entry] of table) {
    if (entry.state !== 'completed') continue;
    if (entry.completedAt + limit <= now) table.delete(key);
  }
}

/** 只逐出已完成项。没有可逐出的项时返回 false（全是占位，或表是空的）。 */
function evictOldestCompleted(): boolean {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  let oldestSeq = Number.POSITIVE_INFINITY;
  for (const [key, entry] of table) {
    if (entry.state !== 'completed') continue;
    if (entry.completedAt < oldestAt || (entry.completedAt === oldestAt && entry.seq < oldestSeq)) {
      oldestKey = key;
      oldestAt = entry.completedAt;
      oldestSeq = entry.seq;
    }
  }
  if (oldestKey === undefined) return false;
  table.delete(oldestKey);
  return true;
}

/**
 * 同步检查并占位。没有键时什么都不做。
 * 调用方必须在身份校验之后、冷却和额度之前调用，且在此之前不能再 await。
 */
export function beginSendIdempotency(
  from: string,
  key: string | undefined,
  parsedBody: object,
): SendIdempotencyBegin {
  if (!key) return { outcome: 'skip' };
  const now = nowFn();
  const keyHash = hashIdempotencyKey(key);
  const requestHash = fingerprintSendBody(parsedBody);
  const scopeId = scopeIdFor(from, keyHash);
  let entry = table.get(scopeId);
  if (entry?.state === 'completed' && entry.completedAt + ttlMs() <= now) {
    table.delete(scopeId);
    entry = undefined;
  }
  if (entry) {
    if (entry.requestHash !== requestHash) return { outcome: 'reused' };
    if (entry.state === 'in_flight') return { outcome: 'in_flight' };
    return { outcome: 'replay', status: entry.status, body: entry.body };
  }
  if (table.size >= maxEntries) {
    dropExpired(now);
    if (table.size >= maxEntries && !evictOldestCompleted()) {
      return { outcome: 'table_full' };
    }
  }
  if (table.size >= maxEntries) return { outcome: 'table_full' };
  const reservationId = nextReservationId;
  nextReservationId += 1;
  table.set(scopeId, {
    state: 'in_flight',
    requestHash,
    reservationId,
    reservedAt: now,
  });
  return {
    outcome: 'reserved',
    reservation: { id: reservationId, scopeId, keyHash, requestHash },
  };
}

/** 200 或对端已应答的 502。只改这张票仍持有的占位。 */
export function completeSendIdempotency(
  reservation: SendIdempotencyReservation | undefined,
  status: CachedSendStatus,
  body: Record<string, unknown>,
): boolean {
  if (!reservation) return false;
  const entry = table.get(reservation.scopeId);
  if (!entry || entry.state !== 'in_flight' || entry.reservationId !== reservation.id) return false;
  const seq = nextSeq;
  nextSeq += 1;
  table.set(reservation.scopeId, {
    state: 'completed',
    requestHash: entry.requestHash,
    status,
    body: cloneBody(body),
    completedAt: nowFn(),
    seq,
  });
  return true;
}

/** 4xx/429 和连接类失败：删掉这张票，让下一次相同请求重新发送。 */
export function releaseSendIdempotency(reservation: SendIdempotencyReservation | undefined): void {
  if (!reservation) return;
  const entry = table.get(reservation.scopeId);
  if (!entry || entry.state !== 'in_flight' || entry.reservationId !== reservation.id) return;
  table.delete(reservation.scopeId);
}

export type SendIdempotencyReplayRow = {
  id: string;
  from: string;
  sentAt: string;
  result: string;
  messageId: string | null;
  failureKind?: string;
  idempotencyKeyHash?: string;
  requestHash?: string;
};

/**
 * 用发送日志重建已完成项。只认窗口内的 queued，以及 smtp_response 失败。
 * sentAt 在未来，或恰好到期（sentAt + 24h <= now）的行不留。
 * 同一身份同一键留 sentAt 更晚的那条。超过上限时留最晚完成的那些，不留占位。
 */
export function rebuildSendIdempotencyFromRecords(
  records: readonly SendIdempotencyReplayRow[],
  now = nowFn(),
): void {
  table.clear();
  const limit = ttlMs();
  const fresh = new Map<string, CompletedSlot>();
  for (const row of records) {
    if (!isIdempotencySha256Hex(row.idempotencyKeyHash) || !isIdempotencySha256Hex(row.requestHash)) {
      continue;
    }
    const answered =
      row.result === 'queued' ||
      (row.result === 'failed' && row.failureKind === 'smtp_response');
    if (!answered) continue;
    const sentAt = Date.parse(row.sentAt);
    if (!Number.isFinite(sentAt) || sentAt > now || sentAt + limit <= now) continue;
    const cached = cachedFromRow(row);
    if (!cached) continue;
    const scopeId = scopeIdFor(row.from, row.idempotencyKeyHash);
    const prev = fresh.get(scopeId);
    if (prev && prev.completedAt > sentAt) continue;
    const seq = nextSeq;
    nextSeq += 1;
    fresh.set(scopeId, {
      state: 'completed',
      requestHash: row.requestHash,
      status: cached.status,
      body: cached.body,
      completedAt: sentAt,
      seq,
    });
  }
  const ranked = [...fresh.entries()].sort((a, b) => b[1].completedAt - a[1].completedAt || b[1].seq - a[1].seq);
  const kept = ranked.length > maxEntries ? ranked.slice(0, maxEntries) : ranked;
  for (const [scopeId, entry] of kept) table.set(scopeId, entry);
}

function cachedFromRow(
  row: SendIdempotencyReplayRow,
): { status: CachedSendStatus; body: Record<string, unknown> } | undefined {
  if (row.result === 'queued') {
    // messageId 缺失时还原不出当时的 200 体。
    if (typeof row.messageId !== 'string') return undefined;
    return { status: 200, body: queuedSendResponse(row.messageId, row.id) };
  }
  if (row.result === 'failed' && row.failureKind === 'smtp_response' && row.id) {
    return { status: 502, body: smtpErrorSendResponse(row.id) };
  }
  return undefined;
}

/** 测试辅助：当前表大小（含未过期的已完成项和占位）。 */
export function sendIdempotencySizeForTests(): number {
  return table.size;
}

/** 测试注入幂等时钟。null 恢复 Date.now。不影响额度桶。 */
export function setSendIdempotencyNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** 测试辅助：收紧或恢复表上限。 */
export function setSendIdempotencyCapForTests(cap: number | null): void {
  maxEntries = cap ?? SEND_IDEMPOTENCY_MAX_ENTRIES;
}

/** 测试辅助：清空表、时钟和上限。占位号不回绕，避免旧票碰上新占位。 */
export function resetSendIdempotencyForTests(): void {
  table.clear();
  nowFn = () => Date.now();
  maxEntries = SEND_IDEMPOTENCY_MAX_ENTRIES;
}
