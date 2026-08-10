/**
 * MCP 工具四级分层（WriteGuard：按爆炸半径分级，策略按级不按工具写）。
 *
 * - read：只读观测
 * - minimal：轻量状态变更（已读标记、建任务）
 * - contained：外发/唤醒（发信、通知、推进任务）
 * - critical：建身份 / 验人通道——对 OAuth 票 deny-by-default
 *
 * 新工具必须在注册处声明 tier；未声明 → 注册即 throw（default deny 的编译期形态）。
 * HTTP /mcp 对未知工具名同样 403（防绕过注册表）。
 * stdio 路径不查本表策略（operator 本地；REST ACL 兜底）——见 mcp/http.ts 注释。
 */

export type ToolTier = 'read' | 'minimal' | 'contained' | 'critical';

const TIER_RANK: Record<ToolTier, number> = {
  read: 0,
  minimal: 1,
  contained: 2,
  critical: 3,
};

/** 定稿映射（PR 描述同源）；模块加载即入库，供 /mcp 预检（早于 SDK 工厂）。 */
export const TOOL_TIER_SPEC = {
  // read
  mail_list_messages: 'read',
  mail_read_message: 'read',
  mail_wait_for: 'read',
  mail_list_identities: 'read',
  notify_check: 'read',
  task_list: 'read',
  task_get: 'read',
  // minimal
  mail_mark_seen: 'minimal',
  task_create: 'minimal',
  // contained
  mail_send: 'contained',
  task_update: 'contained',
  notify_agent: 'contained',
  notify_user: 'contained',
  // critical：OAuth deny-by-default
  mail_new_identity: 'critical',
  notify_verify: 'critical',
} as const satisfies Record<string, ToolTier>;

/** 进程内注册表：tool name → tier（规格预填 + tools.ts 注册时校验）。 */
const declared = new Map<string, ToolTier>(
  Object.entries(TOOL_TIER_SPEC) as [string, ToolTier][],
);

/**
 * 注册处声明级别。同一 name 重复声明且级别不同 → throw。
 * 未在规格表中的新工具也可声明（须与策略一致）；漏声明则 HTTP default deny。
 */
export function declareToolTier(name: string, tier: ToolTier): void {
  const existing = declared.get(name);
  if (existing !== undefined && existing !== tier) {
    throw new Error(`tool tier conflict: ${name} (${existing} vs ${tier})`);
  }
  declared.set(name, tier);
}

/** 查询已声明级别；未声明返回 undefined（HTTP 侧 default deny）。 */
export function getToolTier(name: string): ToolTier | undefined {
  return declared.get(name);
}

/** 强制取级别；未声明即抛——供注册收尾校验。 */
export function requireToolTier(name: string): ToolTier {
  const tier = declared.get(name);
  if (!tier) {
    throw new Error(`tool ${name}: tier not declared (default deny)`);
  }
  return tier;
}

/** tier ≥ minimal 算写调用（审计 + 写桶限量）。 */
export function isWriteTier(tier: ToolTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.minimal;
}

/** 测试辅助：恢复为规格表（勿长期清空，以免 /mcp 预检误拒）。 */
export function resetToolTiersForTests(): void {
  declared.clear();
  for (const [name, tier] of Object.entries(TOOL_TIER_SPEC)) {
    declared.set(name, tier as ToolTier);
  }
}
