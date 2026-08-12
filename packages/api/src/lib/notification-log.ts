/**
 * 30 天通知送达日志（ADR #26 PR 3）。
 *
 * 权威存储：DATA_DIR/notification-log.jsonl。只在 ntfy publish **成功之后**
 * 追加一行；失败/取消不写。append 失败不得把已成功的投递改成失败（送达优先），
 * 但必须打高优先级本地健康告警。
 *
 * 纪律：单写者 promise 队列、目录 0700、文件/临时文件 0600、同目录 .tmp + fsync
 * + atomic rename。不写物理 ntfy topic / reader secret。查询硬加 30 天下界。
 *
 * 损坏：末尾半行隔离并报警；中间损坏 fail-closed（查询/摘要不得装残缺审计当成功）。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.ts';

/** 保留窗口：30 天。查询与清理共用，避免定时任务延迟泄漏过期行。 */
export const NOTIFICATION_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const NOTIFICATION_LOG_SCHEMA_VERSION = 1;

export const NOTIFICATION_LOG_LIMITS = [20, 50, 100] as const;
export type NotificationLogLimit = (typeof NOTIFICATION_LOG_LIMITS)[number];

export type NotificationSource = 'watcher' | 'manual' | 'task' | 'verify';
export type NotificationLevel = 'urgent' | 'normal' | 'low';
export type NotificationLogicalTarget = 'user' | `agent:${string}`;
export type NotificationLogicalChannel = 'user-alerts' | 'user-low' | `agent:${string}`;

/** 落盘行。delivery 恒为 sent：未成功的 publish 根本不会出现在这里。 */
export type NotificationLogRecord = {
  schemaVersion: typeof NOTIFICATION_LOG_SCHEMA_VERSION;
  id: string;
  publishedAt: string;
  source: NotificationSource;
  logicalTarget: NotificationLogicalTarget;
  logicalChannel: NotificationLogicalChannel;
  level: NotificationLevel;
  title: string;
  message: string;
  tags: string[];
  sensitive: boolean;
  identityAddress?: string;
  delivery: 'sent';
};

export type NotificationLogQuery = {
  channel?: NotificationLogicalChannel;
  level?: NotificationLevel;
  from?: string;
  to?: string;
  cursor?: string;
  limit: NotificationLogLimit;
};

export type NotificationLogPage = {
  items: NotificationLogRecord[];
  nextCursor: string | null;
  queryNow: string;
  window: { from: string; to: string };
};

export type NotificationSummary = {
  date: string;
  tz: string;
  from: string;
  to: string;
  total: number;
  ringCount: number;
  byLevel: { urgent: number; normal: number; low: number };
  byChannel: Record<string, number>;
  lastSuccessfulAt: string | null;
};

/** 中间损坏：不得把残缺日志当完整审计返回。 */
export class NotificationLogCorruptError extends Error {
  readonly code = 'notification_log_corrupt';
  constructor() {
    super('notification_log_corrupt');
    this.name = 'NotificationLogCorruptError';
  }
}

/** 游标篡改 / 跨筛选复用。 */
export class InvalidNotifyCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor() {
    super('invalid_cursor');
    this.name = 'InvalidNotifyCursorError';
  }
}

const LOG_NAME = 'notification-log.jsonl';
const CURSOR_PREFIX = 'notify-cursor-v1';
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SOURCES = new Set<NotificationSource>(['watcher', 'manual', 'task', 'verify']);
const LEVELS = new Set<NotificationLevel>(['urgent', 'normal', 'low']);

type CursorPayload = {
  ch: string;
  lv: string;
  from: string;
  to: string;
  t: number;
  id: string;
};

let writeChain: Promise<void> = Promise.resolve();
let failClosed = false;
let nowFn: () => number = () => Date.now();
/** 测试可注入：真正写盘前抛错，模拟盘满。 */
let persistHookForTests: (() => void) | null = null;

function logPath(): string {
  return join(config.dataDir, LOG_NAME);
}

function tmpPath(): string {
  return join(config.dataDir, `${LOG_NAME}.tmp`);
}

function partialPath(): string {
  return join(config.dataDir, `${LOG_NAME}.partial`);
}

function nowMs(): number {
  return nowFn();
}

