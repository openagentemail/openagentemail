# Webhook-wake receiver

Optional standalone HTTP receiver for OpenAgentEmail outbound webhooks. It
verifies `X-OAE-Signature` on bounded raw bytes, maps a static route to one
mailbox and one Orca terminal, and may send a **fixed neutral** new-mail
notice. It does not consume mail, does not interpret subject/body/from/URLs,
and does not talk to the production API process.

This example is not enabled by compose, CI, or any live subscription. Default
mode is **observe** (validate and log `would_wake` only). **Canary** sends only
to an explicitly configured test seat. Do not retire mail sentinels from this
tree.

## Contract

- HMAC-SHA256 over `timestamp + "." + rawBody` using the displayed `whs_…`
  secret (UTF-8, prefix included). Rotation: any bounded `v1` candidate may
  match the current or previous secret. Timestamp must be an integer unix
  second within ±300s.
- Events: metadata `mail.received` and authenticated `webhook.ping`. Ping
  never wakes. Other types are ignored with an explicit disposition.
- 2xx only after a confirmed Orca **transport submission** (or a durable
  observe record) **and** a durable dedup write. Transient send/storage/
  timeout failures return 503 so the sender can retry. Dedup key is
  `subscriptionId + signed event id`, retained 7 days. Concurrent duplicates
  share one in-flight operation.
- Semantics are **at-least-once**. A crash after `orca terminal send` exits 0
  and before the dedup commit can duplicate the neutral wake. A zero send
  exit is **submitted**, never **consumed**.
- Request path cannot choose a terminal or command. Argv is fixed:
  `orca terminal send --terminal <bound> --enter --text <neutral>` with
  `shell=false`, timeout+SIGKILL, and output caps. No `--interrupt`.
- The child inherits a runtime allowlist (`HOME`, `USER`, `XDG_*`, `PATH`)
  so a colocated Orca install can resolve its files. API credentials and
  secrets are not forwarded. The systemd unit uses `ProtectHome=read-only`
  (not `true`) plus `HOME=%h`.
- Dedup fsyncs the file and the parent directory after rename, including
  first directory creation. 2xx is at-least-once, not exactly-once.
- In-memory wake history is off by default (`wakeHistoryLimit=0`).
- The external monitor keeps durable state under
  `/var/lib/webhook-wake-monitor` (not `/tmp`) and never sources that file
  as shell. Recovery during cooldown is pending and emitted on a later tick.

## Local run

```bash
# Copy templates; keep real whs_ files outside git (mode 0600).
cp templates/config.example.json /tmp/webhook-wake-config.json
# point secretFile at a local file, listen on 127.0.0.1, mode=observe
bun src/main.ts --config /tmp/webhook-wake-config.json
```

- `GET /health` — process liveness only.
- `GET /ready` — mappings, secret/state readiness, stale/inactive visibility.
- `POST /hooks/<routeKey>` — signed webhook.

```bash
bun test
```

The suite uses a fake Orca binary and a loopback HTTP server. It is not
evidence of a real mailbox wake, HTTPS edge, or external alarm.

## Deployment notes (not authorized by this card)

Recommended later: run as the VPS `ops` user next to the working Orca runtime;
terminate TLS on 443 and proxy to the loopback listener. Monitor from a
**different** host (probe `/health` every 30s, alarm after two failures,
recovery notice, cooldown). Templates live in `templates/`.

Endpoint health does not prove an OAE subscription is enabled. After a real
deploy order: confirm the subscription, rotate secrets, and measure test-mail
to a visible seat notification (target ≤10s). Keep old sentinels up through a
24h shadow comparison. This README does not publish hostnames, seats, or
secrets.

## Negative controls

No API/compose/workflow/dependency edits, no live subscription, no production
knock, no sentinel retirement.
