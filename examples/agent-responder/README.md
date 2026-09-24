# Agent responder templates

Minimal recipes for **webhook → headless agent / Worker → reply**.
The only long-running piece you must host is the **receiver** (template A or B).
OpenAgent.email does **not** run an LLM inside the product for you.

| Variable | A (`receiver.mjs`) | B (`worker.js`) | Notes |
| --- | --- | --- | --- |
| `WEBHOOK_SIGNING_SECRET` | ✓ | ✓ | Displayed `whs_<64hex>` (prefix is part of the key) |
| `OPENAGENTEMAIL_API_URL` | ✓ | ✓ | API base, no trailing slash |
| `OPENAGENTEMAIL_API_KEY` | ✓ (child env) | ✓ | Identity token for MCP/REST |
| `HEADLESS_CMD` | ✓ | — | Default `kimi -p`; set `claude -p` to swap |
| `PORT` | ✓ (default 8787) | — | Local listen port |
| `LLM_API_URL` / `LLM_API_KEY` | — | ✓ | OpenAI-compatible chat endpoint |
| `LLM_MODEL` | — | optional | Default `gpt-4o-mini` |

Secrets stay in env / wrangler secrets — never commit them.

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
POST to `http://127.0.0.1:$PORT/`, expect `200` / bad sig → `401`.

## Wrangler deploy (template B) — three steps

1. `npx wrangler secret put WEBHOOK_SIGNING_SECRET` (and the other secrets above).
2. Point `[vars]` / secrets at your OpenAgent.email base URL and LLM endpoint.
3. `npx wrangler deploy` — then create a `mail.received` subscription whose `url`
   is the Worker HTTPS URL (`contentScope: metadata`).

`npx wrangler dev` is enough for a local smoke: stub the LLM, POST a signed
`mail.received` event, assert `/v1/send` lands a reply.

## See also

- Recipe write-up: [`docs/agent-responder-recipe.md`](../../docs/agent-responder-recipe.md)
- Production-grade always-on wake: [`examples/webhook-wake/`](../webhook-wake/)
- Polling (no webhook): [`examples/listener/`](../listener/)
