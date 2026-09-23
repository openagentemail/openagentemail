/**
 * 日志/告警载荷面：唯一组合原语 scrubPayload；三入口均走它。
 *
 * 发射路径（#348 / design.md R1–R4）：
 *   ① slice(LIMIT) → ② redactField → ③ escapeBlock → ④ redactField(+MARK)
 *   → ⑤ slice(LIMIT) → ⑥ trimTrailingSecretPrefix → ⑦ containsAnySecret? '' : w
 *
 * 入口：
 *   - 字符串面 describeFailure：逐字段 truncate(200) → scrubPayload(LIMIT=6002) → join(' ')
 *   - 对象面 describeFailureStack：取 stack / 回退文本 → scrubPayload(LIMIT=8204)
 *   - 盘文本面：直接 scrubPayload（禁止 escapeLine 与 redactSecrets 手工嵌套直连）
 *
 * 不变量：|out|≤LIMIT；不含完整密钥；尾部非真前缀；永不抛。
 * 对外错误码/状态码/body 不经本模块；errorCode 在 errors.ts，一字不动。
 */

import { config } from './config.ts';

/** 逐字段诊断文本上界（码元 / UTF-16 单位，与历史 ERROR_DETAIL_MAX 一致） */
export const ERROR_DETAIL_MAX = 200;

/** 字符串面可证输出上界：每字段 ≤2000，两空格 ⇒ ≤6002 */
export const DESCRIBE_FAILURE_MAX = 6002;

/** 单字段经 scrubPayload 后上界（历史：200 码元最坏膨胀至 ≤2000） */
export const DESCRIBE_FAILURE_FIELD_MAX = 2000;

/** 对象面 stack 输入有界（码元；#344 裁点） */
export const STACK_MAX = 8192;

/**
 * 截断标记：在 escape 之后、第二遍 redact 之前并入，使「标记恰等于口令」也被脱敏管辖。
 * 对象面 LIMIT = STACK_MAX + 标记长 = 8204。
 */
const TRUNCATED_MARK = '…[truncated]';

/** 对象面可证最终输出上界（含标记长度） */
export const DESCRIBE_FAILURE_STACK_MAX = STACK_MAX + TRUNCATED_MARK.length; // 8204

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
 * 纯脱敏薄包装（不含转义）。同一域原语，禁止第二份 split/join 实现。
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
 * 不剥离、不截断。保留导出供测试/历史对照；发射路径请走 scrubPayload。
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
 * 多行块转义：与 escapeLine 同一 needsUnicodeEscape 判据，
 * 但【保留 \\n / \\r / \\t 字面】——对象面 / 盘文本 / scrubPayload 所用。
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

// —— scrubPayload 附属小件（R2 / R4）—————————————————

/**
 * 输出是否含任一完整密钥（子串）。空串密钥忽略。
 */
export function containsAnySecret(text: string, secrets: string[]): boolean {
  for (const s of secrets) {
    if (!s) continue;
    if (text.includes(s)) return true;
  }
  return false;
}

/**
 * 尾部是否为任一密钥的非空真前缀（不含完整密钥本身）。
 * 单字符密钥无非空真前缀 ⇒ 永不触发。
 */
function hasSecretProperPrefixTail(text: string, secrets: string[]): boolean {
  for (const s of secrets) {
    if (!s || s.length < 2) continue;
    for (let len = 1; len < s.length; len++) {
      if (text.endsWith(s.slice(0, len))) return true;
    }
  }
  return false;
}

/**
 * R2：尾部单调回退至「非任何密钥真前缀」。
 * 终止性：每次至少去掉 1 码元 ⇒ 必终止。
 */
