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
6. 独立自审指出 shell 深链在 `registerUiAssets` 内先于 `/ui/api|/ui/oauth|/ui/frame` 注册，违反 ADR「必须后挂」硬约束。

## 我们是如何解决这些错误的？

1. 在写出 `SHELL_HTML` 前把 `${logoGeometry}` 替换为真实几何字符串。
2. 将 `waitForPreviousRefresh`…`startSession` 并入 `client/app.ts`，保证启动切片不再跨 Overview。
3. 更新路由表断言，允许 shell `GET /ui/overview`，并继续禁止 `/v1` overview。
4. 更新 `oauth-as` 与 `ui-assets` 测试为 302 → `/ui/configure/clients`。
5. 改写 `dev/acceptance.mjs`：登录/续期断言 Inbox，再经 nav 进入 Overview 跑后续面板用例；同步 `ui-dev-acceptance` 契约字符串。
6. 拆出 `registerUiShell()`，在 app.ts 挂完 api/oauth/frame 之后再注册；删除死代码 `grantsPageHtml`；补注册顺序回归测试。

---

## 返工第1轮（2026-08-12）

### 我们实现了哪些功能？

1. 对照 main 拆分前 `UI_JS` 审计全部 `async function`：`selectTask` 等带 `await apiJson` 的加载器在 HEAD 上本就为 `async`（Codex 报「缺 async」为对 JSON 一行模块的误报）；全量 `await apiJson` 扫描无「非 async 外层」真阳性。
2. 修复 `tasks.ts` 中 `taskTimelineBody` 的 JSON 二次转义：fence/`replace` 反斜杠数与 main 对齐（`^\\s*` 而非 `^\\\\s*`），避免结果块剥离正则行为错误。
3. 防回归闸：`ui-assets.test.ts` 用 `new Function(UI_JS)` 校验拼装产物语法；钉死 main 时代关键 `async function <name>(`；tasks 契约改为显式 `async function selectTask/loadTasks`，并钉死 fence/`\\s` 转义。
4. `bun test`：**629 pass / 0 fail**（原 627 + 2 新闸）。
5. 独立自审 agent `2963a9a1-5fbc-4664-be2e-4fd5320b5f70`：可合并；Codex P0 否定为误报；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. Codex Local Review P0 称 `selectTask` 缺 `async` 导致整脚本 SyntaxError；实测 `new Function(UI_JS)` 通过，函数声明已是 `async`。
2. 曾尝试把模块改成模板字符串，Bun/TS 会把 `\\s` 吃成 `s`，`replace` 一度变成 `/s+$/`。
3. 测试断言曾按「源码一个反斜杠」去匹配 fence，与真实 UI_JS（RegExp 字符串字面量需两反斜杠）不一致导致误红。

### 我们是如何解决这些错误的？

1. 以 main `assets.ts` 导出的 `UI_JS` 为金标逐行比对 fence/replace；用 `json.dumps` 稳定写回 `TASKS_PAGE_JS`，避免模板吞转义。
2. 保留 JSON 字符串模块形态；语法闸 + async 白名单 + fence 字面量钉死，覆盖「缺 async」与「过转义」两类回归。
3. 修正测试 needle 的反斜杠层数，与金标一致后再跑全量测试。

---

## 返工第2轮（2026-08-12）

### 我们实现了哪些功能？

1. 修复共享 `apiJson()`：成功路径对 204/205 与空 body 返回 `null`（`text()` + `JSON.parse`），避免 OAuth grant DELETE 吊销成功仍进 error handler。
2. 核调用点：身份 DELETE 仍返回 `{deleted:true}` JSON；仅 grant 吊销为 204；赋值方均期望对象，`null` 仅落在 fire-and-forget 的 revoke `await`。
3. 契约测试钉死 204 处理与 revoke → `Client revoked.` / `loadConfigureClients()` 成功路径。
4. `bun test`：**630 pass / 0 fail**。
5. 独立自审 agent `93825551-6f2f-4c46-9320-da672a3c20b0`：可合并；Codex P1 已关闭；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. Codex P1：`authorized-clients` 吊销 DELETE 204，旧 `apiJson` 无条件 `response.json()` → 假失败文案与列表不刷新。

### 我们是如何解决这些错误的？

1. 在 `client/api.ts` 的 `apiJson` 成功分支显式处理无 body；保留失败分支 try/`response.json()` 解析 error body。
2. 用静态契约覆盖，防止再次退回 `return response.json()`。
