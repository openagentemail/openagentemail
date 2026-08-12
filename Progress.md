# Progress — #26 Dashboard 大改版 · PR 1

日期：2026-08-12  
分支：`tizerluo/worker-34-pr1`  
范围：ADR §PR 1（前端模块化与新壳）

## 我们实现了哪些功能？

1. 将原 `packages/api/src/ui/assets.ts`（约 3913 行）按 ADR 拆为 `shell.ts`、`styles/{tokens,base,layout,pages}.ts`、`client/{store,dom,api,router,app}.ts`、`client/components/*`、`client/pages/*`；`assets.ts` 仅聚合导出 `UI_HTML` / `UI_CSS` / `UI_JS` / `UI_LOGO_SVG` / `OUTER_CSP`。
2. 对外资产契约不变：仍为 `/ui/styles.css`、`/ui/app.js` 单资源；零新增运行依赖、零 bundler；CSP `script-src 'self'`。
3. 加入全局 Operate / Configure / Plan 导航（含 375px 抽屉与 44px 触控目标）。
4. History API 真实 `/ui/*` 子路径；服务端 shell 路由覆盖 inbox/overview/tasks/notifications/configure/*/plan；未知路径仍 404。
5. 所有 session（含 admin）登录默认落地 Inbox；深链由路径恢复。
6. 现有 Inbox / Overview / Tasks / Notifications / identity 操作接入新 nav；Configure 提供 Identities 列表操作、Clients（复用 `/ui/api/oauth/grants`）、Push/Domains/Plan 诚实空态。
7. 旧 `/ui/oauth/grants` GET 302 → `/ui/configure/clients`；表单吊销回跳同步。
8. Trust-30d、cookie `Path=/ui`、401 cache 清理语义未改。

## 我们遇到了哪些错误？

1. 拆分 HTML 时 `${logoGeometry}` 被当成字面量写入 shell，导致 favicon/symbol 几何断言失败。
2. `INBOX_PAGE_JS` 曾把 `startSession` 拼到 Overview 代码之前，静态测试用 `startSession`…`loginForm` 切片误包含 `focusOverviewPanel`。
3. 新增 `GET /ui/overview` shell 后，Overview 路由表契约测试只允许 `/ui/api/overview`。
4. OAuth grants 页面测试仍期望 200 HTML，与 ADR 302 冲突。
5. 验收脚本 A51/A52 仍假设 admin 落地 Overview。

## 我们是如何解决这些错误的？

1. 在写出 `SHELL_HTML` 前把 `${logoGeometry}` 替换为真实几何字符串。
2. 将 `waitForPreviousRefresh`…`startSession` 并入 `client/app.ts`，保证启动切片不再跨 Overview。
3. 更新路由表断言，允许 shell `GET /ui/overview`，并继续禁止 `/v1` overview。
4. 更新 `oauth-as` 与 `ui-assets` 测试为 302 → `/ui/configure/clients`。
5. 改写 `dev/acceptance.mjs`：登录/续期断言 Inbox，再经 nav 进入 Overview 跑后续面板用例；同步 `ui-dev-acceptance` 契约字符串。
