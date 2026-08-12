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

---

## 返工第3轮（2026-08-12）

### 我们实现了哪些功能？

1. `parseLocationRoute`：新增 `safeDecodeURIComponent`，畸形百分号编码回退 `{ unknown: true }` 的 inbox fallback，避免 URIError 白屏。
2. 抽出 `packages/api/src/ui/shell-routes.ts` 作为 shell 路径单一事实源；精确路径显式注册尾斜杠变体，修复 `/ui/overview/` 等刷新 404。
3. 契约测试：畸形深链 runtime 不抛；客户端字面量 ↔ `UI_SHELL_*` ↔ 注册表三方对齐；尾斜杠刷新 200。
4. `bun test`：**632 pass / 0 fail**。
5. 独立自审 agent `3fc1377e-4fbb-4f59-9482-236a41257dcf`：可合并；P1-1/P1-2 已关闭；无新发现。

### 我们遇到了哪些错误？

1. ZCode P1-1 / Codex P2：`decodeURIComponent` 未捕获 → `/ui/tasks/%E4%B8` 等服务端 200 后客户端同步崩。
2. ZCode P1-2：服务端精确路径无尾斜杠变体，与客户端去尾斜杠解析不对齐 → 刷新 404。

### 我们是如何解决这些错误的？

1. decode 包 try/catch，失败当未知路径。
2. `uiShellRegisterPaths()` 对 exact 路径 `flatMap` 出 `path` + `path/`；测试钉死三方枚举一致。

---

## 返工第4轮（2026-08-12）

### 我们实现了哪些功能？

1. Overview 全局导航按会话角色渲染：`#nav-overview-item` 默认 `hidden`；`configureSession()` 仅 admin 打开；identity 会话 CSS `[data-session="identity"]` 再藏一层。侧栏 Overview 哨兵原本就 `isAdmin()` 门控，未改。
2. 契约测试运行 `isAdmin`+`configureSession`：identity 隐藏 Overview nav，admin 显示。A53 浏览器探针改为钉 `[data-nav="overview"]` / `#nav-overview-item`。
3. 路由表层级回归：对 `/ui/api/*`、`/ui/oauth/*`、`/ui/frame/*` 发真实请求，断言响应不是 dashboard shell（无 `id="app-nav"`、CSP 不是 `OUTER_CSP`）。客户端 `parseLocationRoute` 把这些保留前缀标 `unknown`（popstate 同源解析）。
4. `bun test`：**635 pass / 0 fail**（原 632 + 3 新闸）。
5. 独立自审 agent `a2c21089-d533-4991-8e0d-abd971ead041`：可合并；Codex P2 / ZCode P1 已关闭；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. Codex P2：identity session 能看到 admin 专属 Overview 全局 nav，点了靠 `applyRoute` fallback 兜底，违反 ADR 权限原则。
2. ZCode P1：shell 深链注册顺序此前只有 `app.routes` 静态下标比较，缺少「通配形态请求不吞 api/oauth/frame」的路由表级请求断言。

### 我们是如何解决这些错误的？

1. 与 `backToOverview` / `createIdentityButton` 同一套 `configureSession` 显隐；HTML 默认 hidden 失败关闭；CSS 按 `data-session` 双保险。
2. 新增请求级测试对比合法 shell 深链（`/ui/inbox`、`/ui/tasks/:id` 仍是 dashboard HTML）与保留前缀；复用 `parseLocationRoute` harness 钉 popstate 解析。

---

# Progress — #26 Dashboard 大改版 · PR 2

日期：2026-08-12  
分支：`tizerluo/worker-34-pr2`  
范围：ADR §PR 2（Inbox 邮箱客户端闭环）

## 我们实现了哪些功能？

