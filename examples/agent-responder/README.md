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
fetch the message itself via MCP. There is also a **generation TOCTOU** between
the receiver's `uidValidity` pre-check and the agent's later MCP read (MCP has
no generation parameter); a mailbox rebuild in that window can mis-read — fix
requires a product MCP change or [`webhook-wake`](../webhook-wake/) owning the
read path. Tracked upstream as issue #362. Default `HOST=0.0.0.0` exposes the
receiver on all interfaces — bind `127.0.0.1` (or put a reverse proxy in front)
unless you intend LAN/public reachability. The self-address guard only blocks
replying to yourself; two auto-responders (A↔B) can still loop and burn LLM
quota on both sides — mitigate with a human-approval gate and/or a per-thread
reply budget. Standard suppression (RFC 3834 `Auto-Submitted`) needs product
support; current webhook events and message-read details do not expose that
field. Tracked upstream as issue #363.

## MCP one-time registration

Passing `OPENAGENTEMAIL_API_KEY` alone does **not** give `kimi` / `claude` the
`mail_*` tools. Register the HTTP MCP endpoint once ([docs](../../docs/mcp-clients.md)):

**kimi** — user `~/.kimi-code/mcp.json` or project `.kimi-code/mcp.json`
(use the same base as CHANGE-ME 2 / `OPENAGENTEMAIL_API_URL`):

```json
{
  "mcpServers": {
    "openagentemail": {
      "url": "<你的 OPENAGENTEMAIL_API_URL>/mcp",
      "bearerTokenEnvVar": "OPENAGENTEMAIL_API_KEY"
    }
  }
}
```

**claude** (CLI):

```bash
claude mcp add --transport http openagentemail \
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
   `X-OAE-Delivery` idempotency (24h TTL; not atomic across isolates).
   Without it, redeliveries may send duplicate replies.
3. `npx wrangler deploy` — then create a `mail.received` subscription whose `url`
   is the Worker HTTPS URL (`contentScope: metadata`).

`npx wrangler dev` is enough for a local smoke: stub the LLM, POST a signed
`mail.received` event, assert `/v1/send` lands a reply.

## See also

- Recipe write-up: [`docs/agent-responder-recipe.md`](../../docs/agent-responder-recipe.md)
- Production-grade always-on wake: [`examples/webhook-wake/`](../webhook-wake/)
- Polling (no webhook): [`examples/listener/`](../listener/)
