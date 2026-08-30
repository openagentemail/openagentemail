/**
 * MCP 工具四级分层（WriteGuard：按爆炸半径分级，策略按级不按工具写）。
 *
 * - read：只读观测
 * - minimal：轻量状态变更（已读标记、建任务）
 * - contained：外发/唤醒（发信、通知、推进任务）
 * - critical：建身份 / 验人通道——对 OAuth 票 deny-by-default
 *
 * 两层表：
 * - TOOL_TIER_SPEC：策略规格（文档/对照）；**不**预填注册表
 * - declared：仅由 tools.ts 注册处 `declareToolTier` 写入
 *
 * 护栏：`assertToolTierDeclared(name)` 在真正 registerTool 前调用——
 * 漏调 declare → 注册即 throw。HTTP 预检用 getToolTier：已声明优先，
 * 否则回落 SPEC（工厂尚未跑时仍能按规格拦）。
 */

export type ToolTier = 'read' | 'minimal' | 'contained' | 'critical';

const TIER_RANK: Record<ToolTier, number> = {
  read: 0,
  minimal: 1,
  contained: 2,
  critical: 3,
};

/** 定稿映射（PR / docs 同源）。不自动写入 declared。 */
export const TOOL_TIER_SPEC = {
  // read
  mail_list_messages: 'read',
  mail_read_message: 'read',
  mail_wait_for: 'read',
  mail_list_identities: 'read',
  notify_check: 'read',
  task_list: 'read',
  task_get: 'read',
  task_list_children: 'read',
  // minimal
  mail_mark_seen: 'minimal',
  task_create: 'minimal',
  // contained
  mail_send: 'contained',
  task_update: 'contained',
  task_decide: 'contained',
  task_claim: 'contained',
  task_renew: 'contained',
  task_release: 'contained',
  notify_agent: 'contained',
  notify_user: 'contained',
  // critical：OAuth deny-by-default
  mail_new_identity: 'critical',
  notify_verify: 'critical',
} as const satisfies Record<string, ToolTier>;

/** 进程内注册表：空起步，只接受 declareToolTier。 */
const declared = new Map<string, ToolTier>();

/**
 * 注册处声明级别。同一 name 重复且级别不同 → throw。
 */
export function declareToolTier(name: string, tier: ToolTier): void {
  const existing = declared.get(name);
  if (existing !== undefined && existing !== tier) {
    throw new Error(`tool tier conflict: ${name} (${existing} vs ${tier})`);
  }
  declared.set(name, tier);
}

/**
 * 注册护栏：name 必须已 declare，否则 throw。
 * tools.ts 在 server.registerTool 之前调用——漏声明即炸。
 */
export function assertToolTierDeclared(name: string): void {
  if (!declared.has(name)) {
    throw new Error(`tool ${name}: tier not declared (default deny)`);
  }
}

/** 是否已在注册处声明（不含 SPEC 回落）。 */
export function isToolTierDeclared(name: string): boolean {
  return declared.has(name);
}

/**
 * 查询策略级别：已声明优先，否则 SPEC 回落（供 /mcp 预检在工厂前使用）。
 * 未在 SPEC 且未声明 → undefined（HTTP 403）。
 */
export function getToolTier(name: string): ToolTier | undefined {
  const fromDeclared = declared.get(name);
  if (fromDeclared) return fromDeclared;
  return (TOOL_TIER_SPEC as Record<string, ToolTier>)[name];
}

/** 强制取「已声明」级别；未声明即抛——供注册收尾校验规格表覆盖。 */
export function requireToolTier(name: string): ToolTier {
  const tier = declared.get(name);
  if (!tier) {
    throw new Error(`tool ${name}: tier not declared (default deny)`);
  }
  return tier;
}

/** tier ≥ minimal 算写调用（成功路径审计 + 写桶限量）。 */
export function isWriteTier(tier: ToolTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK.minimal;
}

/** 测试辅助：清空注册表（不预填 SPEC）。 */
export function resetToolTiersForTests(): void {
  declared.clear();
}

/**
 * 校验规格表内每个工具都已在本次注册中声明。
 * 漏掉某个 tier() 调用 → throw（与 SPEC 预填不同，此校验真会失败）。
 */
export function assertAllSpecTiersDeclared(): void {
  for (const name of Object.keys(TOOL_TIER_SPEC)) {
    requireToolTier(name);
  }
}
