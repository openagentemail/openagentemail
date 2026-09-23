# Changelog

All notable changes to this project are documented here, one section per release, newest first.

## Unreleased

### Fixed

- **API: 日志/告警载荷面统一为 `describeFailure`（B 形态：逐字段独立域）** (#342)：`errorDetail` 并入并删除；每字段 **取串 → 有界200 → `redactField`（域内最长优先 + 域尾丢弃）→ `escapeLine`**，**然后** `join(' ')`（**禁止跨字段匹配**）。转义段＝C0/**DEL+C1(U+007F–U+009F)**/U+2028/U+2029/**bidi U+202A–U+202E·U+2066–U+2069**；输出可证 ≤6002；永不抛。调用点含原 `errorDetail` 11 处、`send.ts`、`sent-registry` 字符串告警、**`tasks` claim/claim-lost 兜底 warn**。**已声明行为差异**：字段尾恰为密钥真前缀时有意丢弃（J4）。**`errorCode` 一字不动；对外错误码/状态码/body 形状零变更**（本卡只动日志与告警载荷面）。对象面 6 处记债 #344。设计：`design-b.md`；旧跨字段形态头 `3872b0b` 留作反例素材、不予合并。**合并 ≠ 生效，生效于下次部署窗**。
- **API: 非 Error rejection 不再因裸读 `.message` 逸出/打断日志路径** (#332)：全仓其余 31 处 `(err as Error).message` 统一改走 `errorCode(err)`（#333 已落地）。**对外错误码/状态码/body 形状零变更**；日志/告警与路由 catch 在 `undefined`/`null`/非 Error rejection 上不再因读取本身抛 TypeError。**合并 ≠ 生效，生效于下次部署窗**。

### Changed

- **Tasks: `claim` 遇 `lease_service_unavailable` 由 502 归位为 503 同码** (#340 C3)：`POST /v1/tasks/:id/claim` 在 catch 命中 `lease_service_unavailable` 时，由 **`502 {error:"task_operation_failed"}` → `503 {error:"lease_service_unavailable"}`**（**仅此一码、仅此一条路由**；与 `lease`/`release`/`claim-lost` 兄弟路由既有映射对齐；其它码与其它路由不动）。**合并 ≠ 生效，生效于下次部署窗**。
- **Tasks: 两条被吞域码由兜底归位为 409 同码** (#336)：`task_leases_disabled`（`POST /v1/tasks/:id/{claim,lease,release,claim-lost}` 服务层路径）与 `invalid_approval_decision_event`（`POST /v1/tasks/:id/decision`）由 `502 {error:"task_operation_failed"}` 归位为 **`409` 且 body 回显同码**（与入口守卫 / decision 冲突族对齐）。**中性兜底 `task_operation_failed` 本身保留**，仍收纳未映射失败。**合并 ≠ 生效，生效于下次部署窗**。
- **Tasks: 租约/状态突变兜底码改为 `task_operation_failed`** (#330)：`POST /v1/tasks/:id/{claim,lease,release,claim-lost,decision,state}` 六处与 UI task 突变（`taskMutationError`）在未命中已映射域码时，对外码由 `502 {error:"smtp_error"}` 改为 `502 {error:"task_operation_failed"}`（状态码与 body 形状不变；**已映射域码与状态码一律不变**；`POST /v1/tasks` create 段 pre-create `502 {error:"smtp_error"}` 不变）。这些路径在写入阶段**会投递邮件**（lease journal 投递 / 审批终态投递 / remind / update 通知），**SMTP 投递失败是落入该兜底的成因之一**；该兜底同时收纳未映射/未分类失败，旧码把它**单一归因 SMTP**、客户端据码判因必错，故改为中性码。客户端若按错误码判因需改判。**合并 ≠ 生效，生效于下次部署窗**。
- **Tasks: post-create wait 失败对外码改为 `wait_failed`** (#240)：`POST /v1/tasks` 在 SMTP/创建已成功后，wait 段非 journal 异常由 `502 {error:"smtp_error", taskId, created:true}` 改为 `502 {error:"wait_failed", taskId, created:true}`（状态码与 body 形状不变）。**仅限**该 post-create wait 失败面；pre-create `502 {error:"smtp_error"}`（无 id）与 journal `503 lease_journal_*` 不变。客户端若按错误码判因需改判；`taskId`/`created` 判据不变。

## v0.9.0 — 2026-09-22

### Added

- **API: scoped permissions —— `identities:create` / `messages:send` + 父子归属** (#275): identity token 可按 scope 授予能力。`identities:create` = 创建**归属子身份**（父域、子 ⊆ 父、白名单、配额 ≤50）；`messages:send` = 以自身或归属子身份发信；既有 `read:messages` 扩展为可读**自身 + 归属子信箱**（list/get/wait）。明确**不授予**：删除 / rotate / push-tier、`canNotifyUser`、给子再授 `identities:create`、伪造 `parentIdentity`、非归属 `from`。子 token 默认：父含 `read:messages` → 子 `[read:messages]`，否则 `[]`。admin / 无 scope / 既有 `read:messages` 路径**零行为变化**（`OPERATION_POLICIES` 仅追加两条）。MCP 与 REST 同源（MCP 执行回环 `/v1` 中间件栈，无直连 store 写路径），新 scope 一处登记两侧同时生效。
- **Dashboard: 控制台 i18n —— es / ja / ko / zh-CN** (#137 B1-A #292 / B1-B #293 / B2 / 术语表 #299): 控制台 UI 引入字典 + 运行时（shell 槽位 + `resolveUiLocale` 单点）、call-site 全量迁移与**非循环完备性**测试（非白名单裸字面量即红）、四语字典键集全等、locale 选择走 cookie（不新增匿名端点）、`lang` 跟随实际服务内容、shell 响应补 `Vary: Accept-Language`。术语表落 `docs/i18n-glossary.md`（含落串纪律）。
- **Docs: README 全面改版** (#307): agent 通信 / 任务交接 / 当前架构 / 品牌呈现重写（附 8k 中继实测数字与部署窗 recreate 教训）。

### Fixed

- **Tasks: 一条坏回执不再让整单读不出来** (#308): claim 加 **pending-index fence** —— release/renew 未被吸收时 re-claim 冲突降级为有界；fence age 起算点修正为**入队/接受时刻**（原按事件时间戳起算，上界等于没上界）。
- **Tasks: 冲突 lease claim 降级时保持任务可读** (#305)。
- **Headers: 容忍 MIME 重折** (#313): `X-OA-Task-Root` / `Approval-Digest` 经 MIME 中介重折后仍可解析（原直接拒收）。
- **Webhooks: URL 拒绝详情 + ping 熔断审计对齐 + 折叠容忍** (#289 / #290 / #302)。
- **Redeliver: 裸 `task_not_found` / `missing_task_id` 映射 404** (#280)。
- **Tasks: 租约续期 / 回执去重路径索引化** (#285): 原 O(N²) 路径改键控集合（bench slope 0.78，基线 1.998；满链重建 68.6 ms vs 基线 57–70 s）。
- **Security docs: 工具计数 20→25 + parity 测试** (#287)。

### Changed / Ops

- **Compose: ntfy 以非 root（uid 1000）运行、监听 :2587** (#278): 生成器与 healthcheck / 端口映射同步。**既有实例升级前需先 `chown` `/data/ntfy`，见 README 迁移注记。**
- **CI: release 通道加固** (#284): `mcp-publisher` 钉 v1.8.1 + 内联 sha256 校验 + 架构守卫；另修幂等与浏览器用例阻断（#234 后续）。
- **RFC-0002 联邦签名任务** (#59): 纯文档，Status 保持 **Proposed**——批准前修订清单未清空前不得升 Accepted。

## v0.8.0 — 2026-09-20

### Added

- **Audit: `\Seen` write paths emit `message.mark_seen`** (#152): successful `POST /v1/messages/:id/seen` and `POST /ui/api/messages/:id/seen` append scrubbed audit rows (`messageId`/`seen`); UI rows include `ip`. Read paths gain FakeImapFlow gold tests asserting zero `messageFlagsAdd`/`Remove` (with a write-path control). MCP `mail_mark_seen` copy no longer nudges shared-mailbox agents to mark seen blindly.
- **Dashboard: "Connect an agent" 指南** (`/ui/connect`, #231)：为当前 identity 会话生成可直接复制的 MCP 接入配置 —— Kimi Code（`~/.kimi-code/mcp.json`）、Codex（`~/.codex/config.toml`）、Claude Code（`claude mcp add`）、Cursor（`~/.cursor/mcp.json`）、ZCode（`~/.zcode/cli/config.json`），另附 ChatGPT / Grok 的手工路径（明示不要在对话里粘 token）。`GET /ui/api/connect` 用 `MCP_PUBLIC_URL`（未配置时回退 request origin）给出 endpoint，且**只对仍持有明文的直接 identity 登录进程内会话**返回 token；不可用态带 reason 区分——admin 会话回 `identity_session_required`，`?token=` 交换码会话、容器重启后恢复的 hash-only 会话、以及 identity 会话但 `expectedAddress` 不匹配或已轮换者均回 `token_unavailable`；不反解、不落盘、不自动轮换。硬化：明文下发记 `identity.token.reveal` 审计（按会话+IP 60s 节流、表上限 `MAX_TRACKED_IPS`）、要求 `Sec-Fetch-Site: same-origin|none`（否则 403）、Reveal 前 Copy token / Copy setup 保持 disabled、bfcache `pagehide`/`pageshow` 清敏感态、Claude 命令用 `$OAE_TOKEN` 变量引用（避免 bearer 进 shell 历史）。反代部署需配 `MCP_PUBLIC_URL`，否则 endpoint 取 request origin。
- **API: 可选自证端点（X-Agent H1）** (#266): 配置 `SOURCE_COMMIT`（40 位小写 hex）时 `GET /healthz` 追加 `status`/`commit`/`version`，**`ok:true` 永远在场**（setup CLI / demo 健康检查不受影响）；`SOURCE_COMMIT` 与 `XAGT_VERIFICATION_SLUG` **同时**配置才挂 `GET /.well-known/xagent-verification.json`（`{schemaVersion:1, slug, commit}`，缺任一 → `404`）。不配置即逐字 `{ok:true}`，默认行为不变。compose 把 `${SOURCE_COMMIT:-}` 作为 build arg 透传进 API 镜像（`api` 与 `ntfy-provision` 共用同一 Dockerfile）。注意：`commit`/`version` 对未鉴权调用方可见（启用即运营方选择）；形态不符的 `SOURCE_COMMIT` 会 boot 失败（zod fail-fast，启动前先 echo 确认）。
- **Docker: API 运行时镜像契约 —— non-root + 确定性 lockfile** (#93): 运行镜像以 `bun`（uid/gid **1000**）运行（`USER bun`，仅 `/app/data` 归 bun；可执行件保持 root 只读执行），构建强制 `bun.lock` 存在且**只走 `--frozen-lockfile`**（依赖漂移即构建失败，不再静默降级）。CI 新增 `docker-smoke` job：断言 dist-only 产物集、`dist/main.js`(uid 0) 与 `/app/data`(uid 1000) 属主、容器 uid=1000、`/healthz` 200 + 数据目录写探针，并跑 lockfile 漂移负控（plain 成功 / frozen 失败，证明红的是 flag 而非语法）。**既有卷需先做一次性迁移，见 Notes。**

### Fixed

- **Notify: #249+#235 residual cascade hardening**: disable-window deletes still enqueue `pending_revoke` when a store exists (re-enable boot reconciles); provision race orphans join the same queue; first revoke / `deleteNtfyUserResult` gate on `adminPassword` like `writeServerConfig`; legacy `ambiguous` stamps may upgrade to a unique owner (never downgrade a concrete address); `identities↔notify` cycle broken via `registerNotifyRouteDeleteCallback`.
- **Notify: deleteIdentity cascades full-address agent route + reader revoke** (#235): deleting an identity now drops `notifications.json` `agents[<address>]` (fail-closed on persist), queues the reader into `pending_revoke` reconciled like phone devices (`deleted`/`not_found`/`transient`), and boot reconcile purges orphan full-address keys only (bare localpart untouched). New audit event `identity.notify_route.delete`.
- **Notify: agent 通知路由改按完整地址键 + 取消跨域 `409`** (#134 Q1, #233): 新身份在 `identity.address`（小写、去尾点）下开 ntfy 路由，旧裸 localpart 键按「精确 → 回退」继续可读；同一 localpart 可在不同域共存且互不串通知（`POST /v1/identities` 不再返回 `409 localpart_conflict`）。`POST /v1/notify`、MCP `mail_notify_agent` 与 history topic 均接受完整地址（裸 localpart 在单域场景仍兼容），非法名 → `400 invalid_request`，跨域歧义的裸 localpart fail-closed（`unknown_agent`）；identity 自身频道键与 UI topic 键同步对齐。**行为变更**：依赖 `409 localpart_conflict` 判重的老客户端需改判（冲突不再报错，而是建出第二个域上的身份）；ntfy agent 路由键形态由裸 localpart 迁至 `localpart@domain`（读侧保留精确→回退链，通知投递本身向后兼容）。
- **Tasks: create(wait=true) 错误响应分层** (#183)：SMTP 发送成功后 wait/journal 失败不再误报裸 `502 smtp_error`。未创建仍为 `502 {error:"smtp_error"}`（无 id）；已创建后 journal 错 → `503 {error,taskId,created:true}`，其他等待异常 → `502` 同 body，`429 too_many_waits` 补 `taskId`。MCP client/`task_create` 透出 `taskId` 并提示用 `task_get`/`task_list` 查、勿重新 create。
- **Wait: 截止与剩余时间改用单一单调钟** (#211): API 侧 `waitForMessage`/logout 的 deadline 与 remaining 从 `Date.now()` 切到共享 `waitMonotonicNow()`（`performance.now` 族），MCP 客户端再武装决策共用同一钟缝 —— 宿主墙钟跳变不再导致提前 408。
- **Wait: hung logout 不再越过截止线返回 200** (#223): `logoutBounded` 区分「截止界胜出」与「断开」，截止界胜出即视为截止已跨越并丢弃 provisional，消除 `floor(remaining)` 竞态下「该 408 却返回 200」的路径。
- **`mail_wait_for`: newest-20 匹配跳过已读命中** (#230)：邮件族 wait 不再对已处理（`\Seen`）的匹配邮件立即返回，改为继续等到真超时或新的未读命中；task（`x-oa-task`）分支刻意不跳过，任务结果回取不受影响。**行为变更**：依赖「复读已读邮件」的调用方（例如先 `mail_mark_seen` 再 `mail_wait_for`）会改为等到超时，请改用未读匹配或先取列表。
- **Auth: `requireUiOrigin` 放行 `Origin: null` 的同源表单** (#234): `Referrer-Policy: no-referrer` 下 Chrome 提交 OAuth 同意页 Approve 会发 `Origin: null`，旧判定直接 403；现以 `Sec-Fetch-Site` 为主闸 —— `same-origin` 放行缺失 / 字面 `null` / 可解析同源，`cross-site` 与 `same-site` 一律 403，SFS 缺失时仅可解析同源放行（保持 fail-closed）。
- **Auth: admin API key 改常量时间字节比较** (#227, #271): `resolveAccessToken` 不再用 `Set.has` 做普通（逐字节、非恒定时间）内容比较，改为逐键 `sha256Hex` + `hashEquals`（即 `timingSafeEqual`，与 UI session hash 路径同款），消除逐字节内容比较的时序侧信道。**注意**：命中仍按集合顺序提前返回（与既有循环写法一致），故不宣称消除「按命中位置」的墙钟差异；accept/reject 语义不变，拒收路径由 O(1) 变 O(keys) 次 sha256（keys 通常 1–2 个，影响可忽略）。
- **Webhooks: stale delivery-list cursors are rejected** (#216): `GET /v1/webhooks/:id/deliveries` no longer silently rewinds to page 1 on an unknown cursor; it returns **HTTP 400 `{error:"invalid_cursor"}`**, matching send-log / notify / task cursor semantics. **行为变更**：老分页客户端在未知/过期游标下会由「静默回首页」变为收到 400，需接住并回首页。
- **Webhooks: deliveries 读限流接线 + disable 幂等** (#219, #220): `GET /v1/webhooks/:id/deliveries` 与兄弟读路由同序接入 per-caller 读限流（超限 `429 {error:"rate_limited", retryAfterSec}` + `Retry-After`）；对已 `disabled` 的订阅再次 disable 幂等回显既有 `disabledReason`，不 mutate、不取消在途投递、不写 audit。
- **Webhooks: 内存 delivery-log 索引加行上限** (#217): 新增 `WEBHOOK_LOG_MAX_ROWS`（默认 100000），只约束进程内索引行数 —— **盘上 `webhook-deliveries.jsonl` 仍由 `WEBHOOK_LOG_RETENTION_DAYS` 压缩**；超限按滞回（裁到上限 90%）逐出最旧的非活跃行，活跃重试链永不逐出。边界行为：逐出区 `deliveryId` 的 `redeliver` → `404 delivery_not_found`；游标落入逐出区 → `400 invalid_cursor`（客户端应回首页）；某订阅全部行被逐出时 `lastDelivery: null`。**语义收窄（默认值下远未触发）**：一旦发生逐出，读面可能少于盘上实有行——对盘上仍存在的 `deliveryId` 也可能回 `404`（读的是被裁的内存视图）。
- **Webhooks: delivery 列表改吃增量内存索引** (#146): `GET /v1/webhooks/:id/deliveries` 不再每次整文件读，改吃增量内存索引（仍按请求过滤后排序，过滤/排序/游标语义不变），残余读放大收口；同时把「**每信箱单 API 进程**，多进程写者会越过 `WEBHOOK_MAX_*` 上限」写进 `.env.example` / `compose.yaml` 注释。
- **Webhooks: redeliver run 号盘源流式 + 活组次级上限** (#268, #270, #272): `redeliver` 的最大 `run_N` 改为盘源 64KiB 流式扫描（O(1) 内存，避免吃截断内存视图而撞历史 run 号、boot 丢重试链）；活跃组 alone 超过 `10×WEBHOOK_LOG_MAX_ROWS` 时升 error 级可采集事件 `delivery_log_active_overflow`（仍不逐出活行）；deliveries 游标加 1024 字符硬限并按生产可生成域严格解析，非规范形态一律 `400 invalid_cursor`。
- **Dashboard: recover pagination after a stale mail cursor** (#196): load-more clears `nextCursor` on **400 `invalid_cursor`** and prompts Refresh (other errors leave the cursor alone). `GET /ui/api/messages` now maps codec cursor failures to **`invalid_cursor`** (schema failures remain `invalid_request`), so the UI recovery path is live for inbox as well.
- **Dashboard: Tasks 轮询同步第 2+ 页详情 + waiting 计数诚实化** (#264): 轮询用第 1 页替换列表时改为按 id 并集同步详情，第 2+ 页打开中的工单不再丢 `expiryProjection`；首页 waiting 计数硬停文案从裸 `500+` 改为 `500+ · scan capped`，并补「已达扫描上限、窗口外可能仍有待办」的空态（不再把封顶数当精确数）。
- **Webhook-wake 示例: readiness 硬化** (#177, #228): 非 loopback `listen.host` 必须显式 `listen.allowNonLoopback: true`（`parseFileConfig` 与 `listenReceiver` 双层拒载；`127.0.0.0/8` 整段算 loopback）；`requestTimeoutMs`/`sendTimeoutMs` ≤ 30000、`alertHook.timeoutMs` ≤ 10000，且 `requestTimeoutMs ≥ sendTimeoutMs + 2000`（`config_invalid:requestTimeoutMs.headroom`，不加高 cap）；`alertHook.url` 仅接受 `http:`/`https:`；`/ready` 增加 `.dirsync` 可替换性检查、状态文件 symlink 一律视为非普通文件；marker 写入改用同一 fd 的 `O_NOFOLLOW`，平台缺该旗时 fail-closed 而非静默降级。

### Tests

- OAuth 同意页 Chromium 回归：钉 `playwright@1.63.0`、CI 安装 Chromium，断言 Approve 表单实发 `Origin: null` + `Sec-Fetch-Site: same-origin`（#234）。
- wait-clock：钟族 flip 直接抛错 → 钉子带 family 名；dist mutator 钉子按 API / MCP 分包跑（API 侧只 build api，不拉 mcp build）（#212, #226）。
- invalid_cursor 四族负控（未来时间戳、窗内 lookup_miss、超长/非规范形态）全部入测钉行号（#202, #270）。
- webhook delivery 内存上限与增量列表读的覆盖：逐出、滞回 90%、活跃组永不逐出、逐出后 redeliver/cursor 边界（#146, #217, #268）。
- Connect 页：bfcache 清态、loadGen 竞态、Claude 命令零凭证、UI bundle 字节金标指纹（#231）。
- `docker-smoke` CI job（#93，见 Added）。

### Notes

- **升级注意 —— 既有 `api-data` 卷需一次性 chown 迁移**（#93, #267/#273）：旧 root 属主的具名卷必须先 `docker run --rm -v <project>_api-data:/data alpine sh -c 'chown -R 1000:1000 /data'`，再上新镜像；顺序不可颠倒（新镜像会拒启/首次写失败，这是有意 fail-fast，不是静默回退）。README runbook 明确：停 writer **不够**，必须停到 **recreate**（`restart` ≠ recreate —— root 容器回起会把卷内文件写回 `root:root`，静默回滚迁移且无报错）；`find /data ! -user 1000` 必须零输出；`api` 与 `ntfy-provision` 同批 build（共用 Dockerfile，`--force-recreate` 会连坐一次性 provision 容器）；`docker inspect <api-image> --format '{{.Config.User}}'` 为 `bun` 才许 start。（这一失效模式正是 #267 的由来。）
- **观测面变化（#202, #270）**：四族游标拒收（messages / send / tasks / deliveries）现在打结构化日志，标签恰三枚封顶 `{family, shape, within_retention}`，隐私硬线不输出游标原文；**400 响应体逐字不变**。路由直传 decoder 真实种类（`parse_fail` / `lookup_miss`），旧的从游标字符串软解反推形状那一层整体退役。
- **wait 钟族钉死（#214, #226）**：首次成功读钟即钉死 `performance` / `Date` 族，运行期 flip 直接抛错（响亮失败优于静默全超时）；`performance.now` 不可用时回退 `Date.now` 并 warn-once。
- **单写者前提**：`WEBHOOK_LOG_MAX_ROWS` 等进程内上限与增量索引都假定**每信箱单 API 进程**，多进程写者会越界（已写进 `.env.example` / `compose.yaml`）。
- **X-Agent 自证端点的启用前提（#266）**：`SOURCE_COMMIT` 与 `XAGT_VERIFICATION_SLUG` 必须**同时**配置，`/.well-known/xagent-verification.json` 才挂。两者**生效路径不同**：`SOURCE_COMMIT` 是**构建期 build arg**（compose 的 `api` / `ntfy-provision` 服务 `build.args`），改了必须**重建镜像**——只改 `.env` 再 `up -d` 会仍报旧/空 commit、端点仍不挂；`XAGT_VERIFICATION_SLUG` 是**运行时环境变量**（compose 的 `api` 服务 `environment` 段），改 `.env` 后重建容器即生效。两个键均**未进** `.env.example` / `.env.api-only.example`，且该端点目前除测试外无文档——启用前请对照 `compose.yaml` 的 `api` 服务段与 `packages/api/README.md`。

## v0.7.3 — 2026-09-13

### Added

- **Signed webhook wake receiver example** (`examples/webhook-wake/`): a ready-to-run "doorbell" endpoint that verifies openagent.email webhook signatures and wakes your agent runtime when mail arrives — the reference piece for wiring webhooks into agent fleets (#172, #176).

### Fixed

- **Long waits re-arm correctly instead of hot-looping** (#203, #206): after an early 408, `mail_wait_for` could re-issue waits in a tight loop. Waits now re-arm cleanly under the caller's timeout budget.
- **Cancellation and revocation now win deterministically** (#204, #206): revoking a delegated wait mid-wait returns 403 (revoked), never a misleading 499/408; client disconnects free the wait slot immediately — including while DNS resolution is still in flight — and post-disconnect logout can no longer hang until the deadline.
- **Tasks: pending-lease journal + claim_lost + postponed expiry audit** (opt-in): `TASK_LEASES_PENDING_JOURNAL` (default false, requires `TASK_LEASES_ENABLED`) persists conservative pre-SMTP generation fences, admin-signed `claim_lost` after 2h, and records or defers expiry-audit work. Production expiry-audit SMTP emission remains hard-disabled pending a separate commander-approved card; the journal flag is not an emitter opt-in. Upgrade readers before the first tombstone; old-binary rollback after the first `claim_lost` is unsafe (#80, #84; #181).
- **Tasks: signed expiry receipts for accepted deadline windows** (#156, #185).
- **API: per-caller rate limit on GET /v1/messages** (#192).
- **API: backward mail cursors are bound to the mailbox generation** (#195): cursors can no longer silently page into a rebuilt mailbox.

## v0.7.2 — 2026-09-09

### Added

- **Webhook env wiring for compose deployments**: all 22 webhook configuration keys are now wired through the API service in `compose.yaml` and `compose.api-only.yaml`, with `.env` examples — compose-based installs can enable and tune the outbound webhook subsystem without touching code. Safe defaults preserved: signing secrets stay `undefined` when unset, explicit empty/short values are rejected, and the public-edge guard keeps `private=false` (#149, #174).

### Fixed

- **Tasks: bound public-read lease overlay replay** (opt-in): public read projections cap lease overlay replay at 15 minutes, preventing unbounded replay on read paths. Disabled by default — enable with `TASK_LEASES_OVERLAY_BOUND=true` (#80, #84; #171).
- **Tasks: decouple reclaim from expiry-audit SMTP** (opt-in): lease reclaim no longer depends on the expiry-audit mail path, with late-receipt tolerance. Disabled by default — enable with `TASK_LEASES_EXPIRY_AUDIT_M3=true` (#80, #84; #167).

### Tests

- Webhook quota and latest-delivery IO contract regression coverage: exact read/byte accounting under real compose rendering, including negative controls (#146, #173).

## v0.7.1 — 2026-09-08

### Fixed

- **MCP stdio clean boot**: v0.7.0 crashed on startup in a clean client environment — an import chain pulled the mail server's env schema (`DOMAIN`/`API_KEYS`/IMAP/SMTP) into the MCP bundle before the handshake. Scope constants moved to a config-free leaf module; the stdio client now boots with only `OPENAGENTEMAIL_API_URL` + `OPENAGENTEMAIL_API_KEY` (#168, #169).

### Notes

- Regression guard added: `packages/mcp/test/clean-boot.test.ts` runs an initialize + tools/list handshake against the built bundle with all server-side env removed, wired into CI.

## v0.7.0 — 2026-09-07

### Added

- **Multi-domain identities**: serve several domains from one instance via `DOMAIN` + `EXTRA_DOMAINS` (#133).
- **Revocable mailbox delegation ACLs**: delegate scoped mailbox access to other identities, revocable at any time (#125, #135; hardening follow-ups #136, #151).
- **Outbound webhook subsystem**: notify your own endpoints on mailbox events — shared pinned fetcher with SSRF hardening (incl. IPv6-embedded-IPv4), process-wide event dispatcher with per-sink watermark isolation, forward-`since` query with `uidValidity` generation precondition (#128 PR1–PR4: #140, #141, #142, #145).
- **Approval expiry projection**: list/board views now project unmaterialized approval expiry with signed display metadata, so "waiting on you" never lies about the deadline (#75, #160).
- **Bookmarkable admin UI login** via `?token=` query, hardened with a one-time exchange-code flow (#131, #132/#150).
- **Read-only identity token scopes** enforced across the API (#124); OAuth access-token resolution now inherits identity scopes (#129).

### Fixed

- **Transport-level exact dedup** for lease claim/renew/release events: byte-identical authenticated duplicates are accepted as no-ops, any divergence fails closed (#85, #158).
- **Authorization-read isolation**: REST and dashboard share one authorization-read surface that never materializes expiry on a reject path (#76, #83, #101; #153).
- Task API hardening: children cursor length cap, case-insensitive participant matching, mutation responses share the parent ACL projection, MCP task output schema aligned with the durable-id predicate (#103, #107; #159).
- Review follow-ups batch (#130, #148) and test isolation hardening (#147).

### Notes

- All changes dogfooded on our own instance before release; full test suite green (1459 tests).
- Follow-ups already tracked: #155–#157, #161–#163. #80/#84 (lease overlay bounds / audit retry queue) were sent back for redesign after review surfaced a design-level conflict — they will return in a future release.
