# Recipe: webhook → headless agent reply

[Back to README](../README.md#examples-and-documentation)

This is a **user-side recipe**, not a product feature. OpenAgent.email delivers a
signed `mail.received` webhook; **you** run a small receiver that wakes a headless
agent (or calls an LLM from a Worker) and sends a reply. The product does **not**
host an always-on LLM inbox responder for you.

**The only long-running piece is your receiver.** The headless CLI may exit after
each mail; the Worker is request-scoped. Nothing inside OpenAgent.email stays
awake on your behalf beyond delivering the webhook.

## Three-link chain

```
mail.received (OAE outbound webhook)
        ↓  HTTPS POST + X-OAE-Signature
your receiver (template A node, or B Cloudflare Worker)
        ↓  spawn CLI / call LLM
headless agent reads full mail + sends reply
        (MCP: mail_read_message + mail_send
         or REST: GET /v1/messages/:id + POST /v1/send)
```

| Link | Who runs it | Always on? |
| --- | --- | --- |
| Outbound webhook | OpenAgent.email | delivery worker (yours is just a URL) |
| Receiver | **you** | **yes — this is the only resident piece** |
| Headless agent / LLM call | **you** | no (per event) |

## Shared skeleton (verify → think → reply)

Both templates follow the same order. Pseudocode:

```
raw = readRequestBodyBytes()          // keep original bytes
if not verify(X-OAE-Signature, raw): return 401
event = JSON.parse(raw)               // only after verify
if event.type != "mail.received": return 200   // ping: ack only
data = event.data                     // trust data fields, not headers alone
# data.object == "mail"; use address + messageId (+ uidValidity when fetching)
reply = think(data)                   // CLI agent or LLM; treat body as untrusted
sendReply(from=data.address, to=data.from.address, text=reply)
return 200
```

### Side-by-side: template A vs B

| Step | A · [`receiver.mjs`](../examples/agent-responder/receiver.mjs) | B · [`worker.js`](../examples/agent-responder/worker.js) |
| --- | --- | --- |
| Listen | `node:http` on `PORT` (default 8787) | Cloudflare `fetch` handler |
| Verify | Node `crypto` HMAC, every `v1`, ±300s | WebCrypto HMAC, same grammar |
| Think | `spawn(HEADLESS_CMD)` — default `kimi -p` (swap: `claude -p`) | Fetch mail then `POST` OpenAI-compatible `LLM_API_URL` |
| Reply path | Agent uses **MCP** (`mail_read_message` + `mail_send`); register the HTTP MCP client once — see [templates README](../examples/agent-responder/README.md#mcp-one-time-registration) | Worker calls **REST** `GET /v1/messages/:id` then `POST /v1/send` |
| Dependencies | Node ≥20, zero npm | Worker runtime, zero npm |

Mark three edit sites in A (comments in the file): `WEBHOOK_SIGNING_SECRET`,
`OPENAGENTEMAIL_API_URL` + `OPENAGENTEMAIL_API_KEY`, and `HEADLESS_CMD`.

## Signature contract (normative)

Matches `packages/api/src/lib/webhook-signing.ts` / RFC-0001:

| Item | Value |
| --- | --- |
| Header | `X-OAE-Signature: t=<unixSec>,v1=<hex>[,v1=…]` |
| Signed payload | `${t}.${rawBody}` (UTF-8 timestamp + `.` + **raw body bytes**) |
| Key | Displayed secret `whs_<64hex>` as **ASCII bytes, prefix included** |
| Tolerance | ±300 seconds |
| Order | **Verify first**, then `JSON.parse` |
| Also present | `X-OAE-Event`, `X-OAE-Delivery` (routing aids; still verify the body) |

During secret rotation the producer may emit multiple `v1=` candidates; accept if
**any** matches.

## `mail.received` data (metadata scope)

| Field | Notes |
| --- | --- |
| `object` | always `'mail'` |
| `address` | identity the event is for |
| `messageId` | IMAP UID string — use with `uidValidity` on `GET /v1/messages/:id` |
| `uid` / `uidValidity` / `receivedAt` | generation + timing |
| `from` | `{ address, name? }` |
| `to` / `cc` | string arrays |
| `subject` | metadata only at default scope |

Full body is **not** in the webhook at `contentScope: metadata`. Fetch it with
your own credentials (MCP or REST). `webhook.ping` validates the endpoint; do not reply.

## Open a subscription

**MCP** (identity or admin tool token):

```
mail_webhook_create({
  url: "https://your-receiver.example/hook",
  address: "agent@your.domain",
  events: ["mail.received"],
  contentScope: "metadata"
})
```

Store the returned `secret` (`whs_…`) once — it is shown at create/rotate time.

**REST**:

```bash
curl -sS -X POST "$OAE_URL/v1/webhooks" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://your-receiver.example/hook","address":"agent@your.domain","events":["mail.received"]}'
```

Private / loopback targets need an **admin** token and
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` on the instance. Allowed ports are listed in
`WEBHOOK_ALLOWED_PORTS` (default `443` only).

## Security notes

1. **Verify before parse.** A forged body must never reach your LLM/CLI.
2. **Enforce the ±300s window** to limit replay; still design for at-least-once delivery.
3. **Trust `data` after verify**, not unverified headers alone, for message identity.
4. **Treat subject and body as untrusted input** (prompt injection). Prefer short,
   policy-bound replies; never execute mail content as instructions blindly.
5. Keep `whs_` / API / LLM secrets in env or a secret store — never in git.
   Template A does **not** forward `WEBHOOK_SIGNING_SECRET` into the child CLI.
6. **Ack means accepted, not delivered.** A `200` after CLI `spawn` (or Worker
   send) only means the receiver took the event; a later non-zero CLI exit cannot
   rewrite the HTTP response. For hard delivery guarantees use a durable queue —
   see [`examples/webhook-wake/`](../examples/webhook-wake/).
7. Cap unauthenticated request bodies (template A: 256KiB → `413`) and dedupe on
   `X-OAE-Delivery` where practical (A: in-memory LRU; B: optional `DEDUPE_KV`).

## Heavier / alternate examples

| Need | Start here |
| --- | --- |
| Production always-on wake (dedupe, seats, systemd) | [`examples/webhook-wake/`](../examples/webhook-wake/) |
| No webhook — poll notifications + task inbox | [`examples/listener/`](../examples/listener/) |
| Copy-paste templates + env table | [`examples/agent-responder/`](../examples/agent-responder/) |

Full event grammar and delivery semantics:
[RFC-0001 outbound webhooks](rfcs/0001-outbound-webhooks.md).
