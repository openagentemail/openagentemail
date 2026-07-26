# openagent.email

**Self-hosted email for AI agents. The open-source alternative to AgentMail.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/openagentemail/openagentemail.svg?style=social)](https://github.com/openagentemail/openagentemail)

One `docker compose up` on your own VPS gives every agent you run unlimited real
mailboxes on your own domain — over REST and MCP — with OTP and verification-link
extraction built in. No per-inbox pricing, no third party ever seeing your mail.

## Quickstart

Prerequisites: a VPS with outbound/inbound port 25 open, and a domain you control.

```bash
git clone https://github.com/openagentemail/openagentemail.git && cd openagentemail
cp .env.example .env   # set DOMAIN, API_KEYS, and the mailbox password
docker compose up -d && ./deploy/dns-records.sh   # prints the exact DNS records to create
```

Then verify everything end to end:

```bash
./deploy/doctor.sh    # checks DNS, TLS, IMAP/SMTP login, and a round-trip send
```

Create an identity and hand your agent its scoped token (shown once):

```bash
curl -X POST http://localhost:3100/v1/identities \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"signup-bot"}'
# → 201 {"address":"fox-k7d2@example.com","name":"signup-bot","token":"oa_…"}
```

The API binds to `127.0.0.1` by default — reach it from other hosts over an
SSH tunnel or a TLS proxy: [docs/security.md](docs/security.md).

## Features

- **Unlimited identities** — one catch-all mailbox, unlimited `anything@yourdomain`
  addresses. No provisioning, no per-inbox cost.
- **Scoped tokens** — every identity gets its own token that can only read and
  send as that address. The admin key never has to touch your agents.
- **REST + MCP** — the same six operations over a plain HTTP API and a first-class
  MCP server your agents can call directly.
- **`mail_wait_for` / `POST /v1/messages/wait`** — long-poll an inbox until a
  matching message arrives, with OTP codes and verification links already extracted.
  Built for automated signups.
- **Safety rails built in** — per-identity send rate limits (20/hour default),
  automatic mail retention (30 days default), localhost-only API binding.
- **Bring your own relay** — send directly from the VPS, or route outbound through
  Amazon SES / SMTP2GO / any SMTP relay with one env var.
- **DNS wizard + doctor** — `deploy/dns-records.sh` generates your exact DNS records;
  `deploy/doctor.sh` diagnoses deliverability before your agents depend on it.
- **Single dependency: Docker.** The stack is the API plus
  [docker-mailserver](https://github.com/docker-mailserver/docker-mailserver). Nothing else.

## How it works

```
┌─────────────┐   MCP (stdio)    ┌──────────────────┐
│  AI agents   ├──────────────────▶                  │
│ (Claude Code,│                  │   openagent api  │
│  Cursor, …)  │   REST /v1/*     │  (Node, imapflow │
└─────────────┘──────────────────▶ │   + nodemailer)  │
                                   └────────┬─────────┘
                                            │ IMAP + SMTP (localhost)
                                   ┌────────▼─────────┐      SMTP 25
                                   │ docker-mailserver│ ◀──────────▶  the world
                                   │ catch-all mailbox│  (or your relay: SES, …)
                                   └──────────────────┘
```

One catch-all account on your domain receives everything. The API logs into it over
IMAP, matches messages to identities by the `To`/`Delivered-To` header, and sends
via SMTP with the `From` rewritten to the chosen identity. Polling + IMAP IDLE for
low-latency waits.

## Use it from your agent (MCP)

```json
{
  "mcpServers": {
    "openagentemail": {
      "command": "bun",
      "args": ["run", "/path/to/openagentemail/packages/mcp/src/main.ts"],
      "env": {
        "OPENAGENTEMAIL_API_URL": "http://localhost:3100",
        "OPENAGENTEMAIL_API_KEY": "oa_…identity-token"
      }
    }
  }
}
```

Tools: `mail_new_identity`, `mail_list_identities`, `mail_list_messages`,
`mail_read_message`, `mail_wait_for`, `mail_send`.

Full per-client setup (Claude Code, Claude Desktop, Cursor, Kimi Code, generic):
[docs/mcp-clients.md](docs/mcp-clients.md) · server details:
[packages/mcp/README.md](packages/mcp/README.md)

## Why self-host?

- **Privacy** — OTP codes and verification links are credentials. Self-hosted, they
  never leave a machine you own. No third party reads, stores, or trains on your mail.
- **Cost** — a $5 VPS and a domain you already have vs. per-inbox/per-message SaaS
  pricing that scales linearly with your agent fleet.
- **Control** — your IPs, your reputation, your retention. No rate limits, no
  account suspensions, no sudden API deprecations.

## Comparison

| | **openagent.email** | AgentMail.to | MailSlurp |
|---|---|---|---|
| Open source | ✅ Apache-2.0 | ❌ | ❌ |
| Self-hosted | ✅ | ❌ | ❌ |
| Price | Flat VPS cost | Per-inbox subscription | Usage-based subscription |
| Unlimited inboxes | ✅ (catch-all) | Paid tiers | Paid tiers |
| MCP-native | ✅ | ✅ | ❌ (REST/SDKs) |
| OTP/link extraction | ✅ | ✅ | ✅ |
| Data leaves your infra | Never | Always | Always |

## Roadmap

- **v0.1** — REST + MCP, catch-all identities, `wait_for` with OTP/link
  extraction, DNS wizard + doctor, optional SMTP relay.
- **v0.2 (current)** — scoped per-identity tokens, send rate limits, automatic
  retention, localhost-safe defaults, expanded OTP corpus.
- **Next** — outbound webhooks (push instead of `wait_for` polling), admin web UI,
  multi-domain support, Sieve-style per-identity rules.
- **Distribution** — planned one-click app in the
  [OpenShip](https://github.com/oblien/openship) catalog.

## Docs

- [docs/api.md](docs/api.md) — REST API reference with curl examples
- [docs/security.md](docs/security.md) — tokens, exposure, rate limits, retention
- [docs/mcp-clients.md](docs/mcp-clients.md) — MCP setup for every major client
- [docs/dns-setup.md](docs/dns-setup.md) — DNS records, explained one by one
- [docs/deliverability.md](docs/deliverability.md) — the field guide to actually
  landing in the inbox

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
