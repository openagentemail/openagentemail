# RFC-0001: Outbound event webhooks

- **Status:** Proposed — draft for owner ratification. This document authorizes no
  implementation and commits no schedule.
- **Date:** 2026-09-03
- **Issue:** [#109](https://github.com/openagentemail/openagentemail/issues/109)
- **Decision scope:** event catalog, payload schema, signing and verification, delivery
  semantics (retry, ordering, dead letters), SSRF and egress safety, configuration
  surface (env + REST), coexistence with `mail_wait_for`, and the secret/rotation model.
- **Out of scope:** auto-reply / responder engines (#105), cross-domain federation
  (#59), inbound webhooks (external system → OAE), any change to the mail or task
  state machines, and hosted-plan billing or quota policy.
- **Implementation code:** none. This is a design document. Code-shaped blocks below are
  wire-format illustrations and operator commands, not a reference implementation.

> On numbering: this repository keeps architecture decision records under
> `design/adr-NNNN-*.md`, but that sequence is numbered outside this repo (only
> `design/adr-0026-dashboard-revamp.md` is committed here), so this document does not
> claim an ADR number. If ratified, it should be adopted as the next `design/adr-NNNN`
> by whoever owns that sequence, and this file should then point at it.

---

## 1. Summary

OpenAgentEmail today is **pull-only**. An agent that wants to know whether mail arrived
must ask: `mail_wait_for` long-polls `POST /v1/messages/wait`, watchers poll IMAP, humans
refresh the dashboard. The server never speaks first.

This RFC proposes **outbound event webhooks**: an operator (or an identity-scoped agent
token) registers an HTTPS callback URL, and OAE POSTs a small signed JSON event to it
when something happens — starting with `mail.received`.

The design deliberately reuses four subsystems that already exist and are already
hardened, rather than inventing parallel ones:

| Need | Existing subsystem to reuse | Reference |
| --- | --- | --- |
| Inbound-mail event source | the process-wide IMAP IDLE loop with a UID high-water mark | `packages/api/src/lib/notification-watcher.ts:1602` |
| SSRF / egress safety | the single shared IP policy + DNS-pinned fetcher | `packages/api/src/lib/net.ts:1`, `packages/api/src/lib/oauth-cimd.ts:363` |
| Payload bounding | push content tiers and their byte caps | `packages/api/src/lib/identities.ts:53`, `notification-watcher.ts:54-70` |
| Delivery log / dead-letter inspection | append-only 30-day JSONL + inspection API | `packages/api/src/lib/notification-log.ts`, `routes/ui.ts:1048` |

The decisions that carry the most risk are **not** cryptographic. They are:

1. **The event source is currently gated on ntfy.** Webhooks hooked into the existing
   watcher loop would silently not fire on any deployment that does not run ntfy, and ntfy
   is off by default (§11.4). Fixing this means refactoring a loop that works today.
2. **"Reuse the existing SSRF policy" is a trap as stated.** The shared policy permits
   private addresses *unless* told otherwise, and the flag that tells it otherwise defaults
   to off. Naively reusing it would let any token holder point OAE at the compose-internal
   network — the exact attack §9.6 exists to describe. §9.1 gives the one-line composition
   rule that prevents this, and §14 item 2 makes it the highest-value test in the feature.
3. **Webhooks invert who must be network-reachable.** Long-polling requires the *agent* to
   reach OAE; webhooks require OAE to reach the *agent*. Neither replaces the other, and
   the long-poll path must not be deprecated (§11.2).

Consequently three of the five PRs in §15 touch production code that predates this feature
—the SSRF fetcher extraction, the event-bus refactor, and exposing the existing mail cursor
on the bearer API (§3.7) — and those, not the signing scheme, are where the implementation
risk lives.

---

## 2. Goals and non-goals

### 2.1 v1 goals

1. Deliver `mail.received` events to operator-registered HTTPS endpoints, at-least-once.
2. Sign every delivery with HMAC-SHA256 so a consumer can prove authenticity and reject
   replays, and document verification **before** documenting anything else.
3. Bound payloads structurally: a webhook never carries a full mail body (§6.4).
4. Refuse to become an SSRF amplifier or a DDoS reflector — reusing the existing shared
   IP policy rather than writing a second one, **and** composing it correctly, which is
   not the same thing (§9.1).
5. Fail visible: a broken endpoint is a surfaced health signal, never a silent drop.
6. Coexist cleanly with `mail_wait_for`; consume no wait slots (§11).
7. Be configurable entirely through the repo's existing env, REST, and MCP-tool
   conventions (§10), with no new datastore technology.

### 2.2 Non-goals (explicit)

These are refused for v1, not deferred by accident:

- **No auto-reply / auto-forward / responder engine.** #105 asks for a built-in
  `agent.yaml` LLM responder. This RFC is the substrate that lets an operator build that
  in userland; it does not build it. A rules engine in core would inherit prompt
  injection from every inbound mail body, which is a materially worse threat surface
  than pushing metadata to an endpoint the operator chose.
- **No federation.** #59's cross-domain signed task envelopes need asymmetric
  signatures, `.well-known` discovery, trusted-domain allowlists, and replay nonces.
  None of that is here. §7.6 explains why the v1 signature header is nonetheless shaped
  so that a future asymmetric scheme is additive rather than breaking.
- **No inbound webhooks** (external system POSTs in and becomes mail or a task).
  Different trust direction, different auth model, different abuse surface. Separate card.
- **No events other than `mail.received`.** `mail.sent`, `task.*`, `approval.*`, and
  lease lifecycle events get **reserved names** (§5.2) so that adding them later is not a
  breaking change, but v1 emits exactly one event type.
- **No ordering guarantee, and no exactly-once delivery.** Both are documented as
  absent rather than approximated (§8.1, §8.4).
- **No durable queue surviving restart with full fidelity.** §8.6 states precisely what
  is and is not recovered across a process restart.
- **No new UI.** v1 exposes REST only. A read-only dashboard view is an open question
  (§16, Q10).
- **No batching, no bulk subscribe, no consumer-supplied rate limits.**
- **No replacement of `mail_wait_for`.** It stays, unchanged, first-class (§11.5).

---

## 3. What already exists in this repository

This section is factual, not propositional. Every claim is cited so a reviewer can check
it; the design in §4–§13 depends on these specifics.

### 3.1 The inbound-mail event source

Mail is not stored on the API's filesystem. `packages/api/src/lib/imap.ts` talks to a
single catch-all Dovecot mailbox over IMAP, one-shot connection per call. Identities are
matched to messages by `To` / `Cc` / `Delivered-To`.

Exactly one place in the process observes each new message once:

- `startNotificationWatcher()` (`notification-watcher.ts:1602`) runs one process-wide
  loop, started from `main.ts:42`.
- `watchConnection()` maintains a **UID high-water mark** (`WatcherWatermark`), races
  `client.idle()` against a 3 s heartbeat, re-anchors on `UIDVALIDITY` change, and
  reconnects with 2 s → 120 s backoff.
- `processWatchedMessage()` parses the message and applies policy and content-tier
  gating before publishing.

By contrast, `POST /v1/messages/wait` (`routes/messages.ts:78`) is per-caller and
**has no cursor**: for an ordinary mail wait, `findMatchWith()` pages the newest 20 inbox
messages (`imap.ts:1013`) and returns the newest match, so an already-present message
returns immediately. (Task waits deliberately bypass that view and do a full-mailbox
header search instead — `imap.ts:1003-1012`, with a source comment explaining that a busy
identity can receive many unrelated messages while a task runs. The newest-20 limit is
specific to `mail_wait_for`.) Duplicate avoidance is the caller's job either way. The wait
path is therefore unsuitable as an event source, and webhooks must not be built on it.

**Startup gate (the problem):** the loop is gated twice on ntfy —

```
main.ts:40                     if (config.ntfy.enabled) { … startNotificationWatcher(); }
notification-watcher.ts:1603   if (!config.ntfy.enabled || config.ntfy.pushPolicy === 'none') return () => {};
```

### 3.2 Existing SSRF policy

`lib/net.ts:1` describes itself (translated from the Chinese source comment) as *"the single
shared implementation for hostname / IP private-network and SSRF decisions — CIMD SSRF and
the MCP insecure-issuer gate both go through here; copying another one is forbidden."* That
mandate is binding on this design, and §9.1 shows it is not as simple as calling the
function.

- `isBlockedSsrfIp()` (`net.ts:156`) **always** blocks `169.254.0.0/16`, `0.0.0.0/8`,
  `fe80::/10`, and `fd00:ec2::/16` (AWS IMDS over IPv6), including IPv4-mapped IPv6
  forms via `ipv4MappedFromV6()` (`net.ts:126`).
- `isSsrfBlockedResolvedIp()` (`net.ts:225`) additionally blocks multicast, `::`, and
  special-use space, and permits RFC1918 / CGNAT / loopback / ULA **only** under the
  private-deployment exception — which `OAE_PUBLIC_EDGE=true` (`config.ts:214`) turns off.
  Always-blocked ranges never count as "private" (`net.ts:205`).

The reference *consumer* of that policy is `pinnedCimdFetcher()`
(`oauth-cimd.ts:363`), which is the DNS-rebinding defense already proven in this
codebase: it uses Node `http`/`https` with a **custom `lookup` hook that re-checks every
resolved A/AAAA record at connect time**, so there is no gap between "the name resolved
to a safe address" and "the socket connected to that address". It also sets a 10 s
timeout and caps the response at 5 KiB via a streaming read (`oauth-cimd.ts:450`).
Redirect refusal sits one layer up, in the CIMD document-fetch wrapper, which sets
`redirect: 'manual'` (`oauth-cimd.ts:526`) and rejects any 3xx as `redirect_forbidden`
(`oauth-cimd.ts:543`); §9.1 explains why that layering changes the phasing.

### 3.3 Signing conventions

| Mechanism | Algorithm | Key | Domain separator | Encoding |
| --- | --- | --- | --- | --- |
| `taskStamp` (`tasks-internal.ts:458`) | HMAC-SHA256 over `\n`-joined fields | `config.taskSigningSecret` | implicit in field tuple | base64url |
| approval digest (`tasks-internal.ts:442`) | SHA-256 over canonical JSON | — | `approval-action-v1` shape | lower-case hex |
| `X-OA-Mail-Stamp` (`mail-stamp.ts:25`) | HMAC-SHA256 | `config.taskSigningSecret` | `mail-stamp-v1` | base64url |
| mail body hash (`mail-stamp.ts:22`) | SHA-256 | — | `mail-body-v2` | base64url |
| mail cursor (`mail-cursor.ts:12`) | HMAC-SHA256 | `config.taskSigningSecret` | `mail-cursor-v1` | base64url |
| notify cursor (`config.ts:309`) | HMAC-SHA256 **key derivation** | `config.taskSigningSecret` | `notify-cursor-v1` | raw bytes |

Three conventions matter for this RFC:

**(a) Domain separation by HMAC-deriving a subkey from the root secret, with no new env
var.** `config.ts:308` says so explicitly (translated from the Chinese comment): *"the
notify cursor is domain-separated from
the task/mail cursors; no new env var is added."*

**(b) Length-prefixing to kill boundary ambiguity.** `mail-body-v2` hashes
`mail-body-v2\nlen(text)\ntext\nlen(html)\nhtml` (`mail-stamp.ts:36`, `:79`) precisely so
that two different field splits cannot produce the same signed bytes.

**(c) The anti-oracle rule.** `mail-stamp.ts:141` writes the stamp **only when every
recipient is on-domain**, because `taskSigningSecret` may fall back to `SMTP_PASS`
(`config.ts:281`) and a mixed/external recipient could otherwise use the stamp as an
HMAC oracle over that secret. Verification is constant-time (`timingSafeEqual`,
`mail-stamp.ts:115`) and fails closed.

`config.ts:270-280` already turns (c) into a boot-time rule for the one existing feature
that sends data to an external party: if `ALWAYS_BCC` is set, an explicit
`TASK_SIGNING_SECRET` of ≥ 32 characters is **required**, and the `SMTP_PASS` fallback is
refused. §12.1 applies the same rule to webhooks.

### 3.4 Payload bounding precedent

Per-identity `pushContentTier: 1 | 2 | 3`, default 1 (`identities.ts:48`,
`resolvePushContentTier()` at `:53`, admin-only setter at `:396`). Unknown tier values
read back as the default (`identities.ts:100`) — a forward-compatibility rule worth
copying.

- Tier 1: interrupt only — "address received new email", plus a **boolean** that an OTP
  or verification link is present. No values.
- Tier 2: adds From/Subject, masked (`maskTier2Metadata()`, `notification-watcher.ts:936`).
- Tier 3: adds body preview and OTP codes/links, and marks the log row `sensitive: true`.

Caps (`notification-watcher.ts:54-70`): `PUSH_BODY_PREVIEW_CHARS = 280`,
`PUSH_OTP_ITEM_MAX = 5`, `PUSH_OTP_ENTRY_CHARS = 200`, `PUSH_MESSAGE_MAX_BYTES = 3500`,
`PUSH_META_FIELD_MAX_BYTES = 400`. The ntfy transport cap is
`NTFY_REQUEST_MAX_BYTES = 4_000` (`notify.ts:752`), with a defined overflow order (drop
click, then truncate-or-error). Byte-safe truncation is `truncateUtf8Bytes()`
(`lib/utf8-truncate.ts:15`).

### 3.5 Delivery-log precedent

`notification-log.ts` writes append-only `DATA_DIR/notification-log.jsonl`, 0600, single
writer, retained 30 days (`NOTIFICATION_LOG_RETENTION_MS`), written only after a
successful publish (plus failed-urgent rows). It is read back through
`GET /ui/api/notifications` and `/ui/api/notify/summary`. That is a working
dead-letter/inspection pattern to mirror.

Retry today is shallow: `publishWithRetry()` makes `PUBLISH_MAX_ATTEMPTS = 3` attempts
with 250 → 500 ms backoff (`notification-watcher.ts:47`, `:171`), and on a provider-wide
outage the UID is retained for at most `SERVICE_FAILURE_MAX_MS = 10 min` (`:50`) before
the watcher logs CRITICAL and **skips the message permanently**. There is no durable
queue. Webhooks need a longer budget than 10 minutes, because the consumer is an
external party that may be mid-deploy — but not orders of magnitude longer (§8.3).

### 3.6 Config, route, and error conventions

- Env: one zod schema (`config.ts:91-230`), parsed once at import
  (`export const config = parseConfig(process.env)`, `:345`), so a bad value fails the
  boot rather than the request. SCREAMING_SNAKE with feature namespaces (`NTFY_*`,
  `MCP_*`, `TASK_*`, `RETENTION_*`, `OAE_*`).
- Booleans are `z.enum(['true','false'])`, **not** `z.coerce.boolean()`, because Compose
  `${VAR:-}` injects `""` when unset and `emptyAsUndefined` (`config.ts:15`) maps blank
  to undefined so `.default()` applies; a bare string `"false"` is truthy in JS and would
  silently enable things.
- `0` means disabled for numeric limits. URLs go through `envUrl()` (http/https only,
  `config.ts:27`); `DASHBOARD_PUBLIC_URL` additionally rejects userinfo, query, and
  fragment (`config.ts:64`).
- REST: Hono, `/v1` prefix, plural nouns, mounted in `app.ts:104-116`. `bodyLimit`
  (16 MiB, `limits.ts:5`) runs **before** `bearerAuth` (`app.ts:96-103`), returning
  `413 {error:'request_too_large'}`. Reads are GET; mutations are POST including
  sub-resource verbs (`POST /v1/tasks/:id/claim`); `DELETE` is used where deletion is the
  operation (`routes/notify.ts:228`). Success returns a bare object, `201` on create;
  lists wrap in a named key (`{messages}`, `{tasks}`, `{children, nextCursor}`). Errors
  are `{error:'snake_case_code'}` with optional `details` / `retryAfterSec` — with one
  established exception: authorization failures use a prose suffix
  (`'forbidden: token is scoped to another address'`, `auth.ts:218`;
  `'forbidden: admin key required'`, `routes/audit.ts:11`). §10.3 reuses both strings
  verbatim rather than inventing new codes for the same conditions.
- Auth is bearer-only (`auth.ts:180`): `admin` (exact member of `API_KEYS`), `identity`
  (`oa_…` token scoped to one address, stored as a SHA-256 hash), or `oauth` (always
  identity-scoped). `requireAdmin` (`routes/audit.ts:9`) is the admin-gate precedent.
- Rate limiting is an in-memory **sliding window** (`slidingWindowCheck()`,
  `ratelimit.ts:26`), reset on restart by design, with `limit <= 0` disabling. Wait slots
  are capped at `MAX_WAITS_PER_ADDRESS = 3` and `MAX_WAITS_TOTAL = 8` (`ratelimit.ts:205-206`)
  → `429 {error:'too_many_waits', retryAfterSec:5}`.
- Audit is append-only `DATA_DIR/audit.jsonl`, rotated at 10 MiB, with a **field
  whitelist** (`ts, event, clientId?, grantId?, address?, tool?, tier?, outcome,
  durationMs?, ip?`) that structurally cannot carry args, bodies, tokens, or subjects
  (`audit.ts:38-50`), C0-stripping via `scrubAuditField()`, and a `recordAuditEvent()`
  that never throws.
- Secrets at rest: there is no database. Bearer secrets are **never** persisted in
  plaintext — identity tokens and OAuth tokens are stored as SHA-256 hashes used as
  lookup keys. `notification-devices.ts:112` hard-refuses to persist any object
  containing a `password` or `token` key. Store files are 0600 in a 0700 directory,
  written atomically via `.tmp` + rename, with fsync of file and directory, and a corrupt
  store fails closed.

### 3.7 The reusable resume token

`mail-cursor.ts` already produces an HMAC-signed opaque cursor binding
`(folder, address, receivedAtMs, uid)`, domain-separated as `mail-cursor-v1`, sortable
newest-first by `(t desc, uid desc)`, and designed specifically to prevent cross-folder /
cross-identity reuse and client forgery of a "next page" token (the source comment at
`mail-cursor.ts:4-6`, translated from Chinese).

**But note precisely where it is exposed.** Cursor pagination is implemented in
`listMessagesPageWith()` (`imap.ts:754`) and returned as `{messages, nextCursor}`
(`imap.ts:112-115`) — and today it is reachable only through the **cookie-session
dashboard routes** (`routes/ui.ts:758`). The bearer-token API does **not** accept a cursor:
`GET /v1/messages` validates `address` and `limit` only (`routes/messages.ts:8-11`) and
returns a bare `{messages}`.

So the cursor is a ready-made primitive, not a ready-made **endpoint**. Embedding one in a
webhook payload gives ordering reconstruction (§8.4) and catch-up (§11.5) for free at the
*data* level, but making it useful to a webhook consumer requires **extending
`GET /v1/messages` with `cursor` and `nextCursor`** — the IMAP-layer work is already done,
so this is a thin route change. It is listed as prerequisite work in §15 rather than
assumed to exist.

---

## 4. Reference systems: what we borrow and what we refuse

Three families of prior art are worth arguing with. The point of this section is not
"GitHub does X so we do X" — it is to make the trade-offs explicit and to record *why*
each borrowing survives contact with a self-hosted mailbox that has no database.

The vendor facts below were checked against official documentation, not recalled. Where a
vendor publishes no number, this section says so rather than filling the gap — an invented
constant in a design document becomes an invented requirement in an implementation.

### 4.1 GitHub webhooks

**Borrow:**

- **Separate headers for event type and delivery id.** GitHub sends `X-GitHub-Event` and
  `X-GitHub-Delivery` (a UUID unique per delivery attempt) alongside the signature, plus
  `X-GitHub-Hook-ID` and a `GitHub-Hookshot/` user agent. Splitting these lets a consumer
  route and dedupe *before* parsing JSON, and gives a support vocabulary ("which delivery
  failed?"). OAE adopts `X-OAE-Event`, `X-OAE-Delivery`, and a
  `openagentemail-webhooks/1` user agent (§7.1).
- **A 10-second response timeout.** GitHub documents that the endpoint *"should respond
  with a 2XX response within 10 seconds"*, after which GitHub terminates the connection
  and counts the delivery as failed. This is the one hard number GitHub publishes, and it
  independently validates the `WEBHOOK_DELIVERY_TIMEOUT_MS = 10000` default proposed in
  §10.1 — which also happens to match this repo's existing `CIMD_FETCH_TIMEOUT_MS`.
- **A `ping` handshake at subscription creation.** GitHub documents that the `ping` event
  *"occurs when you create a new webhook"* as *"a confirmation … that you configured the
  webhook correctly"*, carrying a `zen` aphorism, `hook_id`, and the hook object. For a
  self-hosted product whose operators configure this over SSH, that feedback loop is worth
  more than it is for GitHub. Adopted as `webhook.ping` (§5.1, §10.3). Note that GitHub
  does **not** document whether the ping is delivered synchronously with the creation
  call, so this RFC treats synchronicity as its own open decision (§16, Q12) rather than
  copying GitHub.
- **A manual redelivery affordance backed by a stored delivery log.** GitHub lets you
  replay a delivery from the past **3 days**, through the UI or
  `POST …/hooks/{hook_id}/deliveries/{delivery_id}/attempts`. This is the cheapest
  possible dead-letter UX and maps directly onto the `notification-log.jsonl` pattern OAE
  already has. Adopted as `POST /v1/webhooks/deliveries/:id/redeliver` (§10.3), with the
  same 30-day retention as the rest of the repo's logs.
- **An algorithm-prefixed signature value.** GitHub's `X-Hub-Signature-256: sha256=<hex>`
  makes the algorithm explicit on the wire, so a future algorithm is a new header/prefix
  rather than an ambiguity. Adopted as the `v1=` prefix (§7.2).

**Refuse:**

- **GitHub's absence of automatic retry.** This is the sharpest divergence in the whole
  comparison, and it is the opposite of what most people assume. GitHub documents
  plainly: *"GitHub does not automatically redeliver failed deliveries."* The retry loop
  is the **integrator's** problem — GitHub's own suggested automation is a user-authored
  cron GitHub Action that walks recent deliveries and re-posts them. That is a defensible
  choice for a platform with a built-in scheduler sitting next to every consumer, and it
  is indefensible for OAE, whose consumers are fifty-line scripts and serverless functions
  (#109's own framing). A failed delivery that nobody retries is a silently dropped mail
  event, which is exactly what #109 forbids. **OAE retries automatically** (§8.3) *and*
  offers manual redelivery.
- **Fat payloads.** GitHub sends the whole resource — a `push` event can carry hundreds of
  commits. That works because GitHub's consumers are CI systems with fat pipes and because
  GitHub owns both ends of the trust relationship. OAE's payload crosses to a third party
  and may contain mail metadata, so bounding is structural (§6.4), not best-effort.
- **Repository-scoped, UI-first management.** OAE has no per-repo concept and, per §2.2,
  no new UI in v1.

**Not usable as precedent:** GitHub publishes **no** statement about delivery ordering,
at-least-once semantics, or duplicates — the ordering disclaimer in §8.4 rests on Stripe,
not GitHub. GitHub also publishes no numeric retry budget (there is none) and no secret
rotation procedure; what it *does* do is emit a legacy `X-Hub-Signature` (HMAC-SHA1)
alongside `X-Hub-Signature-256` for algorithm migration, which is dual-*algorithm*
emission rather than dual-*secret*, and is discussed in §12.2 as the weaker cousin of the
mechanism OAE adopts.

### 4.2 Stripe webhooks

**Borrow — this is the most influential reference:**

- **Bind the timestamp into the signature.** Stripe signs `"<t>.<raw body>"` — the docs
  describe the signed payload as the concatenation of the timestamp as a string, a period,
  and the JSON payload — and puts `t=<unix seconds>` in `Stripe-Signature`. Consumers are
  told to reject deliveries whose timestamp is outside a tolerance window; the **client
  libraries' default is 5 minutes**, and it is a parameter the consumer passes, not a
  server-enforced limit. This makes replay protection a property of the *signature* rather
  than of a server-side nonce store — which matters enormously here, because OAE has no
  database to keep nonces in. Adopted in shape (§7.2, §7.4), with the important difference
  that OAE's tolerance is an operator setting that is *published to consumers*
  (`WEBHOOK_TIMESTAMP_TOLERANCE_SEC`, surfaced in `GET /v1/webhooks`) rather than a library
  default each integrator must guess.
- **A thin envelope with a typed `data` object.** Stripe's Event object — `id`, `object`,
  `api_version`, `created`, `type`, `data.object`, `livemode`, `pending_webhooks`,
  `request` — is versioned, self-describing, and stable across event types. Adopted, with
  the fields OAE actually needs (§6.1).
- **Treat the payload as a snapshot and re-fetch authoritative state through the API.**
  Stripe documents this explicitly: consumers should *"retrieve the API resource from the
  Stripe API to access the latest and up-to-date object definition."* It is the decision
  that makes everything else cheap. If the webhook only has to be *good enough to act on*,
  the payload can stay small, the content-exposure question collapses (§6.4), and OAE never
  has to design a webhook-side representation of a mail body. The consumer fetches
  `GET /v1/messages/:id` with its own credentials. Adopted as a hard rule.
  **Consequence worth stating plainly: possession of a webhook signing secret is not a
  mail-content credential.** Full content still requires an API token.
- **Dedupe on the event id, as documented consumer guidance.** Stripe's own words: guard
  against duplicates *"by logging the event IDs you've processed, and then not processing
  already-logged events."* Adopted verbatim as a normative consumer requirement (§8.1).
- **Multiple signatures in one header during a secret roll.** Stripe confirms it: *"You can
  have multiple signatures with the same scheme-secret pair when you roll an endpoint's
  secret… Stripe generates one signature for each secret."* The header also carries a
  legacy `v0=` field next to `v1=`, which is living proof that a versioned prefix lets an
  old scheme coexist with a new one for years. Adopted for rotation (§12.2) and for
  algorithm versioning (§7.6).
- **`pending_webhooks` as a failure counter.** Stripe's Event object carries the number of
  webhooks not yet successfully delivered. It is a small, cheap, always-visible signal that
  the push subsystem is behind — precisely the "fail visible" property #109 asks for.
  Adopted in spirit as per-endpoint `consecutiveFailures` and instance-level dead-letter
  counts (§13).
- **An explicit ordering disclaimer.** *"Stripe doesn't guarantee the delivery of events in
  the order that they're generated."* One sentence, prominently documented, and it removes
  an entire class of integrator bug. Adopted, plus the reconstruction tools Stripe does not
  offer (§8.4).

**Refuse:**

- **The ~3-day retry budget.** Stripe retries *"for up to three days with an exponential
  back off in live mode"*; the number of attempts is not published, and the three-day
  figure is scoped to live mode. Stripe can afford this because its events are financial
  and eventually-consistent reconciliation is normal. Mail events are **perishable** in the
  front and **recoverable** in the tail: an OTP is worthless in an hour, while "your
  endpoint was down overnight" is worth more than a day of patience. OAE therefore adopts a
  schedule that is *front-loaded* for perishability and *bounded* to about a day (§8.3),
  following Resend's published shape rather than Stripe's unpublished one. A three-day
  budget also means three days of durable queue in a process whose only durable store is a
  JSONL file (§8.6).
- **`api_version` pinning per endpoint.** Stripe's per-account API version pinning is a
  large compatibility machine justified by thousands of breaking-change-averse
  integrations. OAE has one payload version and additive-only evolution rules (§5.3).
- **A database-backed event log.** Stripe can inspect and replay from durable storage at
  scale. OAE keeps a bounded 30-day JSONL and says so (§8.6).

**Not usable as precedent:** Stripe publishes no numeric response timeout — it says the
endpoint must return 2xx *"quickly … before any complex logic that could cause a timeout"*
— so §8.2's timeout comes from GitHub's 10 s and this repo's own `CIMD_FETCH_TIMEOUT_MS`,
not from Stripe. Stripe also does **not** document automatic disablement of failing
endpoints; that behavior is Resend's (§4.3), and attributing it to Stripe would be wrong.

### 4.3 Resend / Svix, and SendGrid

Resend is the closest *domain* analogue — a thin event catalog around email, including an
`email.received` type — and it delegates signing to Svix. SendGrid is examined twice,
because it signs one webhook and not the other, and the contrast is instructive.

**Borrow:**

- **Resend's published retry schedule, almost verbatim.** Resend's *Retries and replays*
  page enumerates its attempts exactly: *"Immediately, 5 seconds, 5 minutes, 30 minutes,
  2 hours, 5 hours, 10 hours, 10 hours (in addition to the previous)"* — eight attempts.
  This is the single most useful number set in the comparison, because it is (a) published
  rather than vague, (b) bounded rather than open-ended, and (c) derived for **email
  events**, the same domain. OAE adopts this shape in §8.3 and credits it.

  **Worth recording: Resend's own docs disagree with themselves.** Its dashboard webhooks
  introduction page lists only *"5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours,
  10 hours"* — six delays, no leading immediate attempt and no trailing second 10 hours.
  Neither page states whether its numbers are inter-attempt delays or offsets from the
  first, which changes the total span by hours. This is not a dig at Resend; it is the
  reason §8.3 specifies OAE's schedule as explicit delays with a computed worst-case span,
  rather than inheriting a list that even a well-run vendor documents two ways.
- **Resend's documented auto-disablement.** *"If the endpoint continues to fail, Resend
  will eventually disable it automatically and send a second notification to let you
  know."* Disablement **plus an explicit second notification** is the complete form of
  "fail visible, never silent". Adopted as the circuit breaker (§8.5), with OAE's
  notification riding the existing ntfy urgent path where available.
- **Svix's multi-signature rotation header.** The Standard Webhooks specification defines
  `webhook-id` / `webhook-timestamp` / `webhook-signature`, and Svix-hosted senders —
  Resend included — emit the same triple as `svix-id` / `svix-timestamp` /
  `svix-signature`. The signature value is `v1,<base64>`, and the header is a
  **space-delimited list** of signatures specifically to support *"zero downtime secret
  rotation"*: during an overlap the delivery carries both `v1,<new>` and `v1,<old>`, so a
  consumer migrates without a coordinated cutover and without a dropped event. This is the
  strongest rotation precedent of the four vendors. Adopted (§7.1, §12.2).
- **Resend's thin envelope and thin catalog as sanity checks.** Resend's payload is
  `type` / `created_at` / `data` — thinner than Stripe's — and its whole catalog is **19
  event types**, of which **11** are in the `email.*` namespace. That is direct evidence
  from a mature commercial email product that a one-event v1 (§5.1) is not embarrassingly
  small, and that a wide catalog is a liability rather than a feature. Resend also has an
  `email.received`, which validates OAE's choice of `mail.received` as the starting point.
- **Manual replay of both outcomes.** Resend documents that *"You can replay both `failed`
  and `succeeded` webhook messages."* Replaying a *successful* delivery is a small idea
  worth stealing: it is how an integrator tests their handler against a real payload
  without waiting for real mail. OAE's equivalent is
  `GET /v1/webhooks/:id/deliveries` plus `POST /v1/webhooks/deliveries/:id/redeliver`
  (§10.3), and §16 Q15 asks whether redelivery of succeeded events should be in v1.

**Refuse:**

- **Svix's binding of the delivery id into the signed string.** Svix signs
  `<id>.<timestamp>.<payload>`. That is necessary for Svix because its message id lives
  only in a header, so an unbound signature could be replayed across deliveries that share
  a timestamp and body. OAE's event `id` is **already inside the signed body** (§6.1), so
  binding it again in the signed string would add nothing; only the timestamp needs
  binding, which is Stripe's shape and what §7.2 adopts. Recorded here because "copy Svix
  exactly" is the obvious suggestion and it is redundant for this payload layout.
- **Svix's base64 signature encoding.** Noted and deliberately declined in §7.2, which
  chooses hex for integrator familiarity. Recorded as an open question (§16, Q13) because
  it is a genuine trade rather than a clear win.
- **Delegating delivery to an external service.** Svix is a vendor. OAE is self-hosted by
  definition (#109: *"self-hosted OAE instances run on public servers by definition"*);
  adding a required third party in the delivery path would invert the product's premise and
  add a trust root the operator does not control.
- **`multipart/form-data` with raw MIME (SendGrid inbound parse).** SendGrid posts the
  parsed message as form data, with an option to post the raw MIME instead. Two refusals:
  JSON is the right body for a metadata-first event, and — see the next point — inbound
  parse is **unsigned**.
- **Unsigned delivery (SendGrid inbound parse).** SendGrid's inbound-parse documentation
  contains no signature, HMAC, or signature header at all; the only trust mechanism is that
  you control the hostname and its MX record, and the URL must be *"accessible from the
  internet"*. That is secrecy-by-obscurity on a public endpoint. #109 states HMAC signing
  is mandatory, and this RFC keeps it mandatory with no unsigned mode (§7).

  **The instructive part is that SendGrid contradicts itself.** Its *outbound* Event
  Webhook **is** signed — with **ECDSA**, via `X-Twilio-Email-Event-Webhook-Signature` and
  `X-Twilio-Email-Event-Webhook-Timestamp`, over a SHA-256 hash of timestamp + raw payload
  bytes. So the same vendor signs its event webhook asymmetrically and leaves its
  inbound-parse webhook unsigned. Two takeaways: unsigned push is a corner-cut, not a
  design position; and **asymmetric webhook signing is already shipping in production at a
  major vendor**, which is the concrete precedent behind §7.6's claim that an Ed25519 `v2=`
  scheme for #59 is additive rather than exotic.
- **Silent discard.** SendGrid retries POSTs that respond with **5XX**, and states that
  messages undeliverable after **3 days** *"will be dropped"* and that *"SendGrid will not
  send a notification before the message is dropped."* Irreversible data loss with no
  signal is the exact failure mode #109 forbids. (SendGrid's docs are internally ambiguous
  about whether a 4XX enters the 3-day retry loop or is dropped immediately; OAE resolves
  this explicitly in §8.2 rather than leaving it undefined.) OAE dead-letters into an
  inspectable log and raises a health signal instead (§8.5, §8.6, §13).

### 4.4 Summary

| Dimension | GitHub | Stripe | Resend / Svix | SendGrid inbound parse | **OAE v1** |
| --- | --- | --- | --- | --- | --- |
| Signature | `X-Hub-Signature-256: sha256=<hex>` over raw body | `Stripe-Signature: t=,v1=<hex>` over `t.body` | `svix-signature: v1,<base64>` over `id.ts.body` | **none** | `X-OAE-Signature: t=,v1=<hex>` over `t.body` |
| Replay defense | none intrinsic | timestamp tolerance (5 min library default) | timestamp tolerance | URL secrecy | timestamp tolerance + `id` dedupe |
| Response timeout | **10 s (published)** | not published ("quickly") | not published | not published | **10 s** |
| Payload | full resource | snapshot + refetch | thin `type`/`created_at`/`data` | raw MIME / form data | **bounded metadata + refetch** |
| Auto-retry | **none** | ~3 days, exponential, live mode; attempt count unpublished | **8 delays published (docs list 6 elsewhere)** | 3 days on 5XX, then drop | **8 attempts / ~27 h 35 min** |
| Manual redelivery | yes, 3-day window | via dashboard | yes; failed **and** succeeded | no | **yes, 30-day log** |
| Ordering | not documented | **explicitly not guaranteed** | not guaranteed (spec) | n/a | **not guaranteed, cursor provided** |
| Rotation | undocumented; dual-emits SHA-1 + SHA-256 | **multiple `v1=` during secret roll** | **space-delimited multi-sig overlap** | n/a | **multi-sig overlap window** |
| Failure visibility | delivery log only | `pending_webhooks` counter | **auto-disable + second notification** | **silent drop, explicitly no notification** | **log + disable + notify + audit** |

The design is Stripe's envelope, timestamp-binding, refetch, and ordering-disclaimer
discipline; Resend's published retry schedule and auto-disable-plus-notify behavior;
Svix's multi-signature rotation; GitHub's operational affordances (typed headers, ping,
manual redelivery) and its 10-second timeout; and OAE's own payload-bounding and SSRF
machinery. The two deliberate divergences from all four vendors are **automatic retry**
(where GitHub does nothing and SendGrid drops silently) and **structural payload bounding**
(where only Resend is comparably thin, and none of them bound by policy rather than by
taste).

---

## 5. Event catalog

### 5.1 v1 catalog

Exactly one event type is emitted in v1:

| Type | Trigger | Emitted from |
| --- | --- | --- |
| `mail.received` | a new message becomes visible in the catch-all inbox and is attributable to at least one identity | the inbound-mail event loop (§11.4), once per new UID |
| `webhook.ping` | operator requests endpoint validation | `POST /v1/webhooks/:id/test`, and optionally at creation (§16, Q12) |

`webhook.ping` is not a domain event; it carries no mail data and exists only to prove
reachability and signature correctness. It is delivered with the same signing, retry, and
logging machinery, but with a reduced retry budget (§8.3) — there is no point retrying a
connectivity test for a day.

**Emission granularity.** One event per (message, address) pair, not one per message.
A message delivered to two identities on the instance produces two events, each scoped to
one address, because subscriptions are address-scoped (§10.4) and a consumer must never
receive metadata about a mailbox it did not subscribe to. This mirrors how
`messageAccessibleToAddress()` already scopes reads.

### 5.2 Reserved names

These are reserved so that emitting them later is additive and cannot collide. Reserving
a name costs nothing and prevents a future breaking rename.

| Reserved type | Future trigger | Note |
| --- | --- | --- |
| `mail.sent` | a message leaves via `POST /v1/send` | needs a send-path hook, not the IMAP loop |
| `task.created` / `task.updated` / `task.completed` / `task.failed` | task state events | the task state machine already writes stamped events to IMAP threads |
| `approval.requested` / `approval.decided` / `approval.expired` | approval lifecycle | `approval.expired` has no emitter today; expiry is evaluated lazily on read, so this event requires a reaper |
| `task.lease.claimed` / `renewed` / `released` / `expired` | lease lifecycle | gated on `TASK_LEASES_ENABLED` |

`approval.requested` is called out in #109 as the highest-value human-in-the-loop case
(push to ntfy/Telegram the moment an approval is needed). It is *not* in v1 because it
requires emitting from the task path as well as the mail path, and v1 proves the delivery
machinery on one event type first. Whether to pull it forward is §16, Q1.

### 5.3 Catalog evolution rules

1. Type names are `domain.action`, lower-case, dot-separated, and **both segments are
   single words**: no underscores, no hyphens, no camelCase. Resend's catalog contains
   `email.delivery_delayed` alongside `email.delivered` and `email.bounced` (§4.3) — an
   underscore inside a dot-separated namespace, in a mature commercial product. It is a
   small thing that cannot be undone once integrators have string-matched on it, so the
   rule is written down before the second event type exists rather than after. Reserved
   names in §5.2 already comply; if a future action genuinely needs two words, it gets two
   dots (`task.lease.claimed`) rather than an underscore.
2. **New types are always additive.** Emitting a type that did not exist before is never a
   breaking change, given rule 3.
3. **Consumers must ignore event types they do not recognize.** This is a normative
   requirement on consumers, documented prominently, and it is what makes §5.2 safe.
4. Fields may be added to `data` at any time. Fields may not be removed, renamed, or
   change type within a payload version; that requires a new payload version (§7.6).
5. A subscription declares the types it wants. An unrecognized type in a subscription
   request is rejected at creation (`400 {error:'unknown_event_type'}`) rather than
   silently stored — otherwise a typo produces a subscription that never fires, which is
   the worst possible failure mode for a push system. The set of acceptable types is
   itself versioned, so this check loosens as the catalog grows.

---

## 6. Payload schema

### 6.1 Envelope

Every delivery body is a single JSON object:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `evt_` + UUIDv4. Globally unique per event. **The consumer's dedupe key.** The same `id` may be delivered more than once (§8.1). |
| `type` | string | Event type (§5). |
| `payloadVersion` | string | `"v1"`. Bumped only on a breaking change (§7.6). |
| `createdAt` | string | RFC 3339 UTC, millisecond precision. When OAE created the event, *not* when the mail arrived. |
| `domain` | string | The emitting instance's `config.domain`. Lets one consumer disambiguate multiple OAE instances. |
| `data` | object | Type-specific payload (§6.2). |

Event ids follow the repository's existing UUID convention (`lib/task-id.ts` validates
UUID v1–5) rather than introducing a sortable-id scheme. Sortability is deliberately not
relied upon: ordering is reconstructed from `data.cursor` (§8.4). Whether to move to
UUIDv7/ULID is §16, Q13.

### 6.2 `mail.received` data object

| Field | Type | Scope | Meaning |
| --- | --- | --- | --- |
| `object` | `"mail"` | metadata | Stripe-style discriminator, so `data` is self-describing. |
| `address` | string | metadata | The mailbox this event is scoped to. Always a single address (§5.1). |
| `messageId` | string | metadata | OAE message id, usable directly against `GET /v1/messages/:id`. |
| `cursor` | string | metadata | Signed `mail-cursor-v1` token (§3.7) for this message. Address-bound and unforgeable. Consumable as a pagination token once `GET /v1/messages` is extended to accept one (§3.7, §15). |
| `receivedAt` | string | metadata | RFC 3339 UTC arrival time. |
| `from` | `{address, name}` | metadata | Sender. |
| `to` | `string[]` | metadata | Recipient addresses as delivered. |
| `cc` | `string[]` | metadata | CC addresses as delivered. |
| `subject` | string | metadata | **Truncated** to `WEBHOOK_META_FIELD_MAX_BYTES`. |
| `sizeBytes` | integer | metadata | RFC822 size. |
| `hasAttachments` | boolean | metadata | Attachment presence, not content. |
| `unread` | boolean | metadata | `\Seen` flag state at emission. |
| `containsSecurityCode` | boolean | metadata | An OTP/verification code was detected. **Presence only, never the value** at this scope. |
| `containsLink` | boolean | metadata | A verification-style link was detected. Presence only. |
| `textPreview` | string | `preview` | Body preview, ≤ `WEBHOOK_BODY_PREVIEW_CHARS`. |
| `securityCodes` | `string[]` | `preview` | ≤ `WEBHOOK_MAX_CODE_ITEMS` entries, each ≤ `WEBHOOK_CODE_ENTRY_CHARS`. |
| `links` | `string[]` | `preview` | Same bounds. |

The `containsSecurityCode` / `containsLink` booleans at metadata scope are a direct lift
from push tier 1, which already communicates *"(contains OTP or verification link)"*
without the value. They are the most valuable two bytes in the payload for the flagship
use case in #109 — waking a postmaster agent only for mail that actually needs action —
and they leak almost nothing.

### 6.3 Example delivery

Request:

```http
POST /hooks/oae HTTP/1.1
Host: consumer.example.com
Content-Type: application/json
User-Agent: openagentemail-webhooks/1
X-OAE-Event: mail.received
X-OAE-Delivery: dlv_6f1c1c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f
X-OAE-Signature: t=1788400000,v1=8c1f…a92f,v1=1d47…b03c
Content-Length: 612
```

Body:

```json
{
  "id": "evt_2b0e6a18-9f3c-4d21-b6a4-7c8d5e0f1a23",
  "type": "mail.received",
  "payloadVersion": "v1",
  "createdAt": "2026-09-03T12:26:40.412Z",
  "domain": "openagent.email",
  "data": {
    "object": "mail",
    "address": "postmaster@openagent.email",
    "messageId": "9d4c2a71-3b8e-4f60-a1c5-2e7b9d04f6a8",
    "cursor": "mail-cursor-v1.Zm9sZGVy…",
    "receivedAt": "2026-09-03T12:26:39.000Z",
    "from": { "address": "no-reply@bank.example", "name": "Bank Example" },
    "to": ["postmaster@openagent.email"],
    "cc": [],
    "subject": "Your verification code",
    "sizeBytes": 18432,
    "hasAttachments": false,
    "unread": true,
    "containsSecurityCode": true,
    "containsLink": false
  }
}
```

The same delivery with `contentScope: "preview"` adds:

```json
{
  "textPreview": "Use code 483920 to complete your verification. This code expires in 10 minutes…",
  "securityCodes": ["483920"],
  "links": []
}
```

Expected consumer response: any `2xx`. OAE reads at most
`WEBHOOK_RESPONSE_MAX_BYTES` of the response body and discards it; the response body has
no defined meaning and must not be relied upon by either side.

### 6.4 Content scope and bounding

Two scopes, per subscription:

| Scope | Who may set it | Contents |
| --- | --- | --- |
| `metadata` (**default**) | admin or the address's own identity token | envelope + metadata fields only |
| `preview` | **admin only** | metadata + `textPreview` + `securityCodes` + `links` |

Three reasons the bounding is structural rather than a truncation pass:

1. **A webhook never carries a full mail body.** Even `preview` scope carries a bounded
   preview. Full content requires `GET /v1/messages/:id` with the consumer's own API
   credentials. This is Stripe's refetch pattern, and it means the signing secret is not
   a content credential (§4.2).
2. **`preview` is admin-only**, mirroring the existing rule that push tier 3 is set only
   by an admin (`setIdentityPushContentTier()`, `identities.ts:396`). A compromised
   identity token can therefore subscribe to metadata about its own mailbox — which it can
   already read via the API — but **cannot** open a content-exfiltration channel to an
   arbitrary external host. That distinction is the whole security argument for scopes.
3. **Bounds reuse the push-tier constants' shape, not their values.** The ntfy caps
   (3500 bytes total, 280-char preview) exist because a phone-push relay is the
   bottleneck. A webhook's bottleneck is OAE's own egress and the JSONL log, so the caps
   are relaxed but still explicit (§6.5). The *helpers* — `truncateUtf8Bytes()`,
   `boundPreviewChars()` — are reused so truncation stays UTF-8-safe.

**Deliberately not reused: `pushContentTier` itself.** Webhook scope is a separate
setting. Coupling them would mean that enabling webhooks for an agent changes what lands
on the owner's phone lock screen, and the two have genuinely different threat models —
ntfy traverses a third-party relay to a lock screen; a webhook goes to an HTTPS endpoint
the operator chose. Cross-wiring them would be a configuration footgun with a privacy
cost.

**Sensitive marking.** Deliveries at `preview` scope are marked `sensitive: true` in the
delivery log, following the tier-3 precedent (`notification-watcher.ts` sets
`sensitive` on log rows). Sensitive deliveries additionally never write any payload
fragment to the log (§8.6).

### 6.5 Size limits

| Constant | Proposed default | Rationale |
| --- | --- | --- |
| `WEBHOOK_PAYLOAD_MAX_BYTES` | 16384 | 4× the ntfy cap; no relay bottleneck, but bounded so the delivery log and retry queue stay cheap. Trivially below `JSON_BODY_LIMIT_BYTES` (16 MiB, `limits.ts:5`). |
| `WEBHOOK_META_FIELD_MAX_BYTES` | 400 | Same as `PUSH_META_FIELD_MAX_BYTES`; subjects are short and 400 bytes is generous. |
| `WEBHOOK_BODY_PREVIEW_CHARS` | 280 | Same as `PUSH_BODY_PREVIEW_CHARS`; a proven preview length. |
| `WEBHOOK_MAX_CODE_ITEMS` | 5 | Same as `PUSH_OTP_ITEM_MAX`. |
| `WEBHOOK_CODE_ENTRY_CHARS` | 200 | Same as `PUSH_OTP_ENTRY_CHARS`. |
| `WEBHOOK_RESPONSE_MAX_BYTES` | 4096 | Mirrors `CIMD_MAX_BYTES` (5 KiB) and `NTFY_REQUEST_MAX_BYTES`. OAE needs only the status code; an unbounded response read is an amplification vector. |

Overflow behavior: if a payload still exceeds `WEBHOOK_PAYLOAD_MAX_BYTES` after field
truncation, the delivery proceeds with fields dropped in a **defined order**, never by
truncating mid-JSON. The order is stated per scope, because the preview-only fields do not
exist at `metadata` scope:

- `preview` scope: `links` → `securityCodes` → `textPreview`, then continue as below.
- both scopes: `cc` → `to` → `subject`.
- **never dropped:** `id`, `type`, `payloadVersion`, `createdAt`, `domain`,
  `data.object`, `data.address`, `data.messageId`, `data.cursor`, `data.receivedAt`,
  `data.from`, and the two `contains…` booleans.

The never-dropped set is exactly what a consumer needs to dedupe, order, and re-fetch, so a
payload degraded by overflow is still actionable — it just carries less description. This
mirrors ntfy's existing ordered-overflow approach (`notify.ts:895-932`) and is stated
normatively because an integrator needs to know which fields can vanish. If dropping every
droppable field still does not fit, the delivery fails closed rather than being sent
malformed.

---

## 7. Signature and verification

Consumer-facing documentation **must present this section first**, before the payload
schema. #109 requires it and it is the correct order: an integrator who cannot verify a
signature should not be reading payload fields yet.

### 7.1 Headers

| Header | Value | Purpose |
| --- | --- | --- |
| `X-OAE-Event` | `mail.received` | Route before parsing (GitHub). |
| `X-OAE-Delivery` | `dlv_` + UUIDv4 | One **attempt**. Distinct from `id`, which is per **event**. Support and redelivery vocabulary. |
| `X-OAE-Signature` | `t=<unix-seconds>,v1=<hex>[,v1=<hex>]` | Timestamp + one or more signatures. Uniformly comma-delimited (Stripe's grammar); `v1` may repeat during rotation. |
| `User-Agent` | `openagentemail-webhooks/1` | Egress identification; lets a consumer's WAF allowlist OAE. |
| `Content-Type` | `application/json` | Always. |

`X-OAE-Delivery` changes on every retry attempt; `id` in the body does not. Consumers
dedupe on `id`, and use `X-OAE-Delivery` only when asking OAE's operator or logs about a
specific attempt.

### 7.2 Signed string (normative)

```
signedPayload = t + "." + rawRequestBody
signature     = lower-case hex HMAC-SHA256(endpointSigningKey, signedPayload)
headerValue   = "t=" + t + ",v1=" + signature        (append ",v1=" + signature per extra key)
```

where `t` is the Unix timestamp in **whole seconds** at signature construction time, and
`rawRequestBody` is the exact UTF-8 byte sequence placed on the wire.

The header is a comma-delimited list of `key=value` pairs in which `t` appears exactly once
and first, and `v1` appears one or more times. Splitting on `,` and then on the first `=`
is a complete parser; there is no second delimiter and no nesting. Unknown keys must be
ignored rather than rejected, which is what lets `v2=` be added later (§7.6).

The `t + "." + body` construction is unambiguous without length prefixes because `t` is a
fixed-format non-negative integer, so the first `.` in the signed string is always the
separator. If OAE ever signs a multi-field tuple with free-form text in a leading field,
it must adopt the `mail-body-v2` length-prefix construction (`mail-stamp.ts:79`) instead.
That alternative is recorded here so the choice is deliberate rather than accidental.

**Encoding: lower-case hex, not base64url.** This is a conscious deviation from the
repository's stamp convention (`taskStamp`, `mail-stamp`, `mail-cursor` all use
base64url). The reason is that those are verified by OAE's own code, whereas a webhook
signature is verified by third parties whose existing snippets, libraries, and stack
overflow answers all assume hex — GitHub uses `sha256=<hex>`, Stripe uses `v1=<hex>`.
Internal consistency is worth less than integrator familiarity at a public boundary.
Flagged for ratification as §16, Q13.

### 7.3 Verification procedure

Documented as an ordered procedure, with the failure mode of skipping each step:

1. **Read the raw body bytes.** Verify against the bytes as received. Re-serializing a
   parsed JSON object will produce different bytes (key order, whitespace, escaping,
   number spelling) and verification will fail. This is the single most common webhook
   integration bug and it is why this section precedes the schema.
2. **Extract `t` and every `v1=` value** from `X-OAE-Signature`. Multiple signatures are
   allowed and **all** must be tried; success on any one is success (§12.2).
3. **Check the timestamp.** Reject if `abs(now - t) > WEBHOOK_TIMESTAMP_TOLERANCE_SEC`
   (default 300). Skipping this step removes replay protection entirely, because the
   signature alone is valid forever.
4. **Recompute** `HMAC-SHA256(key, t + "." + rawBody)` for each candidate signature and
   compare in **constant time** with an equal-length guard, as `mail-stamp.ts:115` does.
   A non-constant-time comparison leaks the digest byte-by-byte over the network.
5. **Fail closed.** Any error — missing header, malformed header, unknown prefix,
   timestamp skew, no matching signature — rejects the delivery. There is no
   unsigned or warn-only mode.
6. **Dedupe on `id`**, then process. At-least-once means duplicates are normal (§8.1).

Operators can verify an endpoint by hand:

```sh
# Illustrative manual check — not a reference implementation.
printf '%s.%s' "$T" "$RAW_BODY" \
  | openssl dgst -sha256 -hmac "$ENDPOINT_SECRET" -hex
```

### 7.4 Replay protection

Two independent layers, because a webhook endpoint is a public URL:

- **Timestamp tolerance** (§7.3 step 3) bounds the useful lifetime of a captured delivery
  to 300 s. This is stateless — it costs OAE nothing and requires no nonce store, which
  matters because there is no database.
- **Idempotency on `id`** on the consumer side, which also handles legitimate duplicate
  delivery from retries.

A captured delivery replayed *within* the tolerance window to the *same* endpoint is not
defended against, and cannot be cheaply: the attacker would already need the endpoint's
secret-bearing channel. This limitation is stated rather than papered over, because the
alternative (server-side nonces) requires durable state OAE does not have.

### 7.5 Why not canonical JSON

`approvalActionDigest` signs a canonicalized JSON form (`docs/approval-digest.md`):
recursively sorted keys by UTF-16 code unit, `JSON.stringify` escaping and number
spelling, no whitespace, `-0` normalized to `0`. That machinery exists because **two
independent implementations must produce identical bytes** — an approval decision is
hashed by the API and re-hashed by a verifier that never saw the original serialization,
and the repo ships committed interop vectors checked by an independent Python verifier.

Webhooks have the opposite shape: **one producer, many verifiers, and the verifier sees
the exact bytes on the wire.** No canonicalization is needed, and adopting it would be
actively harmful — it would oblige every third-party consumer in every language to
reimplement ECMA-262 number spelling and UTF-16 key ordering correctly, which is exactly
the portability trap `docs/approval-digest.md` has to spend four paragraphs warning
about. Signing the transmitted bytes removes that entire class of integration failure.

Recorded here because "reuse the existing canonical JSON" is the obvious-looking suggestion
and it is wrong for this use case.

### 7.6 Versioning

- `payloadVersion` in the body tracks the **schema**; the `v1=` prefix in the header
  tracks the **signature scheme**. They are versioned independently because they break
  independently.
- Additive schema changes do not bump `payloadVersion`.
- A new signature scheme (e.g. Ed25519 for #59 federation) adds `v2=` **alongside**
  `v1=` during an overlap window; the header format already permits multiple entries.
- **Both halves of this are proven in production elsewhere.** Stripe's header still carries
  a legacy `v0=` next to `v1=` (§4.2), which is direct evidence that a versioned prefix
  lets two schemes coexist for years without breaking consumers. And SendGrid's outbound
  Event Webhook signs with **ECDSA** over timestamp + raw payload bytes (§4.3), so
  asymmetric webhook signing is a shipping commercial practice, not an exotic design OAE
  would be pioneering.
- **Forward compatibility with #59 is the reason for the prefix.** Federation needs
  asymmetric signatures with key ids and `.well-known` discovery. An asymmetric scheme
  slots into the same header as `v2=<kid>.<sig>` without changing the envelope, the
  timestamp binding, or any consumer's routing logic. Nothing in v1 needs to be undone to
  get there. That is the only federation-related commitment in this RFC, and it is free.

---

## 8. Delivery semantics

### 8.1 At-least-once

Every guarantee OAE makes, stated plainly so it can be quoted in user docs:

- A delivery that returns `2xx` within the timeout is **successful** and is not retried.
- An event may be delivered **more than once**. Retries, process restarts, and
  `UIDVALIDITY` re-anchoring (§3.1) can each cause duplicates.
- An event may be delivered **out of order** (§8.4).
- An event may be **not delivered at all** if the endpoint fails for longer than the
  retry budget, or if the process is stopped before the queue drains. This is recorded in
  the delivery log as a dead letter (§8.6) and surfaced (§13) — it is never silent.

**Consumers must be idempotent on `id`.** This is a normative consumer requirement, not a
suggestion, and it belongs in the first paragraph of the user-facing docs.

### 8.2 Outcome classification

| Outcome | Condition | Retried? |
| --- | --- | --- |
| success | any `2xx` within `WEBHOOK_DELIVERY_TIMEOUT_MS` | no |
| retryable | connection error, DNS failure at delivery time, timeout, `5xx`, `408`, `429` | yes |
| permanent | any other `4xx`, **or any `3xx`** (redirects are never followed, §9.4) | **no** — dead-letter immediately |
| refused | SSRF policy violation resolved at delivery time (§9.3) | **no** — dead-letter + disable endpoint |

`429` honours a consumer's `Retry-After` header when it is a sane integer
(1 s … 1 h), clamped into the schedule; otherwise the normal backoff applies. Honoring
`Retry-After` is cheap politeness that materially reduces load on a rate-limited
consumer.

`refused` is its own outcome rather than a variant of `permanent` because it has a
different operator meaning: the endpoint is not broken, it is **disallowed**, and retrying
would mean OAE repeatedly attempting a blocked connection to an internal address. That
must stop immediately and loudly (§9).

### 8.3 Retry schedule

Eight attempts, adopting the schedule Resend publishes (§4.3) because it is the only
enumerated, bounded, email-domain schedule among the vendors surveyed:

| Attempt | Delay before this attempt | Cumulative from first attempt |
| --- | --- | --- |
| 1 | immediate | 0 |
| 2 | 5 s | ~5 s |
| 3 | 5 min | ~5 min |
| 4 | 30 min | ~35 min |
| 5 | 2 h | ~2 h 35 min |
| 6 | 5 h | ~7 h 35 min |
| 7 | 10 h | ~17 h 35 min |
| 8 | 10 h | **~27 h 35 min** |

**The values above are inter-attempt delays, stated normatively.** Resend publishes neither
a single consistent list (its two pages give eight delays and six — §4.3) nor whether its
numbers are delays between attempts or offsets from the first, and the difference moves the
total span by hours. OAE specifies delays, publishes the resulting worst-case span of
~27 h 35 min, and does not inherit either ambiguity — an integrator planning a catch-up job
needs the real number.

The shape is what matters and it is doing two different jobs:

- **Attempts 1–4 (first ~35 minutes) serve perishability.** An OTP or verification link is
  acted on within minutes; four attempts inside half an hour means a transient consumer
  error, a deploy, or a single bad response never costs the agent the mail.
- **Attempts 5–8 (out to ~27 hours) serve availability.** They cover an overnight outage,
  a weekend, or a consumer host that is down for hours. Nothing in that tail is urgent, so
  spacing it widely costs nothing and keeps egress low.

After attempt 8 the event is dead-lettered (§8.6) and counts toward the circuit breaker
(§8.5). Jitter is **full** (`uniform(0, delay)`) rather than decorrelated, because many
subscribers on one instance fail simultaneously when a popular consumer or a shared hosting
provider has an outage, and correlated retries would arrive as a thundering herd on an
already-struggling endpoint.

`WEBHOOK_MAX_ATTEMPTS` (default 8, minimum 1) **truncates this table**; there is no base or
multiplier knob, because a fixed published schedule is easier for an integrator to reason
about than a formula. `WEBHOOK_MAX_ATTEMPTS=1` gives fire-and-forget for operators who want
it, and `=4` gives the perishability-only half.

`webhook.ping` uses attempts 1–3 only (~5 minutes). A connectivity test that takes a day to
report failure is useless as a test.

**Why ~27 hours and not Stripe's or SendGrid's 3 days.** Argued in §4.2: the durable store
is a JSONL file rather than a database, so the queue horizon is a real cost, and the
marginal value of a ninth attempt on day three is near zero for mail. A day-and-a-bit also
keeps the dead-letter window inside the operator's normal review cycle. **Why not the
watcher's existing 10 minutes** (`SERVICE_FAILURE_MAX_MS`, `notification-watcher.ts:50`):
a webhook consumer is an external party that may be mid-deploy, and 10 minutes covers
neither a routine rollout nor a laptop lid closing. **Why not GitHub's model** (no automatic
retry at all, §4.1): a failed delivery nobody retries is a silently dropped mail event,
which is precisely what #109 forbids.

### 8.4 Ordering: not guaranteed

**OAE makes no ordering guarantee, and this RFC recommends against attempting one.** The
reasons are structural, not implementation laziness:

- Retries reorder by construction. An event that fails once and succeeds at attempt 3
  arrives after events emitted later that succeeded at attempt 1.
- Deliveries to different endpoints are independent, and deliveries to one endpoint are
  capped at concurrency 1 (§8.7) but still interleave with retries.
- The event source's UID watermark is re-anchored when `UIDVALIDITY` changes
  (§3.1), which can produce gaps or repeats independent of delivery.

What OAE provides instead, so a consumer that *needs* order can establish it:

1. **`data.cursor`** — the signed `mail-cursor-v1` token, whose sort key is
   `(receivedAtMs desc, uid desc)` per address (`mail-cursor.ts:22`). This is the
   authoritative per-address ordering, and it is the same ordering the list API uses.
2. **`data.receivedAt`** — arrival time, for coarse ordering without decoding a cursor.
3. **`createdAt`** — emission time, useful only for latency measurement, **not** for
   ordering mail.

A consumer requiring strict order should treat webhooks as a *wakeup signal* and read
authoritative state through the list API, which is ordered and paginated at the IMAP layer.
That pattern — push to wake, pull to read — is the recommended integration shape, and it is
also what makes the payload bounding in §6.4 acceptable. It does depend on the prerequisite
in §3.7: exposing `cursor` / `nextCursor` on `GET /v1/messages`. Until that lands, the
bearer list API returns only the newest N messages with no resume token, and a consumer
catching up after an outage has no cursor to catch up *from*.

### 8.5 Circuit breaker

Per endpoint. The live counter is in memory; `state`, `disabledReason`, and
`consecutiveFailures` are persisted in `webhooks.json` (§10.5) so a restart cannot silently
reset a disabled endpoint back to enabled, and every attempt that contributed to the count
is individually recorded in the delivery log (§8.6):

- After `WEBHOOK_DISABLE_THRESHOLD` (default 20) consecutive non-successful deliveries,
  the endpoint transitions to `state: "disabled"` with a `disabledReason`.
- While disabled, OAE makes **no** delivery attempts. New events for that endpoint are
  dead-lettered immediately rather than queued, so a dead endpoint cannot accumulate an
  unbounded backlog.
- Disablement is written to the audit log, exposed on `GET /v1/webhooks/:id`, and — where
  ntfy is enabled — pushed to the operator as an urgent notification through the existing
  notify path. That last step is best-effort and must not itself block or throw.
- Re-enable is **manual**: `POST /v1/webhooks/:id/enable`, which resets the counter and
  optionally fires a `webhook.ping`.

Manual rather than automatic re-enable is a deliberate choice. None of the vendors surveyed
documents automatic recovery: Resend documents auto-*disablement* plus a second
notification (§4.3) but says nothing about re-enabling, and Stripe documents neither.
Silently resuming delivery would hide the fact that a window of events was dropped. The
operator should have to look. The dropped window is inspectable (§8.6), and the cursor in
the last successful delivery tells the consumer exactly where to resume.

### 8.6 Persistence

OAE has no database, so the durable design must be a file, and the repository already has
a proven shape for one.

**`DATA_DIR/webhook-deliveries.jsonl`** — append-only, 0600 in a 0700 directory, single
writer, atomic `.tmp` + rename for compaction, fsync of file and directory, corrupt file
fails closed. These are exactly the conventions of `notification-log.jsonl`,
`audit.jsonl`, and `notification-devices.json` (§3.5, §3.6) and are not re-litigated here.

Each row records one delivery attempt:

```json
{
  "ts": "2026-09-03T12:26:41.018Z",
  "webhookId": "whk_4a1b…",
  "eventId": "evt_2b0e…",
  "deliveryId": "dlv_6f1c…",
  "type": "mail.received",
  "address": "postmaster@openagent.email",
  "messageId": "9d4c2a71-3b8e-4f60-a1c5-2e7b9d04f6a8",
  "attempt": 2,
  "outcome": "retryable",
  "status": 503,
  "durationMs": 412,
  "sensitive": false,
  "nextAttemptAt": "2026-09-03T12:36:41.018Z"
}
```

`messageId` is the one field that makes the log *operational* rather than merely
historical: without it, neither boot-time reconstruction nor manual redelivery (§10.3) has
anything to send, because the payload is deliberately not stored. It is an identifier, not
content, so including it does not weaken the no-payload rule below — the same distinction
`audit.ts` draws when it allows `address` but forbids subjects and bodies.

Rules:

- Retention `WEBHOOK_LOG_RETENTION_DAYS` (default 30), matching
  `NOTIFICATION_LOG_RETENTION_MS` and `RETENTION_DAYS`. Daily and boot-time compaction.
- **No payload content is ever written**, and no URL query string. The row carries the
  event id, type, address, and outcome — the same field-whitelist discipline
  `audit.ts:38-50` applies, extended with delivery-specific fields. `sensitive: true`
  rows write nothing beyond that. This keeps the log safe to expose through an
  inspection API and safe to ship to a log aggregator.
- The file doubles as the **dead-letter store**: a row with `outcome: "permanent"` or
  `"refused"`, or `attempt == WEBHOOK_MAX_ATTEMPTS` without success, *is* the dead
  letter. One artifact, two purposes, no separate queue file.

**Restart behavior, stated honestly:**

- Subscription configuration survives restart (it is in `webhooks.json`, §10.5).
- The delivery log survives restart, so the dead-letter record is durable and inspectable.
- **Pending retries are reconstructed from the log at boot** by reading rows with a
  `nextAttemptAt` in the future and no later successful row for the same
  **`(webhookId, eventId)` pair**. The pair matters: one event fans out to N endpoints
  (§5.1), so keying on `eventId` alone would let a success for endpoint A silently cancel
  endpoint B's outstanding retries.
- **Reconstruction re-builds the payload; it does not replay stored bytes.** No payload is
  ever written (§8.6 rules below), so boot recovery re-fetches the message from IMAP by
  `messageId`, re-serializes it at the subscription's current `contentScope`, and delivers
  it under the **original** `eventId` — preserving the consumer's dedupe key across a
  restart. If the message is gone (retention, manual deletion), the delivery is
  dead-lettered with outcome `permanent` rather than resurrected or silently dropped.
  A consequence worth stating: a rebuilt payload may differ from the original if the
  subscription's scope or the bounding constants changed while the process was down. That
  is correct behavior — the consumer sees current policy — but it is another reason
  consumers must treat the payload as a snapshot and re-fetch (§4.2).
- Events emitted while the process was **down** are not reconstructed in v1. The UID
  watermark persists, so whether a restart re-emits or skips depends on watermark
  durability, which the watcher already owns. Making post-restart catch-up authoritative
  (re-walk the mailbox from the last successfully delivered cursor and re-emit) is
  possible and is §16, Q5 — it is the strongest argument for the cursor being in the
  payload.

### 8.7 Concurrency and rate limits

Reuse `slidingWindowCheck()` (`ratelimit.ts:26`) and the wait-slot pattern
(`ratelimit.ts:205-206`) rather than adding a new primitive:

| Limit | Proposed default | Reason |
| --- | --- | --- |
| concurrent deliveries, per endpoint | 1 | Preserves per-endpoint attempt order, and stops one slow consumer from consuming the pool. |
| concurrent deliveries, instance-wide | `WEBHOOK_MAX_CONCURRENT = 8` | Mirrors `MAX_WAITS_TOTAL = 8`. A webhook pool must not be able to starve `mail_wait_for`, so these are **separate** pools (§11.3). |
| delivery attempts per endpoint per minute | `WEBHOOK_RATE_DELIVER_PER_MIN` = 60 | Bounds a hot mailbox pointed at a slow endpoint. |
| subscription creates per token per minute | 10 | Bounds endpoint-churn abuse. |
| subscriptions per instance | `WEBHOOK_MAX_SUBSCRIPTIONS = 16` | Small by design; a mailbox does not need 200 callbacks. |
| subscriptions per address | 4 | Allows fan-out (agent + archiver + ntfy bridge) without unbounded growth. |

All numeric limits follow the repo's `0 = disabled` convention.

Because limits are in-memory sliding windows they reset on restart — consistent with
every other limit in the codebase, and acceptable here because the consequence of a reset
is a brief over-delivery, not a correctness failure.

---

## 9. SSRF and egress safety

This is the section where a webhook feature can turn a mail server into an attack
platform. A subscription URL is a **user-supplied instruction to make the server open a
TCP connection to an arbitrary host**, and the person supplying it may hold only an
identity-scoped token.

### 9.1 Reuse the shared policy — this is a mandate, not a preference

`lib/net.ts:1` states that it is the single shared implementation for private-network and
SSRF decisions and that **copying another one is forbidden** (translated from the Chinese
source comment). Webhook egress therefore goes through `isBlockedSsrfIp()` /
`isSsrfBlockedResolvedIp()`, and the fetcher follows the `pinnedCimdFetcher()` pattern
(§3.2).

**But "reuse it" is not sufficient, and getting this wrong silently reopens the exact hole
§9.6 describes.** The private-network allowance in `isSsrfBlockedResolvedIp()` is
**opt-out, not opt-in**: an address in RFC1918 / CGNAT / loopback / ULA is *permitted*
unless `publicEdge` is set, and `OAE_PUBLIC_EDGE` defaults to `'false'` (`config.ts:214`,
`net.ts:225-241`). On a stock deployment, calling the shared policy without arguments would
therefore allow a subscription aimed at `http://ntfy` — a compose-internal address — **even
with `WEBHOOK_ALLOW_PRIVATE_TARGETS=false`**.

So the rule is normative and specific:

> Webhook delivery and webhook URL validation must call the shared policy with
> `publicEdge` set to **`!webhookAllowPrivateTargets || config.oaePublicEdge`** — that is,
> the webhook-specific escape hatch, OR-ed with the global public-edge setting so that the
> stricter of the two always wins.

`isSsrfBlockedResolvedIp()` already takes an `opts` parameter for exactly this, so no new
primitive is needed; what is needed is the discipline to pass it. A test asserting this
composition is §14 item 2, and it is the highest-value security test in the feature.

**Refactor scope, stated accurately.** `pinnedCimdFetcher()` (`oauth-cimd.ts:363`) is raw
Node `http`/`https` with the connect-time `lookup` hook and a capped streaming body read
(`CIMD_MAX_BYTES`, `oauth-cimd.ts:34`, `:450`); it never follows redirects because it never
asks the agent to. The `redirect: 'manual'` setting and the `redirect_forbidden` rejection
live one layer up, in the CIMD *document-fetch wrapper* (`oauth-cimd.ts:520`, `:526`,
`:543`), as does the pre-flight `assertClientIdHostSafe()` (`oauth-cimd.ts:150`) — which its
own comment marks as **for pre-flight and tests only**, with production required to use the
pinned fetcher's connect-time lookup (`oauth-cimd.ts:147`, translated). That warning is the
same point §9.3 makes, already written down in this repo.

The consequence for phasing: generalizing the *fetcher* alone does **not** carry redirect
refusal or pre-flight validation along, because those are not in it. PR 1 (§15) must
extract the fetcher **and** promote the wrapper's redirect refusal into shared policy, or
webhooks will inherit pinning without inheriting redirect safety.

### 9.2 Always refused

Regardless of any configuration, including the private-deployment escape hatch:

- `169.254.0.0/16` (link-local, and the cloud metadata endpoint `169.254.169.254`)
- `0.0.0.0/8`
- `fe80::/10`
- `fd00:ec2::/16` (AWS IMDS over IPv6)
- IPv4-mapped IPv6 forms of all of the above (`::ffff:169.254.1.1`)
- multicast, `::`, and other special-use space

These are exactly the ranges `net.ts:6-7` and `net.ts:205` already treat as
never-allowed, and the reason they matter more for webhooks than for CIMD is that CIMD
URLs come from an OAuth client's own metadata while **webhook URLs come from anyone
holding a token**.

**A residual gap worth closing while we are here.** The shared policy handles IPv4-mapped
IPv6 (`::ffff:169.254.1.1`) but not the other IPv6 forms that embed an IPv4 address:
NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), and Teredo. On a DNS64 host, a name whose A
record would be `169.254.169.254` can resolve to `64:ff9b::a9fe:a9fe`, which the current
policy would treat as an ordinary public address. This is a pre-existing gap rather than
one this RFC introduces, but webhooks are the first feature that lets an arbitrary token
holder aim the server at an arbitrary name, so §14 item 2 tests these forms and §16 Q16
asks whether closing them belongs in PR 1 or in a separate hardening card.

### 9.3 Validation at both ends — the DNS rebinding defense

Validating a URL only at subscription-creation time is the classic rebinding mistake: the
attacker registers `https://hook.example` pointing at a public IP, then changes the DNS
record to `169.254.169.254` before the first delivery.

Therefore:

1. **At creation**, validate the URL statically (§9.5) and resolve the hostname, checking
   every returned A/AAAA record against the policy. Reject before persisting.
2. **At every delivery attempt**, re-validate. Not just at process start, not just at
   creation — every attempt, because DNS records and TTLs are attacker-controlled.
3. **Pin the validated address for the duration of the connection.** Use the
   `pinnedCimdFetcher` technique: a custom `lookup` hook that re-checks each resolved
   address at connect time (`oauth-cimd.ts:406-444`). This closes the
   resolve-then-connect TOCTOU gap, which is the part most webhook implementations get
   wrong even when they do re-validate.
4. If any resolved address is blocked, the outcome is `refused` (§8.2): no connection
   attempt, immediate dead letter, endpoint disabled, audit event.

### 9.4 Redirects

`redirect: 'manual'`, never follow — the existing `redirect_forbidden` behavior of the CIMD
document-fetch wrapper (`oauth-cimd.ts:526`, `:543`), promoted into shared policy per §9.1.
A 3xx response is a **permanent** failure (§8.2).

Following a redirect re-enters DNS resolution on a new host that was never validated,
which is a complete bypass of §9.3 in one hop. It also lets a public endpoint bounce OAE
into the internal network. If redirect support is ever added, each hop must be
independently re-validated and re-pinned, and the hop count bounded; that is a separate
design decision, not a flag.

### 9.5 URL acceptance rules at creation

| Rule | Rationale / precedent |
| --- | --- |
| `https` only, with system trust store | Payload may contain mail metadata going to a third party. |
| **No insecure-TLS escape hatch** | The repo has `IMAP_TLS_REJECT_UNAUTHORIZED` and `SMTP_TLS_REJECT_UNAUTHORIZED`, but those govern connections to the operator's *own* mail server. A webhook target is a third party; a `WEBHOOK_TLS_REJECT_UNAUTHORIZED=false` flag would exist only to be misused. Refused deliberately. |
| `http` permitted only when the target resolves to an allowed private address **and** `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` | Covers loopback/tailnet deployments and the same-host case #109 asks for, without a general plaintext path. |
| No userinfo, no query, no fragment | Precedent: the `DASHBOARD_PUBLIC_URL` refinement (`config.ts:64`). Userinfo in a URL is a credential-leak vector and a parsing-ambiguity vector; a query string is a place secrets get logged. |
| Hostname must be a DNS name, not an IP literal | An IP literal bypasses DNS pinning entirely — there is no resolution step to intercept. Allowed only under the private-target exception, where the operator is explicitly asserting the address is safe. |
| Port in `WEBHOOK_ALLOWED_PORTS` (default `443`) | Non-standard ports are how SSRF reaches internal admin panels. Comma-separated list, `splitCsv` convention. |
| Total subscriptions capped | §8.7. |

### 9.6 The compose-internal threat, concretely

OAE ships `compose.yaml` and `compose.api-only.yaml`, and ntfy is reached at
`NTFY_INTERNAL_URL` (default `http://ntfy`) — a Docker service name resolving to a
private address on the compose network. Without §9.2–§9.3, an actor holding **any**
identity-scoped token could register `http://ntfy/<topic>` and make the OAE process issue
requests into the internal network with the process's own network position: reaching ntfy,
the mail server's management interfaces, or anything else on that network.

The private-address block covers this, and `OAE_PUBLIC_EDGE=true` (`config.ts:214`)
removes the exception entirely for internet-facing deployments. This is the specific
scenario that makes §9 non-optional, and it should appear in the security documentation
as a worked example.

### 9.7 Egress amplification

OAE must not be usable as a DDoS reflector or a port scanner:

- Response reads capped at `WEBHOOK_RESPONSE_MAX_BYTES` (§6.5) and discarded.
- Per-endpoint and instance-wide concurrency caps (§8.7), so a tarpit endpoint that
  accepts TCP and never responds cannot exhaust the process — it occupies exactly one
  slot for `WEBHOOK_DELIVERY_TIMEOUT_MS` and then fails.
- Circuit breaker (§8.5) stops sustained traffic to a failing target.
- Registration rate limited (§8.7), so an attacker cannot enumerate an internal network
  by creating 10 000 subscriptions.
- Delivery attempts to a `refused` target are never retried (§8.2).

---

## 10. Configuration surface

### 10.1 Environment variables

Following the repo's conventions exactly: SCREAMING_SNAKE, `WEBHOOK_` namespace,
`z.enum(['true','false'])` for booleans, `0` disables a numeric limit, `envUrl()` for
URLs, defaults inline in the schema.

| Variable | Type | Default | Notes |
| --- | --- | --- | --- |
| `WEBHOOKS_ENABLED` | `'true' \| 'false'` | `'false'` | Fail-closed, matching `NTFY_ENABLED` and `TASK_LEASES_ENABLED`. When false, all `/v1/webhooks` routes return `404`. |
| `WEBHOOK_SIGNING_SECRET` | string ≥ 32, optional | unset | When unset, keys are derived from `taskSigningSecret` (§12.1). When set, it is the derivation root instead. |
| `WEBHOOK_ALLOW_PRIVATE_TARGETS` | `'true' \| 'false'` | `'false'` | The escape hatch #109 asks for. **Overridden to false when `OAE_PUBLIC_EDGE=true`** — a public edge wins, and this precedence must be enforced in `parseConfig`, not left to the operator. |
| `WEBHOOK_ALLOWED_PORTS` | CSV of ints | `443` | `splitCsv` convention. |
| `WEBHOOK_MAX_SUBSCRIPTIONS` | int ≥ 0 | `16` | |
| `WEBHOOK_MAX_PER_ADDRESS` | int ≥ 0 | `4` | |
| `WEBHOOK_MAX_ATTEMPTS` | int ≥ 1 | `8` | Truncates the fixed schedule in §8.3. `1` = no retry. |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | int ≥ 1000 | `10000` | Matches `CIMD_FETCH_TIMEOUT_MS` and GitHub's published 10 s. |
| `WEBHOOK_MAX_CONCURRENT` | int ≥ 1 | `8` | Mirrors `MAX_WAITS_TOTAL`, separate pool. |
| `WEBHOOK_PAYLOAD_MAX_BYTES` | int ≥ 1024 | `16384` | |
| `WEBHOOK_RESPONSE_MAX_BYTES` | int ≥ 0 | `4096` | |
| `WEBHOOK_TIMESTAMP_TOLERANCE_SEC` | int ≥ 30 | `300` | Consumer-side value, published in docs and in `GET /v1/webhooks`. |
| `WEBHOOK_DISABLE_THRESHOLD` | int ≥ 1 | `20` | |
| `WEBHOOK_ROTATION_OVERLAP_MS` | int ≥ 0 | `86400000` | 24 h dual-signature window (§12.2). `0` = atomic swap. |
| `WEBHOOK_LOG_RETENTION_DAYS` | int ≥ 1 | `30` | |
| `WEBHOOK_RATE_CREATE_PER_MIN` | int ≥ 0 | `10` | |
| `WEBHOOK_RATE_DELIVER_PER_MIN` | int ≥ 0 | `60` | Per endpoint. `0` disables. |

Note what is **absent**: no `WEBHOOK_TLS_REJECT_UNAUTHORIZED` (§9.5), and no per-event-type
env configuration — event selection belongs to the subscription, not the environment.

### 10.2 Boot-time validation

All of these run in `parseConfig` and fail the boot, following the existing
`ALWAYS_BCC` precedent (`config.ts:262-280`). A misconfigured webhook subsystem must not
start and silently misbehave:

1. If `WEBHOOKS_ENABLED=true` and `WEBHOOK_SIGNING_SECRET` is unset, then
   `TASK_SIGNING_SECRET` **must be explicitly set** and ≥ 32 characters. The `SMTP_PASS`
   fallback is refused. Rationale in §12.1.
2. If `OAE_PUBLIC_EDGE=true`, `WEBHOOK_ALLOW_PRIVATE_TARGETS` is forced to `false`.
3. `WEBHOOK_ALLOWED_PORTS` must be non-empty and contain only integers in 1–65535. The
   real protection against reaching an internal management panel is the address policy
   (§9.1–§9.3), not the port list; the port list exists to stop non-standard ports being
   used casually, and this RFC does not pretend it does more.
4. `WEBHOOK_PAYLOAD_MAX_BYTES` must be ≤ `JSON_BODY_LIMIT_BYTES`.
5. `DATA_DIR` must be writable, as existing stores already require.

### 10.3 REST API

Mounted as `app.route('/v1/webhooks', webhooksRoute)` alongside the existing mounts
(`app.ts:104-116`), therefore behind `bearerAuth` and the pre-auth `bodyLimit`. Bare
objects on success, `201` on create, `{error:'snake_case'}` on failure, zod `.strict()`
bodies.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/webhooks` | admin, or identity for own address | Create. `201` + `secret` **shown once**. |
| `GET` | `/v1/webhooks` | admin: all; identity: own address | `{webhooks:[…]}`. Never includes `secret`. |
| `GET` | `/v1/webhooks/:id` | as above | Bare object incl. `state`, `lastDelivery`. |
| `POST` | `/v1/webhooks/:id` | as above | Update `url` / `events` / `contentScope` / `active`. POST, not PUT/PATCH, matching `POST /v1/tasks/:id/state`. |
| `DELETE` | `/v1/webhooks/:id` | as above | Delete. Precedent: `routes/notify.ts:228`. |
| `POST` | `/v1/webhooks/:id/rotate` | as above | Issue a new secret; start the overlap window (§12.2). Returns the new `secret` once. |
| `POST` | `/v1/webhooks/:id/test` | as above | Fire `webhook.ping` and return once the first attempt settles, bounded by `WEBHOOK_DELIVERY_TIMEOUT_MS` (10 s). Responds `{deliveryId, outcome, status}`; later attempts continue in the background. |
| `POST` | `/v1/webhooks/:id/enable` | admin | Clear `disabled` state, reset the counter (§8.5). |
| `GET` | `/v1/webhooks/:id/deliveries` | admin | `{deliveries:[…], nextCursor}` — recent attempts and dead letters, from the JSONL log. |
| `POST` | `/v1/webhooks/deliveries/:deliveryId/redeliver` | admin | Manual replay of one dead letter (GitHub pattern). Enqueues a fresh attempt with a **new** `deliveryId` and the **same** event `id`. |

Create request:

```json
{
  "url": "https://consumer.example.com/hooks/oae",
  "address": "postmaster@openagent.email",
  "events": ["mail.received"],
  "contentScope": "metadata",
  "description": "postmaster wake-up"
}
```

Create response (`201`):

```json
{
  "id": "whk_4a1b8c2d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "url": "https://consumer.example.com/hooks/oae",
  "address": "postmaster@openagent.email",
  "events": ["mail.received"],
  "contentScope": "metadata",
  "active": true,
  "state": "enabled",
  "secret": "whs_7f3a9c1e5b8d24f6a0c3e7b1d9f24a68c0e4b7d1f3a9c5e8b2d6f0a4c8e1b5d9",
  "secretPrefix": "whs_7f3a…",
  "signatureScheme": "v1",
  "timestampToleranceSec": 300,
  "createdAt": "2026-09-03T12:20:00.000Z"
}
```

`GET` responses replace `secret` with `secretPrefix` only. The prefix exists so an
operator can tell two endpoints apart in a list and correlate with their own secret store
without OAE keeping the plaintext (§12.1).

Error codes, following the existing snake_case convention:

| Code | Status | Cause |
| --- | --- | --- |
| `webhooks_disabled` | 404 | `WEBHOOKS_ENABLED=false` |
| `invalid_request` | 400 | zod validation failure, with `details` |
| `unknown_event_type` | 400 | Reserved-but-unemitted or nonsense type (§5.3) |
| `invalid_webhook_url` | 400 | Fails §9.5 static rules |
| `webhook_target_forbidden` | 400 | Fails the SSRF policy at creation (§9.3) |
| `content_scope_requires_admin` | 403 | Identity token requested `preview` (§6.4) |
| `forbidden: token is scoped to another address` | 403 | Existing `forbidUnlessAddress` message, reused verbatim |
| `forbidden: admin key required` | 403 | Existing `requireAdmin` message, reused verbatim |
| `not_found` | 404 | Unknown `:id` |
| `webhook_limit_reached` | 409 | Instance or per-address cap (§8.7) |
| `rate_limited` | 429 | With `retryAfterSec` |
| `delivery_not_found` | 404 | Unknown redelivery id, or aged out of the log |
| `webhook_not_disabled` | 409 | `enable` on a healthy endpoint |

### 10.4 Authorization model

| Actor | May do |
| --- | --- |
| admin key | Everything, on any address: create/update/delete/rotate/test/enable, list deliveries, redeliver, set `contentScope: preview`. |
| identity token (`oa_…`, address-scoped) | Create/update/delete/rotate/test subscriptions **for its own address only**, at `contentScope: metadata` only. Cannot list deliveries or redeliver. |
| oauth token | Maps to the identity scope it was issued for — reads, and deleting own subscriptions. **Creation is deny-by-default** via the `critical` MCP tier (§10.7), not allowed merely because the token is identity-scoped. Never admin (`auth.ts`). |

Enforcement reuses `forbidUnlessAddress()` and `requireAdmin()` — no new auth primitive.

**Why an identity token may subscribe at all.** This is the capability that makes #109's
flagship use case work: an agent can wire up its own wake-up endpoint without a human
holding the admin key. It is safe because the token is already scoped to one address, and
everything it can subscribe to is mail it can already read via `GET /v1/messages`. The
scope table is the containment: metadata-only means a stolen identity token gains
*convenience*, not *content*.

Delivery inspection and redelivery are admin-only because the delivery log is an
instance-wide operational artifact, consistent with `GET /v1/audit/events`
(`routes/audit.ts:18`).

### 10.5 Storage

**`DATA_DIR/webhooks.json`** — subscription registry, following every existing store
convention (§3.6): 0600 in a 0700 directory, single writer, atomic `.tmp` + rename,
fsync, corrupt-fails-closed, and a `FORBIDDEN_SECRET_KEYS`-style guard
(`notification-devices.ts:112`) extended to refuse persisting `secret`, `signingSecret`,
or `previousSecret`.

Per subscription the file holds: `id`, `url`, `address`, `events`, `contentScope`,
`active`, `state`, `disabledReason`, `secretPrefix`, `createdAt`, `updatedAt`,
`rotatedAt`, `consecutiveFailures`, `createdBy` (`admin` or the address).

Note what it does **not** hold: the signing secret (§12.1), any payload content, or the
delivery history (that is the JSONL log, §8.6).

`identities.ts:12` observes that the JSON-store approach should be swapped for SQLite
"if identity volume ever matters". The same applies here, and at 16 subscriptions it does
not matter.

### 10.6 Audit events

Written through `recordAuditEvent()` (never throws), using the existing whitelist — which
means **no URLs, no payloads, no secrets, no subjects can appear in the audit log by
construction**. That is a feature: the audit log is the one artifact an operator is most
likely to ship elsewhere.

| `event` | `outcome` values |
| --- | --- |
| `webhook.create` / `webhook.update` / `webhook.delete` | `ok`, `denied`, `rate_limited`, `error` |
| `webhook.rotate` | `ok`, `denied`, `error` |
| `webhook.disabled` | `ok` (the disablement itself succeeded) |
| `webhook.deliver` | `ok`, `error` (retryable/permanent/refused folded into `error`, with the detail in the JSONL log) |
| `webhook.ssrf_refused` | `denied` |

`webhook.ssrf_refused` is the one that matters for security review: it is the signal that
someone tried to point OAE at an internal address. It carries `address` and `ip` (the
*client* IP, via the existing `clientIp()` single implementation) and nothing about the
target.

### 10.7 MCP surface parity

`CONTRIBUTING.md` states a rule this design cannot ignore: *"Keep the REST contract and the
MCP tool surface in sync — every REST operation has a `mail_*` tool and vice versa."*

**The rule already has an exception, and it is the relevant one.** Admin-only operational
routes have no MCP counterpart today: `GET /v1/audit/events` and the
`POST|GET|DELETE /v1/notify/devices` family appear nowhere in `mcp/tools.ts`, while
agent-facing routes all do. So parity applies to the **agent-facing** surface, not to
instance administration.

Applying that line to §10.3:

| Route | MCP tool | Tier |
| --- | --- | --- |
| `GET /v1/webhooks` | `mail_webhook_list` | `read` |
| `POST /v1/webhooks` | `mail_webhook_create` | **`critical`** |
| `DELETE /v1/webhooks/:id` | `mail_webhook_delete` | `minimal` |
| `POST /v1/webhooks/:id/test` | `mail_webhook_test` | `contained` |
| `GET /v1/webhooks/:id`, `POST /v1/webhooks/:id`, `POST …/rotate` | **none in v1** — see below | — |
| `POST …/enable`, `GET …/deliveries`, `POST …/redeliver` | none — admin-only, existing exception | — |

Tiers use the existing four-level vocabulary in `lib/tool-tiers.ts` (`read` / `minimal` /
`contained` / `critical`), whose definitions are quoted here in translation: `contained` is
*outbound or wake* (send mail, notify, advance a task) and `critical` is *identity creation
and human-verification channels, deny-by-default for OAuth tickets*.

**Why `mail_webhook_create` is `critical` and not `contained`.** `mail_send` is `contained`
because it is a single outbound act. Creating a webhook is worse in kind: it installs a
**persistent** egress target that OAE will connect to on every future mail, at a URL the
caller chose. That is closer to `mail_new_identity` (which mints a lasting credential) than
to `mail_send`. The practical consequence is the one that matters — under the repo's
existing tier policy, `critical` is deny-by-default for OAuth-derived tokens, so an agent
acting on a narrowly-granted OAuth ticket cannot silently register a callback URL. It can
still do so with an identity bearer token, which is the capability §10.4 deliberately
grants. `mail_webhook_test` is `contained` because it causes exactly one outbound
connection now.

This also **sharpens §10.4**: an OAuth token maps to identity scope for *reads* and for
`mail_webhook_delete`, but webhook **creation** should be deny-by-default for OAuth tickets
via the tier policy rather than allowed merely because the token is identity-scoped. The
tier mechanism already exists to express this; no new auth primitive is needed.

**The deviation, stated for ratification.** `GET /v1/webhooks/:id`, `POST /v1/webhooks/:id`
(update), and `POST /v1/webhooks/:id/rotate` are not admin-only, so strict parity would
require three more tools. v1 omits them: an agent needs to wire up, verify, list, and tear
down its own wake-up endpoint, and it does not need to edit filters or rotate signing keys
from inside the agent loop. MCP tools are effectively permanent once shipped — removing one
breaks every client that adopted it — so the surface should start minimal and grow on
demand. This is a deliberate, visible deviation from the CONTRIBUTING rule rather than an
oversight, and §16 Q17 asks the owner to ratify or reject it.

Two mechanical notes for implementation: `assertToolTierDeclared()` (`tool-tiers.ts:73`)
throws at registration if a tool is registered without a declared tier, so a missing tier
cannot ship silently; and `TOOL_TIER_SPEC` (`tool-tiers.ts:28`) is documented as the single
source shared by PRs and docs, so the four rows above must be added there in the same PR.

---

## 11. Coexistence with `mail_wait_for`

### 11.1 What long-polling is today

Facts, cited, because the coexistence argument depends on them:

- MCP tool `mail_wait_for` (`packages/api/src/mcp/tools.ts:383`), inputs `address`,
  `fromContains`, `subjectContains`, `timeoutSec` (1–600, default 120). Tier `read`.
- Backed by `POST /v1/messages/wait` (`routes/messages.ts:78`), auth via
  `forbidUnlessAddress`.
- The requested timeout is **silently clamped** to `MCP_MAX_WAIT_SECONDS`
  (`clampWaitSeconds()`, `config.ts:352`; default 60, schema max 600), and the effective
  value is echoed in `X-OAE-Wait-Timeout-Sec`.
- Implementation is `waitForMessage()` → `waitWithIdle()`: one IMAP connection held with
  a mailbox lock, looping `findMatchWith()` then racing `client.idle()` against a 3 s
  heartbeat; on IDLE failure it degrades to `waitWithPolling()` at 3 s intervals.
- For an ordinary mail wait, `findMatchWith()` pages the **newest 20** inbox messages
  (`imap.ts:1013`) and returns the newest match. **There is no cursor or watermark**, so an
  already-present message returns immediately and duplicate avoidance is the caller's job.
  (Task waits bypass this with a full-mailbox header search, `imap.ts:1003-1012`.)
- Slots are capped at `MAX_WAITS_PER_ADDRESS = 3`, `MAX_WAITS_TOTAL = 8`
  (`ratelimit.ts:205-206`), returning `429 {error:'too_many_waits', retryAfterSec:5}`.
- `Bun.serve` runs with `idleTimeout: 0` (`main.ts:51`) specifically so these long
  connections are not cut at the server layer.
- Returns the full `MessageDetail` (text, html, OTP codes and links) on success, or
  `408 {error:'timeout', timeoutSec}` on expiry.

### 11.2 The inversion — why neither replaces the other

The two mechanisms have **opposite reachability requirements**:

| | `mail_wait_for` | webhook |
| --- | --- | --- |
| Who initiates | consumer | OAE |
| Who must be reachable from the internet | **OAE only** | **OAE and the consumer** |
| Works for an agent on a laptop / behind NAT / in CI | yes | **no** |
| Works with no long-lived agent process | no | **yes** |
| Latency to notification | up to the poll interval | one round trip |
| Holds a scarce slot while waiting | yes (8 instance-wide) | no |
| Holds an IMAP connection while waiting | yes | no (shared watcher loop) |
| Delivers content in the response | yes, full detail | no, bounded + refetch |

The row that decides the relationship is the second one. **Webhooks require the consumer
to be publicly addressable; long-polling requires only that OAE is.** A large fraction of
real OAE agents — a developer's laptop, a CI job, an agent behind carrier NAT, a
`localhost` MCP client — can never receive a webhook. Deprecating long-polling would
delete those users.

So: **webhooks do not replace `mail_wait_for`. They invert who must be reachable, and the
two cover disjoint deployment shapes.** `mail_wait_for` is unchanged by this RFC and is
not deprecated, not discouraged, and not scheduled for removal.

### 11.3 What webhooks relieve

The genuine win is slot pressure and process shape, and it is worth quantifying:

- `MAX_WAITS_TOTAL = 8` is a hard ceiling on how many agents can be *waiting* on one
  instance at once. A ninth gets `429`. Webhooks lift that ceiling without raising it,
  because a webhook consumer holds no slot at all.
- Each wait also holds an IMAP connection and a mailbox lock for its duration. Eight
  concurrent waits is eight held connections against one Dovecot. The webhook path uses
  the **one** process-wide watcher loop that already exists.
- The dominant agent pattern today is necessarily "loop: wait 60 s, on timeout loop
  again" — a permanently running process burning a slot to discover nothing. With
  webhooks the agent can be a **function invoked per event**, which is precisely #109's
  "wake a headless agent per incoming mail instead of polling or long-lived processes".

**The two slot pools must be separate.** A webhook delivery pool sized 8 that shared
counters with the wait pool would let a burst of outbound deliveries starve
`mail_wait_for`, and vice versa. §8.7 sizes them independently for this reason.

### 11.4 The prerequisite refactor (the real cost of this RFC)

The only place that observes each new message exactly once, with a durable-ish UID
watermark and reconnect handling, is the notification watcher (§3.1). Webhooks should
emit from there — `processWatchedMessage()` already parses the message and applies gating,
so a webhook dispatch is a sibling of the existing ntfy publish.

But that loop is gated on ntfy at **two** levels:

```
main.ts:40                     if (config.ntfy.enabled) { … startNotificationWatcher(); }
notification-watcher.ts:1603   if (!config.ntfy.enabled || config.ntfy.pushPolicy === 'none') return () => {};
```

If webhooks are simply added inside that loop, then **an operator who does not run ntfy
gets no webhooks** — and ntfy is off by default (`NTFY_ENABLED` defaults to `'false'`).
Worse, `PUSH_POLICY=none` would disable webhooks too, which is a category error: push
policy governs what goes to a phone, not what goes to the operator's own HTTPS endpoint.

The required change, which should land **before** the webhook feature (§15):

1. Widen the startup gate to
   `(config.ntfy.enabled && config.ntfy.pushPolicy !== 'none') || config.webhooks.enabled`.
   Note this widens the **watcher loop** only: `initializeNotifications()` (`main.ts:41`)
   provisions ntfy's server config and credentials and must stay inside
   `if (config.ntfy.enabled)`. Booting ntfy provisioning because webhooks are on would be
   its own bug.
2. Factor the loop into a neutral **inbound-mail event bus**: the IMAP IDLE connection,
   UID watermark, `UIDVALIDITY` re-anchoring, and reconnect backoff stay where they are;
   the per-message fan-out becomes a list of sinks.
3. Make ntfy and webhooks two independent sinks, each with its own enablement, its own
   gating, its own retry policy, and its own failure accounting. **A failure in one sink
   must not affect the other's watermark advancement.** Today a publish failure can retain
   the UID for up to `SERVICE_FAILURE_MAX_MS`; with two sinks that retention decision must
   become per-sink, or a dead webhook endpoint would stall ntfy delivery and vice versa.

Item 3 is the subtle one and the most likely to be gotten wrong in implementation. It is
called out here explicitly so a reviewer can check it.

This refactor touches production code that currently works, for a feature that does not
yet exist. That is a real risk and the owner should see it as the main cost of #109 — not
the crypto, not the SSRF work.

### 11.5 Migration guidance

- **No migration.** Both mechanisms are permanent.
- Recommended combined pattern for a public agent: subscribe a webhook, and keep
  `mail_wait_for` as the fallback path for when the endpoint is unreachable or disabled.
  The `cursor` in the event payload is what makes the two interoperable once
  `GET /v1/messages` accepts one (§3.7): a consumer can then resume from the same token
  regardless of which mechanism delivered it.
- Documented anti-pattern: running both a webhook subscription *and* a tight
  `mail_wait_for` loop for the same address. It doubles the load and guarantees
  duplicates. Idempotency on `id` (§8.1) makes it safe but not sensible.
- Whether `mail_wait_for` should gain cursor support — it currently rescans the newest 20
  with no watermark, so it is duplicate-prone in a way webhooks are not — is a real
  asymmetry, and §16, Q8. It is out of scope here.

---

## 12. Security model

### 12.1 Signing key: derive, do not store

Two candidate designs:

**(A) Random per-endpoint secret, persisted.** Generate `whs_<random>` at creation, store
it, show it once. This is what GitHub and Stripe do.

**(B) Derive the per-endpoint key from a root secret.**
`endpointKey = HMAC-SHA256(rootSecret, "webhook-signing-v1\n" + webhookId + "\n" + epoch)`,
following the exact precedent of `notifyCursorSecret` (`config.ts:309`), whose comment
records the rule (translated): domain-separate from the root, **add no new env var**.

The trailing `epoch` is not decoration — it is what makes per-endpoint rotation possible.
Without it the key is a pure function of `webhookId`, so `POST /v1/webhooks/:id/rotate`
(§10.3) could only produce a new key by rotating the **root**, which would invalidate every
other endpoint on the instance and contradict §12.2. `epoch` is a small integer persisted
per subscription in `webhooks.json` (§10.5) and incremented on each rotation, so the
derivation stays deterministic and re-displayable while each rotation yields a fresh,
endpoint-scoped key. The `\n`-joined construction follows `taskStamp` (`tasks-internal.ts:458`)
and avoids the field-boundary ambiguity that `mail-body-v2` length-prefixing exists to
prevent, because both `webhookId` and `epoch` have fixed, separator-free formats.

**Recommendation: (B), with `WEBHOOK_SIGNING_SECRET` as an optional explicit root.**

Reasons, in order of weight:

1. **(A) would be the first usable secret ever persisted by this codebase.** Every
   existing bearer secret is stored as a SHA-256 hash used only for comparison
   (`identities.ts:279`, `oauth-store.ts:271`), and `notification-devices.ts:112`
   hard-refuses to persist anything under a `password` or `token` key. A webhook signing
   secret is different in kind: it must be *used* to compute an HMAC, so it cannot be
   stored hashed. Adopting (A) means introducing plaintext-secret-at-rest, a new
   threat class for the repo, in a 0600 JSON file next to the identity registry. (B)
   stores nothing secret.
2. **(B) is re-derivable, so the reveal-once constraint softens.** With (A), a lost
   secret forces a rotation and a consumer-side cutover. With (B) an admin can re-display
   the current key at any time, because the server can always recompute it. That is a
   meaningfully better operator experience for a self-hosted product administered over SSH.
3. **(B) gets per-endpoint key isolation anyway.** Distinct `webhookId` inputs give
   distinct keys, so compromising one endpoint's key reveals nothing about another's, and
   deleting an endpoint *is* revoking its key.
4. **HMAC is a PRF, so publishing a derived key does not expose the root.** This matters
   because the derived key is handed to a third party.

**Cost of (B), stated plainly:** rotating the root secret invalidates every endpoint's key
at once. Mitigations: the multi-signature overlap window (§12.2) applies to root rotation
too, and an operator who needs independent rotation sets `WEBHOOK_SIGNING_SECRET`
separately from `TASK_SIGNING_SECRET`.

**The `SMTP_PASS` fallback must be refused.** `config.ts:281` lets `taskSigningSecret`
fall back to `SMTP_PASS`. That fallback is already refused for the one existing feature
that sends signed material to an external party — `ALWAYS_BCC` requires an explicit
`TASK_SIGNING_SECRET` ≥ 32 chars (`config.ts:270-280`) — and `mail-stamp.ts:141` refuses
to stamp at all when any recipient is off-domain, explicitly to avoid an HMAC oracle over
`SMTP_PASS`.

Webhooks are a strictly stronger case for that rule: the derived key is *handed to a
third party*. A derived key does not reveal the root, but the root would then be the SMTP
password, and coupling mail-transport credentials to a key distributed to arbitrary
external endpoints is unacceptable. Hence boot-time rule §10.2 item 1. This is not a new
policy — it is the existing policy applied to a new egress path.

### 12.2 Rotation with overlap

Multi-signature headers, as documented by both Svix/Standard Webhooks and Stripe (§4.2,
§4.3). GitHub publishes no rotation procedure at all; its dual emission of `X-Hub-Signature`
(SHA-1) and `X-Hub-Signature-256` is migration between *algorithms*, not between *secrets*,
and is the weaker cousin of what is adopted here.

1. `POST /v1/webhooks/:id/rotate` generates the new key (or, under (B), rotates the root
   or switches to an explicit `WEBHOOK_SIGNING_SECRET`).
2. For `WEBHOOK_ROTATION_OVERLAP_MS` (default 24 h), every delivery carries **both**
   signatures: `X-OAE-Signature: t=…,v1=<new>,v1=<old>`.
3. The consumer migrates to the new key at its own pace within the window. Verification
   tries every `v1=` value (§7.3 step 2), so no consumer-side coordination is needed to
   survive the window.
4. After the window, only the new signature is sent. The old key is discarded.
5. `WEBHOOK_ROTATION_OVERLAP_MS=0` gives an atomic swap for operators who prefer it.

The response body of `rotate` includes `overlapUntil` so the operator knows the deadline.
Rotation writes an audit event and is the one operation that must be idempotent under
retry — rotating twice in quick succession should produce one window, not two.

### 12.3 Secret handling

- Shown exactly once, in the `201` create response and the `rotate` response. Under
  design (B) an admin-only re-display endpoint is possible; whether to expose it is
  §16, Q3.
- Never returned by any `GET`.
- Never written to `webhooks.json`, the delivery log, the audit log, or application
  output. Enforced structurally by a `FORBIDDEN_SECRET_KEYS` guard, following
  `notification-devices.ts:112`.
- `redactSecrets()` (`lib/redact.ts`) is the existing log-redaction path; the `whs_`
  prefix should be added to its patterns so an accidentally logged secret is still
  scrubbed. Defense in depth, not the primary control.
- The `secretPrefix` stored for display is the first 8 characters — enough to
  disambiguate, too short to narrow a search.

### 12.4 Threat model

| Threat | Mitigation | §|
| --- | --- | --- |
| Forged delivery to a consumer | HMAC-SHA256, mandatory, fail closed | 7 |
| Replay of a captured delivery | 300 s timestamp tolerance + consumer dedupe on `id` | 7.4 |
| SSRF to cloud metadata / internal services | shared `net.ts` policy, always-block ranges | 9.2 |
| DNS rebinding between validation and connect | re-validate every attempt + connect-time address pinning | 9.3 |
| Redirect-based SSRF bypass | never follow redirects; 3xx is permanent failure | 9.4 |
| OAE used as a DDoS reflector or port scanner | response cap, concurrency caps, circuit breaker, registration rate limit, no retry on `refused` | 9.7, 8.5 |
| Mail content exfiltrated via a stolen identity token | `metadata`-only for identity tokens; `preview` requires admin; full bodies never included | 6.4 |
| Webhook secret becomes a mail-content credential | It cannot: full content requires an API token via refetch | 4.2, 6.4 |
| Plaintext secret at rest | Derived keys; nothing secret persisted | 12.1 |
| Root secret is the SMTP password | Boot-time refusal of the `SMTP_PASS` fallback when webhooks are enabled | 12.1, 10.2 |
| Secret leaked into logs | field-whitelisted audit, no payload in delivery log, `FORBIDDEN_SECRET_KEYS`, `redactSecrets` | 10.6, 8.6, 12.3 |
| Dead endpoint accumulates unbounded backlog | circuit breaker + immediate dead-letter while disabled | 8.5 |
| Slow/tarpit consumer exhausts the process | per-endpoint concurrency 1, delivery timeout, instance cap | 8.7 |
| Subscription churn abuse | creation rate limit + subscription caps | 8.7 |
| Webhooks silently disabled because ntfy is off | gate widening + sink separation (prerequisite refactor) | 11.4 |
| Delivery log becomes a privacy leak when shipped to an aggregator | no payload content, no URL query, `sensitive` rows write nothing extra | 8.6 |

### 12.5 What is explicitly *not* defended

Recorded so nobody discovers it later as a surprise:

- **Replay within the tolerance window** to the same endpoint (§7.4).
- **A malicious consumer endpoint** that logs the payload: once you subscribe an external
  URL, that URL's operator sees the metadata. This is inherent and is why `preview` is
  admin-only.
- **Availability.** Webhooks are best-effort. An agent that must not miss mail uses the
  cursor + list API to catch up (§8.4). This RFC does not make webhooks a reliable queue.
- **Use of OAE's egress IP to probe *public* hosts.** The SSRF policy (§9) keeps internal
  addresses out of reach, and creation-time validation is DNS-only, so there is no
  connect-result oracle at registration. But `POST /v1/webhooks/:id/test` plus
  `WEBHOOK_RATE_CREATE_PER_MIN = 10` and `WEBHOOK_MAX_SUBSCRIPTIONS = 16` still lets a
  stolen identity token make OAE originate a bounded number of connections to public hosts
  and observe distinguishable outcomes and timings. The caps make this a poor scanning
  primitive rather than an impossible one. Accepted for v1; tightening the test rate limit
  separately from the create limit is the obvious mitigation if it matters.
- **Compromise of the OAE host.** If the host is compromised, the root secret and all
  derived keys are exposed. Same as every other secret in the repo.

---

## 13. Observability and failure visibility

#109: *"Outbound failures fail visible (health signal), never silent."* Concretely:

1. **Per-endpoint state** on `GET /v1/webhooks/:id`: `state` (`enabled` / `disabled`),
   `disabledReason`, `consecutiveFailures`, and
   `lastDelivery: {at, outcome, status, durationMs, attempt}`.
2. **Instance health.** Extend the admin surface — not the unauthenticated
   `GET /healthz` (`app.ts:56`), which must stay trivial — with a count of disabled
   endpoints and of dead letters in the retention window. A deployment where every
   endpoint is disabled is a deployment that has silently stopped pushing, and that must
   be visible without reading a JSONL file by hand.
3. **Operator notification on disablement**, via the existing ntfy urgent path where
   `NTFY_ENABLED` is true. Best-effort; must not throw or block.
4. **Structured log lines** for `refused` and `disabled` outcomes at WARN/ERROR, using
   `redactSecrets()`.
5. **Audit events** for every management mutation and every SSRF refusal (§10.6).
6. **The delivery log itself** as the inspection API (§8.6, §10.3), so "why didn't my
   endpoint get this?" is answerable without server access. This mirrors the existing
   "why didn't I receive this notification?" affordance in the dashboard.

---

## 14. Verification strategy

No implementation is proposed, so this records how the design would be proven, in the
repository's existing style — the test suite is the specification's enforcement mechanism,
and `docs/approval-digest.md` sets the precedent of committing **interop vectors** rather
than only unit tests.

1. **Committed signature vectors.** A `webhook-signature-vectors.v1.json` fixture with
   `(key, t, body, expectedSignature)` tuples, verified by a JavaScript test *and* by an
   independent Python standard-library verifier — exactly the dual-verification pattern
   already used for `approval-canonical-vectors.v1.json`. This is what makes the wire
   format safe for third-party implementers, and it is the highest-value test in the
   feature.
2. **SSRF matrix.** A test per blocked range in §9.2 and per rule in §9.5, including
   IPv4-mapped IPv6, the IPv6 embedded-IPv4 forms the shared policy does **not** yet cover
   (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo — §9.2), decimal/octal/hex IPv4
   encodings, a DNS name resolving to a blocked address, a name whose resolution *changes*
   between validation and connect (rebinding), and a redirect response. Plus the
   highest-value test in the feature: assert the §9.1 `publicEdge` composition — that
   `WEBHOOK_ALLOW_PRIVATE_TARGETS=false` blocks a private target even when
   `OAE_PUBLIC_EDGE` is unset, and that `OAE_PUBLIC_EDGE=true` blocks it even when the
   webhook escape hatch is on.
3. **Retry/outcome classification.** A local test server returning each status in §8.2,
   asserting the retry decision and the schedule, with a fake clock so the ~27-hour budget
   is testable in milliseconds.
4. **Gate independence.** Assert that webhooks fire with `NTFY_ENABLED=false`, that ntfy
   publishes with `WEBHOOKS_ENABLED=false`, and — the subtle case from §11.4 item 3 —
   that a failing webhook sink does not stall the ntfy sink's watermark, or vice versa.
5. **Storage conventions.** 0600/0700 modes, atomic rename, corrupt-file fail-closed,
   `FORBIDDEN_SECRET_KEYS` refusal, retention compaction.
6. **Payload bounding.** Every field's cap, the ordered overflow behavior (§6.5),
   UTF-8-safety of truncation on multi-byte boundaries, and a hard assertion that no
   payload at any scope exceeds `WEBHOOK_PAYLOAD_MAX_BYTES`.
7. **Authorization matrix.** Each route × {admin, own-address identity, other-address
   identity, oauth}, asserting `content_scope_requires_admin` and the address-scoping 403.
   Plus the MCP tier assertions from §10.7: every new tool appears in `TOOL_TIER_SPEC`,
   `mail_webhook_create` is deny-by-default for an OAuth-derived token, and
   `mail_webhook_test` is permitted for one.
8. **Idempotency of `rotate`** and correctness of the dual-signature overlap window.

---

## 15. Phasing

If ratified, this is five PRs, and the ordering matters because PR 1 and PR 2 touch
working production code and should be independently revertible:

| PR | Content | Risk |
| --- | --- | --- |
| 1 | Generalize `pinnedCimdFetcher` into a shared pinned fetcher parameterized by timeout and byte cap, **and** promote the document-fetch wrapper's redirect refusal into that shared policy (§9.1); no behavior change for CIMD | low — pure refactor, existing CIMD tests are the guard |
| 2 | Factor the notification watcher into an inbound-mail event bus with per-sink enablement, gating, retry, and **per-sink** watermark advancement; widen the startup gate; ntfy remains the only sink | **medium** — touches a working loop; §14 item 4 is the guard |
| 3 | Extend `GET /v1/messages` with `cursor` / `nextCursor`, exposing at the bearer API what `listMessagesPageWith()` already implements for the dashboard (§3.7) | low — additive query param, `{messages}` shape gains an optional key |
| 4 | Webhook subsystem: config, `webhooks.json`, signing, delivery, retry, circuit breaker, delivery log, REST routes, the four MCP tools with their `TOOL_TIER_SPEC` entries (§10.7), audit | additive — behind `WEBHOOKS_ENABLED=false` |
| 5 | Signature interop vectors (JS + Python verifiers), SSRF matrix, docs, `.env.example` and `compose.yaml` entries, and the consumer-facing verification guide | additive |

PR 3 is small but load-bearing: without it the `cursor` in a webhook payload is a token the
consumer cannot spend, and the "push to wake, pull to read" pattern in §8.4 has no pull
half. It is sequenced before the webhook subsystem so the payload field is useful the day
it ships.

PR 4 lands dark: `WEBHOOKS_ENABLED` defaults to `'false'`, so merging it changes nothing
for any running deployment. That is the same rollout posture as `TASK_LEASES_ENABLED` and
`NTFY_ENABLED`.

---

## 16. Open questions for the owner

These are the decisions this RFC could not make alone. Each has a recommendation where one
is defensible.

**Q1 — v1 event catalog.** `mail.received` only, or pull `approval.requested` forward?
#109 frames the human-in-the-loop approval case (push to ntfy/Telegram the instant an
approval is needed) as one of the top unlocks, and it may be worth more than the postmaster
case. *Cost of including it:* a second emission site in the task path, and
`approval.expired` has no emitter at all today (expiry is evaluated lazily on read), so a
complete approval trio needs a reaper. *Recommendation:* ship `mail.received` alone to
prove the delivery machinery, then add `approval.requested` as the immediate follow-up —
but decide now, because it determines whether PR 2's event bus must span the task path.

**Q2 — `contentScope: preview` gating.** Admin-only (recommended, §6.4), or available to
an identity token with an explicit acknowledgement flag mirroring push tier 3's
`confirm_risk=true`? *Trade-off:* an autonomous agent that cannot escalate its own scope
needs a human to enable the useful case; allowing self-escalation with a flag turns a
stolen identity token into a content-exfiltration channel.

**Q3 — Signing key: derived (B) or stored random (A)?** §12.1 recommends (B). *Decide
explicitly*, because (A) introduces the repository's first plaintext usable secret at rest
and should not happen by accident. Sub-question under (B): expose an admin-only
re-display of the current derived key, or keep reveal-once discipline?

**Q4 — Retry budget.** 8 attempts / ~27 h 35 min, adopting Resend's published schedule
(recommended, §8.3); Stripe's and SendGrid's ~3 days; the watcher's existing 10 minutes; or
GitHub's model of no automatic retry at all? This is really a question about **how
perishable a mail event is**, and the owner knows the answer better than the design does.
The recommended schedule is front-loaded — four attempts inside 35 minutes — so the
perishable cases are already served early and the long tail only buys availability.
`WEBHOOK_MAX_ATTEMPTS` truncates the table, so shortening this later is a config change
rather than a redesign.

**Q5 — Restart recovery.** Is "pending retries reconstructed from the delivery log, events
emitted while down are lost" (§8.6) acceptable for v1, or must OAE re-walk the mailbox
from the last delivered cursor on boot and re-emit? The cursor in the payload (§3.7) makes
the stronger version feasible. *Recommendation:* accept the weaker version for v1, because
the stronger one needs a per-subscription durable "last delivered cursor" and a bounded
re-walk, which is real work; but this is the question most likely to bite an operator
during a routine container restart.

**Q6 — Ownership of the prerequisite refactor (§11.4).** The event-bus extraction touches
working production code for a feature that does not exist yet, and item 3 (per-sink
watermark advancement) is subtle. Who owns PR 2, and is it acceptable for it to land with
no user-visible change?

**Q7 — Multi-tenant hosted policy.** If OAE is ever hosted for multiple tenants, is
webhook egress allowed at all? Per-endpoint rate limits, subscription caps, and abuse
surface all change shape on shared infrastructure, and `OAE_PUBLIC_EDGE=true` becomes the
norm rather than the exception. #109 lists this as an open question; this RFC deliberately
does not answer it.

**Q8 — Should `mail_wait_for` gain cursor support?** It currently rescans the newest 20
messages with no watermark (§11.1), so it is duplicate-prone in a way webhooks are not.
Now that a signed cursor exists and is embedded in webhook payloads, adding cursor support
to long-polling would make the two mechanisms fully symmetric. Out of scope here; worth a
card.

**Q9 — Inbound webhooks.** External system POSTs in → becomes mail or a task. Same design
or a split card? #109 says "separate card if pursued". *Recommendation:* split — the trust
direction is opposite and the auth model is unrelated.

**Q10 — Dashboard surface.** Read-only deliveries/dead-letters view under Configure in v1,
or REST-only with the UI deferred? ADR-0026 already plans a Configure section and a
notification-log view; a webhook panel would fit there naturally, but §2.2 excludes new UI.

**Q11 — Circuit-breaker recovery.** Manual re-enable only (recommended, §8.5), or an
automatic periodic probe that re-enables on success? Auto-recovery risks silently resuming
after a window of dropped events; manual-only risks an operator not noticing.

**Q12 — `webhook.ping` at creation: synchronous or asynchronous?** GitHub fires a `ping` on
creation but does not document whether it is synchronous with the creation call (§4.1), so
there is no vendor answer to copy. Validating *during* `POST /v1/webhooks` gives far better
operator feedback
("your endpoint is unreachable" at creation, not 30 seconds later in a log) but couples
create latency to a third party and needs its own timeout. *Recommendation:* create
asynchronously, and make `POST /v1/webhooks/:id/test` the synchronous-feeling path. If the
owner wants create-time verification feedback, the cleanest form is a third endpoint state
— `unverified` until the first ping succeeds, alongside `enabled` and `disabled` (§8.5,
§10.3) — which is a real addition to the state machine and should be decided as such rather
than implied by a response field.

**Q13 — Signature encoding: hex or base64url?** §7.2 recommends hex and explicitly deviates
from this repo's base64url stamp convention (`taskStamp`, `mail-stamp`, `mail-cursor`).
The vendors split: GitHub (`sha256=<hex>`) and Stripe (`v1=<hex>`) use hex, while
Svix/Standard Webhooks uses `v1,<base64>`. Hex is what the majority of existing consumer
snippets and libraries assume, which is the whole argument; base64url would be internally
consistent and 25% shorter. This is a one-way door — once an integrator ships a verifier,
the encoding cannot change without a `v2=`. Related and smaller: should event ids move to a
sortable scheme (UUIDv7/ULID) instead of UUIDv4? Sorting is not needed given `data.cursor`,
but sortable ids make log correlation easier for consumers.

**Q14 — Should `WEBHOOK_MAX_SUBSCRIPTIONS` be per-instance only, or also per-identity?**
§8.7 caps per address at 4. On a many-identity instance, 4 × N identities could still be a
large number of egress targets. Whether that needs a global cap below the instance maximum
depends on the hosted answer to Q7.

**Q15 — Should redelivery cover *succeeded* deliveries, or only dead letters?** Resend
documents replaying both (§4.3), and replaying a success is how an integrator tests their
handler against a real payload without waiting for real mail. §10.3 currently scopes
`redeliver` to dead letters. Extending it to successes is cheap (the log records both) but
means OAE will re-send an event a consumer already processed, so it leans harder on the
consumer's `id` dedupe. *Recommendation:* allow it, admin-only, and mark the resulting
delivery as a replay in the log.

**Q16 — Where does the IPv6 embedded-IPv4 SSRF gap get closed?** §9.2 documents that the
shared policy covers IPv4-mapped IPv6 but not NAT64, 6to4, or Teredo. It is a pre-existing
gap, not one this RFC creates, but webhooks are the first feature that lets any token
holder aim the server at any name. Options: fold it into PR 1 (the SSRF refactor, where it
is cheap and the tests are already being written), or file a separate hardening card so
that PR 1 stays a pure no-behavior-change refactor. *Recommendation:* PR 1 — a hardening
card filed alongside a feature that needs it tends not to happen before the feature.

**Q17 — Ratify the MCP parity deviation (§10.7)?** `CONTRIBUTING.md` requires every REST
operation to have a `mail_*` tool. v1 ships four tools and leaves three non-admin routes
(`GET /v1/webhooks/:id`, `POST /v1/webhooks/:id`, `POST …/rotate`) REST-only, on the
argument that MCP tools are effectively permanent and an agent does not need to rotate
signing keys from inside its own loop. The owner may prefer strict parity — seven tools
from day one — since deviating from a stated CONTRIBUTING rule is a maintainer decision,
not an author's. Related and worth deciding at the same time: is `mail_webhook_create`
correctly tiered `critical` (deny-by-default for OAuth tickets), or is `contained` enough?
§10.7 argues `critical` because a webhook is a *persistent* egress target rather than a
one-shot outbound act like `mail_send`.

---

## Appendix A: normative signature summary

For an implementer who reads nothing else:

```
Header:  X-OAE-Signature: t=<unix-seconds>,v1=<lower-case-hex>[,v1=<lower-case-hex>]
Signed:  "<t>" + "." + <exact UTF-8 bytes of the request body as transmitted>
Mac:     HMAC-SHA256
Key:     the endpoint signing secret (shown once at creation / rotation)
Accept:  if ANY v1 value matches AND abs(now - t) <= 300 s
Reject:  otherwise, always, with no unsigned fallback
Dedupe:  on the body's "id" field; deliveries are at-least-once
Order:   not guaranteed; sort by "data.cursor" if you need order
Fetch:   full mail content via GET /v1/messages/:id with your own API token
```

## Appendix B: relationship to other cards

| Card | Relationship |
| --- | --- |
| #109 | This RFC is the design record #109 asks for. |
| #105 | Refused in core (§2.2). Webhooks are the substrate for a userland responder; the RFC argues a core LLM responder inherits prompt injection from every inbound body. |
| #59 | Not implemented. §7.6 keeps the signature header shape so an asymmetric `v2=` scheme is additive. Nothing else here commits to federation. |
| #72 | Compliance auto-BCC already shipped (`9209aee`). #109 notes it becomes a userland "subscribe an archiver endpoint" pattern; §12.1 reuses its `TASK_SIGNING_SECRET` boot rule. |
| ADR-0026 | Supplies the Configure/notification-log UI context for §16 Q10, and the fact that tasks are authoritatively IMAP mail threads — relevant to any future `task.*` event source. |
