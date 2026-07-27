# Block 1 终版合成报告（arena/b1-final）

- 执行：Cursor（Block 1 胜者），依据 `/Users/tizerluo/Kimi-workspace/.arena/JUDGING.md` 的合并蓝图
- 分支：`arena/b1-final`，**从 `main`（370130d）重新长出**，17 个全新 commit，不做分支对撞
- 工作区：`/Users/tizerluo/Kimi-workspace/.arena/wt-cursor`
- 禁令遵守：未 push、未切换或改动 main、未进入对手 worktree（对手代码只用 `git show arena/b1-codex:...` 只读参考）

## 最终验证

| 检查 | 结果 |
|---|---|
| `packages/api` `bun test` | **101 pass / 0 fail / 248 assertions**（基线 44） |
| `packages/api` `tsc --noEmit` | 通过 |
| `packages/api` `bun run build` | 通过（main.js 3.78 MB） |
| `packages/mcp` `bun test` | **8 pass / 0 fail / 39 assertions**（基线：无测试） |
| `packages/mcp` `tsc --noEmit` | 通过 |
| `packages/mcp` `bun run build` | 通过（main.js 0.67 MB） |
| `docker compose config --quiet` | 通过（用临时 .env，跑完即删，worktree 干净） |
| 每个 commit | 先写复现测试（红）→ 改代码（绿），全程 API 测试没有出现过红色残留 |

## 蓝图逐条落地

### 取 Cursor 版（含互审修订）

| # | 蓝图条目 | commit | 验证 |
|---|---|---|---|
| 1 | F1 身份匹配（合成版） | `d471501` | `test/imap-match.test.ts` 16 例 + `test/imap.test.ts` 端到端 3 例；旧逻辑下 6 红 |
| 2 | F2 `decodeEntities` 越界防护 | `2ada54e` | `test/otp.test.ts` "malformed numeric entities" 6 例，5 红→绿 |
| 3 | F3 INTERNALDATE 排序 | `560da0f` | `receivedAtMs` 4 例 + `listMessages` 端到端排序 1 例，5 红→绿 |
| 4 | F4 href 实体解码（排在 F2 之后） | `f89f6c6` | `extractLinks` 3 例（含"href 里越界实体不打崩"），3 红→绿 |
| 5 | F5 wait 并发（全局上限降到 8） | `ca9d9a6` | `ratelimit` 7 例 + 路由端到端 1 例（4 个并发 wait 恰好 1 个 429） |
| 6 | F6 MCP limit 200 | `09ea53c` | 新建 `packages/mcp/test/tools.test.ts`，1 红→绿 |
| 7 | F7 身份库权限（+ 已存在目录 chmod） | `4973f94` | `identities.test.ts` 先把 DATA_DIR 改成 0755 再断言，红→绿 |

**第 1 条的合成细节**（蓝图要求"Cursor 的字段/折行处理 + 剥注释 + 不认显示名里的邮箱"）：
收件头先做折行还原 → 按字段名过滤（只认 `Delivered-To` / `X-Original-To` / `Envelope-To` / `X-Forwarded-To` / `To` / `Cc` / `Bcc`）→ 剥掉 RFC 5322 注释 `(...)` → 按逗号拆地址表 → 有尖括号时**只取尖括号里的 mailbox** → 整地址相等比较。四类越权在测试里逐条钉死：后缀（`k7d2@d` 读 `fox-k7d2@d`）、catch-all 后缀（`ent@d` 读全信箱）、显示名里的邮箱（`"victim@d" <other@d>`，Codex 复核抓出的残留变体）、注释里的第三方地址（`victim@d (fwd attacker@d)`，我方自认的宽松）。同时保留 6 条"正常投递仍要能命中"的回归（密送、折行、多地址、尾部标点、大小写、信封 To/Cc/Bcc）。

**第 5 条的修订**：全局上限 24 → **8**。Dovecot 默认 `mail_max_userip_connections` 是 10，list/read 的一次性连接要在同一配额里留余量（Codex 复核抓出）。另加路由层端到端测试，补上"只测了计数器"的盲点。