1. IMAP：`listMessagesPage` 支持 `folder=inbox|sent|all` 与 HMAC 游标（`mail-cursor-v1`，绑定 folder+address+(t,uid)，newest-first 含 uid 平局）；`listMessages` / Bearer `/v1/messages` 仍为 Inbox（TO 匹配）。
2. 详情 ACL：`getMessage` / `setMessageSeen` / 新 `getMessageSource` 按 TO∨FROM 可读，Sent 点开不再 404。
3. `GET /ui/api/messages` 扩展 `folder` + `nextCursor`；未知 folder 与坏游标 400；identity 读他人 403 且不碰 IMAP。
4. 新增 `GET /ui/api/messages/:id/source`：同 message ACL、256KiB 截断 + `truncated`/`byteLength`、`Cache-Control: no-store`；列表永不预取。
5. Inbox UI：左栏 identity + 仅 Inbox/Sent/All Mail（无 Scheduled/Trash）；桌面三栏；详情 Rendered/Plain/Source；OTP/links 置顶；宽屏元数据抽屉、≤1100px 折成 Headers tab；定制空态带可执行下一步。
6. 移动端层级：folders → list → detail；应用 Back 与浏览器 Back 都走 `history.back()`；History state 只放 scope/mobileView/folder/messageId，不含正文。
7. HTML 仍只进 sandbox iframe（`/ui/frame`）；Source 用 `createTextNode`。
8. `bun test`：**653 pass / 0 fail**；`bun run build` 成功。PR 1 ZCode P2 债本期不接。

## 我们遇到了哪些错误？

1. `waitForMessage` 仍调用已删除的 `listMessagesWith`，typecheck 在 `imap.ts` 报错。
2. PR1 经验：UI 模块若改成模板字符串会吞正则反斜杠，因此本期继续用 `json.dumps` 写回字符串模块。
3. `selectIdentity` 与 `refreshMessages` 必须相邻，否则 `ui-assets` 切片断言会把中间新函数算进去。
4. 独立自审 P1：已选身份快路径只改 `mobileView` 不 `pushState`，移动端 Back 会跳过 list。

## 我们是如何解决这些错误的？

1. `findMatchWith` 改为 `listMessagesPageWith(..., folder: 'inbox')`，wait 仍只等收件。
2. 用 Python `json.dumps` 补丁脚本改 shell/store/dom/router/app/inbox/css，避免手改 JSON 转义。
3. `selectFolder` 放在 `refreshMessages` 之后；`selectIdentity` 仍紧挨 `refreshMessages`。
4. 快路径在 `folders → list` 时 `syncUrlFromScope(false)`；folders 层 URL 不含 address，避免落地就把 list 路径 replace 掉。

---

## 返工第1轮（2026-08-12）

### 我们实现了哪些功能？

1. Codex P1：`loadMessageSource` 请求时捕获 `requestedSourceAddress`，await 后校验 address + UID + AbortController 世代；`sourceCache` 键含 `address`；`selectIdentity` / `selectMessage` abort 在途 Source。静态闸钉死跨身份同 UID 场景。
2. ZCode P1-2：同步 `docs/security.md`、根 `README.md`、`packages/api/README.md`——`setMessageSeen` ACL 为 TO∨FROM（Sent 点开并标已读所需），不再写「只能 flag 发给自己的邮件」。
3. ZCode P1-1：不改 Source 实现；`docs/security.md` 记录 identity 可读自身 Sent 源码（含 Received 链），属 #26 PR 2 设计决策。
4. `bun test`：**654 pass / 0 fail**（原 653 + 1 新闸）。
5. 独立自审 agent `d6d1fd6a-b643-47cb-97ef-633ec89cdd4d`：可合并；三条门禁均关闭；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. Codex P1（置信 0.96，真 bug）：admin 在身份 A 开 Source、切到 B、选中同 IMAP UID 的邮件，A 的迟到响应只比 UID 就写入 `state.sourceCache`，B 的 Source 页会显示 A 的原始源码（隐私）。
2. ZCode P1-2：实现已放宽 `setMessageSeen` 为 TO∨FROM，文档仍写 identity 只能 flag 发给自己的邮件。
3. ZCode P1-1：Source 对 Sent 可见含 Received 链——任务卡批准的设计取舍，实现不改，文档此前未明示。

### 我们是如何解决这些错误的？

1. 捕获请求时 address 一并校验；身份/换信 abort 在途 source；缓存 `{id, address, …}`；`ui-assets.test.ts` 切片断言 URL 用捕获地址、命中缓存比 address、`selectIdentity` 在 `waitForPreviousRefresh` 之前 abort `sourceController`。
2. 在 `docs/security.md` 新增「Inbox identity ACL（#26 PR 2）」节；API README 的 seen 404 条件改为 TO or FROM；根 README Read/unread 写明可 flag 收到或发出的信。
3. 同一 ACL 节加一句：identity 可读自身 Sent 邮件源码（含 Received 链），属 #26 PR 2 设计决策。

---

## 返工第2轮（2026-08-12）

