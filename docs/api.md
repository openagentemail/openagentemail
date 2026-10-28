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

## 读一封信（`GET /v1/messages/:id`）

`id` 是 IMAP UID 字符串，不是 RFC 5322 Message-ID。详情只在字段通过与 `POST /v1/send` 的 `inReplyTo` 相同的校验时带上下面两项；缺失或非法就省略该键。列表摘要和 webhook 不带这两项。`POST /v1/messages/wait` 返回的是同一份详情，因此也会带上。MCP `mail_read_message` 读的就是这条详情。

| 字段 | 说明 |
| --- | --- |
| `messageId` | 可选。这封信自己的 Message-ID，尖括号形式，例如 `<id-left@id-right>`。含尖括号最长 250。左侧是 dot-atom-text；右侧是 dot-atom-text，或方括号里的字面量。不接受引号、反斜杠、逗号、空白 |
| `references` | 可选。这封信自己的 `References` 头里通过同一校验的 id。按原顺序去重（保留第一次）。超过 50 条时保留最后 50 条。没有合法 id 则省略。不会把本信的 `messageId` 或 `In-Reply-To` 自动补进这个数组 |

## Send API (`POST /v1/send`)

`{from,to,subject,text,html?,autoReply?,inReplyTo?,references?}`。`autoReply` 只能是布尔。仅 `true` 让服务端写 `Auto-Submitted: auto-replied`；`false` 与省略不写该头，也不读、不写下面的冷却表。body 仍是 strict，幂等键不进 JSON。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `from` | 是 | 已有身份地址 |
| `to` | 是 | 一个邮箱，或 1–50 个邮箱 |
| `subject` | 是 | 主题，最长 998。服务端不会自动加 `Re:` |
| `text` | 是 | 纯文本正文 |
| `html` | 否 | HTML 正文 |
| `autoReply` | 否 | 布尔。仅 `true` 写 `Auto-Submitted: auto-replied` |
| `inReplyTo` | 否 | 一个尖括号形式的 RFC 5322 Message-ID，例如 `<id-left@id-right>`。含尖括号最长 250。左侧是 dot-atom-text；右侧是 dot-atom-text，或方括号里的字面量。不接受引号、反斜杠、逗号、空白。设置后写 `In-Reply-To`，并写 `References` |
| `references` | 否 | 1–50 个同样形式的 Message-ID。必须和 `inReplyTo` 一起给。用单个空格拼起来最长 8000。服务端按原顺序去重；若 `inReplyTo` 不是最后一项，再追加到末尾。没给这个字段时，`References` 只有 `inReplyTo` |

### 在线程里回复

调用方自己决定主题要不要写成 `Re:`。省略 `inReplyTo` 和 `references` 时不增加这两条头。这两项不读、不写自动回复冷却，也不改变每小时额度。

`inReplyTo` 必须是尖括号里的 RFC 5322 Message-ID，不是 IMAP UID。`GET /v1/messages/:id` 的 `id` 仍是 IMAP UID，不能拿去填 `inReplyTo`。

回一封收到的信：把该详情里的 `messageId` 当作 `inReplyTo`，把它的 `references`（如果有）当作 `references`。服务端按原顺序去重，并把 `inReplyTo` 追加到 `References` 末尾。详情里的 `references` 不再按发送接口的 8000 字符拼接上限裁剪；交给 `POST /v1/send` 时仍受那条限制。如果 `references` 太长，保留能放进这条限制的最后几条。回本服务发出的信时，用 `POST /v1/send` 响应（或 `GET /v1/send/history` 同一行）里的 `messageId`，它已经是尖括号形式。

格式不合法（包括只给 `references`、不给 `inReplyTo`）是 **400** `{error:"invalid_request"}`。这发生在幂等占位之前，不占键。

可选请求头 `Idempotency-Key`。缺省、只有空白，或 trim 之后为空，与不带这个头完全相同。trim 之后必须是 1–128 个可打印 ASCII（码位 0x20–0x7E，空格可以出现在中间）。控制字符、DEL、非 ASCII（含 emoji）都是 **400** `{error:"invalid_request"}`。键按发件身份分开：`from` 整段小写，与 `checkSendLimit` / `findIdentity` 相同。不同身份用同一个键互不影响。删除身份会清掉该地址在内存里的幂等项；同址新建不会继承上一任的回放。

