/**
 * 日志/告警载荷面：唯一组合原语 scrubPayload；三入口均走它。
 *
 * 发射路径（#348 / design.md R1–R9）：
 *   ① slice → ② redactField(原文族) → ③ escape(line|block)
 *   → ④ redactField(原文∪转义族)；需标则先削正文尾再挂 MARK 后脱敏并恢复固定 MARK
 *   → ⑤ slice（保 MARK）→ ⑦ containsAnySecret?
 *
 * 转义模式（显式，禁隐式耦合）：
 *   - `line`：LF/CR/TAB → `\\n`/`\\r`/`\\t`（串面单行不变量；盘文本默认）
 *   - `block`：保留 LF/CR/TAB 字面（对象面 stack 可读）
 *
 * LIMIT 语义：
 *   - 字符串面：`ERROR_DETAIL_MAX`（200）＝输入界；输出硬顶＝展开因子 2000。
 *   - 对象面：`DESCRIBE_FAILURE_STACK_MAX`（8204）＝输出顶；输入界＝8204−|MARK|
 *     （＝STACK_MAX 8192）。needsMark＝输入侧截断 || 输出侧截断。
 *   - 盘文本面：默认 limit=6002、mode=`line`（磁盘行前 100 字，走单行转义防日志注入）。
 *
 * 不变量：串面 join ≤6002 / 对象面 ≤8204；不含完整密钥；
 * 除本件固定截断标记外尾部非密钥真前缀（R9）；永不抛。
 * 对外错误码/状态码/body 不经本模块；errorCode 在 errors.ts，一字不动。
 */

import { config } from './config.ts';

/** 逐字段诊断文本上界（码元 / UTF-16 单位）＝字符串面 scrubPayload 的 LIMIT（输入界） */
export const ERROR_DETAIL_MAX = 200;

/** 字符串面可证输出上界：每字段 ≤2000，两空格 ⇒ ≤6002 */
export const DESCRIBE_FAILURE_MAX = 6002;

/**
 * 单字段输出可证上界（展开因子）：输入 ≤ERROR_DETAIL_MAX 时
 * 最坏 ≤200×max(6 `\uXXXX`, 10 `[redacted]`)=2000。
 * 串面以此为输出硬顶，防止「转义后再脱敏」复合膨胀破 join 上界。
 */
export const DESCRIBE_FAILURE_FIELD_MAX = 2000;

/** 对象面 stack 参考上界（历史 #344；标记预算见 DESCRIBE_FAILURE_STACK_MAX） */
export const STACK_MAX = 8192;

/**
 * 截断标记：在 escape 之后、第二遍 redact 之前并入（R1）。
 * 对象面 LIMIT＝STACK_MAX+|MARK|＝8204。
 */
const TRUNCATED_MARK = '…[truncated]';

/** 对象面可证最终输出上界（含标记长度）＝对象面 scrubPayload 的 LIMIT */
export const DESCRIBE_FAILURE_STACK_MAX = STACK_MAX + TRUNCATED_MARK.length; // 8204

/** 替换标记（不回喂自动机） */
const REDACTED = '[redacted]';

function configuredSecrets(): string[] {
  return [config.smtp.pass, config.imap.pass];
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
 * 单码元转义（与 escapeLine / escapeBlock 同判据）。
 * 供密钥前缀增量构造复用，避免对每个前缀整串再跑一遍 escape。
 */
function escapeCodeUnit(code: number, mode: ScrubEscapeMode): string {
  if (code === 0x0a) return mode === 'line' ? '\\n' : '\n';
  if (code === 0x0d) return mode === 'line' ? '\\r' : '\r';
  if (code === 0x09) return mode === 'line' ? '\\t' : '\t';
  if (needsUnicodeEscape(code)) return unicodeEscape(code);
  return String.fromCharCode(code);
}

/**
 * 单行转义：LF/CR/TAB → `\\n`/`\\r`/`\\t`；其余 needsUnicodeEscape → `\uXXXX`。
 * 不剥离、不截断。保留导出供测试/历史对照；发射路径请走 scrubPayload。
 */
export function escapeLine(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += escapeCodeUnit(text.charCodeAt(i), 'line');
  }
  return out;
}

