# RECEIPT — #26 阶段 2 · PR 2

日期：2026-08-12  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr2`（基于 main `61951de`）  
禁动 main：是  
PR 1 ZCode P2×3：本期未接

## 独立自审

- 必须新 subagent，禁止自审自。
- agent id：`411d7f2e-2a53-4093-b557-077685309b2b`
- 结论：发现 **P1×1**（已选身份快路径不压 list 历史，移动 Back 跳层）。已在交 PR 前修复：folders→list 快路径 `syncUrlFromScope(false)`；folders 层 URL 不含 address。静态闸钉死 `fromFolders && nextView === 'list'` 与 `inboxOnFolders`。
- 残余风险（自审记录，非 blocker）：Bearer `GET /v1/messages/:id` 现按 TO∨FROM 可读（Sent 点开所需）；list/wait 仍 TO-only。`SCAN_BACK=500` 窗口与旧 Inbox 列表相同。

## ADR §PR 2 验收逐条证据

| 验收项 | 证据 |
| --- | --- |
| admin 可切身份 | 侧栏 `activateAddress` → `selectIdentity`；`ui-authz` admin 可读任意 address |
| identity 只能读自身（ACL 服务端强制） | `forbidUnlessAddress` 在 IMAP 之前；identity 读 owl → 403 且 `listMessages`/`source` 未调用（`ui-authz.test.ts`） |
| 三 folder 集合正确 | `messageBelongsToFolder`：inbox=TO、sent=FROM、all=TO∨FROM；Sent 不含纯收件；all 去重（`imap-match.test.ts`） |
| 未知 folder 400 | `folder=trash\|scheduled\|INBOX` → 400 且不碰 IMAP（`ui-messages.test.ts`） |
| 无 Scheduled/Trash 假入口 | `UI_HTML`/`UI_JS` 无 Scheduled/Trash；仅 Inbox/Sent/All Mail |
| 游标翻页无重复跳页 | HMAC `mail-cursor-v1` 绑定 folder+address+(t,uid)；limit=2 两页无交集；同毫秒 uid 平局；坏/跨 folder 游标 400 |
| Source 限长/no-store/截断 | `MAX_EMAIL_SOURCE_LENGTH=256KiB`；`truncated`+`byteLength`；`Cache-Control: no-store`；ACL 同详情 |
| Source text node | `createTextNode(payload.source`；无 innerHTML 闸仍绿 |
| HTML 不进 app DOM | Rendered 仍 iframe `sandbox=""` + `/ui/frame/`；detail JSON 仍剥 raw html |
| 桌面三栏 | identity+folder \| list \| detail；元数据在 detail 内抽屉，≤1100px 折 Headers tab |
| 移动逐层 Back | folders → list → detail；应用 Back = `history.back()`；与 popstate 共用栈 |
| 首屏打开邮件可读 | OTP/links 置顶；默认 Rendered（有 HTML）否则 Plain |
| Bearer `/v1/messages` 仍 inbox | `listMessages` 固定 `folder: 'inbox'`；未加 folder 查询 |
| 测试 + build | `bun test` **653 pass / 0 fail**；`bun run build` 成功 |

## 改动面

IMAP query（`imap.ts`、`mail-cursor.ts`）、`routes/ui.ts`、frame 复用、Inbox modules/tests、`dev/preview.ts`、`dev/acceptance.mjs`、README / Progress.md。

---

## 返工第1轮（2026-08-12）

- **HEAD（审查时）**：`0e97e19` `fix(api): pin source cache to identity and document Sent ACL`
- **测试**：`packages/api` `bun test` → **654 pass / 0 fail**（原 653 + 1 新闸）
- **独立自审（新 agent，禁止自审自）**：

| 项 | 值 |
|---|---|
| Subagent ID | `d6d1fd6a-b643-47cb-97ef-633ec89cdd4d` |
| HEAD 审查时 | `0e97e19` |
| 结论 | **可合并** — Source 跨身份竞态已关；seen 文档与 TO∨FROM 对齐；Sent Source/Received 仅落文档、未改实现 |
| Codex P1 | **关闭**：捕获 `requestedSourceAddress`；await 后校验 address+UID+controller 世代；缓存键含 address；`selectIdentity` 在 `waitForPreviousRefresh` 前 abort `sourceController` |
| ZCode P1-2 | **关闭**：`docs/security.md` / 根 README / `packages/api/README.md` 写明 TO∨FROM 与 Sent 理由；未改 `setMessageSeen` |
| ZCode P1-1 | **关闭**：`docs/security.md` 记录 identity 可读自身 Sent 源码（含 Received 链），属 #26 PR 2 设计决策 |
| P0/P1/P2 | **无** |

残余风险（非 blocker）：跨身份闸是静态切片契约，未模拟微任务时序；`selectMessage` 的 abort 未单独断言；`docs/security.md` 网站仓库仍为 canonical。

---

## 返工第2轮（2026-08-12）

- **功能 commit**：`a0437a2` `fix(api): treat Sent as server-trusted outbound only`
- **跟进 commit**：`ab558e3` `fix(api): bind sent registry entries to From`（关闭自审 P1）
- **测试**：`packages/api` `bun test` → **672 pass / 0 fail**；`bun run build` 成功
- **独立自审（新 agent，禁止自审自）**：

| 项 | 值 |
|---|---|
| Subagent ID | `04c2b34e-4b11-4b90-8a5d-0e9535435efb` |
| HEAD 审查时 | `a0437a2` |
| 初审结论 | **有条件合并** — 拍板①–⑤主路径关闭；P1：registry 不绑定 From |
| 跟进后 | `ab558e3` 条目改为 `(Message-ID, From)`；抄真实 ID + 另一个 From 的四入口测试已钉死 |
| ① 出站登记 | **关闭**：`sendMail` / `/v1/send` 成功写入 registry |
| ② 四入口同规则 | **关闭**：list/detail/source/seen 均走 `messageIsTrustedSent`；伪造 From 对非收件人不可见 |
| ③ 伪造信 Inbox | **关闭**：收件人 Inbox 可见，任何人 Sent 不可见 |
| ④ UTF-8 截断 | **关闭**：`truncateUtf8Bytes` 按字符边界回退，无 U+FFFD |
| ⑤ 其余不动 | **关闭**：未改 Trust-30d / cookie / 第1轮 Source 竞态 |
| P0/P1/P2（跟进后） | 初审 P1 已关；无新 P0 |

残余风险（非 blocker）：同一 From 重放已登记 Message-ID 换正文仍可能进 Sent；MTA 改写 Message-ID 会 fail-closed 不进 Sent；SMTP 成功后落盘失败会 502 但信已发出；FIFO 20_000 可能早于保留窗淘汰真出站。

### 布局自测（桌面 / 移动；本轮不拍屏）

对照 `layout.ts` / `pages.ts` 与 `ui-assets` 契约，**未改 UI CSS/JS**（本轮只动服务端 Sent ACL 与截断）。

- **桌面（>820px，典型 1280）**：`app-shell` 220px 全局 nav + `inbox-layout` 240px identity/folder + `inbox-main` 360px list | detail，三栏同时可见。≤1100px 时 identity 210 / list 320，元数据抽屉隐藏、Headers tab 出现。folder 按钮 `min-height: 44px`。**结论：桌面三栏完整，Inbox/Sent/All Mail 入口在左栏，list/detail 并排；未见叠栏或假入口。**
- **移动（≤820px，含 375）**：`inbox-layout`/`inbox-main` 改为单列；`data-mobile-view=folders|list|detail` 每次只露一层；list 藏 detail、detail 藏 list；folders 只露 identity。应用 Back / `list-mobile-back` 均为 44px；375 下 wordmark 隐藏以免挤掉 Sign out。**结论：移动为 folders→list→detail 逐层，Back 可达，无三栏并排泄漏。**

---

## 返工第3轮（2026-08-12）

- **HEAD（审查时）**：`3c69352` `fix(api): keep send success when sent-registry persist fails`
- **测试**：`packages/api` `bun test` → **675 pass / 0 fail**
- **独立自审（新 agent，禁止自审自）**：

| 项 | 值 |
|---|---|
| Subagent ID | `178f27cc-0c38-4bf6-ab17-9810c8ed06dd` |
| HEAD 审查时 | `3c69352` |
| 结论 | **可合并** |
| Codex P1 | **关闭**：SMTP 已接受后 persist/登记失败只告警；`/v1/send` 仍 200 且 `sendMail` 一次（不 502 重发） |
| ZCode P1 | **关闭**：`hasSentMessageId` / `loadFromDisk` 零写盘；prune/persist 仅写入路径 |
| 取舍 | 登记失败降级，不选「投递前先登记再撤销」 |
| P0/P1/P2 | **无** |

残余风险（非 blocker）：persist 失败时内存有、盘上可能没有，重启后该封可能从 Sent 消失（与取舍一致）；`/v1/send` 测试 mock 了 `sendMail`，smtp 真路径靠 AfterSend 双层兜底。

### 布局自测（桌面 / 移动；本轮不拍屏）

本轮未改 UI CSS/JS。桌面三栏与移动 folders→list→detail 结论同返工第2轮，无回归。