function retentionCutoffMs(now = nowMs()): number {
  return now - NOTIFICATION_LOG_RETENTION_MS;
}

/** 确保 DATA_DIR 0700；单写者约定与 identities/audit 相同。 */
function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 属主可能不同；文件 mode 仍会设置
  }
}

/** 高优先级本地健康告警：不含 title/message/OTP。 */
export function notificationLogHealthAlert(kind: string, detail: Record<string, unknown> = {}): void {
  console.error(`[notification-log] HIGH: ${kind}`, detail);
}

function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isNotificationLogLimit(value: number): value is NotificationLogLimit {
  return (NOTIFICATION_LOG_LIMITS as readonly number[]).includes(value);
}

export function isLogicalChannel(value: string): value is NotificationLogicalChannel {
  if (value === 'user-alerts' || value === 'user-low') return true;
  if (!value.startsWith('agent:')) return false;
  return AGENT_NAME_RE.test(value.slice('agent:'.length));
}

export function logicalChannelFor(
  target: NotificationLogicalTarget,
  level: NotificationLevel,
): NotificationLogicalChannel {
  if (target === 'user') return level === 'low' ? 'user-low' : 'user-alerts';
  return target;
}

function isLogicalTarget(value: unknown): value is NotificationLogicalTarget {
  if (value === 'user') return true;
  if (typeof value !== 'string' || !value.startsWith('agent:')) return false;
  return AGENT_NAME_RE.test(value.slice('agent:'.length));
}

function parseRecord(raw: unknown): NotificationLogRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.schemaVersion !== NOTIFICATION_LOG_SCHEMA_VERSION) return null;
  if (typeof row.id !== 'string' || row.id.length < 8 || row.id.length > 128) return null;
  if (typeof row.publishedAt !== 'string' || !Number.isFinite(Date.parse(row.publishedAt))) return null;
  if (typeof row.source !== 'string' || !SOURCES.has(row.source as NotificationSource)) return null;
  if (!isLogicalTarget(row.logicalTarget)) return null;
  if (typeof row.logicalChannel !== 'string' || !isLogicalChannel(row.logicalChannel)) return null;
  if (typeof row.level !== 'string' || !LEVELS.has(row.level as NotificationLevel)) return null;
  if (typeof row.title !== 'string' || typeof row.message !== 'string') return null;
  if (!Array.isArray(row.tags) || row.tags.some((tag) => typeof tag !== 'string')) return null;
  if (typeof row.sensitive !== 'boolean') return null;
  if (row.delivery !== 'sent') return null;
  if (row.identityAddress !== undefined && typeof row.identityAddress !== 'string') return null;
  const record: NotificationLogRecord = {
    schemaVersion: NOTIFICATION_LOG_SCHEMA_VERSION,
    id: row.id,
    publishedAt: row.publishedAt,
    source: row.source as NotificationSource,
    logicalTarget: row.logicalTarget,
    logicalChannel: row.logicalChannel,
    level: row.level as NotificationLevel,
    title: row.title,
    message: row.message,
    tags: row.tags as string[],
    sensitive: row.sensitive,
    delivery: 'sent',
  };
  if (typeof row.identityAddress === 'string' && row.identityAddress.includes('@')) {
    record.identityAddress = row.identityAddress.toLowerCase();
  }
  return record;
}

type ParsedFile = {
  records: NotificationLogRecord[];
  trailingPartial: string | null;
  middleCorrupt: boolean;
};

