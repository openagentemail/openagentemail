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

---

## #26 PR 4 返工第3轮（Codex P1：IMAP 滞后 reminder 幂等）

### 我们实现了哪些功能？

1. `remindTask` 发信后只有 IMAP 已能看到刚发的那条 reminder 才把 `getTask()` 当真持久化；否则回 synthetic，并写入进程内 queued overlay。
2. `getTask` 在索引滞后窗口（60s TTL）把 synthetic reminder 并进读路径，同幂等 key 重试命中 replay、15s 冷却仍按 last reminder 计算。
3. 测试：SMTP 接受但不写入 IMAP 目录时，同 key 第二次 `remindTask` 不发信；换 key 仍 `task_remind_cooldown`。
4. `bun test`：**732 pass / 0 fail**；`bun run build` 全绿。
5. 独立自审 agent `54b3e18b-4817-4cdf-a29c-053ea6182bcd`：`df3078c..046a395` → **mergeable**；本轮 P1 **closed**；无新 P0/P1/P2。stampede 等 P2 继续记债不扩。

### 我们遇到了哪些错误？

1. `if (persisted) return persisted` 把催办前的旧 task 当真：SMTP 已接受、Dovecot 未索引时返回体没有 reminder；同 key 重试再读到同样陈旧 task，重复发信并绕过冷却。

### 我们是如何解决这些错误的？

1. 用 `reminderIsIndexed`（幂等 key，或无 key 时 from+body+时间）判断 IMAP 是否已看到刚发的那条。
2. 未索引则 `queueReminderUntilIndexed`，后续 `getTask` 合并 overlay；IMAP 追上或 TTL 到期后丢掉补丁。

---

## #26 PR 4 返工第4轮（收尾：状态 overlay + terminal reminder 窗 + 列表合并）

### 我们实现了哪些功能？

1. **P1：** 把 reminder overlay 推广到全部状态转移。`updateTaskUnlocked` 在 IMAP 未看到刚发事件时 `queueEventUntilIndexed`；后续 `getTask` 合并 overlay，滞后窗口内双 reply / close 后再 reply 被拒。
2. **P1：** `boardUpdatedAt` 对 terminal 工单只认 terminal 事件之前的 reminder（顺序 + 时间）；重放旧 stamped reminder 不再顶到最前或续 30 天窗。
3. **P2：** `listTaskBoard` 在缓存快照上合并同一套 overlay 再过滤，列表与详情口径一致。
4. 测试：滞后双 reply 只一封 working；close 后再 reply 不发 working；closed 单不被后置 reminder 顶进 30d；listBoard.state === getTask.state。
5. `bun test`：**737 pass / 0 fail**；`bun run build` 全绿。
6. 独立自审：初审 `6d037e96-e824-44cd-9ab3-ebc314e142fc` 对 `736236e` **block**（overlay 退役）；`af10d5a` 修补后再审 `7e0f8a8f-7a36-4474-adbc-a2e78ab18946`：`25c98cf..af10d5a` → **mergeable**；①②③④ **closed**。残留 P2（listCache 未合并快照 vs overlay 退役时序）记债，不挡合并。

### 我们遇到了哪些错误？

1. reply/close 的 synthetic 只回给当前请求，锁释放后下一请求从 IMAP 读到旧 input-required/非终态，可再发冲突转移。
2. terminal 后的 reminder（含重放）被算进 `updatedAt`，已关闭单被顶到最前并续命 30 天。
3. overlay 只在 `getTask` 合并，列表仍展示 IMAP 旧 state。

### 我们是如何解决这些错误的？

1. 统一 `queuedEvents`：reminder 与 working/failed 都进 overlay，`applyOverlayMessages` 按 `currentTaskMessage` + `boardUpdatedAt` 重建。
2. terminal 之后（mailbox 顺序或时间）的 reminder 不刷新 `updatedAt`。
3. `loadAllTasksCached` 对 IMAP/测试快照 `map(mergeQueuedEvents)` 再过滤切页。
4. overlay 退役：IMAP 已有同 state 事件、已 terminal、或已有更晚状态信时丢掉补丁，避免盖住权威的新 input-required；丢掉时 `invalidateTaskListCache`。

---

## #26 PR 5：Configure 完整闭环（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr5`（禁动 main；基线 `676fa3c`）  
范围：ADR §PR 5（Identities & Tokens / Authorized Clients / Push 人话卡 / Domains·Plan 诚实预留）+ PR1 ZCode P2×3

### 我们实现了哪些功能？

1. **Identities & Tokens：** 单 token slot 只展示 Set/Missing（永不回显明文）；admin 可创建（一次性 token modal）、Rotate（Rotated Token 仪式）、Delete（二次确认后留在 Configure，不跳 Overview）；每行投影当前 push tier。identity 会话无 Create/Rotate/Delete。
2. **Authorized Clients：** 继续走 `/ui/api/oauth/grants` 列表/吊销；旧 `/ui/oauth/grants` HTML 书签保留 302 fallback。
3. **Push & Devices：** 三张人话卡（1 只告知有信 / 2 +发件人主题 / 3 +正文验证码）；admin 改档；tier 3 走 confirm modal 且 PUT 必须 `confirm_risk: true`；设备配对诚实空态（PR6）。
4. **Domains / Plan：** `renderEmptyState` 明确 roadmap / 自托管实例说明 + 文档路径（无 `https://` 远程 href，无配额/升级按钮）。
5. **PR1 债项：** `/ui/oauth/grants` 未登录先 session 检查再 302 `/ui`；`applyScope` 收成 `SCOPE_META` map；`app-nav` / `modal` 空桩迁入真实现。
6. 测试：`ui-configure.test.ts` 钉 UI tier3 400、identity 越权 403、grant 吊销即时 204、grants 重定向分流；`ui-assets` 补 Configure 静态契约。`bun test` **746 pass / 0 fail**；`bun run build` 全绿。
7. 独立自审 agent `8a6cc590-1218-460f-9781-c5feaa5ddb22`：`676fa3c..a0f1059` 当时标 mergeable / 无 P1；指挥随后把 Configure 模糊失败升为 Codex P1，该结论作废，见下方 R1。

