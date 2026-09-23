/**
 * 日志/告警载荷面：字符串入口 describeFailure；对象面（保 stack）入口 describeFailureStack。
 *
 * B 形态流水线（design-b.md / #344 R0）：
 *   字符串面：逐字段 取串 → 有界(200) → redactField → escapeLine → join(' ')
 *   对象面：取 stack → 有界(STACK_MAX) → redactField（整段单域）→ escapeBlock → 截断标记
 * 不变量 J1–J9；对外错误码/状态码/body 不经本模块；errorCode 在 errors.ts，一字不动。
 */

import { config } from './config.ts';

/** 逐字段诊断文本上界（码元 / UTF-16 单位，与历史 ERROR_DETAIL_MAX 一致） */
export const ERROR_DETAIL_MAX = 200;

/** B 形态可证输出上界：每字段 ≤2000，两空格 ⇒ ≤6002 */
export const DESCRIBE_FAILURE_MAX = 6002;

/** 对象面 stack 文本上界（码元 / UTF-16 单位；#344 裁点 STACK_MAX=8192） */
export const STACK_MAX = 8192;

/** 截断后追加的固定标记（脱敏之后追加；标记本身不含密钥） */
const TRUNCATED_MARK = '…[truncated]';

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
 * 域原语：单字段匹配域内脱敏（J3+J4+J5）。
 * - 最长密钥优先 + hold
 * - 重放保序（队首插入，J5）
 * - 域尾：先对已成匹配发 [redacted]，余部一律丢弃（J4，永不字面倾倒）
 * |pending| ≤ L_max+1：再长必不可达 → resolveFailure 收缩；每次再 feed 前缓冲严格变短。
 */
export function redactField(text: string, secrets: string[]): string {
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
    // J5：回放块插到队首，保证原文更早字符先于队列残余
    const prependReplay = (chars: string[]) => {
      if (chars.length === 0) return;
      queue.unshift(...chars);
    };
    if (L > 0) {
      out.push(REDACTED);
      prependReplay(body.slice(L).concat(extraChars));
    } else if (body.length === 0) {
      // 已证非任何密钥首字符：字面产出，禁止重喂（防死循环）
      for (const ch of extraChars) out.push(ch);
    } else {
      out.push(body[0]!);
      prependReplay(body.slice(1).concat(extraChars));
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

  // J4 域尾：已成匹配发 [redacted]；余部（含真前缀）一律丢弃，永不字面倾倒
  if (matchedEnd > 0) {
    out.push(REDACTED);
  }
  pending = [];
  matchedEnd = 0;

  return out.join('');
}

/**
 * 历史名：与 redactField 同域原语（单域语义）。
 * 新代码请用 redactField；保留以免测试/调用方断裂。
 */
export function streamRedact(text: string, secrets: string[]): string {
  return redactField(text, secrets);
}

/**
 * 纯脱敏薄包装（不含单行转义）。同一域原语，禁止第二份 split/join 实现。
 */
export function redactSecrets(text: string, secrets: string[] = configuredSecrets()): string {
  return redactField(text, secrets);
}

// —— 转义（escapeLine / escapeBlock 同源判据，禁止复制第二份）———————————————

/**
 * 同源转义判据：除 LF/CR/TAB 外是否需写成 `\uXXXX`。
 * C0（其余）/ DEL+C1(U+007F–U+009F) / U+2028·U+2029 /
 * bidi U+202A–U+202E、U+2066–U+2069。
 * LF/CR/TAB 由 escapeLine（写成 \\n/\\r/\\t）与 escapeBlock（保留字面）各自处理。
 */
function needsUnicodeEscape(code: number): boolean {
  if (code === 0x0a || code === 0x0d || code === 0x09) return false;
  if (code <= 0x1f) return true; // 其余 C0
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1（含 NEL/CSI）
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true; // bidi 嵌入/覆盖
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolate
  return false;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * 单行转义：LF/CR/TAB → `\\n`/`\\r`/`\\t`；其余 needsUnicodeEscape → `\uXXXX`。
 * 不剥离、不截断。
 */
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
    } else if (needsUnicodeEscape(code)) {
      out += unicodeEscape(code);
    } else {
      out += text[i]!;
    }
  }
  return out;
}

/**
 * 多行块转义（#344）：与 escapeLine 同一 needsUnicodeEscape 判据，
 * 但【保留 \\n / \\r / \\t 字面】——stack 可用性所在。
 */
