/**
 * Dashboard shell 深链单一事实源（ADR #26）。
 * 服务端 registerUiShell 与客户端 router 契约测试都应对齐此处枚举。
 */

/** 精确页面路径（无通配）；刷新时尾斜杠变体也必须 200。 */
export const UI_SHELL_EXACT_PATHS = [
  '/ui/overview',
  '/ui/notifications',
  '/ui/configure/identities',
  '/ui/configure/push',
  '/ui/configure/clients',
  '/ui/configure/domains',
  '/ui/plan',
] as const;

/** 带动态段的前缀（另注册 `prefix/*`；`prefix` 与 `prefix/` 均需可达）。 */
export const UI_SHELL_PREFIX_PATHS = ['/ui/inbox', '/ui/tasks'] as const;

/**
 * 交给 Hono 注册的完整 path 表。
 * 精确路径显式挂尾斜杠，避免 `/ui/overview/` 刷新 404（ADR「刷新不 404」）。
 */
export function uiShellRegisterPaths(): string[] {
  const paths: string[] = ['/ui', '/ui/'];
  for (const prefix of UI_SHELL_PREFIX_PATHS) {
    paths.push(prefix, `${prefix}/*`);
  }
  for (const exact of UI_SHELL_EXACT_PATHS) {
    paths.push(exact, `${exact}/`);
  }
  return paths;
}
