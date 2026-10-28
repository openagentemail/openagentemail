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
 * 记成已完成的有三类：200，SMTP 对端已经应答的 502，以及进入 DATA（或更晚）
 * 之后才断线的 502。后一类日志仍标 failureKind local，额度与冷却照旧退还。
 * 冷却、额度和其他 4xx/429，以及还没进入 DATA 的连接类失败，都放开这把键。
 *
 * 保留 24 小时。表满 10000 时先丢掉过期的已完成项，再暂时逐出最老的已完成项。
 * 这次请求若后来放开键，被逐出的项放回；只有记成已完成，逐出才留下。
 * 进行中的占位不逐出。全是占位时拒绝新键。
 * 重启只从发送日志重建已完成项：窗口内的 queued、failureKind 为 smtp_response，
 * 以及同样带两个哈希的 local 行（DATA 阶段不确定失败）。
 * sentAt 在未来的行忽略。早于该地址当前身份 createdAt 的行忽略。
 * 没有哈希字段的旧行忽略。删除身份会清掉该地址的内存项。
 * 占位时记下这一任身份的 createdAt。完成时身份没了或已换成另一任，
 * 调用方不把结果放进内存，也不把两个哈希写进发送日志。
 */

import { createHash } from 'node:crypto';

/** 已完成项保留多久。重启回放用同一个窗口。 */
export const SEND_IDEMPOTENCY_TTL_SEC = 86_400;
/** 内存表上限。进行中的占位也算。 */
export const SEND_IDEMPOTENCY_MAX_ENTRIES = 10_000;
/** 与 webhooks 的 Idempotency-Key 上限相同。trim 之后按字符计。 */
export const SEND_IDEMPOTENCY_KEY_MAX_LEN = 128;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SendIdempotencyReservation = {
  id: number;
  scopeId: string;
  /** 原始键的 sha256，十六进制。给发送日志用，不是原始键。 */
  keyHash: string;
  /** 校验后 body 的指纹。 */
  requestHash: string;
  /**
   * 占位当时这一任身份的 createdAt。
   * 完成时对不上（身份已删，或同址新建）就不能记成已完成。
   */
  identityCreatedAt?: string;
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
/** 为这次占位暂时让出的已完成项。放开键时放回；记成已完成则丢掉。 */
const parkedEvictions = new Map<number, { scopeId: string; slot: CompletedSlot }>();
let nowFn: () => number = () => Date.now();
let maxEntries = SEND_IDEMPOTENCY_MAX_ENTRIES;
let nextReservationId = 1;
let nextSeq = 1;
/**
 * 启动时发送日志没能把幂等表重建出来。
 * 带键请求在下一次回放成功之前必须失败关闭，不能拿空表再发一封。
 */
let replayUnavailable = false;

/** 发送日志回放失败，带 Idempotency-Key 的请求应返回 503。 */
export function isSendIdempotencyReplayUnavailable(): boolean {
  return replayUnavailable;
}

/** 这次启动回放没有装上幂等表。 */
export function markSendIdempotencyReplayFailed(): void {
  replayUnavailable = true;
}

/** 幂等表已按当前身份重建。带键请求可以恢复。 */
export function markSendIdempotencyReplaySucceeded(): void {
  replayUnavailable = false;
}

/** 测试和发送日志修剪用的当前表上限。 */
export function sendIdempotencyMaxEntries(): number {
  return maxEntries;
}

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
 * trim 之后的合法键：1–128 个可打印 ASCII（0x20–0x7E）。
 * 控制字符、DEL、非 ASCII（含 emoji）都不行。空串不是合法键。
 * REST 解析和 MCP schema 都用这一条，避免两处各写一套。
 */
export function isSendIdempotencyKey(key: string): boolean {
  if (key.length < 1 || key.length > SEND_IDEMPOTENCY_KEY_MAX_LEN) return false;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * 缺省、trim 后为空都当没有键（REST 空白头保持旧行为）。
 * trim 之后不是合法键则拒绝。MCP 不走这里：空白键由 schema 直接校验失败。
 */
export function parseSendIdempotencyKey(
  raw: string | undefined,
): { ok: true; key?: string } | { ok: false } {
  if (raw === undefined) return { ok: true };
  const key = raw.trim();
  if (!key) return { ok: true };
  if (!isSendIdempotencyKey(key)) return { ok: false };
  return { ok: true, key };
}

function dropExpired(now: number): void {
  const limit = ttlMs();
  for (const [key, entry] of table) {
    if (entry.state !== 'completed') continue;
    if (entry.completedAt + limit <= now) table.delete(key);
  }
}

/** 只取走最老的已完成项。没有可取走的项时返回 undefined（全是占位，或表是空的）。 */
function takeOldestCompleted(): { scopeId: string; slot: CompletedSlot } | undefined {
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
  if (oldestKey === undefined) return undefined;
  const slot = table.get(oldestKey);
  if (!slot || slot.state !== 'completed') return undefined;
  table.delete(oldestKey);
  return { scopeId: oldestKey, slot };
}

/** 格子还空着才放回。别人已经写上的新结果不覆盖。 */
function restoreParked(reservationId: number): void {
  const parked = parkedEvictions.get(reservationId);
  if (!parked) return;
  parkedEvictions.delete(reservationId);
  if (!table.has(parked.scopeId)) table.set(parked.scopeId, parked.slot);
}

function discardParked(reservationId: number): void {
  parkedEvictions.delete(reservationId);
}

/**
 * 同步检查并占位。没有键时什么都不做。
 * 调用方必须在身份校验之后、冷却和额度之前调用，且在此之前不能再 await。
 */
export function beginSendIdempotency(
  from: string,
  key: string | undefined,
  parsedBody: object,
  identityCreatedAt?: string,
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
  // 逐出先记在这张票上。冷却/额度拒绝或连接类失败放开时放回，避免拒绝请求擦掉别人的回放。
  let parked: { scopeId: string; slot: CompletedSlot } | undefined;
  if (table.size >= maxEntries) {
    dropExpired(now);
    if (table.size >= maxEntries) {
      parked = takeOldestCompleted();
      if (!parked) return { outcome: 'table_full' };
    }
  }
  if (table.size >= maxEntries) {
    if (parked && !table.has(parked.scopeId)) table.set(parked.scopeId, parked.slot);
    return { outcome: 'table_full' };
  }
  const reservationId = nextReservationId;
  nextReservationId += 1;
  table.set(scopeId, {
    state: 'in_flight',
    requestHash,
    reservationId,
    reservedAt: now,
  });
  if (parked) parkedEvictions.set(reservationId, parked);
  return {
    outcome: 'reserved',
    reservation: {
      id: reservationId,
      scopeId,
      keyHash,
      requestHash,
      // 只在调用方交出创建时间时带上。完成时用它认出是不是同一任身份。
      ...(identityCreatedAt ? { identityCreatedAt } : {}),
    },
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
  // 这次已经记成已完成，被让出的旧回放不再放回。
  discardParked(reservation.id);
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

/** 4xx/429 和还没进入 DATA 的连接类失败：删掉这张票，并放回它暂时逐出的已完成项。 */
export function releaseSendIdempotency(reservation: SendIdempotencyReservation | undefined): void {
  if (!reservation) return;
  const entry = table.get(reservation.scopeId);
  if (!entry || entry.state !== 'in_flight' || entry.reservationId !== reservation.id) return;
  table.delete(reservation.scopeId);
  restoreParked(reservation.id);
}

/**
 * 身份删除后清掉该地址的内存项，避免同址新建在 24 小时内拿到上一任的回放。
 * 先丢掉属于这个地址的暂存，再把这张票让出来的其它地址放回。
 */
export function purgeSendIdempotencyForAddress(address: string): void {
  const prefix = `${normalizeSendIdentity(address)}\n`;
  const restoreIds: number[] = [];
  for (const [key, entry] of table) {
    if (!key.startsWith(prefix)) continue;
    if (entry.state === 'in_flight') restoreIds.push(entry.reservationId);
    table.delete(key);
  }
  for (const [id, parked] of parkedEvictions) {
    if (parked.scopeId.startsWith(prefix)) parkedEvictions.delete(id);
  }
  for (const id of restoreIds) restoreParked(id);
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
 * 用发送日志重建已完成项。只认窗口内的 queued、smtp_response 失败，
 * 以及带两个哈希的 local 行（DATA 阶段不确定失败，额度回放仍不认 local）。
 * sentAt 在未来，或恰好到期（sentAt + 24h <= now）的行不留。
 * identityCreatedAtMs 给出时：地址不在表里，或 sentAt 早于该身份的创建时间，都不留。
 * 生产路径在身份库读失败时不调用本函数。省略这张表表示不做 createdAt 过滤。
 * 同一身份同一键留 sentAt 更晚的那条。超过上限时留最晚完成的那些，不留占位。
 */
export function rebuildSendIdempotencyFromRecords(
  records: readonly SendIdempotencyReplayRow[],
  now = nowFn(),
  identityCreatedAtMs?: ReadonlyMap<string, number>,
): void {
  table.clear();
  parkedEvictions.clear();
  const limit = ttlMs();
  const fresh = new Map<string, CompletedSlot>();
  for (const row of records) {
    if (!isIdempotencySha256Hex(row.idempotencyKeyHash) || !isIdempotencySha256Hex(row.requestHash)) {
      continue;
    }
    const answered =
      row.result === 'queued' ||
      (row.result === 'failed' &&
        (row.failureKind === 'smtp_response' || row.failureKind === 'local'));
    if (!answered) continue;
    const sentAt = Date.parse(row.sentAt);
    if (!Number.isFinite(sentAt) || sentAt > now || sentAt + limit <= now) continue;
    if (identityCreatedAtMs) {
      const created = identityCreatedAtMs.get(normalizeSendIdentity(row.from));
      if (created === undefined || sentAt < created) continue;
    }
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
  // local 且带两个哈希：DATA 阶段不确定失败。调用方已经先核对过哈希。
  if (
    row.result === 'failed' &&
    row.id &&
    (row.failureKind === 'smtp_response' || row.failureKind === 'local')
  ) {
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
  parkedEvictions.clear();
  nowFn = () => Date.now();
  maxEntries = SEND_IDEMPOTENCY_MAX_ENTRIES;
  replayUnavailable = false;
}
