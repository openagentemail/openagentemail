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
| `IMAP_HOST/PORT/USER/PASS` | `127.0.0.1:993` | catch-all mailbox login |
| `IMAP_TLS` | `true` | `false` for plaintext/STARTTLS (143) |
| `SMTP_HOST/PORT/USER/PASS` | `127.0.0.1:587` | catch-all account; From is rewritten to the identity |
| `ALLOWED_SEND_DOMAINS` | `DOMAIN` | comma list of allowed `from` domains |
| `DATA_DIR` | `./data` | identity store (`identities.json`) |

## Endpoints

All `/v1/*` require `Authorization: Bearer <key>`.

- `POST /mcp` — 无状态 MCP（SDK v2 / 2026-07-28）；**需** `Authorization: Bearer`（admin / `oa_` / OAuth access）；无/坏 token → 401 + `WWW-Authenticate`；OAuth aud 不符 → 403
- `GET /.well-known/oauth-protected-resource`（及 `/mcp` path-aware 变体）— RFC 9728 PRM；**公开**；`authorization_servers` = AS issuer。可选 env `MCP_PUBLIC_URL` 覆盖对外 origin
- `GET /.well-known/oauth-authorization-server` — RFC 8414（PKCE S256、CIMD、iss 响应）；**公开**
- `GET /authorize` → `/ui/oauth/authorize` — OAuth 同意页（Dashboard 会话）；`POST /oauth/token` / `POST /oauth/revoke`；管理页 `/ui/oauth/grants`
- OAuth 存储：`DATA_DIR/oauth.json`（只存哈希；与 identities.json 同模式）
- `POST /v1/identities` `{name?, localpart?}` → `201 {address, name?, pushContentTier, token}` (409 if taken)
- `GET /v1/identities` → `{identities:[{address,name?,createdAt,pushContentTier,...}]}`
- `GET /v1/identities/:address/push-tier` → `{address, pushContentTier, warning?}` (admin any; identity own only)
- `PUT /v1/identities/:address/push-tier` `{pushContentTier:1|2|3, confirm_risk?}` → admin only; tier 3 requires `confirm_risk: true`
- `GET /v1/messages?address=&limit=50` → `{messages:[{id,from,to,subject,date,seen,snippet}]}`. Only the **newest 500 messages in the shared catch-all** are scanned for a match, so on a very busy instance an identity's older mail can fall outside that window and stop being listed even though retention has not deleted it yet
- `GET /v1/messages/:id?address=` → `{id,from,to,subject,date,text,html?,otp:{codes,links}}`
- `POST /v1/messages/:id/seen` `{address, seen}` → `{id, seen}` (404 if the message is not addressed to `address`; reading never sets `\Seen` by itself — agents mark messages processed through here)
- `POST /v1/messages/wait` `{address, fromContains?, subjectContains?, timeoutSec?≤600}` → message or `408 {error:"timeout"}` (IMAP IDLE + 3 s polling hybrid). Each wait holds an IMAP connection, so they are capped: 3 concurrent per address, 8 in total → `429 {error:"too_many_waits"}`
- `POST /v1/send` `{from,to,subject,text,html?}` → `{queued:true, messageId}` (403 if `from` is not a known identity)
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