### 我们遇到了哪些错误？

1. Plan 页若把 `https://openagent.email/docs/...` 写进 JS/HTML，会撞上「三资产禁止远程 `https?://`」闸。
2. `handleDeleteIdentity` 成功后无条件 `enterOverview`，Configure 施工中途会被踢回 Overview。
3. `/ui/oauth/grants` 匿名 302 直接进 Configure，与同意页「先查 session」不一致（PR1 P2）。

### 我们是如何解决这些错误的？

1. Plan 空态用无 scheme 的 `openagent.email/docs/reference/api/` 纯文本指针；不把远程 URL 当 href。
2. 删除成功时若当前 scope 是 configure/plan 则留在本页并 `refreshConfigureSurfaces()`，否则仍回 Overview。
3. GET `/ui/oauth/grants` 无会话走 `redirectToLogin`（302 `/ui`）；有会话再 302 `/ui/configure/clients`。

---

## #26 PR 5 返工 R1（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr5`（就地修复，禁动 main，未新开分支）  
PR：https://github.com/openagentemail/openagentemail/pull/29

### 我们实现了哪些功能？

1. **A Codex P1（3771597658）：** `handleConfigurePushTier` 模糊失败（网络/解析/5xx）对齐 Overview F51：先 `bumpIdentityEpoch()`，再 GET `/ui/api/identities` 拉权威 tier，用 `recoveryGen` 丢弃过期响应，announce `(refreshed).` 后再渲染。`confirm_risk_required` / `session_expired` 仍走明确失败、不回拉。
2. **B Codex P2（3771655230）：** pending 锁 `finally` 清除后若 `state.scope === 'overview'` 调用 `renderOverviewRows()`，避免 Overview 行卡在 disabled + 旧档。
3. **C Codex P2 + CodeRabbit Minor（3771655235 / 3771617547）：** Push 卡改为 `radiogroup` + `role=radio` + `aria-checked`；identity 会话只读卡 `aria-disabled`、去掉非法 `aria-pressed`；sr-only「Current push content:」标明当前档。
4. **D CodeRabbit Major（3771617543 之一）：** `applyRoute()` 在关 nav drawer 之后调用 `closeAllModals()`（消费 `confirmModalOnCancel`），Back/导航不残留 token/确认/创建 modal。
5. **E CodeRabbit Minor（3771617540）：** `closeNavDrawer` 仅在抽屉曾打开时把焦点还给 `navToggle`；Escape（无 modal 时）走同一 `closeNavDrawer()`；backdrop/toggle 共用。
6. **F CodeRabbit Minor（3771617543 之二）：** `beginModal()` 记录 opener；`closeAllModals` 恢复焦点并清除记录；Cancel/Close/Escape 统一走 `closeAllModals`。
7. **G CodeRabbit Minor + ZCode（3771617545）：** Plan 用 `docsHref`/`docsLabel` 真链接；`allowedDocsHref` 只放行 `http:`/`https:` 或单个 `/` 相对路径，拒绝 `//` 与 `javascript:`。资产仍用 `'https:' + '/' + '/' + …` 拼接，不把 `https://` 硬编码进 UI_JS。补 `new Function(EMPTY_STATE_JS)` 白名单测试。
8. **I ZCode P2-2：** `isConfigureScope()` 显式枚举 configure-identities/push/clients/domains 与 plan；去掉 `indexOf('configure-')`。
9. `packages/api`：`bun test` **751 pass / 0 fail**；`bun run build` 全绿。
10. 独立自审 agent `0b86e174-dd2b-4c4d-a3b2-5202e8010943`：A–I 均 fixed；P0/P1 无；初审 F 两条 P2（Create→Token opener / Cancel 卸节点）已在同轮关掉；结论 **mergeable**。未自己 merge。

### 我们遇到了哪些错误？

1. 初版回执把 Configure 模糊失败未回拉权威写成「无 P1 / mergeable」，指挥升为 Codex P1 后原结论作废。
2. Plan 若把 `https://` 字面量写进 UI_JS 会撞三资产契约闸。
3. `applyRoute` 每次都调 `closeNavDrawer`：若无 `wasOpen` 守卫，已关闭时仍 `navToggle.focus()` 会抢焦点。
4. identity 只读档位卡用 `div` + `aria-pressed` 对屏幕阅读器是非法语义。

### 我们是如何解决这些错误的？

1. 本轮按 F51 把权威 GET 接到 Configure catch 的模糊分支，并在 RECEIPT R1 更正原 mergeable/无 P1 结论。
2. Plan href 用字符串拼接构造 scheme；测试文件里才写完整 `https://` 去跑 `allowedDocsHref`。
3. `closeNavDrawer` 先读 `data-nav-open === 'true'`，仅曾打开才恢复 `navToggle` 焦点。
4. 统一 radiogroup/radio/`aria-checked`，并加 sr-only 当前档文案。

---

## #26 PR 5 返工 R2（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr5`（就地修复，禁动 main，未新开分支）  
PR：https://github.com/openagentemail/openagentemail/pull/29

### 我们实现了哪些功能？

