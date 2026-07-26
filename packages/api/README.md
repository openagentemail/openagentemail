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
| `API_KEYS` | — | comma-separated Bearer keys |
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
- `POST /v1/messages/wait` `{address, fromContains?, subjectContains?, timeoutSec?≤600}` → message or `408 {error:"timeout"}` (IMAP IDLE + 3 s polling hybrid)
- `POST /v1/send` `{from,to,subject,text,html?}` → `{queued:true, messageId}` (403 if `from` is not a known identity)
- `GET /healthz` → `{ok:true}`