function parseFileText(raw: string): ParsedFile {
  if (raw.length === 0) {
    return { records: [], trailingPartial: null, middleCorrupt: false };
  }
  const endsWithNl = raw.endsWith('\n');
  const parts = raw.split('\n');
  if (endsWithNl && parts[parts.length - 1] === '') parts.pop();

  let trailingPartial: string | null = null;
  let complete = parts;
  if (!endsWithNl) {
    const last = parts[parts.length - 1] ?? '';
    complete = parts.slice(0, -1);
    const parsedLast = last.trim() ? parseRecord(safeJson(last)) : null;
    if (parsedLast) {
      // 写完 JSON 但没写上换行：仍算完整行。
      complete = [...complete, last];
    } else {
      trailingPartial = last;
    }
  }

  const records: NotificationLogRecord[] = [];
  for (const line of complete) {
    if (!line.trim()) {
      return { records, trailingPartial, middleCorrupt: true };
    }
    const parsed = parseRecord(safeJson(line));
    if (!parsed) {
      return { records, trailingPartial, middleCorrupt: true };
    }
    records.push(parsed);
  }
  return { records, trailingPartial, middleCorrupt: false };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readRawSync(): string {
  const path = logPath();
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function writeAtomicSync(text: string): void {
  ensureDataDir();
  persistHookForTests?.();
  const tmp = tmpPath();
  const fd = openSync(tmp, 'w', 0o600);
  try {
    if (text.length > 0) writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  renameSync(tmp, logPath());
  try {
    chmodSync(logPath(), 0o600);
  } catch {
    // best effort
  }
}

function appendLineSync(line: string): void {
  ensureDataDir();
  persistHookForTests?.();
  const path = logPath();
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/**
 * 非空且不以换行结尾时，只补一个 \\n（不走 persistHook，避免把「记录写盘失败」测成修复失败）。
 * 完整末行缺换行若不先补上，下一次 append 会把新 JSON 粘在同一行，变成中间损坏。
 */
function appendMissingFinalNewlineSync(): void {
  const path = logPath();
  if (!existsSync(path)) return;
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
}

/**
 * 启动/查询/append 前：末尾半行隔离（sidecar 失败则中止、原文件不动）；完整末行缺换行则先补换行；中间损坏 fail-closed。
 * 不在 fail-closed 时重写文件（避免把中间坏行「跳过」装成完整审计）。
 */
function inspectAndRepairSync(): NotificationLogRecord[] {
  const raw = readRawSync();
  const parsed = parseFileText(raw);
  if (parsed.middleCorrupt) {
    failClosed = true;
    notificationLogHealthAlert('middle_corrupt', { path: LOG_NAME });
    throw new NotificationLogCorruptError();
  }
  failClosed = false;
  if (parsed.trailingPartial !== null) {
    try {
      ensureDataDir();
      const fragment = parsed.trailingPartial.endsWith('\n')
        ? parsed.trailingPartial
        : `${parsed.trailingPartial}\n`;
      const pfd = openSync(partialPath(), 'a', 0o600);
      try {
        writeSync(pfd, fragment);
        fsyncSync(pfd);
      } finally {
        closeSync(pfd);
      }
      try {
        chmodSync(partialPath(), 0o600);
      } catch {
        // best effort：权限失败不否决已 fsync 的隔离
      }
    } catch (err) {
      notificationLogHealthAlert('partial_isolate_failed', {
        error: (err as Error).message,
      });
      // sidecar 未持久成功：中止 repair，原文件一字不动，绝不丢掉尾行。
      throw err;
    }
    notificationLogHealthAlert('trailing_partial_isolated', {
      path: LOG_NAME,
      bytes: parsed.trailingPartial.length,
    });
    const kept = parsed.records.map((row) => `${JSON.stringify(row)}\n`).join('');
    writeAtomicSync(kept);
  } else if (raw.length > 0 && !raw.endsWith('\n')) {
    // 末尾是完整合法行但缺换行：先补换行，再让后续 append 写新行。
    appendMissingFinalNewlineSync();
  }
  return parsed.records;
}

function loadRecordsOrThrow(): NotificationLogRecord[] {
  if (failClosed) throw new NotificationLogCorruptError();
  return inspectAndRepairSync();
}

function cursorMac(payload: CursorPayload, key: string | Buffer): string {
  return createHmac('sha256', key)
    .update(
      `${CURSOR_PREFIX}\n${payload.ch}\n${payload.lv}\n${payload.from}\n${payload.to}\n${payload.t}\n${payload.id}`,
    )
    .digest('base64url');
}

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(
    JSON.stringify({
      ch: payload.ch,
      lv: payload.lv,
      from: payload.from,
      to: payload.to,
      t: payload.t,
      id: payload.id,
    }),
  ).toString('base64url');
  return `${CURSOR_PREFIX}.${body}.${cursorMac(payload, config.notifyCursorSecret)}`;
}

function decodeCursor(token: string): CursorPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX || !parts[1] || !parts[2]) {
    throw new InvalidNotifyCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new InvalidNotifyCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidNotifyCursorError();
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.ch !== 'string' || typeof raw.lv !== 'string') throw new InvalidNotifyCursorError();
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string') throw new InvalidNotifyCursorError();
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) throw new InvalidNotifyCursorError();
  if (typeof raw.id !== 'string' || !raw.id) throw new InvalidNotifyCursorError();
  const payload: CursorPayload = {
    ch: raw.ch,
    lv: raw.lv,
    from: raw.from,
    to: raw.to,
    t: raw.t,
    id: raw.id,
  };
  const expected = cursorMac(payload, config.notifyCursorSecret);
  try {
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidNotifyCursorError();
  } catch (err) {
    if (err instanceof InvalidNotifyCursorError) throw err;
    throw new InvalidNotifyCursorError();
  }
  return payload;
}