/**
 * 多行块转义：与 escapeLine 同一 needsUnicodeEscape 判据，
 * 但【保留 \\n / \\r / \\t 字面】——对象面 block 模式所用。
 */
export function escapeBlock(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += escapeCodeUnit(text.charCodeAt(i), 'block');
  }
  return out;
}

/** 转义模式：line＝单行（串面/盘文本）；block＝保换行（对象面） */
export type ScrubEscapeMode = 'line' | 'block';

// —— scrubPayload 附属小件（R2 / R4 / R8 / R9）—————————————————

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

/** 密钥在转义后域的预计算结果（R9：每钥只转义一次） */
type SecretEscapePrep = {
  raw: string;
  /** escape(raw)，一次性构造 */
  esc: string;
};

/**
 * 预计算每个密钥的转义整串。
 * 复杂度：Σ O(|s|)——逐码元 escapeCodeUnit + join；**禁止**对每个前缀再跑 escape（原为 O(|s|²)）。
 */
function prepareSecretEscapePreps(
  secrets: string[],
  mode: ScrubEscapeMode,
): SecretEscapePrep[] {
  const preps: SecretEscapePrep[] = [];
  for (const s of secrets) {
    if (!s || s.length < 2) continue;
    const pieces = new Array<string>(s.length);
    for (let i = 0; i < s.length; i++) {
      pieces[i] = escapeCodeUnit(s.charCodeAt(i), mode);
    }
    preps.push({ raw: s, esc: pieces.join('') });
  }
  return preps;
}

/**
 * 转义后判定用的密钥族：原文 ∪ 预计算转义整钥。
 * 仅用于 ④ 第二遍脱敏与 ⑦ 完整密钥检查；② 第一遍仍只用原文族。
 */
function secretsForPostEscape(
  secrets: string[],
  preps: SecretEscapePrep[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of secrets) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  for (const p of preps) {
    if (p.esc && !seen.has(p.esc)) {
      seen.add(p.esc);
      out.push(p.esc);
    }
  }
  return out;
}

/**
 * 剥掉尾部转义记号后，正文是否以某密钥原文真前缀结尾。
 * 匹配长度上限为 peeled.length（与口令全长无关）⇒ 单次 O(Σ min(|s|,|peeled|))。
 */
function peeledExposesRawSecretPrefix(
  peeled: string,
  preps: SecretEscapePrep[],
): boolean {
  if (!peeled) return false;
  for (const { raw } of preps) {
    const maxLen = Math.min(raw.length - 1, peeled.length);
    for (let len = 1; len <= maxLen; len++) {
      if (peeled.endsWith(raw.slice(0, len))) return true;
    }
  }
  return false;
}

/**
 * 正文尾部最长「密钥真前缀」匹配长度（原文或转义整钥的真前缀）。
 * 只检查长度 ≤ |out| 的候选 ⇒ 与口令全长解耦，避免 O(|s|²)。
 */
function longestPostEscapePrefixLen(
  out: string,
  preps: SecretEscapePrep[],
): number {
  let longest = 0;
  for (const { raw, esc } of preps) {
    const maxRaw = Math.min(raw.length - 1, out.length);
    for (let len = 1; len <= maxRaw; len++) {
      if (out.endsWith(raw.slice(0, len)) && len > longest) longest = len;
    }
    const maxEsc = Math.min(esc.length - 1, out.length);
    for (let len = 1; len <= maxEsc; len++) {
      if (out.endsWith(esc.slice(0, len)) && len > longest) longest = len;
    }
  }
  return longest;
}

/**
 * R8/R9：在**正文**上做转义后尾部回退（不含本件固定截断标记）。
 *
 * 不变量（R9 精化）：输出不含任何完整密钥；且**除本件固定截断标记外**，
 * 输出尾部不构成任何密钥真前缀。标记是发射路径写入的已知固定串，不承载载荷，
 * 不得当作载荷尾部来削（否则会破坏「已截断」指示，见口令 `ted]xyz` 反例）。
 */
