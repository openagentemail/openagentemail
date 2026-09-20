# RFC-0002: Federated signed tasks

- **Status:** **Proposed** — draft for owner ratification.
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

OpenAgentEmail today restricts task coordination to **a single local domain** (`packages/api/src/lib/tasks-internal.ts:1954-1960`). While email as a transport layer is inherently federated and global over SMTP (RFC 5322), two independent OpenAgentEmail deployments cannot exchange structured, authenticated tasks with each other.

The root cause is cryptographic: task integrity and authenticity currently depend on symmetric HMAC-SHA256 stamps (`packages/api/src/lib/tasks-internal.ts:545-549`, `taskStamp()`) computed from a shared secret (`packages/api/src/lib/config.ts:434`, `config.taskSigningSecret`). Verifying a symmetric stamp across domains would require sharing that secret, which collapses tenant isolation and creates a fatal HMAC oracle hazard (`packages/api/src/lib/mail-stamp.ts:12-14`, `:171`).

This RFC proposes **federated signed tasks** across independent OpenAgentEmail domains, divided into two phased capabilities [本 RFC 提议]:

1. **Phase 1: Discovery & Trust:** standardizing `.well-known/openagent-federation` metadata on each deployment domain (RFC 8615), advertising active Ed25519 public signing keys, key IDs, protocol versions, and capabilities, paired with an explicit, closed-by-default trusted-domain allowlist and bounded-cache lifecycle [本 RFC 提议].
2. **Phase 2: Signed Task Envelopes:** establishing asymmetric cryptographic task envelopes signed by the originating domain's private key using Ed25519 (RFC 8032), binding immutable task attributes (task ID, event kind, state, sender, recipient, timestamp, expiry, and body hash) into an unforgeable wire format, with strict fail-closed verification rules that cleanly reject forged `X-OA-Task-*` headers from untrusted or ordinary external mail [本 RFC 提议].

The design deliberately reuses four hardened subsystems already established in this repository:

| Need | Existing subsystem to reuse | Reference |
| --- | --- | --- |
| Safe egress & SSRF defense | Single shared IP policy + connect-time pinned DNS fetcher | `packages/api/src/lib/net.ts:1-10`, `packages/api/src/lib/oauth-cimd.ts:331-381` |
| Length-prefixed payload hashing | Length-prefixed string hashing eliminating field-boundary ambiguity | `packages/api/src/lib/mail-stamp.ts:21-23`, `:36-38` |
| Constant-time verification | Constant-time cryptographic verification failing closed | `packages/api/src/lib/mail-stamp.ts:115` (`timingSafeEqual`) |
| Structured audit & health logging | Append-only bounded audit log with strict field allowlist | `packages/api/src/lib/audit.ts:38-50` |