### 我们实现了哪些功能？

1. Sent 收窄为服务端可信出站：`sendMail` / `/v1/send` 成功后把 Message-ID 写入 `DATA_DIR/sent-registry.json`（0600、tmp+rename、重启持久；FIFO 20_000 + `RETENTION_DAYS` 淘汰）。
2. 纵深防御：`messageBelongsToFolder` / `messageAccessibleToAddress` / `getMessage` / `getMessageSource` / `setMessageSeen` 共用「TO ∨ (FROM∧registry)」；伪造 From 对非收件人四入口不可见，但仍落收件人 Inbox。
3. ZCode P1-1：`getMessageSource` 按 UTF-8 字符边界截断，避免多字节序列中间产生 U+FFFD。
4. 文档同步 `docs/security.md`、根 README、`packages/api/README.md`。PR 2 其余已修部分未动。
5. `bun test`：**672 pass / 0 fail**；`bun run build` 成功。
6. 独立自审 agent `04c2b34e-4b11-4b90-8a5d-0e9535435efb`：初审有条件（P1 registry 未绑 From）；`ab558e3` 已关。

### 我们遇到了哪些错误？

1. 总指挥拍板：Sent 不能只认信封 From——伪造 From 的信会进被冒充身份的 Sent，且详情/Source/Seen 若只修列表入口仍可跨身份读改。
2. ZCode P1-1：字节截断可能切开 UTF-8 多字节序列。
3. FIFO 单测曾用 1970 时间戳，`hasSentMessageId` 按墙钟 TTL 把记录当过期（测试假阳性）。
4. 独立自审 P1：registry 只存 Message-ID、不绑定 From，抄真实出站 ID 即可让另一个 From 变成可信 Sent。

### 我们是如何解决这些错误的？

1. 出站成功才登记 **(Message-ID, From)**；Sent/详情/Source/Seen 走同一 `messageIsTrustedSent`；测试钉死伪造 From 的四入口对 fox 全空，以及抄真实 ID 也不能让另一个 From 进 Sent；owl Inbox 仍可见。
2. `truncateUtf8Bytes` 从切点回退到 leading byte，不完整则丢弃该字符。
3. FIFO 用例改用 `Date.now()` 时间戳。
4. 条目改为 `(id, from)`；`hasSentMessageId(id, from)`；补测「owl 的真实 ID + From=fox」四入口仍不可见。

---

## 返工第3轮（2026-08-12）

### 我们实现了哪些功能？

1. Codex P1：SMTP 已接受后登记失败不再否决投递。取舍是「登记失败降级为告警 + 成功返回」（宁可 Sent 少记，不可 502 重发）。`recordSentMessageIdAfterSend` 吞掉一切登记错误；`persist` 写盘失败只 `console.warn`。
2. ZCode P1：`hasSentMessageId` 读路径零写盘；过期只返回 false。`loadFromDisk` 只修剪内存。prune/persist 仅在 `recordSentMessageId` 写入路径。
3. 测试钉死：registry persist 抛 ENOSPC 时 `/v1/send` 仍 200 且 `sendMail` 只调用一次；读路径 persist hook 计数为 0。
4. `docs/security.md` 写明该取舍。
5. 独立自审 agent `178f27cc-0c38-4bf6-ab17-9810c8ed06dd`：可合并；两条 P1 均关闭；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. Codex（smtp.ts:69，置信 0.98）：SMTP 已接受后 `recordSentMessageId` 失败会让 sendMail reject → `/v1/send` 502 → 调用方重试 → 重复外发。
2. ZCode：`hasSentMessageId` 热路径同步 prune+persist，读放大写盘（并发/性能/DoS）。

### 我们是如何解决这些错误的？

1. 不选「投递前先登记再补偿撤销」——失败发送会短暂出现在 Sent，且撤销窗口更复杂。选降级：投递成功已是事实，Sent 漏记可接受。
2. 读路径删除 persist；TTL 过期不改内存，等下次 record 再 prune 落盘。

---

## 返工第4轮（2026-08-12）

### 我们实现了哪些功能？

