# RECEIPT — #26 阶段2 · PR 4

日期：2026-08-12  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr4`（禁动 main）  
HEAD：见仓库；PR：https://github.com/openagentemail/openagentemail/pull/28

## 交付

Tasks 工单板闭环已推上 PR #28。权威存储仍是 stamped IMAP 线程；不迁第二权威。Trust-30d / cookie `Path=/ui` / Origin / body-limit（4KiB）未改。Bearer `/v1/tasks?state=` 保持 MCP 兼容。

## 验收证据（ADR §PR 4 + T1/T2）

| 项 | 结果 |
|---|---|
| status×period×limit 翻页，跨筛选 cursor 拒绝 | 通过（24h/7d/14d/30d × 20/50/100） |
| terminal 超 30 天不可见 | 通过（注入时钟；不删邮件） |
| 4h/24h 超时；input-required 不标红 | 通过（`overdueReason/overdueAt`） |
| identity ACL | 通过（参与者可见；非参与者列表空 / 详情 403） |
| admin-only remind/close | 通过（identity 403 `admin session required`） |
| 已 terminal 409 | 通过（remind/close） |
| reply 仅 input-required | 通过（否则 409）；identity 不能冒充 from |
| reminder 不改 state；IMAP 可重建 | 通过（`kind=reminder` + 独立 HMAC） |
| UI Closed 而非执行失败 | 通过（`closed_by_admin` → Closed） |
| 前端二次确认 | 通过（`confirmCloseTask` + 现有 confirm modal） |
| API 测试 + build | `bun test` **729 pass / 0 fail**；`bun run build` 全绿 |

## 1k / 10k 基准（内存 filter+sort+page，非 IMAP 扫描）

ADR：短缓存只减重复解析，不能让首次 scan 变成 O(page)。本基准对已重建的 task 对象做过滤/排序/切页并翻完全部页：

| 规模 | 全量翻页耗时 | 页数（limit=100） | totalApprox |
|---|---|---|---|
| 1k tasks | **15 ms** | 10 | 1000 |
| 10k tasks | **3012–3274 ms** | 100 | 10000 |

10k 全量翻完约 3s，因为每页重新 filter 全表（O(pages×n)）。单页 list 远低于此。未建 summary index；IMAP 仍是权威。

## 独立自审

- **禁止自审自。** 新 subagent agent id：`256c0f59-1127-4c31-a542-073ec593a728`
- 初审 verdict：**block**（P1 `updatedAt` 重放；P2 1MB vs 4KiB）
- 修补后再审同一 agent：`git diff af2c857..d0f952e` → verdict：**mergeable**；P1/P2 **closed**；无新 P0/P1
- ZCode `zcode_pr_review` 本轮 MCP 超时，未出报告。

## 桌面 / 移动布局自测（不拍屏）

未开真浏览器拍屏（线上截屏由指挥做）。依据 shell + CSS：

- **桌面：** Tasks 双栏保留；顶部 tabs（Active / Input required / Completed / Failed / All，默认 Active）+ period `24h|7d|14d|30d` + limit `20|50|100` + Load more。overdue 行左侧红条 + Overdue 文字（不只靠颜色）。详情：可折叠 Original request、RESULT 键值表、input-required 回复框、admin Remind/Close（Close 走 confirm modal，文案 Closed）。
- **移动（≤820px / 375 目标）：** 仍为 list → detail 层级；`tasks-list` / `tasks-detail` 互斥；tabs/select/主按钮 `min-height: 44px`；Load more 44px。未改 Inbox 三栏/Back 栈。指挥请在 1280 与 375 各拍 Tasks 列表+详情。

## 未卡住项

无。指挥合入前请看 CI 是否已吃到 P1/P2 修补提交。

---

## 返工第2轮（2026-08-12）

指挥合流：Codex P1 + ZCode P1-1（`tasks.ts` reply 锁外 TOCTOU）与 ZCode P1-2（mutation 回显全量 Task）。

| 项 | 值 |
|---|---|
| 功能 commit | `028cd45` `fix(api): serialize task replies and project mutation responses` |
| 测试 | `packages/api` `bun test` **731 pass / 0 fail**；`bun run build` 全绿 |
| 独立自审（新 agent，禁止自审自） | `00afac4e-7313-42e7-bab9-0f344609621c` |
| 审查 diff | `2ce2e1b..028cd45` |
| 结论 | **mergeable**；P0/P1/P2 **无** |
| ① Codex P1 / ZCode P1-1 | **closed** — `replyTask` 在同一把真实 `withTaskLock` 内重读并断言 `input-required` 再走 `updateTaskUnlocked`；未嵌套加锁；并发测试 1 条 working + 1 条 `task_not_input_required` |
| ② ZCode P1-2 | **closed** — GET `:id` 与 reply/remind/close 成功体共用 `presentUiTask` → `toUiTaskView`；identity 对非参与者 403 且 body 不含对端线程；附加键被裁掉 |

未改 Trust-30d / cookie Path / Origin / 全局 4KiB body-limit。未扩修 Codex 其它 P2（reminder IMAP 滞后幂等、list 缓存 stampede）。

---

## 返工第3轮（2026-08-12）

Codex 对 `028cd45` 再抓 P1：`remindTask` 在 SMTP 已接受、Dovecot 未索引时把催办前的旧 `getTask()` 当真持久化，同幂等 key 重试会重复发信并绕过 15s 冷却。

| 项 | 值 |
|---|---|
| 功能 commit | `046a395` `fix(api): keep reminder idempotency across IMAP index lag` |
| 测试 | `packages/api` `bun test` **732 pass / 0 fail**；`bun run build` 全绿 |
| 独立自审（新 agent，禁止自审自） | `54b3e18b-4817-4cdf-a29c-053ea6182bcd` |
| 审查 diff | `df3078c..046a395` |
| 结论 | **mergeable**；P0/P1/P2 **无** |
| Codex P1（IMAP 滞后 reminder） | **closed** — 仅当 `reminderIsIndexed` 才回 IMAP；否则 synthetic + `getTask` overlay；同 key 不二发，换 key 仍 15s 冷却 |

stampede 等 P2 继续记债，本轮未扩。overlay 为进程内 60s TTL；超时后若 IMAP 仍未索引，同 key 可能再发（与多实例尽力语义一致，不挡合并）。

---

## 返工第4轮（2026-08-12，收尾）

Codex 对 `25c98cf` 三条，同源 IMAP 索引滞后：reply/close overlay、terminal 后 reminder 续窗、列表未合并 overlay。

| 项 | 值 |
|---|---|
| 功能 commit | `736236e` overlay 推广 + terminal reminder 窗 + 列表合并；`af10d5a` overlay 退役 |
| 测试 | `packages/api` `bun test` **737 pass / 0 fail**；`bun run build` 全绿 |
| 独立自审（新 agent，禁止自审自） | 初审 `6d037e96-e824-44cd-9ab3-ebc314e142fc`：**block**；再审 `7e0f8a8f-7a36-4474-adbc-a2e78ab18946`：**mergeable** |
| 审查 diff | `25c98cf..af10d5a` |
| ① 状态 overlay | **closed** — 滞后双 reply / close 后再 reply 冲突被拒；并发不得在 failed 之后发 working |
| ② terminal reminder 窗 | **closed** — `boardUpdatedAt` 忽略 terminal 之后（顺序+时间）的 reminder；31d closed 单不被顶进 30d |
| ③ 列表合并 overlay | **closed** — `loadAllTasksCached` 与 `getTask` 同一 `mergeQueuedEvents` |
| ④ overlay 退役 | **closed** — IMAP 已含 working+新 input-required 时不再盖成 working |

残留记债（不挡合并）：list 30s 未合并快照 vs overlay 退役时序；`listTasks`（REST/MCP）仍不合并 overlay；stampede。未改 Trust-30d / cookie Path / Origin / 全局 4KiB body-limit。