RFC-0001 explicitly reserved cross-domain federation (#59) as out of scope (`docs/rfcs/0001-outbound-webhooks.md:16-17`, `:101-104`), while establishing a versioned signature header prefix (`v2=<kid>.<sig>`) designed specifically so that asymmetric federated signing would be additive rather than breaking (`docs/rfcs/0001-outbound-webhooks.md:1254-1273`). This RFC completes that architectural commitment.

---

## 2. Goals and non-goals

### 2.1 Goals

1. **Cross-domain task exchange:** Allow autonomous agents operating on distinct OAE instances (e.g. `agent@domain-a.com` and `reviewer@domain-b.org`) to submit, advance, approve, and complete tasks over standard email transport [本 RFC 提议].
2. **Phase 1 metadata discovery:** Provide standardized discovery at `https://<domain>/.well-known/openagent-federation` advertising domain identity, active Ed25519 public keys, key IDs, and capabilities (RFC 8615) [本 RFC 提议].
3. **Phase 2 asymmetric envelope signing:** Sign cross-domain task emails using Ed25519 (RFC 8032) under the sending domain's private key, ensuring non-repudiation, origin authenticity, and message integrity [本 RFC 提议].
4. **Strict explicit allowlist (default closed):** Out-of-the-box federation is disabled (`FEDERATION_ENABLED=false`). When enabled, federation is permitted only with domains explicitly enumerated in `FEDERATION_TRUSTED_DOMAINS` [本 RFC 提议].
5. **Robust anti-spoofing:** External emails carrying forged `X-OA-Task-*` headers without a valid federated signature from an allowlisted domain MUST be discarded as tasks and treated strictly as ordinary mail (`packages/api/src/lib/tasks-internal.ts:1041-1180`) [本 RFC 提议].
6. **Bounded cache & safe rotation:** Cache remote discovery metadata with bounded in-memory capacity and strict TTLs, supporting zero-downtime key rotation with multi-key overlap [本 RFC 提议].
7. **SSRF immunity:** Re-check all remote metadata fetches through the repo's mandatory shared IP policy (`packages/api/src/lib/net.ts:1-10`) and DNS-pinned fetcher (`packages/api/src/lib/oauth-cimd.ts:331-381`).
8. **Backward compatibility:** Intra-domain tasks between local identities continue to use the existing symmetric HMAC stamp mechanism (`packages/api/src/lib/tasks-internal.ts:545-549`) without runtime disruption or secret migration.

### 2.2 Non-goals (explicit)

1. **No cross-domain task leasing:** Distributed leasing (`TASK_LEASES_ENABLED`, `packages/api/src/lib/task-lease-journal.ts:28`, `docs/task-lease-journal.md:1-50`) requires single-host authoritative serialized journals. Cross-domain distributed locking or distributed consensus is explicitly excluded.
2. **No distributed two-phase commit:** Tasks communicate asynchronously across domains via message exchange; there is no distributed transaction manager or synchronous consensus across deployments.
3. **No inbound HTTP task injection:** Federated tasks are transported via email (SMTP/IMAP) so that all standard MTA audit trails, DMARC/SPF checks, and delivery guarantees apply. HTTP endpoints are used solely for metadata discovery.
4. **No auto-reply or LLM responder engine:** Automatic task dispatching, prompt processing, and autonomous agent loops remain separate concerns (#105, `docs/rfcs/0001-outbound-webhooks.md:96-100`).
5. **No centralized PKI or CA hierarchy:** Trust is established directly between domain operators via DNS/HTTPS trust anchors and explicit configuration, avoiding external certificate authorities or proprietary centralized registries.

---

## 3. Background: The local-domain restriction and its rationale

### 3.1 The current task stamp mechanism

Within a single deployment, tasks progress through a state machine (`submitted` → `working` → `completed` | `failed` | `input-required`, `packages/api/src/lib/tasks-internal.ts:24-30`).

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
- Each domain possesses a **private signing key** kept strictly within its own boundary [本 RFC 提议].
- Each domain advertises its **public verification key** via HTTPS discovery [本 RFC 提议].
- Receiving domains verify signatures using the sender's public key without possessing or needing the sender's private key (RFC 8032:3) [本 RFC 提议].

RFC-0001 §7.6 explicitly anticipated this design (`docs/rfcs/0001-outbound-webhooks.md:1268-1272`):
> *"Forward compatibility with #59 is the reason for the prefix. Federation needs asymmetric signatures with key ids and `.well-known` discovery. An asymmetric scheme slots into the same header as `v2=<kid>.<sig>` without changing the envelope, the timestamp binding, or any consumer's routing logic."*

This RFC realizes the exact architecture forecast in RFC-0001.

---

## 4. Phase 1: Federated discovery & trust

Phase 1 defines how independent OpenAgentEmail instances discover and establish cryptographic trust with remote domains.

### 4.1 Discovery document specification

Each participating domain MUST publish its federation metadata document at a standardized well-known URI (RFC 8615) [本 RFC 提议]:

```text
https://<domain>/.well-known/openagent-federation
```

#### Acceptance and Transport Rules
1. **HTTPS Only:** The document MUST be fetched over TLS on port 443. Plain HTTP is unconditionally refused [本 RFC 提议].
2. **Content-Type:** The response MUST have `Content-Type: application/json` (RFC 8259) [本 RFC 提议].
3. **Response Bound:** The response body MUST NOT exceed 10 KiB (`FEDERATION_DISCOVERY_MAX_BYTES = 10240`), enforced via streaming truncation to defeat memory exhaustion attacks [本 RFC 提议].
4. **No Redirects:** HTTP 3xx redirects MUST NOT be followed (`redirect: 'manual'`, matching the CIMD precedent in `packages/api/src/lib/oauth-cimd.ts:526-543`) [本 RFC 提议].

#### Schema
The document payload contains the following top-level JSON structure [本 RFC 提议]:

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
    "task.v1",
    "approval.v1"
  ],
  "policy": {
    "taskExpiryMaxSec": 604800
  }
}
```

- `federationVersion`: Integer schema version. Bumping is required only for breaking schema changes [本 RFC 提议].
- `domain`: Canonical lowercase domain name of the hosting deployment. MUST match the request hostname exactly; mismatch causes rejection [本 RFC 提议].
- `publicKeys`: Array of public keys. Each entry MUST provide:
  - `kid`: Key identifier string (1–64 alphanumeric / hyphen characters) [本 RFC 提议].
  - `algorithm`: Must be `"Ed25519"` for v1 (RFC 8032) [本 RFC 提议].
  - `publicKey`: Base64url-encoded 32-byte Ed25519 public key without padding (RFC 8032:3, RFC 8410:2) [本 RFC 提议].
  - `status`: `"active"` (may sign and verify), `"retired"` (verify only, no new signatures), or `"revoked"` (must not verify) [本 RFC 提议].
  - `validFrom` / `validUntil`: ISO-8601 UTC validity window [本 RFC 提议].
- `capabilities`: Array of supported task protocols [本 RFC 提议].

### 4.2 Explicit trusted-domain allowlist (default closed)

Federation across the public internet introduces foreign input into internal agent workflows. OpenAgentEmail mandates a **closed-by-default trust model** [本 RFC 提议]:

1. **Default Off:** Federation is globally disabled by default (`FEDERATION_ENABLED=false`) [本 RFC 提议].
2. **Explicit Allowlist Required:** When `FEDERATION_ENABLED=true`, the operator MUST configure `FEDERATION_TRUSTED_DOMAINS` [本 RFC 提议].
3. **No Wildcard Matching:** Domains must match explicitly (e.g. `partner.org`). Wildcards (such as `*.partner.org`) are rejected at boot time to prevent subdomain takeover bypasses [本 RFC 提议].
4. **Unconditional Dropping:** Inbound emails originating from domains not present in `FEDERATION_TRUSTED_DOMAINS` MUST NEVER initiate metadata discovery or trigger external HTTP fetches; their task headers are discarded immediately [本 RFC 提议].

### 4.3 Discovery fetcher and SSRF protection

Fetching `.well-known/openagent-federation` documents requires making outbound HTTP requests based on domain names found in email headers. This creates a severe Server-Side Request Forgery (SSRF) and DNS rebinding risk.

This RFC mandates the **direct reuse of the repository's single shared SSRF defense** (`packages/api/src/lib/net.ts:1-10`, `packages/api/src/lib/oauth-cimd.ts:331-381`):

1. **Connect-time IP Validation:** Remote fetches MUST use `pinnedCimdFetcher()` (`packages/api/src/lib/oauth-cimd.ts:331-381`), which executes DNS resolution and verifies every resolved `A` and `AAAA` record inside the Node/Bun socket `lookup` hook before connecting.
2. **Blocked IP Ranges:** All addresses in `isBlockedSsrfIp()` (`packages/api/src/lib/net.ts:156`) and `isSsrfBlockedResolvedIp()` (`packages/api/src/lib/net.ts:225`) are blocked, including loopback, RFC 1918, CGNAT, link-local, AWS IMDS (`169.254.169.254` and `fd00:ec2::/16`), and IPv4-mapped IPv6 ranges (`net.ts:126`).
3. **Edge Enforcement:** If `OAE_PUBLIC_EDGE=true` (`packages/api/src/lib/config.ts:432`), private IP exceptions are unconditionally forbidden (`packages/api/src/lib/net.ts:8`, `:24-26`).
4. **Timeout:** Connect and read timeout is hard-capped at 5,000 ms [本 RFC 提议].

### 4.4 Discovery cache lifecycle

To protect against availability degradation and Denial-of-Service attacks from repeated remote HTTP lookups, discovery documents MUST be cached in memory [本 RFC 提议]:

1. **Cache Structure:** An in-memory LRU cache storing parsed discovery documents, indexed by lowercase domain name [本 RFC 提议].
2. **Capacity Bound:** The cache size is hard-capped at `FEDERATION_DISCOVERY_CACHE_MAX_ENTRIES = 500` [本 RFC 提议].
3. **Time-To-Live (TTL):** Cached entries expire after `FEDERATION_DISCOVERY_CACHE_TTL_SEC` (default `3600` seconds / 1 hour) [本 RFC 提议].
4. **Negative Caching:** When discovery fails (e.g. DNS failure, HTTP 404/500, SSRF violation, invalid JSON), a negative entry is cached for `FEDERATION_DISCOVERY_NEGATIVE_TTL_SEC = 60` seconds to prevent request hammering against faulty peers [本 RFC 提议].
5. **Purge on Reboot:** The cache is memory-only; a process restart starts with a cold cache by design (`packages/api/src/lib/ratelimit.ts:26-30` precedent).

### 4.5 Key rotation and safe transition

Key rotation must occur without dropping in-flight messages or invalidating recent tasks:

1. **Multi-Key Overlap:** An operator rotating their signing key generates a new Ed25519 key pair, assigns a new `kid`, and publishes both the new key (`status: "active"`) and the old key (`status: "retired"`) in `.well-known/openagent-federation` [本 RFC 提议].
2. **Overlap Horizon:** The retiring key MUST remain advertised as `"retired"` for a minimum of 7 days to cover delayed or retried email deliveries [本 RFC 提议].
3. **Key Identifier Resolution:** The verifier matches the `kid` specified in the incoming task envelope (`X-OA-Federation-Key-Id`) against the keys present in the sender domain's cached discovery document [本 RFC 提议].
4. **Emergency Revocation:** If a private key is compromised, the operator immediately marks `status: "revoked"` in their discovery document. Verifiers receiving `"revoked"` keys immediately fail signature verification, rejecting any further tasks claiming that key [本 RFC 提议].

---

## 5. Phase 2: Signed task envelopes

Phase 2 specifies the cryptographic envelope, wire headers, and verification rules for cross-domain task messages.

### 5.1 Asymmetric signature scheme

- **Algorithm:** `Ed25519` (RFC 8032 PureEdDSA Ed25519; RFC 8410:2) [本 RFC 提议].
- **Rationale:**
  - **Compact wire footprint:** 32-byte public keys and 64-byte signatures minimize email header overhead (RFC 8032:3) [本 RFC 提议].
  - **Deterministic signing:** Ed25519 generates deterministic signatures without a per-message random nonce, eliminating private key leakage via bad random number generators (RFC 8032:3).
  - **High verification performance:** Sub-millisecond verification prevents DoS bottlenecks on high-volume email ingress (RFC 8032:3).
  - **Precedent in modern email & identity standards:** Broadly adopted across DKIM, SSH, and modern webhooks (e.g. SendGrid outbound event webhooks, `docs/rfcs/0001-outbound-webhooks.md:586-594`).
- **Signature Encoding:** Raw 64-byte signature encoded as base64url without padding [本 RFC 提议].

### 5.2 Signed string and canonical binding tuple

To guarantee that signatures cannot be transplanted between different tasks, states, actors, or timestamps, the signature MUST bind the following canonical tuple [本 RFC 提议]:

1. `domain_separator`: Constant string `"oae-federated-task-v1"` [本 RFC 提议].
2. `task_id`: Canonical UUID string of the task (`packages/api/src/lib/tasks-internal.ts:1934`, `:1976`) [本 RFC 提议].
3. `event_kind`: Task event kind string (`"submitted"`, `"working"`, `"completed"`, `"failed"`, `"input-required"`, `"approval"`, `packages/api/src/lib/tasks-internal.ts:24-30`) [本 RFC 提议].
4. `state`: TaskState string (`packages/api/src/lib/tasks-internal.ts:24`) [本 RFC 提议].
5. `from`: Normalized sender email address (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`) [本 RFC 提议].
6. `to`: Normalized recipient email address (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`) [本 RFC 提议].
7. `timestamp`: ISO-8601 UTC timestamp string with milliseconds set to `000Z` (matching RFC 2822 date conversion in `packages/api/src/lib/mail-stamp.ts:34-35`, `:60`) [本 RFC 提议].
8. `expires_at`: ISO-8601 UTC timestamp string after which this task transition is invalid [本 RFC 提议].
9. `body_hash`: SHA-256 length-prefixed hash over email body text and html, computed using the `mail-body-v2` specification (`packages/api/src/lib/mail-stamp.ts:21-23`, `:36-38`) [本 RFC 提议].

#### Canonical Framing (Length-Prefixed)
To eliminate field boundary ambiguity (`packages/api/src/lib/mail-stamp.ts:21-23`), the signed payload bytes are constructed using newline-separated length-prefixed UTF-8 segments [本 RFC 提议]:

```text
oae-federated-task-v1
len(task_id)\ntask_id
len(event_kind)\nevent_kind
len(state)\nstate
len(from)\nfrom
len(to)\nto
len(timestamp)\ntimestamp
len(expires_at)\nexpires_at
len(body_hash)\nbody_hash
```

The sender signs these canonical bytes using its Ed25519 private key (RFC 8032:3) [本 RFC 提议].

### 5.3 Wire format in mail headers

When an OpenAgentEmail instance sends a federated task message across domain boundaries, it adds the following standard headers to the RFC 5322 MIME message [本 RFC 提议]:

```text
// Illustrative wire headers — not a reference implementation.
X-OA-Task: 7c9e6679-7425-40de-944b-e07fc1f90ae7
X-OA-Task-State: submitted
X-OA-Federation-Version: 1
X-OA-Federation-Origin: alpha.example.com
X-OA-Federation-Key-Id: ed25519-2026-09
X-OA-Federation-Timestamp: 2026-09-19T21:00:00.000Z
X-OA-Federation-Expires: 2026-09-22T21:00:00.000Z
X-OA-Federation-Signature: v2=ed25519-2026-09.dGVzdHNpZ25hdHVyZWJhc2U2NHVybGZlZGVyYXRlZA
```

- `X-OA-Task`: The persistent task UUID (`packages/api/src/lib/tasks-internal.ts:906`).
- `X-OA-Task-State`: The state assertion (`packages/api/src/lib/tasks-internal.ts:907`).
- `X-OA-Federation-Version`: Protocol version (must be `1`) [本 RFC 提议].
- `X-OA-Federation-Origin`: Declared sender domain (must match sender email domain and discovery domain) [本 RFC 提议].
- `X-OA-Federation-Key-Id`: Key identifier used to sign [本 RFC 提议].
- `X-OA-Federation-Timestamp`: UTC emission timestamp [本 RFC 提议].
- `X-OA-Federation-Expires`: UTC expiry timestamp [本 RFC 提议].
- `X-OA-Federation-Signature`: Signature envelope adhering to the RFC-0001 §7.6 versioned syntax: `v2=<kid>.<signature-base64url>` (`docs/rfcs/0001-outbound-webhooks.md:1260-1272`) [本 RFC 提议].

Notice that `X-OA-Task-Stamp` (the local symmetric stamp, `packages/api/src/lib/tasks-internal.ts:915`) is **deliberately omitted** on cross-domain outbound mail, strictly conforming to the anti-oracle rule (`packages/api/src/lib/mail-stamp.ts:151-171`) [本 RFC 提议].

### 5.4 Verification procedure

Incoming emails from IMAP (`packages/api/src/lib/notification-watcher.ts:1602`, `packages/api/src/lib/tasks-internal.ts:1041`) execute the following verification steps sequentially [本 RFC 提议]:

1. **Header Inspection:**
   - Check if `X-OA-Federation-Signature` and `X-OA-Task` are present.
   - If absent:
     - If `from` domain is in `config.allDomains` (`packages/api/src/lib/config.ts:440`), evaluate under the existing local `taskStamp()` path (`packages/api/src/lib/tasks-internal.ts:1038`, `:1178-1179`).
     - If `from` domain is external, treat as non-federated ordinary mail (§5.5) [本 RFC 提议].
2. **Allowlist Gating:**
   - Extract domain from sender address `from` (`normalizeMailbox()`, `packages/api/src/lib/mail-stamp.ts:48-53`).
   - Check that `FEDERATION_ENABLED === true` and domain is an exact member of `FEDERATION_TRUSTED_DOMAINS`.
   - If not allowlisted: fail closed, strip task semantics, treat strictly as ordinary mail [本 RFC 提议].
3. **Header Consistency:**
   - Verify `X-OA-Federation-Origin` matches the domain of `from` [本 RFC 提议].
   - Verify `X-OA-Federation-Version === '1'` [本 RFC 提议].
   - Parse `v2=<kid>.<signature>` from `X-OA-Federation-Signature` [本 RFC 提议].
4. **Temporal Freshness and Expiry Check:**
   - Parse `X-OA-Federation-Timestamp` ($T_{msg}$) and `X-OA-Federation-Expires` ($T_{exp}$).
   - Reject if $T_{msg} > \text{now} + \text{tolerance}$ (future clock skew, `FEDERATION_TIMESTAMP_TOLERANCE_SEC`, default 300s) [本 RFC 提议].
   - Reject if $\text{now} > T_{exp}$ (task message has expired) [本 RFC 提议].
5. **Key Resolution:**
   - Query discovery cache for origin domain. On cache miss, fetch `https://<origin>/.well-known/openagent-federation` via `pinnedCimdFetcher()` (§4.3) [本 RFC 提议].
   - Look up public key matching `<kid>` [本 RFC 提议].
   - If key not found, or `status === "revoked"`, or current time outside `[validFrom, validUntil]`: fail closed with `task_federation_key_untrusted` [本 RFC 提议].
6. **Cryptographic Signature Verification:**
   - Compute `body_hash` from the received mail body text and html (`mail-body-v2`, `packages/api/src/lib/mail-stamp.ts:36-38`).
   - Reconstruct canonical signed string (§5.2) [本 RFC 提议].
   - Verify Ed25519 signature over the canonical UTF-8 bytes using the resolved public key (RFC 8032:3).
   - If verification fails: log security alert, drop task metadata, treat as ordinary mail [本 RFC 提议].
7. **Task State Advancement:**
   - If verification succeeds, instantiate or update the task entity via `canAdvanceTask()` (`packages/api/src/lib/tasks-internal.ts:9`), recording the origin domain and verification key ID in audit metadata [本 RFC 提议].

### 5.5 Spoofing defense and handling ordinary emails with forged headers

Because SMTP is an open protocol, malicious or compromised external mail servers can send emails containing crafted `X-OA-Task-*` or `X-OA-Federation-*` headers.

#### Handling Rules
1. **Never Trust Unsigned Task Headers:** An email from an external domain that carries `X-OA-Task` but lacks a valid `X-OA-Federation-Signature` MUST NOT be parsed into a task (`packages/api/src/lib/tasks-internal.ts:1041-1180`). It MUST return `null` from `parseTaskMessage()` [本 RFC 提议].
2. **Strict Demotion to Ordinary Mail:** The incoming email is still stored in the IMAP inbox for the recipient identity, but it possesses no task attributes, creates no task entry on the board, and cannot trigger agent wait-loops (`packages/api/src/lib/tasks-internal.ts:1945-1947`) [本 RFC 提议].
3. **No Internal Stamp Injection:** Inbound federated or external emails are NEVER assigned a local `X-OA-Task-Stamp` or `X-OA-Mail-Stamp` (`packages/api/src/lib/mail-stamp.ts:137`), preventing elevation of privilege inside the local database [本 RFC 提议].
4. **Security Audit Log:** Whenever an email carrying `X-OA-Task-*` headers fails federated signature verification or arrives from an unlisted domain, a structured audit event `task_federation_spoof_attempt` is recorded (`packages/api/src/lib/audit.ts:309`) [本 RFC 提议].

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

1. **Mutual Distrust:** Domains A and B share no private keys, database access, or admin tokens. Trust extends strictly to evaluating cryptographically signed task envelopes against allowlisted origins [本 RFC 提议].
2. **Untrusted Intermediate MTAs:** SMTP hops and mail relays may inspect or reorder messages. End-to-end Ed25519 signing over length-prefixed bodies and headers ensures that any transit tampering by an intermediate MTA destroys the signature and triggers instant rejection [本 RFC 提议].
3. **DMARC / SPF Defense-in-Depth:** In addition to application-layer Ed25519 signatures, deployments SHOULD enforce transport-layer email authentication (SPF / DKIM / DMARC `p=reject`, matching this repo's production posture per `STATUS.md:26`).

### 6.2 Key compromise blast radius and mitigation

- **Compromise of Domain A's Private Key:**
  - Blast radius: The attacker can forge task state transitions claiming to originate from Domain A.
  - Containment: The attacker CANNOT forge tasks from Domain B, nor decrypt past tasks, nor compromise Domain B's internal database or symmetric `taskSigningSecret` [本 RFC 提议].
  - Remediation: Domain A updates its `.well-known/openagent-federation` document, marking the compromised key as `"revoked"` and publishing a fresh key pair. Domain B flushes its discovery cache or waits for negative cache expiry (maximum 60s) to block all forged signatures immediately [本 RFC 提议].
- **Compromise of Local `TASK_SIGNING_SECRET`:**
  - Internal scope only: Affects internal domain stamps (`packages/api/src/lib/tasks-internal.ts:546`) and cursors (`packages/api/src/lib/task-cursor.ts:14`). Because federated tasks use Ed25519 asymmetric keys, a leak of `TASK_SIGNING_SECRET` does NOT compromise federated signatures if the Ed25519 private key is maintained separately [本 RFC 提议].

### 6.3 Downgrade and refusal semantics (Fail-closed iron rule)

Every failure condition in the federation pipeline MUST fail closed [本 RFC 提议]:
- DNS resolution failure → REJECT task semantics [本 RFC 提议].
- SSRF block triggered on `.well-known` fetch → REJECT task semantics [本 RFC 提议].
- HTTP response timeout (>5,000 ms) → REJECT task semantics [本 RFC 提议].
- Unknown or invalid algorithm in metadata → REJECT task semantics [本 RFC 提议].
- Key ID mismatch → REJECT task semantics [本 RFC 提议].
- Signature verification mismatch → REJECT task semantics [本 RFC 提议].
- Expired timestamp → REJECT task semantics [本 RFC 提议].

Under NO circumstances shall a failed federated task degrade to an unauthenticated task or bypass participant validation [本 RFC 提议].

---

## 7. Configuration and deployment surface

### 7.1 Environment variables

Following repository conventions (`packages/api/src/lib/config.ts:15`, `:91-230`), all configuration settings are validated at import time via Zod [本 RFC 提议]:

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `FEDERATION_ENABLED` | `z.enum(['true', 'false'])` | `'false'` | Master switch for cross-domain federation [本 RFC 提议]. |
| `FEDERATION_TRUSTED_DOMAINS` | `string` (comma-separated) | `""` | Explicit list of allowlisted peer domains [本 RFC 提议]. |
| `FEDERATION_SIGNING_KEY_ID` | `string` (alphanumeric/hyphen) | `undefined` | Key identifier (`kid`) for local active signing key [本 RFC 提议]. |
| `FEDERATION_SIGNING_PRIVATE_KEY` | `string` (base64url or PKCS#8) | `undefined` | 32-byte Ed25519 private signing key [本 RFC 提议]. |
| `FEDERATION_DISCOVERY_CACHE_TTL_SEC`| `number` | `3600` | In-memory cache TTL for remote metadata [本 RFC 提议]. |
| `FEDERATION_TIMESTAMP_TOLERANCE_SEC`| `number` | `300` | Allowed clock skew window in seconds [本 RFC 提议]. |

#### Boot-Time Validation
When `FEDERATION_ENABLED === 'true'`, boot-time validation strictly requires (`packages/api/src/lib/config.ts:414-424` precedent) [本 RFC 提议]:
1. `FEDERATION_SIGNING_PRIVATE_KEY` MUST be provided and decode to a valid 32-byte Ed25519 private key [本 RFC 提议].
2. `FEDERATION_SIGNING_KEY_ID` MUST be non-empty (1–64 characters) [本 RFC 提议].
3. `FEDERATION_TRUSTED_DOMAINS` MUST be non-empty and contain valid domain names without wildcards [本 RFC 提议].

If any check fails, the process terminates immediately on boot with an informative error rather than starting in an insecure state (`packages/api/src/lib/config.ts:345`).

### 7.2 REST API proposals

#### Public Discovery Endpoint
- `GET /.well-known/openagent-federation`
  - Unauthenticated public endpoint (RFC 8615) [本 RFC 提议].
  - Returns the local deployment's discovery document with active public keys, capabilities, and key IDs [本 RFC 提议].

#### Administrative Management Endpoints
Mounted under `/v1/federation` and gated by `requireAdmin` (`packages/api/src/routes/audit.ts:9`):
- `GET /v1/federation/trusted-domains`: Lists configured trusted domains and their current cached discovery status [本 RFC 提议].
- `POST /v1/federation/trusted-domains`: Adds a new trusted domain to the runtime allowlist [本 RFC 提议].
- `DELETE /v1/federation/trusted-domains/:domain`: Removes a trusted domain and flushes its cached metadata [本 RFC 提议].
- `POST /v1/federation/test`: Tests discovery document retrieval and key parsing against a target domain without sending email, exercising `pinnedCimdFetcher()` and returning diagnostic results [本 RFC 提议].

---

## 8. Open questions for the owner

The following design decisions are explicitly left open for owner and commander determination (Q-series). Per task instructions, these are enumerated without answers, to be ruled on during RFC review:

- **Q1: Key discovery protocol — DNS TXT vs HTTPS `.well-known`:** Should OpenAgentEmail support DNS TXT records (similar to DKIM / OpenPGP) as an alternative or fallback to HTTPS `.well-known/openagent-federation`? HTTPS provides structured JSON and capability negotiation, but DNS avoids outbound HTTP fetches and SSRF entirely.
- **Q2: Local mailbox mapping for external participants:** When an incoming federated task is addressed to a local identity (`agent@domain-b.org`) from an external identity (`creator@domain-a.com`), should the external identity be registered automatically into a read-only "federated contact" record in `identities.ts`, or should tasks allow arbitrary external email strings as long as the origin domain is trusted?
- **Q3: Envelope signing granularity — Whole-MIME DKIM alignment vs Custom Header Envelope:** Should federated task signing use standard ARC / DKIM signature headers (RFC 6376, RFC 8617) generated by the MTA, or should OpenAgentEmail maintain its own application-level `X-OA-Federation-Signature` headers independent of the underlying MTA transport?
- **Q4: Asymmetric encryption of task bodies:** Ed25519 provides signature authenticity and integrity, but does not provide end-to-end encryption across intermediate mail relays. Should RFC-0002 specify an X25519 key agreement scheme (RFC 8410) in Phase 2 for encrypting sensitive task arguments and results across domains?
- **Q5: Dynamic allowlist persistence without restarts:** Should dynamically added trusted domains (`POST /v1/federation/trusted-domains`) persist to a local JSONL file (following `notification-log.ts` / `audit.ts`), or should `FEDERATION_TRUSTED_DOMAINS` remain strictly immutable via environment variables to minimize mutable attack surfaces?
- **Q6: Maximum task expiration lifetime:** What should be the mandatory global ceiling for `X-OA-Federation-Expires` relative to message creation time (e.g. 24 hours, 7 days, or 30 days) to bound the replay window of old task envelopes?
- **Q7: Approval task cross-domain delegation:** Should `createApprovalTask()` (`packages/api/src/lib/tasks-internal.ts:1964`) allow cross-domain reviewers in v1, or should federated approvals be deferred to a follow-up RFC given that approvals can trigger external execution?
- **Q8: Multi-domain hosting and signature keys:** For OAE deployments configured with multiple domains (`config.extraDomains`, `packages/api/src/lib/config.ts:439`), should each domain have a distinct Ed25519 signing key, or should one primary key sign for all domains managed by the instance?
