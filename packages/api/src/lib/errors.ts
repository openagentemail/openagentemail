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

/** 日志/告警载荷诊断文本截断上限（码点） */
const ERROR_DETAIL_MAX = 200;

/**
 * 按码点截断到 N=200，避免切裂代理对；不抛。
 */
function truncateDetail(text: string): string {
  const chars = Array.from(text);
  return chars.length > ERROR_DETAIL_MAX ? chars.slice(0, ERROR_DETAIL_MAX).join('') : text;
}

/**
 * 控制字符转义（不剥离）：保证输出单行。
 * `\n`→`\\n`、`\r`→`\\r`、`\t`→`\\t`，其余 C0（U+0000–U+001F）→`\\uXXXX`。
 */
function escapeControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0d) out += '\\r';
    else if (cp === 0x09) out += '\\t';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out;
}

/** 转义后按码点截断；供 errorDetail 所有成功路径统一收口 */
function finalizeDetail(text: string): string {
  return truncateDetail(escapeControlChars(text));
}

/**
 * 日志/告警载荷用：从未知值安全取出可诊断文本。
 *
 * - `Error` ⇒ `.message`（转义控制符后截断至 200 码点）
 * - duck 对象带字符串 `message` ⇒ `[non-error:object:<msg>]`（来源可辨）
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
        return finalizeDetail(typeof msg === 'string' ? msg : String(msg));
      } catch {
        return '[unreadable]';
      }
    }
    if (err === undefined) return '[non-error:undefined]';
    if (err === null) return '[non-error:null]';
    const t = typeof err;
    if (t === 'string') return finalizeDetail(`[non-error:string:${err}]`);
    if (t === 'number') return finalizeDetail(`[non-error:number:${err}]`);
    if (t === 'boolean') return `[non-error:boolean:${err}]`;
    if (t === 'bigint') return finalizeDetail(`[non-error:bigint:${err}]`);
    if (t === 'symbol') return finalizeDetail(`[non-error:symbol:${String(err)}]`);
    if (t === 'function') return '[non-error:function]';
    // object：在类型化回退之前先读字符串 message（与 errorCode 同款守卫）
    try {
      const raw = (err as { message?: unknown } | null | undefined)?.message;
      if (typeof raw === 'string') {
        return finalizeDetail(`[non-error:object:${raw}]`);
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
