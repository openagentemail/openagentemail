# RECEIPT — #1 Sent box light（发送审计日志 + Sent 视图接通）

日期：2026-08-14  
工位：`<worktree>`  
分支：`tizerluo/worker-34-sentbox`（基线 `origin/main` **`3965e01`**）  
PR：https://github.com/openagentemail/openagentemail/pull/33  
禁动 main，禁止自 merge。PR 描述 **refs #1**，不用 closes（full 版留 issue 收集需求）。

## 交付

light 版：`/v1/send`（成功 + 失败）落 30 天 JSONL 审计；Dashboard Sent 改读该日志；响应回传 logged `id`；MCP `mail_send` 同路。无正文审计轨。SMTP 直发不审计。

## 范围 5 条对账

| # | 范围 | 结果 | 证据 |
|---|---|---|---|
| 1 | 发送审计 service：time/from/to/subject/message-id/结果(queued\|failed+原因)/来源(api\|mcp)；JSONL append-only、0600、进程内 serial queue、tmp+fsync+rename+目录 fsync、30 天 sweeper；corrupt fail-closed；照 notification-devices / notification-log | **过** | `packages/api/src/lib/send-log.ts`；启动 `startSendLogMaintenance()`（`main.ts`） |
| 2 | GET 发送历史：admin 全量+按地址筛；identity 只看自己（from=自己），看他人 403；limit/cursor 沿用 task 板 20\|50\|100 + HMAC | **过** | `GET /v1/send/history` + `GET /ui/api/send-log`；`send-history.test.ts` |
| 3 | UI Sent 改读审计日志：列时间/双方/主题/结果徽章（queued 金 / failed 红+文字）；详情无正文；诚实口径；空态改掉 | **过** | `inbox.ts` / `app.ts` / `pages.ts`；`ui-assets.test.ts` |
| 4 | `/v1/send` 响应带 logged `id`；MCP `mail_send` 同路 | **过** | `send.ts` 200/502/429 均可带 `id`；MCP `X-OAE-Send-Source-Mac` HMAC；`sendOutputSchema.id` optional |
| 5 | 边界诚实声明：本期只覆盖 API/MCP，SMTP 直发不审计 | **过** | `docs/security.md`「Send audit log（#1 light）」；`packages/api/README.md`；根 `README.md` Sent 一句 |

## 验收对账

| 项 | 结果 | 证据 |
|---|---|---|
| 发送一条→Sent 可见（时间/双方/主题/结果徽章） | **过** | `successful send returns logged id and appears in Sent history`；UI 行：from/to + `Queued`/`Failed` 徽章 + `data-result` |
| 失败发送也留痕带原因 | **过** | `failed send is recorded with smtp_error`；429 记 `rate_limited`；详情 `Failed · smtp_error` |
| identity 只见自己、越权 403（测试+curl） | **过** | `identity only sees own sends; peeking at a peer is 403`；`UI send-log mirrors ACL and identity 403`。curl 见下方拍屏指引 |
| 审计日志 grep 无正文/无 token 明文，0600 | **过** | 成功用例断言磁盘不含 `BODY-SECRET` / identity token，`mode & 0777 === 0600`；parse 遇 `text`/`html`/`token`/`body` 当坏行 |
| 30 天 sweeper | **过** | `query hard-clamps to 30 days`；`compact drops rows older than 30 days`；启动 + UTC 午夜 `compactSendLog` |
| 分页 | **过** | `pagination cursor is bound to address filter`（跨 address 游标 `invalid_cursor`） |
| 磁盘满/只读/corrupt 恢复（PR 6 标准） | **过** | `disk-full persist hook…`；`readonly data dir append fails closed…`；`middle corrupt fail-closes query`；`dir fsync failure on compact rolls back dropped rows`（断言磁盘仍含旧行）；`dest missing with leftover bak is restored instead of empty log` |
| Sent 副本不进 catch-all INBOX、不污染 unseen（watch out #1） | **过** | `/v1/send does not IMAP-append and smtp/send have no APPEND`：`send.ts` 不 import imap、无 APPEND；`smtp.ts` 无 APPEND/imap |
| `cd packages/api && bun test` + `bun run build` | **过** | R1 后 **848 pass / 0 fail**；`bun run build` Bundled 570 modules |
| MCP 同路 | **过** | `packages/mcp bun test` **24 pass**；`mail_send 输出含可选审计 id`；`bun run build` 全绿 |

