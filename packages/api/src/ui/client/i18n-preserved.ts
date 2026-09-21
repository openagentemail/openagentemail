/**
 * 不译/保真键清单（#137 B2）：四字典中这些键的值必须与 I18N_EN 逐字节相同。
 * 覆盖产品名标题、CLI/路径指令块、API token/MCP 标签、任务状态枚举字面量。
 */
export const I18N_PRESERVED_KEYS = [
  "login.tokenLabel",
  "shell.html.mcpEndpoint",
  "frame.brandH1",
  "frame.docTitle",
  "router.docTitle.connectAnAgentOpenagentEmail",
  "router.docTitle.openagentAlerts",
  "router.docTitle.openagentConnectedApps",
  "router.docTitle.openagentDomains",
  "router.docTitle.openagentHome",
  "router.docTitle.openagentIdentities",
  "router.docTitle.openagentMail",
  "router.docTitle.openagentPlan",
  "router.docTitle.openagentPushDevices",
  "router.docTitle.openagentTasks",
  "connect.copy.iAlreadyAddedOpenagentEmailTo",
  "connect.copy.iAlreadyMergedOpenagentEmailInto",
  "connect.copy.iAlreadyMergedOpenagentEmailInto2",
  "connect.copy.iAlreadySavedOpenagentEmailInto",
  "connect.copy.inYourShellRunReadS",
  "tasks.filter.active",
  "tasks.filter.completed",
  "tasks.filter.failed",
  "tasks.filter.input-required",
  "tasks.state.completed",
  "tasks.state.failed",
  "tasks.state.reminder",
  "tasks.state.submitted",
  "tasks.state.working"
] as const;

export type I18nPreservedKey = (typeof I18N_PRESERVED_KEYS)[number];
