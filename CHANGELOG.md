# Changelog

All notable changes to this project are documented here, one section per release, newest first.

## v0.8.0 — 2026-09-20

### Added

- **Audit: `\Seen` write paths emit `message.mark_seen`** (#152): successful `POST /v1/messages/:id/seen` and `POST /ui/api/messages/:id/seen` append scrubbed audit rows (`messageId`/`seen`); UI rows include `ip`. Read paths gain FakeImapFlow gold tests asserting zero `messageFlagsAdd`/`Remove` (with a write-path control). MCP `mail_mark_seen` copy no longer nudges shared-mailbox agents to mark seen blindly.
- **Dashboard: "Connect an agent" 指南** (`/ui/connect`, #231)：为当前 identity 会话生成可直接复制的 MCP 接入配置 —— Kimi Code（`~/.kimi-code/mcp.json`）、Codex（`~/.codex/config.toml`）、Claude Code（`claude mcp add`）、Cursor（`~/.cursor/mcp.json`）、ZCode（`~/.zcode/cli/config.json`），另附 ChatGPT / Grok 的手工路径（明示不要在对话里粘 token）。`GET /ui/api/connect` 用 `MCP_PUBLIC_URL`（未配置时回退 request origin）给出 endpoint，且**只对仍持有明文的直接 identity 登录进程内会话**返回 token；admin、`?token=` 交换码、容器重启后恢复的 hash-only 会话一律 `unavailable`，不反解、不落盘、不自动轮换。硬化：明文下发记 `identity.token.reveal` 审计（按会话+IP 60s 节流、表上限 `MAX_TRACKED_IPS`）、要求 `Sec-Fetch-Site: same-origin|none`（否则 403）、Reveal 前 Copy token / Copy setup 保持 disabled、bfcache `pagehide`/`pageshow` 清敏感态、Claude 命令用 `$OAE_TOKEN` 变量引用（避免 bearer 进 shell 历史）。反代部署需配 `MCP_PUBLIC_URL`，否则 endpoint 取 request origin。
- **API: 可选自证端点（X-Agent H1）** (#266): 配置 `SOURCE_COMMIT`（40 位小写 hex）时 `GET /healthz` 追加 `status`/`commit`/`version`，**`ok:true` 永远在场**（setup CLI / demo 健康检查不受影响）；`SOURCE_COMMIT` 与 `XAGT_VERIFICATION_SLUG` **同时**配置才挂 `GET /.well-known/xagent-verification.json`（`{schemaVersion:1, slug, commit}`，缺任一 → `404`）。不配置即逐字 `{ok:true}`，默认行为不变。compose 把 `${SOURCE_COMMIT:-}` 作为 build arg 透传进 API 镜像（`api` 与 `ntfy-provision` 共用同一 Dockerfile）。注意：`commit`/`version` 对未鉴权调用方可见（启用即运营方选择）；形态不符的 `SOURCE_COMMIT` 会 boot 失败（zod fail-fast，启动前先 echo 确认）。
- **Docker: API 运行时镜像契约 —— non-root + 确定性 lockfile** (#93): 运行镜像以 `bun`（uid/gid **1000**）运行（`USER bun`，仅 `/app/data` 归 bun；可执行件保持 root 只读执行），构建强制 `bun.lock` 存在且**只走 `--frozen-lockfile`**（依赖漂移即构建失败，不再静默降级）。CI 新增 `docker-smoke` job：断言 dist-only 产物集、`dist/main.js`(uid 0) 与 `/app/data`(uid 1000) 属主、容器 uid=1000、`/healthz` 200 + 数据目录写探针，并跑 lockfile 漂移负控（plain 成功 / frozen 失败，证明红的是 flag 而非语法）。**既有卷需先做一次性迁移，见 Notes。**

### Fixed

- **Notify: #249+#235 residual cascade hardening**: disable-window deletes still enqueue `pending_revoke` when a store exists (re-enable boot reconciles); provision race orphans join the same queue; first revoke / `deleteNtfyUserResult` gate on `adminPassword` like `writeServerConfig`; legacy `ambiguous` stamps may upgrade to a unique owner (never downgrade a concrete address); `identities↔notify` cycle broken via `registerNotifyRouteDeleteCallback`.
- **Notify: deleteIdentity cascades full-address agent route + reader revoke** (#235): deleting an identity now drops `notifications.json` `agents[<address>]` (fail-closed on persist), queues the reader into `pending_revoke` reconciled like phone devices (`deleted`/`not_found`/`transient`), and boot reconcile purges orphan full-address keys only (bare localpart untouched). New audit event `identity.notify_route.delete`.
- **Notify: agent 通知路由改按完整地址键 + 取消跨域 `409`** (#134 Q1, #233): 新身份在 `identity.address`（小写、去尾点）下开 ntfy 路由，旧裸 localpart 键按「精确 → 回退」继续可读；同一 localpart 可在不同域共存且互不串通知（`POST /v1/identities` 不再返回 `409 localpart_conflict`）。`POST /v1/notify`、MCP `mail_notify_agent` 与 history topic 均接受完整地址（裸 localpart 在单域场景仍兼容），非法名 → `400 invalid_request`，跨域歧义的裸 localpart fail-closed（`unknown_agent`）；identity 自身频道键与 UI topic 键同步对齐。
- **Tasks: create(wait=true) 错误响应分层** (#183)：SMTP 发送成功后 wait/journal 失败不再误报裸 `502 smtp_error`。未创建仍为 `502 {error:"smtp_error"}`（无 id）；已创建后 journal 错 → `503 {error,taskId,created:true}`，其他等待异常 → `502` 同 body，`429 too_many_waits` 补 `taskId`。MCP client/`task_create` 透出 `taskId` 并提示用 `task_get`/`task_list` 查、勿重新 create。
- **Wait: 截止与剩余时间改用单一单调钟** (#211): API 侧 `waitForMessage`/logout 的 deadline 与 remaining 从 `Date.now()` 切到共享 `waitMonotonicNow()`（`performance.now` 族），MCP 客户端再武装决策共用同一钟缝 —— 宿主墙钟跳变不再导致提前 408。
- **Wait: hung logout 不再越过截止线返回 200** (#223): `logoutBounded` 区分「截止界胜出」与「断开」，截止界胜出即视为截止已跨越并丢弃 provisional，消除 `floor(remaining)` 竞态下「该 408 却返回 200」的路径。
- **`mail_wait_for`: newest-20 匹配跳过已读命中** (#230)：邮件族 wait 不再对已处理（`\Seen`）的匹配邮件立即返回，改为继续等到真超时或新的未读命中；task（`x-oa-task`）分支刻意不跳过，任务结果回取不受影响。**行为变更**：依赖「复读已读邮件」的调用方（例如先 `mail_mark_seen` 再 `mail_wait_for`）会改为等到超时，请改用未读匹配或先取列表。
- **Auth: `requireUiOrigin` 放行 `Origin: null` 的同源表单** (#234): `Referrer-Policy: no-referrer` 下 Chrome 提交 OAuth 同意页 Approve 会发 `Origin: null`，旧判定直接 403；现以 `Sec-Fetch-Site` 为主闸 —— `same-origin` 放行缺失 / 字面 `null` / 可解析同源，`cross-site` 与 `same-site` 一律 403，SFS 缺失时仅可解析同源放行（保持 fail-closed）。
- **Auth: admin API key 比对去掉短路早退** (#227, #271): `resolveAccessToken` 不再用 `Set.has` 按内容直查（该路径命中位置不同即提前返回），改为逐键 `sha256Hex` + `hashEquals` 比较（与 UI session token 同款），消除按位置可测的时序差；accept/reject 语义不变。
- **Webhooks: stale delivery-list cursors are rejected** (#216): `GET /v1/webhooks/:id/deliveries` no longer silently rewinds to page 1 on an unknown cursor; it returns **HTTP 400 `{error:"invalid_cursor"}`**, matching send-log / notify / task cursor semantics.
- **Webhooks: deliveries 读限流接线 + disable 幂等** (#219, #220): `GET /v1/webhooks/:id/deliveries` 与兄弟读路由同序接入 per-caller 读限流（超限 `429 {error:"rate_limited", retryAfterSec}` + `Retry-After`）；对已 `disabled` 的订阅再次 disable 幂等回显既有 `disabledReason`，不 mutate、不取消在途投递、不写 audit。
- **Webhooks: 内存 delivery-log 索引加行上限** (#217): 新增 `WEBHOOK_LOG_MAX_ROWS`（默认 100000），只约束进程内索引行数 —— **盘上 `webhook-deliveries.jsonl` 仍由 `WEBHOOK_LOG_RETENTION_DAYS` 压缩**；超限按滞回（裁到上限 90%）逐出最旧的非活跃行，活跃重试链永不逐出。边界行为：逐出区 `deliveryId` 的 `redeliver` → `404 delivery_not_found`；游标落入逐出区 → `400 invalid_cursor`（客户端应回首页）；某订阅全部行被逐出时 `lastDelivery: null`。
- **Webhooks: delivery 列表改吃增量内存索引** (#146): `GET /v1/webhooks/:id/deliveries` 不再每次整文件读 + 重排，过滤/排序/游标语义不变，残余读放大收口；同时把「**每信箱单 API 进程**，多进程写者会越过 `WEBHOOK_MAX_*` 上限」写进 `.env.example` / `compose.yaml` 注释。
- **Webhooks: redeliver run 号盘源流式 + 活组次级上限** (#268, #270, #272): `redeliver` 的最大 `run_N` 改为盘源 64KiB 流式扫描（O(1) 内存，避免吃截断内存视图而撞历史 run 号、boot 丢重试链）；活跃组 alone 超过 `10×WEBHOOK_LOG_MAX_ROWS` 时升 error 级可采集事件 `delivery_log_active_overflow`（仍不逐出活行）；deliveries 游标加 1024 字符硬限并按生产可生成域严格解析，非规范形态一律 `400 invalid_cursor`。
- **Dashboard: recover pagination after a stale mail cursor** (#196): load-more clears `nextCursor` on **400 `invalid_cursor`** and prompts Refresh (other errors leave the cursor alone). `GET /ui/api/messages` now maps codec cursor failures to **`invalid_cursor`** (schema failures remain `invalid_request`), so the UI recovery path is live for inbox as well.
- **Dashboard: Tasks 轮询同步第 2+ 页详情 + waiting 计数诚实化** (#264): 轮询用第 1 页替换列表时改为按 id 并集同步详情，第 2+ 页打开中的工单不再丢 `expiryProjection`；首页 waiting 计数硬停文案从裸 `500+` 改为 `500+ · scan capped`，并补「已达扫描上限、窗口外可能仍有待办」的空态（不再把封顶数当精确数）。
- **Webhook-wake 示例: readiness 硬化** (#177, #228): 非 loopback `listen.host` 必须显式 `listen.allowNonLoopback: true`（`parseFileConfig` 与 `listenReceiver` 双层拒载；`127.0.0.0/8` 整段算 loopback）；`requestTimeoutMs`/`sendTimeoutMs` ≤ 30000、`alertHook.timeoutMs` ≤ 10000，且 `requestTimeoutMs ≥ sendTimeoutMs + 2000`（`config_invalid:requestTimeoutMs.headroom`，不加高 cap）；`alertHook.url` 仅接受 `http:`/`https:`；`/ready` 增加 `.dirsync` 可替换性检查、状态文件 symlink 一律视为非普通文件；marker 写入改用同一 fd 的 `O_NOFOLLOW`，平台缺该旗时 fail-closed 而非静默降级。

### Tests

- OAuth 同意页 Chromium 回归：钉 `playwright@1.63.0`、CI 安装 Chromium，断言 Approve 表单实发 `Origin: null` + `Sec-Fetch-Site: same-origin`（#234）。
- wait-clock：钟族 flip 直接抛错 → 钉子带 family 名；dist mutator 钉子按 API / MCP 分包跑（API 侧不再 bun-build MCP）（#212, #226）。
- invalid_cursor 四族负控（未来时间戳、窗内 lookup_miss、超长/非规范形态）全部入测钉行号（#202, #270）。
- webhook delivery 内存上限与增量列表读的覆盖：逐出、滞回 90%、活跃组永不逐出、逐出后 redeliver/cursor 边界（#146, #217, #268）。
- Connect 页：bfcache 清态、loadGen 竞态、Claude 命令零凭证、shell 字节金标指纹（#231）。
- `docker-smoke` CI job（#93，见 Added）。

### Notes

- **升级注意 —— 既有 `api-data` 卷需一次性 chown 迁移**（#93, #267/#273）：旧 root 属主的具名卷必须先 `docker run --rm -v <project>_api-data:/data alpine sh -c 'chown -R 1000:1000 /data'`，再上新镜像；顺序不可颠倒（新镜像会拒启/首次写失败，这是有意 fail-fast，不是静默回退）。README runbook 明确：停 writer **不够**，必须停到 **recreate**（`restart` ≠ recreate —— root 容器回起会把文件写回 `root:root`，静默回滚迁移且无报错）；`find /data ! -user 1000` 必须零输出；`api` 与 `ntfy-provision` 同批 build（共用 Dockerfile，`--force-recreate` 会连坐一次性 provision 容器）；`docker inspect <api-image> --format '{{.Config.User}}'` 为 `bun` 才许 start。09-18 的回滚事故即此机理。
- **观测面变化（#202, #270）**：四族游标拒收（messages / send / tasks / deliveries）现在打结构化日志，标签恰三枚封顶 `{family, shape, within_retention}`，隐私硬线不输出游标原文；**400 响应体逐字不变**。路由直传 decoder 真实种类（`parse_fail` / `lookup_miss`），旧的从游标字符串软解反推形状那一层整体退役。
- **wait 钟族钉死（#214, #226）**：首次成功读钟即钉死 `performance` / `Date` 族，运行期 flip 直接抛错（响亮失败优于静默全超时）；`performance.now` 不可用时回退 `Date.now` 并 warn-once。
- **单写者前提**：`WEBHOOK_LOG_MAX_ROWS` 等进程内上限与增量索引都假定**每信箱单 API 进程**，多进程写者会越界（已写进 `.env.example` / `compose.yaml`）。
- `SOURCE_COMMIT` / `XAGT_VERIFICATION_SLUG` 目前只出现在 `compose.yaml` / `compose.api-only.yaml` 与 `packages/api/README.md`，未进 `.env.example`。

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
