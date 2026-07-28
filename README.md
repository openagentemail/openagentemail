# openagent.email

**Self-hosted email for AI agents. The open-source alternative to AgentMail.**

**[openagent.email](https://openagent.email)** · website: [openagentemail/website](https://github.com/openagentemail/website)

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
SSH tunnel or a TLS proxy: [docs/security.md](https://openagent.email/docs/guides/security/).

## Read mail in a browser

Open [`http://localhost:3100/ui`](http://localhost:3100/ui) and paste an admin
or identity API token. The built-in dashboard lists the addresses the token
may access, shows messages, extracts verification codes and links, offers
plain-text or isolated HTML previews, and can mark messages read or unread —
its only write action.

The browser exchanges the token once for an `HttpOnly` session cookie; the
token never enters the URL or browser storage. Sessions live only in API
process memory, so restarting the API signs every browser out. They expire
after 12 idle hours or 24 hours total — or tick **Trust this device** at
login to keep a sliding 30-day session on that browser. Each token holds at
most five sessions; a sixth login evicts that token's least-recently-used one
instead of locking you out.

For another computer, use the same SSH tunnel recommended for the API or put a
TLS reverse proxy in front. The login form refuses non-local plain HTTP, and
session cookies are `Secure` away from localhost. Set `UI_ENABLED=false` in
`.env` to make every `/ui` route return 404.

HTML email is treated as hostile input. The UI removes scripts, images, forms,
links, sender CSS, and all attributes except numeric table spans, then loads the
result in a separately sandboxed frame with a restrictive CSP. The
`sanitize-html` 2.x dependency is deliberately pinned to an exact version;
upgrade it in a dedicated change and rerun the full poison-message corpus.

### Admin overview

An admin session lands on **Overview**: every identity in one table with the
message count, unseen count, last delivery, and creation day, plus totals across
the top. Identity sessions never see it — they go straight to their own inbox.
The page is served from the same in-process API as the rest of `/ui`; there is no
new public endpoint outside `/ui/api`.

What the numbers mean, and where they stop:

- **Counts are a window, not a lifetime total.** One scan reads the newest 500
  messages in the catch-all mailbox and attributes each one to the identities it
  was delivered to. The header says `newest N of M in the mailbox` so the window
  is never mistaken for history. A message addressed to two identities counts
  once for each row and once — not twice — in the totals.
- **Honest instead of round.** Messages with enormous recipient lists can exceed
  the scanner's per-message and global memory bounds. Rows the scanner could not
  fully account for show `≥N` or `Unknown` rather than a confident wrong number,
  the page explains why, and `unmatchedInWindow` is reported as `null` instead of
  a made-up zero. The same applies to an identity created after the last scan:
  it reads `Unknown` until the next one, never a false `0`.
- **Snapshots are cached in memory for 15 seconds** and reused for up to
  10 minutes while a refresh runs in the background, so opening Overview or
  walking in and out of inboxes does not hammer IMAP. Refresh is floored at
  5 seconds. Restarting the API drops the cache — the first request afterwards
  pays for a fresh scan.
- **Failures cool down and never lie.** If a scan fails, the next attempt waits
  5 seconds (the API sends `Retry-After`), the table keeps showing the previous
  numbers, and the header says the last refresh failed. Once a snapshot is older
  than 10 minutes it is not revived by a failed refresh: the page reports the
  counts as unavailable instead of showing stale data as current. While a cold
  scan is still running the endpoint answers `202` and the address list renders
  immediately with `Loading…` in the count columns.
- **`GET /ui/api/overview`** (browser session only, admin only) returns exactly
  the fields the page renders — never message content. `?refresh=1` asks for a
  new scan, subject to the 5-second floor and the failure cooldown.

Deliberate limits, so nothing here is a surprise later:

- Overview shows counts and timestamps only. Subjects, senders, and verification
  codes need per-message parsing, which is what the inbox view is for.
- New mail can be up to 15 seconds late on the page; `Refresh` fetches sooner.
  There is no steady-state polling: the page only schedules a follow-up while
  counts are loading or a refresh is pending, capped at 15 attempts over 20
  seconds and paced by the server's own retry hint.
- A scan that misses its deadline is abandoned even if IMAP answers a moment
  later, and the next request scans again. The deadline covers connecting as well
  as fetching, so a hung server does not park a request behind IMAP's own
  30-second socket timeout.
- Up to 200 identities render in one pass. Beyond that, expect to want paging or
  virtual scrolling; filtering and sorting happen in the browser today.
- The dashboard self-hosts the Satoshi webfont (`/ui/fonts/*`, the same
  typeface as the website) so it renders identically on every machine;
  `font-src` is `'self'`. The favicon is an SVG (`/ui/favicon.svg`) so it
  needs no build step, and `/ui/favicon.ico` keeps returning 204 as before.
- Form controls use a dedicated `--line-control` border token so their outlines
  stay above 3:1 contrast. It is the one intentional deviation from the website's
  palette and is a one-line revert.

## Features

- **Unlimited identities** — one catch-all mailbox, unlimited `anything@yourdomain`
  addresses. No provisioning, no per-inbox cost.
- **Scoped tokens** — every identity gets its own token that can only read and
  send as that address. The admin key never has to touch your agents.
- **REST + MCP** — the same seven operations over a plain HTTP API and a first-class
  MCP server your agents can call directly.
- **`mail_wait_for` / `POST /v1/messages/wait`** — long-poll an inbox until a
  matching message arrives, with OTP codes and verification links already extracted.
  Built for automated signups.
- **Read/unread state** — `mail_mark_seen` / `POST /v1/messages/:id/seen` lets an
  agent (or the human in the dashboard) mark a message handled, so the unseen
  count means "still needs attention". Reading a message never changes the flag
  by itself.
- **Web dashboard for humans** — inspect identities and messages at `/ui`, with
  an admin overview across all identities, responsive layouts, and doubly
  isolated HTML previews.
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
`mail_read_message`, `mail_wait_for`, `mail_send`, `mail_mark_seen`.

Full per-client setup (Claude Code, Claude Desktop, Cursor, Kimi Code, generic):
[docs/mcp-clients.md](https://openagent.email/docs/reference/mcp-clients/) · server details:
[packages/mcp/README.md](packages/mcp/README.md)

## Why self-host?

- **Privacy** — OTP codes and verification links are credentials. Self-hosted, they
  never leave a machine you own. No third party reads, stores, or trains on your mail.
- **Cost** — a $5 VPS and a domain you already have vs. per-inbox/per-message SaaS
  pricing that scales linearly with your agent fleet.
- **Control** — your IPs, your reputation, your retention. No rate limits, no
  account suspensions, no sudden API deprecations.

## Server requirements

Measured on our own production instance, idle: **~190 MB RAM total, ~0% CPU**,
and ~2 GB of disk for the Docker images. Mail itself is a rounding error —
retention auto-deletes after 30 days.

| Tier | Spec | Notes |
|---|---|---|
| Minimum | 1 vCPU / 1 GB RAM / 10 GB disk | works with the defaults (ClamAV and SpamAssassin off) |
| Comfortable | 1 vCPU / 2 GB RAM / 20 GB disk | headroom to enable SpamAssassin |
| With antivirus | 4 GB RAM | ClamAV alone needs ~1 GB extra |

That's a $5/mo VPS — or a $10–15/**year** deal box. The real prerequisite isn't
size, it's **port 25**: AWS, GCP, Azure, DigitalOcean and Vultr block it by
default (some unblock on request). Check before you buy — or route outbound
through a [relay](https://openagent.email/docs/guides/deliverability/) and you don't need port 25 out at all.

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
- **Next** — outbound webhooks (push instead of `wait_for` polling), more write
  actions in the web dashboard, multi-domain support, Sieve-style per-identity rules.
- **Distribution** — planned one-click app in the
  [OpenShip](https://github.com/oblien/openship) catalog.

## Docs

- [docs/api.md](https://openagent.email/docs/reference/api/) — REST API reference with curl examples
- [docs/security.md](https://openagent.email/docs/guides/security/) — tokens, exposure, rate limits, retention
- [docs/mcp-clients.md](https://openagent.email/docs/reference/mcp-clients/) — MCP setup for every major client
- [docs/dns-setup.md](https://openagent.email/docs/guides/dns-setup/) — DNS records, explained one by one
- [docs/deliverability.md](https://openagent.email/docs/guides/deliverability/) — the field guide to actually
  landing in the inbox

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
