/**
 * 发送审计日志（#1 Sent box light）。
 *
 * 权威存储：DATA_DIR/send-log.jsonl。/v1/send 成功与失败都追加一行。
 * 只记信封元数据，不写正文 / token。SMTP 直发不在此列。
 *
 * 纪律对齐 notification-log + notification-devices：
 * 单写者 promise 队列、目录 0700、文件/临时文件 0600、
 * 同目录 .tmp + 文件 fsync + dest→.bak + rename + 目录 fsync；
 * 目录 fsync 失败则 .bak 换回（不 truncate 活文件）；
 * 末尾半行隔离、中间损坏 fail-closed、30 天 sweeper。
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
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.ts';

export const SEND_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SEND_LOG_SCHEMA_VERSION = 1;
export const SEND_LOG_LIMITS = [20, 50, 100] as const;
export type SendLogLimit = (typeof SEND_LOG_LIMITS)[number];

export type SendLogSource = 'api' | 'mcp';
export type SendLogResult = 'queued' | 'failed';

export type SendLogRecord = {
  schemaVersion: typeof SEND_LOG_SCHEMA_VERSION;
  id: string;
  sentAt: string;
  from: string;
  to: string[];
  subject: string;
  messageId: string | null;
  result: SendLogResult;
  error?: string;
  source: SendLogSource;
};

export type SendLogQuery = {
  address?: string;
  cursor?: string;
  limit: SendLogLimit;
};

export type SendLogPage = {
  items: SendLogRecord[];
  nextCursor: string | null;
  queryNow: string;
};

export class SendLogCorruptError extends Error {
  readonly code = 'send_log_corrupt';
  constructor() {
    super('send_log_corrupt');
    this.name = 'SendLogCorruptError';
  }
}

export class SendLogPersistError extends Error {
  readonly code = 'send_log_persist_failed';
  constructor(cause?: unknown) {
    super(cause instanceof Error ? cause.message : 'send_log_persist_failed');
    this.name = 'SendLogPersistError';
  }
}

export class InvalidSendCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor() {
    super('invalid_cursor');
    this.name = 'InvalidSendCursorError';
  }
}

const LOG_NAME = 'send-log.jsonl';
const CURSOR_PREFIX = 'send-log-cursor-v1';
const SOURCES = new Set<SendLogSource>(['api', 'mcp']);
const RESULTS = new Set<SendLogResult>(['queued', 'failed']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CursorPayload = { addr: string; t: number; id: string };

let writeChain: Promise<void> = Promise.resolve();
let failClosed = false;
let nowFn: () => number = () => Date.now();
let persistHookForTests: (() => void) | null = null;
let dirFsyncHookForTests: (() => void) | null = null;

function logPath(): string {
  return join(config.dataDir, LOG_NAME);
}

function tmpPath(): string {
  return join(config.dataDir, `${LOG_NAME}.tmp`);
}

function bakPath(): string {
  return join(config.dataDir, `${LOG_NAME}.bak`);
}

function partialPath(): string {
  return join(config.dataDir, `${LOG_NAME}.partial`);
}

function nowMs(): number {
  return nowFn();
}

function retentionCutoffMs(now = nowMs()): number {
  return now - SEND_LOG_RETENTION_MS;
}

function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // bind mount 属主可能不同
  }
}

export function sendLogHealthAlert(kind: string, detail: Record<string, unknown> = {}): void {
  console.error(`[send-log] HIGH: ${kind}`, detail);
}

function enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isSendLogLimit(value: number): value is SendLogLimit {
  return (SEND_LOG_LIMITS as readonly number[]).includes(value);
}

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

function parseRecord(raw: unknown): SendLogRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (row.schemaVersion !== SEND_LOG_SCHEMA_VERSION) return null;
  if (typeof row.id !== 'string' || !row.id.startsWith('snd_') || row.id.length > 80) return null;
  if (typeof row.sentAt !== 'string' || !Number.isFinite(Date.parse(row.sentAt))) return null;
  if (typeof row.from !== 'string' || !normalizeEmail(row.from)) return null;
  if (!Array.isArray(row.to) || row.to.length === 0 || row.to.length > 50) return null;
  const to: string[] = [];
  for (const item of row.to) {
    if (typeof item !== 'string') return null;
    const email = normalizeEmail(item);
    if (!email) return null;
    to.push(email);
  }
  if (typeof row.subject !== 'string' || row.subject.length > 998) return null;
  if (row.messageId !== null && typeof row.messageId !== 'string') return null;
  if (typeof row.result !== 'string' || !RESULTS.has(row.result as SendLogResult)) return null;
  if (typeof row.source !== 'string' || !SOURCES.has(row.source as SendLogSource)) return null;
  if (row.error !== undefined && (typeof row.error !== 'string' || row.error.length > 64)) return null;
  // 禁止正文/秘密键混入落盘行
  if ('text' in row || 'html' in row || 'token' in row || 'body' in row) return null;
  const record: SendLogRecord = {
    schemaVersion: SEND_LOG_SCHEMA_VERSION,
    id: row.id,
    sentAt: row.sentAt,
    from: normalizeEmail(row.from)!,
    to,
    subject: row.subject,
    messageId: typeof row.messageId === 'string' ? row.messageId : null,
    result: row.result as SendLogResult,
    source: row.source as SendLogSource,
  };
  if (typeof row.error === 'string' && row.error) record.error = row.error;
  return record;
}

type ParsedFile = {
  records: SendLogRecord[];
  trailingPartial: string | null;
  middleCorrupt: boolean;
};

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseFileText(raw: string): ParsedFile {
  if (raw.length === 0) return { records: [], trailingPartial: null, middleCorrupt: false };
  const endsWithNl = raw.endsWith('\n');
  const parts = raw.split('\n');
  if (endsWithNl && parts[parts.length - 1] === '') parts.pop();

  let trailingPartial: string | null = null;
  let complete = parts;
  if (!endsWithNl) {
    const last = parts[parts.length - 1] ?? '';
    complete = parts.slice(0, -1);
    const parsedLast = last.trim() ? parseRecord(safeJson(last)) : null;
    if (parsedLast) complete = [...complete, last];
    else trailingPartial = last;
  }

  const records: SendLogRecord[] = [];
  for (const line of complete) {
    if (!line.trim()) return { records, trailingPartial, middleCorrupt: true };
    const parsed = parseRecord(safeJson(line));
    if (!parsed) return { records, trailingPartial, middleCorrupt: true };
    records.push(parsed);
  }
  return { records, trailingPartial, middleCorrupt: false };
}

function readRawSync(): string {
  if (!existsSync(logPath())) return '';
  return readFileSync(logPath(), 'utf8');
}

function fsyncDirectorySync(dir: string): void {
  dirFsyncHookForTests?.();
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS') return;
    throw err;
  } finally {
    closeSync(fd);
  }
}

function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset);
  }
}

/** 覆盖写留下的 .bak：dest 缺失则恢复旧日志；dest 已在则丢掉残留备份。 */
function recoverBackupSync(): void {
  const bak = bakPath();
  const dest = logPath();
  if (!existsSync(bak)) return;
  if (!existsSync(dest)) {
    try {
      renameSync(bak, dest);
      sendLogHealthAlert('crash_bak_restored', { path: LOG_NAME });
    } catch (err) {
      failClosed = true;
      sendLogHealthAlert('crash_bak_restore_failed', {
        path: LOG_NAME,
        error: err instanceof Error ? err.message : 'unknown',
      });
      throw new SendLogCorruptError();
    }
    return;
  }
  try {
    rmSync(bak, { force: true });
    sendLogHealthAlert('crash_bak_discarded', { path: LOG_NAME });
  } catch (err) {
    sendLogHealthAlert('crash_bak_cleanup_failed', {
      path: LOG_NAME,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** 目录 fsync 失败时把覆盖写滚回旧日志（.bak 优先，内存快照兜底）。 */
function restoreOverwrittenLog(dest: string, bak: string, previous: Buffer | null): void {
  try {
    if (existsSync(bak)) {
      renameSync(bak, dest);
      return;
    }
  } catch {
    // 下面用内存快照再写一次
  }
  try {
    if (previous) {
      writeFileSync(dest, previous, { mode: 0o600 });
      return;
    }
  } catch {
    // 两路都失败则 fail-closed，避免把半截新文件当有效审计
  }
  failClosed = true;
  sendLogHealthAlert('crash_bak_restore_exhausted', { path: LOG_NAME });
  throw new SendLogCorruptError();
}

/** 重写整文件：tmp + 文件 fsync + dest→bak + rename + 目录 fsync；目录 fsync 失败则 bak 换回。 */
function writeAtomicSync(text: string): void {
  // dest 缺而 .bak 还在：禁止当空日志落盘，否则会丢掉历史审计。
  if (existsSync(bakPath()) && !existsSync(logPath())) {
    failClosed = true;
    sendLogHealthAlert('crash_bak_unrestored', { path: LOG_NAME });
    throw new SendLogCorruptError();
  }
  ensureDataDir();
  persistHookForTests?.();
  const tmp = tmpPath();
  const dest = logPath();
  const bak = bakPath();
  const replacing = existsSync(dest);
  const previous = replacing ? readFileSync(dest) : null;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    if (text.length > 0) writeAllSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best effort
  }
  if (replacing) renameSync(dest, bak);
  renameSync(tmp, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best effort
  }
  try {
    fsyncDirectorySync(config.dataDir);
  } catch (err) {
    let rollbackErr: unknown = null;
    try {
      if (!replacing) {
        try {
          rmSync(dest, { force: true });
        } catch {
          // ignore
        }
      } else {
        restoreOverwrittenLog(dest, bak, previous);
      }
    } catch (inner) {
      rollbackErr = inner;
    }
    try {
      fsyncDirectorySync(config.dataDir);
    } catch {
      failClosed = true;
      sendLogHealthAlert('crash_rollback_fsync_failed', { path: LOG_NAME });
      throw new SendLogCorruptError();
    }
    if (rollbackErr) throw rollbackErr;
    throw err;
  }
  if (replacing) {
    try {
      rmSync(bak, { force: true });
    } catch {
      // 残留 .bak 下次读盘会丢掉
    }
  }
}

function appendLineSync(line: string): void {
  ensureDataDir();
  persistHookForTests?.();
  const path = logPath();
  const fd = openSync(path, 'a', 0o600);
  try {
    writeAllSync(fd, line);
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
}

function inspectAndRepairSync(): SendLogRecord[] {
  recoverBackupSync();
  const raw = readRawSync();
  const parsed = parseFileText(raw);
  if (parsed.middleCorrupt) {
    failClosed = true;
    sendLogHealthAlert('middle_corrupt', { path: LOG_NAME });
    throw new SendLogCorruptError();
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
        writeAllSync(pfd, fragment);
        fsyncSync(pfd);
      } finally {
        closeSync(pfd);
      }
      try {
        chmodSync(partialPath(), 0o600);
      } catch {
        // sidecar 权限失败不否决已隔离
      }
    } catch (err) {
      sendLogHealthAlert('partial_isolate_failed', { error: (err as Error).message });
      throw err;
    }
    sendLogHealthAlert('trailing_partial_isolated', {
      path: LOG_NAME,
      bytes: parsed.trailingPartial.length,
    });
    writeAtomicSync(parsed.records.map((row) => `${JSON.stringify(row)}\n`).join(''));
  } else if (raw.length > 0 && !raw.endsWith('\n')) {
    appendMissingFinalNewlineSync();
  }
  return parsed.records;
}

function loadRecordsOrThrow(): SendLogRecord[] {
  if (failClosed) throw new SendLogCorruptError();
  return inspectAndRepairSync();
}

const cursorKey = createHmac('sha256', config.taskSigningSecret)
  .update(CURSOR_PREFIX)
  .digest();

function cursorMac(payload: CursorPayload): string {
  return createHmac('sha256', cursorKey)
    .update(`${CURSOR_PREFIX}\n${payload.addr}\n${payload.t}\n${payload.id}`)
    .digest('base64url');
}

function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${CURSOR_PREFIX}.${body}.${cursorMac(payload)}`;
}

function decodeCursor(token: string): CursorPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX || !parts[1] || !parts[2]) {
    throw new InvalidSendCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSendCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidSendCursorError();
  const raw = parsed as { addr?: unknown; t?: unknown; id?: unknown };
  if (typeof raw.addr !== 'string') throw new InvalidSendCursorError();
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) throw new InvalidSendCursorError();
  if (typeof raw.id !== 'string' || !raw.id) throw new InvalidSendCursorError();
  const payload: CursorPayload = { addr: raw.addr, t: raw.t, id: raw.id };
  const expected = cursorMac(payload);
  try {
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidSendCursorError();
  } catch (err) {
    if (err instanceof InvalidSendCursorError) throw err;
    throw new InvalidSendCursorError();
  }
  return payload;
}

function olderThanCursor(row: SendLogRecord, cursor: CursorPayload): boolean {
  const t = Date.parse(row.sentAt);
  if (t < cursor.t) return true;
  if (t > cursor.t) return false;
  return row.id < cursor.id;
}

export type AppendSendLogInput = {
  from: string;
  to: string[];
  subject: string;
  messageId?: string | null;
  result: SendLogResult;
  error?: string;
  source: SendLogSource;
};

export function appendSendLog(input: AppendSendLogInput): Promise<SendLogRecord> {
  return enqueue(() => {
    inspectAndRepairSync();
    const from = normalizeEmail(input.from);
    if (!from) throw new Error('invalid_send_log_from');
    const to = input.to.map((item) => normalizeEmail(item)).filter((item): item is string => Boolean(item));
    if (to.length === 0) throw new Error('invalid_send_log_to');
    const record: SendLogRecord = {
      schemaVersion: SEND_LOG_SCHEMA_VERSION,
      id: `snd_${randomBytes(12).toString('hex')}`,
      sentAt: new Date(nowMs()).toISOString(),
      from,
      to: to.slice(0, 50),
      subject: input.subject.slice(0, 998),
      messageId: input.messageId ?? null,
      result: input.result,
      source: input.source,
    };
    if (input.result === 'failed' && input.error) {
      record.error = input.error.slice(0, 64);
    }
    try {
      appendLineSync(`${JSON.stringify(record)}\n`);
    } catch (err) {
      sendLogHealthAlert('persist_failed', { error: (err as Error).message });
      throw new SendLogPersistError(err);
    }
    return record;
  });
}

export function querySendLog(query: SendLogQuery): Promise<SendLogPage> {
  return enqueue(() => {
    const now = nowMs();
    const records = loadRecordsOrThrow();
    const cutoff = retentionCutoffMs(now);
    const address = query.address ? normalizeEmail(query.address) : undefined;
    const rows = records
      .filter((row) => {
        const t = Date.parse(row.sentAt);
        if (!Number.isFinite(t) || t < cutoff || t > now) return false;
        if (address && row.from !== address) return false;
        return true;
      })
      .sort((a, b) => {
        const dt = Date.parse(b.sentAt) - Date.parse(a.sentAt);
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    const fp = address ?? '';
    let start = 0;
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.addr !== fp) throw new InvalidSendCursorError();
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
          ? encodeCursor({ addr: fp, t: Date.parse(last.sentAt), id: last.id })
          : null,
      queryNow: new Date(now).toISOString(),
    };
  });
}

export function getSendLogRecord(id: string): Promise<SendLogRecord | null> {
  return enqueue(() => {
    const records = loadRecordsOrThrow();
    const cutoff = retentionCutoffMs();
    return (
      records.find((row) => row.id === id && Date.parse(row.sentAt) >= cutoff) ?? null
    );
  });
}

export function compactSendLog(): Promise<{ kept: number; dropped: number }> {
  return enqueue(() => {
    const now = nowMs();
    const cutoff = retentionCutoffMs(now);
    let records: SendLogRecord[];
    try {
      records = loadRecordsOrThrow();
    } catch (err) {
      if (err instanceof SendLogCorruptError) {
        sendLogHealthAlert('compact_skipped_corrupt', {});
        throw err;
      }
      throw err;
    }
    const kept = records.filter((row) => Date.parse(row.sentAt) >= cutoff);
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

export function startSendLogMaintenance(): void {
  const tick = async () => {
    try {
      const result = await compactSendLog();
      if (result.dropped > 0) {
        console.log(`[send-log] compacted: kept ${result.kept}, dropped ${result.dropped}`);
      }
    } catch (err) {
      if (!(err instanceof SendLogCorruptError)) {
        sendLogHealthAlert('compact_failed', { error: (err as Error).message });
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

export function setSendLogNowForTests(fn: (() => number) | null): void {
  nowFn = fn ?? (() => Date.now());
}

export function setSendLogPersistHookForTests(hook: (() => void) | null): void {
  persistHookForTests = hook;
}

export function setSendLogDirFsyncHookForTests(hook: (() => void) | null): void {
  dirFsyncHookForTests = hook;
}

export function resetSendLogForTests(): void {
  failClosed = false;
  persistHookForTests = null;
  dirFsyncHookForTests = null;
  nowFn = () => Date.now();
  writeChain = Promise.resolve();
  for (const path of [logPath(), tmpPath(), bakPath(), partialPath()]) {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function sendLogPathForTests(): string {
  return logPath();
}
