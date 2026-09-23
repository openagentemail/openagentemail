/**
 * 从未知 rejection 安全取出错误码字符串。
 *
 * 哨兵值：`''`（空串）——与 `routes/tasks.ts` 历史守卫
 * `typeof raw === 'string' ? raw : ''` 逐字节同语义。
 *
 * - `err` 为 `Error`，或任意带字符串 `message` 的对象 ⇒ 返回该 `message`
 * - 非 Error / `undefined` / `null` / 数字 / 无字符串 message 的对象 ⇒ 返回 `''`
 * - 永不抛异常（含会抛的 `message` getter / revoked Proxy 等取值失败；
 *   一律返回哨兵，供 catch 映射器使用，避免逸出成 app 级 500）
 */
export function errorCode(err: unknown): string {
  // try/catch 包住属性读取：?. 只短路 nullish，不挡会抛的 getter / revoked Proxy
  try {
    const raw = (err as { message?: unknown } | null | undefined)?.message;
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/** 日志/告警载荷诊断文本截断上限（输出码点） */
export const ERROR_DETAIL_MAX = 200;

/** 单趟取前 n 个码点；不物化超量尾部 */
function takeCodePoints(text: string, n: number): string {
  if (n <= 0) return '';
  let out = '';
  let c = 0;
  for (const ch of text) {
    if (c >= n) break;
    out += ch;
    c += 1;
  }
  return out;
}

/**
 * 单趟有界化：边遍历边转义控制/行分隔符，收集满 N 个**输出**码点即停。
 *
 * - 不 `Array.from(整串)`、不先整串拼接再截断 ⇒ 多兆输入下内存/时间有界
 * - `\n`/`\r`/`\t` → `\\n`/`\\r`/`\\t`；其余 C0、U+0085、U+2028、U+2029 → `\\uXXXX`
 * - **永不抛**（取值/遍历异常 ⇒ `[unreadable]`）
 *
 * 供 `errorDetail` 与路由 warn（先有界脱敏后再调用）复用。
 */
export function boundDetail(text: string, max: number = ERROR_DETAIL_MAX): string {
  try {
    let out = '';
    let n = 0;
    for (const ch of text) {
      if (n >= max) break;
      const cp = ch.codePointAt(0)!;
      let piece: string;
      if (cp === 0x0a) piece = '\\n';
      else if (cp === 0x0d) piece = '\\r';
      else if (cp === 0x09) piece = '\\t';
      else if (cp < 0x20 || cp === 0x85 || cp === 0x2028 || cp === 0x2029) {
        piece = '\\u' + cp.toString(16).padStart(4, '0');
      } else {
        piece = ch;
      }
      // 按输出码点计数（转义串可能 >1）；空间不足时切在码点边界
      for (const p of piece) {
        if (n >= max) break;
        out += p;
        n += 1;
      }
    }
    return out;
  } catch {
    return '[unreadable]';
  }
}

/**
 * 日志/告警载荷用：从未知值安全取出可诊断文本。
 *
 * - `Error` ⇒ `.message`（转义控制符后截断至 200 码点）
 * - duck 对象带字符串 `message` ⇒ `[non-error:object:<msg>]`（来源可辨；msg 先有界再拼接）
 * - 其它非 Error ⇒ 类型化文本（如 `[non-error:undefined]`），永不空
 * - 取值失败（会抛的 message getter / revoked Proxy）⇒ `[unreadable]`
 * - **永不抛异常**（与 `errorCode` 不同：本函数只供日志/告警，不参与路由映射）
 */
export function errorDetail(err: unknown): string {
  try {
    if (err instanceof Error) {
      // message 可能是会抛的 getter；单独保护
      try {
        const msg = err.message;
        return boundDetail(typeof msg === 'string' ? msg : String(msg));
      } catch {
        return '[unreadable]';
      }
    }
    if (err === undefined) return '[non-error:undefined]';
    if (err === null) return '[non-error:null]';
    const t = typeof err;
    // 嵌入正文前先 takeCodePoints，避免模板插值物化多兆串
    if (t === 'string') return boundDetail(`[non-error:string:${takeCodePoints(err, ERROR_DETAIL_MAX)}]`);
    if (t === 'number') return boundDetail(`[non-error:number:${err}]`);
    if (t === 'boolean') return `[non-error:boolean:${err}]`;
    if (t === 'bigint') return boundDetail(`[non-error:bigint:${err}]`);
    if (t === 'symbol') return boundDetail(`[non-error:symbol:${takeCodePoints(String(err), ERROR_DETAIL_MAX)}]`);
    if (t === 'function') return '[non-error:function]';
    // object：在类型化回退之前先读字符串 message（与 errorCode 同款守卫）
    try {
      const raw = (err as { message?: unknown } | null | undefined)?.message;
      if (typeof raw === 'string') {
        return boundDetail(`[non-error:object:${takeCodePoints(raw, ERROR_DETAIL_MAX)}]`);
      }
    } catch {
      // 取值失败仍回退类型文本（不升为 [unreadable]——外层仍可辨为 object）
    }
    return '[non-error:object]';
  } catch {
    // instanceof / typeof 等极端失败（如 revoked Proxy）
    return '[unreadable]';
  }
}
