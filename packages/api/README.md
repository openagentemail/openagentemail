# @openagentemail/api

REST API service for openagent.email: identities, inbox read, OTP/verification-link
extraction, wait-for-message, and send — backed by one catch-all mailbox on
docker-mailserver (IMAP read via imapflow, SMTP send via nodemailer).

## Run

```sh
bun install
bun run dev        # watch mode
bun run start
bun test           # unit tests (OTP extraction)
bun run build      # bundle to dist/ (bun build --target bun)
bun run typecheck
```

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3100` | HTTP listen port |
| `DOMAIN` | — | identity domain (`localpart@DOMAIN`) |
| `API_KEYS` | — | comma-separated **admin** Bearer keys (full access; agents should use per-identity tokens instead) |
| `MCP_PUBLIC_URL` | — | optional public origin for PRM / AS issuer / MCP loopback aud（`http(s)://…`，去尾斜杠）；反代后与浏览器所见 origin 不一致时必填 |
| `MCP_RATE_READ_PER_MIN` | `60` | `/mcp` tools/call 读桶（read 级）每分钟上限；`0` 关闭；OAuth 按 grantId、`oa_` 按 address；admin 豁免 |
| `MCP_RATE_WRITE_PER_MIN` | `20` | `/mcp` tools/call 写桶（minimal+）每分钟上限；写更严；超限 `429` + `Retry-After` |
| `MCP_MAX_WAIT_SECONDS` | `60` | 阻塞等待上限（1..600）；`timeoutSec` / task wait 静默钳到此值；见响应头 `X-OAE-Wait-Timeout-Sec` |
| `TRUST_PROXY_HEADERS` | `false` | `true` 时 `clientIp` 取 `X-Forwarded-For` 首跳；直连公网开=可伪造，见 docs/security.md |
| `OAE_PUBLIC_EDGE` | `false` | `true` 时关闭 CIMD 私网 SSRF 例外（公网 AS 应开） |
| `OAUTH_RATE_PER_MIN` | `30` | `/authorize`+`/oauth/token`+`/oauth/revoke` 预鉴权 IP 限量/分钟；`0` 关 |
| `MCP_PREAUTH_RATE_PER_MIN` | `120` | `/mcp` 无/坏 token 401 路径 IP 限量/分钟；`0` 关（引导握手探 401 余量） |
| `IMAP_HOST/PORT/USER/PASS` | `127.0.0.1:993` | catch-all mailbox login |
| `IMAP_TLS` | `true` | `false` for plaintext/STARTTLS (143) |
| `SMTP_HOST/PORT/USER/PASS` | `127.0.0.1:587` | catch-all account; From is rewritten to the identity |
| `ALLOWED_SEND_DOMAINS` | `DOMAIN` | comma list of allowed `from` domains |
| `DATA_DIR` | `./data` | 全部 store 单写者，不支持多容器共享（identities / oauth / audit / ui-sessions / sent-registry / notification-log / notification-devices；0600）。 |

## Endpoints

All `/v1/*` require `Authorization: Bearer <key>`.

