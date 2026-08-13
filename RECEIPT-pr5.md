# RECEIPT — #26 阶段2 · PR 5

日期：2026-08-13  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr5`（禁动 main；基线 `676fa3c`）  
HEAD：`a0f1059`  
PR：https://github.com/openagentemail/openagentemail/pull/29

## 交付

Configure 分区完整闭环已推上 PR #29。后端业务能力基本复用（identities CRUD/token/push-tier、OAuth grants JSON API）。Trust-30d / cookie `Path=/ui` / Origin / 全局 body-limit 未改。设备配对仍属 PR 6，本页保持诚实空态。

## 验收证据（ADR §PR 5）

| 项 | 结果 |
|---|---|
| 创建 / 删除二次确认 / rotate 一次性 token 仪式 | **过** — create/rotate 走现有 token modal（「Copy this token now. It will not be shown again.」）；删除 confirm modal；成功后留在 Configure |
| 单 slot 诚实展示；旧 token 明文永不回显 | **过** — 只渲染 `Token slot: Set\|Missing`；列表投影 `hasToken`，无 `identity.token` |
| 每身份 push tier 投影 | **过** — Identities 行只读投影；编辑在 Push 三张人话卡 |
| 人话三档卡 1/2/3；tier 3 服务端 `confirm_risk` 不可绕过 | **过** — PUT 无/`false` → 400 `confirm_risk_required`；`true` 才写入（`ui-configure.test.ts` + Bearer `identities.test.ts`） |
| identity session 无越权控件 | **过** — Create/Rotate/Delete 不渲染；CSS 再藏 create；API 403；Push 卡为只读 `div` |
| OAuth grant 吊销即时生效 | **过** — DELETE 204 后 `getGrant` 空；`oauth-as` 另钉 token 立即 401 |
| 自托管无虚假套餐/升级 | **过** — Plan 仅实例说明 + `openagent.email/docs/reference/api/` 纯文本；HTML/JS 无 Upgrade 按钮 |
| Domains 诚实 roadmap 空态 | **过** — `renderEmptyState`，无可点击无效控件 |
| 旧 `/ui/oauth/grants` 兼容 fallback | **过** — 有会话 302 `/ui/configure/clients`；无会话先登录 |
| API 测试 + build | `packages/api` `bun test` **746 pass / 0 fail**；`bun run build` 全绿 |

## PR1 债项 ZCode P2×3（逐条）

| 债项 | 处理结果 |
|---|---|
| ① `/grants` 重定向 session 检查 | **已关** — `createUiOAuthPageRoutes` GET `/grants` 无会话 `redirectToLogin`（302 `/ui`）；有会话再 302 Configure。测试：`ui-configure.test.ts` + `ui-assets` 匿名 Location `/ui`；`oauth-as` 带 cookie 仍到 `/ui/configure/clients`。未改 `/ui/api/oauth/*` 契约。 |
| ② `applyScope` 分支膨胀收敛 | **已关** — 嵌套三元收成 `SCOPE_META` map（title / document.title / skip / href / mobileView）；configure/plan 的 skip 不再误落到 Inbox。 |
| ③ 空桩组件补齐或移除 | **已关（迁入真实现）** — `app-nav.ts`：`closeNavDrawer` / `openNavDrawer` / `renderAppNav`；`modal.ts`：`closeAllModals` / `showTokenModal` / `showCreateModal`。`empty-state` / `paginator` / `identity-switcher` 本就有真函数。拼接顺序未改；函数声明在同一 IIFE 内提升，调用点不用动。 |

## 独立自审

- **禁止自审自。** 新 subagent agent id：`8a6cc590-1218-460f-9781-c5feaa5ddb22`
- 审查范围：`origin/main...HEAD`（`676fa3c..a0f1059`）对照 ADR §PR 5
- 结论：**mergeable**
- P0/P1：**无**
- P2（记债，不挡合并）：Configure `handleConfigurePushTier` 模糊失败（网络/5xx）未像 Overview F51 那样 GET `/ui/api/identities` 回拉权威档。若 PUT 已成功但响应丢失，卡片可能停在旧档，再点已选中卡是 no-op。Overview `<select>` 仍带 F51。建议下轮把同一 recovery 迁到 Configure 卡。
- ZCode `zcode_pr_review` 本轮 MCP 超时，未出报告。

## 桌面 / 移动布局自测（不拍屏）

未开真浏览器拍屏（线上截屏由指挥做）。依据 shell + CSS：

- **桌面：** Identities 为 `identity-config-row` 两列（meta + Rotate/Delete）；Push 三卡 `repeat(auto-fit, minmax(220px, 1fr))`，选中金边；admin 多身份时显示 Identity `<select>`；Clients 仍为 `client-row` 列表+Revoke；Domains/Plan 为 `empty-state-card`，无假按钮。
- **移动（≤820px / 375 目标）：** identity 行改 block，动作右对齐；push 卡 `min-height: 44px`；Create Identity / 文档指针 44px。identity 会话 CSS 隐藏 `#configure-identities-create` 与 Overview 的 `#create-identity-button`。未改 Inbox 三栏/Back 栈。
- 指挥请在 1280 与 375 各拍：Identities 列表（含 token slot + tier 投影）、Push 三卡、Clients 吊销、Plan 空态。

## 未卡住项

无阻塞。指挥合入前请看 CI；可选是否把 Configure 档位 F51 recovery 收进本 PR 或记到 PR 6 前。
