# #319 附件能力对照矩阵（vs AgentMail）

> 内部件 · 三列 = 官方文档（dated 快照）| 我方实测（file:line + 原始输出）| 未验证  
> 代码基线：`openagentemail@fd83eb86`（worktree `tizerluo/w319`）  
> AgentMail 快照：`materials/319/agentmail-attachments.snapshot.md` @ **2026-09-22T10:58:06Z**  
> 我方探针：`materials/319/probe-attachments.ts` → stdout `probe-stdout.txt` / JSON `probe-results.json`  
> **端点注**：任务卡写 `POST /v1/messages`；本仓发信 schema 落点为 **`POST /v1/send`**（`messages` 无 POST 发信）。下表「我方实测」均打 `/v1/send`（及 MCP `mail_send`）。

| 轴 | 官方文档（AgentMail，dated 快照） | 我方实测 | 未验证 |
|---|---|---|---|
| ① 附件发送 Base64 | `attachments[]` 元素可提供 Base64 `content`（另可选 `filename` / `content_type`）。快照 §Sending。 | **无附件发送能力**。`sendSchema` 仅 `{from,to,subject,text,html?}` 且**无 `.strict()`**（`packages/api/src/routes/send.ts:41-47`）。探针 **G1**：携 `attachments[{content}]` → **HTTP 200** `{"queued":true,...}`（未知键被 Zod 静默剥离，**非**任务卡预期的 400）。SMTP 层 `sendMail` 亦不传 attachments（`smtp.ts:86-98`）。原始：`probe-stdout.txt` G1。 | AgentMail Base64 实发成功率 / 超限响应码（无对方账号，未测） |
| ② 附件发送 URL | 可提供 `url`；须无自定义 header/cookie 即可下载；允重定向与预签名；最终须 2xx。快照 §Sending。 | 同 ①：`attachments[{url}]` **G2 → HTTP 200**（剥离后当普通信发出）。无 URL 抓取逻辑。原始：`probe-stdout.txt` G2。 | AgentMail URL 抓取失败形态、重定向链边界（未测） |
| ③ 消息下载 | `inboxes.messages.get_attachment(inbox_id, message_id, attachment_id)` → 原始文件。快照 §Retrieving / From a Specific Message。 | **无下载端点**。`messages` 仅 `GET /`、`GET /:id`、`POST /:id/seen`、`POST /wait`（`messages.ts:63/94/116/150`）。探针 `GET /v1/messages/31901/attachments/att_1` → **404**。原始：`probe-stdout.txt` ROUTE-messages。 | AgentMail 下载鉴权/过期/大文件流式行为（未测） |
| ④ 线程下载 | `inboxes.threads.get_attachment(inbox_id, thread_id, attachment_id)`。快照 §From a Specific Thread。 | **无 threads 路由 / 无附件下载**。探针 `GET /v1/threads/.../attachments/...` → **404**。原始：`probe-stdout.txt` ROUTE-threads。 | AgentMail 线程侧 attachment_id 作用域（未测） |
| ⑤ 内联尺寸上限 | Inline `content`：**整请求 6 MB**（含正文+元数据+全部附件）；超限 **413**。快照表 Attachment size limits。 | **无附件内联常量**。仅有：`text`/`html` 各 ≤ **1_000_000** 字符（`send.ts:45-46`）；整请求 **16 MiB**（`limits.ts:5`）。探针 **G4a** text=1e6 → 200；**G4b** 1e6+1 → 400 `too_big`；**G4c/G4d** html 同界；**G4e** ≈17 MiB → **413** `request_too_large`。原始：`probe-stdout.txt` G4*。 | AgentMail 6 MB 边界旁路/分片（未测） |
| ⑥ URL 尺寸上限 | Remote `url`：附件合计约 **30 MB**/消息。快照表。 | **无 URL 附件路径 → 无 URL 尺寸上限**。与 ② 相同，URL 键被剥离。 | AgentMail「约 30 MB」精确阈值与错误码（未测） |
| ⑦ URL 可达性要求 | 无自定义 header/cookie；允重定向/预签名；最终 2xx。快照 §Sending 条目 `url`。 | **不适用（无实现）**。本席未测任何 URL 抓取。 | AgentMail 对私网/SSRF、cookie 注入、非 2xx 的具体拒因（未测） |
| ⑧ webhook 附件表示 | （AgentMail Attachments 页**未**描述 webhook 附件字段；本列官文 =「页面未写」。） | **仅元数据**。入站 MIME 经 `simpleParser` 得 `hasAttachments` 布尔后内容丢弃（`webhook-sink.ts:227`；payload 写入 `webhook-delivery.ts:1532`）。探针 **G5**：multipart+attachment → `data.hasAttachments=true`；`data` 键无 `attachments`/`content`/`files` 等；`leaked_content_keys=[]`。原始 payload 见 `probe-stdout.txt` G5 / `probe-results.json`。 | AgentMail webhook/实时推送是否含附件字节或仅 id（官文本页未写，**未验证**） |

### 附：MCP `mail_send`

- `inputSchema` 无 `attachments`（`tools.ts:531-548`；`tools/list` 实测 `hasAttachmentsProp=false`）。
- 携 `attachments[]` 调用 → **200 queued**（多余键剥离，同 REST）。原始：`probe-stdout.txt` MCP。

### 复现命令

```bash
# 仓根；需已 bun install（packages/api）
bun materials/319/probe-attachments.ts
# 输出：materials/319/probe-stdout.txt 、probe-results.json
```

### 源码锚点速查（我方，基线 fd83eb86）

| 主题 | 路径:行 |
|---|---|
| sendSchema（无 .strict） | `packages/api/src/routes/send.ts:41-47` |
| 成功发信 HTTP 200 | `packages/api/src/routes/send.ts:224` |
| SMTP 无 attachments 字段 | `packages/api/src/lib/smtp.ts:86-98` |
| JSON 体上限 16 MiB | `packages/api/src/lib/limits.ts:5`；`app.ts:127` |
| messages 路由面 | `packages/api/src/routes/messages.ts:63/94/116/150` |
| webhook hasAttachments 解析 | `packages/api/src/lib/webhook-sink.ts:227` |
| payload 写入 hasAttachments | `packages/api/src/lib/webhook-delivery.ts:1532` |
| MCP mail_send | `packages/api/src/mcp/tools.ts:531-548` |
| 挂载 /v1/send | `packages/api/src/app.ts:136` |

### 口径注（防误读）

1. 任务卡/R0 写「携 attachments → 预期 **400（strict schema）**」——**与今日源码不符**：`sendSchema` **未** `.strict()`；实测为 **200 + 静默丢弃**。本矩阵以实测为准，不把 R0 预期改写成「已验证兼容」。
2. 成功发信 HTTP 码为 **200**（非任务卡所写 201）。
3. 不得据 AgentMail 官文推断我方「将来兼容」或「应对齐某上限」。