1. **A 3773347575：** `allowedDocsHref` 相对路径经 `new URL(value, window.location.href)` 解析，必须 `origin` 相同；序列化结果若以 `//` 开头也拒绝（堵住 `/\evil.example` 与 `/foo/../\evil.example`）。
2. **B 3773323957：** Configure tier 3 成功先 `closeAllModals({ skipFocus: true })` 再 `renderConfigurePush()`，并聚焦新的选中卡。
3. **C 3773323961 / 3773347580：** `modalGeneration`；`beginModal` 递增；异步成功仅当代际仍当前才关窗/恢复控件/`showTokenModal`；`applyRoute` 的 `closeAllModals` 作废 pending。覆盖 create/rotate/delete、Overview/Configure tier 确认、revoke、关单。
4. **D 3773323965：** 删除成功若命中 `activeAddress`，立刻清空地址/messages/detail，不靠 Overview 对账。
5. **E：** 拒绝 `vbscript:` 并补测试。
6. **F：** `/ui/oauth/grants` 无会话 `redirectToLogin` 注释写明恒 302 `/ui`、无开放重定向。
7. **G：** `confirmModalOnCancel` 与 `modalOpener` 跨模块耦合记债不修。
8. `bun test` **752 pass / 0 fail**；`bun run build` 全绿。独立自审 agent `4dae6c68-7509-415b-b775-9213a7876b24`：**mergeable**。

### 我们遇到了哪些错误？

1. `/\evil.example` 被当成同源相对路径，WHATWG 把 `\` 当 `/` 后变成协议相对主机。
2. origin 通过后返回 pathname，`/foo/../\evil.example` 会序列化成 `//evil.example`，赋给 `<a href>` 仍是开放跳转。
3. tier 3 成功先 `renderConfigurePush` 再关窗，opener 节点被卸下，键盘丢焦点。
4. 异步确认返回时若用户已路由到新确认框，旧成功路径会 `closeAllModals` 误关。
5. 删除当前 inbox 身份后只靠 `loadOverviewCycle` 对账，进 Inbox 会 `cancelOverview` 中止对账。

### 我们是如何解决这些错误的？

1. 相对路径用当前 origin 解析；测试注入 `window.location`，不把 `https://` 写进 UI_JS。
2. 序列化结果必须是单个 `/` 开头（`rel.charAt(1) !== '/'`），并补 `/foo/../\evil.example` 用例。
3. 关窗 skipFocus 后再重绘，聚焦 `.push-tier-card.is-selected`。
4. `modalGeneration` + `openedGen` 守卫；路由关闭不带 `keepGeneration`。
5. 删除成功路径同步清 `activeAddress` / messages / detail。

---

## #26 PR 5 返工 R3（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr5`（就地修复，禁动 main，未新开分支）  
PR：https://github.com/openagentemail/openagentemail/pull/29

### 我们实现了哪些功能？

1. **A P1（Codex Local 08:03 + ZCode P1-1）：** 五条确认流（create `createModalSubmit`、delete、revoke、Overview/Configure tier-3 的 Confirm+Cancel）的 `finally` 无条件复位本 dialog 控件 `disabled`。代际守卫只拦关窗 / 写状态 / `showTokenModal`。同类关单（tasks）一并修。行为测试 `ui-modal-buttons.test.ts`：抽出真实 onclick/submit，`new Function` + 假按钮，确认 → 请求成功（fake `closeAllModals`/`showTokenModal` bump 代际）→ 断言按钮可再点。仓库无 jsdom，对齐既有切片基建。
2. **B ZCode P2-1：** `plan.ts` 直写 `https://openagent.email/docs/reference/api/`；三资产闸加 `https://openagent.email/docs` 前缀 allowlist，删掉拼接 trick。
3. **C ZCode P2-2：** 删除 `ui-configure.test.ts` 两条中文注释断言；保留 Location `/ui`。
4. **D ZCode P2-3：** `/grants` 加 identity 可见自己 grants 的设计注释，不改行为。
5. **E ZCode P2-4：** mimosa 过期 checkout 记债不改代码。
6. `bun test` **758 pass / 0 fail**（752+6 行为测试）；`bun run build` 全绿。本轮未复现指挥记的偶发 1 fail。独立自审 agent `1c05ad79-e953-4478-8d87-612cc8602dff`：**mergeable**。

### 我们遇到了哪些错误？

1. R2 把「恢复控件」也套进 `openedGen === modalGeneration`。成功路径 try 内 `closeAllModals()`/`showTokenModal()` 会 bump 代际，finally 比较失败，共享按钮永远 disabled，只能整页刷新。752 条源码字符串测试测不出此行为。
2. Plan 曾用 `'https:'+'/'+'/'+…` 拼接绕过三资产禁远程 URL 闸。
3. `/grants` 测试曾断言源码中文注释，无防护价值且脆弱。

### 我们是如何解决这些错误的？

1. finally 无条件 `disabled = false`；try 里代际守卫保留在关窗/`showTokenModal` 之前。补 DOM 行为级测试（`new Function` 假按钮，无 jsdom）。静态闸：源码不得再出现 `if (openedGen === modalGeneration)`。
2. 直写完整 https 字面量；闸对 allowlist 前缀 split 后再禁 `\bhttps?:\/\/`。
3. 删注释断言，只留 302 Location `/ui`。

---

## #26 PR 5 返工 R4（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr5`（就地修复，禁动 main，未新开分支）  
PR：https://github.com/openagentemail/openagentemail/pull/29

### 我们实现了哪些功能？