1. ZCode P1：`loadFromDisk` 遇到损坏/半行 JSON 时告警、隔离为 `sent-registry.json.corrupt`、回退空表；读路径零异常。Inbox/详情照常，Sent 判定为空集。
2. 测试钉死损坏文件存在时 `listMessagesPage`/`getMessage` 正常返回、Sent 为空；`hasSentMessageId` 不抛。
3. `bun test`：**676 pass / 0 fail**。
4. 独立自审 agent `8f0e8b0e-8da8-4151-a890-5cdaadd8ab10`：可合并；本轮 P1 关闭；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. 损坏 registry 抛 `sent_registry_corrupt` 会击穿全部邮箱读路径（盘满/半行损坏 → Inbox 500）。fail-closed 被做成了炸掉读路径。

### 我们是如何解决这些错误的？

1. fail-closed = 判不可信（空 registry），不是抛错。隔离备份损坏文件，避免每次启动重复解析毒药。不在读路径 persist 空表。

---

## #26 PR 3（2026-08-12）

分支：`tizerluo/worker-34-pr3`  
范围：ADR §PR 3（30 天 Notifications 完整闭环）

### 我们实现了哪些功能？

1. 新建 `DATA_DIR/notification-log.jsonl`：schemaVersion/id/publishedAt/source/logicalTarget/logicalChannel/level/title/message/tags/sensitive/identityAddress?/delivery=sent；0600、目录 0700、单写者 promise 队列；不写物理 ntfy topic/secret。
2. 埋点落在 `NtfyNotificationService.publish()` 成功路径内（ntfy 成功响应后、返回前）。watcher / manual `/v1/notify` / task trusted delivery / `verify()` 的 `this.publish` 自调用四来源同一埋点；失败与 `beforeSend` 取消不写。
3. 送达优先：append 失败打 `[notification-log] HIGH:` 告警，publish 仍成功；不得先记后发、不得把失败冒充成功。
4. 启动 + 每日 UTC 午夜清理 `publishedAt < now-30d`（`.tmp` + fsync + atomic rename）；查询硬加 30 天下界。末尾半行隔离到 `.partial` 并报警；中间损坏 fail-closed。
5. 新 UI API：`GET /ui/api/notifications`（channel/level/日期/cursor/limit 20|50|100）、`GET /ui/api/notify/summary?date=today&tz=`（回显区间）、`GET /ui/api/notify/diagnostics`、`POST /ui/api/notify/verify`（镜像 Bearer 权限+限流）。identity 强制自身 agent channel；admin 全实例。
6. Notifications 页：筛选/分页、sensitive 默认 `•••` 逐条展开不持久化、顶部今日小结；Overview 两张通知数字卡与小结同一 summary 源；旧 12h ntfy history 保留为 transport cache fallback。不回填 12h 到 30 天日志。
7. `docs/security.md` 与 `packages/api/README.md` 同步 DATA_DIR 运维说明。
8. `bun test`：**699 pass / 0 fail**；`bun run build` 全绿。

### 独立自审后的修补（同一 PR）

1. JSONL 首测改为按行 `JSON.parse`，并 `beforeEach` reset，避免与 `main.ts` 维护循环/其它文件共享进程单例时把整文件当一个 JSON。
2. `appendNotificationLog` 写盘前先 `inspectAndRepairSync()`，末尾半行先隔离再追加，避免粘成中间损坏。
3. 12h transport cache fallback 无可靠 `sensitive` 标记，默认走 `•••` 遮蔽。
4. 补 UI cursor 翻页与目录 0700 测试。

### 我们遇到了哪些错误？

1. `/v1/notify` 给 mock service 传入 `identityAddress: undefined` 导致既有精确相等断言失败。
2. Overview cycle 增加 summary 请求后，generation 守卫出现次数从 4 变成 6，静态契约未同步。
3. 游标测试在 `nextCursor=null` 时仍查询，被当成首页重放。

### 我们是如何解决这些错误的？

1. 仅在 agent target 时附带 `identityAddress`；断言补上 source/logicalChannel/sensitive。
2. 更新 ui-assets 契约为 6 次 generation 比较，并钉死 Notifications today / Urgent today 与 `/ui/api/notify/summary`。
3. 用 21 条 + limit 20 覆盖翻页与跨筛选 cursor 拒绝。

---

## #26 PR 3 返工第2轮（2026-08-12）

### 我们实现了哪些功能？

