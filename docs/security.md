# Security guide

A mail server for agents handles **credentials by design** — OTP codes and
verification links are as sensitive as passwords. This page is the short list
of things to get right.

## 1. Two kinds of tokens — keep the admin key offline

| Token | Created by | Can do |
|---|---|---|
| **Admin key** (`API_KEYS` env) | you, at deploy time | everything: create/rotate/delete identities, read and send as **any** address |
| **Identity token** (`oa_…`) | `POST /v1/identities` (returned once) | read and send as **its own address only** |

Rules of thumb:

- **Agents get identity tokens, never the admin key.** A leaked identity token
  exposes one mailbox, not the whole server.
- Identity tokens are stored as SHA-256 hashes; the plaintext is shown exactly
  once at creation. Lost it? Rotate:
  `POST /v1/identities/:address/token` (admin).
- Rotating a token kills the old one instantly — that's also how you revoke a
  leaked token. Deleting the identity works too (`DELETE /v1/identities/:address`).

## 2. Don't expose the API port

The compose stack binds the API to `127.0.0.1:3100` **on purpose**. Tokens in
plaintext over HTTP over the internet = game over. Pick one:

**Option A — SSH tunnel (simplest, recommended for a single agent host)**

```bash
ssh -N -L 3100:127.0.0.1:3100 user@your-server
# agent now talks to http://localhost:3100, encrypted by SSH
```

**Option B — TLS reverse proxy (for agents on several hosts)**

Caddy in front of the API, with a hostname like `api.yourdomain`:

```caddyfile
api.yourdomain {
    reverse_proxy 127.0.0.1:3100
}
```

Caddy gets and renews the certificate automatically. Then point
`OPENAGENTEMAIL_API_URL` at `https://api.yourdomain`. An A record for `api.`
is the only extra DNS you need.

**Option C — `API_BIND=0.0.0.0`:** only acceptable behind a private network
(VPN/Tailscale) or a firewall that whitelists your agent hosts. Never raw on
the public internet.

## 3. Send rate limit

Every identity is capped at `SEND_RATE_LIMIT` messages per rolling hour
(default **20**, `0` disables). This is the circuit breaker for two failure
modes: an agent stuck in a send loop, and a leaked token being used for spam.
One identity hitting the cap does not slow down the others.

Over the limit returns:

```
429 {"error":"rate_limited","limit":20,"retryAfterSec":1234}
```

Note the limiter is in-memory: an API restart resets the windows.

## 4. Retention

The catch-all mailbox grows forever unless something deletes mail. The API
sweeps every `RETENTION_CHECK_HOURS` (default 6) and deletes messages older
than `RETENTION_DAYS` (default **30**; `0` keeps everything).

Mail is credential-bearing — a shorter retention window is a feature, not a
limitation. If your agents only do signups, `RETENTION_DAYS=7` is plenty.

## 5. The mailbox password is not an agent credential

`MAIL_PASSWORD` protects the catch-all IMAP/SMTP account. Only the API
container uses it; agents never see it. Keep it out of agent-facing env vars
and prompts.

## 6. Harden the host

The usual VPS hygiene applies doubly to a mail server: SSH key-only login,
`ufw` allowing only 22/25/465/587/993 (+80/443 if you run a proxy), and
fail2ban (the compose stack enables it inside docker-mailserver by default).
`./deploy/doctor.sh` re-checks your DNS, TLS and blocklist posture any time.
