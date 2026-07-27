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

- `POST /v1/identities` `{name?, localpart?}` → `201 {address, name?}` (409 if taken)
- `GET /v1/identities` → `{identities:[{address,name?,createdAt}]}`
- `GET /v1/messages?address=&limit=50` → `{messages:[{id,from,to,subject,date,seen,snippet}]}`
- `GET /v1/messages/:id?address=` → `{id,from,to,subject,date,text,html?,otp:{codes,links}}`
- `POST /v1/messages/wait` `{address, fromContains?, subjectContains?, timeoutSec?≤600}` → message or `408 {error:"timeout"}` (IMAP IDLE + 3 s polling hybrid). Each wait holds an IMAP connection, so they are capped: 3 concurrent per address, 8 in total → `429 {error:"too_many_waits"}`
- `POST /v1/send` `{from,to,subject,text,html?}` → `{queued:true, messageId}` (403 if `from` is not a known identity)
- `GET /healthz` → `{ok:true}`

## Operating notes

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