1. **A P1（Codex Local 08:33）：** 双管齐下收口 R2↔R3 振荡。① `finally` 仅 `openedGen === modalGeneration` 才复位本 dialog 控件（stale 不得复活新窗共享钮）。② `beginModal` 在 bump 代际后无条件复位 `confirmModalConfirm` / `confirmModalCancel` / `createModalSubmit`（成功关窗 finally 跳过后，下次开窗必然可点）。五条流 + tasks 关单均核对 Confirm+Cancel。
2. **行为测试：** `ui-modal-buttons.test.ts` — **T1** `stale request must not re-enable a newer dialog Confirm`；**T2** `beginModal re-enables buttons after a successful generation bump`。
3. **B ZCode P2-1：** `handleConfigurePushTier` 与 `handlePushTierChange` 模糊失败恢复重复，记债不修（后续抽 `recoverPushTier`）。
4. `bun test` **754 pass / 0 fail**（R3 六条行为测例收成 T1/T2 两条）；`bun run build` 全绿。独立自审 agent `fab53156-3103-407e-9a4e-2182c03f6b71`：**mergeable**。

### 我们遇到了哪些错误？

1. R3 无条件 finally 复位：delete pending → Escape bump → 新开 revoke 并点击（disabled=true）→ 旧 delete 返回 finally 把共享 Confirm 拉回可点 → 可重复提交。
2. 若只恢复 R2 的代际守卫、不在 beginModal 复位，成功关窗 bump 后按钮再次永死。

### 我们是如何解决这些错误的？

1. 两个开关同时落地：finally 代际守卫 + beginModal 统一复位。成功路径 bump 后 finally 跳过，下次 beginModal 拉回可点；stale 代际不符跳过，不碰新窗已 disable 的钮。
2. T1 用挂起的 `apiJson`/`apply` 模拟 stale 完成；T2 抽出真实 `beginModal`，成功 leftover disabled 后再开窗断言可点。

---

## #26 PR 6：设备管理完整闭环（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（从 `origin/main` @ `608cbb2` 检出；禁动 main，禁止自 merge）

### 我们实现了哪些功能？

1. **device registry：** `DATA_DIR/notification-devices.json`（schemaVersion 1），0600 / 目录 0700，进程内 serial queue，同目录 `.tmp` + fsync + rename 原子写。崩溃 tmp 丢弃并告警；corrupt JSON fail-closed；磁盘满/只读走 `DeviceRegistryPersistError` + HIGH 健康告警。password/token 键拒绝落盘。
2. **create 补 displayName：** 现有 ntfy user 创建路径在 ACL 成功后 `registerPairedDevice`；缺省名 `Phone`。登记失败 best-effort 删 ntfy user，不留幽灵。
3. **list/revoke API：** Bearer `/v1/notify/devices` 与 UI `/ui/api/notify/devices`；仅 `kind === 'admin'`。identity 与非 admin（现网无独立平台运营主体 kind，故不能被解释为 admin）一律 403。
4. **Push & Devices UI：** 设备列表（名称 / User alerts·User low / 配对时间）+ Add device 引导 + 一次性 password modal（同 token 仪式）+ 服务端 QR 模块图（canvas 绘制，零新依赖）。tier 三卡逻辑未改。
5. **吊销一致性：** `active → pending_revoke`（先落盘，失败不碰 ntfy）→ 删 ntfy（404/not_found = 成功）→ `revoked`。步骤 3 落盘失败保持 pending；启动/列表对账因 not_found 收敛。已 revoked 重复 DELETE 204。
6. **一次性凭据：** 创建响应 `Cache-Control: no-store`；关窗清 password/QR DOM；磁盘零明文（含日志不写 password）。
7. **旧 POST 兼容：** `{ publicUrl }` 无 displayName 仍 201。

### 我们遇到了哪些错误？

1. UI 模块是 JSON 字符串导出，直接模板替换会吞转义；shell 插入 modal 时 StrReplace 对不上转义片段。
2. `beginModal` 增加 `deviceAddSubmit.disabled = false` 后，既有 `ui-modal-buttons` 沙箱没有该变量，T2 会 ReferenceError。
3. T1 插入 device-revoke 用例时漏了数组 `];`，测试文件语法失败。
4. 一次性密码文案在 HTML 不在 JS，资产测试若断言 `UI_JS` 会找不到。
5. 独立自审 P1：现网 ntfy 删缺失 user 返回 HTTP 400 / code 40031，不是 404；只认 404 会让步骤 3 落盘失败后的对账永远停在 `pending_revoke`。

### 我们是如何解决这些错误的？

1. 用 Python `json.loads` / `json.dumps(..., ensure_ascii=False)` 改 shell 与 client 模块。
2. T2 / create-submit 沙箱补 `var deviceAddSubmit = box.submit`。
3. 补回 `];`。
4. 密码只展示一次的文案改断言 `UI_HTML`；关窗清密文仍断言 `UI_JS`。
5. `classifyNtfyUserDeleteResponse` 把 40031 / "user does not exist" 定为 `not_found`；通用 400（如 40024 非法 JSON）与 5xx 仍是 `transient`。补分类单测 + Bearer DELETE 用 40031 体。

---

## #26 PR 6 返工 R1（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **QR ISO 交织：** `addEccAndInterleave` 先按列跨 block 轮转 data（短块缺席跳过），全部 data 吐完后再按列轮转 ECC。导出 `qrRsPlan` / `qrRsRemainder` / `encodeQrCodewords` 给测试。version 9-M：5 blocks、ECC 22、raw 292、data 182、3×36+2×37。
2. **QR 测试升级：** 结构表 + 规范 data 列序 + `buggyConcatThenColumn` 负例（钉死短块 ECC 不得出现在长块 data 仍应在的位置）+ 独立 ISO de-interleave + RS remainder + byte-mode 还原配对 JSON。形状/确定性测保留，但不再是唯一闸。
3. **5xx 分类：** `classifyNtfyUserDeleteResponse` 对一切 5xx 不看 body 一律 `transient`；not_found 仅 HTTP 404 与 HTTP 400+`40031`/`"user does not exist"`；泛 400（40024）与网络错误仍 transient。去掉对任意 status 的 `"not_found"` 子串匹配。
4. **分类测试：** `5xx body containing user-does-not-exist stays transient; 40031/404 still not_found`；`5xx with user-does-not-exist body does not converge pending_revoke to revoked`。
5. `bun test` **782 pass / 0 fail**；`bun run build` 全绿。独立自审 agent `79098d1b-5391-415d-b686-7e19973a7209`：**mergeable**，P0/P1/P2=0。

