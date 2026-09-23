/**
 * 日志/告警载荷面：唯一入口 describeFailure。
 *
 * 流水线：逐字段先有界(200) → 拼接 → 单趟流式脱敏 → 单行转义。
 * 不变量见 #342 / materials/log-face-design/design.md（R3）。
 * 对外错误码/状态码/body 不经本模块；errorCode 在 errors.ts，一字不动。
 */

import { config } from './config.ts';

/** 逐字段诊断文本上界（码元 / UTF-16 单位，与历史 ERROR_DETAIL_MAX 一致） */
export const ERROR_DETAIL_MAX = 200;

/** 替换标记（不回喂自动机） */
const REDACTED = '[redacted]';

function configuredSecrets(): string[] {
  return [config.smtp.pass, config.imap.pass];
}

/** 安全截断到 N=200，不抛 */
function truncateDetail(text: string): string {
  return text.length > ERROR_DETAIL_MAX ? text.slice(0, ERROR_DETAIL_MAX) : text;
}

// —— trie：单趟多密钥，最长完成匹配优先 ————————————————

type TrieNode = {
  children: Map<string, TrieNode>;
  /** 若本节点是某密钥终点，为其长度；否则 0 */
  endLen: number;
};

function buildTrie(secrets: string[]): TrieNode {
  const root: TrieNode = { children: new Map(), endLen: 0 };
  for (const secret of secrets) {
    if (!secret) continue;
    let node = root;
    // 与 feed 一致：按 UTF-16 码元建边（对齐 slice/历史 split 语义）
    for (let i = 0; i < secret.length; i++) {
      const ch = secret[i]!;
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map(), endLen: 0 };
        node.children.set(ch, next);
      }
      node = next;
    }
    if (secret.length > node.endLen) node.endLen = secret.length;
  }
  return root;
}

/** 从根走 pending；不可达返回 null。maxEnd=路径上最长终点；canExtend=仍有子边 */
function walkTrie(
  root: TrieNode,
  pending: string[],
): { maxEnd: number; canExtend: boolean } | null {
  let node = root;
  let maxEnd = 0;
  for (const ch of pending) {
    const next = node.children.get(ch);
    if (!next) return null;
    node = next;
    if (node.endLen > maxEnd) maxEnd = node.endLen;
  }
  return { maxEnd, canExtend: node.children.size > 0 };
}

/**
 * 单趟流式脱敏（纯脱敏，不含转义）。
 * |pending| ≤ L_max+1：再长必不可达 → resolveFailure 收缩；每次再 feed 前缓冲严格变短。
 */
export function streamRedact(text: string, secrets: string[]): string {
  const filtered = secrets.filter(Boolean);
  const root = buildTrie(filtered);
  // 无密钥：原文返回（兼容负控逐字节）
  if (filtered.length === 0) return text;

  let pending: string[] = [];
  let matchedEnd = 0;
  const out: string[] = [];
  const queue: string[] = [];

  function resolveFailure(extraChars: string[]): void {
    const body = pending;
    pending = [];
    const L = matchedEnd;
    matchedEnd = 0;
    if (L > 0) {
      out.push(REDACTED);
      for (let i = L; i < body.length; i++) queue.push(body[i]!);
      for (const ch of extraChars) queue.push(ch);
    } else if (body.length === 0) {
      // 已证非任何密钥首字符：字面产出，禁止重喂（防死循环）
      for (const ch of extraChars) out.push(ch);
    } else {
      out.push(body[0]!);
      for (let i = 1; i < body.length; i++) queue.push(body[i]!);
      for (const ch of extraChars) queue.push(ch);
    }
  }

  function feed(ch: string): void {
    pending.push(ch);
    const walked = walkTrie(root, pending);
    if (!walked) {
      pending.pop();
      resolveFailure([ch]);
      return;
    }
    matchedEnd = walked.maxEnd;
    // hold：已完成短钥但仍是更长钥真前缀
    if (matchedEnd > 0 && walked.canExtend) return;
    if (matchedEnd > 0) {
      out.push(REDACTED);
      pending = [];
      matchedEnd = 0;
      return;
    }
    // 仅真前缀：继续攒（|pending| ≤ L_max；再长必不可达）
  }

  function drainQueue(): void {
    while (queue.length > 0) {
      feed(queue.shift()!);
    }
  }

  for (let i = 0; i < text.length; i++) {
    queue.push(text[i]!);
    drainQueue();
  }

  // finish：先回落已完成匹配，再丢弃行尾真前缀（有意保守）
  if (matchedEnd > 0) {
    out.push(REDACTED);
    pending = pending.slice(matchedEnd);
    matchedEnd = 0;
  }
  if (pending.length > 0) {
    const stillPrefix = walkTrie(root, pending);
    if (stillPrefix) {
      // 仍是某密钥真前缀 ⇒ 丢弃，防半截泄漏
      pending = [];
    } else {
      for (const ch of pending) out.push(ch);
      pending = [];
    }
  }

  return out.join('');
}