### 取 Codex 版（含互审修订）

| # | 蓝图条目 | commit | 验证 |
|---|---|---|---|
| 8 | #2 加锁失败关连接（+ 补 `await`） | `6a76878` | `test/imap.test.ts` "IMAP 连接清理" 2 例，2 红→绿 |
| 9 | #3 SMTP 报错脱敏（诊断进日志） | `b196a0e` | `test/send.test.ts` 4 例：响应无内幕、日志留 `EENVELOPE 550 …`、密码变 `[redacted]` |
| 10 | #4 配额退还（**重做**） | `c7ffa66` | 5 例：`isLocalSendFailure` 三类 + 对端拒收跑满限额后 429 + 本机故障退还 |
| 11 | #5 身份库损坏 fail-closed（+ 可观测性文档） | `620e0a2` | 3 例：截断 JSON / 结构不对全路径抛错、修好后照常 |
| 12 | #7 MCP URL 凭据脱敏（+ 保留 `err.code`） | `4be1501` | `packages/mcp/test/client.test.ts` 7 例 |
| 13 | #8 请求体 16 MiB 上限 | `275b059` | `test/request-size.test.ts` 2 例：17 MiB→413（改前 400）、正常体不受影响 |
| 14 | #10 MCP 输入约束对齐 | `7052f5a` | `tools.test.ts` 逐边界断言（200/201、998/999、1e6±1、地址、`"7"/"0"/"../7"`） |

**第 8 条的扩展**：Codex 只修了 `withInbox`，`waitWithIdle` 里同样的"锁在 try 之前"仍然漏连接（我方复核指出过这条能绕过 wait 槽位——槽位已归还、连接还挂着）。两处都修，且 wait 路径统一按 `withInbox` 的规矩来：出错走 `close()`（不等可能卡住的 LOGOUT），正常走 `logout()`。测试用 `await expect(...).rejects`，补上原测试缺的 `await`。

**第 9 条的修订**：响应给稳定的 `{"error":"smtp_error"}`，**原因写进服务端日志**（`describeFailure` 保留适配器 code、SMTP 应答码和消息，并把配置里的 IMAP/SMTP 密码替换成 `[redacted]`）。两家复核的共同意见：Codex 原版把错误从响应和日志里同时抹掉，自托管用户排障无从下手。

**第 10 条的重做**：只有"信根本没出本机"（`ECONNECTION`/`EAUTH`/`ESOCKET`/... 且没有任何 SMTP 应答码）才退还额度；**只要邮局应答过（含 550 拒收）就照常计数**；认不出来的错误按已消耗处理。Codex 原版无条件退还，我方实测 `SEND_RATE_LIMIT=1` 下 50 次失败投递全部放行到 SMTP —— 这条回归被写成测试钉死（跑满 `config.sendRateLimit` 次 550 后必须 429）。

**第 11 条的文档**：`packages/api/README.md` 新增 "Operating notes"，写明损坏期间**身份令牌请求与 `/v1/identities` 全线 500，而 `/healthz` 不读身份库、healthcheck 仍然绿**，要盯日志里的 `identity_store_corrupt`。

### 文档收尾

| 条目 | commit | 内容 |
|---|---|---|
| R1 删身份后同名重开可读旧信 | `7240220` | `docs/security.md` 明确"不要复用已删除身份的 localpart"，并注明网站仓库是正源、需同步镜像 |
| R7 `SCAN_BACK=500` 可见性边界 | `322eea0` | `packages/api/README.md` 接口说明 + Operating notes 各补一处，写清两个调节杆 |
| R6 `TLS_REJECT_UNAUTHORIZED` 死配置 | `e0a25f3` | 从 `compose.yaml` 删除，换成指向 `imap.ts`/`smtp.ts` 硬编码 `rejectUnauthorized:false` 的注释；无行为变化 |

## 留给业主拍板（未实施，蓝图明列）