1. Codex P1：append 前若文件非空且不以换行结尾——完整合法末行先补 `\\n`，半行仍先隔离再写。避免「缺末尾换行的完好记录」与下一次 append 粘成中间损坏，导致 30 天日志 fail-closed。
2. Codex P2：`zonedDayBounds` 拒绝不存在的日历日（如 2 月 30 日、非闰年 2 月 29 日）。JS Date 不再把非法日滚到另一天；summary 回显区间不变，非法日期走既有 400。
3. 测试钉死：缺末尾换行的完好文件 append 后两行均可 `JSON.parse`、查询可读；`2026-02-30` 的 zonedDayBounds 抛 RangeError，UI summary 400 且不回显滚后的 3 月。
4. `bun test`（packages/api）：**702 pass / 0 fail**；`bun run build` 全绿。
5. 独立自审 agent `8543835d-3784-411a-bc6d-6b3159493479`：可合并；No findings；Codex P1（缺末尾换行粘连）与 P2（非法日历日）均关闭。

### 我们遇到了哪些错误？

1. 上轮只在 append 前调用 `inspectAndRepairSync`。`parseFileText` 把「完整 JSON 但缺最终换行」当完整行收下，却不重写文件；随后 `appendLineSync` 把新 JSON 直接粘在旧 JSON 后面，下一轮解析变成中间损坏。
2. `date=2026-02-30` 过 `YYYY-MM-DD` 正则后被 `Date.UTC` 归一成 3 月 2 日，摘要区间误导。

### 我们是如何解决这些错误的？

1. `inspectAndRepairSync`：无 trailingPartial 且 raw 非空不以 `\\n` 结尾时，`appendMissingFinalNewlineSync` 只补换行（不走 persistHook）。半行路径仍隔离 + 原子重写。
2. 解析出年/月/日后用 UTC 日历回读校验，对不上则 `RangeError('invalid_date')`；路由已映射为 400。

---

## #26 PR 3 返工第3轮（2026-08-12）

### 我们实现了哪些功能？

1. Codex P1：sidecar（`.partial`）未持久写成功时中止 repair 并抛错，主日志一字不动，绝不丢掉尾行。
2. ZCode P1-1：config 层用 `createHmac('sha256', taskSigningSecret).update('notify-cursor-v1').digest()` 派生 `notifyCursorSecret`，不新增 env。通知游标与 task/mail 游标不同钥；旧 notify 游标失效可接受。
3. 测试钉死：sidecar 为目录导致 EISDIR 时 query/append 均失败且主日志字节不变；用 taskSigningSecret 重签的旧游标 `invalid_cursor`；派生密钥与 task 密钥不相等。
4. `bun test`（packages/api）：**705 pass / 0 fail**；`bun run build` 全绿。
5. ZCode「append 前全量解析」性能观察本期不扩 scope，记债（见回执）。
6. 独立自审 agent `38b16cb4-9d8c-432e-a989-5295d32b0359`：可合并；No findings；Codex P1 与 ZCode P1-1 均关闭。

### 我们遇到了哪些错误？

1. 隔离尾行到 `.partial` 失败时 catch 只记日志，仍 `writeAtomicSync` 截断主日志，隔离机制要保的数据被丢掉。
2. 通知游标 HMAC 直接复用 `taskSigningSecret`（可能 fallback `SMTP_PASS`），跨用途泄漏放大。

### 我们是如何解决这些错误的？

1. sidecar write+fsync 成功后才告警并重写主日志；失败则 `partial_isolate_failed` 后原样抛出。
2. 派生域分离子密钥，encode/decode 改走 `config.notifyCursorSecret`。

---

## #26 PR 3 返工第4轮（2026-08-12）

### 我们实现了哪些功能？

1. Codex P1：`zonedDayBounds` 改为迭代求解当地午夜 UTC，并验证墙钟落在目标日 00:00；偏移在 guess 与午夜之间切换则按墙钟差重算。当地 00:00 被弹簧向前跳过时，取该日第一个可表示瞬间。
2. 测试钉死：Australia/Lord_Howe 2026-04-05（不再算出 00:30）与 2026-10-04（不再算出前一天 23:30）；America/Santiago 2026-04-05 / 2026-09-06 整小时转换日；Asia/Shanghai 与 UTC 不回归。
3. `bun test`（packages/api）：**706 pass / 0 fail**；`bun run build` 全绿。
4. 独立自审 agent `509117a0-ce70-4661-8726-cb7ef72e9379`：可合并；No findings；Codex P1（DST 午夜偏移）关闭。

### 我们遇到了哪些错误？

