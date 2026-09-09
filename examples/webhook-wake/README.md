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

- HMAC-SHA256 over UTF-8(`timestamp + "."`) followed by the **original raw
  body bytes** (no UTF-8 decode/re-encode of the body) using the displayed
  `whs_…` secret (UTF-8, prefix included). Rotation: any bounded `v1`
  candidate may match the current or previous secret. Timestamp must be an
  integer unix second within ±300s. JSON/UTF-8 is interpreted only after
  the signature check. RFC-0001 §5.1 / §6.1 requires a `data` object on
  every event (`docs/rfcs/0001-outbound-webhooks.md` lines 672 and 775;
  `formatPingPayload` always supplies one). `data: null`, a missing `data`,
  or a non-object is `invalid_data` (400). Mail without an address is never
  a 2xx success.
- Events: metadata `mail.received` and authenticated `webhook.ping`. Ping
  never wakes. Other types are ignored with an explicit disposition.
- 2xx only after a confirmed Orca **transport submission** (or a durable
  observe record) **and** a durable dedup write. Transient send/storage/
  timeout/authenticated mapping mismatch failures return 503 so the sender
  can retry. Dedup key is `subscriptionId + signed event id`, retained 7
  days (≥72h). Concurrent duplicates share one in-flight operation.
  **Observe replay:** an `observed` record for the same subscription+event
  id suppresses a later canary send of that id. Switching to canary
  requires a **new** event id (or a new test send). This is not a live
  catch-up/replay feature.
- Semantics are **at-least-once**. A crash after `orca terminal send` exits 0
  and before the dedup commit can duplicate the neutral wake. A zero send
  exit is **submitted**, never **consumed**.
- Request path cannot choose a terminal or command. Argv is fixed:
  `orca terminal send --terminal <bound> --enter --text <neutral>` with
  `shell=false`, timeout+SIGKILL of the **spawned job process group**,
  and output caps. No `--interrupt`. Ambient bun/node is never signalled.
- The child inherits a runtime allowlist (`HOME`, `USER`, `XDG_*`, `PATH`)
  so a colocated Orca install can resolve its files. API credentials and
  secrets are not forwarded. Placeholder operator identity is **ops** in
  the system unit, `runtime.env.example`, and `config.user.example.json`.
  The **system** unit must not use `%h`/`%U` (those are the service
  manager, typically `/root` and UID 0). Put `HOME` / `XDG_RUNTIME_DIR` in
  `/etc/webhook-wake/runtime.env`. The optional **user** unit may use
  `%h`/`%U` and writes durable state under `%h/.local/state/webhook-wake`
  (`StateDirectory=webhook-wake`). `ProtectHome=read-only`.
- `GET /health` is liveness only and is the public monitor target.
  `GET /ready` lists `routeKey` / `subscriptionId` and stays **private**.
  Caddy/nginx templates proxy `/health` and `/hooks/*` only.
- Dedup fsyncs the file and the parent directory after rename, including
  first directory creation. A failed directory fsync leaves an `.unacked`
  marker; 2xx is withheld until that fsync succeeds. At-least-once, not
  exactly-once.
- In-memory wake history is off by default (`wakeHistoryLimit=0`).
- The external monitor keeps state under `/var/lib/webhook-wake-monitor`
  (not `/tmp`) and never sources that file as shell. Across-run persistence
  already exists via `StateDirectory`. `save()` is an atomic rename without
  fsync: a crash between write and disk flush may roll back one tick
  (`last_alert` / `alarming`). That is an explicit monitor limitation, not
  the receiver 2xx durability contract; FC may confirm the disposition.
  Recovery during cooldown is pending and emitted on a later tick.
  Alert execution requires a `timeout` binary; a missing tool fails visibly
  and never runs the alerter unbounded.
  Install rename (required so the timer `Unit=` resolves):
  `monitor.service` → `/etc/systemd/system/webhook-wake-monitor.service`,
  `monitor.timer` → `/etc/systemd/system/webhook-wake-monitor.timer`,
  `monitor.sh` → `/usr/local/bin/webhook-wake-monitor.sh`.
- Secret files on Linux must be mode `0600` (group/other bits fail load).
  `templates/canary.whs.example` is deliberately **not** a valid `whs_` hex
  secret until replaced. `alertHook.url` is trusted-operator config; this
  example does not add SSRF/network policy (upstream API already pins
  egress). Oversized bodies return HTTP 413 on the live connection; unknown
  unauthenticated routes never call the alert hook.

## Local run

```bash
# Copy templates; keep real whs_ files outside git (mode 0600).
cp templates/config.example.json /tmp/webhook-wake-config.json
# point secretFile at a local file, listen on 127.0.0.1, mode=observe
bun src/main.ts --config /tmp/webhook-wake-config.json
```

- `GET /health` — process liveness only (public monitor probe).
- `GET /ready` — mappings, secret/state readiness, stale/inactive visibility
  (keep off the public proxy).
- `POST /hooks/<routeKey>` — signed webhook.

Requires Bun `>=1.2.21` (tested with the workspace Bun). Example typecheck
uses the TypeScript already installed under `packages/api/node_modules`
(`bun run typecheck`); no new compiler dependency is added.

```bash
bun test
bun run typecheck
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
