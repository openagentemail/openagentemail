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

/** 日志/告警载荷诊断文本截断上限（字符） */
const ERROR_DETAIL_MAX = 200;

/** 安全截断到 N=200，不抛 */
function truncateDetail(text: string): string {
  return text.length > ERROR_DETAIL_MAX ? text.slice(0, ERROR_DETAIL_MAX) : text;
}

/**
 * 日志/告警载荷用：从未知值安全取出可诊断文本。
 *
 * - `Error` ⇒ `.message`（截断至 200）
 * - 非 Error ⇒ 类型化文本（如 `[non-error:undefined]`），永不空
 * - 取值失败（会抛的 message getter / revoked Proxy）⇒ `[unreadable]`
 * - **永不抛异常**（与 `errorCode` 不同：本函数只供日志/告警，不参与路由映射）
 */
export function errorDetail(err: unknown): string {
  try {
    if (err instanceof Error) {
      // message 可能是会抛的 getter；单独保护
      try {
        const msg = err.message;
        return truncateDetail(typeof msg === 'string' ? msg : String(msg));
      } catch {
        return '[unreadable]';
      }
    }
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
    // instanceof / typeof 等极端失败（如 revoked Proxy）
    return '[unreadable]';
  }
}
