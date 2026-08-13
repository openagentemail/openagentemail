# RECEIPT — #26 阶段2 · PR 5

日期：2026-08-13  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr5`（禁动 main；基线 `676fa3c`）  
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
| identity session 无越权控件 | **过** — Create/Rotate/Delete 不渲染；CSS 再藏 create；API 403；Push 卡为 `radiogroup`/`radio` + `aria-checked`（只读 `aria-disabled`） |
| OAuth grant 吊销即时生效 | **过** — DELETE 204 后 `getGrant` 空；`oauth-as` 另钉 token 立即 401 |
| 自托管无虚假套餐/升级 | **过** — Plan 仅实例说明 + `docsHref`/`docsLabel` 真链接（白名单 http(s) 或 `/` 相对路径）；HTML/JS 无 Upgrade 按钮 |
| Domains 诚实 roadmap 空态 | **过** — `renderEmptyState`，无可点击无效控件 |
| 旧 `/ui/oauth/grants` 兼容 fallback | **过** — 有会话 302 `/ui/configure/clients`；无会话先登录 |
| API 测试 + build | `packages/api` `bun test` **751 pass / 0 fail**；`bun run build` 全绿 |

## PR1 债项 ZCode P2×3（逐条）

| 债项 | 处理结果 |
|---|---|
| ① `/grants` 重定向 session 检查 | **已关** — `createUiOAuthPageRoutes` GET `/grants` 无会话 `redirectToLogin`（302 `/ui`）；有会话再 302 Configure。测试：`ui-configure.test.ts` + `ui-assets` 匿名 Location `/ui`；`oauth-as` 带 cookie 仍到 `/ui/configure/clients`。未改 `/ui/api/oauth/*` 契约。 |
| ② `applyScope` 分支膨胀收敛 | **已关** — 嵌套三元收成 `SCOPE_META` map（title / document.title / skip / href / mobileView）；configure/plan 的 skip 不再误落到 Inbox。 |
| ③ 空桩组件补齐或移除 | **已关（迁入真实现）** — `app-nav.ts`：`closeNavDrawer` / `openNavDrawer` / `renderAppNav`；`modal.ts`：`closeAllModals` / `showTokenModal` / `showCreateModal`。`empty-state` / `paginator` / `identity-switcher` 本就有真函数。拼接顺序未改；函数声明在同一 IIFE 内提升，调用点不用动。 |

## 初版独立自审（已被指挥否决，见 R1）

- **禁止自审自。** agent id：`8a6cc590-1218-460f-9781-c5feaa5ddb22`
- 审查范围：`origin/main...HEAD`（`676fa3c..a0f1059`）对照 ADR §PR 5
- 当时结论：mergeable / P0/P1 无 / P2 记 Configure 模糊失败未回拉权威
- **更正（CodeRabbit Major 3771644746 + Minor 3771644742）：** 原「mergeable / 无 P1」**错误**。指挥把该 P2 升为 Codex P1（评论 3771597658）。信任事故：tier PUT 可能已落盘但 UI 仍画旧档。本轮 R1 已修，证据见下表 A。

## 桌面 / 移动布局自测（不拍屏）

未开真浏览器拍屏（线上截屏由指挥做）。依据 shell + CSS：

- **桌面：** Identities 为 `identity-config-row` 两列（meta + Rotate/Delete）；Push 三卡 `repeat(auto-fit, minmax(220px, 1fr))`，选中金边；admin 多身份时显示 Identity `<select>`；Clients 仍为 `client-row` 列表+Revoke；Domains/Plan 为 `empty-state-card`，Plan 文档为真 `<a>`（`.empty-state-docs`，44px）。
- **移动（≤820px / 375 目标）：** identity 行改 block，动作右对齐；push 卡 `min-height: 44px`；Create Identity / 文档指针 44px。identity 会话 CSS 隐藏 `#configure-identities-create` 与 Overview 的 `#create-identity-button`。未改 Inbox 三栏/Back 栈。
- 指挥请在 1280 与 375 各拍：Identities 列表（含 token slot + tier 投影）、Push 三卡、Clients 吊销、Plan 空态真链接。

---

## R1 返工（2026-08-13）

同一分支 `tizerluo/worker-34-pr5` 就地修复，未新开分支，未动 main，未自行 merge。

### 逐条对账

| 评论 id | 项 | 处置 | 证据 / 测试 |
|---|---|---|---|
| 3771597658 | A Codex P1 `handleConfigurePushTier` 模糊失败 | **fixed** | catch 模糊分支：`bumpIdentityEpoch()` → `apiJson('/ui/api/identities')` → `(refreshed).` 再渲染；`confirm_risk_required` / `session_expired` 不含 GET。测试：`ui-assets` Configure push 契约（F51 对齐） |
| 3771655230 | B pending 锁 finally 后 Overview 重绘 | **fixed** | `finally`：`delete state.tierPending[address]` 后 `if (state.scope === 'overview') renderOverviewRows()`。同上测试切片 |
| 3771655235 + 3771617547 | C 只读卡 `div`+`aria-pressed` | **fixed** | `radiogroup` + `role=radio` + `aria-checked`；只读 `aria-disabled`；sr-only「Current push content:」；`renderConfigurePush` 无 `aria-pressed` |
| 3771617543 之一 | D `applyRoute` 关 modal | **fixed** | `router.ts` `applyRoute`：`closeNavDrawer()` 后 `closeAllModals()`（消费 `confirmModalOnCancel`）。测试：`applyRoute closes modals…` |
| 3771617540 | E drawer 焦点 + Escape | **fixed** | `closeNavDrawer` 仅 `wasOpen` 才 `navToggle.focus()`；Escape / backdrop / toggle 共用。测试：`nav drawer restore focus…` |
| 3771617543 之二 | F modal opener 回焦 | **fixed** | `beginModal` 记 opener；链式 Create→Token：焦点在 modal 内或落到 `body` 时保留 previous；`closeAllModals` 仅 `isConnected` 才 focus；Cancel/Close/Escape 走 `closeAllModals`。独立自审初标 partial 的两条 P2 已关 |
| 3771617545 | G Plan 真链接 + href 白名单 | **passed** | `docsHref`/`docsLabel`；`allowedDocsHref` 放行 http(s) 与 `/…`，拒绝 `//` 与 `javascript:`；UI_JS 用 `'https:'+'/'+'/'+…` 拼接，三资产闸 0 命中 `https://`。测试：`allowedDocsHref permits…` + Plan 契约 |
| 3771644746 + 3771644742 | H 回执更正 | **fixed** | 本文更正初版「无 P1」；A 已修；G 验证后标 passed |
| ZCode P2-2 | I `indexOf('configure-')` | **fixed** | `isConfigureScope` 显式五值；`api.ts` / identity-switcher 改用；UI_JS 无 `indexOf('configure-')`。测试：`delete-identity stay-on-configure uses an explicit scope enum` |

### R1 独立自审

- **禁止自审自。** 新 subagent agent id：`0b86e174-dd2b-4c4d-a3b2-5202e8010943`
- 范围：未提交 R1 diff（解码 JSON 模块）对照 ADR §PR 5 与评论 A–I
- 结论：**mergeable**
- P0/P1：**无**
- 过程：初审 F 标 partial（Create→Token opener 被提交钮/`body` 覆盖；tier3 Cancel `replaceChildren` 卸 opener）。同轮已关：`lostFocus && previous` 保留上一层 opener；Configure `confirmModalOnCancel = null`；`isConnected` 才 focus。复审：**F fixed，P2-1/P2-2 closed，仍 mergeable**。
- ZCode `zcode_pr_review` 未在本轮重跑（上轮 MCP 超时）。

### R1 测试 / build

`cd packages/api && bun test` **751 pass / 0 fail**；`bun run build` 全绿。

push 后停在 `tizerluo/worker-34-pr5` 等指挥终审，禁止自行 merge。