/**
 * 纯脱敏薄包装（不含单行转义）。同一流式核心，禁止第二份 split/join 实现。
 */
export function redactSecrets(text: string, secrets: string[] = configuredSecrets()): string {
  return streamRedact(text, secrets);
}

// —— 单行转义（仅 describeFailure 末步）———————————————

/** C0 / U+0085 / U+2028 / U+2029 → 可读转义；不剥离、不截断 */
export function escapeLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) {
      out += '\\n';
    } else if (code === 0x0d) {
      out += '\\r';
    } else if (code === 0x09) {
      out += '\\t';
    } else if (code <= 0x1f || code === 0x85) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else if (code === 0x2028 || code === 0x2029) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += text[i]!;
    }
  }
  return out;
}

// —— 取串 / 哨兵 ————————————————————————————————

/** 安全读字符串字段；抛或缺席 ⇒ undefined */
function readStringField(obj: object, key: string): string | undefined {
  try {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 安全读 number 字段（如 responseCode） */
function readNumberField(obj: object, key: string): number | undefined {
  try {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 非 Error 类型化哨兵（沿用原 errorDetail 语义；禁止 String(err) 当主语义）。
 * 整串先有界。
 */
function nonErrorDetail(err: unknown): string {
  try {
    if (err === undefined) return '[non-error:undefined]';
    if (err === null) return '[non-error:null]';
    const t = typeof err;
    if (t === 'string') return truncateDetail(`[non-error:string:${err}]`);
    if (t === 'number') return truncateDetail(`[non-error:number:${err}]`);
    if (t === 'boolean') return `[non-error:boolean:${err}]`;
    if (t === 'bigint') return truncateDetail(`[non-error:bigint:${err}]`);
    if (t === 'symbol') return truncateDetail(`[non-error:symbol:${String(err)}]`);
    if (t === 'function') return '[non-error:function]';
    return '[non-error:object]';
  } catch {
    return '[unreadable]';
  }
}

/**
 * 日志/告警载荷唯一入口。
 *
 * - secrets === undefined → 使用配置中的邮件密码
 * - secrets === [] → 不脱敏
 * - 空串密钥过滤
 * - 永不抛；输出单行且有界（≤6020 可证）
 */
export function describeFailure(err: unknown, secrets?: string[]): string {
  try {
    const secretList = secrets === undefined ? configuredSecrets() : secrets;
    let line: string;

    try {
      if (err instanceof Error) {
        const parts: string[] = [];
        const code = readStringField(err, 'code');
        if (code) parts.push(truncateDetail(code));
        const rc = readNumberField(err, 'responseCode');
        if (rc !== undefined) parts.push(truncateDetail(String(rc)));
        // message 单独保护（会抛 getter → 该字段缺席）
        let message: string | undefined;
        try {
          const msg = err.message;
          if (typeof msg === 'string' && msg) message = truncateDetail(msg);
        } catch {
          message = undefined;
        }
        if (message) parts.push(message);

        if (parts.length > 0) {
          line = parts.join(' ');
        } else {
          // 三字段皆空：String(err) 先有界（R0 ④）
          try {
            line = truncateDetail(String(err));
          } catch {
            line = '[unreadable]';
          }
        }
      } else {
        line = nonErrorDetail(err);
      }
    } catch {
      line = '[unreadable]';
    }

    const redacted = streamRedact(line, secretList);
    return escapeLine(redacted);
  } catch {
    // 极端兜底：整条流水线不得逸出
    return '[unreadable]';
  }
}
