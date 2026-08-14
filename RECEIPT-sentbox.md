# RECEIPT — #1 Sent box light（发送审计日志 + Sent 视图接通）

日期：2026-08-14  
工位：`/home/ops/orca/workspaces/openagentemail/worker-34-pr1`  
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
| 4 | `/v1/send` 响应带 logged `id`；MCP `mail_send` 同路 | **过** | `send.ts` 200/502/429 均可带 `id`；MCP `X-OAE-Send-Source: mcp`；`sendOutputSchema.id` optional |
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
| `cd packages/api && bun test` + `bun run build` | **过** | **836 pass / 0 fail**；`bun run build` Bundled 569 modules |
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

## 独立自审

- **禁止自审自。** 见文末表。

---

## 本地起服务拍屏指引

工位默认读仓库根 `.env`（**不要改**）。API 在 `packages/api`。

### 1. 起服务

```bash
cd /home/ops/orca/workspaces/openagentemail/worker-34-pr1/packages/api
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

MCP 同路（可选）：MCP `mail_send` 会带 `X-OAE-Send-Source: mcp`，详情 Source=MCP。或：

```bash
curl -sS -X POST "http://127.0.0.1:3100/v1/send" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-OAE-Send-Source: mcp" \
  -d "{\"from\":\"$FROM\",\"to\":\"$TO\",\"subject\":\"Sent-box mcp sample\",\"text\":\"x\"}"
```

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
| 初审 | `1add3fcf-0359-481b-a889-174515edeb25` | **mergeable** | 0 / 0 / **1** | 对照 `3965e01` 未提交 diff。ACL / 无正文 / 不进 INBOX / sweeper / 徽章双通道过。P2：`writeAtomicSync` 目录 fsync 失败时 `openSync(dest,'w')` truncate 活文件再回写；崩溃或二次写失败会把 30 天审计静默清空。相对 notification-devices 的 bak+rename 是新发明。 |
| 复审（新 agent，禁止自审自） | `6cdf75fb-b7f3-4b24-b094-f421167bf412` | **mergeable** | **0 / 0 / 0** | 独立读 `writeAtomicSync` / `restoreOverwrittenLog` / `recoverBackupSync`，对照 `notification-devices.ts`。主回滚已是 dest→bak、失败 bak 换回；dest 缺+bak 在则恢复。P2 **过**。No findings。 |

初审 P2 已修：覆盖写 dest→`.bak`；目录 fsync 失败 bak 换回；测试断言磁盘仍含旧行；dest 缺失 leftover bak 恢复。未抄 devices 的 `.unrestored` / 落盘 failClosed（复审列为残余，不升 P1）。
