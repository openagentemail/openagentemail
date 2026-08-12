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