export function trimTrailingSecretPrefix(text: string, secrets: string[]): string {
  let out = text;
  while (out.length > 0 && hasSecretProperPrefixTail(out, secrets)) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * 唯一组合原语（#348）：三入口共用发射路径。
 *
 *   ① b = slice(text, inputLimit)
 *   ② r = redactField(b, secrets)
 *   ③ t = escapeBlock(r)
 *   ④ u = redactField(t + MARK_if_truncated, secrets)
 *   ⑤ v = slice(u, outputLimit)     // Codex P2：剔半个 `\uXXXX`
 *   ⑥ w = trimTrailingSecretPrefix(v, secrets)
 *   ⑦ if containsAnySecret(w): return ''   // R4 兜底＝空串
 *   return w
 *
 * @param outputLimit 最终输出上界（字符串面字段 2000 / 整串 6002 / 对象面 8204）
 * @param inputLimit  输入有界（对象面用 STACK_MAX=8192，使标记能落在 8204 输出预算内；默认＝outputLimit）
 */
export function scrubPayload(
  text: string,
  secrets: string[] = configuredSecrets(),
  outputLimit: number = DESCRIBE_FAILURE_MAX,
  inputLimit: number = outputLimit,
): string {
  try {
    const secretList = secrets.filter(Boolean);

    // ① 输入先有界（约束 CPU；对象面 inputLimit=8192 < outputLimit=8204 以保留标记位）
    const truncatedAtInput = text.length > inputLimit;
    const b = truncatedAtInput ? text.slice(0, inputLimit) : text;

    // ② 第一遍：清原文中的完整密钥
    const r = redactField(b, secretList);

    // ③ 转义（可能生成密钥文本形态）
    const t = escapeBlock(r);

    // ④ 标记并入后第二遍脱敏（转义生成者 + 标记恰等于口令）
    const needsMark = truncatedAtInput || t.length > outputLimit;
    const withMark = needsMark ? t + TRUNCATED_MARK : t;
    const u = redactField(withMark, secretList);

    // ⑤ 最终上界；截断点落在 `\uXXXX` 内时去掉残段（含孤立 `\`，Codex P2）
    let v = u;
    if (v.length > outputLimit) {
      v = v.slice(0, outputLimit).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
    }

    // ⑥ 尾部单调回退至非真前缀（只删不增）
    const w = trimTrailingSecretPrefix(v, secretList);

    // ⑦ R4 后置检查：不满足 ⇒ 空串兜底（不迭代替换）
    if (containsAnySecret(w, secretList)) return '';
    return w;
  } catch {
    // 发射路径永不抛；极端失败视同不可读 → 空串（与 R4 同形、无密钥）
    return '';
  }
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
 * 对单字段跑 scrubPayload（先有界 200；字段输出上界 2000）。
 * join 之前调用，保证禁止跨字段匹配（J1）；三字段+两空格 ⇒ ≤6002。
 */
function processField(raw: string, secrets: string[]): string {
  return scrubPayload(truncateDetail(raw), secrets, DESCRIBE_FAILURE_FIELD_MAX);
}

/**
 * 非 Error 类型化哨兵（沿用原 errorDetail 语义；禁止 String(err) 当主语义）。
 * 整串先有界（由 processField / scrubPayload 统一做）。
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
 * 字符串面入口：逐字段 scrubPayload 后 join（J1 独立域）。
 *
 * - secrets === undefined → 使用配置中的邮件密码
 * - secrets === [] → 不脱敏
 * - 空串密钥过滤
 * - 永不抛；输出有界（≤6002 可证，J9）
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
 * 对象面入口：保住 stack（多行）同时有界 + 脱敏 + 永不抛。
 *
 * stack 缺席/非串/空/会抛 ⇒ 取 describeFailure 单行文本为 raw，**仍走 scrubPayload**
 * （不得直接返回 describeFailure——否则绕过统一流水线的后置检查）。
 */
export function describeFailureStack(err: unknown, secrets?: string[]): string {
  try {
    const secretList = secrets === undefined ? configuredSecrets() : secrets;

    // 取串（永不抛）：err.stack 为非空字符串 ⇒ 用它；否则退化为 describeFailure 文本
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

    const raw = stackText !== undefined ? stackText : describeFailure(err, secrets);
    // 输入有界 STACK_MAX=8192；输出有界 8204（为截断标记留位）
    return scrubPayload(raw, secretList, DESCRIBE_FAILURE_STACK_MAX, STACK_MAX);
  } catch {
    return '[unreadable]';
  }
}
