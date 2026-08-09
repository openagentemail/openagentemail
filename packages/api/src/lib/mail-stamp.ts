/**
 * 内部信 HMAC 自签 stamp（与 MTA 无关，fail-closed）。
 *
 * 发信侧在 sendMail 写入 `X-OA-Mail-Stamp`；读信侧按同一字段规约重算比对。
 * 通过 → source:'internal'；无头 / 不符 / 字段缺失 → 一律 'external'。
 *
 * 重放安全性：stamp 绑定信封字段 + 正文摘要。攻击者复制合法 stamp 头但改正文
 * （或改 from/to/subject/date）都会使 HMAC 破碎。完整重放整封信只能重放
 * 本 API 写过的内容。密钥复用 config.taskSigningSecret，前缀 `mail-stamp-v1`
 * 做域分离；正文摘要另用 `mail-body-v1` 前缀。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 协议版本前缀，变更字段规约时递增。 */
export const MAIL_STAMP_PREFIX = 'mail-stamp-v1';

/** 正文摘要域分离前缀。 */
export const MAIL_BODY_HASH_PREFIX = 'mail-body-v1';

/** 发信时写入的头名（mailparser 读回为小写键）。 */
export const MAIL_STAMP_HEADER = 'X-OA-Mail-Stamp';

export type MailSource = 'internal' | 'external';

/**
 * Stamp 载荷字段规约（发读两侧必须逐字一致）：
 * - from：单个邮箱地址，小写（不含显示名）
 * - to：逐地址小写后按发信顺序用英文逗号拼接（无空格）
 * - subject：主题原文（不做 trim / 大小写变换）
 * - dateIso：显式 Date 的 toISOString()；发信前把毫秒置 0，
 *   因为 RFC 2822 Date 头不带毫秒，mailparser 回读后 ms 恒为 0
 * - bodyHash：base64url(SHA-256(mail-body-v1\\ntext.trimEnd()\\nhtml))，
 *   无 html 时第三行为空串；绑定正文防止「偷 stamp 头换正文」逃逸围栏
 */
export interface MailStampFields {
  from: string;
  to: string;
  subject: string;
  dateIso: string;
  bodyHash: string;
}

/** 从 "Name <addr@x>" / "addr@x" 抽出单个邮箱并小写；抽不出则空串。 */
export function normalizeMailbox(raw: string): string {
  const trimmed = raw.trim();
  const angle = /<([^<>]+)>/.exec(trimmed);
  const candidate = (angle ? angle[1]! : trimmed).trim().toLowerCase();
  return candidate.includes('@') ? candidate : '';
}

/** 把地址列表折成 stamp 用的 to 字段（小写、逗号拼接、无空格）。 */
export function normalizeToList(addresses: string[]): string {
  return addresses.map(normalizeMailbox).filter(Boolean).join(',');
}

/** 发信用 Date：毫秒置 0，保证与 RFC 2822 回读后的 ISO 一致。 */
export function stampDate(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setMilliseconds(0);
  return d;
}

/**
 * 正文摘要：CRLF→LF 再 trimEnd（对齐 mailparser 行尾与常加的尾 \\n），
 * html 缺省为空串（mailparser 无 html 时可能给出 false）。
 */
export function hashMailBody(text: string, html?: string): string {
  const normalizedText = text.replace(/\r\n/g, '\n').trimEnd();
  const normalizedHtml = (html ?? '').replace(/\r\n/g, '\n');
  return createHash('sha256')
    .update(`${MAIL_BODY_HASH_PREFIX}\n${normalizedText}\n${normalizedHtml}`)
    .digest('base64url');
}

/** 计算 stamp：base64url(HMAC-SHA256(key, mail-stamp-v1\\n…\\nbodyHash)) */
export function createMailStamp(fields: MailStampFields, key: string): string {
  return createHmac('sha256', key).update(stampPayload(fields)).digest('base64url');
}

/**
 * 验证 stamp。任一字段缺失、头缺失、或 HMAC 不符 → false（fail-closed）。
 * 使用 timing-safe 比较，避免泄露前缀匹配信息。
 */
export function verifyMailStamp(
  stamp: string | undefined,
  fields: MailStampFields,
  key: string,
): boolean {
  if (!stamp || !fields.from || !fields.to || !fields.dateIso || !fields.bodyHash) {
    return false;
  }
  const expected = createMailStamp(fields, key);
  try {
    const a = Buffer.from(stamp);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 根据 stamp 头与载荷字段判定来源；不确定一律 external。 */
export function classifyMailSource(
  stamp: string | undefined,
  fields: MailStampFields,
  key: string,
): MailSource {
  return verifyMailStamp(stamp, fields, key) ? 'internal' : 'external';
}

/**
 * 发信侧组装头：在调用方 headers 之上强制写入 X-OA-Mail-Stamp（覆盖同名伪造值）。
 * from/to/正文按字段规约规范化后再签名。
 */
export function buildOutboundStampHeaders(
  input: {
    from: string;
    to: string[];
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  },
  date: Date,
  key: string,
): Record<string, string> {
  const stamp = createMailStamp(
    {
      from: normalizeMailbox(input.from),
      to: normalizeToList(input.to),
      subject: input.subject,
      dateIso: date.toISOString(),
      bodyHash: hashMailBody(input.text, input.html),
    },
    key,
  );
  return { ...(input.headers ?? {}), [MAIL_STAMP_HEADER]: stamp };
}

function stampPayload(fields: MailStampFields): string {
  return `${MAIL_STAMP_PREFIX}\n${fields.from}\n${fields.to}\n${fields.subject}\n${fields.dateIso}\n${fields.bodyHash}`;
}