export function escapeBlock(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x09) {
      out += text[i]!; // 保留换行/回车/制表字面
    } else if (needsUnicodeEscape(code)) {
      out += unicodeEscape(code);
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
 * 对单字段跑完整 B 流水线：有界 → 域内脱敏 → 转义。
 * join 之前调用，保证禁止跨字段匹配（J1）。
 */
function processField(raw: string, secrets: string[]): string {
  return escapeLine(redactField(truncateDetail(raw), secrets));
}

/**
 * 非 Error 类型化哨兵（沿用原 errorDetail 语义；禁止 String(err) 当主语义）。
 * 整串先有界（由 processField 统一做）。
 */
function nonErrorDetail(err: unknown): string {
  try {
    if (err === undefined) return '[non-error:undefined]';
    if (err === null) return '[non-error:null]';
    const t = typeof err;
    if (t === 'string') return `[non-error:string:${err}]`;
    if (t === 'number') return `[non-error:number:${err}]`;
    if (t === 'boolean') return `[non-error:boolean:${err}]`;
    if (t === 'bigint') return `[non-error:bigint:${err}]`;
    if (t === 'symbol') return `[non-error:symbol:${String(err)}]`;
    if (t === 'function') return '[non-error:function]';
    return '[non-error:object]';
  } catch {
    return '[unreadable]';
  }
}

/**
 * 日志/告警载荷唯一入口（B 形态）。
 *
 * - secrets === undefined → 使用配置中的邮件密码
 * - secrets === [] → 不脱敏
 * - 空串密钥过滤
 * - 永不抛；输出单行且有界（≤6002 可证，J9）
 */
export function describeFailure(err: unknown, secrets?: string[]): string {
  try {
    const secretList = secrets === undefined ? configuredSecrets() : secrets;
    const parts: string[] = [];

    try {
      if (err instanceof Error) {
        const code = readStringField(err, 'code');
        if (code) parts.push(processField(code, secretList));
        const rc = readNumberField(err, 'responseCode');
        if (rc !== undefined) parts.push(processField(String(rc), secretList));
        // message 单独保护（会抛 getter → 该字段缺席）
        let message: string | undefined;
        try {
          const msg = err.message;
          if (typeof msg === 'string' && msg) message = msg;
        } catch {
          message = undefined;
        }
        if (message) parts.push(processField(message, secretList));

        if (parts.length === 0) {
          // 三字段皆空：String(err) 作单域兜底（J2 一视同仁）
          try {
            return processField(String(err), secretList);
          } catch {
            return '[unreadable]';
          }
        }
      } else {
        return processField(nonErrorDetail(err), secretList);
      }
    } catch {
      return '[unreadable]';
    }

    // J1：join 在脱敏之后；禁止跨字段匹配
    return parts.join(' ');
  } catch {
    // 极端兜底：整条流水线不得逸出
    return '[unreadable]';
  }
}

/**
 * 对象面唯一入口（#344）：保住 stack（多行）同时有界 + 脱敏 + 永不抛。
 *
 * 流水线：取 stack 串 → 有界 STACK_MAX → redactField（整段单域）→ escapeBlock
 * → 若截断则尾部追加 `…[truncated]`（脱敏之后）。
 * stack 缺席/非串/空/会抛 ⇒ 退化为 describeFailure 单行文本。
 */
export function describeFailureStack(err: unknown, secrets?: string[]): string {
  try {
    const secretList = secrets === undefined ? configuredSecrets() : secrets;

    // 1) 取串（永不抛）：err.stack 为非空字符串 ⇒ 用它；否则退化
    let stackText: string | undefined;
    try {
      if (err instanceof Error) {
        try {
          const s = err.stack;
          if (typeof s === 'string' && s.length > 0) stackText = s;
        } catch {
          stackText = undefined;
        }
      }
    } catch {
      stackText = undefined;
    }

    if (stackText === undefined) {
      return describeFailure(err, secrets);
    }

    // 2) 先有界
    const didTruncate = stackText.length > STACK_MAX;
    const bounded = didTruncate ? stackText.slice(0, STACK_MAX) : stackText;

    // 3) 域内脱敏（整段 stack 含换行＝单域；密钥含 \n 亦可匹配）
    const redacted = redactField(bounded, secretList);

    // 4) 转义（保留 \n/\r/\t 字面）
    let out = escapeBlock(redacted);

    // 5) 截断标记在脱敏之后追加（标记不含密钥）
    if (didTruncate) out += TRUNCATED_MARK;

    return out;
  } catch {
    return '[unreadable]';
  }
}
