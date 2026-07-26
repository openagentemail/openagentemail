# REST API reference

Base URL: `http://localhost:3100` (the compose stack binds the API to
localhost by default — see [security.md](security.md) for reaching it
remotely).

All endpoints except `GET /healthz` require a bearer token:

```
Authorization: Bearer <admin key or identity token>
```

Two token kinds (details in [security.md](security.md)):

- **Admin key** (from the `API_KEYS` env) — full access, every endpoint below.
- **Identity token** (`oa_…`, returned by `POST /v1/identities`) — scoped to
  one address: only the `messages`/`wait`/`send` endpoints, and only for its
  own address. Anything else returns `403`.

Failures return `401 {"error":"unauthorized"}` for bad tokens. Examples below
assume:

```bash
export API=http://localhost:3100
export KEY=your-admin-key
```

---

## `GET /healthz`

Liveness probe. No auth.

```bash
curl $API/healthz
# → 200 {"ok":true}
```

## `POST /v1/identities` — admin only

Create an identity. With no `localpart`, a random one like `fox-k7d2` is generated.
The address is always on the `DOMAIN` the server was configured with.

The response includes the identity's **scoped token, shown exactly once** —
hand this one to your agent, not the admin key.

```bash
curl -X POST $API/v1/identities \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"signup-bot"}'
# → 201 {"address":"fox-k7d2@example.com","name":"signup-bot","token":"oa_…"}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string? | Free-form label for the identity |
| `localpart` | string? | Force a specific address, e.g. `billing` → `billing@example.com` |

## `GET /v1/identities` — admin only

```bash
curl $API/v1/identities -H "Authorization: Bearer $KEY"
# → 200 {"identities":[{"address":"fox-k7d2@example.com","name":"signup-bot","createdAt":"2026-07-26T00:00:00.000Z"}]}
```

Token hashes are never included in responses.

## `POST /v1/identities/:address/token` — admin only

Rotate an identity's token. The old token stops working immediately; the new
plaintext is returned once.

```bash
curl -X POST $API/v1/identities/fox-k7d2@example.com/token \
  -H "Authorization: Bearer $KEY"
# → 200 {"address":"fox-k7d2@example.com","token":"oa_…"}
```

## `DELETE /v1/identities/:address` — admin only

Delete an identity (and invalidate its token). Its mail stays in the catch-all
mailbox until the retention sweeper removes it.

```bash
curl -X DELETE $API/v1/identities/fox-k7d2@example.com -H "Authorization: Bearer $KEY"
# → 200 {"deleted":true}
```

## `GET /v1/messages?address=x@y&limit=50`

List an identity's inbox, newest first. `limit` defaults to 50.
Identity tokens may only list their own address.

```bash
curl "$API/v1/messages?address=fox-k7d2@example.com&limit=10" \
  -H "Authorization: Bearer $KEY"
# → 200 {"messages":[{"id":"42","from":"noreply@github.com","to":"fox-k7d2@example.com",
#      "subject":"Verify your email","date":"2026-07-26T00:01:00.000Z","seen":false,
#      "snippet":"Confirm your address by clicking…"}]}
```

## `GET /v1/messages/:id?address=x@y`

Full message, including extracted OTP codes and links.

```bash
curl "$API/v1/messages/42?address=fox-k7d2@example.com" \
  -H "Authorization: Bearer $KEY"
# → 200 {"id":"42","from":"noreply@github.com","to":"fox-k7d2@example.com",
#      "subject":"Verify your email","date":"2026-07-26T00:01:00.000Z",
#      "text":"Your code is 482913 …","html":"<p>Your code is …</p>",
#      "otp":{"codes":["482913"],"links":["https://github.com/verify?token=…"]}}
```

`otp.codes` holds short numeric/alphanumeric verification codes found in the body;
`otp.links` holds URLs that look like verification/confirmation links. Both are
best-effort extraction — the raw `text`/`html` are always there as fallback.

## `POST /v1/messages/wait`

Long-poll until a matching message arrives. This is the workhorse for automated
signups: create the identity, trigger the signup, then wait.

```bash
curl -X POST $API/v1/messages/wait \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"address":"fox-k7d2@example.com","subjectContains":"verify","timeoutSec":180}'
```

| Field | Type | Notes |
|---|---|---|
| `address` | string | Identity to watch (required) |
| `fromContains` | string? | Case-insensitive substring match on the sender |
| `subjectContains` | string? | Case-insensitive substring match on the subject |
| `timeoutSec` | number? | Default 120, max 600 |

Success returns the same shape as `GET /v1/messages/:id` (including `otp`).
On expiry:

```
408 {"error":"timeout"}
```

Set your HTTP client timeout comfortably above `timeoutSec`.

## `POST /v1/send`

Send from an existing identity. `from` must be an identity you created —
otherwise `403 {"error":"from is not a known identity"}`. Identity tokens may
only send as themselves.

```bash
curl -X POST $API/v1/send \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"from":"fox-k7d2@example.com","to":"friend@example.org",
       "subject":"hello from an agent","text":"sent via openagent.email"}'
# → 200 {"queued":true,"messageId":"<…@example.com>"}
```

| Field | Type | Notes |
|---|---|---|
| `from` | string | An existing identity (required) |
| `to` | string | Recipient (required) |
| `subject` | string | Required |
| `text` | string | Plain-text body (required) |
| `html` | string? | Optional HTML alternative |

Each identity is limited to `SEND_RATE_LIMIT` messages per rolling hour
(default 20). Over the limit:

```
429 {"error":"rate_limited","limit":20,"retryAfterSec":1234}
```

`queued:true` means the mailserver accepted it — not that the recipient's provider
did. Deliverability is your infrastructure's job; see
[deliverability.md](deliverability.md).

## Status codes

| Code | Meaning |
|---|---|
| `200` / `201` | Success |
| `401` | Missing/invalid bearer token |
| `403` | Valid token, disallowed action (identity token outside its scope, non-identity `from`, non-admin managing identities) |
| `408` | `wait` timed out |
| `429` | Send rate limit hit — back off `retryAfterSec` |
| `5xx` | Mailserver unreachable or internal error — check `docker compose logs api` |
