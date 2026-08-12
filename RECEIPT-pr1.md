# RECEIPT — #26 Dashboard 大改版 · PR 1

- **时间**：2026-08-12
- **分支**：`tizerluo/worker-34-pr1`（未动 `main`）
- **HEAD commit**：`62d9925`（`chore: drop accidental mimosa hook-state from PR1 branch`）
- **功能 commit**：`8113994` modularize shell；`6de5219` shell 注册顺序修复
- **PR**：[#25](https://github.com/openagentemail/openagentemail/pull/25) — `feat(api): modularize dashboard shell and real /ui routes (#26 PR 1)`
- **Repo**：`openagentemail/openagentemail`

## 独立自审（强制）

| 项 | 值 |
|---|---|
| Subagent ID | `d7f56123-14b4-4a53-8122-44147b98149f` |
| 初审结论 | **有条件合并**（P1：shell 深链须在 api/oauth/frame 之后） |
| 跟进 | 已拆 `registerUiShell()` 后挂；删 `grantsPageHtml` 死代码；补顺序回归测试 |
| 终态 | P1 已关闭；P2（组件空桩/文档面）记债可合 |

## ADR §PR 1 验收逐条自测

| # | 验收原文要点 | 结果 | 证据 |
|---|---|---|---|
| 1 | 现有 API 功能无回归 | **过** | `packages/api`：`bun test` → **627 pass / 0 fail**；`bun run build` 绿 |
| 2 | admin/identity 登录落 Inbox | **过** | `startSession` 调 `loadInbox`+`applyRoute`；acceptance A51/A52 改为 inbox |
| 3 | 刷新新路径不 404 | **过** | `registerUiShell` 路径表 + `ui-assets` 枚举 200 |
| 4 | 旧 `/ui` 书签有效 | **过** | `/ui` `/ui/` 同 shell；契约测试保留 |
| 5 | 旧 `/ui/oauth/grants` 302→`/ui/configure/clients` | **过** | `ui-oauth.ts` + `oauth-as`/`ui-assets` 测试 |
| 6 | OAuth 回跳 | **过（静态）** | `consumeReturnTo` 仍限 `/ui` 前缀 |
| 7 | 401 cache 清理 | **过** | F1 `showLogin`→`clearNotifyState`/`clearTasksState` |
| 8 | CSP `script-src 'self'` | **过** | `OUTER_CSP` 钉死；无 inline script |
| 9 | 375px 移动导航 | **过（代码）/ 未实机** | drawer CSS + 44px targets；browser harness 未在本工位实跑 |
| 10 | 键盘焦点 | **过（静态）** | skip-link / `preventScroll` focus 路径保留 |
| 11 | cookie `Path=/ui` 与 Trust-30d 一字不动 | **过** | `ui-session.ts` 相对 main 无 diff |

## 改动面

- `packages/api/src/ui/**`（拆分 + 聚合）
- `packages/api/src/routes/ui-assets.ts`、`ui-oauth.ts`、`app.ts`（shell 注册顺序）
- 相关 UI tests + `dev/acceptance.mjs`
- 文档：`README.md`、`packages/api/README.md`、`Progress.md`

## 卡住 / 疑问

无阻塞项。可选后续：实跑 acceptance harness 做 375px/焦点手测；把 `app-nav` 等空桩迁入真实现（P2 记债）。

---

## 返工第1轮（Codex P0 跟进）

- **时间**：2026-08-12
- **触发**：Codex Local Review 对 `62d9925` 报 P0（置信 1.00）：`selectTask` 使用 `await` 但未声明 `async` → `/ui/app.js` SyntaxError。
- **核实**：对照 main 拆分前实现 + `new Function(UI_JS)`；`async function selectTask(` 已存在，该 P0 为对 JSON 一行模块的误报。另发现真回归：`taskTimelineBody` fence/`replace` 反斜杠被 JSON 二次转义，已与 main 金标对齐。
- **闸**：`assembled /ui/app.js is syntactically valid`（`new Function`）+ `critical UI loaders remain async…` + tasks fence 字面量钉死。
- **测试**：`packages/api` `bun test` → **629 pass / 0 fail**
- **独立自审（新 agent，禁止自审自）**：见下方追加（subagent 跑完后填入）。