### 测试名

**send-log.test.ts**

- `append writes one schema row without body or token`
- `failed row stores stable error code only`
- `query hard-clamps to 30 days`
- `compact drops rows older than 30 days`
- `pagination cursor is bound to address filter`
- `disk-full persist hook surfaces persist error and leaves no secret`
- `readonly data dir append fails closed without writing a body`
- `middle corrupt fail-closes query`
- `dir fsync failure on compact rolls back dropped rows`（bak+rename，磁盘断言旧行仍在）
- `dest missing with leftover bak is restored instead of empty log`

**send-history.test.ts**

- `successful send returns logged id and appears in Sent history`
- `failed send is recorded with smtp_error`
- `identity only sees own sends; peeking at a peer is 403`
- `MCP header tags source=mcp`
- `UI send-log mirrors ACL and identity 403`
- `/v1/send does not IMAP-append and smtp/send have no APPEND`

## 实现备注（非分叉，不拦合并）

- 覆盖写回滚对齐 `notification-devices`：dest→`.bak`，目录 fsync 失败则 bak 换回，**不** truncate 活文件。dest 缺而 bak 在则启动恢复，禁止当空日志。
- 记盘失败只打 `[send-log] HIGH:`，不改 SMTP 结果（200/502 仍按 SMTP；此时响应可无 `id`）。
- 失败原因落盘为稳定码（`smtp_error` / `rate_limited`），不写 SMTP 原文/密码。
- Dashboard **Sent 文件夹**改读 `/ui/api/send-log`。IMAP `folder=sent`（All Mail / 可信 Sent / sent-registry）未改；那是 #26 PR 2 的信封可信规则，不是本 light 审计视图。
- light 版不 IMAP-append，故 watch out #1 用源码断言 + 行为上 send 不碰 imap。
- 未改 `.env`。未提交 `.mimosa/`。

---

## 本地起服务拍屏指引

工位默认读仓库根 `.env`（**不要改**）。API 在 `packages/api`。

### 1. 起服务

```bash
cd <worktree>/packages/api
bun run src/main.ts
```

浏览器：`http://127.0.0.1:3100/ui`（或 `.env` 里的端口）。用 **admin** token 登录。

### 2. 造 queued 样例（成功发送）

取一个已有 identity（Overview 表），或 admin 新建一个。然后：

```bash
# 把 ADMIN_TOKEN / FROM / TO 换成现网值。TO 可以是外网测试箱。
curl -sS -X POST "http://127.0.0.1:3100/v1/send" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"$FROM\",\"to\":\"$TO\",\"subject\":\"Sent-box queued sample\",\"text\":\"body must not appear in send-log.jsonl\"}"
```

期望：`200 {"queued":true,"messageId":"…","id":"snd_…"}`。  
Dashboard → 该身份 → **Sent**：应见时间、From、To、主题、金色 **Queued** 徽章（不只靠颜色）。点开：详情行（From/To/Result/Message-ID/Source），**无正文**。页顶口径：`API/MCP send audit (30 days). Direct SMTP is not listed.`

磁盘核对（路径以 `.env` 的 `DATA_DIR` 为准，默认 `./data`）：

```bash
stat -c '%a %n' "$DATA_DIR/send-log.jsonl"   # 期望 600
grep -n -E 'body must not|sk-proj-|Bearer |token' "$DATA_DIR/send-log.jsonl" || echo 'no body/token plaintext'
```

