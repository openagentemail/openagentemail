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
  never wakes. A ping must also match the configured `subscriptionId`
  (`data.webhookId`) and domain before `ping_ok`; a wrong or missing
  binding is `400 ping_binding_mismatch` and is not a successful
  verification. Other types are ignored with an explicit disposition.
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
  Shipped `webhook-wake.service` / `webhook-wake.user.service` omit
  `KillMode=`, so systemd default `KillMode=control-group` applies:
  stopping the unit signals every process in the service cgroup,
  including a `detached` orca child. Bare/manual `bun src/main.ts` has
  no cgroup — a parent SIGKILL can leave that detached child running.
  This example does not add a PDEATHSIG wrapper; prefer the unit (or an
  equivalent cgroup) in deployment.
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
  Caddy/nginx templates proxy `/health` and `/hooks/*` only. Binding a
  non-loopback listen address logs `listen_not_loopback` (no secrets).
  Unknown hook routes return **404**; a known route with a failed
  signature returns **401**. Route keys are not credentials; the
  distinction is intentional and is not an authentication system.
- Dedup fsyncs the file and the parent directory after rename, including
  first directory creation. A failed directory fsync leaves an `.unacked`
  marker; 2xx is withheld until that fsync succeeds. A failed **mkdir**
  fsync records the ancestor chain in `.dirsync` and resyncs that chain
  on retry/restart before ACK. At-least-once, not exactly-once. A new
  event reserves a dedup slot through send+commit (released on failure)
  so a concurrent observe record cannot steal the last slot after a
  canary wake has started.
- In-memory wake history is off by default (`wakeHistoryLimit=0`).
- The external monitor keeps state under `/var/lib/webhook-wake-monitor`
  (not `/tmp`) and never sources that file as shell. Across-run persistence
  already exists via `StateDirectory`. `save()` is an atomic rename without
  fsync: a crash between write and disk flush may roll back one tick
  (`last_alert` / `alarming`). That is an explicit monitor limitation, not
  the receiver 2xx durability contract; FC may confirm the disposition.
  Recovery during cooldown is pending and emitted on a later tick.
  A failed `health_recovered` delivery does **not** advance
  `lastAlertAtMs` / `last_alert`; the next healthy tick retries without
  a full cooldown (`monitor.ts` matches `monitor.sh` here). A failed
  `health_failed` in the TypeScript helper still stamps `lastAlertAtMs`
  so a down sink is not hammered every interval — that is **not** claimed
  as shell parity (`monitor.sh` stamps `last_alert` only after a
  successful `health_failed`).
  The probe requires an exact HTTP **200** (no redirect follow; 3xx/4xx/5xx
  are failures) in **both** `templates/monitor.sh` and `httpProbe`. Alert
  execution requires a `timeout` binary; a missing tool fails visibly and
  never runs the alerter unbounded. `alertHook.url` POSTs with
  `redirect: manual` and accepts only HTTP 200 — redirects are not
  followed (trusted-operator URL; no extra DNS/private-network policy).
  Authenticated mapping/stale failures coalesce alerts per code (first
  fire, then cooldown) so sender retries stay 503 without flooding the
  sink.
  Install rename (required so the timer `Unit=` resolves):
  `monitor.service` → `/etc/systemd/system/webhook-wake-monitor.service`,
  `monitor.timer` → `/etc/systemd/system/webhook-wake-monitor.timer`,
  `monitor.sh` → `/usr/local/bin/webhook-wake-monitor.sh`.
- Secret files on Linux must be mode `0600` (group/other bits fail load).
  Load uses one fd: `O_NOFOLLOW` + `fstat` + read (symlink →
  `secret_symlink`). That is a local operator-directory trust boundary,
  not a new credential policy. `templates/canary.whs.example` is
  deliberately **not** a valid `whs_` hex secret until replaced.
  `alertHook.url` is trusted-operator config; this example does not add
  SSRF/network policy (upstream API already pins egress). Oversized
  bodies return HTTP 413 on the live connection; unknown unauthenticated
  routes never call the alert hook. Request timeout aborts an unfinished
  body read and frees the concurrent slot; a later completed wake+dedup
  is not cancelled.
- **Deploy checklist (guidance, not a substitute for timeout/slots):**
  rate-limit public `/hooks` at the proxy or host filter you already
  operate. nginx (standard `limit_req`; zone belongs in `http {}`):
  `limit_req_zone $binary_remote_addr zone=webhook_wake:10m rate=10r/s;`
  then `limit_req zone=webhook_wake burst=20 nodelay;` on `/hooks/`.
  This tree does **not** invent a Caddy rate-limit module directive.
  Non-loopback bind already logs `listen_not_loopback` (no new limiter).
  Route 404 vs 401 stays a documented non-secret distinction. `alertHook.url`
  remains trusted-operator config (no new scheme allowlist). Timer overflow
  stays documented; commander 1823 accepted README ranges without new
  load-time caps.

## Recommended numeric ranges (guidance, not newly enforced)

These ranges describe operator defaults and current load-time constraints.
They are **not** a new validation layer. Present values must already be
integers of the documented sign; only `listen.port` (0–65535) and
`dedup.retentionMs` (≥72h) have extra ceilings/floors today. Do not treat
the recommended bands below as runtime-enforced limits.