1. 一次性 `start = guess - offsetAt(guess)` 在本地午夜与 guess 之间发生 DST 切换时用错一侧 offset。Lord_Howe 半小时 DST：4 月 5 日算出当地 00:30，10 月 4 日算出前一天 23:30，summary 漏算/多算半小时。

### 我们是如何解决这些错误的？

1. `utc := asUtc - offsetAt(utc)` 迭代至不动点，再用 Intl 墙钟校验。不对则按 `asUtc - gotAsUtc` 重算；仍非 00:00 但已在目标日则接受（跳过的午夜）。

---

## #26 PR 3 返工第5轮（2026-08-12）

### 我们实现了哪些功能？

1. ZCode P1-1：`GET /ui/api/notifications` 的 `limit` 在 schema 层用 `z.union` 字面量 `'20'|'50'|'100'`（缺省 `'20'`），非法直接 400。不再 `z.coerce.number()` 后再白名单兜底。
2. 测试钉死 `limit=20.5` / `999` / `abc` 全 400；`limit=50` 仍 200。
3. ZCode P1-2（sensitive 服务端全量返回）按 ADR 既定设计不动，回执引用 ADR 原句分流。
4. `bun test`（packages/api）：**707 pass / 0 fail**；`bun run build` 全绿。
5. 独立自审 agent `0b8c9a88-d76d-4337-9f77-b6197232c4a7`：可合并；No findings；ZCode P1-1 关闭。

### 我们遇到了哪些错误？

1. `z.coerce.number().int()` 让任意整数进入后续比较；越界/非字面量合法域没卡死在 schema。

### 我们是如何解决这些错误的？

1. 查询串按字符串白名单解析再 `transform` 成 `NotificationLogLimit`；路由去掉第二道 `isNotificationLogLimit` 兜底。

---

## #26 PR 4（2026-08-12）

### 我们实现了哪些功能？

1. Tasks 工单板服务端化：`GET /ui/api/tasks?status=&period=&limit=&cursor=` 返回 `{tasks,nextCursor,totalApprox,queryNow}`。默认 `status=active`（submitted+working）。period=`24h|7d|14d|30d`，limit=`20|50|100`。opaque HMAC cursor 绑定 `(updatedAt,id,status|period|viewer)`，跨筛选串页 `invalid_cursor`。terminal 仅 `updatedAt>=now-30d` 可见，不删 IMAP。IMAP 全扫后过滤切页 + 30s 短缓存；`queryNow` 服务端一次取值。
2. 超时标红：submitted 以最后 submitted 事件/createdAt+4h，working 以最后 working 事件+24h；input-required 不按这两条标红。服务端返回 `overdueReason/overdueAt`。
3. 详情：状态时间线 + 可折叠任务原文；RESULT object 渲染键值表，非 object 安全格式化。admin 关闭显示 Closed。
4. `POST /ui/api/tasks/:id/reply`：仅 input-required 写 working。identity=自身；admin 必须显式选任务中的本方 from。
5. admin 催办 `POST /:id/remind`：新 event kind `reminder`（独立 HMAC，不伪装 working），幂等 key + 15s 冷却，不改 task.state；已 terminal 409。
6. admin 关闭 `POST /:id/close` `{reason}`：terminal failed + `{closed_by_admin,reason}`；已 terminal 409；前端二次确认。
7. 顶部 tabs：Active / Input required / Completed / Failed / All，默认 Active；period×limit + Load more。
8. Bearer `/v1/tasks?state=` 保持 MCP 兼容。Trust-30d / cookie Path / Origin / body-limit 未改。不迁移权威存储。
9. `bun test`（packages/api）：**727 pass / 0 fail**；`bun run build` 全绿。1k/10k 内存 filter+sort+page 基准：1k 15ms/10 页，10k 3274ms/100 页（全量翻完；短缓存只减重复 IMAP 解析）。

### 我们遇到了哪些错误？

1. 旧 UI 契约钉死客户端 `TASKS_RENDER_LIMIT=500` 与 `?state=`；默认列表精确等于 `{tasks:[TASK_A,TASK_B]}`，而 TASK 日期在 2024，会被 30d/active 滤掉。
2. `TaskService` 新增方法后，Bearer 路由测试的 in-memory mock 缺 `listBoard/reply/remind/close` 无法通过类型/运行。
3. `export { encodeTaskBoardCursor }` 仅再导出时，本文件调用处出现 `ReferenceError: encodeTaskBoardCursor is not defined`（Bun 对 import+re-export 同名绑定的作用域）。
4. `expect().rejects.toBeInstanceOf(InvalidTaskCursorError)` 曾因从 `tasks.ts` 取到 `undefined`（未 re-export）失败。
5. 静态测试 `UI_JS` 含 `'/ui/api/tasks'` 字面量，改成 `'/ui/api/tasks?' + params` 后引号边界对不上。

