/**
 * Inbox 列表游标（HMAC 不透明 token）。
 *
 * 绑定 folder + address + (receivedAtMs, uid)，防止跨 folder/身份复用，
 * 以及客户端伪造「下一页」跳过或重复条目。密钥复用 taskSigningSecret，
 * 前缀 `mail-cursor-v1` 与 mail-stamp 做域分离。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 协议版本前缀；变更字段规约时递增。 */
export const MAIL_CURSOR_PREFIX = 'mail-cursor-v1';

/** Dashboard Inbox 首版文件夹。Scheduled/Trash 后端未具备，不得出现在此枚举。 */
export const MAIL_FOLDERS = ['inbox', 'sent', 'all'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export function isMailFolder(value: string): value is MailFolder {
  return (MAIL_FOLDERS as readonly string[]).includes(value);
}

/** 游标载荷：排序键 newest-first 为 (t desc, uid desc)。 */
export type MailCursorPayload = {
  folder: MailFolder;
  address: string;
  t: number;
  uid: number;
};

/** 非法 / 篡改 / 跨 folder 错用游标。路由折成 400。 */
export class InvalidMailCursorError extends Error {
  readonly code = 'invalid_cursor';
  constructor() {
    super('invalid_cursor');
    this.name = 'InvalidMailCursorError';
  }
}

function cursorMac(payload: MailCursorPayload, key: string): string {
  return createHmac('sha256', key)
    .update(
      `${MAIL_CURSOR_PREFIX}\n${payload.folder}\n${payload.address}\n${payload.t}\n${payload.uid}`,
    )
    .digest('base64url');
}

/** 编码不透明游标。address 必须已小写。 */
export function encodeMailCursor(payload: MailCursorPayload, key: string): string {
  const body = Buffer.from(
    JSON.stringify({
      f: payload.folder,
      a: payload.address,
      t: payload.t,
      u: payload.uid,
    }),
  ).toString('base64url');
  return `${MAIL_CURSOR_PREFIX}.${body}.${cursorMac(payload, key)}`;
}

/** 解码并校验 HMAC。失败一律 InvalidMailCursorError（fail-closed）。 */
export function decodeMailCursor(token: string, key: string): MailCursorPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== MAIL_CURSOR_PREFIX || !parts[1] || !parts[2]) {
    throw new InvalidMailCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new InvalidMailCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidMailCursorError();
  const raw = parsed as { f?: unknown; a?: unknown; t?: unknown; u?: unknown };
  if (typeof raw.f !== 'string' || !isMailFolder(raw.f)) throw new InvalidMailCursorError();
  if (typeof raw.a !== 'string' || !raw.a.includes('@')) throw new InvalidMailCursorError();
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) throw new InvalidMailCursorError();
  if (typeof raw.u !== 'number' || !Number.isInteger(raw.u) || raw.u <= 0) {
    throw new InvalidMailCursorError();
  }
  const payload: MailCursorPayload = {
    folder: raw.f,
    address: raw.a.toLowerCase(),
    t: raw.t,
    uid: raw.u,
  };
  const expected = cursorMac(payload, key);
  try {
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidMailCursorError();
  } catch (err) {
    if (err instanceof InvalidMailCursorError) throw err;
    throw new InvalidMailCursorError();
  }
  return payload;
}