| Field | Default | Current load rule | Recommended band | Runtime / misconfig note |
| --- | --- | --- | --- | --- |
| `listen.port` | 8787 | integer 0–65535 | 1024–65535 (0 = kernel ephemeral) | Bind failure is startup-fatal. |
| `bodyLimitBytes` | 16384 | integer > 0 | 4096–65536 | Metadata events are small; too low yields 413. |
| `timestampToleranceSec` | 300 | integer > 0 | 60–600 | Replay window. Large values accept stale signatures. |
| `maxV1Signatures` | 8 | integer > 0 | 2–16 | Rotation candidates. Too low rejects a valid current+previous header. |
| `maxHeaderBytes` | 2048 | integer > 0 | 2048–8192 | **UTF-8 byte** length (`Buffer.byteLength`). The parser and `createServer({ maxHeaderSize })` use `maxHeaderBytes + 4096` so other request headers fit. If that total exceeds the process `http.maxHeaderSize` (Bun default 16384), **load fails** (`config_invalid:maxHeaderBytes_exceeds_transport`). Raise the runtime (`bun --max-http-header-size=…`) before promising a larger signature. Too small → 401 `invalid_header`. |
| `requestTimeoutMs` | 10000 | integer > 0 | 2000–30000 | Aborts an unfinished **HTTP body read** and frees the concurrent slot. Does not kill an already-spawned Orca child. |
| `maxConcurrent` | 16 | integer > 0 | 1–64 | In-flight HTTP cap. `0` fails load. Too low → 503 `busy`. |
| `sendTimeoutMs` | 8000 | integer > 0 | 1000–30000 | SIGKILL of the **spawned job process group** after this budget. Independent of `requestTimeoutMs`. Too small → 503 `timeout_killed`. |
| `outputCapBytes` | 4096 | integer > 0 | 1024–16384 | Bound on **retained** child stdout/stderr counts. Excess is drained and discarded (not pipe-destroyed) so a zero-exit send still commits. |
| `wakeHistoryLimit` | 0 | integer ≥ 0 | 0–128 | In-memory ring only. `0` disables history. |
| `dedup.retentionMs` | 604800000 (7d) | integer ≥ 259200000 (72h) | 72h–30d | Replay/dedup window. Below 72h fails load. |
| `dedup.maxRecords` | 10000 | integer > 0 | 1000–100000 | Fail-closed when full (no eviction of live keys). |
| `alertHook.timeoutMs` | 2000 | integer > 0 | 500–10000 | Receiver hook POST budget only. |

External monitor timers (templates, not JSON config): probe interval **30s**,
`FAIL_THRESHOLD` **2**, `COOLDOWN_SEC` **300**, curl `--max-time` **5**,
`ALERT_TIMEOUT_SEC` **2**. Recommended: interval 15–60s, threshold 2–5,
cooldown 60–900s, curl 2–10s, alert timeout 1–5s. A future persisted
`last_alert` is treated as **not** in cooldown.

**Timer distinction:** `requestTimeoutMs` is the inbound HTTP deadline.
`sendTimeoutMs` is the child-kill deadline after a wake starts. Setting
either far below the other does not compensate: a late body can still
complete a wake if the request already passed to send, and a tiny send
budget kills a healthy child while the HTTP slot is still open.

**Runtime timer range (not a new config ceiling):**
`requestTimeoutMs`, `sendTimeoutMs`, and `alertHook.timeoutMs` are passed
to `setTimeout` (and `requestTimeoutMs` also to `http.Server.requestTimeout`
/ `headersTimeout`). Node.js timers
(https://nodejs.org/docs/latest-v22.x/api/timers.html#settimeoutcallback-delay-args)
keep `delay` in a signed 32-bit millisecond range. If `delay` is larger
than **2147483647** (~24.8 days), the runtime sets the duration to
**1 ms** and emits `TimeoutOverflowWarning` (observed on this
workspace's Bun 1.3.14 and Node v24.5.0; `_idleTimeout` becomes 1).
Values below 1 (including Bun `delay=0`) are also clamped to **1 ms**;
Bun 0 does that **without** `TimeoutOverflowWarning`. This example
does **not** add a load-time cap. A huge integer is **not** a reliable
multi-day HTTP, send, or alert timer — it can fire almost immediately.
Stay in the recommended second-to-tens-of-seconds bands, far below
2^31−1. `dedup.retentionMs`
and `timestampToleranceSec` are wall-clock comparisons, not
`setTimeout`, so a 7d–30d retention does not use this clamp. Monitor
`COOLDOWN_SEC` / systemd `OnUnitActiveSec` are shell/unit seconds, not
JS timers.

**Deploy verification:** `bun src/main.ts --config <file>` starts a
**persistent listener**. It does **not** exit 0 after a successful bind.
`startup_not_ready` is only logged; the process still calls
`listenReceiver` and stays up. Success is all of: the process remains
running; a `listening` log with the bound URL; loopback
`GET /ready` returns **HTTP 200** with `ready: true`. HTTP 503 on
`/ready` means the socket is up but mappings/state are not ready.
Then POST one signed canary with the intended header size/rotation
count and confirm `/health` from the monitor host. Check that a
deliberate oversize header is 401 and that a write-without-search
state directory is unready.

Config shape/numbers without starting a service (existing
`parseFileConfig`, `loadSecrets: false`; no new CLI). Prints `config_ok`
and exits; does not bind a port or load secret files:

```bash
bun -e 'import { parseFileConfig } from "./src/config.ts";
const raw = JSON.parse(await Bun.file(process.argv[1]).text());
parseFileConfig(raw, { loadSecrets: false });
console.log("config_ok");' -- /path/to/config.json
```

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
uses the TypeScript and `@types/node` already installed under
`packages/api/node_modules` (`bun run typecheck`); no new dependency is
added.

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