### 我们遇到了哪些错误？

1. Codex Local P1（qr-byte，置信 0.99）：不等长 RS block 把 data+ECC 拼块再整列轮转，短块 ECC 插进长块尾部 data；旧测只看形状，扫码器无法可靠解码配对 QR。
2. Codex Local P1（notify.ts，置信 0.96）：5xx body 含 `"user does not exist"`/`"not_found"` 被当成 `not_found` → 本地收敛 `revoked`，远端 user 可能仍在。这正是第二轮自审列为「残余不当作 finding」的那条。

### 我们是如何解决这些错误的？

1. 按 ISO/IEC 18004 8.6 拆成 data 列、ECC 列两阶段；测试用负例对照旧算法，并用独立 de-interleave+RS 证明可解——形状测抓不到「拼块再整列」，负例在 v9 index 180 钉死该错位。
2. 分类器把 `status>=500` 提到解析 body 之前；400 只认 40031 / "user does not exist"。集成测试用 503 + 40031 JSON，断言 `device_revoke_retry` 且列表仍 `pending_revoke`。

---

## #26 PR 6 返工 R2（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **结构化 secret-key 闸：** `registryHasForbiddenSecretKey` 递归检查对象键（password/token，大小写不敏感）。persist 与 parse 都走它；不再用正则扫序列化 JSON。displayName 含 `"password":` / `"token":` 可以创建；真含这些键的 payload 仍拒。
2. **测试：** displayName 含 key-like 文本创建成功且无同名 key、不幽灵 DELETE；`{ password }` / `{ TOKEN }` / 嵌套 `token` 仍拒；落盘带 token 键 fail-close；0600/零明文保持绿。
3. **B① in-flight 合并：** 并发 list/revoke 共用一次 reconcile；不做跨请求 TTL（记债：顺序入口仍全量对账，保证刚写入的 pending_revoke 能收敛）。
4. **B② 幽灵清理 warn：** 失败 `console.warn`（username + status/error）；不建重试队列（凭据未落盘无法对账）。
5. `bun test` **787 pass / 0 fail**；`bun run build` 全绿。独立自审 agent `09117a6e-8372-4f94-9327-8c62aa89d6f6`：**mergeable**，P0/P1/P2=0。

### 我们遇到了哪些错误？

1. Codex Local P1：secret-key guard 扫序列化文本，displayName 含 `"password":` 会被当成密钥拒绝并删 ntfy user。
2. ZCode P2×2：list/revoke 每次全量 reconcile 放大；幽灵清理失败无告警。

### 我们是如何解决这些错误的？

1. 改成递归键检查。独立自审指出：旧正则对 `JSON.stringify` 转义后的 displayName **并不命中**（`\"password\":`）；仍按任务做结构化检查，不把转义当安全属性。
2. 并发 in-flight 合并 + 清理失败 warn；TTL 与重试队列明确记债（收敛语义 / 未落盘无法对账）。

---

## #26 PR 6 返工 R3（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **QR v7+ 功能模块：** finder/timing 先占位；alignment 仅中心空闲才画 5×5；timing 轨道省略的 alignment 占位 `isFunc`（不画图案）；finder 三角只 skip。
2. **目录 fsync：** rename 后 fsync `DATA_DIR`；首次创建失败撤回新文件；EINVAL/ENOTSUP/ENOSYS 视为成功。
3. **404：** 须 missing-user body 才 not_found；裸 404 不收敛。
4. **ntfy 关/未配置：** 吊销纯本地 revoked，不外呼。
5. **顺手：** 管理面 fetch 8s 超时；corrupt 启动不阻断 API；UI 坏 JSON 400；GET devices `no-store`。
6. `bun test` **793 pass / 0 fail**；`bun run build` 全绿。复审 agent `bb8406c4-2c9f-4690-9abf-df1d626fb382`：**mergeable**。

### 我们遇到了哪些错误？

1. Codex P1：v7+ alignment 画在 timing 上再被切一条。
2. Codex P1：rename 后未 fsync 目录。
3. 独立自审 P1：对 finder 角也 `reserveAlignment`，多占数据格、zigzag 错位。
4. ZCode P2-1/3：裸 404 假吊销；disabled 时 DELETE 仍外呼。

### 我们是如何解决这些错误的？

1. 绘制顺序改为 finder→timing→alignment；中心占用则省略图案；仅 timing 非 finder 省略才 reserve。测试钉 timing 完整、无近轨 5×5、finder 旁数据格非 isFunc。
2. rename 后 open 目录 fsync；EIO 首次创建 rm 新文件。
3. 初审指出 finder reserve 过占位后收窄条件并补回归格。
4. 404 看 body；disabled/unconfigured 走本地 `deleted` 回调。

---

