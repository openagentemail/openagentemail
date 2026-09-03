/**
 * 内部信 HMAC 自签 stamp（与 MTA 无关，fail-closed）。
 *
 * 发信侧在 sendMail 写入 `X-OA-Mail-Stamp`；读信侧按同一字段规约重算比对。
 * 通过 → source:'internal'；无头 / 不符 / 字段缺失 → 一律 'external'。
 *
 * 重放安全性：stamp 绑定信封字段 + 正文摘要。攻击者复制合法 stamp 头但改正文
 * （或改 from/to/subject/date）都会使 HMAC 破碎。完整重放整封信只能重放
 * 本 API 写过的内容。密钥复用 config.taskSigningSecret，前缀 `mail-stamp-v1`
 * 做域分离；正文摘要用 `mail-body-v2` 长度前缀规约。
 *
 * HMAC 预言机：taskSigningSecret 可能 fallback 到 SMTP_PASS，stamp 头若发给
 * 外部收件人即成已知明文爆破面——因此仅当全部 To 均在本域时才写出 stamp。
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** 协议版本前缀，变更字段规约时递增。 */
export const MAIL_STAMP_PREFIX = 'mail-stamp-v1';

/** 正文摘要域分离前缀（v2：长度前缀，消除裸 \\n 拼接的边界歧义）。 */
export const MAIL_BODY_HASH_PREFIX = 'mail-body-v2';

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
 * - bodyHash：base64url(SHA-256(mail-body-v2\\nlen(text)\\ntext\\nlen(html)\\nhtml))，
 *   长度按 UTF-8 字节；绑定正文防止「偷 stamp 头换正文」逃逸围栏
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
 * 全部收件人是否都在配置的域名集合内（小写比对）。空列表 / 无法解析 → false（fail-closed）。
 */
export function allRecipientsInDomains(to: string[], domains: Iterable<string>): boolean {
  const domainSet = new Set([...domains].map((d) => d.toLowerCase()));
  const addrs = to.map(normalizeMailbox).filter(Boolean);
  if (addrs.length === 0) return false;
  return addrs.every((address) => {
    const at = address.lastIndexOf('@');
    if (at === -1) return false;
    return domainSet.has(address.slice(at + 1));
  });
}

/**
 * 全部收件人是否都在本域（小写比对）。保留单域名兼容。
 */
export function allRecipientsOnDomain(to: string[], domain: string): boolean {
  return allRecipientsInDomains(to, [domain]);
}

/**
 * 正文摘要（mail-body-v2）：CRLF→LF + trimEnd 后，用 UTF-8 字节长度前缀拼接，
 * 避免 "a\\nb","c" 与 "a","b\\nc" 哈希碰撞。
 */
export function hashMailBody(text: string, html?: string): string {
  const normalizedText = text.replace(/\r\n/g, '\n').trimEnd();
  const normalizedHtml = (html ?? '').replace(/\r\n/g, '\n').trimEnd();
  const textLen = Buffer.byteLength(normalizedText, 'utf8');
  const htmlLen = Buffer.byteLength(normalizedHtml, 'utf8');
  return createHash('sha256')
    .update(
      `${MAIL_BODY_HASH_PREFIX}\n${textLen}\n${normalizedText}\n${htmlLen}\n${normalizedHtml}`,
    )
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

/** 大小写不敏感地去掉调用方已有的 stamp 头，避免与规范名并存成双头。 */
function withoutStampHeaders(headers: Record<string, string>): Record<string, string> {
  const stampKey = MAIL_STAMP_HEADER.toLowerCase();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === stampKey) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 发信侧组装头：滤掉调用方异形同名 stamp 头后，在「全部 To 均本域」时写入
 * 唯一的 X-OA-Mail-Stamp；混合/外部收件人不写（防 HMAC 预言机外泄）。
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
  domains: Iterable<string> | string,
): Record<string, string> {
  const base = withoutStampHeaders(input.headers ?? {});
  const domainList = typeof domains === 'string' ? [domains] : domains;
  // 任一外部收件人 → 不贴 stamp（本地那封读回会 external，可接受）。
  if (!allRecipientsInDomains(input.to, domainList)) return base;

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
  return { ...base, [MAIL_STAMP_HEADER]: stamp };
}

function stampPayload(fields: MailStampFields): string {
  return `${MAIL_STAMP_PREFIX}\n${fields.from}\n${fields.to}\n${fields.subject}\n${fields.dateIso}\n${fields.bodyHash}`;
}
