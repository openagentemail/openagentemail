# RFC-0002: Federated signed tasks

- **Status:** **Proposed** — draft for owner ratification. 本 RFC 的「批准前修订清单」（见终审补报与闸面意见记录）未清空之前，Status 不得由 Proposed 升为 Accepted。
- **Date:** 2026-09-19
- **Issue:** [#59](https://github.com/openagentemail/openagentemail/issues/59)
- **Decision scope:** federated discovery metadata (`.well-known/openagent-federation`), domain trust and allowlist model, asymmetric signing envelope (Ed25519), signature verification rules and ordinary mail spoofing rejection, cross-domain trust boundaries and key compromise semantics, configuration surface (env + REST), discovery cache lifecycle and key rotation.
- **Out of scope:** cross-domain task leasing (#189 / `TASK_LEASES_ENABLED`), distributed two-phase commit or consensus across deployments, auto-reply / responder engines (#105), inbound webhooks (#109), multi-tenant SaaS / billing federation, and alterations to the local IMAP/Dovecot storage model.
- **Implementation code:** none. This is a design document. Code-shaped blocks below are wire-format illustrations and operator commands, not a reference implementation.

> On numbering: this repository keeps architecture decision records under
> `design/adr-NNNN-*.md`, but that sequence is numbered outside this repo (only
> `design/adr-0026-dashboard-revamp.md` is committed here). Following RFC-0001
> (`docs/rfcs/0001-outbound-webhooks.md:22-26`), this document claims RFC-0002.
> If ratified, it should be adopted as the corresponding `design/adr-NNNN` by whoever
> owns that sequence, and this file should then point at it.

---

## 1. Summary

OpenAgentEmail today restricts task coordination to **a single local domain** (`packages/api/src/lib/tasks-internal.ts:1954-1960`, `knownManagedIdentity()`). While email as a transport layer is inherently federated and global over SMTP (RFC 5322), two independent OpenAgentEmail deployments cannot exchange structured, authenticated tasks with each other.

The root cause is cryptographic: task integrity and authenticity currently depend on symmetric HMAC-SHA256 stamps (`packages/api/src/lib/tasks-internal.ts:545-549`, `taskStamp()`) computed from a shared secret (`packages/api/src/lib/config.ts:434`, `config.taskSigningSecret`). Verifying a symmetric stamp across domains would require sharing that secret, which collapses tenant isolation and creates a fatal HMAC oracle hazard (`packages/api/src/lib/mail-stamp.ts:12-14`, `:171`).

This RFC proposes **federated signed tasks** across independent OpenAgentEmail domains, divided into two phased capabilities:

1. **Phase 1: Discovery & Trust:** standardizing `.well-known/openagent-federation` metadata on each deployment domain (RFC 8615), advertising active Ed25519 public signing keys, key IDs, protocol versions, and capabilities, paired with an explicit, closed-by-default trusted-domain allowlist, strict SSRF egress isolation independent of host edge settings, and a bounded-cache lifecycle with explicit revocation bounds.
2. **Phase 2: Signed Task Envelopes:** establishing asymmetric cryptographic task envelopes signed by the originating domain's private key using Ed25519 (RFC 8032), binding immutable task attributes (task ID, event kind, state, sender, recipient, subject, timestamp, expiry, and body hash) into an unforgeable wire format, with strict fail-closed verification rules that cleanly reject forged `X-OA-Task-*` headers, un-modeled extensions, or attachments from untrusted external mail.

The design deliberately reuses four hardened subsystems already established in this repository:

| Need | Existing subsystem to reuse | Reference |
| --- | --- | --- |
| Safe egress & SSRF defense | Parameterized pinned DNS fetcher enforcing strict IP policies | `packages/api/src/lib/net.ts:1-10`, `:355-377`, `packages/api/src/lib/pinned-fetch.ts:101-104` |
| Length-prefixed payload hashing | Length-prefixed string hashing eliminating field-boundary ambiguity | `packages/api/src/lib/mail-stamp.ts:21-23`, `:36-38`, `:92-102` |
| Constant-time verification | Constant-time cryptographic verification failing closed | `packages/api/src/lib/mail-stamp.ts:125` (`timingSafeEqual`) |
| Structured audit & health logging | Append-only bounded audit log with strict field allowlist | `packages/api/src/lib/audit.ts:38-50`, `:117-142` |

RFC-0001 explicitly reserved cross-domain federation (#59) as out of scope (`docs/rfcs/0001-outbound-webhooks.md:16-17`, `:101-104`), while establishing a versioned signature header prefix (`v2=<kid>.<sig>`) designed specifically so that asymmetric federated signing would be additive rather than breaking (`docs/rfcs/0001-outbound-webhooks.md:1254-1273`). This RFC completes that architectural commitment.

---

## 2. Goals and non-goals

### 2.1 Goals

1. **Cross-domain task exchange:** Allow autonomous agents operating on distinct OAE instances (e.g. `agent@domain-a.com` and `reviewer@domain-b.org`) to submit, advance, and complete tasks over standard email transport.
2. **Phase 1 metadata discovery:** Provide standardized discovery at `https://<domain>/.well-known/openagent-federation` advertising domain identity, active Ed25519 public keys, key IDs, and capabilities (RFC 8615).
3. **Phase 2 asymmetric envelope signing:** Sign cross-domain task emails using Ed25519 (RFC 8032) under the sending domain's private key, ensuring non-repudiation, origin authenticity, and message integrity.
4. **Strict explicit allowlist (default closed):** Out-of-the-box federation is disabled (`FEDERATION_ENABLED=false`). When enabled, federation is permitted only with domains explicitly enumerated in `FEDERATION_TRUSTED_DOMAINS`.
5. **Robust anti-spoofing:** External emails carrying forged `X-OA-Task-*` headers without a valid federated signature from an allowlisted domain MUST be discarded as tasks and treated strictly as ordinary mail (`packages/api/src/lib/tasks-internal.ts:1041-1180`).
6. **Strict egress SSRF isolation:** Remote discovery fetches MUST enforce strict SSRF options (`ssrfOptions: { publicEdge: true }`), unconditionally blocking loopback, RFC 1918, CGNAT, link-local, and ULA addresses regardless of whether the hosting deployment has set `OAE_PUBLIC_EDGE`.
7. **Mandatory replay defense:** In v1, receivers MUST maintain a bounded deduplication cache for seen `(task_id, event_kind, state, timestamp)` tuples, alongside strictly monotonic timestamp validation for state advancements.
8. **No attachments in v1:** Federated task envelopes bind plain text and HTML bodies; emails carrying MIME attachments MUST fail closed and be rejected as tasks.
9. **Bounded cache & safe rotation:** Cache remote discovery metadata with bounded in-memory capacity and strict TTLs, supporting zero-downtime key rotation with multi-key overlap and active revocation.
10. **Backward compatibility:** Intra-domain tasks between local identities continue to use the existing symmetric HMAC stamp mechanism (`packages/api/src/lib/tasks-internal.ts:545-549`) without runtime disruption or secret migration.

### 2.2 Non-goals (explicit)

1. **No cross-domain task leasing:** Distributed leasing (`TASK_LEASES_ENABLED`, `packages/api/src/lib/config.ts:155`, `packages/api/src/lib/task-lease-journal.ts`, `docs/task-lease-journal.md:1-50`) requires single-host authoritative serialized journals. Cross-domain distributed locking or distributed consensus is explicitly excluded.
2. **No distributed two-phase commit:** Tasks communicate asynchronously across domains via message exchange; there is no distributed transaction manager or synchronous consensus across deployments.
3. **No inbound HTTP task injection:** Federated tasks are transported via email (SMTP/IMAP) so that all standard MTA audit trails, DMARC/SPF checks, and delivery guarantees apply. HTTP endpoints are used solely for metadata discovery.
4. **No auto-reply or LLM responder engine:** Automatic task dispatching, prompt processing, and autonomous agent loops remain separate concerns (#105, `docs/rfcs/0001-outbound-webhooks.md:96-100`).
5. **No federation-specific PKI or centralized registry:** Federation introduces no proprietary certificate authorities or centralized registries. HTTPS discovery relies on standard Web PKI certificate chains (CA misissuance or compromise remains an inherent boundary threat; whether to enforce certificate pinning is left for owner determination), while task authorization is governed directly by explicit operator allowlists.

---

## 3. Background: The local-domain restriction and its rationale

### 3.1 The current task stamp mechanism

Within a single deployment, tasks progress through a canonical state machine:

```ts
// packages/api/src/lib/tasks-internal.ts:56-57
export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed'] as const;
export type TaskState = (typeof TASK_STATES)[number];
```

Task events are typed as:

```ts
// packages/api/src/lib/tasks-internal.ts:99
export type TaskEventKind = 'state' | 'reminder';
```

To prevent clients from forging task transitions by injecting arbitrary email headers, the API writes a cryptographic stamp header `X-OA-Task-Stamp` on all outbound task emails (`packages/api/src/lib/tasks-internal.ts:909`, `:915`). The stamp is generated by `taskStamp()`:

```ts
// packages/api/src/lib/tasks-internal.ts:545-549
function taskStamp(id: string, state: TaskState, from: string, to: string): string {
  return createHmac('sha256', config.taskSigningSecret)
    .update(`${id}\n${state}\n${from.toLowerCase()}\n${to.toLowerCase()}`)
    .digest('base64url');
}
```

When incoming mail is ingested from IMAP, `parseTaskMessage()` parses headers and strictly checks the stamp (`packages/api/src/lib/tasks-internal.ts:1031-1039`, `:1055`, `:1178-1179`). If the stamp does not match `taskStamp(id, state, from, to)`, `parseTaskMessage()` returns `null` (`packages/api/src/lib/tasks-internal.ts:1179`), and the message is not recognized as a task mutation.

### 3.2 Task participant ACL and identity gating

Task authorization enforces strict participant boundaries:
- `taskParticipants(task)` defines the authorized participants as `{task.from, task.to}` (`packages/api/src/lib/tasks-internal.ts:3868-3870`).
- `canReadTask()` restricts REST reads to admin keys or validated task participants (`packages/api/src/routes/tasks.ts:101-105`).
- `knownManagedIdentity()` requires all participants to belong to configured local domains (`packages/api/src/lib/tasks-internal.ts:1954-1960`):

```ts
// packages/api/src/lib/tasks-internal.ts:1954-1960
export function knownManagedIdentity(
  address: string,
  find: (address: string) => any = findIdentity,
): boolean {
  const domain = address.split('@')[1]?.toLowerCase();
  return !!domain && config.allDomains.has(domain) && !!find(address);
}
```

- Approval tasks enforce this constraint even more strictly: `createApprovalTask()` throws `approval_identity_required` if either participant fails `knownManagedIdentity` (`packages/api/src/lib/tasks-internal.ts:1968-1969`).

Consequently, an agent with address `bob@external-domain.org` cannot participate in any task, because `external-domain.org` is not in `config.allDomains` (`packages/api/src/lib/config.ts:440`).

### 3.3 The anti-oracle rule and secret exposure hazard

The symmetric secret `config.taskSigningSecret` is derived at boot:

```ts
// packages/api/src/lib/config.ts:434
const taskSigningSecret = raw.TASK_SIGNING_SECRET ?? raw.SMTP_PASS;
```

Because `TASK_SIGNING_SECRET` may fall back to `SMTP_PASS`, leaking signatures or providing an HMAC oracle over this key to external parties is catastrophic:
1. `mail-stamp.ts` explicitly enforces the **anti-oracle rule**: `buildOutboundStampHeaders()` refuses to emit `X-OA-Mail-Stamp` whenever any recipient is outside the local domains (`packages/api/src/lib/mail-stamp.ts:12-14`, `:171`).
2. If symmetric task stamps were sent to external recipients, external actors could mount chosen-plaintext attacks to recover `SMTP_PASS` or forge local task stamps (`packages/api/src/lib/mail-stamp.ts:12-14`).
3. Conversely, two separate OAE instances cannot verify each other's symmetric stamps without sharing `taskSigningSecret`. Sharing a symmetric secret between distinct organizations completely destroys trust boundaries and gives each party total impersonation authority over the other.

### 3.4 Why cross-domain federation requires asymmetric cryptography

To bridge independent deployments safely, signatures must be **asymmetric**:
- Each domain possesses a **private signing key** kept strictly within its own boundary.
- Each domain advertises its **public verification key** via HTTPS discovery.
- Receiving domains verify signatures using the sender's public key without possessing or needing the sender's private key (RFC 8032:3).

RFC-0001 §7.6 explicitly anticipated this design (`docs/rfcs/0001-outbound-webhooks.md:1268-1272`):
> *"Forward compatibility with #59 is the reason for the prefix. Federation needs asymmetric signatures with key ids and `.well-known` discovery. An asymmetric scheme slots into the same header as `v2=<kid>.<sig>` without changing the envelope, the timestamp binding, or any consumer's routing logic."*

This RFC realizes the exact architecture forecast in RFC-0001.

---

## 4. Phase 1: Federated discovery & trust

Phase 1 defines how independent OpenAgentEmail instances discover and establish cryptographic trust with remote domains.

### 4.1 Discovery document specification

Each participating domain MUST publish its federation metadata document at a standardized well-known URI (RFC 8615):

```text
https://<domain>/.well-known/openagent-federation
```

#### Acceptance and Transport Rules
1. **HTTPS Only:** The document MUST be fetched over TLS on port 443. Plain HTTP is unconditionally refused.
2. **Content-Type:** The response MUST have `Content-Type: application/json` (RFC 8259).
3. **Response Bound:** The response body MUST NOT exceed 10 KiB (`FEDERATION_DISCOVERY_MAX_BYTES = 10240`), enforced via streaming truncation to defeat memory exhaustion attacks.
4. **No Redirects:** HTTP 3xx redirects MUST NOT be followed (`redirect: 'manual'`, matching the CIMD precedent in `packages/api/src/lib/oauth-cimd.ts:387` and `packages/api/src/lib/pinned-fetch.ts:8`).

#### Schema
The document payload contains the following top-level JSON structure:

```json
// Illustrative discovery document — not a reference implementation.
{
  "federationVersion": 1,
  "domain": "alpha.example.com",
  "publicKeys": [
    {
      "kid": "ed25519-2026-09",
      "algorithm": "Ed25519",
      "publicKey": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      "status": "active",
      "validFrom": "2026-09-01T00:00:00Z",
      "validUntil": "2027-09-01T00:00:00Z"
    },
    {
      "kid": "ed25519-2025-09",
      "algorithm": "Ed25519",
      "publicKey": "m3gXAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHAAA",
      "status": "retired",
      "validFrom": "2025-09-01T00:00:00Z",
      "validUntil": "2026-10-01T00:00:00Z"
    }
  ],
  "capabilities": [
    "task.v1"
  ],
  "policy": {
    "taskExpiryMaxSec": 604800
  }
}
```

- `federationVersion`: Integer schema version. Bumping is required only for breaking schema changes.
- `domain`: Canonical lowercase domain name of the hosting deployment. MUST match the request hostname exactly; mismatch causes rejection.
- `publicKeys`: Array of public keys. Each entry MUST provide:
  - `kid`: Key identifier string (1–64 alphanumeric / hyphen characters).
  - `algorithm`: Must be `"Ed25519"` for v1 (RFC 8032).
  - `publicKey`: Base64url-encoded 32-byte Ed25519 public key without padding (RFC 8032:3, RFC 8410:2).
  - `status`: `"active"` (may sign and verify), `"retired"` (verify only, no new signatures), or `"revoked"` (must not verify).
  - `validFrom` / `validUntil`: ISO-8601 UTC validity window.
- `capabilities`: Array of supported task protocols.

### 4.2 Explicit trusted-domain allowlist (default closed)

Federation across the public internet introduces foreign input into internal agent workflows. OpenAgentEmail mandates a **closed-by-default trust model**:

1. **Default Off:** Federation is globally disabled by default (`FEDERATION_ENABLED=false`).
2. **Explicit Allowlist Required:** When `FEDERATION_ENABLED=true`, the operator MUST configure `FEDERATION_TRUSTED_DOMAINS`.
3. **No Wildcard Matching:** Domains must match explicitly (e.g. `partner.org`). Wildcards (such as `*.partner.org`) are rejected at boot time to prevent subdomain takeover bypasses.
4. **Unconditional Dropping:** Inbound emails originating from domains not present in `FEDERATION_TRUSTED_DOMAINS` MUST NEVER initiate metadata discovery or trigger external HTTP fetches; their task headers are discarded immediately without making outbound network calls.

### 4.3 Discovery fetcher and SSRF protection

Fetching `.well-known/openagent-federation` documents requires making outbound HTTP requests based on domain names found in email headers. This creates a severe Server-Side Request Forgery (SSRF) and DNS rebinding risk.

#### Strict SSRF Policy Mandate
Reusing `pinnedCimdFetcher()` directly (`packages/api/src/lib/oauth-cimd.ts:331-348`) is forbidden because of its default inheritance semantics:
1. `pinnedCimdFetcher` delegates to `isSsrfBlockedResolvedIp(ip, opts)` (`packages/api/src/lib/net.ts:355-377`), which checks `isAllowedPrivateIpv4(host)` and `isUlaIpv6(host)` and returns `publicEdge` (`packages/api/src/lib/net.ts:365`, `:374`).
2. `publicEdge` defaults to `config.oaePublicEdge` (`packages/api/src/lib/net.ts:24-26`), which defaults to `false` in standard deployments. When `OAE_PUBLIC_EDGE` is false, private IPv4 (RFC 1918), loopback, CGNAT, and ULA addresses are **permitted** by `pinnedCimdFetcher`.
3. For cross-domain federation discovery, permitting private addresses would allow any token holder or external email sender to point OAE at compose-internal containers, cloud metadata endpoints, or tailnet services.

Therefore, federation discovery MUST explicitly enforce a **strict SSRF policy** (`ssrfOptions: { publicEdge: true }`, `packages/api/src/lib/pinned-fetch.ts:74`, `packages/api/src/lib/net.ts:19-22`) **independently of `OAE_PUBLIC_EDGE`**. Under this strict policy, all private IP ranges (RFC 1918), loopback (`127.0.0.0/8`, `::1`), CGNAT (`100.64.0.0/10`), ULA (`fc00::/7`), link-local, AWS IMDS (`169.254.169.254` and `fd00:ec2::/16`), and IPv4-mapped IPv6 ranges are unconditionally blocked (`packages/api/src/lib/net.ts:172-222`, `:262`, `:351`, `:365`, `:374`).

#### Parameterized Fetcher Specification
`pinnedCimdFetcher` hardcodes `CIMD_MAX_BYTES = 5 * 1024` (5 KiB) and `CIMD_FETCH_TIMEOUT_MS = 10_000` (10s) (`packages/api/src/lib/oauth-cimd.ts:38-39`, `:343-345`). Federation discovery requires distinct parameterized limits.

This RFC defines a dedicated `federatedDiscoveryFetcher()` backed by the repository's underlying `pinnedFetch()` (`packages/api/src/lib/pinned-fetch.ts:101-104`), parameterized as follows:
- `maxBytes`: `FEDERATION_DISCOVERY_MAX_BYTES = 10_240` (10 KiB streaming cap via `readBodyCapped`, `packages/api/src/lib/pinned-fetch.ts:40-57`).
- `timeoutMs`: `FEDERATION_DISCOVERY_TIMEOUT_MS = 5_000` (5,000 ms socket idle timeout).
- `deadlineMs`: `FEDERATION_DISCOVERY_TIMEOUT_MS = 5_000` (5,000 ms absolute wall-clock deadline, `packages/api/src/lib/pinned-fetch.ts:65-70`).
- `ssrfOptions`: `{ publicEdge: true }` (strict private-network block, `packages/api/src/lib/pinned-fetch.ts:74`).
- `headers`: `Accept: application/json`.
- `redirect`: Built-in rejection (`packages/api/src/lib/pinned-fetch.ts:8`, throwing `redirect_forbidden`).

### 4.4 Discovery cache lifecycle

To protect against availability degradation and Denial-of-Service attacks from repeated remote HTTP lookups, discovery documents MUST be cached in memory:

1. **Cache Structure:** An in-memory LRU cache storing parsed discovery documents, indexed by lowercase domain name.
2. **Capacity Bound:** The cache size is hard-capped at `FEDERATION_DISCOVERY_CACHE_MAX_ENTRIES = 500`.
3. **Positive TTL:** Cached entries expire after `FEDERATION_DISCOVERY_CACHE_TTL_SEC` (default `3600` seconds / 1 hour).
4. **Negative Caching:** When discovery fails (e.g. DNS failure, HTTP 404/500, SSRF violation, invalid JSON), a negative entry is cached for `FEDERATION_DISCOVERY_NEGATIVE_TTL_SEC = 60` seconds to prevent request hammering against faulty peers.
5. **Revocation Propagation Upper Bound:** The worst-case passive propagation delay for key revocation is bounded by `FEDERATION_DISCOVERY_CACHE_TTL_SEC` (default 3600s). The 60-second negative cache TTL applies strictly to failed lookups; it does not accelerate positive cache invalidation.
6. **Automated Discovery Re-fetch Restricted Strictly to Unknown KIDs:** When an incoming message references a `<kid>` not present in the cached discovery document, the verifier performs a single conditional, cache-bypassing re-fetch using `federatedDiscoveryFetcher()` (§4.3) to handle key rotation propagation races, provided the positive cache entry is older than `FEDERATION_DISCOVERY_NEGATIVE_TTL_SEC` (60s). Crucially, **re-fetch is triggered strictly for unknown `kid`s**. If a key is present in cache with `status: "revoked"`, verification MUST immediately fail closed without re-fetch (revocation is monotonic; re-fetching on revoked keys is futile and introduces an unauthenticated outbound network trigger). Regardless of outcome, any re-fetched discovery document MUST undergo full strict validation (domain matching, schema validation, 10 KiB size cap, and strict SSRF) before admission to cache.
7. **Purge on Reboot:** The cache is memory-only; a process restart starts with a cold cache by design (`packages/api/src/lib/ratelimit.ts:26-30` precedent).

### 4.5 Key rotation and safe transition

Key rotation must occur without dropping in-flight messages or invalidating recent tasks:

1. **Multi-Key Overlap:** An operator rotating their signing key generates a new Ed25519 key pair, assigns a new `kid`, and publishes both the new key (`status: "active"`) and the old key (`status: "retired"`) in `.well-known/openagent-federation`.
2. **Overlap Horizon:** The retiring key MUST remain advertised as `"retired"` for a minimum of 7 days to cover delayed or retried email deliveries.
3. **Key Identifier Resolution:** The verifier matches the `kid` specified in the incoming task envelope (`X-OA-Federation-Key-Id` or embedded in `X-OA-Federation-Signature`) against the keys present in the sender domain's cached discovery document.
4. **Emergency Revocation:** If a private key is compromised, the operator immediately marks `status: "revoked"` in their discovery document. Verifiers encountering a key with `status: "revoked"` MUST immediately fail closed with `task_federation_key_untrusted` without triggering a re-fetch, as revocation is monotonic.
5. **Administrative Invalidation:** Operators can force immediate cache invalidation for any peer domain via `POST /v1/federation/trusted-domains/:domain/refresh` (§7.2).

---

## 5. Phase 2: Signed task envelopes

Phase 2 specifies the cryptographic envelope, wire headers, and verification rules for cross-domain task messages.

### 5.1 Asymmetric signature scheme

- **Algorithm:** `Ed25519` (RFC 8032 PureEdDSA Ed25519; RFC 8410:2).
- **Rationale:**
  - **Compact wire footprint:** 32-byte public keys and 64-byte signatures minimize email header overhead (RFC 8032:3).
  - **Deterministic signing:** Ed25519 generates deterministic signatures without a per-message random nonce, eliminating private key leakage via bad random number generators (RFC 8032:3).
  - **High verification performance:** Sub-millisecond verification prevents DoS bottlenecks on high-volume email ingress (RFC 8032:3).
  - **Precedent in modern email & identity standards:** Broadly adopted across DKIM, SSH, and modern webhooks (e.g. SendGrid outbound event webhooks, `docs/rfcs/0001-outbound-webhooks.md:586-594`).
- **Signature Encoding:** Raw 64-byte signature encoded as base64url without padding.

### 5.2 Signed string and canonical binding tuple

To guarantee that signatures cannot be transplanted between different tasks, states, actors, subjects, or timestamps, the signature MUST bind a strictly canonical tuple covering all semantically consumed attributes.

In existing local task processing, the event discriminator is defined as:

```ts
// packages/api/src/lib/tasks-internal.ts:99
export type TaskEventKind = 'state' | 'reminder';
```

For the federated wire envelope [本 RFC 提议], the event discriminator is defined as `FederatedEventKind` (`export type FederatedEventKind = 'state' | 'reminder'`), sharing the exact enumeration values of `TaskEventKind`.

#### Canonical Binding Tuple
1. `domain_separator`: Constant string `"oae-federated-task-v1"`.
2. `task_id`: Canonical UUID string of the task (`packages/api/src/lib/tasks-internal.ts:1934`, `:1976`).
3. `event_kind`: Closed enum string: `"state"` | `"reminder"` (`packages/api/src/lib/tasks-internal.ts:99`).
4. `state`: TaskState string from canonical `TASK_STATES` (`packages/api/src/lib/tasks-internal.ts:56-57`).
5. `from`: Normalized sender email address (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`).
6. `to`: Normalized recipient email address (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`).
7. `subject`: Raw email subject string without modification (matching `MailStampFields.subject` in `packages/api/src/lib/mail-stamp.ts:33`, `:42`, and consumed for display in `packages/api/src/lib/tasks-internal.ts:1092`, `:1162`).
8. `timestamp`: ISO-8601 UTC timestamp string with milliseconds set to `000Z` (matching RFC 2822 date conversion in `packages/api/src/lib/mail-stamp.ts:34-35`, `:60`).
9. `expires_at`: ISO-8601 UTC timestamp string after which this task transition is invalid.
10. `body_hash`: SHA-256 length-prefixed hash over email body text and html, computed using the `mail-body-v2` specification (`packages/api/src/lib/mail-stamp.ts:21-23`, `:36-38`, `:92-102`).

#### Wire Timestamp Resolution vs. Replay Identity 4-Tuple
Wire timestamps in `X-OA-Federation-Timestamp` retain second resolution (`...000Z`) to ensure compatibility with RFC 2822 email Date headers (`packages/api/src/lib/mail-stamp.ts:34-35`, `:60`). To prevent false collisions between distinct legitimate events occurring within the same second for the same task (e.g. rapid valid state transitions), the in-memory replay deduplication cache indexes events by the complete 4-tuple:
`(task_id, event_kind, state, timestamp)`
The signed wire format remains unchanged, while replay verification is disambiguated by incorporating `state`.

#### Closed Enumeration & Deterministic Derivation for `(event_kind, state)`
- In `packages/api/src/lib/tasks-internal.ts:1060`, `:1171-1172`, `x-oa-task-event` distinguishes reminders from state transitions. In local task processing (`packages/api/src/lib/tasks-internal.ts:1172-1174`), the reminder stamp check does not strictly enforce `headerState === 'working'`.
- For federated tasks, this RFC introduces a stricter constraint [本 RFC 提议] (本 RFC 新增强制，严于本地行为):
  - If `X-OA-Task-Event` is `'reminder'`, `event_kind` MUST be `"reminder"`, and `state` MUST be `"working"`.
  - Otherwise, `event_kind` MUST be `"state"`, and `state` MUST be one of the five canonical states in `TASK_STATES` (`packages/api/src/lib/tasks-internal.ts:56`).
  - Any message presenting an inconsistent `(event_kind, state)` pairing (e.g. `event_kind: 'reminder'` with `state: 'submitted'`) MUST fail closed and return `null` (`packages/api/src/lib/tasks-internal.ts:1174`).

#### Strict Fail-Closed Closed Whitelist of Permitted Headers
The internal parser `parseTaskMessage()` inspects headers across multiple subsystems (`packages/api/src/lib/tasks-internal.ts:1056-1067`):
- Hierarchy: `x-oa-task-root`, `x-oa-task-parent`
- Approvals: `x-oa-task-approval-*`
- Leasing: `x-oa-task-lease-*`
- Idempotency: `x-oa-task-idempotency-key` (read at `packages/api/src/lib/tasks-internal.ts:1061`, exposed at `:1192`, consumed at `:2277`)
- Symmetric stamps: `X-OA-Task-Stamp`, `X-OA-Mail-Stamp` (`packages/api/src/lib/mail-stamp.ts:137`)

To prevent attackers from injecting unauthenticated extensions, bypassing ACLs, or exploiting legacy parser branches, **v1 enforces a strict closed whitelist of headers for federated task emails**. The ONLY permitted task and federation headers on incoming federated messages are:
1. `X-OA-Task`
2. `X-OA-Task-State`
3. `X-OA-Task-Event`
4. `X-OA-Federation-Version`
5. `X-OA-Federation-Origin`
6. `X-OA-Federation-Signature`
7. `X-OA-Federation-Timestamp`
8. `X-OA-Federation-Expires`
9. `X-OA-Federation-Key-Id` (optional)

**If an incoming external message carries ANY header starting with `X-OA-Task-*` or `X-OA-Federation-*` outside this closed whitelist, or ANY stamp header (`X-OA-Task-Stamp`, `X-OA-Mail-Stamp`), `parseTaskMessage()` MUST immediately fail closed and return `null`**. In particular, `x-oa-task-idempotency-key`, `x-oa-task-root`, `x-oa-task-parent`, `x-oa-task-approval-*`, `x-oa-task-lease-*`, and local stamp headers are unconditionally forbidden on federated mail.

#### Prohibition of Attachments
`hashMailBody()` (`packages/api/src/lib/mail-stamp.ts:92-102`) hashes only `text` and `html`; MIME attachments are not hashed. In v1, **federated task emails MUST NOT carry MIME attachments (`parsed.attachments.length === 0`)**. Any email carrying attachments is fail-closed rejected from task processing and demoted to ordinary mail. Task arguments and results are serialized directly into JSON code blocks within the message body (`resultBlock()`, `packages/api/src/lib/tasks-internal.ts:954-956`).

#### Canonical Framing (Length-Prefixed)
To eliminate field boundary ambiguity (`packages/api/src/lib/mail-stamp.ts:21-23`), the signed payload bytes are constructed using newline-separated length-prefixed UTF-8 segments:

```text
oae-federated-task-v1\n
len(task_id)\ntask_id\n
len(event_kind)\nevent_kind\n
len(state)\nstate\n
len(from)\nfrom\n
len(to)\nto\n
len(subject)\nsubject\n
len(timestamp)\ntimestamp\n
len(expires_at)\nexpires_at\n
len(body_hash)\nbody_hash\n
```

**Precise Framing Specification:**
1. **UTF-8 Byte-Length Semantics:** All `len(...)` prefixes are formatted as base-10 decimal ASCII strings representing the exact UTF-8 byte length (strictly equivalent to Node.js `Buffer.byteLength(value, 'utf8')` semantics), eliminating any ambiguity between Unicode codepoints, UTF-16 code units, and byte lengths.
2. **Segment Encoding Structure:** Each field in the canonical tuple is encoded as: decimal byte length + newline (`\n`) + UTF-8 byte string + newline (`\n`).
3. **Domain Separator and Trailing Newline:** The fixed domain separator string (`oae-federated-task-v1`) is followed immediately by a newline (`\n`), and the final field (`body_hash`) is likewise terminated with a trailing newline (`\n`).
4. **Deterministic Cross-Platform Reproducibility:** Any independent implementation conforming to this definition is guaranteed to construct byte-identical signed payloads (a canonical test vector will be provided with the implementation PR).

The sender signs these canonical bytes using its Ed25519 private key (RFC 8032:3).

### 5.3 Wire format in mail headers

When an OpenAgentEmail instance sends a federated task message across domain boundaries, it adds the following standard headers to the RFC 5322 MIME message:

```text
// Illustrative wire headers — not a reference implementation.
X-OA-Task: 7c9e6679-7425-40de-944b-e07fc1f90ae7
X-OA-Task-State: submitted
X-OA-Task-Event: state
X-OA-Federation-Version: 1
X-OA-Federation-Origin: alpha.example.com
X-OA-Federation-Key-Id: ed25519-2026-09
X-OA-Federation-Timestamp: 2026-09-19T21:00:00.000Z
X-OA-Federation-Expires: 2026-09-22T21:00:00.000Z
X-OA-Federation-Signature: v2=ed25519-2026-09.dGVzdHNpZ25hdHVyZWJhc2U2NHVybGZlZGVyYXRlZA
```

- `X-OA-Task`: The persistent task UUID (`packages/api/src/lib/tasks-internal.ts:906`).
- `X-OA-Task-State`: The state assertion (`packages/api/src/lib/tasks-internal.ts:907`).
- `X-OA-Task-Event`: Event kind (`state` | `reminder`, `packages/api/src/lib/tasks-internal.ts:99`).
- `X-OA-Federation-Version`: Protocol version (must be `1`).
- `X-OA-Federation-Origin`: Declared sender domain (must match sender email domain and discovery domain).
- `X-OA-Federation-Key-Id`: Optional standalone key identifier header. If present, it MUST strictly equal the embedded `<kid>` in `X-OA-Federation-Signature`. Senders MAY omit this header, relying on the embedded `<kid>` as the single canonical identifier.
- `X-OA-Federation-Timestamp`: UTC emission timestamp.
- `X-OA-Federation-Expires`: UTC expiry timestamp.
- `X-OA-Federation-Signature`: Signature envelope adhering to the RFC-0001 §7.6 versioned syntax: `v2=<kid>.<signature-base64url>` (`docs/rfcs/0001-outbound-webhooks.md:1260-1272`).

Notice that `X-OA-Task-Stamp` (the local symmetric stamp, `packages/api/src/lib/tasks-internal.ts:915`) is **deliberately omitted** on cross-domain outbound mail, strictly conforming to the anti-oracle rule (`packages/api/src/lib/mail-stamp.ts:151-171`).

### 5.4 Verification procedure

Incoming emails from IMAP execute verification within `parseTaskMessage()` (`packages/api/src/lib/tasks-internal.ts:1041-1180`) through the following sequential steps:

1. **Header Inspection, Local Invariant & Attachment Gating:**
   - Extract domain from sender address `from` (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`).
   - **Local Sender Invariant (Normative MUST):** If the `from` domain is in `config.allDomains` (`packages/api/src/lib/config.ts:440`), evaluate unconditionally under the existing local symmetric `taskStamp()` path (`packages/api/src/lib/tasks-internal.ts:1038`, `:1178-1179`), strictly ignoring any `X-OA-Federation-*` headers. Local identities NEVER use or trust asymmetric federation headers for intra-domain traffic.
   - For external senders (`from` domain not in `config.allDomains`):
     - Check if `X-OA-Federation-Signature` and `X-OA-Task` are present. If absent, treat strictly as non-federated ordinary mail (§5.5).
     - If present: verify that `parsed.attachments` is empty (`parsed.attachments.length === 0`). If attachments are present, fail closed (`return null`).
2. **Allowlist Gating:**
   - Check that `FEDERATION_ENABLED === true` and domain is an exact member of `FEDERATION_TRUSTED_DOMAINS`.
   - If not allowlisted: fail closed, strip task semantics, treat strictly as ordinary mail without initiating outbound network requests.
3. **Header Consistency, Key-ID Assertion & Closed Whitelist:**
   - Verify `X-OA-Federation-Origin` matches the domain of `from`.
   - Verify `X-OA-Federation-Version === '1'`.
   - Parse `v2=<kid>.<signature>` from `X-OA-Federation-Signature`.
   - If `X-OA-Federation-Key-Id` is present, assert `X-OA-Federation-Key-Id === kid`. Mismatch causes immediate fail-closed rejection.
   - **Enforce Closed Whitelist:** Verify that NO unlisted `X-OA-Task-*`, `X-OA-Federation-*`, or stamp headers (`X-OA-Task-Stamp`, `X-OA-Mail-Stamp`, `x-oa-task-idempotency-key`, `packages/api/src/lib/tasks-internal.ts:1061`, `:1192`, `:2277`) are present (§5.2). Any extra header causes immediate fail-closed rejection (`return null`).
4. **Temporal Freshness, Expiry Horizon & Replay Checks (Normative MUST):**
   - Parse `X-OA-Federation-Timestamp` ($T_{msg}$) and `X-OA-Federation-Expires` ($T_{exp}$).
   - Reject if $T_{msg} > \text{now} + \text{tolerance}$ (future clock skew, `FEDERATION_TIMESTAMP_TOLERANCE_SEC`, default 300s).
   - Reject if $\text{now} > T_{exp}$ (task message has expired).
   - **Non-Negative Validity Interval (Normative MUST):** Assert $T_{exp} \ge T_{msg}$. Reject any message where $T_{exp} < T_{msg}$ (fail-closed on inverted validity intervals, preventing negative intervals from bypassing horizon limits within clock skew tolerance windows).
   - **Mandatory Expiration Horizon (Normative MUST):** Assert $(T_{exp} - T_{msg}) \le \text{FEDERATION\_MAX\_EXPIRY\_SEC}$ (default `604800` seconds / 7 days). Reject any message with an excessively long validity window. Together with `FEDERATION_REPLAY_CACHE_MAX_ENTRIES = 10000`, this strictly bounds the retention window and memory footprint of the replay deduplication cache.
   - **Replay Deduplication:** Check bounded in-memory replay cache for `(task_id, event_kind, state, timestamp)`. If hit, drop idempotently.
   - **Monotonic Advancement for States and Reminders (Normative MUST) [本 RFC 提议]:**
     - For state advancements (`event_kind === 'state'`), assert that $T_{msg} > T_{\text{last\_state}}$ for that task. Reject out-of-order or stale transitions.
     - For reminders (`event_kind === 'reminder'`), assert that $T_{msg} > T_{\text{last\_reminder}}$ for that task. Reject stale or replayed reminders.
     Cryptographically enforcing timestamp monotonicity across both states and reminders eliminates historical replay vulnerabilities even after entries are evicted from the in-memory replay cache.
5. **Key Resolution via Strict Parameterized Fetcher:**
   - Query discovery cache for origin domain.
   - If `<kid>` is present in cache with `status: "revoked"`, fail closed immediately with `task_federation_key_untrusted` without triggering a re-fetch.
   - If cache miss, or if `<kid>` is unknown in cached document: perform rate-limited re-fetch using `federatedDiscoveryFetcher()` backed by `pinnedFetch` with `{ ssrfOptions: { publicEdge: true }, maxBytes: 10240, timeoutMs: 5000, deadlineMs: 5000 }` (§4.3). The re-fetched document MUST pass all strict checks (domain match, JSON schema, size limits, SSRF) before admission to cache.
   - Look up public key matching `<kid>`. If key not found (after re-fetch), or `status === "revoked"`, or current time outside `[validFrom, validUntil]`: fail closed with `task_federation_key_untrusted`.
6. **Cryptographic Signature Verification:**
   - Compute `body_hash` from received mail body text and html (`mail-body-v2`, `packages/api/src/lib/mail-stamp.ts:36-38`, `:92-102`).
   - Reconstruct canonical 10-element signed string (§5.2).
   - Verify Ed25519 signature over canonical UTF-8 bytes using resolved public key (RFC 8032:3).
   - If verification fails: log security alert (rate-limited, §5.5), drop task metadata, treat as ordinary mail.
7. **Task State Advancement:**
   - If verification succeeds, record `(task_id, event_kind, state, timestamp)` in replay cache.
   - Instantiate or advance task entity via `canAdvanceTask()` (`packages/api/src/lib/tasks-internal.ts:404`), recording origin domain and verification key ID in audit metadata.

### 5.5 Spoofing defense and handling ordinary emails with forged headers

Because SMTP is an open protocol, malicious external mail servers can send emails containing crafted `X-OA-Task-*` or `X-OA-Federation-*` headers.

#### Handling Rules
1. **Never Trust Unsigned Task Headers:** An email from an external domain that carries `X-OA-Task` but lacks a valid `X-OA-Federation-Signature` MUST NOT be parsed into a task (`packages/api/src/lib/tasks-internal.ts:1041-1180`). It MUST return `null` from `parseTaskMessage()`.
2. **Strict Demotion to Ordinary Mail:** The incoming email is still stored in the IMAP inbox for the recipient identity, but it possesses no task attributes, creates no task entry on the board, and cannot trigger agent wait-loops (`parseTaskMessage()` fails closed and returns `null` at `packages/api/src/lib/tasks-internal.ts:1041-1180`, specifically `:1179`, preventing task board hydration or `notifyTrustedTaskDelivery`).
3. **Closed Whitelist and No Internal Stamp Injection:** Inbound federated or external emails are NEVER assigned a local `X-OA-Task-Stamp` or `X-OA-Mail-Stamp` (`packages/api/src/lib/mail-stamp.ts:137`), and any external message carrying unlisted task headers (such as `x-oa-task-idempotency-key`, `packages/api/src/lib/tasks-internal.ts:1061`, `:1192`, `:2277`) or existing symmetric stamps MUST fail closed immediately.
4. **Security Audit Log with Domain-Level Rate Limiting and Summary Aggregation:** Whenever an email carrying task headers fails federated verification or arrives from an unlisted domain, a structured audit event `task_federation_spoof_attempt` is recorded (`packages/api/src/lib/audit.ts:117-142`). Because both sender domain and key ID can be forged or randomized by an adversary, rate-limiting MUST NOT rely on a composite `(sender_domain, kid)` key. Instead, rate-limiting is keyed strictly by `sender_domain` alongside a global token bucket ceiling (e.g. at most 10 audit events per minute across all spoof attempts). Events exceeding the limit are dropped from immediate detailed logging, counted, and periodically emitted as an aggregated summary event `task_federation_spoof_summary` (recording dropped count and domain), preserving forensic observability while preventing log rotation attacks against the 10MB `audit.jsonl` boundary (`packages/api/src/lib/audit.ts:94-112`).

---

## 6. Security boundary & threat model

### 6.1 Cross-domain trust model and threat boundaries

```text
+-----------------------+                         +-----------------------+
| Domain A (Sender)     |                         | Domain B (Receiver)   |
|  - Private Key (A)    | --- SMTP Transport ---> |  - Trusted Allowlist  |
|  - Public .well-known |     (Untrusted MTA)     |  - Resolves PubKey(A) |
+-----------------------+                         +-----------------------+
```

1. **Mutual Distrust:** Domains A and B share no private keys, database access, or admin tokens. Trust extends strictly to evaluating cryptographically signed task envelopes against allowlisted origins.
2. **Untrusted Intermediate MTAs:** SMTP hops and mail relays may inspect or reorder messages. End-to-end Ed25519 signing over length-prefixed bodies and headers ensures that any transit tampering by an intermediate MTA destroys the signature and triggers instant rejection.
3. **DMARC / SPF Defense-in-Depth:** In addition to application-layer Ed25519 signatures, deployments SHOULD enforce transport-layer email authentication (SPF / DKIM / DMARC `p=reject`, matching this repo's production posture).

### 6.2 Key compromise blast radius and mitigation

- **Compromise of Domain A's Private Key:**
  - Blast radius: The attacker can forge task state transitions claiming to originate from Domain A.
  - Containment: The attacker CANNOT forge tasks from Domain B, nor decrypt past tasks, nor compromise Domain B's internal database or symmetric `taskSigningSecret`.
  - Remediation & Revocation Propagation: Domain A updates its `.well-known/openagent-federation` document, marking the compromised key as `"revoked"` and publishing a fresh key pair. Without active intervention, verifier caches expire within `FEDERATION_DISCOVERY_CACHE_TTL_SEC` (default 3600s). For active defense, Domain B verifiers bypass cache strictly for unknown KIDs (per §4.4.6), and operators can invoke `POST /v1/federation/trusted-domains/:domain/refresh` to instantly revoke compromised keys.
- **Compromise of Local `TASK_SIGNING_SECRET`:**
  - Internal scope only: Affects internal domain stamps (`packages/api/src/lib/tasks-internal.ts:546`) and cursors (`packages/api/src/lib/task-cursor.ts:14`). Because federated tasks use Ed25519 asymmetric keys, a leak of `TASK_SIGNING_SECRET` does NOT compromise federated signatures if the Ed25519 private key is maintained separately.

### 6.3 Downgrade and refusal semantics (Fail-closed iron rule)

Every failure condition in the federation pipeline MUST fail closed:
- DNS resolution failure → REJECT task semantics.
- SSRF block triggered on `.well-known` fetch → REJECT task semantics.
- HTTP response timeout (>5,000 ms) → REJECT task semantics.
- Unknown or invalid algorithm in metadata → REJECT task semantics.
- Key ID mismatch → REJECT task semantics.
- Signature verification mismatch → REJECT task semantics.
- Expired timestamp → REJECT task semantics.
- Replay detected → REJECT / DROP idempotently.
- Attachments present → REJECT task semantics.
- Unlisted or unauthenticated headers (outside closed whitelist) → REJECT task semantics.

Under NO circumstances shall a failed federated task degrade to an unauthenticated task or bypass participant validation.

---

## 7. Configuration and deployment surface

### 7.1 Environment variables

Following repository conventions (`packages/api/src/lib/config.ts:1`, `:92-294`), all configuration settings are validated at import time via Zod:

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `FEDERATION_ENABLED` | `z.enum(['true', 'false'])` | `'false'` | Master switch for cross-domain federation. |
| `FEDERATION_TRUSTED_DOMAINS` | `string` (comma-separated) | `""` | Explicit list of allowlisted peer domains. |
| `FEDERATION_SIGNING_KEY_ID` | `string` (alphanumeric/hyphen) | `undefined` | Key identifier (`kid`) for local active signing key. |
| `FEDERATION_SIGNING_PRIVATE_KEY` | `string` (base64url or PKCS#8) | `undefined` | 32-byte Ed25519 private signing key. |
| `FEDERATION_DISCOVERY_CACHE_TTL_SEC`| `number` | `3600` | In-memory cache TTL for remote metadata. |
| `FEDERATION_TIMESTAMP_TOLERANCE_SEC`| `number` | `300` | Allowed clock skew window in seconds. |
| `FEDERATION_MAX_EXPIRY_SEC` | `number` | `604800` | Maximum validity lifetime window (7 days) for task envelopes. |
| `FEDERATION_REPLAY_CACHE_MAX_ENTRIES`| `number` | `10000` | In-memory bounded replay deduplication cache size. |

#### Boot-Time Validation
When `FEDERATION_ENABLED === 'true'`, boot-time validation strictly requires (`packages/api/src/lib/config.ts:414-428` precedent):
1. `FEDERATION_SIGNING_PRIVATE_KEY` MUST be provided and decode to a valid 32-byte Ed25519 private key.
2. `FEDERATION_SIGNING_KEY_ID` MUST be non-empty (1–64 characters).
3. `FEDERATION_TRUSTED_DOMAINS` MUST be non-empty and contain valid domain names without wildcards.
4. **Disjoint Domain Sets (Normative MUST):** The intersection between `FEDERATION_TRUSTED_DOMAINS` and `config.allDomains` (`packages/api/src/lib/config.ts:440`) MUST be strictly empty (`FEDERATION_TRUSTED_DOMAINS ∩ config.allDomains = ∅`). If any domain in `FEDERATION_TRUSTED_DOMAINS` is also present in `config.allDomains`, boot-time validation MUST fail closed and immediately throw a fatal error on startup, preventing route aliasing and self-federation.

If any check fails, the process terminates immediately on boot with an informative error rather than starting in an insecure state (`packages/api/src/lib/config.ts:354`, `:414-428`).

### 7.2 REST API proposals

#### Public Discovery Endpoint
- `GET /.well-known/openagent-federation`
  - Unauthenticated public endpoint (RFC 8615).
  - Returns the local deployment's discovery document with active public keys, capabilities, and key IDs.

#### Administrative Management Endpoints
Mounted under `/v1/federation` and gated by `requireAdmin` (`packages/api/src/routes/audit.ts:9`):
- `GET /v1/federation/trusted-domains`: Lists configured trusted domains and their current cached discovery status.
- `POST /v1/federation/trusted-domains`: Adds a new trusted domain to the runtime allowlist. **Validation Requirement (Normative MUST):** Runtime addition MUST strictly re-execute the boot-time domain validation rules specified in §7.1.4 on each candidate domain: the candidate domain MUST NOT intersect with `config.allDomains` (`packages/api/src/lib/config.ts:440`), MUST NOT contain wildcards, and MUST satisfy domain syntax and length constraints (`Buffer.byteLength(label) <= 63`, `packages/api/src/lib/config.ts:341-350`). Any violation MUST reject the request with HTTP 4xx, MUST NOT add the domain to the allowlist, and MUST NOT trigger any discovery fetch.
- `DELETE /v1/federation/trusted-domains/:domain`: Removes a trusted domain and flushes its cached metadata.
- `POST /v1/federation/trusted-domains/:domain/refresh`: Flushes cached discovery metadata for a domain and forces an immediate re-fetch via `federatedDiscoveryFetcher()`.
- `POST /v1/federation/test`: Tests discovery document retrieval and key parsing against a target domain without sending email, exercising `pinnedFetch()` with strict SSRF options and returning diagnostic results.

---

## 8. Open questions for the owner

The following design decisions are explicitly left open for owner and commander determination (Q-series). Per task instructions, these are enumerated without answers, to be ruled on during RFC review:

- **Q1: Key discovery protocol — DNS TXT vs HTTPS `.well-known`:** Should OpenAgentEmail support DNS TXT records (similar to DKIM / OpenPGP) as an alternative or fallback to HTTPS `.well-known/openagent-federation`? HTTPS provides structured JSON and capability negotiation, but DNS avoids outbound HTTP fetches and SSRF entirely.
- **Q2: Local mailbox mapping for external participants:** When an incoming federated task is addressed to a local identity (`agent@domain-b.org`) from an external identity (`creator@domain-a.com`), should the external identity be registered automatically into a read-only "federated contact" record in `identities.ts`, or should tasks allow arbitrary external email strings as long as the origin domain is trusted?
- **Q3: Envelope signing granularity — Whole-MIME DKIM alignment vs Custom Header Envelope:** Should federated task signing use standard ARC / DKIM signature headers (RFC 6376, RFC 8617) generated by the MTA, or should OpenAgentEmail maintain its own application-level `X-OA-Federation-Signature` headers independent of the underlying MTA transport?
- **Q4: Asymmetric encryption of task bodies:** Ed25519 provides signature authenticity and integrity, but does not provide end-to-end encryption across intermediate mail relays. Should RFC-0002 specify an X25519 key agreement scheme (RFC 8410) in Phase 2 for encrypting sensitive task arguments and results across domains?
- **Q5: Dynamic allowlist persistence without restarts:** Should dynamically added trusted domains (`POST /v1/federation/trusted-domains`) persist to a local JSONL file (following `notification-log.ts` / `audit.ts`), or should `FEDERATION_TRUSTED_DOMAINS` remain strictly immutable via environment variables to minimize mutable attack surfaces?
- **Q6: Maximum task expiration lifetime:** In v1, a mandatory global ceiling of $(T_{exp} - T_{msg}) \le \text{FEDERATION\_MAX\_EXPIRY\_SEC}$ (default 7 days) is enforced as a normative MUST alongside monotonic timestamp validation (§5.4). The remaining open question for the owner is whether domain operators should be allowed to negotiate tighter per-domain validity windows via discovery metadata (e.g. 24 hours), or if 7 days should remain the universal immutable ceiling.
- **Q7: Approval task cross-domain delegation:** Should `createApprovalTask()` (`packages/api/src/lib/tasks-internal.ts:1964`) allow cross-domain reviewers in v1, or should federated approvals be deferred to a follow-up RFC given that approvals can trigger external execution?
- **Q8: Multi-domain hosting and signature keys:** For OAE deployments configured with multiple domains (`config.extraDomains`, `packages/api/src/lib/config.ts:439`), should each domain have a distinct Ed25519 signing key, or should one primary key sign for all domains managed by the instance?
- **Q12: Limitations of second-resolution wire timestamps for strict total ordering (秒级 wire 时间戳作严格全序的局限):** In v1, timestamp monotonicity ($T_{msg} > T_{\text{last}}$, §5.4) relies on second-resolution UTC wire timestamps (`000Z`, §5.2). In environments permitting clock skew (`FEDERATION_TIMESTAMP_TOLERANCE_SEC = 300s`) or bursty event sequences where multiple transitions occur within the same second, a causally subsequent task event may arrive carrying $T_{msg} \le T_{\text{last\_state}}$ and be rejected as a false replay or stale transition. Should future iterations introduce a signed monotonic sequence counter, cryptographic nonce, or sub-second tie-breaker into the canonical binding tuple as the authoritative total ordering mechanism, or does wall-clock second precision remain sufficient for asynchronous email delivery? Left for owner determination.
- **Q13: Keyring configuration for rotation overlap (轮换重叠期的多密钥配置形态):** In §7.1, configuration defines a single `FEDERATION_SIGNING_PRIVATE_KEY` and `FEDERATION_SIGNING_KEY_ID`. However, §4.5 requires retired or revoked signing keys to remain advertised as `retired` or `revoked` for a minimum of 7 days to support verification retries and in-flight mail delivery. A single-key environment variable pair cannot express overlapping multi-key lifecycles. Whether OpenAgentEmail should adopt a JSON-formatted multi-key keyring in environment variables, a dedicated 0600-permission filesystem key directory, or a database-backed keystore is left for owner determination.
- **Q14: TOFU-over-HTTPS trust establishment and public key fingerprint pinning (TOFU-over-HTTPS 信任建立与公钥指纹钉扎):** Domain trust is established via HTTPS discovery on first contact (Trust On First Use / TOFU). The initial cold-cache fetch constitutes the single window required for an active attacker (via BGP hijacking, rogue Web PKI certificate misissuance, or DNS hijacking) to replace a remote domain's Ed25519 public key. Whether OpenAgentEmail should support cryptographic public key fingerprint pinning (TOFU-PIN) in `FEDERATION_TRUSTED_DOMAINS` (e.g. `domain:sha256-fingerprint`) or require explicit out-of-band initial fingerprint verification before admitting a domain is left for owner determination.

### 8.1 Known integration gaps (已知集成缺口)

以下三项为 **RFC 未定义、需业主定方向的集成层缺口**——v1 实现者不得照本 RFC 对这三处自行发挥：

- **Q9: Outbound federated event local persistence (出站联邦事件的本地持久化):** When an agent initiates or advances a federated task, outbound emails sent via SMTP do not automatically appear in the sender's own IMAP mailbox. This is fundamentally incompatible with OpenAgentEmail's storage model, where task states and message threads are reconstructed by scanning IMAP mailboxes (`packages/api/src/lib/tasks-internal.ts:1235`), and in-memory synthetic task bases survive for only 60 seconds (`packages/api/src/lib/tasks-internal.ts:2043`, `:2065`). How local outbound copies are captured (e.g. SMTP Bcc to self, IMAP append to Sent folder, or independent durable storage) is undefined. This cannot be decided within this document because selecting a persistence strategy alters global mail flow, quota assumptions, and IMAP synchronization semantics across the entire platform.
- **Q10: Federated task creation gate (联邦任务的创建门):** The task creation endpoint `POST /v1/tasks` currently enforces that both participants MUST be known local identities managed by the local instance (`packages/api/src/routes/tasks.ts:168-175`, `known()`, rejecting external domains with HTTP 403 `forbidden: task participants must be known identities`). How an allowlisted remote domain recipient passes this creation gate is undefined. This cannot be decided within this document because relaxing participant gating directly affects multi-tenant isolation, authorization policy, and identity creation boundaries across the REST API.
- **Q11: Separation of replay defense from storage reconstruction (重放防线与存储重建的分离):** `parseTaskMessage()` is reused repeatedly across offline storage scans, board re-indexing, and startup recovery via `scanDurableTasks()` and `findTaskMessages()` (`packages/api/src/lib/tasks-internal.ts:1235`). If the replay deduplication tuple `(task_id, event_kind, state, timestamp)` is recorded indiscriminately inside `parseTaskMessage()`, re-scanning the same stored message UID on subsequent iterations would classify legitimate historical messages as replays and drop them, causing existing tasks to disappear from the board. How the verification layer cleanly distinguishes initial ingress delivery from storage-layer reconstruction is undefined. This cannot be decided within this document because it requires restructuring the core mailbox processing pipeline and separating transport admission from idempotent event playback.