指纹是校验后整个 body 的规范 JSON 的 sha256。`to` 收成数组并保留顺序，不排序。对象的键按字典序。地址大小写保持客户端传入的值，因为发送路径不改写已经校验过的字段。通过校验的 `inReplyTo` 与 `references` 原样留在这份 body 里（`references` 的去重和把 `inReplyTo` 补到末尾发生在写头时，不改指纹所依据的数组），因此进入 `requestHash`：同一键、相同线程参数在保留期内回放；只改了 `inReplyTo` 或 `references` 是 422。以后新增的可选 body 字段会自动算进指纹。同一身份若只改了 `from` 的大小写，指纹不同，得到 422。调用方重试时应原样重放 body。

在 body 校验和身份 / From 检查之后、自动回复冷却和每小时额度之前处理。占位在任何 await 之前同步完成：

- 24 小时内已完成、指纹相同：原样返回当时的状态码和 JSON，并加响应头 `Idempotent-Replayed: true`。不再发信，不占 `SEND_RATE_LIMIT`，不碰冷却，不新写 `send-log.jsonl`。
- 同一键、指纹不同（已完成或仍在发送）：**422** `{error:"idempotency_key_reused"}`。
- 同一键、同一指纹仍在发送：**409** `{error:"idempotency_in_flight", retryAfterSec:1}`。同一键不会发出两封 SMTP。
- 记为已完成并缓存的结果：200 成功，以及 SMTP 对端已经应答的 502（`isLocalSendFailure` 为 false，日志 `failureKind` 为 `smtp_response`）。另外，Nodemailer 的 `error.command` 已是 `DATA`、`BDAT` 或更晚（正文可能已经写出）且没有 SMTP 应答码时，幂等也缓存 502。这条仍算本地失败：每小时额度和自动回复冷却照旧退还，日志 `failureKind` 仍是 `local`，不写 `rateLimitAt`。200 体是 `{queued:true, messageId, id?}`，502 体是 `{error:"smtp_error", id?}`。
- 放开键、允许原样重试的结果：冷却、每小时额度，以及占位之后的其它 4xx/429；还有还没进入 DATA 的连接类失败（`failureKind` 为 `local`，且不写两个哈希）。这些响应不缓存。
- 内存最多 10_000 条（`SEND_IDEMPOTENCY_TTL_SEC = 86400`）。先丢掉已过期的已完成项；仍满则暂时逐出最老的已完成项，不逐出进行中的占位。若这次请求随后被冷却、额度或连接类失败放开，被逐出的项会放回；只有记成已完成，逐出才留下。若全是进行中，**429** `{error:"idempotency_table_full", retryAfterSec:1}`。这几条响应都不带 `Retry-After` 头。
- 启动时发送日志读失败，或额度 / 冷却 / 幂等回放抛错：带 `Idempotency-Key` 的请求在占位之前返回 **503** `{error:"idempotency_unavailable"}`。不占冷却、不占每小时额度、不打 SMTP。不带键的请求照常。下一次回放成功后恢复。MCP `mail_send` 走同一条路由。

启动时和冷却、额度一起从 `DATA_DIR/send-log.jsonl` 重建已完成项。只认 24 小时窗口内同时带 `idempotencyKeyHash` 与 `requestHash` 的 `queued` 行、`failureKind: "smtp_response"` 的失败行，以及同样带这两个哈希的 `failureKind: "local"` 行（DATA 阶段不确定失败）。`sentAt` 在未来的行忽略。恰好到期（`sentAt + 86400 秒 <= now`）不算。早于该地址当前身份 `createdAt` 的行也不算。身份库读失败时不重建幂等行（额度与冷却仍回放），避免没有 `createdAt` 过滤时装入上一任。SMTP 已接受之后若再读身份库抛错，这次实际返回的响应记成终态，不放开占位，同一键不会再发一封。没有这两个字段的旧行忽略。日志只存键的 sha256 十六进制（`idempotencyKeyHash`），不存原始键。`requestHash` 是上面的指纹。200 由行内 `messageId` 与 `id` 还原；`messageId` 不是字符串时这行不还原。502 还原为 `{error:"smtp_error", id}`。还没进入 DATA 的连接类失败和额度拒绝不写这两个字段，重启后也不会挡住重试。日志没写上的那一封，重启后补不回来。进程死掉时还在飞的占位不会恢复。

`send-log.jsonl` 超过 10_000 行或 8MB 时，先丢掉其它旧行。仍在 24 小时窗口内、并且两个哈希都在的行优先保留，最多留幂等表上限那么多条（最新优先）。窗口外的带哈希行不特殊保留。这些行本身仍超过字节上限时，才从最旧的开始丢。