- `POST /mcp` — 无状态 MCP（SDK v2 / 2026-07-28）；**需** `Authorization: Bearer`（admin / `oa_` / OAuth access）；无/坏 token → 401 + `WWW-Authenticate`；OAuth aud 不符 → 403；critical 工具对 OAuth 票 403；超限 429 + `Retry-After`（见 `MCP_RATE_*`）；JSON-RPC **batch 数组** → `400 {error:"batch_not_supported"}`（计写桶并审计 `mcp.batch_rejected`）
- `GET /.well-known/oauth-protected-resource`（及 `/mcp` path-aware 变体）— RFC 9728 PRM；**公开**；`authorization_servers` = AS issuer。可选 env `MCP_PUBLIC_URL` 覆盖对外 origin
- `GET /.well-known/oauth-authorization-server` — RFC 8414（PKCE S256、CIMD、iss 响应）；**公开**
- `GET /authorize` → `/ui/oauth/authorize` — OAuth 同意页（Dashboard 会话）；`POST /oauth/token` / `POST /oauth/revoke`；旧管理页 `/ui/oauth/grants` 需会话后 302 → `/ui/configure/clients`
- Dashboard（ADR #26 PR1–PR6）：`/ui` 与 `/ui/*` shell 子路径（Inbox 默认落地），静态资源仍为 `/ui/styles.css` + `/ui/app.js` 单资源、零 bundler。Inbox 桌面三栏（identity/folder、list、detail）；`GET /ui/api/messages?address=&folder=inbox|sent|all&cursor=&limit=` 返回 `{messages,nextCursor}`，未知 folder 为 400；`GET /ui/api/messages/:id/source?address=` 受控 Source（同 ACL、256KiB 截断、`no-store`）。HTML 仍只进 `/ui/frame` sandbox。Bearer `/v1/messages` 仍为 Inbox（TO 匹配）、无 folder。Overview 全局导航仅 admin session 可见；shell 深链注册在 `/ui/api`、`/ui/oauth`、`/ui/frame` 之后。Tasks 工单板：`GET /ui/api/tasks?status=active|submitted|working|input-required|completed|failed|all&period=24h|7d|14d|30d&limit=20|50|100&cursor=` 返回 `{tasks,nextCursor,totalApprox,queryNow}`（默认 active=submitted+working；terminal 仅 `updatedAt>=now-30d` 可见，不删 IMAP）。`POST /ui/api/tasks/:id/reply`（仅 input-required → working）；admin-only `POST /:id/remind`（新 reminder event，不改 state）与 `POST /:id/close` `{reason}`（terminal failed + `closed_by_admin`；已 terminal 409）。Bearer `/v1/tasks?state=` 保持 MCP 兼容。Push & Devices：admin-only `GET|POST|DELETE /ui/api/notify/devices`（identity 与非 admin 一律 403）；POST 一次性 password + QR modules，`Cache-Control: no-store`。
- OAuth 存储：`DATA_DIR/oauth.json`（只存哈希；与 identities.json 同模式）
- `GET /v1/audit/events?limit=&event=` → `{events:[…]}`（**admin only**；scrubbed JSONL `DATA_DIR/audit.jsonl`；见 docs/security.md）
- `POST /v1/identities` `{name?, localpart?}` → `201 {address, name?, pushContentTier, token}` (409 if taken)
- `GET /v1/identities` → `{identities:[{address,name?,createdAt,pushContentTier,...}]}`
- `GET /v1/identities/:address/push-tier` → `{address, pushContentTier, warning?}` (admin any; identity own only)
- `PUT /v1/identities/:address/push-tier` `{pushContentTier:1|2|3, confirm_risk?}` → admin only; tier 3 requires `confirm_risk: true`
- `GET /v1/messages?address=&limit=50` → `{messages:[{id,from,to,subject,date,seen,snippet}]}`. Only the **newest 500 messages in the shared catch-all** are scanned for a match, so on a very busy instance an identity's older mail can fall outside that window and stop being listed even though retention has not deleted it yet
- `GET /v1/messages/:id?address=` → `{id,from,to,subject,date,text,html?,otp:{codes,links}}`
- `POST /v1/messages/:id/seen` `{address, seen}` → `{id, seen}` (404 unless the message is TO `address` **or** a server-trusted Sent item (From match **and** Message-ID in the outbound registry) — #26 PR 2 / 返工第2轮；reading never sets `\Seen` by itself — agents mark messages processed through here)
- `POST /v1/messages/wait` `{address, fromContains?, subjectContains?, timeoutSec?≤600}` → message or `408 {error:"timeout", timeoutSec}` (IMAP IDLE + 3 s polling hybrid). Schema max 仍 600；服务端按 `MCP_MAX_WAIT_SECONDS` 静默钳制（头 `X-OAE-Wait-Timeout-Sec`）。并发：3/地址、8 全局 → `429 {error:"too_many_waits"}`
- `POST /v1/send` `{from,to,subject,text,html?}` → `{queued:true, messageId}` (403 if `from` is not a known identity)
- `POST /v1/notify/devices` `{publicUrl, displayName?}` → `201` 一次性 ntfy 凭据（password / `qrPayload` / `qr` 只此一次；`Cache-Control: no-store`）。旧 client 只传 `publicUrl` 仍可用，缺省 displayName=`Phone`。**admin only**
- `GET /v1/notify/devices` → `{devices:[{id,displayName,topicLabels,pairedAt,revokeStatus,…}]}`（默认隐藏 `revoked`；不含 password/token）。**admin only**
- `DELETE /v1/notify/devices/:id` → `204`（`pending_revoke` 中间态；ntfy 缺失 user = HTTP 400/code 40031 或 404+缺失正文，视为成功；已 revoked 幂等 204）。ntfy 临时关闭且行含 `ntfyUsername` 时 `503`，不标 revoked。**admin only**
- `GET /healthz` → `{ok:true}`

## Operating notes

- **Inbox scan window.** Every identity reads the same catch-all mailbox, and
  list/wait scan its newest 500 messages (`SCAN_BACK` in `src/lib/imap.ts`) to
  find the ones addressed to the caller. Mail that is still within
  `RETENTION_DAYS` but sits behind 500 newer messages is invisible to the API.
  Keep `RETENTION_DAYS` tight enough that the mailbox stays well under that,
  or raise `SCAN_BACK` (it costs one envelope fetch per message per call).
- **Identity store integrity.** `DATA_DIR/identities.json` is the only copy of
  every identity and its token hash, and it is written 0600 in a 0700 dir. If
  it is ever damaged (manual edit, filesystem trouble) the API **fails closed**
  rather than treating it as empty — an empty store would be saved over the
  damaged one on the next create/rotate and lose every identity. While it is
  damaged, anything that reads the store answers `500`: that is every request
  authenticated with an identity token, plus all `/v1/identities` calls.
  **`GET /healthz` does not read the store and keeps returning `{ok:true}`, so
  the container healthcheck stays green** — watch the API log for
  `identity_store_corrupt` and restore the file from backup.
- **Notification log.** `DATA_DIR/notification-log.jsonl` records successful
  ntfy publishes for 30 days (0600, single-writer queue, UTC daily compact).
  Do not backfill ntfy 12h cache into it. Trailing half-lines are isolated to
  `notification-log.jsonl.partial`; a corrupt line in the middle fail-closes
  queries (`500 notification_log_corrupt`). See `docs/security.md`.
- **Paired devices.** `DATA_DIR/notification-devices.json` is the instance device
  registry (0600, directory 0700, single-writer queue, same-dir `.tmp` + fsync
  file + rename + fsync directory). It stores id / displayName / ntfyUsername / topic labels / pairedAt /
  lastSeenAt / revokeStatus / revokedAt — **never password or token keys**
  (the persist guard walks object keys, so a displayName like
  `My "password": vault` is allowed). Revoke is
  `active → pending_revoke` (persist first; failure must not call ntfy) → delete
  ntfy user (live ntfy missing user is HTTP 400 / code 40031 / "user does not
  exist"; HTTP 404 counts as success **only** with code 40031 or that text —
  a bare `not_found` substring such as `{"error":"route_not_found"}` is
  transient; **all 5xx are transient regardless of body text**) → `revoked`.
  Revoke reconciles other pending rows but skips the target so one call
  issues a single DELETE. If ntfy is temporarily disabled or the admin
  password is missing **and** the registry row has an `ntfyUsername`, revoke
  is refused (503) so a still-valid phone credential is not marked revoked.
  Already-revoked rows stay idempotent 204 with no outbound call. Local
  converge is only for rows with no remote username (ntfy never provisioned). Pairing QR is ISO/IEC 18004
  byte-mode ECC-M: data codewords are column-interleaved across RS blocks
  (short blocks skip the extra data column), then ECC columns follow. Alignment
  patterns are drawn after timing and overwrite it except the three finder
  corners. Format information is stored at ISO (x,y) into `modules[y][x]`.
  Pairing QR canvas includes a 4-module quiet zone. Startup
  inspect fail-closes a corrupt registry without blocking the rest of the API
  (startup `initializeNotifications` reconcile swallows the same corrupt error).
  Overwrite persist keeps the previous registry as `.bak` and restores it if
  directory fsync fails, so a 502 matches the on-disk devices. If dest is
  missing and `.bak` cannot be renamed back, the registry fail-closes instead
  of treating the store as empty. After a rollback (unlink dest or restore
  `.bak`), the directory is fsynced again; a second fsync failure fail-closes
  the registry (`.failclosed` marker, all evidence files kept). If directory fsync, `.bak` rename, and the
  in-memory snapshot write all fail, the new dest is isolated as `.unrestored`
  and the API fail-closes; `.bak` is kept and must not be discarded.
