# REST API reference

**Moved:** this document now lives at https://openagent.email/docs/reference/api/

The website docs are canonical — edit them in the [website repo](https://github.com/openagentemail/website) (`src/content/docs/docs/`).

## OAuth Authorization Server（P3，本仓增量）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/.well-known/oauth-authorization-server` | RFC 8414 AS 元数据（公开） |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 PRM；`authorization_servers` = AS issuer |
| GET | `/authorize` | 302 → `/ui/oauth/authorize`（cookie path=/ui） |
| GET/POST | `/ui/oauth/authorize` | 同意页（需 Dashboard 会话）；回跳一律带 `iss`（RFC 9207） |
| POST | `/oauth/token` | `authorization_code` + PKCE S256；`refresh_token` 轮换 |
| POST | `/oauth/revoke` | RFC 7009 |
| GET | `/ui/oauth/grants` | 兼容书签：需 Dashboard 会话，302 → `/ui/configure/clients` |
| GET/DELETE | `/ui/api/oauth/grants[/:id]` | 列表 / 吊销 |
| POST | `/ui/api/oauth/grants/:id/revoke` | 管理页表单吊销（同 origin + session；成功 302 回列表） |

预鉴权 IP 限量（应用层）：`OAUTH_RATE_PER_MIN` 覆盖上表 `/authorize`、`/oauth/token`、`/oauth/revoke`；`MCP_PREAUTH_RATE_PER_MIN` 覆盖 `POST /mcp` 无/坏 token 的 401 挑战。超限 `429` + `Retry-After`。键见 `TRUST_PROXY_HEADERS` / docs/security.md。

不做：DCR（`/oauth/register`）、OIDC discovery、admin 级 OAuth 票。

## Token rotation breaking change (PR #129 / #130)

- `POST /v1/identities/:address/token`:
  - **空请求体（Empty Body）**：保留该身份当前已有 scopes 限制（安全收紧方向：避免因请求体缺失而意外重置铸造出全权票）。
  - **显式 `{"scopes": null}`**：重置恢复为无限制的全权限身份票（legacy unscoped full power）。
  - **显式 `{"scopes": [...]}`**：以指定 scopes 数组替换现有权限集合（传入 `{"scopes": []}` 签发无 API 操作权限的受限票）。

## Outbound webhooks

Pending retries are rebuilt from the delivery log on restart; events emitted while the process was down are not reconstructed (D7, the same weak-restart semantics as ntfy).

**`WEBHOOK_LOG_MAX_ROWS`（默认 `100000`）** 只约束进程内 delivery-log 索引行数（磁盘 `webhook-deliveries.jsonl` 仍由 `WEBHOOK_LOG_RETENTION_DAYS` 压缩）。边界：① 内存逐出区 `deliveryId` 上 `redeliver` → `404 delivery_not_found`（盘行可能仍在）；② 深分页游标落在逐出区 → `400 invalid_cursor`，客户端应回首页；③ 某 webhook 的全部行均已被内存逐出时，`lastDelivery` 显示 `null`（内存视图降级，盘数据仍在）。

## Multi-domain identities and ntfy agent routes (#134)

Same localpart may exist on different configured domains (no cross-domain `409 localpart_conflict`). New identities provision ntfy agent routes under the full address key (`agent:<localpart@domain>` lowercase); legacy bare-localpart keys remain readable via exact-then-fallback lookup. Prefer full addresses when notifying; bare localpart without a legacy key is `unknown_agent` when the name is ambiguous across domains.

## Messages API (`GET /v1/messages`) 前向追补合同

### 排序与完整性契约
- **响应内排序**：单次响应内的 `messages` 列表严格按 `(receivedAt, uid)` 元组升序排列（oldest-first）。
- **跨页排序与完整性**：跨页**不承诺全局元组序**（由于 IMAP `APPEND`/`COPY` 历史导入等可能导致非单调 `INTERNALDATE`）；系统承诺的是**完整性**——在当前信箱代际内，严格大于初始传入游标元组的所有匹配邮件，每封恰好送达一次（无损追补，不重不漏）。
- **游标连续性与永不为 null**：`since` 前向查询的 `nextCursor` **永不返回 null**。当候选集全部扫尽或单批未达 `limit` 时，仍返回携带已检视最新进度 `scanUid` 的 checkpoint 游标，供客户端后续轮询继续向后追补，杜绝因回退重用旧游标而引发的终批邮件重复投递。
- **消费方自排**：对全局有序有强依赖的消费方，应遵循 RFC 0001 §8.4 口径，在消费端按 `(data.receivedAt, data.uid)` 进行二次排序。
- **代际保护**：游标严格绑定 `uidValidity`；若信箱代际变更（UIDVALIDITY 不匹配），请求将 fail-closed 返回 `400 invalid_cursor`。`GET /v1/messages/:id` 支持可选的 `?uidValidity=` 参数，代际不匹配时返回 `404 stale_message_generation`。
- **服务端 SINCE 与 receivedAtMs 口径差异说明**：服务端 IMAP SEARCH SINCE 依据 RFC 3501 `INTERNALDATE` 检索（向前预留 1 天缓冲）；应用层 `receivedAtMs` 优先采用 `INTERNALDATE` 并回落至 `ENVELOPE.date`。若个别邮件缺失 `INTERNALDATE` 且其 `ENVELOPE.date` 晚于实际收信时间，此口径差异为 fail-safe（只漏不越权，后续追扫覆盖）。

## Dashboard 后向列表游标（mail-cursor-v2 / #144）

- Dashboard `GET /ui/api/messages` 的分页游标现为 **`mail-cursor-v2`**：HMAC 绑定 `folder`、`address`、`(receivedAtMs, uid)` 与 **canonical 正整数 `uidValidity`**。`nextCursor` 只绑定本次已验证的选中信箱代际。
- **旧 `mail-cursor-v1` 一律作废**：解码 fail-closed（`InvalidMailCursorError` / `invalid_cursor`），无 v1 fallback、不从载荷推断代际。客户端必须丢弃旧游标、**不带 cursor 从第一页重新开始**。
- 同一已 SELECT 的 INBOX 会话里，**search/fetch 之前**必须读到当前合法代际；缺代际（含首页无 cursor）或与游标代际不符均失败。空信箱同样先校验代际，再决定是否 search。
- 排序、folder 过滤、`SCAN_BACK`、ACL、限速与成功响应形状不变。前向 `since` / `mail-fcursor-v1` 协议不变。不扩展 MessageDetail。REST **不**增加后向 `cursor` 参数。
- **HTTP 映射（Commander2262 / 2269 / R1 #196）：** codec / `listMessagesPage` 抛 `InvalidMailCursorError`（`error.code === 'invalid_cursor'`）。Dashboard `GET /ui/api/messages` 游标失效折成 **HTTP 400 `{error:"invalid_cursor"}`**（与 send-log / notify / task 及公开 `/v1` 游标口径一致）；**schema 校验失败仍为 `400 {error:"invalid_request"}`**，两码不混。REST **不加**后向 `cursor` 参数。普通 `GET /v1/messages`（无 `since`）与 `POST /v1/messages/wait` 在缺代际或当前会话代际不可用时返回 **400 `{error:"invalid_cursor"}`**；客户端应丢弃会话位置、从第一页/新 wait 会话重启。任务 wait（`task_create` / `task_get` `wait=true`）例外：其 IMAP 段为**丢弃式唤醒提示**，不做代际校验；权威态=签名任务快照，代际翻转不影响返回（权威 lookup=`tasks-internal.ts` waitForTaskTerminalWith；IMAP 命中丢弃后回落轮询见 `imap.ts` waitForMessage）。MCP `mail_list_messages` / `mail_wait_for` 走同一 REST，自然继承。前向 `since` 仍是 `400 invalid_cursor`。auth / 限速 / 委托撤销等其它分支不变。`POST /v1/messages/wait` 在确认调用方断开时返回 **HTTP 499 `{error:"client_disconnected"}`**（仅此新错误面，响应带 `X-OAE-Wait-Timeout-Sec`；不断开的超时仍是 408 `{error:"timeout", timeoutSec:N}` 且头/体 `N` 相等，委托撤销仍是 403）。MCP `mail_wait_for` 在 REST 每段钳制之上还有**调用方总截止**：只有完整超时身份且该段真正等到 `N` 才再武装；过早或畸形 408 立即失败，与总截止 408 文案可区分。邮件族 wait（newest-20 + from/subject）会**跳过已读匹配**，继续等到真超时或新到未读命中；task 族（`x-oa-task`）不跳过 seen。

### Caller 列表限速（#143，单实例前提）

仅 `GET /v1/messages`（普通列表与 `since` 共用同一 caller 桶）。身份键是已鉴权地址的小写形式，不是原始 token、也不是 query `address`。同一地址的 identity token 与 OAuth 凭证聚合；委托方无论轮换目标信箱都消耗**自己的**身份预算。全部 admin 凭证共享一个 `list:admin` 命名空间桶，不是无限豁免。

- **预算：** 每 caller 滚动 60 次录取 / 60 秒；进程内单调毫秒窗口，重启清零。允许一次性打满 60（突发），随后 `429` `{error:"rate_limited",retryAfterSec}` 且带整数 `Retry-After`。
- **顺序：** query schema 与 ACL（401/400/403）不消耗预算；预算在首次 IMAP 之前同步录取；下游错误（含不透明 `since` 游标失败、IMAP 失败）已录取不退款。
- **内存：** 最多 10000 个 caller 桶，每桶最多 60 个活戳。仅当**新 key** 将触顶时懒清理过期/空桶（一次检查最多扫 10000 个桶、每桶最多 60 个戳，不是“只做 10000 次常量操作”）；不驱逐仍有活戳的桶，不做后台 janitor。新 caller 在满图且无法回收时拒绝，`retryAfterSec=60` 为保守提示，不保证届时一定能入场。
- **明确不是：** 全局 IMAP 并发/耗尽保护。多身份与未纳入的路由（detail / wait / UI / MCP-direct）仍可叠加负载。多实例不共享内存桶，部署合同按单实例前提；水平扩展不会自动协调这份预算。
- **独立：** 不改 send / MCP / wait 槽位的既有桶。上面的「重启清零」只指这份列表预算。发信每小时额度在 API 启动时从 `send-log.jsonl` 回放，见下方 Send。

## Send API (`POST /v1/send`)

`{from,to,subject,text,html?,autoReply?}`。`autoReply` 只能是布尔。仅 `true` 让服务端写 `Auto-Submitted: auto-replied`；`false` 与省略不写该头，也不读、不写下面的冷却表。

身份和发件域通过之后、每小时额度之前：

- **一对一冷却**（仅 `autoReply: true`）：键是发件身份 × 每一个收件人。地址只做 trim + 小写，不剥 `+tag`，不合并点号。父代子发信时键用子地址（与每小时额度同一个发件身份）。`AUTO_REPLY_COOLDOWN_SEC` 默认 300；`0` 关闭；非整数、负数、NaN 回落 300。
- 检查通过时，同一步同步占住全部归一化后的发件身份 × 收件人对，然后才进入每小时额度和 SMTP。占位还没结束（SMTP 尚未返回）时，别的 `autoReply: true` 碰到同一对也会被拒绝。任一收件人仍在冷却或占位中，则整封 **HTTP 429** `{error:"auto_reply_cooldown", retryAfterSec}`。`retryAfterSec` 是被挡住的那些对里剩余秒数的最大值（向上取整，至少 1）；进行中的占位按剩余预留窗口计，至少 1 秒。不部分投递，不打 SMTP，不占每小时额度，不写 `send-log.jsonl`。响应不带 `Retry-After` 头（与本路由的 `rate_limited` 一样，只在 JSON 里给秒数）。
- 每小时额度若拒绝，会在写审计之前放开这次占位。连接被拒、超时、认证失败这类还没得到应答的失败同样放开占位（与每小时额度退还同一分类）。释放只删掉仍属于这次占位的格子，不会清掉已经记下的更长冷却。SMTP 接受，或对端已经返回错误应答时，截止时间改为完成时刻 + 冷却秒数。记在进程内存里，不依赖审计行追加成功。
- 内存里最多 10_000 对。只丢掉已经到期的正式冷却；未过期项和进行中的占位都不逐出。丢掉过期项之后仍放不下这次要新增的对，则整封 429 `auto_reply_cooldown`，`retryAfterSec` 为最早到期的那一项还剩的秒数（向上取整，至少 1）。不打 SMTP，不占每小时额度。
- API 启动时从 `DATA_DIR/send-log.jsonl` 重建：冷却窗口内、`autoReply: true` 且 `result: "queued"` 的行，按发件人 × 每个收件人放回内存。`sentAt` 在未来的行忽略（与每小时额度回放相同）。窗口边界恰好到期（`sentAt + 冷却 <= now`）不算。失败行和 `rate_limited` 不算。超过 10_000 对时保留最晚到期的那些对。日志没写上的那一封，重启后补不回来。

每小时额度仍然包住该身份的全部 `/v1/send`，包括自动回复。先过冷却，再扣额度。`SEND_RATE_LIMIT` 默认 20，`0` 关闭。超限 **429** `{error:"rate_limited", limit, retryAfterSec}`（同样没有 `Retry-After` 头）。进程启动把最近一小时 `result: "queued"` 的行按原时间戳回放进同一个滑动窗口，所以重启不会把额度清零；日志没写上的那一封不会被计入。任务、审批、催办、租约邮件不走这条路由。

