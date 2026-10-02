# Agent responder templates

Minimal recipes for **webhook → headless agent / Worker → reply**.
The only long-running piece you must host is the **receiver** (template A or B).
OpenAgent.email does **not** run an LLM inside the product for you.

| Variable | A (`receiver.mjs`) | B (`worker.js`) | Notes |
| --- | --- | --- | --- |
| `WEBHOOK_SIGNING_SECRET` | ✓ (receiver only) | ✓ | Displayed `whs_<64hex>` (prefix is part of the key); **not** passed to child CLI |
| `OPENAGENTEMAIL_API_URL` | ✓ | ✓ | API base, no trailing slash. **Remote must be https** (Bearer token crosses the wire in cleartext otherwise) |
| `OPENAGENTEMAIL_API_KEY` | ✓ (child env) | ✓ | Identity token for MCP/REST |
| `HEADLESS_CMD` | ✓ | — | Default `kimi -p`; set `claude -p` to swap |
| `PORT` | ✓ (default 8787) | — | Local listen port |
| `HOST` | ✓ (default `0.0.0.0`) | — | Bind address; use `127.0.0.1` for local-only |
| `CHILD_TIMEOUT_MS` | ✓ (default `300000`) | — | Kill hung child after this many ms (template-level) |
| `MAX_QUEUE` | ✓ (default `32`) | — | Wait-queue cap; excess POSTs get `503` (template-level) |
| `LLM_API_URL` / `LLM_API_KEY` | — | ✓ | OpenAI-compatible chat endpoint |
| `LLM_MODEL` | — | optional | Default `gpt-4o-mini` |
| `DEDUPE_KV` | — | optional KV | **best-effort** dedupe (KV has no atomic claim; overlapping redeliveries may still double-send). For atomic dedupe use Durable Objects / [`webhook-wake`](../webhook-wake/). **Unbound = no dedupe.** |
| Concurrency | in-process cap **1** + queue **32** (excess → `503`) | Worker isolate | **Before production, add concurrency limits / dedupe / rate limits — see [`examples/webhook-wake`](../webhook-wake/)** |

Secrets stay in env / wrangler secrets — never commit them.

**Risk (template A):** the spawned agent holds send credentials. A successful
prompt-injection against that agent can send mail as the identity. Harden with
a human-approval gate if that risk is unacceptable. Template A deliberately
does **not** put `subject` into the CLI prompt or child env — the agent must
fetch the message itself via MCP. When the webhook includes `uidValidity`, the
child prompt passes it to `mail_read_message` and must not reply on
`stale_message_generation`. When the event has no generation, template A still
replies as before and the prompt warns that this event has no generation
guarantee. Template B's REST fetch already passes generation;
[`webhook-wake`](../webhook-wake/) is unchanged. Default `HOST=0.0.0.0` exposes the
receiver on all interfaces — bind `127.0.0.1` (or put a reverse proxy in front)
unless you intend LAN/public reachability. The self-address guard only blocks
replying to yourself; two auto-responders (A↔B) can still loop and burn LLM
quota on both sides — mitigate with a human-approval gate and/or a per-thread
reply budget. `mail.received` now includes bounded `autoSubmitted`
(`null`, `no`, `auto-generated`, `auto-replied`, or `other`) on both scopes.
Templates A and B skip when that value is present and not `no`, on the event
and again when the current read succeeds. A failed template B read, or one
without `uidValidity`, still drafts from metadata and is not fail-closed.
Missing or `no` does not prove a human sender. Self-address and generation
checks stay independent, and `source:internal` does not replace this field.
Template A tells the agent to pass `autoReply:true` only after those checks
allow a reply, and not to pass `headers`. Template B adds `autoReply:true`
only on its existing send, including the metadata-draft fallback. That
fallback is still not fail-closed. The server writes
`Auto-Submitted: auto-replied` only for explicit `true`.

## MCP one-time registration

Passing `OPENAGENTEMAIL_API_KEY` alone does **not** give `kimi` / `claude` the
`mail_*` tools. Register the HTTP MCP endpoint once ([docs](../../docs/mcp-clients.md)):

**kimi** — user `~/.kimi-code/mcp.json` or project `.kimi-code/mcp.json`
(use the same base as CHANGE-ME 2 / `OPENAGENTEMAIL_API_URL`).
This matches the product Connect page shape (token in headers). The file is
user-level — prefer mode `600`:

```json
{
  "mcpServers": {
    "openagentemail": {
      "url": "<你的 OPENAGENTEMAIL_API_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <your identity token>"
      }
    }
  }
}
```

Equivalent alternative: `"bearerTokenEnvVar": "OPENAGENTEMAIL_API_KEY"` (env
reference form — token stays out of the file).

**claude** (CLI):

```bash
claude mcp add --transport http --scope user openagentemail \
  "<你的 OPENAGENTEMAIL_API_URL>/mcp" \
  --header "Authorization: Bearer ${OPENAGENTEMAIL_API_KEY}"
```

## Local check (template A)

```bash
export WEBHOOK_SIGNING_SECRET='whs_…'   # from mail_webhook_create / POST /v1/webhooks
export OPENAGENTEMAIL_API_URL='http://localhost:3100'
export OPENAGENTEMAIL_API_KEY='oa_…'
# E2E often points HEADLESS_CMD at a deterministic REST reply script instead of a live LLM CLI
export HEADLESS_CMD='kimi -p'
# optional: HOST=127.0.0.1 for loopback-only bind
node examples/agent-responder/receiver.mjs
```

Sign a test body the same way the API does (`t.<rawBody>`, HMAC-SHA256, hex `v1`),
POST to `http://127.0.0.1:$PORT/`, expect `200` / bad sig → `401` / body >256KiB → `413`.

## Wrangler deploy (template B) — three steps

1. `npx wrangler secret put WEBHOOK_SIGNING_SECRET` (and the other secrets above).
2. Point `[vars]` / secrets at your OpenAgent.email base URL and LLM endpoint.
   Optionally bind a KV namespace as `DEDUPE_KV` for **best-effort**
   `X-OAE-Delivery` / event-id idempotency (96h TTL to cover RFC-0001 §8.3's
   72h retry window; not atomic across isolates).
   Without it, redeliveries may send duplicate replies.
3. `npx wrangler deploy worker.js` — then create a `mail.received` subscription whose
   `url` is the Worker HTTPS URL (`contentScope: metadata`).
   Or create your own `wrangler.toml` with `main = "worker.js"` and run
   `npx wrangler deploy` from that directory.

`npx wrangler dev worker.js` is enough for a local smoke: stub the LLM, POST a
signed `mail.received` event, assert `/v1/send` lands a reply.

## See also

- Recipe write-up: [`docs/agent-responder-recipe.md`](../../docs/agent-responder-recipe.md)
- Production-grade always-on wake: [`examples/webhook-wake/`](../webhook-wake/)
- Polling (no webhook): [`examples/listener/`](../listener/)