1. **R1 是否做"读信过滤 createdAt 之前"的开关** —— 会改变现有部署的可见性语义（先收信后建身份的用法会突然看不到旧信），还要处理容器与 Dovecot 的时钟偏差。当前只写了文档警告。
2. **R4 限流是否按收件人计费** —— 一封信最多 50 个收件人却只计 1 次，默认可达 1000 recipients/hour；改成按收件人计数会改变 `SEND_RATE_LIMIT` 这个配置项的含义，属行为破坏性变更。

## 合成过程中发现、但未纳入蓝图的残留（如实记录）

- **`isIdentity` 要求每条记录都有 `createdAt: string`**（照蓝图取 Codex 版）。若真存在缺该字段的历史身份库，行为会从"静默清空"变成"整库拒服"。当前代码路径的 `createIdentity` 一直会写 `createdAt`，风险低，但合并进 main 前值得在 dogfood 实例上 `cat identities.json` 确认一眼。
- **`extractCodes` 的关键词窗口误提取**（Cursor R2）：Codex 复核给出了反例 `Order number 12345678. Your verification code is 483920.` → `["12345678","483920"]`，无关数字在前时 `codes[0]` 就是错的。我方原报告"codes[0] 仍正确"的说法不成立，这条比 low 更值得重视，但启发式调优需要真实语料回归，蓝图未列，本次未动。
- **实体解码只覆盖手写的几个 named reference**（`&amp;` `&lt;` `&gt;` `&quot;` `&nbsp;` `&apos;`/`&#39;` + 数字实体），`&AMP;` 等大小写变体和其余 HTML 命名实体不认。常见邮件序列化输出已覆盖，蓝图未列。
- **`bodyLimit` 的测试只覆盖带 `Content-Length` 的请求**，`Transfer-Encoding: chunked` 的流式超限走 Hono 内部另一段逻辑，未加覆盖。
- **测试与 `config` 单例的耦合**：`config.ts` 在 import 时解析环境变量，同一次 `bun test` 里由最先 import 它的文件定终身。本次新增的测试凡是涉及密码/限额的，都改成显式传参或只断言与配置无关的性质（例如"不是 413"而不是"是 403"），避免出现依赖文件执行顺序的假绿。

DONE

## 终检返工（2026-07-27）

- **FAIL-1（蓝图 #9）** `170a533` —— `packages/api/src/lib/redact.ts` 跳过长度 <4 的密码，而 config 对 `IMAP_PASS`/`SMTP_PASS` 只要求 `min(1)`，1–3 字符的合法密码会原样进服务端日志。改为**任意长度的非空密码一律脱敏**（按长度降序替换，避免长短密码互相截断；空串跳过以免把整段文本切碎）。回归测试 `test/send.test.ts`："再短的配置密码也要脱敏"、"空密码不会把整段文本切碎"、"多个密码同时脱敏，长的优先，避免互相截断"，改前 2 红改后全绿；顺带把一条依赖 config 单例密码的旧断言改成显式传参。API 104 pass / 0 fail。
- **FAIL-2（蓝图 #12）** `62e27a0` —— `packages/mcp/src/lib/client.ts` 的 `apiUrlForDisplay` 在 `new URL()` 失败时只剥 userinfo、其余原样返回，而 URL 之所以非法通常正是因为用户手敲错了，凭据就在那串错东西里（`http://[::1?token=…`、`://bad?api_key=…` 实测全泄漏）。解析失败路径现在同样脱敏 **userinfo + 形似凭据的 key=value（token/key/secret/pass/auth/credential）+ 整个 fragment**，同时保留主机和无关参数（`?apiKey=REDACTED&page=2`）。回归测试 `packages/mcp/test/client.test.ts`"解析失败的 URL 也要把敏感 query 抹掉"含终检给的两个非法 URL 加一个 userinfo+query+fragment 混合用例，改前红改后绿。MCP 9 pass / 0 fail，tsc + build 通过。

返工后全量：**API 104 pass / 0 fail，MCP 9 pass / 0 fail**，两包 `tsc --noEmit` 与 `bun run build` 均通过；历史未回滚，两处修复以追加 commit 落在 `arena/b1-final` 上。

REWORK-DONE