### 我们是如何解决这些错误的？

1. 工单板改走 `listBoard`；fixture 改到 2026-08；UI 改为 tabs + 服务端分页；更新 `ui-assets` / `ui-tasks` 契约。
2. Bearer mock 补齐新方法，行为仍走原 `list/get/update`。
3. 本文件改 `import * as taskBoardCursor` 再调用；对外仍从 `task-cursor.ts` re-export。
4. 测试改为从 `task-cursor.ts` 导入 `InvalidTaskCursorError`。
5. 静态断言改为 `'/ui/api/tasks?' + params.join('&')`。

---

## #26 PR 4 返工第1轮（独立自审 P1/P2）

### 我们实现了哪些功能？

1. **P1：** `updatedAt` 改为权威状态事件与 reminder 的较新者，terminal 之后重放的 submitted/working 不再刷新 30 天可见窗。
2. **P2：** reply/remind/close 文本上限改为 3000，对齐 `/ui/api/*` 4KiB body-limit；前端 textarea/input `maxLength=3000`。
3. 测试：terminal 重放不改 `updatedAt`；超长 reply 400。
4. 独立自审 agent `256c0f59-1127-4c31-a542-073ec593a728`：初审 block；修补后再审 **mergeable**，P1/P2 closed。

### 我们遇到了哪些错误？

1. 催办为把工单顶到列表前，曾把 `updatedAt` 设成 IMAP 最后一封（含 terminal 后的旧状态重放）。
2. zod 允许 1MB reply body，但 UI Origin 入口仍是 4KiB，超限会先 413。

### 我们是如何解决这些错误的？

1. `boardUpdatedAt()` 只看 current 状态事件与 `kind=reminder`。
2. 不改全局 body-limit；把 UI 任务 mutation 字段钳到 3000。

---

## #26 PR 4 返工第2轮（Codex P1 + ZCode P1-1/P1-2）

### 我们实现了哪些功能？

1. **Codex P1 / ZCode P1-1：** `replyTask` 的 `input-required` 检查与 working 写入改到同一把 per-task 锁内。抽出 `updateTaskUnlocked`（禁止再套 `withTaskLock`，避免同 id 死锁）；`updateTask` 仍加锁后走内部路径。`closeTask` 的 terminal 预检一并收进同一把锁。
2. **ZCode P1-2：** 抽出 `toUiTaskView`（Task 公开字段 + overdue）。`GET /ui/api/tasks/:id` 与 `reply/remind/close` 成功体都走 `presentUiTask`（ACL + 同一投影），不扩权限、只收口服务层附加键。
3. 测试：并发双 `replyTask` 只有一条 working 事件、另一个 `task_not_input_required`；identity mutation 返回体与 GET `:id` 同键、不含 `adminInternal`/`peerMailbox`/对端线程。
4. `bun test`（packages/api）：**731 pass / 0 fail**；`bun run build` 全绿。
5. 独立自审 agent `00afac4e-7313-42e7-bab9-0f344609621c`：`2ce2e1b..028cd45` → **mergeable**；①② **closed**；无新 P0/P1/P2。

### 我们遇到了哪些错误？

1. 锁外 `getTask` + `state !== 'input-required'` 后调 `updateTask`：并发两个 reply 都过检，锁内只拦 terminal，会写出第二条 working。
2. 若在 `replyTask` 外再包一层 `withTaskLock` 再调 `updateTask`，同 id 锁会死锁（CodeRabbit 已警告）。
3. mutation 直接 `c.json(service.*)` 回显全量 Task（含服务层附加键），与 GET `:id` 的 viewer 投影不一致。

### 我们是如何解决这些错误的？

1. 持锁读 → 断言 `input-required` → `updateTaskUnlocked` 写 working；发信走 `deliverMail` 可注入缝，单测用内存目录钉死竞态。
2. GET/mutation 共用 `toUiTaskView` 白名单字段，identity 对非参与者仍 403 且 body 不含线程内容。