### 3. 造 failed 样例

任选其一：

- **SMTP 对端拒收：** `to` 填明显非法本域或会被 550 的地址，再 POST `/v1/send`。期望 `502 {"error":"smtp_error","id":"snd_…"}`。Sent 行红色 **Failed** + 文字；详情 `Failed · smtp_error`。
- **配额：** 同一 from 连打超过 `SEND_RATE_LIMIT`（默认 20/小时）次。期望 `429` 且历史多一条 `error=rate_limited`。

MCP 同路（可选）：进程内 `/mcp` 的 `mail_send` 会注入 `X-OAE-Send-Source-Mac`。裸 `X-OAE-Send-Source: mcp` **不再**被信任，会记 `api`。

### 4. identity 对照（越权 403）

准备两个 identity：`fox@…` / `owl@…`，admin 各发一条。用 **fox 的 identity token** 登录 Dashboard：Sent 只见 fox 的行。

curl 留证：

```bash
# 只见自己
curl -sS -D- "http://127.0.0.1:3100/v1/send/history?limit=20" \
  -H "Authorization: Bearer $FOX_TOKEN"

# 看他人 → 403 forbidden: token is scoped to another address
curl -sS -D- "http://127.0.0.1:3100/v1/send/history?address=$OWL_ADDRESS" \
  -H "Authorization: Bearer $FOX_TOKEN"
```

UI 会话同口径：identity cookie 打 `/ui/api/send-log?address=$OWL_ADDRESS` → 403。

### 5. 拍什么

1. admin Sent 列表：queued 金徽章 + failed 红徽章（带文字）。  
2. 点开 queued / failed 各一张（无正文、有原因）。  
3. 页上诚实口径可见。  
4. identity 会话 Sent 只有自己的 from。  
5. 终端：403 curl + `stat` 600 + grep 无正文。

---

## 独立自审

| 轮 | Subagent ID | 结论 | P0/P1/P2 | 过程 |
|---|---|---|---|---|
| 初审 | `1add3fcf` | **mergeable** | 0 / 0 / **1** | 对照 `3965e01` 未提交 diff。ACL / 无正文 / 不进 INBOX / sweeper / 徽章双通道过。P2：`writeAtomicSync` 目录 fsync 失败时 `openSync(dest,'w')` truncate 活文件再回写；崩溃或二次写失败会把 30 天审计静默清空。相对 notification-devices 的 bak+rename 是新发明。 |
| 复审（新 agent，禁止自审自） | `6cdf75fb` | **mergeable** | **0 / 0 / 0** | 独立读 `writeAtomicSync` / `restoreOverwrittenLog` / `recoverBackupSync`，对照 `notification-devices.ts`。主回滚已是 dest→bak、失败 bak 换回；dest 缺+bak 在则恢复。P2 **过**。No findings。 |

初审 P2 已修：覆盖写 dest→`.bak`；目录 fsync 失败 bak 换回；测试断言磁盘仍含旧行；dest 缺失 leftover bak 恢复。未抄 devices 的 `.unrestored` / 落盘 failClosed（复审列为残余，不升 P1）。

---

## 返工 R1（2026-08-14 · PR #33）

同一分支 `tizerluo/worker-34-sentbox` 就地修。未新开分支、未动 `main`、未自 merge。

### 评论对账

