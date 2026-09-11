/**
 * Inbox 列表游标（HMAC 不透明 token）。
 *
 * 后向分页现为 mail-cursor-v2：绑定 folder + address + (receivedAtMs, uid)
 * + canonical 正整数 uidValidity，防止跨 folder/身份/信箱代际复用，
 * 以及客户端伪造「下一页」。密钥复用 taskSigningSecret。
 * 旧 mail-cursor-v1 一律失效，客户端须从第一页重启；无 v1 fallback。
 * 前向 mail-fcursor-v1 协议不变，与后向互不通用。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 后向游标协议版本前缀；v1 已退役，解码见前缀即拒。 */
export const MAIL_CURSOR_PREFIX = 'mail-cursor-v2';

/** 已退役的后向 v1 前缀；仅供文档/测试对照，编码器不得再发出。 */
export const MAIL_CURSOR_V1_PREFIX = 'mail-cursor-v1';

/** 前向游标版本前缀；载荷含 uidValidity，与既有后向游标互不通用。 */
export const MAIL_FORWARD_CURSOR_PREFIX = 'mail-fcursor-v1';

/** Dashboard Inbox 首版文件夹。Scheduled/Trash 后端未具备，不得出现在此枚举。 */
export const MAIL_FOLDERS = ['inbox', 'sent', 'all'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

export function isMailFolder(value: string): value is MailFolder {
  return (MAIL_FOLDERS as readonly string[]).includes(value);
}

/**
 * 将 uidValidity 收成规范正整数字符串（十进制、无前导零、无符号、>0）。
 * 数字串一律经 BigInt(...).toString()；number 只接受安全正整数。
 * 非法 / 缺失一律 InvalidMailCursorError（含首页拿不到当前代际）。
 * 前向 mail-fcursor-v1 不走此函数，协议不变。
 */
export function canonicalizeMailUidValidity(value: unknown): string {
  if (typeof value === 'bigint' && value > 0n) return value.toString();
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const normalized = BigInt(value).toString();
    if (normalized === '0') throw new InvalidMailCursorError();
    return normalized;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  throw new InvalidMailCursorError();
}

/** 游标载荷：排序键 newest-first 为 (t desc, uid desc)；v 为已验证代际。 */
export type MailCursorPayload = {
  folder: MailFolder;
  address: string;
  t: number;
  uid: number;
  uidValidity: string | number | bigint;
};

/** 前向游标载荷：绑定 uidValidity 代际，语义为 (t asc, uid asc) 之后的条目；可选 scanUid 为扫描预算水印。 */
export type MailForwardCursorPayload = {
  folder: MailFolder;
  address: string;
  t: number;
  uid: number;
  uidValidity: string | number | bigint;
  scanUid?: number;
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
  const vStr = canonicalizeMailUidValidity(payload.uidValidity);
  return createHmac('sha256', key)
    .update(
      `${MAIL_CURSOR_PREFIX}\n${payload.folder}\n${payload.address}\n${payload.t}\n${payload.uid}\n${vStr}`,
    )
    .digest('base64url');
}

/** 编码不透明后向游标。address 必须已小写；uidValidity 写入载荷与 MAC。 */
export function encodeMailCursor(payload: MailCursorPayload, key: string): string {
  const vStr = canonicalizeMailUidValidity(payload.uidValidity);
  const body = Buffer.from(
    JSON.stringify({
      f: payload.folder,
      a: payload.address,
      t: payload.t,
      u: payload.uid,
      v: vStr,
    }),
  ).toString('base64url');
  return `${MAIL_CURSOR_PREFIX}.${body}.${cursorMac({ ...payload, uidValidity: vStr }, key)}`;
}

/** 解码并校验 HMAC。v1 / 缺代际 / 篡改一律 InvalidMailCursorError（fail-closed）。 */
export function decodeMailCursor(token: string, key: string): MailCursorPayload {
  const parts = token.split('.');
  // 任何非 v2 前缀（含 mail-cursor-v1）直接拒，不推断代际。
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
  const raw = parsed as { f?: unknown; a?: unknown; t?: unknown; u?: unknown; v?: unknown };
  if (typeof raw.f !== 'string' || !isMailFolder(raw.f)) throw new InvalidMailCursorError();
  if (typeof raw.a !== 'string' || !raw.a.includes('@')) throw new InvalidMailCursorError();
  if (typeof raw.t !== 'number' || !Number.isFinite(raw.t)) throw new InvalidMailCursorError();
  if (typeof raw.u !== 'number' || !Number.isInteger(raw.u) || raw.u <= 0) {
    throw new InvalidMailCursorError();
  }
  const vStr = canonicalizeMailUidValidity(raw.v);
  const payload: MailCursorPayload = {
    folder: raw.f,
    address: raw.a.toLowerCase(),
    t: raw.t,
    uid: raw.u,
    uidValidity: vStr,
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

function forwardCursorMac(payload: MailForwardCursorPayload, key: string): string {
  const vStr = String(payload.uidValidity);
  const parts: string[] = [
    MAIL_FORWARD_CURSOR_PREFIX,
    payload.folder,
    payload.address,
    String(payload.t),
    String(payload.uid),
    vStr,
    ...(payload.scanUid !== undefined ? [String(payload.scanUid)] : []),
  ];
  const input = parts.map((p) => `${Buffer.byteLength(p, 'utf8')}:${p}`).join('');
  return createHmac('sha256', key).update(input).digest('base64url');
}

/** 编码不透明前向游标。address 自动小写归一，含代际 uidValidity 与可选 scanUid。 */
export function encodeMailForwardCursor(
  payload: MailForwardCursorPayload,
  key: string,
): string {
  const normalizedAddress = payload.address.toLowerCase();
  const normalizedPayload: MailForwardCursorPayload = {
    ...payload,
    address: normalizedAddress,
  };
  const vStr = String(normalizedPayload.uidValidity);
  const bodyObj: Record<string, unknown> = {
    f: normalizedPayload.folder,
    a: normalizedPayload.address,
    t: normalizedPayload.t,
    u: normalizedPayload.uid,
    v: vStr,
  };
  if (normalizedPayload.scanUid !== undefined) {
    bodyObj.s = normalizedPayload.scanUid;
  }
  const body = Buffer.from(JSON.stringify(bodyObj)).toString('base64url');
  return `${MAIL_FORWARD_CURSOR_PREFIX}.${body}.${forwardCursorMac(normalizedPayload, key)}`;
}

/** 解码并校验前向 HMAC。任何失败一律 InvalidMailCursorError（fail-closed）。 */
export function decodeMailForwardCursor(
  token: string,
  key: string,
): MailForwardCursorPayload {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] !== MAIL_FORWARD_CURSOR_PREFIX ||
    !parts[1] ||
    !parts[2]
  ) {
    throw new InvalidMailCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new InvalidMailCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidMailCursorError();
  const raw = parsed as {
    f?: unknown;
    a?: unknown;
    t?: unknown;
    u?: unknown;
    v?: unknown;
    s?: unknown;
  };
  if (typeof raw.f !== 'string' || !isMailFolder(raw.f)) {
    throw new InvalidMailCursorError();
  }
  if (typeof raw.a !== 'string' || !raw.a.includes('@')) {
    throw new InvalidMailCursorError();
  }
  if (typeof raw.t !== 'number' || !Number.isInteger(raw.t) || raw.t < 0) {
    throw new InvalidMailCursorError();
  }
  if (typeof raw.u !== 'number' || !Number.isInteger(raw.u) || raw.u <= 0) {
    throw new InvalidMailCursorError();
  }
  let validV: string;
  if (typeof raw.v === 'string' && /^\d+$/.test(raw.v) && BigInt(raw.v) > 0n) {
    validV = raw.v;
  } else if (typeof raw.v === 'number' && Number.isInteger(raw.v) && raw.v > 0) {
    validV = String(raw.v);
  } else {
    throw new InvalidMailCursorError();
  }
  if (
    raw.s !== undefined &&
    (typeof raw.s !== 'number' || !Number.isInteger(raw.s) || raw.s < 0)
  ) {
    throw new InvalidMailCursorError();
  }
  const payload: MailForwardCursorPayload = {
    folder: raw.f,
    address: raw.a.toLowerCase(),
    t: raw.t,
    uid: raw.u,
    uidValidity: validV,
    ...(raw.s !== undefined ? { scanUid: raw.s } : {}),
  };
  const expected = forwardCursorMac(payload, key);
  try {
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new InvalidMailCursorError();
    }
  } catch (err) {
    if (err instanceof InvalidMailCursorError) throw err;
    throw new InvalidMailCursorError();
  }
  return payload;
}