MCP `mail_send` 的可选字符串 `idempotencyKey` 与 REST 用同一条规则：trim 之后 1–128 个可打印 ASCII（0x20–0x7E）。只有空白在 MCP 校验失败，不会当成没带键；REST 的空白头仍视为没带键。客户端把通过校验的键放进同一个请求头，不放进 body。

身份和发件域通过之后、上面的幂等键处理之后、每小时额度之前：

- **一对一冷却**（仅 `autoReply: true`）：键是发件身份 × 每一个收件人。地址只做 trim + 小写，不剥 `+tag`，不合并点号。父代子发信时键用子地址（与每小时额度同一个发件身份）。`AUTO_REPLY_COOLDOWN_SEC` 默认 300；`0` 关闭；非整数、负数、NaN 或大于 86400 回落 300（超过 86400 时打一条配置警告）。
- 检查通过时，同一步同步占住全部归一化后的发件身份 × 收件人对，然后才进入每小时额度和 SMTP。占位还没结束（SMTP 尚未返回）时，别的 `autoReply: true` 碰到同一对也会被拒绝。任一收件人仍在冷却或占位中，则整封 **HTTP 429** `{error:"auto_reply_cooldown", retryAfterSec}`。`retryAfterSec` 是被挡住的那些对里剩余秒数的最大值（向上取整，至少 1）；进行中的占位按剩余预留窗口计，至少 1 秒。不部分投递，不打 SMTP，不占每小时额度，不写 `send-log.jsonl`。响应不带 `Retry-After` 头（与本路由的 `rate_limited` 一样，只在 JSON 里给秒数）。
- 每小时额度若拒绝，会在写审计之前放开这次占位。连接被拒、超时、认证失败这类还没得到应答的失败同样放开占位（与每小时额度退还同一分类）。释放只删掉仍属于这次占位的格子，不会清掉已经记下的更长冷却。SMTP 接受，或对端已经返回错误应答时，截止时间改为完成时刻 + 冷却秒数。记在进程内存里，不依赖审计行追加成功。
- 内存里最多 10_000 对。只丢掉已经到期的正式冷却；未过期项和进行中的占位都不逐出。丢掉过期项之后仍放不下这次要新增的对，则整封 429 `auto_reply_cooldown`。`retryAfterSec` 只看未过期的正式冷却里最早到期的那一项还剩的秒数（向上取整，至少 1）；进行中的占位不参与。没有这样的正式冷却时，用配置的冷却秒数（至少 1）。不打 SMTP，不占每小时额度。
- API 启动时从 `DATA_DIR/send-log.jsonl` 重建：冷却窗口内、`autoReply: true`，且为 `queued` 行或 SMTP 服务器已应答的失败行（`result: "failed"` 且 `failureKind: "smtp_response"`），按发件人 × 每个收件人放回内存。`sentAt` 在未来的行忽略（与每小时额度回放相同）。窗口边界恰好到期（`sentAt + 冷却 <= now`）不算。连接类失败（`failureKind: "local"`）、没有 `failureKind` 的旧失败行，以及 `rate_limited` 不算。超过 10_000 对时保留最晚到期的那些对。日志没写上的那一封，重启后补不回来。SMTP 失败行才会带 `failureKind`（`smtp_response` 或 `local`）。占住每小时额度的 `queued` 行和 `failureKind` 为 `smtp_response` 的失败行还可带 `rateLimitAt`（准入时刻的 ISO 时间）；`SEND_RATE_LIMIT=0`、`rate_limited` 和连接类失败不写。发送历史仍显示 `sentAt`。冷却回放继续用 `sentAt`。

每小时额度仍然包住该身份的全部 `/v1/send`，包括自动回复。先处理幂等键，再过冷却，再扣额度。幂等回放不扣额度。`SEND_RATE_LIMIT` 默认 20，`0` 关闭。超限 **429** `{error:"rate_limited", limit, retryAfterSec}`（同样没有 `Retry-After` 头）。进程启动把最近一小时的 `queued` 行，加上 SMTP 服务器已应答的失败行，回放进同一个滑动窗口，所以重启不会把额度清零。回放有准入时刻 `rateLimitAt` 时用它，否则用 `sentAt`；日志没写上的那一封不会被计入。连接类失败和没有 `failureKind` 的旧失败行不计。任务、审批、催办、租约邮件不走这条路由。

