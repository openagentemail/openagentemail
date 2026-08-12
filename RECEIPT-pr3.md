# RECEIPT — #26 阶段2 · PR 3

日期：2026-08-12  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
分支：`tizerluo/worker-34-pr3`（禁动 main）  
HEAD：见仓库；PR：https://github.com/openagentemail/openagentemail/pull/27

## 交付

30 天 Notifications 完整闭环已推上 PR #27。埋点在 `NtfyNotificationService.publish()` 成功路径内（ntfy 成功响应后、返回前）；watcher / manual `/v1/notify` / task trusted delivery / `verify()` 自调用同一埋点。不回填 ntfy 12h。Trust-30d / cookie `Path=/ui` / Origin / body-limit 未改。

## 验收证据（ADR §PR 3）

| 项 | 结果 |
|---|---|
| 各来源成功恰好写一行 | 通过（publish 测试 + watcher `source=watcher` / `sensitive`） |
| 失败/取消不写 | 通过（503 与 `beforeSend` 取消） |
| 重启保留 | 通过（JSONL 落盘 0600） |
| 31 天清理 + 查询 30 天下界 | 通过（注入时钟） |
| 末尾半行隔离；中间损坏 fail-closed | 通过；append 前也会先隔离半行 |
| 权限隔离 | 通过（identity 强制自身 agent channel） |
| tier 3 默认遮蔽 | 通过（日志路径 + 12h fallback 均默认 `•••`） |
| Overview 与 Notifications 同日同时区数字一致 | 通过（同一 `/ui/api/notify/summary`） |
| 未启用 ntfy 诚实诊断 | 通过（不返回 topic/secret） |
| API 测试 + build | `bun test` **699 pass / 0 fail**；`bun run build` 全绿 |
| DATA_DIR 运维文档 | `packages/api/README.md`、`docs/security.md` |

## 独立自审

- **禁止自审自。** 新 subagent agent id：`6650b57d-876e-43ce-97e1-97fe5e3153c5`
- 初审 verdict：**block**（CI 把整份 JSONL 当单 JSON 解析；append 可能把半行粘成中间损坏；空日志 12h fallback 明文渲染）。
- 已在同一 PR 修补并再跑全绿：按行解析 + `beforeEach` reset；append 前 `inspectAndRepairSync`；fallback 默认遮蔽；补 cursor/0700 测试。

## 桌面 / 移动布局自测（不拍屏）

未开真浏览器拍屏（线上截屏由指挥做）。依据 shell + CSS 结论：

- **桌面：** Notifications 筛选条 `flex-wrap`（channel/level/日期/20|50|100）；顶部今日小结条与 diagnostics 分行；Overview 在既有邮件卡后追加「Notifications today」「Urgent today」两张 `stat-card`，与小结同一 API。
- **移动（≤820px / 375 目标）：** 筛选 `select`/`input[type=date]` `min-height: 44px`；小结条左右 12px 边距；Reveal/Hide 按钮 44px；未改 Inbox 三栏/Back 栈。指挥请在 1280 与 375 各拍 Notifications + Overview。

## 未卡住项

无。指挥合入前请看 CI 是否已吃到修补提交。

## 返工第2轮（head `2471cc0`）

Codex 对 `b2226e5` 仍抓两条，已按语义修补并推上 `2471cc0`：

1. **P1：** append 前若文件非空且不以换行结尾——完整合法末行先补换行，半行仍先隔离再写。测试钉死缺末尾换行的完好文件 append 后不产生中间损坏、两行均可解析、日志持续可读。
2. **P2：** `zonedDayBounds` 拒绝不存在的日历日（2 月 30 日等）；`GET /ui/api/notify/summary` 非法日 400，区间回显不变（不滚成另一天）。

ZCode 已裁可以合并（P0/P1=0，P2×3 记债），本轮未另动。

`bun test`（packages/api）：**702 pass / 0 fail**；`bun run build` 全绿。

### 独立自审（禁止自审自）

- 新 subagent agent id：`8543835d-3784-411a-bc6d-6b3159493479`
- 审 `git diff b2226e5..2471cc0`
- verdict：**mergeable**；No findings；Codex P1/P2 均 **closed**

## 返工第3轮（head `ea1a28e`）

1. **Codex P1：** sidecar（`.partial`）未持久成功则中止 repair 并抛错，主日志一字不动，绝不丢掉尾行。测试：sidecar 为目录（EISDIR）时 query/append 失败且主文件字节不变。
2. **ZCode P1-1：** config 派生 `notifyCursorSecret = HMAC-SHA256(taskSigningSecret, 'notify-cursor-v1')`，不新增 env。通知游标与 task/mail 游标不同钥；旧 notify 游标 `invalid_cursor`（上线不足一天，无存量）。
3. **记债（本期不扩 scope）：** ZCode 观察 append 前全量解析 JSONL 的性能；不在本轮改存储形态或增量索引。

`bun test`（packages/api）：**705 pass / 0 fail**；`bun run build` 全绿。

### 独立自审（禁止自审自）

- 新 subagent agent id：`38b16cb4-9d8c-432e-a989-5295d32b0359`
- 审 `git diff 6a79afc..ea1a28e`
- verdict：**mergeable**；No findings；Codex P1 与 ZCode P1-1 均 **closed**

## 返工第4轮（head `7eaddae`）

**Codex P1：** `zonedDayBounds` 迭代求解当地午夜并验证墙钟。Lord_Howe 2026-04-05 为 `2026-04-04T13:00:00.000Z`（当地 00:00，不再是 00:30）；2026-10-04 为 `2026-10-03T13:30:00.000Z`（不再是前一天 23:30）。America/Santiago 整小时转换日（4-05 回拨、9-06 弹簧向前跳过 00:00）与 Asia/Shanghai / UTC 不回归。

`bun test`（packages/api）：**706 pass / 0 fail**；`bun run build` 全绿。

### 独立自审（禁止自审自）

- 新 subagent agent id：`509117a0-ce70-4661-8726-cb7ef72e9379`
- 审 `git diff 2da142c..7eaddae`
- verdict：**mergeable**；No findings；Codex P1 **closed**

## 返工第5轮（head `ed05f62`，收尾）

1. **ZCode P1-1：** `GET /ui/api/notifications` 的 `limit` 在 schema 层限定为字面量 `'20'|'50'|'100'`（缺省 `'20'`），非法直接 400。测试钉死 `limit=20.5` / `999` / `abc` 全 400。
2. **ZCode P1-2 分流（不动）：** sensitive 服务端全量返回、遮蔽靠客户端。ADR #26 原文：「响应包含 `sensitive`，但服务端仍返回授权可读内容供显式展开。」属既定设计。

`bun test`（packages/api）：**707 pass / 0 fail**；`bun run build` 全绿。

### 独立自审（禁止自审自）

- 新 subagent agent id：`0b8c9a88-d76d-4337-9f77-b6197232c4a7`
- 审 `git diff 47ccf37..ed05f62`
- verdict：**mergeable**；No findings；ZCode P1-1 **closed**