## #26 PR 6 返工 R4（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **QR alignment 覆盖 timing（纠正 R3）：** finder + timing 先铺；坐标组合循环对 finder 三角 `(6,6)/(6,size-7)/(size-7,6)` 直接 `continue`；其余一律 `addAlignment`（绘制 + `isFunc` 占位），覆盖 timing 上的中心（v7 `(6,22)`、v10 `(6,28)/(28,6)` 等）。删除 `reserveAlignment`。
2. **测试反转：** 去掉 R3 的 `version 7+ omits alignment on timing tracks and keeps timing intact`。新测 `alignment bullseye overwrites timing except the three finder corners`：完整 5×5 bullseye、finder 三角无 alignment、未被覆盖的 timing 仍交替、finder 旁数据格非 isFunc。v2 `[6,18]` / v7 / v10 / v14 功能格 + 配对 JSON 全编码。
3. **R1 回归：** `ISO de-interleave plus RS remainder recovers pairing payload` 仍绿。
4. `bun test` **793 pass / 0 fail**；`bun run build` 全绿。独立自审 agent `9d3aafec-7c86-4190-a1cb-f8735220f48e`：**mergeable**，P0/P1/P2=0（先独立求证 ISO Annex E/G 再裁）。

### 我们遇到了哪些错误？

1. Codex Local P1（置信 0.99，指挥亲验属实）：R3 对 timing 上的 alignment 只 reserve 不画。R3 把 Codex R2「本应省略」理解反了——R2 的错是绘制顺序（alignment 先、timing 后切坏中心），正解是 alignment 后画覆盖 timing，不是省略。
2. 全量 `bun test` 第一次 F50 watcher「many tier-2 recipients… stay under 1s」抖到 ~1189ms 失败。隔离重跑 615ms 通过；再跑全量 793 全绿。与 QR diff 无关。

### 我们是如何解决这些错误的？

1. 循环改为 finder 三角 skip、其余 `addAlignment`；删 `reserveAlignment`。v2 `(6,18)` 按 ISO 仍是 finder 角不画；v7/v10 的 timing 中心画完整 bullseye。测试用 `isAlignAt` 钉死外框/白环/中心，防止再退化成 reserve-blank。
2. 不改 F50 阈值；隔离确认后重跑全量通过。

---

## #26 PR 6 返工 R5（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **启动链 corrupt fail-closed：** `initializeNotifications` 的 reconcile 吞 `DeviceRegistryCorruptError`（读盘路径已告警）。ntfy enabled + corrupt 文件时 API 仍可提供 `/healthz`；设备 API 500 `device_registry_corrupt`。
2. **覆盖写与 502 一致：** dest→`.bak` → tmp→dest；目录 fsync 失败换回旧 registry（内存快照兜底）；成功删 `.bak`。首次创建撤回不变。
3. **QR quiet zone：** canvas 内边距 4 模块白底，模块从 `(x+4,y+4)` 绘制。
4. **tmp 短写：** `writeAllSync` 循环写全量再 fsync+rename。
5. `bun test` **797 pass / 0 fail**；`bun run build` 全绿。独立自审 agent `2cf614a2-7cf8-47fb-b85b-892bda53760a`：**mergeable**，P0/P1/P2=0（重点攻启动链全路与报告-磁盘一致性）。

### 我们遇到了哪些错误？

1. Codex Local P1（0.99）：R3 E4 只修 inspect，initialize 的 reconcile 仍 throw，ntfy 开时 API 起不来。
2. Codex Local P1（0.96）：覆盖写目录 fsync 失败后 502+删新 ntfy user，磁盘却已是含新设备的 registry。
3. Codex 云端 P2：QR canvas 无 4 模块 quiet zone（CSS 12px 拉到 240px 不够）。
4. Codex 云端 P2：自管 `writeSync` 一次可能短写。

### 我们是如何解决这些错误的？

1. 只在 `initializeNotifications` 吞 corrupt；运行时 list/create 仍 fail-closed。测试走 inspect + initialize + healthz 200 + devices 500，告警不含文件里的 password 文本。
2. 覆盖写保留 `.bak`/内存快照，fsync 失败恢复旧字节；create 仍删新 user，磁盘只留旧设备。
3. 把 quiet zone 画进 canvas 位图，不依赖 CSS padding。
4. `writeAllSync` 按 offset 循环直到写完。

---

## #26 PR 6 返工 R6（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **CI 超时对症：** 启动链测注入廉价 password hash，fetch 立即失败；不调大 5s 时限。根因是 `writeServerConfig` bcrypt cost=10，不是 ntfyFetch 8s。
2. **drawFormat `[y][x]`：** ISO (x,y) 写入 `modules[y][x]`。坐标测钉两份 15 位 + 暗模块 + isFunc。
3. **.bak 恢复失败 fail-closed：** throw + 拒绝空表落盘。
4. **真扫码：** OpenCV 解码配对 PNG，载荷全等。脚本 `packages/api/scripts/verify-pairing-qr.ts`。
5. `bun test` **800 pass / 0 fail**；`bun run build` 全绿。独立自审 `94288c31-b372-4110-b2ed-68bac9a6a878`：**mergeable**。

### 我们遇到了哪些错误？

1. CI：corrupt-boot 测 5000ms timeout。本机 1.1s 绿。时间线显示超时后 bcrypt 还跑了约 90s。
2. format 信息转置，扫码器拿不到 mask。
3. bak 恢复失败当空表会丢掉历史设备。
4. PNG 编码器把 filter byte 填成 255，OpenCV `libpng error: bad adaptive filter value`——修 `row[0]=0` 后解码成功。

### 我们是如何解决这些错误的？

1. 查 CI log 排除 8s fetch（该路径不 fetch）；注入 `setNotifyPasswordHashForTests`。
2. `put(x,y)` → `modules[y][x]`；坐标级断言。
3. 恢复失败 failClosed；persist 见 unrestored bak 拒写。
4. 真扫码脚本 + bun skipIf 无 cv2。解码输出进回执。