function filterFingerprint(query: NotificationLogQuery): Omit<CursorPayload, 't' | 'id'> {
  return {
    ch: query.channel ?? '',
    lv: query.level ?? '',
    from: query.from ?? '',
    to: query.to ?? '',
  };
}

/** newest-first 下，游标之后（更旧）的行才进下一页。 */
function olderThanCursor(row: NotificationLogRecord, cursor: CursorPayload): boolean {
  const t = Date.parse(row.publishedAt);
  if (t < cursor.t) return true;
  if (t > cursor.t) return false;
  return row.id < cursor.id;
}

function applyWindow(
  records: NotificationLogRecord[],
  query: NotificationLogQuery,
  now: number,
): { rows: NotificationLogRecord[]; window: { from: string; to: string } } {
  const lower = retentionCutoffMs(now);
  const fromMs = query.from ? Date.parse(query.from) : Number.NaN;
  const toMs = query.to ? Date.parse(query.to) : Number.NaN;
  const windowFrom = Number.isFinite(fromMs) ? Math.max(fromMs, lower) : lower;
  // to 为开区间右端；未传则用 now，避免把「此刻之后」的行算进来。
  const windowTo = Number.isFinite(toMs) ? Math.min(toMs, now + 1) : now + 1;
  const rows = records.filter((row) => {
    const t = Date.parse(row.publishedAt);
    if (!Number.isFinite(t) || t < windowFrom || t >= windowTo) return false;
    if (query.channel && row.logicalChannel !== query.channel) return false;
    if (query.level && row.level !== query.level) return false;
    return true;
  });
  rows.sort((a, b) => {
    const dt = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    if (dt !== 0) return dt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return {
    rows,
    window: { from: new Date(windowFrom).toISOString(), to: new Date(windowTo).toISOString() },
  };
}

export type AppendNotificationInput = {
  source: NotificationSource;
  logicalTarget: NotificationLogicalTarget;
  logicalChannel: NotificationLogicalChannel;
  level: NotificationLevel;
  title: string;
  message: string;
  tags?: string[];
  sensitive?: boolean;
  identityAddress?: string;
};

/**
 * 在 ntfy 成功响应后调用。串行入队；写盘失败抛给调用方，由 publish 改成告警而非失败。
 */
export function appendNotificationLog(input: AppendNotificationInput): Promise<NotificationLogRecord> {
  return enqueue(() => {
    // 先规范化：半行隔离，或给缺末尾换行的完整行补换行，避免粘成中间损坏。
    inspectAndRepairSync();
    const record: NotificationLogRecord = {
      schemaVersion: NOTIFICATION_LOG_SCHEMA_VERSION,
      id: randomBytes(12).toString('hex'),
      publishedAt: new Date(nowMs()).toISOString(),
      source: input.source,
      logicalTarget: input.logicalTarget,
      logicalChannel: input.logicalChannel,
      level: input.level,
      title: input.title,
      message: input.message,
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 16) : [],
      sensitive: Boolean(input.sensitive),
      delivery: 'sent',
    };
    if (input.identityAddress && input.identityAddress.includes('@')) {
      record.identityAddress = input.identityAddress.toLowerCase();
    }
    appendLineSync(`${JSON.stringify(record)}\n`);
    return record;
  });
}

/** 查询：硬加 30 天下界；中间损坏 fail-closed。 */
export function queryNotificationLog(query: NotificationLogQuery): Promise<NotificationLogPage> {
  return enqueue(() => {
    const now = nowMs();
    const records = loadRecordsOrThrow();
    const { rows, window } = applyWindow(records, query, now);
    const fp = filterFingerprint(query);
    let start = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.ch !== fp.ch || cursor.lv !== fp.lv || cursor.from !== fp.from || cursor.to !== fp.to) {
        throw new InvalidNotifyCursorError();
      }
      start = rows.findIndex((row) => olderThanCursor(row, cursor));
      if (start < 0) start = rows.length;
    }
    const slice = rows.slice(start, start + query.limit);
    const last = slice[slice.length - 1];
    const hasMore = start + slice.length < rows.length;
    return {
      items: slice,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              ...fp,
              t: Date.parse(last.publishedAt),
              id: last.id,
            })
          : null,
      queryNow: new Date(now).toISOString(),
      window,
    };
  });
}