function trimTrailingSecretPrefixAfterEscape(
  text: string,
  preps: SecretEscapePrep[],
): string {
  let out = text;
  const maxSteps = text.length + 8;
  let steps = 0;
  while (out.length > 0 && steps++ < maxSteps) {
    const longest = longestPostEscapePrefixLen(out, preps);
    if (longest > 0) {
      out = out.slice(0, -longest);
      continue;
    }

    const escTok = /(\\n|\\r|\\t|\\u[0-9a-fA-F]{4})$/.exec(out);
    if (escTok) {
      const peeled = out.slice(0, -escTok[1]!.length);
      if (peeledExposesRawSecretPrefix(peeled, preps)) {
        out = peeled;
        continue;
      }
    }
    const last = out.length > 0 ? out.charCodeAt(out.length - 1) : -1;
    if (last === 0x0a || last === 0x0d || last === 0x09) {
      const peeled = out.slice(0, -1);
      if (peeledExposesRawSecretPrefix(peeled, preps)) {
        out = peeled;
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * R9：从可能被 J4 啃过的串上恢复本件固定截断标记。
 * - 若已以完整 MARK 结尾：只对正文做尾前缀回退，再挂回 MARK
 * - 否则：去掉尾部「MARK 的真前缀」残段（J4 丢掉的后缀），正文回退后挂回完整 MARK
 */
function restoreFixedTruncationMark(
  text: string,
  markLen: number,
  outputCap: number,
  preps: SecretEscapePrep[],
): string {
  let body = text;
  if (body.endsWith(TRUNCATED_MARK)) {
    body = body.slice(0, body.length - markLen);
  } else {
    // 去掉 MARK 真前缀残段（最长优先）
    for (let len = markLen - 1; len >= 1; len--) {
      if (body.endsWith(TRUNCATED_MARK.slice(0, len))) {
        body = body.slice(0, -len);
        break;
      }
    }
  }
  body = trimTrailingSecretPrefixAfterEscape(body, preps);
  const bodyBudget = Math.max(0, outputCap - markLen);
  if (body.length > bodyBudget) {
    body = body.slice(0, bodyBudget).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
    body = trimTrailingSecretPrefixAfterEscape(body, preps);
  }
  return body + TRUNCATED_MARK;
}

/**
 * 唯一组合原语（#348）：三入口共用发射路径。
 *
 *   ① b = slice(text, inputLimit)
 *   ② r = redactField(b, secrets)          // 原文密钥族
 *   ③ t = escapeLine|escapeBlock(r)
 *   ④ postSecrets = secrets ∪ escape(secrets)；uProbe = redactField(t, postSecrets)
 *      needsMark 按最终长度重算；
 *      若需标：**先**在正文上尾部回退，**再**追加 MARK，然后 redactField（R1+R9）
 *   ⑤ v = slice(u, outputCap)              // 不得吃掉完整 MARK
 *   ⑥ 无标：对全文尾部回退；有标：只回退正文再挂回 MARK（标记无条件保留）
 *   ⑦ if containsAnySecret(w, postSecrets): return ''
 *   return w
 *
 * @param limit 见文件头 LIMIT 语义
 * @param mode  `line`（默认：串面/盘文本）| `block`（对象面）——显式，不靠 limit 魔数分面
 */
export function scrubPayload(
  text: string,
  secrets: string[] = configuredSecrets(),
  limit: number = DESCRIBE_FAILURE_MAX,
  mode: ScrubEscapeMode = 'line',
): string {
  try {
    const secretList = secrets.filter(Boolean);
    const markLen = TRUNCATED_MARK.length;
    const isLine = mode === 'line';
    // R9：每钥 O(|s|) 预计算转义整串，供 ④⑦ 与尾部回退复用
    const secretPreps = prepareSecretEscapePreps(secretList, mode);
    const postSecrets = secretsForPostEscape(secretList, secretPreps);
    const escapeFn = isLine ? escapeLine : escapeBlock;

    // ① 输入有界：line＝limit；block＝limit−|MARK|（为标记预留）
    const inputLimit = isLine ? limit : Math.max(0, limit - markLen);
    const truncatedAtInput = text.length > inputLimit;
    const b = truncatedAtInput ? text.slice(0, inputLimit) : text;

    // ② 第一遍：清原文中的完整密钥（只用原文族，避免误伤）
    const r = redactField(b, secretList);

    // ③ 转义（显式 mode；可能生成密钥文本形态）
    const t = escapeFn(r);

    // 输出硬顶：line → 展开因子 2000；block → limit（8204）
    const outputCap = isLine ? DESCRIBE_FAILURE_FIELD_MAX : limit;

    // ④ 第二遍脱敏用 postSecrets；needsMark 按探针后长度重算（R5）
    const uProbe = redactField(t, postSecrets);
    const truncatedAtOutput = t.length > outputCap || uProbe.length > outputCap;
    const needsMark = !isLine && (truncatedAtInput || truncatedAtOutput);

    let u: string;
    if (needsMark) {
      const bodyBudget = Math.max(0, outputCap - markLen);
      let body = t.length > bodyBudget ? t.slice(0, bodyBudget) : t;
      // Codex P2：剔半个 `\uXXXX` / 孤立 `\`
      body = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
      // R9：先在正文上满足尾前缀不变量，再追加固定标记（标记不参与削尾）
      body = trimTrailingSecretPrefixAfterEscape(body, secretPreps);
      // 最后一次脱敏：主体 + MARK 一并管辖（R1）；标记=整钥时由 R4 空串兜底
      u = redactField(body + TRUNCATED_MARK, postSecrets);
      // R9：J4 可能把标记后缀（恰为某密钥真前缀，如 ted]）当域尾丢掉。
      // 固定标记无条件恢复；整钥=标记的情形仍由 ⑦ containsAnySecret → ''。
      u = restoreFixedTruncationMark(u, markLen, outputCap, secretPreps);
    } else {
      u = trimTrailingSecretPrefixAfterEscape(uProbe, secretPreps);
    }

    // ⑤ 最终上界；有标时保完整 MARK
    let v = u;
    if (v.length > outputCap) {
      if (v.endsWith(TRUNCATED_MARK) && outputCap >= markLen) {
        let body = v.slice(0, v.length - markLen);
        const bodyBudget = outputCap - markLen;
        if (body.length > bodyBudget) body = body.slice(0, bodyBudget);
        body = body.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
        body = trimTrailingSecretPrefixAfterEscape(body, secretPreps);
        v = body + TRUNCATED_MARK;
      } else {
        v = v.slice(0, outputCap).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
        if (!needsMark) {
          v = trimTrailingSecretPrefixAfterEscape(v, secretPreps);
        } else {
          v = restoreFixedTruncationMark(v, markLen, outputCap, secretPreps);
        }
      }
    }

    const w = v;

    // ⑦ R4 后置检查：原文或转义整钥仍在 ⇒ 空串兜底
    if (containsAnySecret(w, postSecrets)) return '';
    return w;
  } catch {
    // 发射路径永不抛；极端失败视同不可读 → 空串（与 R4 同形、无密钥）
    return '';
  }
}

/** 串面/盘文本薄封装：显式 line 模式 */
export function scrubLinePayload(
  text: string,
  secrets: string[] = configuredSecrets(),
  limit: number = DESCRIBE_FAILURE_MAX,
): string {
  return scrubPayload(text, secrets, limit, 'line');
}

/** 对象面薄封装：显式 block 模式 */
export function scrubBlockPayload(
  text: string,
  secrets: string[] = configuredSecrets(),
  limit: number = DESCRIBE_FAILURE_STACK_MAX,
): string {
  return scrubPayload(text, secrets, limit, 'block');
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
 * 对单字段跑 scrubPayload：LIMIT＝ERROR_DETAIL_MAX（输入界 200），mode＝line。
 * join 之前调用，保证禁止跨字段匹配（J1）；展开因子 ⇒ 每字段 ≤2000 ⇒ join ≤6002。
 */
function processField(raw: string, secrets: string[]): string {
  return scrubLinePayload(raw, secrets, ERROR_DETAIL_MAX);
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
    // 对象面：显式 block 模式（保换行）；LIMIT＝8204
    return scrubBlockPayload(raw, secretList, DESCRIBE_FAILURE_STACK_MAX);
  } catch {
    return '[unreadable]';
  }
}