| # | 来源 / 评论 id | 问题 | 处置 | 证据 / 测试名 |
|---|---|---|---|---|
| A① | Codex 云端 `3782080125` + CodeRabbit Major `3782097391` + ZCode P1-1 | `rate_limited` 无界刷盘 | **已修。** 每身份每 1h 窗口最多落 1 条；后续 429 只响应不落盘。 | `N rate-limited requests log only one rate_limited row` |
| A② | 同上 | 单行体积无上界 | **已修。** `sendSchema` from/to 单项 `.max(254)`；`parseRecord` 同步长度校验。 | `oversized to address is rejected…`；`oversized address is clipped…`；`parseRecord rejects a giant from on disk as corrupt` |
| A③ | 同上 | 日志无硬上限 | **已修。** 选型：**10_000 行或 8MB**（先到先限）。append 超限 drop-oldest；compact 同时按年龄+大小。 | `hard cap drop-oldest on append and compact by size` |
| A④ | 同上 | append 全量 `inspectAndRepairSync` | **已修。** 热路径不扫整文件：末行完整则补 `\\n`，半行隔离到 `.partial` 再截断；inspect 仅 query/compact/启动/超限。 | `append hot path does not full-reparse as the file grows`；`torn trailing line is isolated without fail-closing the log`；`complete last line missing newline is kept then appended` |
| B | Codex Local `d8ec70b` + CodeRabbit Major `3782097376` | 首次创建丢目录项 | **已修。** 新建 `send-log.jsonl` 关 fd 后 fsync `DATA_DIR`；失败 unlink + persist 失败。 | `first-create dir fsync failure fails persist and leaves no file` |
| C | Codex Local `57c3454a` + 云端 `3782080137` + CodeRabbit Major `3782097385` + ZCode P2-1 | `X-OAE-Send-Source` 可伪造 | **已修。** 不再信任该公共头。`taskSigningSecret` 域分离 `send-source-v1` → `X-OAE-Send-Source-Mac`；验签通过才记 mcp。HTTP `/mcp` 注入 `config.taskSigningSecret`。 | `forged X-OAE-Send-Source still records api`；`valid send-source MAC records mcp; bad or missing MAC records api`；`OpenAgentEmailClient.send injects MAC and records mcp` |
| D | ZCode P2-2 | 双 email 校验器 + 落盘失败静默 | **已修。** 落盘层删 `EMAIL_RE`，只 `clipEmail` 长度截断。`append_failed_after_send` 走 `[send-log] HIGH:`（同 notification-log）+ 告警环。 | `persist failure after send raises HIGH alert and still returns 200` |
| E | CodeRabbit `3782097421` + ZCode P2-3 | MD024 双标题；工位路径/UUID 进公开仓 | **已修。** 合并为一个「独立自审」；路径改 `<worktree>`；UUID 留前 8 位。 | 本文件 |
| F | 记债，不改码 | `taskSigningSecret` 回退 `SMTP_PASS`；查询入口限速 | **记债。** 专用 secret 是运维项，本轮不改 env 契约。查询未另加限速：history 已鉴权，A③ 把单次解析上界钉在 10k/8MB；再加滑动窗口属产品决策。 | 见下「记债」 |

### 记债（F）

1. **生产强制专用 `TASK_SIGNING_SECRET`：** 现网仍允许回退 `SMTP_PASS`（升级兼容）。运维应在 Compose 里写满 16+ 专用 secret，本 PR 不改解析契约。
2. **查询入口限速：** 未做。A④ 已把全量解析移出 append 热路径；query/compact 仍全量但文件有硬上限，最坏解析有界。history 需 admin/identity。若要防认证后扫盘，另开单加与 send 独立的滑动窗口。

### 独立自审（R1 · 新 agent，禁止自审自）

| 项 | 值 |
|---|---|
| Subagent ID | `6b679e38`（初审）→ `f6a3b246`（复审） |
| 审查对象 | 相对 `d8ec70b` / PR #33 的 R1 diff |
| 结论 | **mergeable**（复审） |
| P0 / P1 / P2 | 初审 0/1/0；复审 **0/0/0** |
| 过程 | 初审独立核 A①–④、C 均过；P1：热路径缺换行只补 `\\n` 会把崩溃半行钉成 `middleCorrupt`。已改为只解析末行尾块（完整则补换行，半行进 `.partial`+truncate）。复审自推调用链，P1 **过**，No findings。 |