/**
 * 把 IANA 时区的某个本地日历日换成 UTC 闭开区间 [from, to)。
 * date=today 取该时区「此刻」的年月日。
 */
export function zonedDayBounds(
  date: string,
  tz: string,
  now = nowMs(),
): { date: string; from: string; to: string } {
  let timeZone: string;
  try {
    timeZone = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError('invalid_time_zone');
  }
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const day = date === 'today' ? dayFmt.format(new Date(now)) : date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError('invalid_date');

  /** 把 utc 瞬间读成该时区墙钟。hour=24 视为次日 00:00。 */
  const localWallAt = (utcMs: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    let year = get('year');
    let month = get('month');
    let dayNum = get('day');
    let hour = get('hour');
    if (hour === 24) {
      hour = 0;
      const rolled = new Date(Date.UTC(year, month - 1, dayNum + 1));
      year = rolled.getUTCFullYear();
      month = rolled.getUTCMonth() + 1;
      dayNum = rolled.getUTCDate();
    }
    return { year, month, day: dayNum, hour, minute: get('minute'), second: get('second') };
  };

  const offsetAt = (utcMs: number): number => {
    const wall = localWallAt(utcMs);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    return asUtc - utcMs;
  };

  /**
   * 目标日历日当地 00:00 对应的 UTC。
   * 一次性 guess-offset 会在午夜两侧 DST 切换时用错偏移（Lord_Howe 半小时、Santiago 整小时）。
   * 迭代收敛后必须验证墙钟；00:00 被跳过则取该日第一个可表示瞬间。
   */
  const zonedLocalMidnightUtc = (year: number, month: number, dayNum: number): number => {
    const asUtc = Date.UTC(year, month - 1, dayNum, 0, 0, 0);
    let utc = asUtc;
    for (let i = 0; i < 8; i++) {
      const next = asUtc - offsetAt(utc);
      if (next === utc) break;
      utc = next;
    }

    const onDate = (ms: number) => {
      const wall = localWallAt(ms);
      return wall.year === year && wall.month === month && wall.day === dayNum;
    };
    const atMidnight = (ms: number) => {
      const wall = localWallAt(ms);
      return onDate(ms) && wall.hour === 0 && wall.minute === 0 && wall.second === 0;
    };

    if (atMidnight(utc)) return utc;

    // 偏移在 guess 与目标午夜之间切过：按墙钟差重算。
    for (let i = 0; i < 4; i++) {
      const wall = localWallAt(utc);
      const gotAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
      const adjusted = utc + (asUtc - gotAsUtc);
      if (adjusted === utc) break;
      utc = adjusted;
      if (atMidnight(utc)) return utc;
    }
    if (onDate(utc)) return utc;

    const step = 30 * 60 * 1000;
    const wall = localWallAt(utc);
    const dir = asUtc >= Date.UTC(wall.year, wall.month - 1, wall.day, 0, 0, 0) ? 1 : -1;
    for (let i = 0; i < 48; i++) {
      utc += dir * step;
      if (!onDate(utc)) continue;
      while (onDate(utc - 1000)) utc -= 1000;
      return utc;
    }
    throw new RangeError('invalid_date');
  };

  const [year, month, dayNum] = day.split('-').map(Number) as [number, number, number];
  // JS Date 会把 2 月 30 日滚成 3 月 2 日；非法日历日必须 400，区间回显不得被归一化改掉。
  const calendar = new Date(Date.UTC(year, month - 1, dayNum));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== dayNum
  ) {
    throw new RangeError('invalid_date');
  }
  const start = zonedLocalMidnightUtc(year, month, dayNum);
  const next = new Date(Date.UTC(year, month - 1, dayNum + 1));
  const end = zonedLocalMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  return {
    date: day,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  };
}

