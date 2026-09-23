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
 *
 * 日志/告警载荷请走 `describeFailure`（`lib/redact.ts`）；本文件不再导出 errorDetail。
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
