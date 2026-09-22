/**
 * 从未知 rejection 安全取出错误码字符串。
 *
 * 哨兵值：`''`（空串）——与 `routes/tasks.ts` 历史守卫
 * `typeof raw === 'string' ? raw : ''` 逐字节同语义。
 *
 * - `err` 为 `Error`，或任意带字符串 `message` 的对象 ⇒ 返回该 `message`
 * - 非 Error / `undefined` / `null` / 数字 / 无字符串 message 的对象 ⇒ 返回 `''`
 * - 永不抛异常（供 catch 映射器使用，避免读 `undefined.message` 逸出成 app 级 500）
 */
export function errorCode(err: unknown): string {
  // 与 journalUnavailable 既有守卫同一口径：只认字符串 message
  const raw = (err as { message?: unknown } | null | undefined)?.message;
  return typeof raw === 'string' ? raw : '';
}