export function summarizeNotificationLog(options: {
  date: string;
  tz: string;
  channel?: NotificationLogicalChannel;
}): Promise<NotificationSummary> {
  return enqueue(() => {
    const now = nowMs();
    const bounds = zonedDayBounds(options.date, options.tz, now);
    const records = loadRecordsOrThrow();
    const { rows } = applyWindow(
      records,
      {
        channel: options.channel,
        from: bounds.from,
        to: bounds.to,
        limit: 100,
      },
      now,
    );
    const byLevel = { urgent: 0, normal: 0, low: 0 };
    const byChannel: Record<string, number> = {};
    let lastSuccessfulAt: string | null = null;
    for (const row of rows) {
      byLevel[row.level] += 1;
      byChannel[row.logicalChannel] = (byChannel[row.logicalChannel] ?? 0) + 1;
      if (!lastSuccessfulAt || row.publishedAt > lastSuccessfulAt) lastSuccessfulAt = row.publishedAt;
    }
    return {
      date: bounds.date,
      tz: options.tz,
      from: bounds.from,
      to: bounds.to,
      total: rows.length,
      ringCount: byLevel.urgent,
      byLevel,
      byChannel,
      lastSuccessfulAt,
    };
  });
}

export function lastSuccessfulAt(channel?: NotificationLogicalChannel): Promise<string | null> {
  return enqueue(() => {
    const now = nowMs();
    const records = loadRecordsOrThrow();
    const { rows } = applyWindow(records, { channel, limit: 20 }, now);
    return rows[0]?.publishedAt ?? null;
  });
}

/** 丢掉 publishedAt < now-30d 的行；tmp + fsync + rename。 */
export function compactNotificationLog(): Promise<{ kept: number; dropped: number }> {
  return enqueue(() => {
    const now = nowMs();
    const cutoff = retentionCutoffMs(now);
    let records: NotificationLogRecord[];
    try {
      records = loadRecordsOrThrow();
    } catch (err) {
      if (err instanceof NotificationLogCorruptError) {
        notificationLogHealthAlert('compact_skipped_corrupt', {});
        throw err;
      }
      throw err;
    }
    const kept = records.filter((row) => Date.parse(row.publishedAt) >= cutoff);
    const dropped = records.length - kept.length;
    if (dropped > 0) {
      writeAtomicSync(kept.map((row) => `${JSON.stringify(row)}\n`).join(''));
    }
    return { kept: kept.length, dropped };
  });
}

function msUntilNextUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1_000, next - now);
}

/** 启动立即清理，之后每个 UTC 午夜再跑。永不把异常抛出事件循环。 */
export function startNotificationLogMaintenance(): void {
  const tick = async () => {
    try {
      const result = await compactNotificationLog();
      if (result.dropped > 0) {
        console.log(`[notification-log] compacted: kept ${result.kept}, dropped ${result.dropped}`);
      }
    } catch (err) {
      if (!(err instanceof NotificationLogCorruptError)) {
        notificationLogHealthAlert('compact_failed', { error: (err as Error).message });
      }
    }
  };
  void tick();
  const schedule = () => {
    const timer = setTimeout(() => {
      void tick().finally(schedule);
    }, msUntilNextUtcMidnight(Date.now()));
    timer.unref?.();
  };
  schedule();
}

/** 测试缝：注入时钟。 */
export function setNotificationLogNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

/** 测试缝：写盘前钩子。 */
export function setNotificationLogPersistHookForTests(hook: (() => void) | null): void {
  persistHookForTests = hook;
}

/** 测试缝：清内存 fail-closed 与队列，并尽量删掉当前 DATA_DIR 日志。 */
export function resetNotificationLogForTests(): void {
  failClosed = false;
  persistHookForTests = null;
  nowFn = () => Date.now();
  writeChain = Promise.resolve();
  for (const path of [logPath(), tmpPath(), partialPath()]) {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
