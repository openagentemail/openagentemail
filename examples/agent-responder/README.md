# Agent responder templates

Minimal recipes for **webhook → headless agent / Worker → reply**.
The only long-running piece you must host is the **receiver** (template A or B).
OpenAgent.email does **not** run an LLM inside the product for you.

| Variable | A (`receiver.mjs`) | B (`worker.js`) | Notes |
| --- | --- | --- | --- |
| `WEBHOOK_SIGNING_SECRET` | ✓ (receiver only) | ✓ | Displayed `whs_<64hex>` (prefix is part of the key); **not** passed to child CLI |
| `OPENAGENTEMAIL_API_URL` | ✓ | ✓ | API base, no trailing slash |
| `OPENAGENTEMAIL_API_KEY` | ✓ (child env) | ✓ | Identity token for MCP/REST |
| `HEADLESS_CMD` | ✓ | — | Default `kimi -p`; set `claude -p` to swap |
| `PORT` | ✓ (default 8787) | — | Local listen port |
| `LLM_API_URL` / `LLM_API_KEY` | — | ✓ | OpenAI-compatible chat endpoint |
| `LLM_MODEL` | — | optional | Default `gpt-4o-mini` |
| `DEDUPE_KV` | — | optional KV | **Unbound = no dedupe** (at-least-once may double-reply) |

Secrets stay in env / wrangler secrets — never commit them.

## MCP one-time registration

Passing `OPENAGENTEMAIL_API_KEY` alone does **not** give `kimi` / `claude` the
`mail_*` tools. Register the HTTP MCP endpoint once ([docs](../../docs/mcp-clients.md)):

**kimi** — user `~/.kimi-code/mcp.json` or project `.kimi-code/mcp.json`:

```json
{
  "mcpServers": {
    "openagentemail": {
      "url": "http://127.0.0.1:3100/mcp",
      "bearerTokenEnvVar": "OPENAGENTEMAIL_API_KEY"
    }
  }
}
```

**claude** (CLI):

```bash
claude mcp add --transport http openagentemail http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer ${OPENAGENTEMAIL_API_KEY}"
```

## Local check (template A)

```bash
export WEBHOOK_SIGNING_SECRET='whs_…'   # from mail_webhook_create / POST /v1/webhooks
export OPENAGENTEMAIL_API_URL='http://localhost:3100'
export OPENAGENTEMAIL_API_KEY='oa_…'
# E2E often points HEADLESS_CMD at a deterministic REST reply script instead of a live LLM CLI
export HEADLESS_CMD='kimi -p'
node examples/agent-responder/receiver.mjs
```

Sign a test body the same way the API does (`t.<rawBody>`, HMAC-SHA256, hex `v1`),
POST to `http://127.0.0.1:$PORT/`, expect `200` / bad sig → `401` / body >256KiB → `413`.

## Wrangler deploy (template B) — three steps

1. `npx wrangler secret put WEBHOOK_SIGNING_SECRET` (and the other secrets above).
2. Point `[vars]` / secrets at your OpenAgent.email base URL and LLM endpoint.
   Optionally bind a KV namespace as `DEDUPE_KV` for `X-OAE-Delivery` idempotency
   (24h TTL). Without it, redeliveries may send duplicate replies.
3. `npx wrangler deploy` — then create a `mail.received` subscription whose `url`
   is the Worker HTTPS URL (`contentScope: metadata`).

`npx wrangler dev` is enough for a local smoke: stub the LLM, POST a signed
`mail.received` event, assert `/v1/send` lands a reply.

## See also

- Recipe write-up: [`docs/agent-responder-recipe.md`](../../docs/agent-responder-recipe.md)
- Production-grade always-on wake: [`examples/webhook-wake/`](../webhook-wake/)
- Polling (no webhook): [`examples/listener/`](../listener/)