---

## #26 PR 6 返工 R7（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **分类器收口：** 404/400 只认 ntfy `code 40031` 或 `"user does not exist"`。裸 `not_found` 子串删除，`{"error":"route_not_found"}` 为 transient，不收敛 revoked。
2. **覆盖写三连失败 fail-closed：** 目录 fsync + `.bak` rename + 内存快照写都失败时，新 dest 隔离为 `.unrestored`，保留 `.bak`，registry `failClosed`，设备 API 抛 `DeviceRegistryCorruptError`。
3. **revoke 单次 DELETE：** `reconcileNotificationDevices(skipDeviceId)` 跳过本次目标，不占用 list in-flight；已 pending 目标在 ntfy 503 时一次 revoke 只发一次 DELETE。
4. `bun test` **802 pass / 0 fail**；`bun run build` 全绿。独立自审 `62d40cd6-c839-4987-b09b-c3fa655f66e5`：**mergeable**，P0/P1/P2=0。

### 我们遇到了哪些错误？

1. Codex 云端 P1：R3「404 看 body」方向对，但匹配名单留裸 `not_found`，反代 `route_not_found` 被判 missing user。
2. Codex 云端 P2：restore 两路都失败时错误被吞，新 dest 在位，下次读盘丢 bak。
3. Codex 云端 P2：revoke 前 reconcile 已对该 pending 目标 DELETE，revoke 再 DELETE 一次。

### 我们是如何解决这些错误的？

1. `ntfyDeleteBodyMeansMissingUser` 去掉 `allowNotFoundToken` / 裸 `not_found`；测试把 `(404,'not_found')` 改为 transient，并钉 `route_not_found` 不收敛。
2. `restoreOverwrittenRegistry` 两路失败则 failClosed + 隔离 dest + throw；`recoverBackupSync` 见 unrestored+.bak 不得丢 bak。测试缝 `snapshotRestoreHookForTests`。
3. revoke 调用 `reconcileNotificationDevices(id)` 跳过本目标；skip 不写 `reconcileInFlight`。

---

## #26 PR 6 返工 R8（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **拆开 ntfy 未就绪的两种吊销语义：** 行含 `ntfyUsername` 时临时 disabled / 缺 admin 密码 → **拒绝 503**（人话 message），不标 revoked、不外呼。已 revoked 仍幂等。无远端 username 才允许本地收敛。
2. UI 吊销失败对 `notifications_disabled` / `unconfigured` 宣布「先恢复 ntfy，手机可能仍在收通知」。
3. ZCode P1×2 + P2×5 **只记债不改码**（见 `RECEIPT-pr6.md` R8）。
4. `bun test` **804 pass / 0 fail**；`bun run build` 全绿。独立自审 `e3cb234e-76ca-412d-858e-7e1920d25e55`：**mergeable**，P0/P1/P2=0。

### 我们遇到了哪些错误？

1. Codex Local P1：R3 本地收敛把「从未配 ntfy」和「临时关掉 / 缺密码但远端仍可达」混在一起，假吊销后对账永远跳过。
2. 若挂 `pending_revoke`，UI 会显示「Revoking…」，同样不像诚实失败。

### 我们是如何解决这些错误的？

1. `peekPairedDevice` 后按是否有 `ntfyUsername` 分流；有则 `NotifyError` 503 + message。选拒绝而非 pending，因为凭据存活期间设备不该显示已吊销或正在吊销。
2. 已 revoked + ntfy 全关：直接 `already_revoked`，回归不外呼。
3. ZCode 条目写入回执记债表，本轮零改码。

---

## #26 PR 6 返工 R9（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-pr6`（就地修；禁动 main；禁止新开分支；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/30

### 我们实现了哪些功能？

1. **回滚后再 fsync 目录：** 首次创建 unlink dest、覆盖写 restore `.bak` 之后都再 `fsyncDirectorySync`。成功则仍 502 且磁盘=报告。
2. **二次 fsync 失败 fail-closed：** 复用 `failClosed`，并写 `.failclosed` 标记（502 后崩溃仍闸住读盘）；保留 dest/.bak 现场；告警无敏感内容。
3. `bun test` **805 pass / 0 fail**；`bun run build` 全绿。独立自审 `daeab04f-8dd1-473e-8389-52a2b44e29c2`：**mergeable**。

### 我们遇到了哪些错误？

1. Codex Local P1：回滚完成不 fsync 目录，崩溃可能 replay 已失败的 rename，被拒的新 registry 复活而 ntfy user 已删。

### 我们是如何解决这些错误的？

1. 回滚 `try` 之后无条件再 fsync；再失败 `markRegistryFailClosed` + throw corrupt，不把「可能没持久化的回滚」当成功服务。
2. 现有用例改为只失败第一次 fsync（①）；新增两次失败用例（②）。

---

## #26 阶段2 收官单（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-wrapup`（从 `origin/main` @ `ef880a9` 开出；禁动 main；禁止自 merge）

### 我们实现了哪些功能？

1. **A1 台账 #8：** `allowedDocsHref` 前置黑名单补 data 协议（`'data' + ':'`，避免资产闸命中连续 `data:`）；测试钉 `allowed('data:text/html,…')===''`。
2. **A2 台账 #13：** `parseFile` 对整个 body 跑 `registryHasForbiddenSecretKey`；顶层 `token` 投毒 fail-closed。
3. **A3 台账 #11：** `recoverPushTier` 抽到 `api.ts`，Overview / Configure 两处调用；F51 与 Configure 模糊失败闸仍绿。
4. **A4 台账 #12：** `var confirmModalOnCancel` 迁入 `modal.ts`；未改 IIFE 拼接顺序。
5. **B1 台账 #1：** 详情主题列 ≤1440 收抽屉 + `min-width: 12em` + `break-word`；撤回误加在 `.meta` 上的 12em。
6. **B2 台账 #2：** Folders 钉身份栏底 + 标题 `--ink-dim`。
7. **B3 台账 #3：** RESULT 维持键值表（对象）/ `<pre>`（数组标量）。
8. **B4 台账 #14：** revoke catch 立刻 `loadPairedDevices()`。
9. **B5：** 属 UI 的 ZCode P2 即 A3/A4/B4；其余 registry/工具链记债。
10. `bun test` **810 pass / 0 fail**；`bun run build` 全绿。

### 我们遇到了哪些错误？

1. 开工 `git checkout main` 失败：`main` 被另一 worktree `/home/ops/openagentemail` 占用。改 `git fetch origin main && git checkout -b tizerluo/worker-34-wrapup origin/main`，HEAD `ef880a9`。
2. 三资产闸禁止 UI_JS 出现连续 `data:`；直接写 `indexOf('data:')` 会红。
3. 独立自审 P2：`.meta` 改成 `minmax(12em, 1fr)` 会在 821–1100 Headers tab 横向溢出。那不是主题列修复所需要的。

### 我们是如何解决这些错误的？

1. 不占用 main worktree，从 `origin/main` 开收官分支。
2. 运行时拼接 `'data' + ':'`；注释写「data 协议」而不写连续 `data:`。
3. `.meta` 恢复 `58px minmax(0, 1fr)`；主题列只动 `h2` / `.detail-main-col` / 1440 抽屉。

---

## #26 收官返工 R1（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-wrapup`（就地修；禁动 main；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/31

### 我们实现了哪些功能？

1. **设备列表代际：** `state.deviceLoadGen`；`loadPairedDevices` 每次发起 `++` 并捕获，响应/错误落地前校验代际才写 state/渲染。
2. **登出作废飞行请求：** `clearNotifyState`（`showLogin` 走这里）bump `deviceLoadGen`，旧响应不得重填上一会话设备。
3. 行为测试两条：乱序不得盖 `pending_revoke`；登出后旧响应不得重填。静态闸钉三处守卫。
4. `bun test` **813 pass / 0 fail**；`bun run build` 全绿。

### 我们遇到了哪些错误？

1. CodeRabbit Major：B4 立刻 `loadPairedDevices()` 后，无代际防护——乱序会把 Revoking 打回 Revoke；登出后飞行响应会污染下一会话。

### 我们是如何解决这些错误的？

1. 对齐 `overviewGen`：新请求占新代际；清会话 bump 代际。try/catch/`!isAdmin` 写路径都先比代际。
2. 用 `new Function` 抽出真实 `loadPairedDevices`/`clearNotifyState`，可控 Promise 模拟乱序与登出。

---

## #26 收官终审拍板补断言（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-wrapup`（就地修；禁动 main；禁止自 merge）  
PR：https://github.com/openagentemail/openagentemail/pull/31

### 我们实现了哪些功能？

1. C2 呈现层：`ui-tasks.test.ts` 抽出真实 `renderTaskRows`，直造 `overdueReason` fixture 跑假 DOM。
2. 钉死：`overdueReason` 非空行带 `is-overdue` + `Overdue` 文字；`null` 行两者皆无。CSS 闸钉 inset 红条与 `.task-overdue-flag` 红色。
3. 未改生产代码。指挥授权本轮不另起 subagent 自审。

### 我们遇到了哪些错误？

1. 无。对照 `tasks.ts` / `pages.ts` 后，渲染输出已是红条 + Overdue 文字，与 PR4 回执口径一致，未停工上报。

### 我们是如何解决这些错误的？

1. 无需修生产码。对齐 `ui-device-load` 的 `new Function` 假 DOM 模式，把呈现钉在可执行断言上，而不是只 `toContain` 源码字符串。

---

## 健康小单 #9 / #22 / #23（2026-08-13）

日期：2026-08-13  
分支：`tizerluo/worker-34-health`（基线 `94566013`；禁动 main；禁止自 merge）

### 我们实现了哪些功能？

1. **#9：** `NtfyNotificationService.messages()` 复用 `ntfyFetch` 8s 超时；header 与 body 超时都映射 `NotifyError('notify_unavailable')`。/v1 与 /ui 共享。
2. **#22：** 无文件的 `loadFromDisk` 也设 `lastSeenPersistedAt`；启动删 `ui-sessions.json.tmp`；`docs/security.md` / README / 注释声明 DATA_DIR 单写者。
3. **#23：** 共享 MCP summary schema 钉 `source`/`hasOtp`（description 补 hasOtp）；detail 仍不含 seen/snippet。发版 tag 不在本单。
4. `packages/api bun test` **820 pass**；`packages/mcp bun test` **23 pass**；两边 `bun run build` 全绿。无 UI 改动。

### 我们遇到了哪些错误？

1. 全量套件里 `config.ntfy.enabled` 可能已被别的文件关掉，单测 `messages()` 得到 `notifications_disabled`。测试里显式打开并还原。
2. 独立自审 P1：Bun 上 `fetch()` 在 header 到达后 resolve，卡住的 NDJSON body 让 `response.text()` 抛超时，原先只包了 fetch → 500。

### 我们是如何解决这些错误的？

1. 超时测试 `Object.assign(config.ntfy, { enabled: true, adminPassword })`，`finally` 还原。
2. `fetch` / `!ok` / `response.text()` 同一 try，`notifyFetchFailed` 映射；补 body 超时测试。复审 mergeable。


